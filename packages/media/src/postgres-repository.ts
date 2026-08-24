import { createHash, randomUUID } from "node:crypto";

import { DomainEventFactory, type EventStore } from "@navocms/kernel";
import { PostgresDatabase, PostgresEventStore, PostgresIdempotencyStore, type SqlClient } from "@navocms/persistence-postgres";

import type {
  CreateUploadIntentInput,
  CreateUploadResult,
  FinalizeUploadInput,
  MediaAssetSummary,
  MediaAssetReview,
  MediaAssetPage,
  MediaReferenceInput,
  MediaReferencePage,
  MediaReferenceSummary,
  MediaRepository,
  MediaScope,
  RejectMediaAssetInput,
  ScheduleMediaDeleteInput,
  MediaLifecycleInput,
  ReconcileMediaInput,
  MediaReconciliationResult,
  GenerateMediaVariantInput,
  MediaVariantSummary
} from "./domain.js";
import { assertOriginalKey, originalKey, originalPrefix, sha256, variantIdentity, variantKey, type MediaStorage } from "./storage.js";
import { inspectMedia, MEDIA_LIMITS, verifyUpload } from "./validation.js";
import { resolvePreset } from "./presets.js";
import { assertVariantTransform, PinnedMediaProcessor, type MediaProcessor } from "./processor.js";

interface AssetRow extends Record<string, unknown> {
  readonly id: string;
  readonly state: MediaAssetSummary["state"];
  readonly created_at: Date | string;
  readonly rejection_reason: string | null;
  readonly sha256: string | null;
  readonly byte_size: string | number | null;
  readonly media_type: "image/jpeg" | "image/png" | null;
  readonly width: number | null;
  readonly height: number | null;
}

interface ReviewRow extends AssetRow {
  readonly provenance_json: Readonly<Record<string, unknown>>;
  readonly rights_json: Readonly<Record<string, unknown>>;
}

interface ReferenceRow extends Record<string, unknown> {
  readonly id: string;
  readonly owner_type: string;
  readonly owner_id: string;
  readonly purpose: string;
  readonly created_at: Date | string;
}

interface IntentRow extends Record<string, unknown> {
  readonly id: string;
  readonly asset_id: string;
  readonly expected_sha256: string;
  readonly expected_size: string | number;
  readonly expected_media_type: "image/jpeg" | "image/png" | null;
  readonly storage_key: string;
  readonly expires_at: Date | string;
  readonly finalized_at: Date | string | null;
}

interface LifecycleOriginalRow extends Record<string, unknown> {
  readonly id: string;
  readonly state: MediaAssetSummary["state"];
  readonly storage_key: string;
  readonly recoverable_until: Date | string | null;
  readonly deleted_at: Date | string | null;
}

interface OriginalInventoryRow extends Record<string, unknown> {
  readonly asset_id: string;
  readonly sha256: string;
  readonly storage_key: string;
  readonly state: MediaAssetSummary["state"];
}

interface VariantOriginalRow extends Record<string, unknown> {
  readonly asset_id: string;
  readonly sha256: string;
  readonly byte_size: string | number;
  readonly media_type: "image/jpeg" | "image/png";
  readonly storage_key: string;
}

interface VariantRow extends Record<string, unknown> {
  readonly id: string;
  readonly variant_identity: string;
  readonly sha256: string;
  readonly storage_key: string;
  readonly byte_size: string | number;
  readonly media_type: MediaVariantSummary["mediaType"];
  readonly width: number;
  readonly height: number;
  readonly preset_id: string;
  readonly preset_version: string;
  readonly transform_json: Readonly<Record<string, unknown>>;
}

interface VariantCheckpointRow extends Record<string, unknown> {
  readonly checkpoint_id: string;
  readonly storage_key: string;
  readonly original_sha256: string;
  readonly output_sha256: string;
  readonly byte_size: string | number;
  readonly media_type: MediaVariantSummary["mediaType"];
  readonly width: number;
  readonly height: number;
  readonly preset_id: string;
  readonly preset_version: string;
  readonly transform_json: Readonly<Record<string, unknown>>;
}

const MAX_INTENT_TTL_MS = 15 * 60 * 1000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_EVENT_IDEMPOTENCY_KEY_LENGTH = 200;
const MIN_DELETE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Finalization reads and validates the temporary object before it begins the
 * SQL mutation. The immutable object write remains deliberately outside SQL:
 * reconciliation of an orphan is a later media-worker responsibility.
 */
export class PostgresMediaRepository implements MediaRepository {
  readonly #database: PostgresDatabase;
  readonly #storage: MediaStorage | undefined;
  readonly #idempotency: PostgresIdempotencyStore;
  readonly #events: EventStore;
  readonly #processor: MediaProcessor;

  public constructor(
    database: PostgresDatabase,
    storage?: MediaStorage,
    idempotency: PostgresIdempotencyStore = new PostgresIdempotencyStore(database),
    events: EventStore = new PostgresEventStore(database),
    processor: MediaProcessor = new PinnedMediaProcessor()
  ) {
    this.#database = database;
    this.#storage = storage;
    this.#idempotency = idempotency;
    this.#events = events;
    this.#processor = processor;
  }

  public async createUploadIntent(scope: MediaScope, input: CreateUploadIntentInput): Promise<CreateUploadResult> {
    assertIntentInput(scope, input);
    return this.idempotent(scope, "media_upload_intent_create", input.idempotencyKey, input, async () => {
      const existing = await this.findOriginalBySha(scope, input.expectedSha256);
      if (existing) {
        if (existing.byteSize !== input.expectedSize || (input.expectedMediaType !== undefined && existing.mediaType !== input.expectedMediaType)) {
          throw new Error("MEDIA_DEDUP_METADATA_MISMATCH");
        }
        return Object.freeze({ kind: "deduplicated" as const, asset: existing });
      }
      const assetId = randomUUID();
      const intentId = randomUUID();
      const storageKey = `tenants/${scope.tenantId}/sites/${scope.siteId}/pending/${intentId}`;
      const asset = await this.#database.withScope(scope, async (client) => {
        await client.query(
          `INSERT INTO navocms.media_assets (id, tenant_id, site_id, state, provenance_json, rights_json, created_by)
           VALUES ($1, $2, $3, 'pending', $4::jsonb, $5::jsonb, $6)`,
          [assetId, scope.tenantId, scope.siteId, JSON.stringify(input.provenance), JSON.stringify(input.rights), scope.principalId]
        );
        await client.query(
          `INSERT INTO navocms.media_upload_intents
             (id, tenant_id, site_id, asset_id, operation_key, expected_sha256, expected_size, expected_media_type, storage_key, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [intentId, scope.tenantId, scope.siteId, assetId, `media_upload_intent_create:${input.idempotencyKey}`,
            input.expectedSha256, input.expectedSize, input.expectedMediaType ?? null, storageKey, input.expiresAt]
        );
        const row = (await client.query<AssetRow>(
          `${assetSelect()} WHERE a.tenant_id = $1 AND a.site_id = $2 AND a.id = $3`,
          [scope.tenantId, scope.siteId, assetId]
        )).rows[0]!;
        return toAsset(row);
      });
      await this.append(scope, "media_upload_intent_create", assetId, input.idempotencyKey, "io.navocms.media.asset.created.v1", { assetId, state: "pending" });
      await this.append(scope, "media_upload_intent_create", assetId, input.idempotencyKey, "io.navocms.media.upload.intent.created.v1", {
        assetId, intentId, expectedSha256: input.expectedSha256, expectedSize: input.expectedSize, expiresAt: input.expiresAt
      });
      return Object.freeze({ kind: "upload-intent" as const, asset, intentId, storageKey, expiresAt: input.expiresAt });
    });
  }

  public async finalizeUpload(scope: MediaScope, input: FinalizeUploadInput): Promise<MediaAssetSummary> {
    assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = fingerprintOf(input);
    const existing = await this.#idempotency.lookup<MediaAssetSummary>(
      scope, "media_upload_finalize", input.idempotencyKey, fingerprint
    );
    if (existing?.status === "completed") return existing.value;
    if (existing) throw new Error("MEDIA_IDEMPOTENCY_INCOMPLETE");
    const preflight = await this.loadIntentForValidation(scope, input.intentId);
    if (preflight.finalized_at) {
      const replay = await this.#idempotency.lookup<MediaAssetSummary>(
        scope, "media_upload_finalize", input.idempotencyKey, fingerprint
      );
      if (replay?.status === "completed") return replay.value;
      throw new Error("MEDIA_INTENT_ALREADY_FINALIZED");
    }
    if (new Date(preflight.expires_at).getTime() <= Date.now()) throw new Error("MEDIA_INTENT_EXPIRED");
    if (preflight.storage_key !== input.uploadedStorageKey) throw new Error("MEDIA_FINALIZATION_MISMATCH");
    if (!this.#storage) throw new Error("MEDIA_STORAGE_UNAVAILABLE");
    const header = await this.#storage.head(input.uploadedStorageKey);
    if (!header) throw new Error("MEDIA_UPLOAD_OBJECT_NOT_FOUND");
    if (header.byteSize !== Number(preflight.expected_size) || header.byteSize > MEDIA_LIMITS.maxBytes) throw new Error("MEDIA_STORAGE_SIZE_MISMATCH");
    if (header.sha256 !== preflight.expected_sha256) throw new Error("MEDIA_STORAGE_CHECKSUM_MISMATCH");
    if (preflight.expected_media_type !== null && header.mediaType !== preflight.expected_media_type) throw new Error("MEDIA_STORAGE_MIME_MISMATCH");
    const uploaded = await this.#storage.read(input.uploadedStorageKey, Number(preflight.expected_size));
    if (!uploaded) throw new Error("MEDIA_UPLOAD_OBJECT_NOT_FOUND");
    if (uploaded.key !== input.uploadedStorageKey) throw new Error("MEDIA_STORAGE_KEY_MISMATCH");
    if (uploaded.mediaType !== header.mediaType) throw new Error("MEDIA_STORAGE_MIME_MISMATCH");
    if (uploaded.bytes.byteLength !== header.byteSize || uploaded.bytes.byteLength !== Number(preflight.expected_size)) throw new Error("MEDIA_STORAGE_SIZE_MISMATCH");
    if (sha256(uploaded.bytes) !== header.sha256 || sha256(uploaded.bytes) !== preflight.expected_sha256) throw new Error("MEDIA_STORAGE_CHECKSUM_MISMATCH");
    const mediaType = verifyUpload(uploaded.bytes, {
      sha256: preflight.expected_sha256,
      byteSize: Number(preflight.expected_size),
      ...(preflight.expected_media_type ? { mediaType: preflight.expected_media_type } : {})
    });
    if (uploaded.mediaType !== mediaType) throw new Error("MEDIA_STORAGE_MIME_MISMATCH");
    const inspection = inspectMedia(uploaded.bytes, mediaType);
    const original = Object.freeze({
      sha256: preflight.expected_sha256,
      byteSize: uploaded.bytes.byteLength,
      mediaType,
      storageKey: originalKey(scope, preflight.expected_sha256),
      width: inspection.width,
      height: inspection.height,
      frames: inspection.frames
    });
    await this.#storage.putImmutable({ key: original.storageKey, bytes: uploaded.bytes, mediaType: original.mediaType });
    return this.idempotent(scope, "media_upload_finalize", input.idempotencyKey, input, async () => {
      const outcome = await this.#database.withScope(scope, async (client) => {
        const intent = (await client.query<IntentRow>(
          `SELECT id, asset_id, expected_sha256, expected_size, expected_media_type, storage_key, expires_at, finalized_at
             FROM navocms.media_upload_intents
            WHERE tenant_id = $1 AND site_id = $2 AND id = $3 FOR UPDATE`,
          [scope.tenantId, scope.siteId, input.intentId]
        )).rows[0];
        if (!intent) throw new Error("MEDIA_INTENT_NOT_FOUND");
        if (intent.finalized_at) throw new Error("MEDIA_INTENT_ALREADY_FINALIZED");
        if (new Date(intent.expires_at).getTime() <= Date.now()) throw new Error("MEDIA_INTENT_EXPIRED");
        if (intent.expected_sha256 !== original.sha256 || Number(intent.expected_size) !== original.byteSize ||
          (intent.expected_media_type !== null && intent.expected_media_type !== original.mediaType) || intent.storage_key !== input.uploadedStorageKey) {
          throw new Error("MEDIA_FINALIZATION_MISMATCH");
        }
        const lockedAsset = await client.query<{ state: MediaAssetSummary["state"] }>(
          `SELECT state FROM navocms.media_assets
            WHERE tenant_id = $1 AND site_id = $2 AND id = $3 FOR UPDATE`,
          [scope.tenantId, scope.siteId, intent.asset_id]
        );
        if (lockedAsset.rows[0]?.state !== "pending") throw new Error("MEDIA_ASSET_NOT_FINALIZABLE");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `${scope.tenantId}:${scope.siteId}:${original.sha256}`
        ]);
        const duplicate = await client.query<{ asset_id: string }>(
          `SELECT asset_id FROM navocms.media_originals
            WHERE tenant_id = $1 AND site_id = $2 AND sha256 = $3`,
          [scope.tenantId, scope.siteId, original.sha256]
        );
        if (duplicate.rows[0]) {
          await client.query(
            `UPDATE navocms.media_assets
                SET state = 'rejected', rejection_reason = 'duplicate_sha256', updated_at = now()
              WHERE tenant_id = $1 AND site_id = $2 AND id = $3 AND state = 'pending'`,
            [scope.tenantId, scope.siteId, intent.asset_id]
          );
          await client.query(
            `UPDATE navocms.media_upload_intents SET finalized_at = now()
              WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
            [scope.tenantId, scope.siteId, intent.id]
          );
          const row = (await client.query<AssetRow>(`${assetSelect()} WHERE a.tenant_id = $1 AND a.site_id = $2 AND a.id = $3`,
            [scope.tenantId, scope.siteId, intent.asset_id])).rows[0]!;
          return { row, kind: "duplicate" as const };
        }
        await client.query(
          `INSERT INTO navocms.media_originals
             (id, tenant_id, site_id, asset_id, sha256, byte_size, media_type, width, height, frames, storage_key, verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
          [randomUUID(), scope.tenantId, scope.siteId, intent.asset_id, original.sha256, original.byteSize,
            original.mediaType, original.width, original.height, original.frames, original.storageKey]
        );
        const updatedAsset = await client.query(
          `UPDATE navocms.media_assets SET state = 'verified', updated_at = now()
            WHERE tenant_id = $1 AND site_id = $2 AND id = $3 AND state = 'pending'`,
          [scope.tenantId, scope.siteId, intent.asset_id]
        );
        if ((updatedAsset.rowCount ?? 0) !== 1) throw new Error("MEDIA_ASSET_NOT_FINALIZABLE");
        await client.query(
          `UPDATE navocms.media_upload_intents SET finalized_at = now()
            WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
          [scope.tenantId, scope.siteId, intent.id]
        );
        const row = (await client.query<AssetRow>(`${assetSelect()} WHERE a.tenant_id = $1 AND a.site_id = $2 AND a.id = $3`,
          [scope.tenantId, scope.siteId, intent.asset_id])).rows[0]!;
        return { row, kind: "verified" as const };
      });
      const asset = toAsset(outcome.row);
      if (outcome.kind === "duplicate") {
        await this.append(scope, "media_upload_finalize", asset.id, input.idempotencyKey, "io.navocms.media.asset.rejected.v1", {
          assetId: asset.id, reason: "duplicate_sha256"
        });
      } else {
        await this.append(scope, "media_upload_finalize", asset.id, input.idempotencyKey, "io.navocms.media.original.verified.v1", {
          assetId: asset.id, sha256: original.sha256, mediaType: original.mediaType,
          byteSize: original.byteSize, width: original.width, height: original.height, frames: original.frames
        });
      }
      return asset;
    });
  }

  public async getAsset(scope: MediaScope, assetId: string): Promise<MediaAssetSummary | undefined> {
    const rows = await this.#database.withScope(scope, async (client) => (
      await client.query<AssetRow>(`${assetSelect()} WHERE a.tenant_id = $1 AND a.site_id = $2 AND a.id = $3`, [scope.tenantId, scope.siteId, assetId])
    ).rows);
    return rows[0] ? toAsset(rows[0]) : undefined;
  }

  public async getAssetReview(scope: MediaScope, assetId: string, referenceLimit: number): Promise<MediaAssetReview | undefined> {
    assertReadLimit(referenceLimit);
    const row = await this.#database.withScope(scope, async (client) => (
      await client.query<ReviewRow>(
        `${assetSelect("a.provenance_json, a.rights_json")} WHERE a.tenant_id = $1 AND a.site_id = $2 AND a.id = $3`,
        [scope.tenantId, scope.siteId, assetId]
      )).rows[0]
    );
    if (!row) return undefined;
    const referencePage = await this.listReferences(scope, assetId, referenceLimit);
    const variants = await this.#database.withScope(scope, async (client) => (
      await client.query<VariantRow>(
        `SELECT id, variant_identity, sha256, storage_key, byte_size, media_type, width, height, preset_id, preset_version, transform_json
           FROM navocms.media_variants WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3
           ORDER BY created_at, id LIMIT 100`, [scope.tenantId, scope.siteId, assetId]
      )).rows
    );
    return Object.freeze({ ...toAsset(row), provenance: Object.freeze({ ...row.provenance_json }), rights: Object.freeze({ ...row.rights_json }), references: referencePage.references, variants: Object.freeze(variants.map(toVariant)) });
  }

  public async listAssets(scope: MediaScope, limit: number, cursor?: string): Promise<MediaAssetPage> {
    assertReadLimit(limit);
    assertCursor(cursor);
    const rows = await this.#database.withScope(scope, async (client) => (
      await client.query<AssetRow>(
        `${assetSelect()}
          WHERE a.tenant_id = $1 AND a.site_id = $2
            AND ($4::uuid IS NULL OR (a.created_at, a.id) < (
              SELECT cursor_asset.created_at, cursor_asset.id FROM navocms.media_assets cursor_asset
               WHERE cursor_asset.tenant_id = $1 AND cursor_asset.site_id = $2 AND cursor_asset.id = $4
            ))
          ORDER BY a.created_at DESC, a.id DESC LIMIT $3`,
        [scope.tenantId, scope.siteId, limit + 1, cursor ?? null]
      )
    ).rows);
    const assets = rows.slice(0, limit).map(toAsset);
    return Object.freeze({ assets: Object.freeze(assets), ...(rows.length > limit ? { nextCursor: assets.at(-1)!.id } : {}) });
  }

  public async listReferences(scope: MediaScope, assetId: string, limit: number, cursor?: string): Promise<MediaReferencePage> {
    assertReadLimit(limit);
    assertCursor(cursor);
    const rows = await this.#database.withScope(scope, async (client) => (
      await client.query<ReferenceRow>(
        `SELECT reference.id, reference.owner_type, reference.owner_id, reference.purpose, reference.created_at
           FROM navocms.media_references reference
          WHERE reference.tenant_id = $1 AND reference.site_id = $2 AND reference.asset_id = $3
            AND reference.deleted_at IS NULL
            AND ($5::uuid IS NULL OR (reference.created_at, reference.id) < (
              SELECT cursor_reference.created_at, cursor_reference.id FROM navocms.media_references cursor_reference
               WHERE cursor_reference.tenant_id = $1 AND cursor_reference.site_id = $2
                 AND cursor_reference.asset_id = $3 AND cursor_reference.id = $5
            ))
          ORDER BY reference.created_at DESC, reference.id DESC LIMIT $4`,
        [scope.tenantId, scope.siteId, assetId, limit + 1, cursor ?? null]
      )).rows
    );
    const references = rows.slice(0, limit).map(toReference);
    return Object.freeze({ references: Object.freeze(references), ...(rows.length > limit ? { nextCursor: references.at(-1)!.id } : {}) });
  }

  public async createReference(scope: MediaScope, input: MediaReferenceInput): Promise<{ readonly id: string }> {
    return this.idempotent(scope, "media_reference_create", input.idempotencyKey, input, async () => {
      const id = randomUUID();
      await this.#database.withScope(scope, (client) => client.query(
        `INSERT INTO navocms.media_references (id, tenant_id, site_id, asset_id, owner_type, owner_id, purpose)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, scope.tenantId, scope.siteId, input.assetId, input.ownerType, input.ownerId, input.purpose]
      ));
      await this.append(scope, "media_reference_create", input.assetId, input.idempotencyKey, "io.navocms.media.reference.created.v1", { assetId: input.assetId, referenceId: id, purpose: input.purpose });
      return Object.freeze({ id });
    });
  }

  public async removeReference(scope: MediaScope, referenceId: string, idempotencyKey: string): Promise<void> {
    await this.idempotent(scope, "media_reference_remove", idempotencyKey, { referenceId }, async () => {
      const assetId = await this.#database.withScope(scope, async (client) => {
        const result = await client.query<{ asset_id: string }>(
          `UPDATE navocms.media_references SET deleted_at = now()
            WHERE tenant_id = $1 AND site_id = $2 AND id = $3 AND deleted_at IS NULL RETURNING asset_id`,
          [scope.tenantId, scope.siteId, referenceId]
        );
        if (!result.rows[0]) throw new Error("MEDIA_REFERENCE_NOT_FOUND");
        return result.rows[0].asset_id;
      });
      await this.append(scope, "media_reference_remove", assetId, idempotencyKey, "io.navocms.media.reference.removed.v1", { assetId, referenceId });
      return null;
    });
  }

  public async rejectAsset(scope: MediaScope, input: RejectMediaAssetInput): Promise<MediaAssetSummary> {
    if (!input.reason.trim() || input.reason.length > 500) throw new Error("MEDIA_REJECTION_REASON_INVALID");
    return this.idempotent(scope, "media_asset_reject", input.idempotencyKey, input, async () => {
      const row = await this.#database.withScope(scope, async (client) => {
        const result = await client.query<AssetRow>(
          `UPDATE navocms.media_assets
              SET state = 'rejected', rejection_reason = $4, updated_at = now()
            WHERE tenant_id = $1 AND site_id = $2 AND id = $3 AND state IN ('pending', 'quarantined')
          RETURNING id, state, created_at, rejection_reason, NULL::text AS sha256,
                    NULL::bigint AS byte_size, NULL::text AS media_type, NULL::integer AS width, NULL::integer AS height`,
          [scope.tenantId, scope.siteId, input.assetId, input.reason]
        );
        if (!result.rows[0]) throw new Error("MEDIA_ASSET_NOT_REJECTABLE");
        return result.rows[0];
      });
      const asset = toAsset(row);
      await this.append(scope, "media_asset_reject", asset.id, input.idempotencyKey, "io.navocms.media.asset.rejected.v1", {
        assetId: asset.id, reason: input.reason
      });
      return asset;
    });
  }

  public async generateVariant(scope: MediaScope, input: GenerateMediaVariantInput): Promise<MediaVariantSummary> {
    assertIdempotencyKey(input.idempotencyKey);
    const preset = resolvePreset(input.presetId, input.presetVersion);
    const crop = input.crop ?? "center";
    assertVariantTransform(preset, input.width, input.format, crop, input.focalPoint);
    const transform = Object.freeze({ presetId: preset.presetId, presetVersion: preset.presetVersion, width: input.width, format: input.format, crop, ...(input.focalPoint ? { focalPoint: { x: input.focalPoint.x, y: input.focalPoint.y } } : {}) });
    const original = await this.variantOriginal(scope, input.assetId);
    assertOriginalKey(scope, original.storage_key, original.sha256);
    const identity = variantIdentity(original.sha256, preset.presetVersion, transform);
    const existing = await this.#idempotency.lookup<MediaVariantSummary>(scope, "media_variant_generate", input.idempotencyKey, fingerprintOf(input));
    if (existing?.status === "completed") return existing.value;
    if (existing) throw new Error("MEDIA_IDEMPOTENCY_INCOMPLETE");
    if (!this.#storage) throw new Error("MEDIA_STORAGE_UNAVAILABLE");
    const header = await this.#storage.head(original.storage_key);
    if (!header || header.sha256 !== original.sha256 || header.mediaType !== original.media_type || header.byteSize !== Number(original.byte_size) || header.byteSize > MEDIA_LIMITS.maxBytes) throw new Error("MEDIA_VARIANT_SOURCE_MISMATCH");
    const source = await this.#storage.read(original.storage_key, Number(original.byte_size));
    if (!source || source.key !== original.storage_key || source.mediaType !== original.media_type || source.bytes.byteLength !== header.byteSize || sha256(source.bytes) !== original.sha256) throw new Error("MEDIA_VARIANT_SOURCE_MISMATCH");
    inspectMedia(source.bytes, original.media_type);
    const processed = await this.#processor.process({ bytes: source.bytes, mediaType: original.media_type, preset, width: input.width, format: input.format, crop, ...(input.focalPoint ? { focalPoint: input.focalPoint } : {}) });
    if (processed.bytes.byteLength < 1 || processed.bytes.byteLength > MEDIA_LIMITS.maxBytes ||
      processed.mediaType !== input.format || !Number.isSafeInteger(processed.width) || !Number.isSafeInteger(processed.height) ||
      processed.width < 1 || processed.height < 1 || processed.width > input.width ||
      processed.width > MEDIA_LIMITS.maxDimension || processed.height > MEDIA_LIMITS.maxDimension ||
      processed.width * processed.height > MEDIA_LIMITS.maxPixels ||
      (preset.maxHeight !== undefined && processed.height > preset.maxHeight)) throw new Error("MEDIA_VARIANT_OUTPUT_INVALID");
    const outputSha = sha256(processed.bytes);
    const checkpoint = await this.idempotent(scope, "media_variant_prepare", input.idempotencyKey, { assetId: input.assetId, identity, transform }, async () => {
      const storageKey = variantKey(scope, identity);
      return this.#database.withScope(scope, async (client) => {
        const row = await client.query<VariantCheckpointRow>(
          `INSERT INTO navocms.media_variant_checkpoints
             (id, tenant_id, site_id, asset_id, original_sha256, variant_identity, storage_key,
              output_sha256, byte_size, media_type, width, height, preset_id, preset_version,
              transform_json, operation_key, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,'effect_pending')
           ON CONFLICT (tenant_id, site_id, variant_identity) DO UPDATE
             SET updated_at = media_variant_checkpoints.updated_at
           RETURNING id AS checkpoint_id, storage_key, original_sha256, output_sha256, byte_size,
             media_type, width, height, preset_id, preset_version, transform_json`,
          [randomUUID(), scope.tenantId, scope.siteId, input.assetId, original.sha256, identity, storageKey,
            outputSha, processed.bytes.byteLength, processed.mediaType, processed.width, processed.height,
            preset.presetId, preset.presetVersion, JSON.stringify(transform), eventOperationKey("media_variant_generate", input.idempotencyKey)]
        );
        const checkpoint = row.rows[0];
        if (!checkpoint) throw new Error("MEDIA_VARIANT_CHECKPOINT_INVALID");
        assertVariantCheckpoint(checkpoint, original.sha256, outputSha, processed, preset.presetId, preset.presetVersion, transform);
        await this.append(scope, "media_variant_prepare", input.assetId, input.idempotencyKey, "io.navocms.media.variant.prepared.v1", { assetId: input.assetId, variantIdentity: identity });
        return Object.freeze({ checkpointId: checkpoint.checkpoint_id, storageKey: checkpoint.storage_key });
      });
    });
    await this.#storage.putImmutable({ key: checkpoint.storageKey, bytes: processed.bytes, mediaType: processed.mediaType });
    const storedHead = await this.#storage.head(checkpoint.storageKey);
    if (!storedHead || storedHead.byteSize !== processed.bytes.byteLength || storedHead.sha256 !== outputSha || storedHead.mediaType !== processed.mediaType) throw new Error("MEDIA_VARIANT_STORAGE_MISMATCH");
    const stored = await this.#storage.read(checkpoint.storageKey, processed.bytes.byteLength);
    if (!stored || stored.key !== checkpoint.storageKey || stored.mediaType !== processed.mediaType || stored.bytes.byteLength !== processed.bytes.byteLength || sha256(stored.bytes) !== outputSha) throw new Error("MEDIA_VARIANT_STORAGE_MISMATCH");
    return this.idempotent(scope, "media_variant_generate", input.idempotencyKey, input, async () => {
      const row = await this.#database.withScope(scope, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${scope.tenantId}:${scope.siteId}:${identity}`]);
        const present = (await client.query<VariantRow>(
          `SELECT id, variant_identity, sha256, storage_key, byte_size, media_type, width, height, preset_id, preset_version, transform_json
             FROM navocms.media_variants WHERE tenant_id = $1 AND site_id = $2 AND variant_identity = $3 FOR UPDATE`,
          [scope.tenantId, scope.siteId, identity]
        )).rows[0];
        if (present) {
          assertVariantRow(present, checkpoint.storageKey, outputSha, processed, preset.presetId, preset.presetVersion, transform);
          return present;
        }
        const inserted = (await client.query<VariantRow>(
          `INSERT INTO navocms.media_variants
             (id, tenant_id, site_id, asset_id, original_sha256, variant_identity, sha256, storage_key, byte_size, media_type, width, height, preset_id, preset_version, transform_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
           RETURNING id, variant_identity, sha256, storage_key, byte_size, media_type, width, height, preset_id, preset_version, transform_json`,
          [randomUUID(), scope.tenantId, scope.siteId, input.assetId, original.sha256, identity, outputSha, checkpoint.storageKey, processed.bytes.byteLength, processed.mediaType, processed.width, processed.height, preset.presetId, preset.presetVersion, JSON.stringify(transform)]
        )).rows[0]!;
        const completed = await client.query(
          `UPDATE navocms.media_variant_checkpoints SET status = 'completed', completed_at = now(), updated_at = now()
            WHERE tenant_id = $1 AND site_id = $2 AND variant_identity = $3 AND status = 'effect_pending'`,
          [scope.tenantId, scope.siteId, identity]
        );
        if ((completed.rowCount ?? 0) !== 1) throw new Error("MEDIA_VARIANT_CHECKPOINT_INVALID");
        return inserted;
      });
      const variant = toVariant(row);
      await this.append(scope, "media_variant_generate", input.assetId, input.idempotencyKey, "io.navocms.media.variant.generated.v1", {
        assetId: input.assetId, variantIdentity: identity, storageKey: variant.storageKey,
        sha256: variant.sha256, byteSize: variant.byteSize, mediaType: variant.mediaType,
        width: variant.width, height: variant.height, presetId: variant.presetId,
        presetVersion: variant.presetVersion
      });
      return variant;
    });
  }

  /**
   * Marks an unreferenced asset as deleted and persists the mandatory grace
   * checkpoint before any provider effect.  Recoverable deletion is a second,
   * retryable operation so SQL never attempts to include object storage in its
   * transaction.
   */
  public async scheduleDelete(scope: MediaScope, input: ScheduleMediaDeleteInput): Promise<MediaAssetSummary> {
    assertIdempotencyKey(input.idempotencyKey);
    // Keep a small clock-skew margin above the database-enforced 24-hour floor.
    const graceUntil = new Date(Date.now() + MIN_DELETE_GRACE_MS + 60_000);
    return this.idempotent(scope, "media_delete_schedule", input.idempotencyKey, input, async () => {
      const row = await this.#database.withScope(scope, async (client) => {
        const original = (await client.query<LifecycleOriginalRow>(
          `SELECT a.id, a.state, o.storage_key, NULL::timestamptz AS recoverable_until, a.deleted_at
             FROM navocms.media_assets a JOIN navocms.media_originals o
               ON o.tenant_id = a.tenant_id AND o.site_id = a.site_id AND o.asset_id = a.id
            WHERE a.tenant_id = $1 AND a.site_id = $2 AND a.id = $3 FOR UPDATE`,
          [scope.tenantId, scope.siteId, input.assetId]
        )).rows[0];
        if (!original || !["verified", "ready"].includes(original.state)) throw new Error("MEDIA_ASSET_NOT_DELETABLE");
        const references = await client.query<{ present: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM navocms.media_references
             WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3 AND deleted_at IS NULL) AS present`,
          [scope.tenantId, scope.siteId, input.assetId]
        );
        if (references.rows[0]?.present) throw new Error("MEDIA_ASSET_HAS_LIVE_REFERENCES");
        await client.query(
          `UPDATE navocms.media_assets SET state = 'deleted', deleted_at = now(), purge_after = $4, updated_at = now()
            WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
          [scope.tenantId, scope.siteId, input.assetId, graceUntil]
        );
        await client.query(
          `INSERT INTO navocms.media_gc_candidates (id, tenant_id, site_id, asset_id, recoverable_until)
           VALUES ($1,$2,$3,$4,$5)`,
          [randomUUID(), scope.tenantId, scope.siteId, input.assetId, graceUntil]
        );
        await client.query(
          `INSERT INTO navocms.media_lifecycle_checkpoints
             (id, tenant_id, site_id, asset_id, storage_key, operation, operation_key, status, grace_until, checkpoint_json)
           VALUES ($1,$2,$3,$4,$5,'schedule_delete',$6,'scheduled',$7,$8::jsonb)`,
          [randomUUID(), scope.tenantId, scope.siteId, input.assetId, original.storage_key,
            eventOperationKey("media_delete_schedule", input.idempotencyKey), graceUntil,
            JSON.stringify({ priorState: original.state })]
        );
        return (await client.query<AssetRow>(`${assetSelect()} WHERE a.tenant_id = $1 AND a.site_id = $2 AND a.id = $3`,
          [scope.tenantId, scope.siteId, input.assetId])).rows[0]!;
      });
      const asset = toAsset(row);
      await this.append(scope, "media_delete_schedule", asset.id, input.idempotencyKey, "io.navocms.media.asset.delete.scheduled.v1", {
        assetId: asset.id, graceUntil: graceUntil.toISOString()
      });
      return asset;
    });
  }

  public async recoverableDelete(scope: MediaScope, input: MediaLifecycleInput): Promise<void> {
    assertIdempotencyKey(input.idempotencyKey);
    const existing = await this.#idempotency.lookup<null>(scope, "media_recoverable_delete", input.idempotencyKey, fingerprintOf(input));
    if (existing?.status === "completed") return;
    if (existing) throw new Error("MEDIA_IDEMPOTENCY_INCOMPLETE");
    const original = await this.lifecycleOriginal(scope, input.assetId, true);
    if (!this.#storage) throw new Error("MEDIA_STORAGE_UNAVAILABLE");
    await this.prepareLifecycleEffect(scope, input.assetId, original.storage_key, "recoverable_delete", input.idempotencyKey, new Date(original.recoverable_until!));
    await this.#storage.deleteRecoverable(original.storage_key, new Date(original.recoverable_until!));
    await this.idempotent(scope, "media_recoverable_delete", input.idempotencyKey, input, async () => {
      await this.#database.withScope(scope, async (client) => {
        await this.completeLifecycleEffect(client, scope, "recoverable_delete", input.idempotencyKey);
      });
      await this.append(scope, "media_recoverable_delete", input.assetId, input.idempotencyKey, "io.navocms.media.asset.recoverably.deleted.v1", {
        assetId: input.assetId, graceUntil: new Date(original.recoverable_until!).toISOString()
      });
      return null;
    });
  }

  public async restore(scope: MediaScope, input: MediaLifecycleInput): Promise<MediaAssetSummary> {
    assertIdempotencyKey(input.idempotencyKey);
    const existing = await this.#idempotency.lookup<MediaAssetSummary>(scope, "media_restore", input.idempotencyKey, fingerprintOf(input));
    if (existing?.status === "completed") return existing.value;
    if (existing) throw new Error("MEDIA_IDEMPOTENCY_INCOMPLETE");
    const original = await this.lifecycleOriginal(scope, input.assetId, true);
    if (new Date(original.recoverable_until!).getTime() <= Date.now()) throw new Error("MEDIA_RESTORE_GRACE_EXPIRED");
    if (!await this.hasCurrentRecoverableDelete(scope, input.assetId)) throw new Error("MEDIA_RECOVERABLE_DELETE_REQUIRED");
    if (!this.#storage) throw new Error("MEDIA_STORAGE_UNAVAILABLE");
    await this.prepareLifecycleEffect(scope, input.assetId, original.storage_key, "restore", input.idempotencyKey, new Date(original.recoverable_until!));
    const restored = await this.#storage.restore(original.storage_key);
    if (!restored && !await this.#storage.head(original.storage_key)) throw new Error("MEDIA_RESTORE_STORAGE_MISSING");
    return this.idempotent(scope, "media_restore", input.idempotencyKey, input, async () => {
      const row = await this.#database.withScope(scope, async (client) => {
        const prior = (await client.query<{ checkpoint_json: Readonly<Record<string, unknown>> }>(
          `SELECT checkpoint_json FROM navocms.media_lifecycle_checkpoints
            WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3 AND operation = 'schedule_delete'
            ORDER BY created_at DESC LIMIT 1`, [scope.tenantId, scope.siteId, input.assetId]
        )).rows[0];
        const state = prior?.checkpoint_json.priorState === "ready" ? "ready" : "verified";
        const updated = await client.query<AssetRow>(
          `UPDATE navocms.media_assets SET state = $4, deleted_at = NULL, purge_after = NULL, updated_at = now()
            WHERE tenant_id = $1 AND site_id = $2 AND id = $3 AND state = 'deleted'
            RETURNING id`,
          [scope.tenantId, scope.siteId, input.assetId, state]
        );
        if (!updated.rows[0]) throw new Error("MEDIA_ASSET_NOT_RESTORABLE");
        await client.query(`DELETE FROM navocms.media_gc_candidates WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3`, [scope.tenantId, scope.siteId, input.assetId]);
        await this.completeLifecycleEffect(client, scope, "restore", input.idempotencyKey);
        return (await client.query<AssetRow>(`${assetSelect()} WHERE a.tenant_id = $1 AND a.site_id = $2 AND a.id = $3`,
          [scope.tenantId, scope.siteId, input.assetId])).rows[0]!;
      });
      const asset = toAsset(row);
      await this.append(scope, "media_restore", asset.id, input.idempotencyKey, "io.navocms.media.asset.restored.v1", { assetId: asset.id });
      return asset;
    });
  }

  public async reclaim(scope: MediaScope, input: MediaLifecycleInput): Promise<void> {
    assertIdempotencyKey(input.idempotencyKey);
    const existing = await this.#idempotency.lookup<null>(scope, "media_reclaim", input.idempotencyKey, fingerprintOf(input));
    if (existing?.status === "completed") return;
    if (existing) throw new Error("MEDIA_IDEMPOTENCY_INCOMPLETE");
    const original = await this.lifecycleOriginal(scope, input.assetId, true);
    const graceUntil = new Date(original.recoverable_until!);
    if (graceUntil.getTime() > Date.now()) throw new Error("MEDIA_RECLAIM_GRACE_NOT_ELAPSED");
    if (!original.deleted_at || new Date(original.deleted_at).getTime() + MIN_DELETE_GRACE_MS > Date.now()) throw new Error("MEDIA_RECLAIM_GRACE_NOT_ELAPSED");
    if (!await this.hasCurrentRecoverableDelete(scope, input.assetId)) throw new Error("MEDIA_RECOVERABLE_DELETE_REQUIRED");
    if (!this.#storage) throw new Error("MEDIA_STORAGE_UNAVAILABLE");
    await this.prepareLifecycleEffect(scope, input.assetId, original.storage_key, "reclaim", input.idempotencyKey, graceUntil);
    const reclaimed = await this.#storage.reclaim(original.storage_key, new Date());
    if (!reclaimed && await this.#storage.head(original.storage_key)) throw new Error("MEDIA_RECLAIM_STORAGE_STILL_LIVE");
    await this.idempotent(scope, "media_reclaim", input.idempotencyKey, input, async () => {
      await this.#database.withScope(scope, async (client) => {
        const updated = await client.query(
          `UPDATE navocms.media_gc_candidates SET reclaimed_at = now()
            WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3 AND reclaimed_at IS NULL`,
          [scope.tenantId, scope.siteId, input.assetId]
        );
        if ((updated.rowCount ?? 0) !== 1) throw new Error("MEDIA_ASSET_NOT_RECLAIMABLE");
        await this.completeLifecycleEffect(client, scope, "reclaim", input.idempotencyKey);
      });
      await this.append(scope, "media_reclaim", input.assetId, input.idempotencyKey, "io.navocms.media.asset.reclaimed.v1", { assetId: input.assetId });
      return null;
    });
  }

  public async reconcile(scope: MediaScope, input: ReconcileMediaInput): Promise<MediaReconciliationResult> {
    assertIdempotencyKey(input.idempotencyKey);
    assertReadLimit(input.limit);
    assertInventoryCursor(scope, input.cursor);
    if (!this.#storage) throw new Error("MEDIA_STORAGE_UNAVAILABLE");
    const page = await this.#storage.inventory(originalPrefix(scope), input.limit, input.cursor);
    assertInventoryCursor(scope, page.nextCursor);
    const databasePage = await this.#database.withScope(scope, async (client) => (
      await client.query<OriginalInventoryRow>(
        `SELECT o.asset_id, o.sha256, o.storage_key, a.state FROM navocms.media_originals o
          JOIN navocms.media_assets a ON a.tenant_id = o.tenant_id AND a.site_id = o.site_id AND a.id = o.asset_id
         WHERE o.tenant_id = $1 AND o.site_id = $2 AND a.state IN ('verified', 'ready')
           AND ($3::text IS NULL OR o.storage_key > $3)
         ORDER BY o.storage_key LIMIT $4`,
        [scope.tenantId, scope.siteId, input.cursor ?? null, input.limit + 1]
      )).rows
    );
    const databaseHasMore = databasePage.length > input.limit;
    const databaseOriginals = databasePage.slice(0, input.limit);
    const keys = [...new Set([...page.objects.map(({ key }) => key), ...databaseOriginals.map(({ storage_key }) => storage_key)])].sort();
    const selectedKeys = keys.slice(0, input.limit);
    const selected = new Set(selectedKeys);
    const more = keys.length > input.limit || page.nextCursor !== undefined || databaseHasMore;
    let orphanedStorageObjects = 0;
    for (const object of page.objects.filter(({ key }) => selected.has(key))) {
      assertOriginalKey(scope, object.key, object.sha256);
      const known = await this.originalExists(scope, object.key);
      if (known) continue;
      orphanedStorageObjects += 1;
      // Preserve a small margin above the schema floor, as scheduleDelete does.
      const graceUntil = new Date(Date.now() + MIN_DELETE_GRACE_MS + 60_000);
      const operationKey = `media_reconcile_orphan:${object.sha256}`;
      const prepared = await this.idempotent(scope, "media_reconcile_orphan_prepare", object.sha256, { storageKey: object.key }, async () => {
        const checkpointId = randomUUID();
        await this.#database.withScope(scope, async (client) => {
          await client.query(
            `INSERT INTO navocms.media_lifecycle_checkpoints
               (id, tenant_id, site_id, asset_id, storage_key, operation, operation_key, status, grace_until)
             VALUES ($1,$2,$3,NULL,$4,'reconcile_orphan',$5,'effect_pending',$6)
             ON CONFLICT (tenant_id, site_id, operation, operation_key) DO NOTHING`,
            [checkpointId, scope.tenantId, scope.siteId, object.key, operationKey, graceUntil]
          );
        });
        await this.append(scope, "media_reconcile_orphan_prepare", checkpointId, object.sha256, "io.navocms.media.lifecycle.effect.prepared.v1", {
          storageKey: object.key, operation: "reconcile_orphan", graceUntil: graceUntil.toISOString()
        });
        return Object.freeze({ checkpointId, graceUntil: graceUntil.toISOString() });
      });
      const preparedGraceUntil = new Date(prepared.graceUntil);
      await this.#storage.deleteRecoverable(object.key, preparedGraceUntil);
      await this.idempotent(scope, "media_reconcile_orphan", object.sha256, { storageKey: object.key }, async () => {
        await this.#database.withScope(scope, async (client) => {
          await this.completeLifecycleEffect(client, scope, "reconcile_orphan", object.sha256);
        });
        await this.append(scope, "media_reconcile_orphan", prepared.checkpointId, object.sha256, "io.navocms.media.storage.orphaned.v1", {
          storageKey: object.key, sha256: object.sha256, graceUntil: preparedGraceUntil.toISOString()
        });
        return null;
      });
    }
    let missingStorageObjects = 0;
    for (const original of databaseOriginals.filter(({ storage_key }) => selected.has(storage_key))) {
      if (await this.#storage.head(original.storage_key)) continue;
      missingStorageObjects += 1;
      await this.idempotent(scope, "media_reconcile_missing", original.sha256, { assetId: original.asset_id, storageKey: original.storage_key }, async () => {
        await this.#database.withScope(scope, async (client) => {
          await client.query(
            `UPDATE navocms.media_assets SET state = 'quarantined', updated_at = now()
              WHERE tenant_id = $1 AND site_id = $2 AND id = $3 AND state <> 'deleted'`,
            [scope.tenantId, scope.siteId, original.asset_id]
          );
          await client.query(
            `INSERT INTO navocms.media_lifecycle_checkpoints
               (id, tenant_id, site_id, asset_id, storage_key, operation, operation_key, status)
             VALUES ($1,$2,$3,$4,$5,'reconcile_missing',$6,'storage_missing')
             ON CONFLICT (tenant_id, site_id, operation, operation_key) DO NOTHING`,
            [randomUUID(), scope.tenantId, scope.siteId, original.asset_id, original.storage_key,
              `media_reconcile_missing:${original.sha256}`]
          );
        });
        await this.append(scope, "media_reconcile_missing", original.asset_id, original.sha256, "io.navocms.media.storage.missing.v1", {
          assetId: original.asset_id, storageKey: original.storage_key
        });
        return null;
      });
    }
    return Object.freeze({
      inspected: selectedKeys.length,
      orphanedStorageObjects,
      missingStorageObjects,
      ...(more && selectedKeys.length > 0 ? { nextCursor: selectedKeys.at(-1)! } : {})
    });
  }

  private async lifecycleOriginal(scope: MediaScope, assetId: string, requireDeleted: boolean): Promise<LifecycleOriginalRow> {
    const row = await this.#database.withScope(scope, async (client) => (
      await client.query<LifecycleOriginalRow>(
        `SELECT a.id, a.state, o.storage_key, gc.recoverable_until, a.deleted_at
           FROM navocms.media_assets a
           JOIN navocms.media_originals o ON o.tenant_id = a.tenant_id AND o.site_id = a.site_id AND o.asset_id = a.id
           LEFT JOIN navocms.media_gc_candidates gc ON gc.tenant_id = a.tenant_id AND gc.site_id = a.site_id AND gc.asset_id = a.id
          WHERE a.tenant_id = $1 AND a.site_id = $2 AND a.id = $3`,
        [scope.tenantId, scope.siteId, assetId]
      )).rows[0]
    );
    if (!row || (requireDeleted && (row.state !== "deleted" || !row.recoverable_until))) throw new Error("MEDIA_ASSET_NOT_DELETED");
    return row;
  }

  private async variantOriginal(scope: MediaScope, assetId: string): Promise<VariantOriginalRow> {
    const row = await this.#database.withScope(scope, async (client) => (
      await client.query<VariantOriginalRow>(
        `SELECT o.asset_id, o.sha256, o.byte_size, o.media_type, o.storage_key
           FROM navocms.media_originals o JOIN navocms.media_assets a
             ON a.tenant_id = o.tenant_id AND a.site_id = o.site_id AND a.id = o.asset_id
          WHERE o.tenant_id = $1 AND o.site_id = $2 AND o.asset_id = $3
            AND a.state IN ('verified', 'ready')`, [scope.tenantId, scope.siteId, assetId]
      )).rows[0]
    );
    if (!row) throw new Error("MEDIA_VARIANT_SOURCE_NOT_FOUND");
    return row;
  }

  private async originalExists(scope: MediaScope, storageKey: string): Promise<boolean> {
    return this.#database.withScope(scope, async (client) => {
      const row = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM navocms.media_originals
          WHERE tenant_id = $1 AND site_id = $2 AND storage_key = $3) AS present`,
        [scope.tenantId, scope.siteId, storageKey]
      );
      return row.rows[0]?.present === true;
    });
  }

  /** A completed delete from an older restore/delete cycle is not sufficient. */
  private async hasCurrentRecoverableDelete(scope: MediaScope, assetId: string): Promise<boolean> {
    return this.#database.withScope(scope, async (client) => {
      const row = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM navocms.media_lifecycle_checkpoints recovered
            WHERE recovered.tenant_id = $1 AND recovered.site_id = $2 AND recovered.asset_id = $3
              AND recovered.operation = 'recoverable_delete' AND recovered.status = 'completed'
              AND recovered.created_at >= (
                SELECT max(scheduled.created_at) FROM navocms.media_lifecycle_checkpoints scheduled
                 WHERE scheduled.tenant_id = $1 AND scheduled.site_id = $2 AND scheduled.asset_id = $3
                   AND scheduled.operation = 'schedule_delete'
              )
         ) AS present`,
        [scope.tenantId, scope.siteId, assetId]
      );
      return row.rows[0]?.present === true;
    });
  }

  private async prepareLifecycleEffect(scope: MediaScope, assetId: string, storageKey: string, operation: "recoverable_delete" | "restore" | "reclaim", clientKey: string, graceUntil: Date): Promise<void> {
    const prepareOperation = `media_${operation}_prepare`;
    await this.idempotent(scope, prepareOperation, clientKey, { assetId, storageKey, graceUntil: graceUntil.toISOString() }, async () => {
      await this.#database.withScope(scope, async (client) => {
        await client.query(
          `INSERT INTO navocms.media_lifecycle_checkpoints
             (id, tenant_id, site_id, asset_id, storage_key, operation, operation_key, status, grace_until)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'effect_pending',$8)
           ON CONFLICT (tenant_id, site_id, operation, operation_key) DO NOTHING`,
          [randomUUID(), scope.tenantId, scope.siteId, assetId, storageKey, operation, eventOperationKey(`media_${operation}`, clientKey), graceUntil]
        );
      });
      await this.append(scope, prepareOperation, assetId, clientKey, "io.navocms.media.lifecycle.effect.prepared.v1", {
        assetId, operation, graceUntil: graceUntil.toISOString()
      });
      return null;
    });
  }

  private async completeLifecycleEffect(client: SqlClient, scope: MediaScope, operation: "recoverable_delete" | "restore" | "reclaim" | "reconcile_orphan", clientKey: string): Promise<void> {
    const result = await client.query(
      `UPDATE navocms.media_lifecycle_checkpoints SET status = 'completed', completed_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND site_id = $2 AND operation = $3 AND operation_key = $4 AND status = 'effect_pending'`,
      [scope.tenantId, scope.siteId, operation, eventOperationKey(`media_${operation}`, clientKey)]
    );
    if ((result.rowCount ?? 0) !== 1) throw new Error("MEDIA_LIFECYCLE_CHECKPOINT_INVALID");
  }

  private async idempotent<T>(scope: MediaScope, operation: string, key: string, input: unknown, mutation: () => Promise<T>): Promise<T> {
    assertIdempotencyKey(key);
    return this.#database.withScope(scope, async () => {
      const fingerprint = fingerprintOf(input);
      const reservation = await this.#idempotency.reserve<T>(scope, operation, key, fingerprint);
      if (reservation.status === "completed") return reservation.value;
      if (reservation.status !== "reserved") throw new Error("MEDIA_IDEMPOTENCY_INCOMPLETE");
      const value = await mutation();
      await this.#idempotency.complete(scope, operation, key, fingerprint, value);
      return value;
    });
  }

  private async loadIntentForValidation(scope: MediaScope, intentId: string): Promise<IntentRow> {
    const intent = await this.#database.withScope(scope, async (client) => {
      const result = await client.query<IntentRow>(
        `SELECT id, asset_id, expected_sha256, expected_size, expected_media_type, storage_key, expires_at, finalized_at
           FROM navocms.media_upload_intents
          WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
        [scope.tenantId, scope.siteId, intentId]
      );
      return result.rows[0];
    });
    if (!intent) throw new Error("MEDIA_INTENT_NOT_FOUND");
    return intent;
  }

  private async findOriginalBySha(scope: MediaScope, sha256: string): Promise<MediaAssetSummary | undefined> {
    const rows = await this.#database.withScope(scope, async (client) => (
      await client.query<AssetRow>(
        `${assetSelect()} WHERE a.tenant_id = $1 AND a.site_id = $2 AND o.sha256 = $3`,
        [scope.tenantId, scope.siteId, sha256]
      )).rows
    );
    return rows[0] ? toAsset(rows[0]) : undefined;
  }

  private async append(scope: MediaScope, operation: string, correlationId: string, clientKey: string, type: string, data: Record<string, unknown>): Promise<void> {
    const idempotencyKey = `${operation}:${clientKey}`;
    if (idempotencyKey.length > MAX_EVENT_IDEMPOTENCY_KEY_LENGTH) throw new Error("MEDIA_EVENT_IDEMPOTENCY_KEY_INVALID");
    const factory = new DomainEventFactory({
      source: "urn:navocms:media", tenantId: scope.tenantId, siteId: scope.siteId, correlationId,
      actor: { type: scope.principalKind, id: scope.principalId }
    });
    await this.#events.append(factory.create({ type, subject: correlationId, consequence: "G1", idempotencyKey, data }));
  }
}

function assetSelect(extra = ""): string {
  return `SELECT a.id, a.state, a.created_at, a.rejection_reason, o.sha256, o.byte_size, o.media_type, o.width, o.height${extra ? `, ${extra}` : ""}
    FROM navocms.media_assets a LEFT JOIN navocms.media_originals o
      ON o.tenant_id = a.tenant_id AND o.site_id = a.site_id AND o.asset_id = a.id`;
}

function assertReadLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("MEDIA_LIST_LIMIT_INVALID");
}

function assertCursor(cursor: string | undefined): void {
  if (cursor !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor)) {
    throw new Error("MEDIA_CURSOR_INVALID");
  }
}

function assertInventoryCursor(scope: MediaScope, cursor: string | undefined): void {
  if (cursor !== undefined && (!cursor.startsWith(originalPrefix(scope)) || cursor.length > 512)) throw new Error("MEDIA_INVENTORY_CURSOR_INVALID");
}

function eventOperationKey(operation: string, clientKey: string): string {
  const value = `${operation}:${clientKey}`;
  if (value.length > MAX_EVENT_IDEMPOTENCY_KEY_LENGTH) throw new Error("MEDIA_EVENT_IDEMPOTENCY_KEY_INVALID");
  return value;
}

function toReference(row: ReferenceRow): MediaReferenceSummary {
  return Object.freeze({ id: row.id, ownerType: row.owner_type, ownerId: row.owner_id, purpose: row.purpose, createdAt: new Date(row.created_at).toISOString() });
}

function toVariant(row: VariantRow): MediaVariantSummary {
  return Object.freeze({ id: row.id, variantIdentity: row.variant_identity, sha256: row.sha256,
    storageKey: row.storage_key, byteSize: Number(row.byte_size), mediaType: row.media_type,
    width: row.width, height: row.height, presetId: row.preset_id, presetVersion: row.preset_version,
    transform: Object.freeze({ ...row.transform_json }) });
}

function assertVariantRow(
  row: VariantRow,
  storageKey: string,
  outputSha: string,
  processed: Readonly<{ bytes: Uint8Array; mediaType: MediaVariantSummary["mediaType"]; width: number; height: number }>,
  presetId: string,
  presetVersion: string,
  transform: Readonly<Record<string, unknown>>
): void {
  if (row.storage_key !== storageKey || row.sha256 !== outputSha || Number(row.byte_size) !== processed.bytes.byteLength ||
    row.media_type !== processed.mediaType || row.width !== processed.width || row.height !== processed.height ||
    row.preset_id !== presetId || row.preset_version !== presetVersion ||
    fingerprintOf(row.transform_json) !== fingerprintOf(transform)) {
    throw new Error("MEDIA_VARIANT_PERSISTED_MISMATCH");
  }
}

function assertVariantCheckpoint(
  row: VariantCheckpointRow,
  originalSha: string,
  outputSha: string,
  processed: Readonly<{ bytes: Uint8Array; mediaType: MediaVariantSummary["mediaType"]; width: number; height: number }>,
  presetId: string,
  presetVersion: string,
  transform: Readonly<Record<string, unknown>>
): void {
  if (row.original_sha256 !== originalSha || row.output_sha256 !== outputSha ||
    Number(row.byte_size) !== processed.bytes.byteLength || row.media_type !== processed.mediaType ||
    row.width !== processed.width || row.height !== processed.height || row.preset_id !== presetId ||
    row.preset_version !== presetVersion || fingerprintOf(row.transform_json) !== fingerprintOf(transform)) {
    throw new Error("MEDIA_VARIANT_CHECKPOINT_MISMATCH");
  }
}

function toAsset(row: AssetRow): MediaAssetSummary {
  return Object.freeze({ id: row.id, state: row.state, createdAt: new Date(row.created_at).toISOString(),
    ...(row.sha256 ? { sha256: row.sha256, mediaType: row.media_type!, byteSize: Number(row.byte_size), width: row.width!, height: row.height! } : {}),
    ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}) });
}

function assertIntentInput(scope: MediaScope, input: CreateUploadIntentInput): void {
  assertIdempotencyKey(input.idempotencyKey);
  const expiresAt = Date.parse(input.expiresAt);
  if (!/^[a-f0-9]{64}$/.test(input.expectedSha256) || !Number.isSafeInteger(input.expectedSize) || input.expectedSize < 1 || input.expectedSize > MEDIA_LIMITS.maxBytes || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + MAX_INTENT_TTL_MS || (input.expectedMediaType !== undefined && !["image/jpeg", "image/png"].includes(input.expectedMediaType))) throw new Error("MEDIA_INTENT_INVALID");
  assertProvenance(scope, input.provenance);
  assertRights(input.rights);
}

function assertIdempotencyKey(key: string): void {
  if (typeof key !== "string" || !key.trim() || key.length < 16 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) throw new Error("MEDIA_IDEMPOTENCY_KEY_INVALID");
}

function assertProvenance(scope: MediaScope, provenance: Readonly<Record<string, unknown>>): void {
  assertJsonRecord(provenance, "MEDIA_PROVENANCE_INVALID");
  const allowed = new Set(["kind", "sourceUrl", "receivedAt", "receivedBy"]);
  if (Object.keys(provenance).some((key) => !allowed.has(key)) || !["upload", "remote-ingest", "import"].includes(String(provenance.kind)) || typeof provenance.receivedAt !== "string" || !Number.isFinite(Date.parse(provenance.receivedAt)) || provenance.receivedBy !== scope.principalId) throw new Error("MEDIA_PROVENANCE_INVALID");
  if (provenance.sourceUrl !== undefined && (typeof provenance.sourceUrl !== "string" || provenance.sourceUrl.length > 2048 || !isUrl(provenance.sourceUrl))) throw new Error("MEDIA_PROVENANCE_INVALID");
}

function assertRights(rights: Readonly<Record<string, unknown>>): void {
  assertJsonRecord(rights, "MEDIA_RIGHTS_INVALID");
  const allowed = new Set(["license", "holder", "expiresAt", "restricted"]);
  if (Object.keys(rights).some((key) => !allowed.has(key)) || typeof rights.license !== "string" || !rights.license.trim() || rights.license.length > 200 || typeof rights.restricted !== "boolean" || (rights.holder !== undefined && (typeof rights.holder !== "string" || rights.holder.length > 200)) || (rights.expiresAt !== undefined && (typeof rights.expiresAt !== "string" || !Number.isFinite(Date.parse(rights.expiresAt))))) throw new Error("MEDIA_RIGHTS_INVALID");
}

function assertJsonRecord(value: Readonly<Record<string, unknown>>, errorCode: string): void {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > 16) throw new Error(errorCode);
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new Error(errorCode); }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_METADATA_BYTES) throw new Error(errorCode);
}

function isUrl(value: string): boolean { try { new URL(value); return true; } catch { return false; } }

function fingerprintOf(value: unknown): string {
  const stable = (nested: unknown): string => Array.isArray(nested) ? `[${nested.map(stable).join(",")}]` : nested && typeof nested === "object" ? `{${Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}` : JSON.stringify(nested) ?? "null";
  return createHash("sha256").update(stable(value)).digest("hex");
}
