import { createHash, createHmac } from "node:crypto";

import type { PostgresDatabase } from "@navocms/persistence-postgres";
import type { MediaScope } from "./domain.js";
import { sha256, type MediaStorage, type StorageObject } from "./storage.js";
import { MEDIA_LIMITS } from "./validation.js";

const MAX_INVENTORY = 100;
const MAX_SIGNED_UPLOAD_TTL_SECONDS = 15 * 60;
const directUploadSigningCapability = Symbol("navocms.direct-upload-signing");
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export interface S3TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: AsyncIterable<Uint8Array>;
  /** Cancels an HTTP response body after a bounded consumer stops reading. */
  readonly abort?: () => Promise<void> | void;
}

/** A deliberately small seam: tests inject this; no credentials are logged. */
export interface S3Transport {
  request(input: Readonly<{ method: string; key: string; headers?: Readonly<Record<string, string>>; body?: Uint8Array; query?: Readonly<Record<string, string>> }>): Promise<S3TransportResponse>;
}

export interface S3StorageOptions extends Pick<MediaScope, "tenantId" | "siteId"> {
  readonly bucket: string;
  readonly transport: S3Transport;
  readonly clock?: () => Date;
  /** Optional by design: a provider is never activated by a profile implicitly. */
  readonly directUploadSigning?: Readonly<{ endpoint: string; region: string; accessKeyId: string; secretAccessKey: string }>;
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
  readonly #bucket: string;
  readonly #transport: S3Transport;
  readonly #clock: () => Date;
  readonly #directUploadSigning: S3StorageOptions["directUploadSigning"];

  public constructor(options: S3StorageOptions) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new Error("STORAGE_BUCKET_INVALID");
    this.#scope = { tenantId: options.tenantId, siteId: options.siteId };
    this.#bucket = options.bucket;
    this.#transport = options.transport;
    this.#clock = options.clock ?? (() => new Date());
    this.#directUploadSigning = options.directUploadSigning;
  }

  public async putImmutable(object: StorageObject): Promise<void> {
    this.assertKey(object.key);
    const digest = sha256(object.bytes);
    const response = await this.request({ method: "PUT", key: object.key, body: object.bytes, headers: immutableHeaders(object.mediaType, digest, object.bytes.byteLength) });
    if (response.status !== 412 && response.status !== 409) return this.expectSuccess(response);

    // An external write can win immediately before its DB checkpoint fails.
    const existing = await this.read(object.key, object.bytes.byteLength);
    if (!existing || existing.mediaType !== object.mediaType || existing.bytes.byteLength !== object.bytes.byteLength || sha256(existing.bytes) !== digest) throw new Error("STORAGE_KEY_IMMUTABLE");
  }

  public async head(key: string): Promise<Readonly<{ byteSize: number; sha256: string; mediaType: string }> | undefined> {
    const metadata = await this.headMetadata(key);
    return metadata && Object.freeze({ byteSize: metadata.byteSize, sha256: metadata.sha256, mediaType: metadata.mediaType });
  }

  public async read(key: string, maxBytes: number): Promise<StorageObject | undefined> {
    this.assertKey(key);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("STORAGE_READ_LIMIT_INVALID");
    const head = await this.headMetadata(key);
    if (!head) return undefined;
    if (head.byteSize > maxBytes) throw new Error("STORAGE_READ_LIMIT_EXCEEDED");
    // Ask for one extra byte: a provider that lies in HEAD but honours Range
    // cannot hide a body larger than the repository's explicit bound.
    const response = await this.request({ method: "GET", key, headers: { range: `bytes=0-${maxBytes}` } });
    if (response.status === 404) return undefined;
    this.expectSuccess(response);
    const bytes = await readBounded(response, maxBytes, "STORAGE_READ_LIMIT_EXCEEDED");
    if (bytes.byteLength !== head.byteSize || sha256(bytes) !== head.sha256) throw new Error("STORAGE_BODY_MISMATCH");
    return Object.freeze({ key, bytes, mediaType: head.mediaType });
  }

  public async deleteRecoverable(key: string, recoverableUntil: Date): Promise<void> {
    this.assertKey(key);
    if (!isFiniteDate(recoverableUntil) || recoverableUntil.getTime() <= this.#clock().getTime()) throw new Error("STORAGE_RECOVERY_DEADLINE_INVALID");
    const source = await this.headMetadata(key);
    if (!source) return;
    const recovery = recoveryKey(key); this.assertKey(recovery);
    const copied = await this.request({ method: "PUT", key: recovery, headers: {
      "x-amz-copy-source": copySource(this.#bucket, key), "x-amz-metadata-directive": "REPLACE",
      ...metadataHeaders(source.mediaType, source.sha256), "x-amz-meta-recoverable-until": recoverableUntil.toISOString()
    } });
    this.expectSuccess(copied);
    const copiedMetadata = await this.headMetadata(recovery);
    if (!copiedMetadata || copiedMetadata.byteSize !== source.byteSize || copiedMetadata.sha256 !== source.sha256 || copiedMetadata.mediaType !== source.mediaType || copiedMetadata.recoverableUntil?.getTime() !== recoverableUntil.getTime()) throw new Error("STORAGE_RECOVERY_COPY_INVALID");
    this.expectSuccess(await this.request({ method: "DELETE", key }));
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
    this.expectSuccess(await this.request({ method: "DELETE", key: recovery }));
    return true;
  }

  public async reclaim(key: string, now: Date): Promise<boolean> {
    this.assertKey(key);
    if (!isFiniteDate(now)) throw new Error("STORAGE_RECLAIM_TIME_INVALID");
    const recovery = recoveryKey(key);
    const marker = await this.headMetadata(recovery);
    if (!marker) return false;
    if (!marker.recoverableUntil || now.getTime() < marker.recoverableUntil.getTime()) throw new Error("STORAGE_RECLAIM_GRACE_NOT_ELAPSED");
    this.expectSuccess(await this.request({ method: "DELETE", key: recovery }));
    return true;
  }

  public async inventory(prefix: string, limit: number, cursor?: string): Promise<Readonly<{ objects: readonly Readonly<{ key: string; byteSize: number; sha256: string; mediaType: string }>[]; nextCursor?: string }>> {
    this.assertPrefix(prefix);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INVENTORY) throw new Error("STORAGE_INVENTORY_LIMIT_INVALID");
    if (cursor !== undefined) {
      if (!cursor.startsWith(prefix) || cursor < prefix) throw new Error("STORAGE_INVENTORY_CURSOR_INVALID");
      this.assertKey(cursor);
    }
    // The repository cursor is a validated, exclusive storage key, never an opaque provider token.
    const response = await this.request({ method: "GET", key: "", query: { "list-type": "2", prefix, "max-keys": String(limit), ...(cursor ? { "start-after": cursor } : {}) } });
    this.expectSuccess(response);
    const body = new TextDecoder().decode(await readBounded(response, 256 * 1024, "STORAGE_RESPONSE_LIMIT_EXCEEDED"));
    const listed = [...body.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)].map((match) => ({ key: decodeXml(match[1]!), byteSize: Number(match[2]!) }));
    if (listed.length > limit) throw new Error("STORAGE_INVENTORY_LIMIT_EXCEEDED");
    const objects = await Promise.all(listed.map(async ({ key, byteSize }) => {
      if (!key.startsWith(prefix)) throw new Error("STORAGE_KEY_SCOPE_MISMATCH");
      this.assertKey(key);
      const metadata = await this.head(key);
      if (!metadata || metadata.byteSize !== byteSize) throw new Error("STORAGE_METADATA_INVALID");
      return Object.freeze({ key, ...metadata });
    }));
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(body);
    if (truncated && objects.length === 0) throw new Error("STORAGE_INVENTORY_INVALID");
    return Object.freeze({ objects: Object.freeze(objects), ...(truncated ? { nextCursor: objects.at(-1)!.key } : {}) });
  }

  /** @internal Requires the module-private issuer capability. */
  public signDirectUploadWithCapability(intent: DirectUploadIntentBinding, ttlSeconds: number, capability: symbol): SignedDirectUpload {
    if (capability !== directUploadSigningCapability) throw new Error("STORAGE_SIGNING_FORBIDDEN");
    this.assertKey(intent.storageKey);
    assertIntent(intent, ttlSeconds, this.#clock());
    const signing = this.#directUploadSigning;
    if (!signing) throw new Error("STORAGE_SIGNING_UNAVAILABLE");
    const url = new URL(signing.endpoint);
    if (url.protocol !== "https:" || !signing.accessKeyId || !signing.secretAccessKey || !/^[a-z0-9-]{2,32}$/.test(signing.region)) throw new Error("STORAGE_SIGNING_CONFIG_INVALID");
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
    const signedUrl = presignPut(url, this.#bucket, intent.storageKey, intentHeaders, effectiveTtl, signing, now);
    return Object.freeze({ key: intent.storageKey, method: "PUT", expiresAt: new Date(now.getTime() + effectiveTtl * 1000).toISOString(), headers, url: signedUrl });
  }

  private async headMetadata(key: string): Promise<HeadMetadata | undefined> {
    this.assertKey(key);
    const response = await this.request({ method: "HEAD", key });
    if (response.status === 404) return undefined;
    this.expectSuccess(response);
    const headers = normalized(response.headers);
    const byteSize = Number(headers["content-length"]); const digest = headers["x-amz-meta-sha256"];
    const mediaType = headers["x-amz-meta-media-type"] ?? headers["content-type"];
    const rawDeadline = headers["x-amz-meta-recoverable-until"];
    const recoverableUntil = rawDeadline === undefined ? undefined : new Date(rawDeadline);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0 || !digest || !/^[a-f0-9]{64}$/.test(digest) || !mediaType || (recoverableUntil && !isFiniteDate(recoverableUntil))) throw new Error("STORAGE_METADATA_INVALID");
    return Object.freeze({ byteSize, sha256: digest, mediaType, ...(recoverableUntil ? { recoverableUntil } : {}) });
  }

  private async request(input: Parameters<S3Transport["request"]>[0]): Promise<S3TransportResponse> { try { return await this.#transport.request(input); } catch { throw new Error("STORAGE_PROVIDER_UNAVAILABLE"); } }
  private expectSuccess(response: S3TransportResponse): void { if (response.status < 200 || response.status >= 300) throw new Error(`STORAGE_PROVIDER_${response.status >= 500 ? "UNAVAILABLE" : "REJECTED"}`); }
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

function immutableHeaders(mediaType: string, digest: string, byteSize: number): Record<string, string> { return { "if-none-match": "*", "content-type": mediaType, "content-length": String(byteSize), ...metadataHeaders(mediaType, digest) }; }
function metadataHeaders(mediaType: string, digest: string): Record<string, string> { return { "x-amz-meta-sha256": digest, "x-amz-meta-media-type": mediaType }; }
function assertIntent(intent: DirectUploadIntentBinding, ttl: number, now: Date): void { const expiry = Date.parse(intent.expiresAt); if (!/^[0-9a-f-]{36}$/i.test(intent.intentId) || !intent.storageKey.endsWith(`/pending/${intent.intentId}`) || !/^[a-f0-9]{64}$/.test(intent.expectedSha256) || !Number.isSafeInteger(intent.expectedSize) || intent.expectedSize < 1 || intent.expectedSize > MEDIA_LIMITS.maxBytes || !["image/jpeg", "image/png"].includes(intent.expectedMediaType) || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_SIGNED_UPLOAD_TTL_SECONDS || !Number.isFinite(expiry) || expiry <= now.getTime()) throw new Error("STORAGE_UPLOAD_INTENT_INVALID"); }
function recoveryKey(key: string): string { const [prefix] = key.split("/originals/"); return `${prefix}/__recoverable/${Buffer.from(key).toString("base64url")}`; }
function copySource(bucket: string, key: string): string { return `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`; }
function normalized(headers: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> { return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])); }
function isFiniteDate(value: Date): boolean { return Number.isFinite(value.getTime()); }
function concat(chunks: readonly Uint8Array[], size: number): Uint8Array { const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes; }
async function readBounded(response: S3TransportResponse, limit: number, limitCode: string): Promise<Uint8Array> { const chunks: Uint8Array[] = []; let size = 0; let aborted = false; const abort = async () => { if (!aborted) { aborted = true; try { await response.abort?.(); } catch { /* provider error is deliberately normalized */ } } }; try { for await (const chunk of response.body ?? []) { size += chunk.byteLength; if (size > limit) { await abort(); throw new Error(limitCode); } chunks.push(new Uint8Array(chunk)); } } catch (error) { await abort(); if (error instanceof Error && error.message === limitCode) throw error; throw new Error("STORAGE_PROVIDER_UNAVAILABLE"); } return concat(chunks, size); }
function decodeXml(value: string): string { return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
function presignPut(endpoint: URL, bucket: string, key: string, headers: Readonly<Record<string, string>>, ttl: number, signing: NonNullable<S3StorageOptions["directUploadSigning"]>, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); const date = stamp.slice(0, 8); const scope = `${date}/${signing.region}/s3/aws4_request`;
  const hoistedHeaders = Object.entries(headers).filter(([name]) => name.toLowerCase().startsWith("x-amz-"));
  // S3 requires host to be part of the canonical headers and signed headers.
  const headerNames = [...Object.keys(headers).filter((name) => !name.toLowerCase().startsWith("x-amz-")), "host"].sort(); const signedHeaders = headerNames.join(";");
  const query = new URLSearchParams({ "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${signing.accessKeyId}/${scope}`, "X-Amz-Date": stamp, "X-Amz-Expires": String(ttl), "X-Amz-SignedHeaders": signedHeaders });
  for (const [name, value] of hoistedHeaders) query.set(name, value);
  const canonicalQuery = [...query.entries()].sort(([left], [right]) => asciiCompare(left, right)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"); const path = `${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const canonicalHeaders = headerNames.map((name) => `${name}:${name === "host" ? endpoint.host : headers[name]}\n`).join(""); const canonical = `PUT\n${path}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${UNSIGNED_PAYLOAD}`; const stringToSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${hex(canonical)}`;
  const signingKey = hmac(hmac(hmac(hmac(Buffer.from(`AWS4${signing.secretAccessKey}`), date), signing.region), "s3"), "aws4_request"); query.set("X-Amz-Signature", createHmac("sha256", signingKey).update(stringToSign).digest("hex")); endpoint.pathname = path; endpoint.search = query.toString(); return endpoint.toString();
}
function hmac(key: Uint8Array, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
function hex(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function asciiCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
