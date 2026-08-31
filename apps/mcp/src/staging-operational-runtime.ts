import { sha256, type MediaStorage } from "@navocms/media";
import type { AstroMediaBinding, AstroRenderInput } from "@navocms/design-astro";
import type { ContentRevision } from "@navocms/content";
import type { PostgresDatabase } from "@navocms/persistence-postgres";

import type { McpRequestContext } from "./model.js";
import { PostgresReviewedAstroArtifactStore } from "./postgres-reviewed-astro-artifact-store.js";
import type { ReviewedAstroObjectStorage } from "./reviewed-astro-object-storage.js";
import { PostgresReviewedAstroBuildInputStore } from "./postgres-reviewed-astro-build-input-store.js";
import type { RepositoryContext } from "./repository.js";
import type { StoredRelease } from "./release-repository.js";
import type { StagingAstroOperations } from "./service.js";
import { McpEditingError } from "./errors.js";
import { STAGING_ASTRO_POLICY_DIGEST, StagingAstroPreviewPreparer } from "./staging-astro-preview-preparer.js";
import { ImageAttestedAstroBuildRunner, TrustedAstroBuilder, type TrustedAstroBuildRunner } from "./trusted-astro-builder.js";

const INLINE_VARIANT_BYTES = 192 * 1024;
const INLINE_MEDIA_BYTES = 512 * 1024;

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
  readonly #preparer = new StagingAstroPreviewPreparer();
  #runnerReadiness: Promise<boolean> | undefined;

  public constructor(input: Readonly<{ database: PostgresDatabase; environmentKey: string; reviewedSourceCommit: string; toolchainDirectory: string; readinessContext: RepositoryContext; runner?: TrustedAstroBuildRunner; objectStorage?: ReviewedAstroObjectStorage; mediaStorage?: MediaStorage }>) {
    this.#database = input.database;
    this.#environmentKey = input.environmentKey;
    this.#readinessContext = input.readinessContext;
    this.#objectStorage = input.objectStorage;
    this.#mediaStorage = input.mediaStorage;
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

  public async ensureArtifact(context: McpRequestContext, repository: RepositoryContext, release: StoredRelease): Promise<void> {
    const artifacts = new PostgresReviewedAstroArtifactStore(this.#database, repository, this.#environmentKey, this.#objectStorage ? { storage: this.#objectStorage } : {});
    const existing = await artifacts.get({ tenantId: repository.site.tenantId, siteId: repository.site.siteId, environment: "staging", environmentKey: this.#environmentKey, releaseId: release.id });
    if (existing) {
      if (existing.releaseHash !== release.releaseHash || existing.releaseArtifactHash !== release.artifactHash) throw new Error("REVIEWED_ASTRO_ARTIFACT_DRIFT");
      return;
    }
    const inputs = new PostgresReviewedAstroBuildInputStore(this.#database, repository, this.#environmentKey);
    const builder = new TrustedAstroBuilder({ inputs, registrations: artifacts, context: repository, environmentKey: this.#environmentKey, runner: this.#runner });
    await builder.buildAndRegister(context, {
      releaseId: release.id,
      releaseHash: release.releaseHash,
      releaseArtifactHash: release.artifactHash,
      idempotencyKey: `astro-build:${release.releaseHash}`
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

function validRow(row: MediaBindingRow): boolean {
  return /^[0-9a-f-]{36}$/i.test(row.asset_id) && /^[a-z][a-z0-9_.-]{0,99}$/.test(row.purpose) &&
    /^[a-f0-9]{64}$/.test(row.variant_identity) && /^[a-f0-9]{64}$/.test(row.sha256) &&
    /^tenants\/[0-9a-f-]{36}\/sites\/[0-9a-f-]{36}\/variants\/[a-f0-9]{64}$/.test(row.storage_key) &&
    Number.isSafeInteger(row.byte_size) && row.byte_size > 0 && Number.isSafeInteger(row.width) && row.width > 0 &&
    ["image/avif", "image/webp", "image/jpeg"].includes(row.media_type);
}
