import { createHash } from "node:crypto";

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
