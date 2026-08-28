import { NAVOCMS_MEDIA_NAMESPACE, S3NamespaceStorage, type S3PresigningOptions, type S3Transport } from "@navocms/s3-core";
import type { PostgresDatabase } from "@navocms/persistence-postgres";
import type { MediaScope } from "./domain.js";
import { sha256, type MediaStorage, type StorageObject } from "./storage.js";
import { MEDIA_LIMITS } from "./validation.js";

const MAX_SIGNED_UPLOAD_TTL_SECONDS = 15 * 60;
const directUploadSigningCapability = Symbol("navocms.direct-upload-signing");
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
/** @deprecated Import transport contracts from `@navocms/s3-core`. */
export type { S3Transport, S3TransportResponse } from "@navocms/s3-core";

export interface S3StorageOptions extends Pick<MediaScope, "tenantId" | "siteId"> {
  readonly bucket: string;
  readonly transport: S3Transport;
  readonly clock?: () => Date;
  /** Optional by design: a provider is never activated by a profile implicitly. */
  readonly directUploadSigning?: S3PresigningOptions;
}

/** This is a verified persistence projection, never client-provided MCP input. */
interface DirectUploadIntentBinding {
  readonly intentId: string;
  readonly storageKey: string;
  readonly expectedSha256: string;
  readonly expectedSize: number;
  readonly expectedMediaType: "image/jpeg" | "image/png";
  readonly expiresAt: string;
}

export interface SignedDirectUpload {
  readonly key: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly method: "PUT";
  readonly headers: Readonly<Record<string, string>>;
}

interface HeadMetadata {
  readonly byteSize: number;
  readonly sha256: string;
  readonly mediaType: string;
  readonly recoverableUntil?: Date;
}

/** R2/S3-compatible, scope-bound object boundary. */
export class S3CompatibleMediaStorage implements MediaStorage {
  readonly #scope: Pick<MediaScope, "tenantId" | "siteId">;
  readonly #store: S3NamespaceStorage;
  readonly #clock: () => Date;
  readonly #directUploadSigning: S3StorageOptions["directUploadSigning"];

  public constructor(options: S3StorageOptions) {
    this.#scope = { tenantId: options.tenantId, siteId: options.siteId };
    this.#store = new S3NamespaceStorage({ bucket: options.bucket, namespace: NAVOCMS_MEDIA_NAMESPACE, transport: options.transport });
    this.#clock = options.clock ?? (() => new Date());
    this.#directUploadSigning = options.directUploadSigning;
  }

  public async putImmutable(object: StorageObject): Promise<void> {
    this.assertKey(object.key);
    await this.#store.putImmutable(object);
  }

  public async head(key: string): Promise<Readonly<{ byteSize: number; sha256: string; mediaType: string }> | undefined> {
    const metadata = await this.headMetadata(key);
    return metadata && Object.freeze({ byteSize: metadata.byteSize, sha256: metadata.sha256, mediaType: metadata.mediaType });
  }

  public async read(key: string, maxBytes: number): Promise<StorageObject | undefined> {
    this.assertKey(key);
    return this.#store.read(key, maxBytes);
  }

  public async deleteRecoverable(key: string, recoverableUntil: Date): Promise<void> {
    this.assertKey(key);
    if (!isFiniteDate(recoverableUntil) || recoverableUntil.getTime() <= this.#clock().getTime()) throw new Error("STORAGE_RECOVERY_DEADLINE_INVALID");
    const source = await this.headMetadata(key);
    if (!source) return;
    const recovery = recoveryKey(key); this.assertKey(recovery);
    await this.#store.copy(key, recovery, {
      "x-amz-metadata-directive": "REPLACE",
      ...metadataHeaders(source.mediaType, source.sha256), "x-amz-meta-recoverable-until": recoverableUntil.toISOString()
    });
    const copiedMetadata = await this.headMetadata(recovery);
    if (!copiedMetadata || copiedMetadata.byteSize !== source.byteSize || copiedMetadata.sha256 !== source.sha256 || copiedMetadata.mediaType !== source.mediaType || copiedMetadata.recoverableUntil?.getTime() !== recoverableUntil.getTime()) throw new Error("STORAGE_RECOVERY_COPY_INVALID");
    await this.#store.delete(key);
  }

  public async restore(key: string): Promise<boolean> {
    this.assertKey(key);
    const recovery = recoveryKey(key);
    const marker = await this.headMetadata(recovery);
    if (!marker) return false;
    if (!marker.recoverableUntil || marker.recoverableUntil.getTime() <= this.#clock().getTime()) throw new Error("STORAGE_RECOVERY_EXPIRED");
    // R2 documents destination conditions for PutObject, not CopyObject. Read
    // the bounded recovery object and let putImmutable reconcile an exact
    // replay; only then is it safe to delete the recovery object.
    const recoveryObject = await this.read(recovery, marker.byteSize);
    if (!recoveryObject || recoveryObject.mediaType !== marker.mediaType || recoveryObject.bytes.byteLength !== marker.byteSize || sha256(recoveryObject.bytes) !== marker.sha256) throw new Error("STORAGE_RESTORE_COPY_INVALID");
    await this.putImmutable({ key, bytes: recoveryObject.bytes, mediaType: recoveryObject.mediaType });
    await this.#store.delete(recovery);
    return true;
  }

  public async reclaim(key: string, now: Date): Promise<boolean> {
    this.assertKey(key);
    if (!isFiniteDate(now)) throw new Error("STORAGE_RECLAIM_TIME_INVALID");
    const recovery = recoveryKey(key);
    const marker = await this.headMetadata(recovery);
    if (!marker) return false;
    if (!marker.recoverableUntil || now.getTime() < marker.recoverableUntil.getTime()) throw new Error("STORAGE_RECLAIM_GRACE_NOT_ELAPSED");
    await this.#store.delete(recovery);
    return true;
  }

  public async inventory(prefix: string, limit: number, cursor?: string): Promise<Readonly<{ objects: readonly Readonly<{ key: string; byteSize: number; sha256: string; mediaType: string }>[]; nextCursor?: string }>> {
    this.assertPrefix(prefix);
    const page = await this.#store.inventory(prefix, limit, cursor);
    for (const object of page.objects) this.assertKey(object.key);
    return page;
  }

  /** @internal Requires the module-private issuer capability. */
  public signDirectUploadWithCapability(intent: DirectUploadIntentBinding, ttlSeconds: number, capability: symbol): SignedDirectUpload {
    if (capability !== directUploadSigningCapability) throw new Error("STORAGE_SIGNING_FORBIDDEN");
    this.assertKey(intent.storageKey);
    assertIntent(intent, ttlSeconds, this.#clock());
    const signing = this.#directUploadSigning;
    if (!signing) throw new Error("STORAGE_SIGNING_UNAVAILABLE");
    if (!signing.accessKeyId || !signing.secretAccessKey) throw new Error("STORAGE_SIGNING_CONFIG_INVALID");
    const now = this.#clock(); const intentExpiry = Date.parse(intent.expiresAt);
    const effectiveTtl = Math.min(ttlSeconds, Math.floor((intentExpiry - now.getTime()) / 1000));
    if (!Number.isFinite(effectiveTtl) || effectiveTtl < 1) throw new Error("STORAGE_UPLOAD_INTENT_INVALID");
    const intentHeaders = Object.freeze({
      "content-type": intent.expectedMediaType, "if-none-match": "*", "x-amz-meta-sha256": intent.expectedSha256,
      "x-amz-meta-media-type": intent.expectedMediaType, "x-amz-meta-expected-size": String(intent.expectedSize),
      "X-Amz-Content-Sha256": UNSIGNED_PAYLOAD,
      "x-navocms-upload-intent": intent.intentId, "x-navocms-upload-ttl": String(effectiveTtl)
    });
    // AWS SDK v3 hoists x-amz-* into the signed query string. Returning them
    // as browser headers as well would change the signed request shape.
    const headers = Object.freeze(Object.fromEntries(Object.entries(intentHeaders).filter(([name]) => !name.toLowerCase().startsWith("x-amz-"))));
    const signedUrl = this.#store.presignPut(intent.storageKey, intentHeaders, effectiveTtl, signing, now);
    return Object.freeze({ key: intent.storageKey, method: "PUT", expiresAt: new Date(now.getTime() + effectiveTtl * 1000).toISOString(), headers, url: signedUrl });
  }

  private async headMetadata(key: string): Promise<HeadMetadata | undefined> {
    this.assertKey(key);
    const metadata = await this.#store.head(key);
    if (!metadata) return undefined;
    const rawDeadline = metadata.metadata["recoverable-until"];
    const recoverableUntil = rawDeadline === undefined ? undefined : new Date(rawDeadline);
    if (recoverableUntil && !isFiniteDate(recoverableUntil)) throw new Error("STORAGE_METADATA_INVALID");
    return Object.freeze({ byteSize: metadata.byteSize, sha256: metadata.sha256, mediaType: metadata.mediaType, ...(recoverableUntil ? { recoverableUntil } : {}) });
  }

  private assertPrefix(prefix: string): void { if (prefix !== `tenants/${this.#scope.tenantId}/sites/${this.#scope.siteId}/originals/`) throw new Error("STORAGE_KEY_SCOPE_MISMATCH"); }
  private assertKey(key: string): void { const prefix = `tenants/${this.#scope.tenantId}/sites/${this.#scope.siteId}/`; if (!key.startsWith(prefix) || !/^(?:pending\/[0-9a-f-]{36}|originals\/[a-f0-9]{64}|variants\/[a-f0-9]{64}|__recoverable\/[A-Za-z0-9_-]+)$/.test(key.slice(prefix.length))) throw new Error("STORAGE_KEY_SCOPE_MISMATCH"); }
}

/**
 * The only application-facing direct-upload issuer. It projects a currently
 * pending, scoped PostgreSQL intent immediately before creating the URL;
 * callers cannot bind an arbitrary key or a finalized/expired intent.
 */
export class PostgresMediaUploadIntentSigner {
  readonly #database: PostgresDatabase;
  readonly #storage: S3CompatibleMediaStorage;

  public constructor(database: PostgresDatabase, storage: S3CompatibleMediaStorage) {
    this.#database = database;
    this.#storage = storage;
  }

  public async sign(scope: MediaScope, intentId: string, ttlSeconds: number): Promise<SignedDirectUpload> {
    const binding = await this.#database.withScope(scope, async (client) => {
      const result = await client.query<{
        id: string; storage_key: string; expected_sha256: string; expected_size: number;
        expected_media_type: string | null; expires_at: Date | string; finalized_at: Date | string | null;
      }>(`SELECT i.id, i.storage_key, i.expected_sha256, i.expected_size, i.expected_media_type, i.expires_at, i.finalized_at
           FROM navocms.media_upload_intents i
           JOIN navocms.media_assets a
             ON (a.tenant_id, a.site_id, a.id) = (i.tenant_id, i.site_id, i.asset_id)
          WHERE i.tenant_id = $1 AND i.site_id = $2 AND i.id = $3 AND a.state = 'pending'`, [scope.tenantId, scope.siteId, intentId]);
      const row = result.rows[0];
      if (!row || row.finalized_at !== null || (row.expected_media_type !== "image/jpeg" && row.expected_media_type !== "image/png")) throw new Error("STORAGE_UPLOAD_INTENT_INVALID");
      const expiresAt = new Date(row.expires_at);
      if (!isFiniteDate(expiresAt)) throw new Error("STORAGE_UPLOAD_INTENT_INVALID");
      return Object.freeze({
        intentId: row.id, storageKey: row.storage_key, expectedSha256: row.expected_sha256,
        expectedSize: Number(row.expected_size), expectedMediaType: row.expected_media_type,
        expiresAt: expiresAt.toISOString()
      });
    });
    return this.#storage.signDirectUploadWithCapability(binding, ttlSeconds, directUploadSigningCapability);
  }
}

function metadataHeaders(mediaType: string, digest: string): Record<string, string> { return { "x-amz-meta-sha256": digest, "x-amz-meta-media-type": mediaType }; }
function assertIntent(intent: DirectUploadIntentBinding, ttl: number, now: Date): void { const expiry = Date.parse(intent.expiresAt); if (!/^[0-9a-f-]{36}$/i.test(intent.intentId) || !intent.storageKey.endsWith(`/pending/${intent.intentId}`) || !/^[a-f0-9]{64}$/.test(intent.expectedSha256) || !Number.isSafeInteger(intent.expectedSize) || intent.expectedSize < 1 || intent.expectedSize > MEDIA_LIMITS.maxBytes || !["image/jpeg", "image/png"].includes(intent.expectedMediaType) || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_SIGNED_UPLOAD_TTL_SECONDS || !Number.isFinite(expiry) || expiry <= now.getTime()) throw new Error("STORAGE_UPLOAD_INTENT_INVALID"); }
function recoveryKey(key: string): string { const [prefix] = key.split("/originals/"); return `${prefix}/__recoverable/${Buffer.from(key).toString("base64url")}`; }
function isFiniteDate(value: Date): boolean { return Number.isFinite(value.getTime()); }
