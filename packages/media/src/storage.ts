import { createHash } from "node:crypto";

export interface StorageObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface MediaStorage {
  putImmutable(object: StorageObject): Promise<void>;
  head(key: string): Promise<Readonly<{ byteSize: number; sha256: string; mediaType: string }> | undefined>;
  read(key: string): Promise<StorageObject | undefined>;
  deleteRecoverable(key: string, recoverableUntil: Date): Promise<void>;
  restore(key: string): Promise<boolean>;
  reclaim(now: Date): Promise<readonly string[]>;
}

export interface MediaScope { readonly tenantId: string; readonly siteId: string; }

export function originalKey(scope: MediaScope, sha256: string): string {
  assertSha256(sha256);
  return `tenants/${scope.tenantId}/sites/${scope.siteId}/originals/${sha256}`;
}

export function assertOriginalKey(scope: MediaScope, key: string, digest: string): void {
  if (key !== originalKey(scope, digest)) throw new Error("STORAGE_KEY_SCOPE_MISMATCH");
}

export function variantIdentity(originalSha256: string, presetVersion: string, transform: Readonly<Record<string, unknown>>): string {
  assertSha256(originalSha256);
  if (!presetVersion) throw new Error("VARIANT_PRESET_INVALID");
  assertJsonValue(transform);
  return sha256(`${originalSha256}\n${presetVersion}\n${canonicalJson(transform)}`);
}

export function variantKey(scope: MediaScope, identity: string): string {
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

  public async read(key: string): Promise<StorageObject | undefined> {
    const object = this.#objects.get(key);
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

  public async reclaim(now: Date): Promise<readonly string[]> {
    const reclaimed: string[] = [];
    for (const [key, deleted] of this.#deleted) {
      if (deleted.recoverableUntil <= now) { this.#deleted.delete(key); reclaimed.push(key); }
    }
    return Object.freeze(reclaimed.sort());
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
