import { NAVOCMS_MEDIA_NAMESPACE, S3NamespaceStorage, type S3Transport } from "@navocms/s3-core";
import type { MediaScope } from "./domain.js";
import { sha256, type MediaStorage, type StorageObject } from "./storage.js";
/** @deprecated Import transport contracts from `@navocms/s3-core`. */
export type { S3Transport, S3TransportResponse } from "@navocms/s3-core";

export interface S3StorageOptions extends Pick<MediaScope, "tenantId" | "siteId"> {
  readonly bucket: string;
  readonly transport: S3Transport;
  readonly clock?: () => Date;
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

  public constructor(options: S3StorageOptions) {
    this.#scope = { tenantId: options.tenantId, siteId: options.siteId };
    this.#store = new S3NamespaceStorage({ bucket: options.bucket, namespace: NAVOCMS_MEDIA_NAMESPACE, transport: options.transport });
    this.#clock = options.clock ?? (() => new Date());
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

function metadataHeaders(mediaType: string, digest: string): Record<string, string> { return { "x-amz-meta-sha256": digest, "x-amz-meta-media-type": mediaType }; }
function recoveryKey(key: string): string { const [prefix] = key.split("/originals/"); return `${prefix}/__recoverable/${Buffer.from(key).toString("base64url")}`; }
function isFiniteDate(value: Date): boolean { return Number.isFinite(value.getTime()); }
