import { createHash, randomUUID } from "node:crypto";

import { DomainEventFactory, type EventStore } from "@navocms/kernel";
import { PostgresDatabase, PostgresEventStore, PostgresIdempotencyStore } from "@navocms/persistence-postgres";

import type {
  CreateUploadIntentInput,
  CreateUploadResult,
  FinalizeUploadInput,
  MediaAssetSummary,
  MediaReferenceInput,
  MediaRepository,
  MediaScope,
  RejectMediaAssetInput
} from "./domain.js";
import { originalKey, sha256, type MediaStorage } from "./storage.js";
import { inspectMedia, MEDIA_LIMITS, verifyUpload } from "./validation.js";

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

const MAX_INTENT_TTL_MS = 15 * 60 * 1000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_EVENT_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * Finalization reads and validates the temporary object before it begins the
 * SQL mutation. The immutable object write remains deliberately outside SQL:
 * reconciliation of an orphan is a later media-worker responsibility.
 */
export class PostgresMediaRepository implements MediaRepository {
  readonly #database: PostgresDatabase;
  readonly #storage: MediaStorage;
  readonly #idempotency: PostgresIdempotencyStore;
  readonly #events: EventStore;

  public constructor(
    database: PostgresDatabase,
    storage: MediaStorage,
    idempotency: PostgresIdempotencyStore = new PostgresIdempotencyStore(database),
    events: EventStore = new PostgresEventStore(database)
  ) {
    this.#database = database;
    this.#storage = storage;
    this.#idempotency = idempotency;
    this.#events = events;
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

  public async listAssets(scope: MediaScope, limit: number): Promise<readonly MediaAssetSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("MEDIA_LIST_LIMIT_INVALID");
    const rows = await this.#database.withScope(scope, async (client) => (
      await client.query<AssetRow>(`${assetSelect()} WHERE a.tenant_id = $1 AND a.site_id = $2 ORDER BY a.created_at DESC LIMIT $3`, [scope.tenantId, scope.siteId, limit])
    ).rows);
    return Object.freeze(rows.map(toAsset));
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

function assetSelect(): string {
  return `SELECT a.id, a.state, a.created_at, a.rejection_reason, o.sha256, o.byte_size, o.media_type, o.width, o.height
    FROM navocms.media_assets a LEFT JOIN navocms.media_originals o
      ON o.tenant_id = a.tenant_id AND o.site_id = a.site_id AND o.asset_id = a.id`;
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
