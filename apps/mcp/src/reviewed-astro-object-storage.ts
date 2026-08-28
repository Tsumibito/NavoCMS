import { createHash } from "node:crypto";

import { NAVOCMS_ARTIFACTS_NAMESPACE, S3NamespaceStorage, type S3Transport } from "@navocms/s3-core";

const MAX_INVENTORY = 100;

export interface ReviewedAstroStoredObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly mediaType: "application/vnd.navocms.astro-source-bundle+json" | "application/vnd.navocms.astro-output-bundle+json";
}

export interface ReviewedAstroObjectStorage {
  putImmutable(object: ReviewedAstroStoredObject): Promise<void>;
  head(key: string): Promise<Readonly<{ byteSize: number; sha256: string; mediaType: ReviewedAstroStoredObject["mediaType"] }> | undefined>;
  read(key: string, maxBytes: number): Promise<ReviewedAstroStoredObject | undefined>;
  /** Bounded, scoped evidence for recovery of immutable PUTs left before SQL commits. */
  inventory(prefix: string, limit: number, cursor?: string): Promise<Readonly<{ objects: readonly Readonly<{ key: string; byteSize: number; sha256: string; mediaType: ReviewedAstroStoredObject["mediaType"] }>[]; nextCursor?: string }>>;
}

export type ReviewedAstroObjectKind = "source" | "output";

export interface S3ReviewedAstroObjectStorageOptions {
  readonly bucket: string;
  readonly transport: S3Transport;
}

/**
 * R2/S3 adapter for reviewed Astro bundles. It keeps tenant/site keys logical
 * while the shared core owns all physical `navocms/v1/artifacts/` mapping.
 */
export class S3ReviewedAstroObjectStorage implements ReviewedAstroObjectStorage {
  readonly #storage: S3NamespaceStorage;

  public constructor(options: S3ReviewedAstroObjectStorageOptions) {
    this.#storage = new S3NamespaceStorage({ bucket: options.bucket, namespace: NAVOCMS_ARTIFACTS_NAMESPACE, transport: options.transport });
  }

  public async putImmutable(object: ReviewedAstroStoredObject): Promise<void> {
    assertStoredObject(object);
    await this.#storage.putImmutable(object);
  }

  public async head(key: string): Promise<Readonly<{ byteSize: number; sha256: string; mediaType: ReviewedAstroStoredObject["mediaType"] }> | undefined> {
    assertStorageKey(key);
    const metadata = await this.#storage.head(key);
    if (!metadata) return undefined;
    return Object.freeze({ byteSize: metadata.byteSize, sha256: metadata.sha256, mediaType: assertMediaType(metadata.mediaType) });
  }

  public async read(key: string, maxBytes: number): Promise<ReviewedAstroStoredObject | undefined> {
    assertStorageKey(key);
    const object = await this.#storage.read(key, maxBytes);
    if (!object) return undefined;
    return Object.freeze({ key: object.key, bytes: object.bytes, mediaType: assertMediaType(object.mediaType) });
  }

  public async inventory(prefix: string, limit: number, cursor?: string): Promise<Readonly<{ objects: readonly Readonly<{ key: string; byteSize: number; sha256: string; mediaType: ReviewedAstroStoredObject["mediaType"] }>[]; nextCursor?: string }>> {
    assertStoragePrefix(prefix);
    if (cursor !== undefined) {
      assertStorageKey(cursor);
      if (!cursor.startsWith(prefix) || cursor < prefix) throw new Error("REVIEWED_ASTRO_STORAGE_CURSOR_INVALID");
    }
    const page = await this.#storage.inventory(prefix, limit, cursor);
    const objects = page.objects.map((object) => Object.freeze({ key: assertStorageKey(object.key), byteSize: object.byteSize, sha256: object.sha256, mediaType: assertMediaType(object.mediaType) }));
    return Object.freeze({ objects: Object.freeze(objects), ...(page.nextCursor ? { nextCursor: assertStorageKey(page.nextCursor) } : {}) });
  }
}

export function reviewedAstroObjectKey(scope: Readonly<{ tenantId: string; siteId: string }>, kind: ReviewedAstroObjectKind, digest: string): string {
  assertDigest(digest);
  assertScope(scope);
  return `tenants/${scope.tenantId}/sites/${scope.siteId}/reviewed-astro/${kind}/sha256/${digest}.json`;
}

export function reviewedAstroObjectPrefix(scope: Readonly<{ tenantId: string; siteId: string }>): string {
  assertScope(scope);
  return `tenants/${scope.tenantId}/sites/${scope.siteId}/reviewed-astro/`;
}

export function assertReviewedAstroObjectKey(scope: Readonly<{ tenantId: string; siteId: string }>, kind: ReviewedAstroObjectKind, key: string, digest: string): void {
  if (key !== reviewedAstroObjectKey(scope, kind, digest)) throw new Error("REVIEWED_ASTRO_STORAGE_KEY_SCOPE_MISMATCH");
}

export function reviewedAstroObjectDigest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic test adapter; production composition must inject a real provider. */
export class LocalDeterministicReviewedAstroObjectStorage implements ReviewedAstroObjectStorage {
  readonly #objects = new Map<string, ReviewedAstroStoredObject>();

  public async putImmutable(object: ReviewedAstroStoredObject): Promise<void> {
    const existing = this.#objects.get(object.key);
    if (existing && (reviewedAstroObjectDigest(existing.bytes) !== reviewedAstroObjectDigest(object.bytes) || existing.mediaType !== object.mediaType)) throw new Error("REVIEWED_ASTRO_STORAGE_KEY_IMMUTABLE");
    if (!existing) this.#objects.set(object.key, Object.freeze({ ...object, bytes: new Uint8Array(object.bytes) }));
  }

  public async head(key: string) {
    const object = this.#objects.get(key);
    return object && Object.freeze({ byteSize: object.bytes.byteLength, sha256: reviewedAstroObjectDigest(object.bytes), mediaType: object.mediaType });
  }

  public async read(key: string, maxBytes: number) {
    const object = this.#objects.get(key);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("REVIEWED_ASTRO_STORAGE_READ_LIMIT_INVALID");
    if (object && object.bytes.byteLength > maxBytes) throw new Error("REVIEWED_ASTRO_STORAGE_READ_LIMIT_EXCEEDED");
    return object && Object.freeze({ ...object, bytes: new Uint8Array(object.bytes) });
  }

  public async inventory(prefix: string, limit: number, cursor?: string) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INVENTORY || !prefix.endsWith("/")) throw new Error("REVIEWED_ASTRO_STORAGE_INVENTORY_INVALID");
    const keys = [...this.#objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = cursor === undefined ? 0 : keys.findIndex((key) => key > cursor);
    const selected = keys.slice(start < 0 ? keys.length : start, (start < 0 ? keys.length : start) + limit + 1);
    const objects = Object.freeze(selected.slice(0, limit).map((key) => {
      const object = this.#objects.get(key)!;
      return Object.freeze({ key, byteSize: object.bytes.byteLength, sha256: reviewedAstroObjectDigest(object.bytes), mediaType: object.mediaType });
    }));
    return Object.freeze({ objects, ...(selected.length > limit ? { nextCursor: objects.at(-1)!.key } : {}) });
  }
}

function assertScope(scope: Readonly<{ tenantId: string; siteId: string }>): void { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.tenantId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.siteId)) throw new Error("REVIEWED_ASTRO_STORAGE_SCOPE_INVALID"); }
function assertDigest(value: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("REVIEWED_ASTRO_STORAGE_DIGEST_INVALID"); }
function assertStoredObject(object: ReviewedAstroStoredObject): void { assertStorageKey(object.key); assertMediaType(object.mediaType); }
function assertStorageKey(key: string): string {
  if (typeof key !== "string") throw new Error("REVIEWED_ASTRO_STORAGE_KEY_SCOPE_MISMATCH");
  const match = /^tenants\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/sites\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/reviewed-astro\/(source|output)\/sha256\/([a-f0-9]{64})\.json$/.exec(key);
  if (!match) throw new Error("REVIEWED_ASTRO_STORAGE_KEY_SCOPE_MISMATCH");
  assertScope({ tenantId: match[1]!, siteId: match[2]! }); assertDigest(match[4]!); return key;
}
function assertStoragePrefix(prefix: string): void {
  if (typeof prefix !== "string") throw new Error("REVIEWED_ASTRO_STORAGE_PREFIX_SCOPE_MISMATCH");
  const match = /^tenants\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/sites\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/reviewed-astro\/$/.exec(prefix);
  if (!match) throw new Error("REVIEWED_ASTRO_STORAGE_PREFIX_SCOPE_MISMATCH");
  assertScope({ tenantId: match[1]!, siteId: match[2]! });
}
function assertMediaType(value: string): ReviewedAstroStoredObject["mediaType"] {
  if (value === "application/vnd.navocms.astro-source-bundle+json" || value === "application/vnd.navocms.astro-output-bundle+json") return value;
  throw new Error("REVIEWED_ASTRO_STORAGE_METADATA_INVALID");
}
