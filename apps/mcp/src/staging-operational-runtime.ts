import { sha256, type MediaStorage } from "@navocms/media";
import type { AstroMediaBinding, AstroRenderInput } from "@navocms/design-astro";
import type { ContentRevision } from "@navocms/content";
import type { PostgresDatabase } from "@navocms/persistence-postgres";
import { NAVOCMS_PERMISSIONS } from "@navocms/security";
import { randomUUID } from "node:crypto";

import { McpEditingError } from "./errors.js";
import type { McpRequestContext, PreviewBuildStatus } from "./model.js";
import { outputManifestDigest } from "./output-manifest.js";
import { PostgresReviewedAstroArtifactStore } from "./postgres-reviewed-astro-artifact-store.js";
import type { ReviewedAstroObjectStorage } from "./reviewed-astro-object-storage.js";
import { PostgresReviewedAstroBuildInputStore } from "./postgres-reviewed-astro-build-input-store.js";
import type { RepositoryContext } from "./repository.js";
import type { StoredRelease } from "./release-repository.js";
import type { StagingAstroOperations } from "./service.js";
import { STAGING_ASTRO_POLICY_DIGEST, StagingAstroPreviewPreparer } from "./staging-astro-preview-preparer.js";
import { ImageAttestedAstroBuildRunner, TrustedAstroBuilder, type TrustedAstroBuildRunner } from "./trusted-astro-builder.js";

const INLINE_VARIANT_BYTES = 192 * 1024;
const INLINE_MEDIA_BYTES = 512 * 1024;
/** Durable workflow key for the pre-review trusted Astro build job. */
export const STAGING_ASTRO_BUILD_WORKFLOW = "navocms.staging-astro.build.v1";

interface MediaBindingRow extends Record<string, unknown> {
  readonly asset_id: string;
  readonly purpose: string;
  readonly variant_identity: string;
  readonly sha256: string;
  readonly storage_key: string;
  readonly byte_size: number;
  readonly media_type: "image/avif" | "image/webp" | "image/jpeg";
  readonly width: number;
}

/**
 * Private runtime composition for staging. Its methods are injected into the
 * service only; mcp.ts has no corresponding tool. Stores are created with the
 * authenticated request principal for mutations, while the delivery resolver
 * remains service-scoped and read-only.
 */
export class StagingOperationalRuntime implements StagingAstroOperations {
  readonly #database: PostgresDatabase;
  readonly #environmentKey: string;
  readonly #runner: TrustedAstroBuildRunner;
  readonly #readinessContext: RepositoryContext;
  readonly #objectStorage: ReviewedAstroObjectStorage | undefined;
  readonly #mediaStorage: MediaStorage | undefined;
  readonly #runtimePrincipalId: string;
  readonly #preparer = new StagingAstroPreviewPreparer();
  readonly #buildExecutors = new Map<string, Promise<void>>();
  #runnerReadiness: Promise<boolean> | undefined;

  public constructor(input: Readonly<{ database: PostgresDatabase; environmentKey: string; reviewedSourceCommit: string; toolchainDirectory: string; readinessContext: RepositoryContext; runtimePrincipalId: string; runner?: TrustedAstroBuildRunner; objectStorage?: ReviewedAstroObjectStorage; mediaStorage?: MediaStorage }>) {
    this.#database = input.database;
    this.#environmentKey = input.environmentKey;
    this.#readinessContext = input.readinessContext;
    this.#objectStorage = input.objectStorage;
    this.#mediaStorage = input.mediaStorage;
    this.#runtimePrincipalId = input.runtimePrincipalId;
    this.#runner = input.runner ?? new ImageAttestedAstroBuildRunner({ sourceCommitSha: input.reviewedSourceCommit, toolchainDirectory: input.toolchainDirectory });
  }

  public async ready(): Promise<boolean> {
    if (!await new PostgresReviewedAstroBuildInputStore(this.#database, this.#readinessContext, this.#environmentKey).ready()) return false;
    if (!this.#mediaStorage || !await new PostgresReviewedAstroArtifactStore(this.#database, this.#readinessContext, this.#environmentKey, this.#objectStorage ? { storage: this.#objectStorage } : {}).ready()) return false;
    this.#runnerReadiness ??= this.#runner.attest().then(() => true, () => false);
    return this.#runnerReadiness;
  }

  public policyDigest(): string { return STAGING_ASTRO_POLICY_DIGEST; }

  public async prepare(context: McpRequestContext, site: RepositoryContext["site"], revision: ContentRevision): Promise<AstroRenderInput> {
    if (!this.#mediaStorage || context.authorization.tenantId !== site.tenantId || context.authorization.siteId !== site.siteId) {
      throw new McpEditingError("STAGING_ASTRO_MEDIA_SCOPE_DENIED", "Staging Astro media binding is outside the authorized site");
    }
    return this.#preparer.prepare(site, revision, await this.resolveMedia(context, revision));
  }

  public async persistPreviewInput(context: McpRequestContext, repository: RepositoryContext, release: StoredRelease, render: AstroRenderInput): Promise<void> {
    await new PostgresReviewedAstroBuildInputStore(this.#database, repository, this.#environmentKey).register(context, {
      idempotencyKey: `astro-input:${release.releaseHash}`,
      releaseId: release.id,
      releaseHash: release.releaseHash,
      releaseArtifactHash: release.artifactHash,
      render
    });
  }

  /**
   * Starts (or resumes) the durable pre-review build job for one release. The
   * executor runs under the service principal, not the requesting bearer; the
   * durable run/checkpoint rows make a killed process resumable without a
   * second job, and registration idempotency makes re-execution safe.
   */
  public async startBuild(repository: RepositoryContext, release: StoredRelease): Promise<PreviewBuildStatus> {
    const run = await this.#findBuildRun(repository, release.id);
    if (run?.status === "succeeded") return await this.buildStatus(repository, release.id);
    if (!this.#buildExecutors.has(release.id)) this.#launchBuild(repository, release);
    return { releaseId: release.id, status: "building" };
  }

  public async buildStatus(repository: RepositoryContext, releaseId: string): Promise<PreviewBuildStatus> {
    const artifacts = this.#artifactStore(repository);
    const existing = await artifacts.get({ tenantId: repository.site.tenantId, siteId: repository.site.siteId, environment: "staging", environmentKey: this.#environmentKey, releaseId });
    if (existing) {
      if (this.#buildExecutors.has(releaseId)) return { releaseId, status: "building" };
      return { releaseId, status: "ready", ...artifactSummaryFields(existing) };
    }
    const run = await this.#findBuildRun(repository, releaseId);
    if (!run) return { releaseId, status: "failed", errorCode: "BUILD_JOB_MISSING" };
    if (run.status === "failed") return { releaseId, status: "failed", ...(run.last_error_code ? { errorCode: run.last_error_code } : {}) };
    // A running job without a live executor is a crashed process: resume it.
    if (run.status === "running" && !this.#buildExecutors.has(releaseId)) {
      const release = await this.#loadReleaseForResume(repository, releaseId);
      if (release) {
        this.#launchBuild(repository, release);
        return { releaseId, status: "building" };
      }
      return { releaseId, status: "failed", errorCode: "BUILD_JOB_MISSING" };
    }
    return { releaseId, status: "building" };
  }

  /** Hash-bearing summary of the registered reviewed artifact for one release. */
  public async artifactSummary(repository: RepositoryContext, releaseId: string): Promise<Readonly<{ outputManifestDigest: string; fileCount: number; totalBytes: number; sourceCommitSha: string }> | undefined> {
    const existing = await this.#artifactStore(repository).get({ tenantId: repository.site.tenantId, siteId: repository.site.siteId, environment: "staging", environmentKey: this.#environmentKey, releaseId });
    return existing ? artifactSummaryFields(existing) : undefined;
  }

  /** Scope-explicit read for the browser preview/confirmation surfaces. */
  public async artifactFor(scope: Readonly<{ tenantId: string; siteId: string; releaseId: string }>): Promise<Readonly<{ output: Readonly<Record<string, string>>; outputManifestDigest: string; fileCount: number; totalBytes: number; sourceCommitSha: string }> | undefined> {
    const repository: RepositoryContext = {
      site: { tenantId: scope.tenantId, siteId: scope.siteId, name: "", primaryLocale: "", locales: [] },
      principalId: this.#runtimePrincipalId
    };
    const existing = await this.#artifactStore(repository).get({ tenantId: scope.tenantId, siteId: scope.siteId, environment: "staging", environmentKey: this.#environmentKey, releaseId: scope.releaseId });
    if (!existing) return undefined;
    return Object.freeze({ output: Object.freeze(existing.output), ...artifactSummaryFields(existing) });
  }

  async #loadReleaseForResume(repository: RepositoryContext, releaseId: string): Promise<Readonly<{ id: string; releaseHash: string; artifactHash: string }> | undefined> {
    return this.#database.withScope(serviceScope(repository), async (client) => (
      await client.query<{ id: string; release_hash: string; artifact_hash: string }>(
        `SELECT id, release_hash, artifact_hash FROM navocms.release_candidates
          WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
        [repository.site.tenantId, repository.site.siteId, releaseId]
      )).rows[0]
  ).then((row) => row ? Object.freeze({ id: row.id, releaseHash: row.release_hash, artifactHash: row.artifact_hash }) : undefined);
  }

  async #findBuildRun(repository: RepositoryContext, releaseId: string): Promise<Readonly<{ id: string; status: string; last_error_code: string | null }> | undefined> {
    return this.#database.withScope(serviceScope(repository), async (client) => (
      await client.query<{ id: string; status: string; last_error_code: string | null }>(
        `SELECT id, status, last_error_code FROM navocms.workflow_runs
          WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND workflow_key = $4
          ORDER BY started_at DESC LIMIT 1`,
        [repository.site.tenantId, repository.site.siteId, releaseId, STAGING_ASTRO_BUILD_WORKFLOW]
      )).rows[0]);
  }

  #launchBuild(repository: RepositoryContext, release: Readonly<{ id: string; releaseHash: string; artifactHash: string }>): void {
    const executor = (async () => {
      try {
        await this.#database.withScope(serviceScope(repository), async (client) => {
          const existing = (await client.query<{ id: string }>(
            `SELECT id FROM navocms.workflow_runs
              WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND workflow_key = $4
                AND status IN ('running','succeeded')`,
            [repository.site.tenantId, repository.site.siteId, release.id, STAGING_ASTRO_BUILD_WORKFLOW]
          )).rows[0];
          if (!existing) {
            const runId = randomUUID();
            await client.query(
              `INSERT INTO navocms.workflow_runs (
                 id, tenant_id, site_id, release_id, workflow_key, status, current_step
               ) VALUES ($1,$2,$3,$4,$5,'running','build.requested')`,
              [runId, repository.site.tenantId, repository.site.siteId, release.id, STAGING_ASTRO_BUILD_WORKFLOW]
            );
            await client.query(
              `INSERT INTO navocms.workflow_checkpoints (id, tenant_id, site_id, run_id, step_key, input_hash, output_json)
               VALUES ($1,$2,$3,$4,'build.requested',$5,$6::jsonb)`,
              [randomUUID(), repository.site.tenantId, repository.site.siteId, runId, release.releaseHash,
                JSON.stringify({ releaseHash: release.releaseHash })]
            );
          }
        });
        const artifacts = this.#artifactStore(repository);
        const inputs = new PostgresReviewedAstroBuildInputStore(this.#database, repository, this.#environmentKey);
        const builder = new TrustedAstroBuilder({ inputs, registrations: artifacts, context: repository, environmentKey: this.#environmentKey, runner: this.#runner });
        const record = await builder.buildAndRegister(this.#serviceContext(repository), {
          releaseId: release.id,
          releaseHash: release.releaseHash,
          releaseArtifactHash: release.artifactHash,
          idempotencyKey: `astro-build:${release.releaseHash}`
        });
        const summary = artifactSummaryFields(record);
        await this.#database.withScope(serviceScope(repository), async (client) => {
          await client.query(
            `UPDATE navocms.workflow_runs SET status = 'succeeded', current_step = 'build.completed', completed_at = now(), updated_at = now()
              WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND workflow_key = $4 AND status = 'running'`,
            [repository.site.tenantId, repository.site.siteId, release.id, STAGING_ASTRO_BUILD_WORKFLOW]
          );
          await client.query(
            `INSERT INTO navocms.workflow_checkpoints (id, tenant_id, site_id, run_id, step_key, input_hash, output_json)
             SELECT $1, $2, $3, r.id, 'build.completed', $5, $6::jsonb
               FROM navocms.workflow_runs r
              WHERE r.tenant_id = $2 AND r.site_id = $3 AND r.release_id = $4 AND r.workflow_key = $7 AND r.status = 'succeeded'`,
            [randomUUID(), repository.site.tenantId, repository.site.siteId, release.id,
              release.releaseHash, JSON.stringify(summary), STAGING_ASTRO_BUILD_WORKFLOW]
          );
        });
      } catch (error) {
        const errorCode = error instanceof McpEditingError ? error.code : "REVIEWED_ASTRO_BUILD_FAILED";
        await this.#database.withScope(serviceScope(repository), async (client) => {
          await client.query(
            `UPDATE navocms.workflow_runs SET status = 'failed', current_step = 'build.failed', last_error_code = $4, completed_at = now(), updated_at = now()
              WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND workflow_key = $5 AND status = 'running'`,
            [repository.site.tenantId, repository.site.siteId, release.id, errorCode, STAGING_ASTRO_BUILD_WORKFLOW]
          );
        }).catch(() => undefined);
      } finally {
        this.#buildExecutors.delete(release.id);
      }
    })();
    this.#buildExecutors.set(release.id, executor);
  }

  #artifactStore(repository: RepositoryContext): PostgresReviewedAstroArtifactStore {
    return new PostgresReviewedAstroArtifactStore(this.#database, repository, this.#environmentKey, this.#objectStorage ? { storage: this.#objectStorage } : {});
  }

  #serviceContext(repository: RepositoryContext): McpRequestContext {
    return Object.freeze({
      authorization: {
        tenantId: repository.site.tenantId,
        siteId: repository.site.siteId,
        principal: { id: this.#runtimePrincipalId, kind: "service" as const, issuer: "urn:navocms:runtime", subject: "trusted-astro-build" },
        layers: Object.freeze([
          Object.freeze({ name: "principal" as const, permissions: Object.freeze(["content:publish"] as const) }),
          Object.freeze({ name: "operation" as const, permissions: NAVOCMS_PERMISSIONS })
        ])
      }
    });
  }

  private async resolveMedia(context: McpRequestContext, revision: ContentRevision): Promise<readonly AstroMediaBinding[]> {
    const storage = this.#mediaStorage!;
    const rows = (await this.#database.withScope({
      tenantId: context.authorization.tenantId,
      siteId: context.authorization.siteId,
      principalId: context.authorization.principal.id
    }, async (client) => client.query<MediaBindingRow>(
      `SELECT r.asset_id::text, r.purpose, v.variant_identity, v.sha256, v.storage_key,
              v.byte_size::integer AS byte_size, v.media_type, v.width
         FROM navocms.media_references r
         JOIN navocms.media_assets a
           ON a.tenant_id = r.tenant_id AND a.site_id = r.site_id AND a.id = r.asset_id
         JOIN navocms.media_variants v
           ON v.tenant_id = r.tenant_id AND v.site_id = r.site_id AND v.asset_id = r.asset_id
        WHERE r.tenant_id = $1 AND r.site_id = $2 AND r.owner_type = 'content.revision'
          AND r.owner_id = $3 AND r.deleted_at IS NULL AND a.state = 'verified'
          AND v.preset_id = 'responsive' AND v.preset_version = 'v1'
          AND ((v.media_type = 'image/webp' AND v.width IN (320, 640))
            OR (v.media_type = 'image/jpeg' AND v.width = 640))
        ORDER BY r.purpose, r.asset_id, v.media_type, v.width`,
      [revision.tenantId, revision.siteId, revision.id]
    ))).rows;
    const grouped = new Map<string, MediaBindingRow[]>();
    for (const row of rows) {
      if (!validRow(row) || row.byte_size > INLINE_VARIANT_BYTES) throw new McpEditingError("STAGING_ASTRO_MEDIA_INVALID", "Verified media variant metadata is outside the staging policy");
      const key = `${row.purpose}:${row.asset_id}`;
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    let total = 0;
    const bound: AstroMediaBinding[] = [];
    for (const [key, variants] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const webp320 = variants.find((variant) => variant.media_type === "image/webp" && variant.width === 320);
      const webp640 = variants.find((variant) => variant.media_type === "image/webp" && variant.width === 640);
      const jpeg640 = variants.find((variant) => variant.media_type === "image/jpeg" && variant.width === 640);
      if (!webp320 || !webp640 || !jpeg640 || variants.length !== 3) throw new McpEditingError("STAGING_ASTRO_MEDIA_VARIANTS_INCOMPLETE", "A referenced staging image needs responsive WebP 320/640 and JPEG 640 variants");
      const urls = await Promise.all([webp320, webp640, jpeg640].map(async (variant) => {
        const object = await storage.read(variant.storage_key, INLINE_VARIANT_BYTES);
        if (!object || object.key !== variant.storage_key || object.mediaType !== variant.media_type || object.bytes.byteLength !== variant.byte_size || sha256(object.bytes) !== variant.sha256) {
          throw new McpEditingError("STAGING_ASTRO_MEDIA_STORAGE_MISMATCH", "Verified media bytes do not match the immutable staging variant");
        }
        total += object.bytes.byteLength;
        if (total > INLINE_MEDIA_BYTES) throw new McpEditingError("STAGING_ASTRO_MEDIA_BOUNDS", "Staging media bindings exceed the reviewed inline limit");
        return `data:${variant.media_type};base64,${Buffer.from(object.bytes).toString("base64")}`;
      }));
      const [webp320Url, webp640Url, jpeg640Url] = urls;
      if (!webp320Url || !webp640Url || !jpeg640Url) throw new McpEditingError("STAGING_ASTRO_MEDIA_STORAGE_MISMATCH", "Verified media bytes do not match the immutable staging variant");
      bound.push(Object.freeze({
        assetId: jpeg640.asset_id,
        variantIdentity: jpeg640.variant_identity,
        url: jpeg640Url,
        alt: `${key.split(":", 1)[0]} image`,
        sources: Object.freeze([
          Object.freeze({ variantIdentity: webp320.variant_identity, url: webp320Url, mediaType: webp320.media_type, media: "(max-width: 480px)" }),
          Object.freeze({ variantIdentity: webp640.variant_identity, url: webp640Url, mediaType: webp640.media_type })
        ])
      }));
    }
    return Object.freeze(bound);
  }
}

function serviceScope(repository: RepositoryContext) {
  return { tenantId: repository.site.tenantId, siteId: repository.site.siteId, principalId: repository.principalId };
}

function artifactSummaryFields(record: { output: Readonly<Record<string, string>>; sourceCommitSha: string }): Readonly<{ outputManifestDigest: string; fileCount: number; totalBytes: number; sourceCommitSha: string }> {
  const files = Object.values(record.output);
  return Object.freeze({
    outputManifestDigest: outputManifestDigest(record.output),
    fileCount: files.length,
    totalBytes: files.reduce((total, body) => total + Buffer.byteLength(body, "utf8"), 0),
    sourceCommitSha: record.sourceCommitSha
  });
}

function validRow(row: MediaBindingRow): boolean {
  return /^[0-9a-f-]{36}$/i.test(row.asset_id) && /^[a-z][a-z0-9_.-]{0,99}$/.test(row.purpose) &&
    /^[a-f0-9]{64}$/.test(row.variant_identity) && /^[a-f0-9]{64}$/.test(row.sha256) &&
    /^tenants\/[0-9a-f-]{36}\/sites\/[0-9a-f-]{36}\/variants\/[a-f0-9]{64}$/.test(row.storage_key) &&
    Number.isSafeInteger(row.byte_size) && row.byte_size > 0 && Number.isSafeInteger(row.width) && row.width > 0 &&
    ["image/avif", "image/webp", "image/jpeg"].includes(row.media_type);
}
