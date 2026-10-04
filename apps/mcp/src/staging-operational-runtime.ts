import { sha256, type MediaStorage } from "@navocms/media";
import type { AstroMediaBinding, AstroRenderInput } from "@navocms/design-astro";
import { renderSemanticMarkdownHtml, type ContentRevision } from "@navocms/content";
import type { SqlClient, PostgresDatabase } from "@navocms/persistence-postgres";
import { NAVOCMS_PERMISSIONS } from "@navocms/security";
import { randomUUID } from "node:crypto";

import { composeSiteSnapshot, snapshotGovernance } from "./site-snapshot.js";
import { McpEditingError } from "./errors.js";
import type { McpRequestContext, PreviewBuildStatus } from "./model.js";
import { outputManifestDigest } from "./output-manifest.js";
import { PostgresReviewedAstroArtifactStore } from "./postgres-reviewed-astro-artifact-store.js";
import type { ReviewedAstroObjectStorage } from "./reviewed-astro-object-storage.js";
import { PostgresReviewedAstroBuildInputStore } from "./postgres-reviewed-astro-build-input-store.js";
import type { RepositoryContext } from "./repository.js";
import type { StoredRelease } from "./release-repository.js";
import type { StagingAstroOperations } from "./service.js";
import { STAGING_ASTRO_GOVERNANCE_DIGEST, STAGING_ASTRO_POLICY_DIGEST, StagingAstroPreviewPreparer } from "./staging-astro-preview-preparer.js";
import { ImageAttestedAstroBuildRunner, TrustedAstroBuilder, type TrustedAstroBuildRunner } from "./trusted-astro-builder.js";

const INLINE_VARIANT_BYTES = 192 * 1024;
const INLINE_MEDIA_BYTES = 512 * 1024;
/** Durable workflow key for the pre-review trusted Astro build job. */
export const STAGING_ASTRO_BUILD_WORKFLOW = "navocms.staging-astro.build.v1";

interface MediaBindingRow extends Record<string, unknown> {
  readonly asset_id: string;
  readonly purpose: string;
  readonly alt: string | null;
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
  readonly #mediaBaseUrl: string;
  readonly #leaseTtlMs: number;
  readonly #ownerToken = randomUUID();
  readonly #preparer = new StagingAstroPreviewPreparer();
  readonly #buildExecutors = new Map<string, Promise<void>>();
  #runnerReadiness: Promise<boolean> | undefined;

  public constructor(input: Readonly<{ database: PostgresDatabase; environmentKey: string; reviewedSourceCommit: string; toolchainDirectory: string; readinessContext: RepositoryContext; runtimePrincipalId: string; leaseTtlMs?: number; runner?: TrustedAstroBuildRunner; objectStorage?: ReviewedAstroObjectStorage; mediaStorage?: MediaStorage; mediaBaseUrl?: string }>) {
    this.#database = input.database;
    this.#environmentKey = input.environmentKey;
    this.#readinessContext = input.readinessContext;
    this.#objectStorage = input.objectStorage;
    this.#mediaStorage = input.mediaStorage;
    this.#runtimePrincipalId = input.runtimePrincipalId;
    this.#mediaBaseUrl = input.mediaBaseUrl ?? "";
    this.#leaseTtlMs = input.leaseTtlMs ?? 900_000;
    this.#runner = input.runner ?? new ImageAttestedAstroBuildRunner({ sourceCommitSha: input.reviewedSourceCommit, toolchainDirectory: input.toolchainDirectory });
  }

  public async ready(): Promise<boolean> {
    if (!await new PostgresReviewedAstroBuildInputStore(this.#database, this.#readinessContext, this.#environmentKey).ready()) return false;
    if (!this.#mediaStorage || !await new PostgresReviewedAstroArtifactStore(this.#database, this.#readinessContext, this.#environmentKey, this.#objectStorage ? { storage: this.#objectStorage } : {}).ready()) return false;
    this.#runnerReadiness ??= this.#runner.attest().then(() => true, () => false);
    return this.#runnerReadiness;
  }

  public policyDigest(): string { return STAGING_ASTRO_POLICY_DIGEST; }

  public async siteContext(repository: RepositoryContext): Promise<object> {
    const base = await this.snapshotBase(repository);
    const input = base ? await new PostgresReviewedAstroBuildInputStore(this.#database, repository, this.#environmentKey).get({ tenantId: repository.site.tenantId, siteId: repository.site.siteId, environment: "staging", environmentKey: this.#environmentKey, releaseId: base.release_id }) : undefined;
    return { environmentKey: this.#environmentKey, releaseId: base?.release_id ?? null,
      routes: input?.render.routes.map(route => ({ path: route.path, locale: route.locale, documentId: route.id, revisionId: route.revisionId, sectionId: "main", componentId: route.componentId, dataSource: "content.revision", fields: ["title", "body", "media"] })) ?? [],
      redirects: input?.render.redirects ?? [], integrations: { build: "reviewed-astro", media: "injected-immutable-storage" }, policyDigest: STAGING_ASTRO_POLICY_DIGEST };
  }

  public async prepare(context: McpRequestContext, site: RepositoryContext["site"], revision: ContentRevision, additional: readonly ContentRevision[] = []): Promise<AstroRenderInput> {
    if (!this.#mediaStorage || context.authorization.tenantId !== site.tenantId || context.authorization.siteId !== site.siteId) {
      throw new McpEditingError("STAGING_ASTRO_MEDIA_SCOPE_DENIED", "Staging Astro media binding is outside the authorized site");
    }
    const repository = { site, principalId: context.authorization.principal.id };
    const base = await this.snapshotBase(repository);
    const previous = base ? await new PostgresReviewedAstroBuildInputStore(this.#database, repository, this.#environmentKey).get({
      tenantId: site.tenantId, siteId: site.siteId, environment: "staging", environmentKey: this.#environmentKey, releaseId: base.release_id
    }) : undefined;
    if (base && !previous) throw new McpEditingError("SITE_SNAPSHOT_BASE_MISSING", "Published route snapshot is missing; restore it before preparing another release");
    const selected = await Promise.all([revision, ...additional].map(async item => this.#preparer.prepare(site, item, await this.resolveMedia(context, item))));
    return composeSiteSnapshot(selected, previous?.render.routes ?? [], base?.id ?? null);
  }

  private async snapshotBase(repository: RepositoryContext): Promise<{ id: string; release_id: string } | undefined> {
    return this.#database.withScope(serviceScope(repository), async client => (await client.query<{ id: string; release_id: string }>(
      `SELECT p.id, p.release_id FROM navocms.release_publications p JOIN navocms.environments e
       ON e.tenant_id = p.tenant_id AND e.site_id = p.site_id AND e.id = p.environment_id
       WHERE p.tenant_id = $1 AND p.site_id = $2 AND e.environment_key = $3
         AND p.status IN ('applied','verified','verification_failed') ORDER BY p.applied_at DESC LIMIT 1`,
      [repository.site.tenantId, repository.site.siteId, this.#environmentKey]
    )).rows[0]);
  }

  public async publicSnapshot(releaseHash: string): Promise<object | undefined> {
    if (!/^[a-f0-9]{64}$/.test(releaseHash)) return undefined;
    const repository = { ...this.#readinessContext, principalId: this.#runtimePrincipalId };
    const releaseId = await this.#database.withScope(serviceScope(repository), async client => (await client.query<{ release_id: string }>(
      `SELECT p.release_id FROM navocms.release_publications p JOIN navocms.release_candidates c
       ON c.tenant_id=p.tenant_id AND c.site_id=p.site_id AND c.id=p.release_id
       WHERE p.tenant_id=$1 AND p.site_id=$2 AND c.release_hash=$3 AND p.verified_at IS NOT NULL LIMIT 1`,
      [repository.site.tenantId, repository.site.siteId, releaseHash]
    )).rows[0]?.release_id);
    if (!releaseId) return undefined;
    const input = await new PostgresReviewedAstroBuildInputStore(this.#database, repository, this.#environmentKey).get({
      tenantId: repository.site.tenantId, siteId: repository.site.siteId, environment: "staging", environmentKey: this.#environmentKey, releaseId
    });
    if (!input) return undefined;
    const routes = await this.#database.withScope(serviceScope(repository), async client => Promise.all(input.render.routes.map(async route => {
      const row = (await client.query<{ metadata_json: Record<string, unknown>; type_name: string; document_id: string }>(
        `SELECT r.metadata_json, t.name AS type_name, r.document_id FROM navocms.content_revisions r
         JOIN navocms.content_documents d ON d.tenant_id=r.tenant_id AND d.site_id=r.site_id AND d.id=r.document_id
         JOIN navocms.content_types t ON t.tenant_id=d.tenant_id AND t.site_id=d.site_id AND t.id=d.content_type_id
         WHERE r.tenant_id=$1 AND r.site_id=$2 AND r.id=$3`, [repository.site.tenantId, repository.site.siteId, route.revisionId]
      )).rows[0];
      if (!row) throw new McpEditingError("SITE_SNAPSHOT_REVISION_MISSING", "Published revision is missing");
      return { path: route.path, locale: route.locale, revisionId: route.revisionId, documentId: row.document_id,
        typeName: row.type_name, title: route.title, markdown: route.source, html: renderSemanticMarkdownHtml(route.source, route.directives), fields: row.metadata_json, media: route.media };
    })));
    const snapshot = { schema: "io.navocms.public-site-snapshot.v1", siteId: repository.site.siteId, releaseHash,
      locales: input.render.locales, redirects: input.render.redirects ?? [], routes };
    return { snapshot, snapshotHash: sha256(JSON.stringify(snapshot)) };
  }

  public async readMedia(variantIdentity: string, previewReleaseId?: string): Promise<{ bytes: Uint8Array; mediaType: string; sha256: string } | undefined> {
    if (!/^[a-f0-9]{64}$/.test(variantIdentity) || !this.#mediaStorage) return undefined;
    const repository = { ...this.#readinessContext, principalId: this.#runtimePrincipalId };
    const eligible = await this.#database.withScope(serviceScope(repository), async client => (await client.query<{ storage_key: string; byte_size: number; media_type: string; sha256: string }>(
      `SELECT v.storage_key,v.byte_size,v.media_type,v.sha256 FROM navocms.media_variants v
       WHERE v.tenant_id=$1 AND v.site_id=$2 AND v.variant_identity=$3 AND EXISTS (
         SELECT 1 FROM navocms.reviewed_astro_build_inputs b
         WHERE b.tenant_id=v.tenant_id AND b.site_id=v.site_id
           AND (($4::uuid IS NOT NULL AND b.release_id=$4) OR ($4::uuid IS NULL AND EXISTS (
             SELECT 1 FROM navocms.release_publications p WHERE p.tenant_id=b.tenant_id AND p.site_id=b.site_id AND p.release_id=b.release_id AND p.verified_at IS NOT NULL)))
           AND b.render_json->'routes' @? ('$[*].media[*] ? (@.variantIdentity == "' || $3 || '" || exists(@.sources[*] ? (@.variantIdentity == "' || $3 || '")))')::jsonpath
       ) LIMIT 1`, [repository.site.tenantId, repository.site.siteId, variantIdentity, previewReleaseId ?? null]
    )).rows[0]);
    if (!eligible || Number(eligible.byte_size) > INLINE_VARIANT_BYTES) return undefined;
    const object = await this.#mediaStorage.read(eligible.storage_key, INLINE_VARIANT_BYTES);
    if (!object || sha256(object.bytes) !== eligible.sha256 || object.mediaType !== eligible.media_type || object.bytes.length !== Number(eligible.byte_size)) return undefined;
    return { bytes: object.bytes, mediaType: object.mediaType, sha256: eligible.sha256 };
  }

  public async persistPreviewInput(context: McpRequestContext, repository: RepositoryContext, release: StoredRelease, render: AstroRenderInput): Promise<void> {
    const base = await this.snapshotBase(repository);
    if (render.anchors.governance !== snapshotGovernance(STAGING_ASTRO_GOVERNANCE_DIGEST, base?.id ?? null)) throw new McpEditingError("SITE_SNAPSHOT_STALE", "Published release changed during preparation; prepare a fresh snapshot");
    await this.#database.withScope(serviceScope(repository), client => client.query(
      `INSERT INTO navocms.site_release_snapshots (tenant_id, site_id, release_id, base_publication_id, governance_digest)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [repository.site.tenantId, repository.site.siteId, release.id, base?.id ?? null, render.anchors.governance]
    ));
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
   * executor runs under the service principal, not the requesting bearer.
   * Ownership is leased in the database: the running workflow row and the
   * lease commit together before any build work starts, so a second live
   * instance never duplicates the job and a crashed owner's lease expires
   * before another instance re-homes it. Registration idempotency makes
   * re-execution a safe recomputation.
   */
  public async startBuild(repository: RepositoryContext, release: Readonly<{ id: string; releaseHash: string; artifactHash: string }>): Promise<PreviewBuildStatus> {
    // A repeated start while this instance already executes the job is a
    // no-op; the lease renewal keeps the ownership alive meanwhile.
    if (this.#buildExecutors.has(release.id)) return { releaseId: release.id, status: "building" };
    const owned = await this.#acquireJob(repository, release);
    if (!owned) return { releaseId: release.id, status: "building" };
    this.#launchBuild(repository, release);
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
    // A running job without a live local executor may belong to another live
    // instance (its lease is still held) or to a crashed process. Only an
    // expired lease may be re-homed; a foreign active lease stays untouched.
    if (run.status === "running" && !this.#buildExecutors.has(releaseId)) {
      const release = await this.#loadReleaseForResume(repository, releaseId);
      if (release) {
        const owned = await this.#acquireJob(repository, release);
        if (owned) this.#launchBuild(repository, release);
        return { releaseId, status: "building" };
      }
      return { releaseId, status: "failed", errorCode: "BUILD_JOB_MISSING" };
    }
    return { releaseId, status: "building" };
  }

  /**
   * Atomically claims the build job. A transaction advisory lock on the job
   * key serializes every claimant — including the very first one, where
   * neither a lease nor a workflow row exists yet — so only one instance can
   * observe "unclaimed". The unique partial index on workflow_runs is the
   * database-level backstop: one build run per release, ever. An active
   * foreign lease returns false without writing anything; an expired lease
   * (or our own) is re-claimed together with the running workflow row and its
   * durable checkpoint.
   */
  async #acquireJob(repository: RepositoryContext, release: Readonly<{ id: string; releaseHash: string; artifactHash: string }>): Promise<boolean> {
    return this.#database.withScope(serviceScope(repository), async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${repository.site.tenantId}:${repository.site.siteId}:${release.id}:${STAGING_ASTRO_BUILD_WORKFLOW}`]
      );
      const succeeded = (await client.query<{ id: string }>(
        `SELECT id FROM navocms.workflow_runs
          WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND workflow_key = $4 AND status = 'succeeded'`,
        [repository.site.tenantId, repository.site.siteId, release.id, STAGING_ASTRO_BUILD_WORKFLOW]
      )).rows[0];
      if (succeeded) return false;
      const lease = (await client.query<{ owner_token: string; leased_until: Date | string }>(
        `SELECT owner_token, leased_until FROM navocms.build_job_leases
          WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND workflow_key = $4 FOR UPDATE`,
        [repository.site.tenantId, repository.site.siteId, release.id, STAGING_ASTRO_BUILD_WORKFLOW]
      )).rows[0];
      if (lease && lease.owner_token !== this.#ownerToken && new Date(lease.leased_until).getTime() > Date.now()) {
        return false;
      }
      const existing = (await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM navocms.workflow_runs
          WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND workflow_key = $4
            AND status IN ('running','succeeded','failed')`,
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
      } else if (existing.status === "failed") {
        // A failed attempt still owns the release's unique job identity.
        await client.query(
          `UPDATE navocms.workflow_runs SET status = 'running', current_step = 'build.requested',
             attempt = attempt + 1, last_error_code = NULL, completed_at = NULL, updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND site_id = $3 AND status = 'failed'`,
          [existing.id, repository.site.tenantId, repository.site.siteId]
        );
      }
      await client.query(
        `INSERT INTO navocms.build_job_leases (
           tenant_id, site_id, release_id, workflow_key, owner_token, leased_until
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, site_id, release_id, workflow_key) DO UPDATE
           SET owner_token = $5, leased_until = $6, updated_at = now()`,
        [repository.site.tenantId, repository.site.siteId, release.id, STAGING_ASTRO_BUILD_WORKFLOW,
          this.#ownerToken, new Date(Date.now() + this.#leaseTtlMs).toISOString()]
      );
      return true;
    });
  }

  /** Refreshes our lease while the executor is alive; a no-op once lost. */
  async #renewLease(repository: RepositoryContext, releaseId: string): Promise<void> {
    await this.#database.withScope(serviceScope(repository), (client) => client.query(
      `UPDATE navocms.build_job_leases SET leased_until = $4, updated_at = now()
        WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND workflow_key = $5 AND owner_token = $6`,
      [repository.site.tenantId, repository.site.siteId, releaseId,
        new Date(Date.now() + this.#leaseTtlMs).toISOString(), STAGING_ASTRO_BUILD_WORKFLOW, this.#ownerToken]
    )).catch(() => undefined);
  }

  /** True while this instance still owns the job's lease. */
  async #stillOwns(client: SqlClient, repository: RepositoryContext, releaseId: string): Promise<boolean> {
    const row = (await client.query<{ owner_token: string }>(
      `SELECT owner_token FROM navocms.build_job_leases
        WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND workflow_key = $4
          AND leased_until > now() FOR UPDATE`,
      [repository.site.tenantId, repository.site.siteId, releaseId, STAGING_ASTRO_BUILD_WORKFLOW]
    )).rows[0];
    return row?.owner_token === this.#ownerToken;
  }

  async #releaseJob(repository: RepositoryContext, releaseId: string): Promise<void> {
    await this.#database.withScope(serviceScope(repository), (client) => client.query(
      `DELETE FROM navocms.build_job_leases
        WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND workflow_key = $4 AND owner_token = $5`,
      [repository.site.tenantId, repository.site.siteId, releaseId, STAGING_ASTRO_BUILD_WORKFLOW, this.#ownerToken]
    )).catch(() => undefined);
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

  #launchBuild(requestRepository: RepositoryContext, release: Readonly<{ id: string; releaseHash: string; artifactHash: string }>): void {
    if (this.#buildExecutors.has(release.id)) return;
    // The request selects the site; the trusted executor owns registration.
    // Its database scope and registration authority must name the same actor.
    const repository = { ...requestRepository, principalId: this.#runtimePrincipalId };
    const executor = (async () => {
      // Keep renewing the lease while this executor is alive so a long, live
      // build is never mistaken for a crashed one and never runs twice.
      const renewal = setInterval(() => { void this.#renewLease(repository, release.id); }, Math.max(1_000, Math.floor(this.#leaseTtlMs / 3)));
      renewal.unref?.();
      try {
        const artifacts = this.#artifactStore(repository);
        const inputs = new PostgresReviewedAstroBuildInputStore(this.#database, repository, this.#environmentKey);
        const builder = new TrustedAstroBuilder({ inputs, registrations: artifacts, context: repository, environmentKey: this.#environmentKey, runner: this.#runner });
        // Registration is idempotent and drift-checked, so even a stale owner
        // can only ever re-register the identical artifact.
        const record = await builder.buildAndRegister(this.#serviceContext(repository), {
          releaseId: release.id,
          releaseHash: release.releaseHash,
          releaseArtifactHash: release.artifactHash,
          idempotencyKey: `astro-build:${release.releaseHash}`
        });
        const summary = artifactSummaryFields(record);
        await this.#database.withScope(serviceScope(repository), async (client) => {
          if (!await this.#stillOwns(client, repository, release.id)) return;
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
        // A stale owner whose job was re-homed must never overwrite the new
        // owner's outcome; the ownership check makes the terminal write a
        // no-op for it.
        await this.#database.withScope(serviceScope(repository), async (client) => {
          if (!await this.#stillOwns(client, repository, release.id)) return;
          await client.query(
            `UPDATE navocms.workflow_runs SET status = 'failed', current_step = 'build.failed', last_error_code = $4, completed_at = now(), updated_at = now()
              WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND workflow_key = $5 AND status = 'running'`,
            [repository.site.tenantId, repository.site.siteId, release.id, errorCode, STAGING_ASTRO_BUILD_WORKFLOW]
          );
        }).catch(() => undefined);
      } finally {
        clearInterval(renewal);
        // Keep the local guard until cleanup finishes: a retry on this same
        // instance must not lose its new lease to the previous attempt.
        await this.#releaseJob(repository, release.id);
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
      `SELECT r.asset_id::text, r.purpose, r.alt, v.variant_identity, v.sha256, v.storage_key,
              v.byte_size::integer AS byte_size, v.media_type, (v.transform_json->>'width')::integer AS width
         FROM navocms.media_references r
         JOIN navocms.media_assets a
           ON a.tenant_id = r.tenant_id AND a.site_id = r.site_id AND a.id = r.asset_id
         JOIN navocms.media_variants v
           ON v.tenant_id = r.tenant_id AND v.site_id = r.site_id AND v.asset_id = r.asset_id
        WHERE r.tenant_id = $1 AND r.site_id = $2 AND r.owner_type = 'content.revision'
          AND r.owner_id = $3 AND r.deleted_at IS NULL AND a.state = 'verified'
          AND v.preset_id = 'responsive' AND v.preset_version = 'v1'
          AND ((v.media_type = 'image/webp' AND v.transform_json->>'width' IN ('320', '640'))
            OR (v.media_type = 'image/jpeg' AND v.transform_json->>'width' = '640'))
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
        if (!this.#mediaBaseUrl) throw new McpEditingError("MEDIA_DELIVERY_UNAVAILABLE", "Immutable media delivery origin is missing");
        return `${this.#mediaBaseUrl}/media/${variant.variant_identity}`;
      }));
      const [webp320Url, webp640Url, jpeg640Url] = urls;
      if (!webp320Url || !webp640Url || !jpeg640Url) throw new McpEditingError("STAGING_ASTRO_MEDIA_STORAGE_MISMATCH", "Verified media bytes do not match the immutable staging variant");
      bound.push(Object.freeze({
        assetId: jpeg640.asset_id,
        variantIdentity: jpeg640.variant_identity,
        url: jpeg640Url,
        alt: jpeg640.alt ?? `${key.split(":", 1)[0]} image`,
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
