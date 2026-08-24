import { createHash } from "node:crypto";
import type { MediaScope } from "./domain.js";

export interface StorageObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface MediaStorage {
  putImmutable(object: StorageObject): Promise<void>;
  head(key: string): Promise<Readonly<{ byteSize: number; sha256: string; mediaType: string }> | undefined>;
  /** Implementations must abort rather than buffer past maxBytes. */
  read(key: string, maxBytes: number): Promise<StorageObject | undefined>;
  deleteRecoverable(key: string, recoverableUntil: Date): Promise<void>;
  restore(key: string): Promise<boolean>;
  /** Reclaims one already recoverably-deleted object, never a provider-wide set. */
  reclaim(key: string, now: Date): Promise<boolean>;
  /** Returns only live objects below prefix and never more than limit. */
  inventory(prefix: string, limit: number, cursor?: string): Promise<Readonly<{ objects: readonly Readonly<{ key: string; byteSize: number; sha256: string; mediaType: string }>[]; nextCursor?: string }>>;
}

export function originalKey(scope: Pick<MediaScope, "tenantId" | "siteId">, sha256: string): string {
  assertSha256(sha256);
  return `tenants/${scope.tenantId}/sites/${scope.siteId}/originals/${sha256}`;
}

export function originalPrefix(scope: Pick<MediaScope, "tenantId" | "siteId">): string {
  return `tenants/${scope.tenantId}/sites/${scope.siteId}/originals/`;
}

export function assertOriginalKey(scope: Pick<MediaScope, "tenantId" | "siteId">, key: string, digest: string): void {
  if (key !== originalKey(scope, digest)) throw new Error("STORAGE_KEY_SCOPE_MISMATCH");
}

export function variantIdentity(originalSha256: string, presetVersion: string, transform: Readonly<Record<string, unknown>>): string {
  assertSha256(originalSha256);
  if (!presetVersion) throw new Error("VARIANT_PRESET_INVALID");
  assertJsonValue(transform);
  return sha256(`${originalSha256}\n${presetVersion}\n${canonicalJson(transform)}`);
}

export function variantKey(scope: Pick<MediaScope, "tenantId" | "siteId">, identity: string): string {
  assertSha256(identity);
  return `tenants/${scope.tenantId}/sites/${scope.siteId}/variants/${identity}`;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class LocalDeterministicMediaStorage implements MediaStorage {
  readonly #objects = new Map<string, StorageObject>();
  readonly #deleted = new Map<string, { object: StorageObject; recoverableUntil: Date }>();

  public async putImmutable(object: StorageObject): Promise<void> {
    const existing = this.#objects.get(object.key);
    if (existing && (sha256(existing.bytes) !== sha256(object.bytes) || existing.mediaType !== object.mediaType)) {
      throw new Error("STORAGE_KEY_IMMUTABLE");
    }
    if (!existing) this.#objects.set(object.key, Object.freeze({ ...object, bytes: new Uint8Array(object.bytes) }));
  }

  public async head(key: string) {
    const object = this.#objects.get(key);
    return object && Object.freeze({ byteSize: object.bytes.byteLength, sha256: sha256(object.bytes), mediaType: object.mediaType });
  }

  public async read(key: string, maxBytes: number): Promise<StorageObject | undefined> {
    const object = this.#objects.get(key);
    if (object && object.bytes.byteLength > maxBytes) throw new Error("STORAGE_READ_LIMIT_EXCEEDED");
    return object && Object.freeze({ ...object, bytes: new Uint8Array(object.bytes) });
  }

  public async deleteRecoverable(key: string, recoverableUntil: Date): Promise<void> {
    const object = this.#objects.get(key);
    if (!object) return;
    this.#objects.delete(key);
    this.#deleted.set(key, { object, recoverableUntil: new Date(recoverableUntil) });
  }

  public async restore(key: string): Promise<boolean> {
    const deleted = this.#deleted.get(key);
    if (!deleted || deleted.recoverableUntil.getTime() <= Date.now()) return false;
    this.#deleted.delete(key);
    this.#objects.set(key, deleted.object);
    return true;
  }

  public async reclaim(key: string, now: Date): Promise<boolean> {
    const deleted = this.#deleted.get(key);
    if (!deleted) return false;
    if (deleted.recoverableUntil > now) throw new Error("STORAGE_RECLAIM_GRACE_NOT_ELAPSED");
    this.#deleted.delete(key);
    return true;
  }

  public async inventory(prefix: string, limit: number, cursor?: string) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("STORAGE_INVENTORY_LIMIT_INVALID");
    const keys = [...this.#objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    // The cursor is an exclusive lexical key. It need not exist in storage:
    // reconciliation shares the same key-space with DB originals that may be
    // missing from the provider.
    const afterCursor = cursor === undefined ? 0 : keys.findIndex((key) => key > cursor);
    const start = afterCursor < 0 ? keys.length : afterCursor;
    const selected = keys.slice(start, start + limit + 1);
    const objects = selected.slice(0, limit).map((key) => {
      const object = this.#objects.get(key)!;
      return Object.freeze({ key, byteSize: object.bytes.byteLength, sha256: sha256(object.bytes), mediaType: object.mediaType });
    });
    return Object.freeze({ objects: Object.freeze(objects), ...(selected.length > limit ? { nextCursor: objects.at(-1)!.key } : {}) });
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("SHA256_INVALID");
}

function assertJsonValue(value: unknown): asserts value is null | boolean | number | string | readonly unknown[] | Readonly<Record<string, unknown>> {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error("TRANSFORM_NOT_JSON");
  }
  if (Array.isArray(value)) { for (const nested of value) assertJsonValue(nested); return; }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("TRANSFORM_NOT_JSON");
    for (const nested of Object.values(value as Record<string, unknown>)) assertJsonValue(nested);
    return;
  }
  throw new Error("TRANSFORM_NOT_JSON");
}
