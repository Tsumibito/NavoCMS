import { createHash, createHmac } from "node:crypto";

const MAX_INVENTORY = 100;
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** The only reviewed root for application-owned shared-bucket objects. */
export const NAVOCMS_S3_NAMESPACE_ROOT = "navocms/v1/";
export type ReviewedS3NamespaceChild = "media" | "artifacts";
export type ReviewedS3Namespace = `${typeof NAVOCMS_S3_NAMESPACE_ROOT}${ReviewedS3NamespaceChild}/`;
export const NAVOCMS_MEDIA_NAMESPACE: ReviewedS3Namespace = "navocms/v1/media/";
export const NAVOCMS_ARTIFACTS_NAMESPACE: ReviewedS3Namespace = "navocms/v1/artifacts/";
/** Select a reviewed child; callers never concatenate runtime namespace input. */
export function reviewedS3Namespace(child: ReviewedS3NamespaceChild): ReviewedS3Namespace {
  if (child === "media") return NAVOCMS_MEDIA_NAMESPACE;
  if (child === "artifacts") return NAVOCMS_ARTIFACTS_NAMESPACE;
  throw new Error("STORAGE_NAMESPACE_INVALID");
}

export interface S3TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: AsyncIterable<Uint8Array>;
  /** Cancels an HTTP response body after a bounded consumer stops reading. */
  readonly abort?: () => Promise<void> | void;
}

export interface S3TransportRequest {
  /** An already namespaced physical object key, never an application key. */
  readonly key: string;
  readonly method: "PUT" | "GET" | "HEAD" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly query?: Readonly<Record<string, string>>;
}

/** The provider seam. Implementations must not expose credentials in errors. */
export interface S3Transport {
  request(input: S3TransportRequest): Promise<S3TransportResponse>;
}

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface FetchS3TransportOptions {
  readonly endpoint: () => string | URL | Promise<string | URL>;
  readonly bucket: () => string | Promise<string>;
  readonly credentials: () => S3Credentials | Promise<S3Credentials>;
  /** R2 uses `auto`; AWS callers can inject their concrete region. */
  readonly region?: () => string | Promise<string>;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
}

export interface S3NamespaceStorageOptions {
  readonly bucket: string;
  /** A fixed physical namespace, for example `navocms/v1/media/`. */
  readonly namespace: ReviewedS3Namespace;
  readonly transport: S3Transport;
}

export interface S3StoredObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface S3ObjectMetadata {
  readonly byteSize: number;
  readonly sha256: string;
  readonly mediaType: string;
  /** x-amz-meta-* values without the header prefix. */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface S3InventoryPage {
  readonly objects: readonly Readonly<{ key: string; byteSize: number; sha256: string; mediaType: string }> [];
  readonly nextCursor?: string;
}

export interface S3PresigningOptions {
  readonly endpoint: string;
  readonly region?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/**
 * Provider-neutral S3/R2 object core. It owns physical namespace mapping and
 * byte/metadata verification; callers retain their domain key policy.
 */
export class S3NamespaceStorage {
  readonly #bucket: string;
  readonly #namespace: ReviewedS3Namespace;
  readonly #transport: S3Transport;

  public constructor(options: S3NamespaceStorageOptions) {
    if (!isBucket(options.bucket)) throw new Error("STORAGE_BUCKET_INVALID");
    if (!isNamespace(options.namespace)) throw new Error("STORAGE_NAMESPACE_INVALID");
    this.#bucket = options.bucket;
    this.#namespace = options.namespace;
    this.#transport = options.transport;
  }

  public async putImmutable(object: S3StoredObject): Promise<void> {
    this.assertKey(object.key);
    const digest = sha256(object.bytes);
    const response = await this.request({ method: "PUT", key: this.physicalKey(object.key), body: object.bytes, headers: immutableHeaders(object.mediaType, digest, object.bytes.byteLength) });
    if (response.status !== 412 && response.status !== 409) return this.expectSuccess(response);
    const existing = await this.read(object.key, object.bytes.byteLength);
    if (!existing || existing.mediaType !== object.mediaType || existing.bytes.byteLength !== object.bytes.byteLength || sha256(existing.bytes) !== digest) throw new Error("STORAGE_KEY_IMMUTABLE");
  }

  public async head(key: string): Promise<S3ObjectMetadata | undefined> {
    this.assertKey(key);
    const response = await this.request({ method: "HEAD", key: this.physicalKey(key) });
    if (response.status === 404) return undefined;
    this.expectSuccess(response);
    return parseMetadata(response.headers);
  }

  public async read(key: string, maxBytes: number): Promise<S3StoredObject | undefined> {
    this.assertKey(key);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("STORAGE_READ_LIMIT_INVALID");
    const head = await this.head(key);
    if (!head) return undefined;
    if (head.byteSize > maxBytes) throw new Error("STORAGE_READ_LIMIT_EXCEEDED");
    // One extra requested byte detects a lying HEAD from a range-aware provider.
    const response = await this.request({ method: "GET", key: this.physicalKey(key), headers: { range: `bytes=0-${maxBytes}` } });
    if (response.status === 404) return undefined;
    this.expectSuccess(response);
    const bytes = await readBounded(response, maxBytes, "STORAGE_READ_LIMIT_EXCEEDED");
    if (bytes.byteLength !== head.byteSize || sha256(bytes) !== head.sha256) throw new Error("STORAGE_BODY_MISMATCH");
    return Object.freeze({ key, bytes, mediaType: head.mediaType });
  }

  public async delete(key: string): Promise<void> {
    this.assertKey(key);
    this.expectSuccess(await this.request({ method: "DELETE", key: this.physicalKey(key) }));
  }

  public async copy(sourceKey: string, destinationKey: string, headers: Readonly<Record<string, string>>): Promise<void> {
    this.assertKey(sourceKey); this.assertKey(destinationKey);
    this.expectSuccess(await this.request({ method: "PUT", key: this.physicalKey(destinationKey), headers: {
      "x-amz-copy-source": copySource(this.#bucket, this.physicalKey(sourceKey)), ...headers
    } }));
  }

  public async inventory(prefix: string, limit: number, cursor?: string): Promise<S3InventoryPage> {
    this.assertPrefix(prefix);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INVENTORY) throw new Error("STORAGE_INVENTORY_LIMIT_INVALID");
    if (cursor !== undefined) {
      if (!cursor.startsWith(prefix) || cursor < prefix) throw new Error("STORAGE_INVENTORY_CURSOR_INVALID");
      this.assertKey(cursor);
    }
    const physicalPrefix = this.physicalPrefix(prefix);
    const response = await this.request({ method: "GET", key: "", query: {
      "list-type": "2", prefix: physicalPrefix, "max-keys": String(limit), ...(cursor ? { "start-after": this.physicalKey(cursor) } : {})
    } });
    this.expectSuccess(response);
    const body = new TextDecoder().decode(await readBounded(response, 256 * 1024, "STORAGE_RESPONSE_LIMIT_EXCEEDED"));
    const listed = [...body.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)].map((match) => ({ key: decodeXml(match[1]!), byteSize: Number(match[2]!) }));
    if (listed.length > limit) throw new Error("STORAGE_INVENTORY_LIMIT_EXCEEDED");
    const objects = await Promise.all(listed.map(async ({ key, byteSize }) => {
      if (!key.startsWith(physicalPrefix)) throw new Error("STORAGE_KEY_SCOPE_MISMATCH");
      const logicalKey = this.logicalKey(key);
      const metadata = await this.head(logicalKey);
      if (!metadata || metadata.byteSize !== byteSize) throw new Error("STORAGE_METADATA_INVALID");
      return Object.freeze({ key: logicalKey, byteSize, sha256: metadata.sha256, mediaType: metadata.mediaType });
    }));
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(body);
    if (truncated && objects.length === 0) throw new Error("STORAGE_INVENTORY_INVALID");
    return Object.freeze({ objects: Object.freeze(objects), ...(truncated ? { nextCursor: objects.at(-1)!.key } : {}) });
  }

  public presignPut(key: string, headers: Readonly<Record<string, string>>, ttl: number, signing: S3PresigningOptions, now: Date): string {
    this.assertKey(key);
    return presignPut(new URL(signing.endpoint), this.#bucket, this.physicalKey(key), headers, ttl, signing, now);
  }

  private physicalKey(key: string): string { return `${this.#namespace}${key}`; }
  private physicalPrefix(prefix: string): string { return `${this.#namespace}${prefix}`; }
  private logicalKey(physicalKey: string): string {
    if (!physicalKey.startsWith(this.#namespace)) throw new Error("STORAGE_KEY_SCOPE_MISMATCH");
    const key = physicalKey.slice(this.#namespace.length); this.assertKey(key); return key;
  }
  private assertKey(key: string): void { if (!isLogicalKey(key, this.#namespace)) throw new Error("STORAGE_KEY_SCOPE_MISMATCH"); }
  private assertPrefix(prefix: string): void { if (!isLogicalPrefix(prefix, this.#namespace)) throw new Error("STORAGE_KEY_SCOPE_MISMATCH"); }
  private async request(input: S3TransportRequest): Promise<S3TransportResponse> { try { return await this.#transport.request(input); } catch { throw new Error("STORAGE_PROVIDER_UNAVAILABLE"); } }
  private expectSuccess(response: S3TransportResponse): void { if (response.status < 200 || response.status >= 300) throw new Error(`STORAGE_PROVIDER_${response.status >= 500 ? "UNAVAILABLE" : "REJECTED"}`); }
}

/** Fetch transport with SigV4 signing. Configuration is obtained only at request time. */
export function createFetchS3Transport(options: FetchS3TransportOptions): S3Transport {
  const requestFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("S3_TRANSPORT_CONFIG_INVALID");
  return Object.freeze({
    async request(input: S3TransportRequest): Promise<S3TransportResponse> {
      try {
        const [endpointValue, bucket, credentials, region] = await Promise.all([options.endpoint(), options.bucket(), options.credentials(), options.region?.() ?? "auto"]);
        if (!isBucket(bucket) || !isCredentials(credentials) || !isRegion(region)) throw new Error("invalid configuration");
        const endpoint = new URL(endpointValue);
        if (!isSafeEndpoint(endpoint)) throw new Error("invalid endpoint");
        const now = options.clock?.() ?? new Date();
        if (!Number.isFinite(now.getTime())) throw new Error("invalid clock");
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
        const clear = () => clearTimeout(timer);
        const abort = () => { clear(); controller.abort(); };
        const url = requestUrl(endpoint, bucket, input.key, input.query);
        const payloadHash = sha256(input.body ?? new Uint8Array());
        const headers = signHeaders(input.method, url, input.headers ?? {}, payloadHash, credentials, region, now);
        const response = await requestFetch(url, { method: input.method, headers, ...(input.body ? { body: input.body } : {}), signal: controller.signal });
        if (!response.body) clear();
        return Object.freeze({ status: response.status, headers: Object.fromEntries(response.headers.entries()), ...(response.body ? { body: readableBody(response.body, clear) } : {}), abort });
      } catch { throw new Error("S3_TRANSPORT_UNAVAILABLE"); }
    }
  });
}

function immutableHeaders(mediaType: string, digest: string, byteSize: number): Record<string, string> { return { "if-none-match": "*", "content-type": mediaType, "content-length": String(byteSize), "x-amz-meta-byte-size": String(byteSize), "x-amz-meta-sha256": digest, "x-amz-meta-media-type": mediaType }; }
function parseMetadata(rawHeaders: Readonly<Record<string, string | undefined>>): S3ObjectMetadata {
  const headers = normalized(rawHeaders); const byteSize = Number(headers["x-amz-meta-byte-size"] ?? headers["content-length"]); const sha = headers["x-amz-meta-sha256"]; const mediaType = headers["x-amz-meta-media-type"] ?? headers["content-type"];
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || !sha || !/^[a-f0-9]{64}$/.test(sha) || !mediaType) throw new Error("STORAGE_METADATA_INVALID");
  const metadata = Object.freeze(Object.fromEntries(Object.entries(headers).flatMap(([key, value]) => key.startsWith("x-amz-meta-") && value !== undefined ? [[key.slice("x-amz-meta-".length), value]] : [])));
  return Object.freeze({ byteSize, sha256: sha, mediaType, metadata });
}
function isBucket(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value); }
function isNamespace(value: unknown): value is ReviewedS3Namespace { return value === NAVOCMS_MEDIA_NAMESPACE || value === NAVOCMS_ARTIFACTS_NAMESPACE; }
function isLogicalKey(value: unknown, namespace: ReviewedS3Namespace): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(`${namespace}${value}`) <= 1024 && !/[\\\u0000-\u001f\u007f]/.test(value) && !value.startsWith("/") && !value.split("/").some((part) => part.length === 0 || part === "." || part === ".."); }
function isLogicalPrefix(value: unknown, namespace: ReviewedS3Namespace): value is string { return typeof value === "string" && value.length > 1 && value.endsWith("/") && Buffer.byteLength(`${namespace}${value}`) <= 1024 && isLogicalKey(value.slice(0, -1), namespace); }
function isRegion(value: unknown): value is string { return typeof value === "string" && (value === "auto" || /^[a-z0-9-]{2,32}$/.test(value)); }
function isCredentials(value: unknown): value is S3Credentials { return typeof value === "object" && value !== null && "accessKeyId" in value && "secretAccessKey" in value && isBoundedCredential(value.accessKeyId, 128) && isBoundedCredential(value.secretAccessKey, 256) && (!("sessionToken" in value) || value.sessionToken === undefined || isBoundedCredential(value.sessionToken, 4096)); }
function isBoundedCredential(value: unknown, maxBytes: number): value is string { return typeof value === "string" && Buffer.byteLength(value) >= 1 && Buffer.byteLength(value) <= maxBytes && !/[\u0000-\u001f\u007f]/.test(value); }
function isSafeEndpoint(value: URL): boolean { return value.protocol === "https:" && value.hostname.length > 0 && !value.username && !value.password && !value.search && !value.hash; }
function normalized(headers: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> { return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])); }
function copySource(bucket: string, key: string): string { return `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`; }
function concat(chunks: readonly Uint8Array[], size: number): Uint8Array { const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes; }
async function readBounded(response: S3TransportResponse, limit: number, limitCode: string): Promise<Uint8Array> { const chunks: Uint8Array[] = []; let size = 0; let aborted = false; const abort = async () => { if (!aborted) { aborted = true; try { await response.abort?.(); } catch { /* normalized below */ } } }; try { for await (const chunk of response.body ?? []) { size += chunk.byteLength; if (size > limit) { await abort(); throw new Error(limitCode); } chunks.push(new Uint8Array(chunk)); } } catch (error) { await abort(); if (error instanceof Error && error.message === limitCode) throw error; throw new Error("STORAGE_PROVIDER_UNAVAILABLE"); } return concat(chunks, size); }
async function* readableBody(body: ReadableStream<Uint8Array>, complete: () => void): AsyncIterable<Uint8Array> { const reader = body.getReader(); try { for (;;) { const next = await reader.read(); if (next.done) return; yield next.value; } } finally { complete(); reader.releaseLock(); } }
function decodeXml(value: string): string { return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
export function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function requestUrl(endpoint: URL, bucket: string, key: string, query?: Readonly<Record<string, string>>): URL { const url = new URL(endpoint); url.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(bucket)}${key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : ""}`; if (query) url.search = canonicalQuery(query); return url; }
function signHeaders(method: string, url: URL, original: Readonly<Record<string, string>>, payloadHash: string, credentials: S3Credentials, region: string, now: Date): Record<string, string> {
  const stamp = amzStamp(now); const date = stamp.slice(0, 8); const headers = normalized({ ...original, host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": stamp, ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}) });
  const names = Object.keys(headers).sort(asciiCompare); const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, " ")}\n`).join(""); const signedHeaders = names.join(";"); const scope = `${date}/${region}/s3/aws4_request`;
  const canonical = `${method}\n${url.pathname}\n${url.search.slice(1)}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`; const signature = signatureFor(hex(canonical), stamp, scope, credentials.secretAccessKey, date, region);
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}
function presignPut(endpoint: URL, bucket: string, key: string, headers: Readonly<Record<string, string>>, ttl: number, signing: S3PresigningOptions, now: Date): string {
  if (!isSafeEndpoint(endpoint) || !isCredentials(signing) || !isRegion(signing.region ?? "auto") || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 604800 || !Number.isFinite(now.getTime())) throw new Error("STORAGE_SIGNING_CONFIG_INVALID");
  const region = signing.region ?? "auto"; const stamp = amzStamp(now); const date = stamp.slice(0, 8); const scope = `${date}/${region}/s3/aws4_request`; const hoisted = Object.entries(headers).filter(([name]) => name.toLowerCase().startsWith("x-amz-")); const headerNames = [...Object.keys(headers).filter((name) => !name.toLowerCase().startsWith("x-amz-")), "host"].sort(asciiCompare); const signedHeaders = headerNames.join(";");
  const query: Record<string, string> = { "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${signing.accessKeyId}/${scope}`, "X-Amz-Date": stamp, "X-Amz-Expires": String(ttl), "X-Amz-SignedHeaders": signedHeaders, ...Object.fromEntries(hoisted), ...(signing.sessionToken ? { "X-Amz-Security-Token": signing.sessionToken } : {}) };
  const url = requestUrl(endpoint, bucket, key, query); const canonicalHeaders = headerNames.map((name) => `${name}:${name === "host" ? endpoint.host : headers[name]}\n`).join(""); const canonical = `PUT\n${url.pathname}\n${url.search.slice(1)}\n${canonicalHeaders}\n${signedHeaders}\n${UNSIGNED_PAYLOAD}`; query["X-Amz-Signature"] = signatureFor(hex(canonical), stamp, scope, signing.secretAccessKey, date, region); return requestUrl(endpoint, bucket, key, query).toString();
}
function amzStamp(now: Date): string { return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function canonicalQuery(query: Readonly<Record<string, string>>): string { return Object.entries(query).sort(([left], [right]) => asciiCompare(left, right)).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&"); }
function signatureFor(canonicalHash: string, stamp: string, scope: string, secret: string, date: string, region: string): string { const key = hmac(hmac(hmac(hmac(Buffer.from(`AWS4${secret}`), date), region), "s3"), "aws4_request"); return createHmac("sha256", key).update(`AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${canonicalHash}`).digest("hex"); }
function hmac(key: Uint8Array, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
function hex(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function asciiCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
