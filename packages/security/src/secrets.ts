import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

import { requirePermission, type AuthorizationContext } from "./authorization.js";
import { SecurityError } from "./errors.js";

export interface SecretReference {
  readonly id: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly provider: string;
  readonly label: string;
  readonly createdAt: string;
}

export interface SecretStore {
  put(reference: SecretReference, plaintext: Uint8Array): Promise<void>;
  use<T>(reference: SecretReference, operation: (plaintext: Uint8Array) => Promise<T>): Promise<T>;
  delete(reference: SecretReference): Promise<void>;
}

interface EncryptedValue {
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

export class InMemoryEncryptedSecretStore implements SecretStore {
  readonly #key: Buffer;
  readonly #values = new Map<string, EncryptedValue>();

  public constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new SecurityError("SECRET_KEY_INVALID", "Secret store key must be 32 bytes");
    this.#key = Buffer.from(key);
  }

  public async put(reference: SecretReference, plaintext: Uint8Array): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(secretIdentity(reference)));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    this.#values.set(secretIdentity(reference), { iv, tag: cipher.getAuthTag(), ciphertext });
  }

  public async use<T>(reference: SecretReference, operation: (plaintext: Uint8Array) => Promise<T>): Promise<T> {
    const encrypted = this.#values.get(secretIdentity(reference));
    if (!encrypted) throw new SecurityError("SECRET_NOT_FOUND", "Secret reference does not exist");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, encrypted.iv);
    decipher.setAAD(Buffer.from(secretIdentity(reference)));
    decipher.setAuthTag(encrypted.tag);
    const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
    try {
      return await operation(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }

  public async delete(reference: SecretReference): Promise<void> {
    const encrypted = this.#values.get(secretIdentity(reference));
    if (encrypted) encrypted.ciphertext.fill(0);
    this.#values.delete(secretIdentity(reference));
  }
}

function secretIdentity(reference: SecretReference): string {
  return `${reference.tenantId}:${reference.siteId}:${reference.id}`;
}

export interface SecretLeaseRequest {
  readonly reference: SecretReference;
  readonly pluginId: string;
  readonly allowedPluginIds: readonly string[];
  readonly ttlSeconds?: number;
}

export interface SecretLeaseReceipt {
  readonly leaseId: string;
  readonly referenceId: string;
  readonly pluginId: string;
  readonly expiresAt: string;
}

export class SecretBroker {
  readonly #store: SecretStore;
  readonly #now: () => Date;

  public constructor(store: SecretStore, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  public async use<T>(
    context: AuthorizationContext,
    request: SecretLeaseRequest,
    operation: (plaintext: Uint8Array, receipt: SecretLeaseReceipt) => Promise<T>
  ): Promise<T> {
    requirePermission(context, "secrets:use", request.reference);
    if (!request.allowedPluginIds.includes(request.pluginId)) {
      throw new SecurityError("SECRET_PLUGIN_DENIED", "Plugin is not authorized to use this secret reference");
    }
    const ttlSeconds = request.ttlSeconds ?? 60;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) {
      throw new SecurityError("SECRET_LEASE_TTL_INVALID", "Secret lease TTL must be between 1 and 300 seconds");
    }
    const receipt = Object.freeze({
      leaseId: randomUUID(),
      referenceId: request.reference.id,
      pluginId: request.pluginId,
      expiresAt: new Date(this.#now().getTime() + ttlSeconds * 1000).toISOString()
    });
    return this.#store.use(request.reference, (plaintext) => operation(plaintext, receipt));
  }
}
