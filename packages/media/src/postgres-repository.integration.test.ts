import { createHash, randomUUID } from "node:crypto";

import { PostgresDatabase, PostgresEventStore, PostgresIdempotencyStore } from "@navocms/persistence-postgres";
import { afterAll, describe, expect, it } from "vitest";

import type { FinalizeUploadInput, MediaScope, UploadIntentResult } from "./domain.js";
import { PostgresMediaRepository } from "./postgres-repository.js";
import { LocalDeterministicMediaStorage, type MediaStorage } from "./storage.js";

const databaseUrl = process.env.NAVOCMS_INTEGRATION_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const scope: MediaScope = {
  tenantId: "a2af348f-58b8-4efe-b873-8bd032ecbc5c",
  siteId: "2e0bcd4f-6780-470c-844b-d72abb6737ca",
  principalId: "016ef382-bf28-406b-9321-1fc580b6ea00",
  principalKind: "human"
};
const database = databaseUrl ? new PostgresDatabase({ connectionString: databaseUrl, applicationName: "navocms-media-integration", maxConnections: 4 }) : undefined;

afterAll(async () => database?.close());

integration("atomic media repository", () => {
  it("persists a single intent-to-original trajectory and replays its result", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-happy-${randomUUID()}`;
    const intent = uploadIntent(await repository.createUploadIntent(scope, createInput(key)));
    const finalized = await finalize(repository, storage, intent, key);
    const replayed = await finalize(repository, storage, intent, key);
    expect(finalized).toMatchObject({ id: intent.asset.id, state: "verified" });
    expect(replayed).toEqual(finalized);
    await expect(repository.finalizeUpload(scope, { ...finalizeInput(intent, key), uploadedStorageKey: "wrong" })).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    expect(await repository.getAsset(scope, intent.asset.id)).toEqual(finalized);
    expect(await repository.listAssets(scope, 1)).toHaveLength(1);
    await expect(repository.listAssets(scope, 0)).rejects.toThrow("LIMIT");
    const counts = await countsFor(intent.asset.id, [key, `${key}-finalize`]);
    expect(counts).toMatchObject({ assets: "1", originals: "1", finalized: "1", idempotency: "2", ledger: "3", outbox: "3" });
  });

  it("rejects idempotency drift, expired intents, invalid finalized input, and a foreign site", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-drift-${randomUUID()}`;
    const intent = uploadIntent(await repository.createUploadIntent(scope, createInput(key)));
    await expect(repository.createUploadIntent(scope, { ...createInput(key), expectedSha256: digest("changed") })).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    const sizeIntent = uploadIntent(await repository.createUploadIntent(scope, createInput(`${key}-size`)));
    await storage.putImmutable({ key: sizeIntent.storageKey, bytes: mediaBytes(`${key}-different-size`), mediaType: "image/png" });
    await expect(repository.finalizeUpload(scope, finalizeInput(sizeIntent, `${key}-size`))).rejects.toThrow("SIZE");
    const mimeIntent = uploadIntent(await repository.createUploadIntent(scope, createInput(`${key}-mime`, "image/jpeg")));
    await putUpload(storage, mimeIntent.storageKey, `${key}-mime`);
    await expect(repository.finalizeUpload(scope, finalizeInput(mimeIntent, `${key}-mime`))).rejects.toThrow("MEDIA_STORAGE_MIME_MISMATCH");
    const checksumIntent = uploadIntent(await repository.createUploadIntent(scope, createInput(`${key}-checksum`)));
    const checksumBytes = mediaBytes(`${key}-checksum`); const lastByte = checksumBytes.length - 1;
    checksumBytes[lastByte] = (checksumBytes[lastByte] ?? 0) ^ 1;
    await storage.putImmutable({ key: checksumIntent.storageKey, bytes: checksumBytes, mediaType: "image/png" });
    await expect(repository.finalizeUpload(scope, finalizeInput(checksumIntent, `${key}-checksum`))).rejects.toThrow("CHECKSUM");
    const pixelBomb = mediaBytes(`${key}-dimensions`, 99_999);
    const dimensionIntent = uploadIntent(await repository.createUploadIntent(scope, createInput(`${key}-dimensions`, "image/png", pixelBomb)));
    await storage.putImmutable({ key: dimensionIntent.storageKey, bytes: pixelBomb, mediaType: "image/png" });
    await expect(repository.finalizeUpload(scope, finalizeInput(dimensionIntent, `${key}-dimensions`))).rejects.toMatchObject({
      code: "MEDIA_DECODE_LIMIT"
    });
    await expect(repository.finalizeUpload({ ...scope, siteId: "22222222-2222-4222-8222-222222222222" }, finalizeInput(intent, key))).rejects.toThrow("NOT_FOUND");
    await database!.withScope(scope, (client) => client.query("UPDATE navocms.media_upload_intents SET expires_at = now() - interval '1 second' WHERE id = $1", [intent.intentId]));
    await expect(repository.finalizeUpload(scope, finalizeInput(intent, `${key}-expired`))).rejects.toThrow("EXPIRED");
    expect(await countsFor(intent.asset.id, [key])).toMatchObject({ assets: "1", originals: "0", finalized: "0", idempotency: "1" });
  });

  it("serializes concurrent finalize and rolls every record back after an event/outbox failure", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-concurrent-${randomUUID()}`;
    const intent = uploadIntent(await repository.createUploadIntent(scope, createInput(key)));
    await putUpload(storage, intent.storageKey, key);
    const input = finalizeInput(intent, key);
    const completed = await Promise.all([repository.finalizeUpload(scope, input), repository.finalizeUpload(scope, input)]);
    expect(completed[0]).toEqual(completed[1]);
    expect(await countsFor(intent.asset.id, [key, `${key}-finalize`])).toMatchObject({ originals: "1" });

    const failingEvents = {
      append: async (event: Parameters<PostgresEventStore["append"]>[0]) => {
        await new PostgresEventStore(database!).append(event);
        throw new Error("injected event/outbox failure");
      },
      query: (query: Parameters<PostgresEventStore["query"]>[0]) => new PostgresEventStore(database!).query(query)
    };
    const failing = new PostgresMediaRepository(database!, storage, new PostgresIdempotencyStore(database!), failingEvents);
    const failedKey = `media-rollback-${randomUUID()}`;
    const failedIntent = uploadIntent(await repository.createUploadIntent(scope, createInput(failedKey)));
    await putUpload(storage, failedIntent.storageKey, failedKey);
    await expect(failing.finalizeUpload(scope, finalizeInput(failedIntent, failedKey))).rejects.toThrow("injected event/outbox failure");
    const result = await database!.withScope(scope, async (client) => (
      await client.query<{ state: string; originals: string; finalized: string; idempotency: string; ledger: string; outbox: string }>(
        `SELECT
          (SELECT state FROM navocms.media_assets WHERE id = $1) AS state,
          (SELECT count(*) FROM navocms.media_originals WHERE asset_id = $1) AS originals,
          (SELECT count(*) FROM navocms.media_upload_intents WHERE id = $2 AND finalized_at IS NOT NULL) AS finalized,
          (SELECT count(*) FROM navocms.idempotency_records WHERE operation = 'media_upload_finalize' AND idempotency_key = $3) AS idempotency,
          (SELECT count(*) FROM navocms.event_ledger WHERE correlation_id = $1 AND event_type = 'io.navocms.media.original.verified.v1') AS ledger,
          (SELECT count(*) FROM navocms.domain_outbox WHERE correlation_id = $1 AND event_type = 'io.navocms.media.original.verified.v1') AS outbox`,
        [failedIntent.asset.id, failedIntent.intentId, `${failedKey}-finalize`]
      )).rows[0]!
    );
    expect(result).toEqual({ state: "pending", originals: "0", finalized: "0", idempotency: "0", ledger: "0", outbox: "0" });
  });

  it("writes reference and rejection events with the asset correlation id", async () => {
    const repository = new PostgresMediaRepository(database!, new LocalDeterministicMediaStorage());
    const key = `media-reference-${randomUUID()}`;
    const intent = uploadIntent(await repository.createUploadIntent(scope, createInput(key)));
    const reference = await repository.createReference(scope, {
      assetId: intent.asset.id, ownerType: "content.entry", ownerId: randomUUID(), purpose: "hero", idempotencyKey: `${key}-reference`
    });
    await repository.removeReference(scope, reference.id, `${key}-remove`);
    const rejected = await repository.rejectAsset(scope, { assetId: intent.asset.id, reason: "policy denied", idempotencyKey: `${key}-reject` });
    expect(rejected).toMatchObject({ id: intent.asset.id, state: "rejected", rejectionReason: "policy denied" });
    const events = await new PostgresEventStore(database!).query({ ...scope, correlationId: intent.asset.id });
    expect(events.map(({ event }) => event.type)).toEqual(expect.arrayContaining([
      "io.navocms.media.reference.created.v1", "io.navocms.media.reference.removed.v1", "io.navocms.media.asset.rejected.v1"
    ]));
  });

  it("deduplicates a verified site-local SHA without creating another asset or intent", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-dedup-${randomUUID()}`;
    const first = uploadIntent(await repository.createUploadIntent(scope, createInput(key)));
    await finalize(repository, storage, first, key);
    const duplicate = await repository.createUploadIntent(scope, createInput(`${key}-retry`, "image/png", mediaBytes(key)));
    expect(duplicate).toMatchObject({ kind: "deduplicated", asset: { id: first.asset.id, state: "verified" } });
    const counts = await countsFor(first.asset.id, [key, `${key}-finalize`, `${key}-retry`]);
    expect(counts).toMatchObject({ assets: "1", originals: "1", finalized: "1", idempotency: "3" });
  });

  it("resolves two pre-existing intents for the same SHA without a raw unique conflict", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-dedup-race-${randomUUID()}`;
    const first = uploadIntent(await repository.createUploadIntent(scope, createInput(key)));
    const second = uploadIntent(await repository.createUploadIntent(scope, createInput(`${key}-second`, "image/png", mediaBytes(key))));
    await putUpload(storage, first.storageKey, key);
    await putUpload(storage, second.storageKey, key);
    const finalized = await Promise.all([
      repository.finalizeUpload(scope, finalizeInput(first, key)),
      repository.finalizeUpload(scope, finalizeInput(second, `${key}-second`))
    ]);
    expect(finalized.map(({ state }) => state).sort()).toEqual(["rejected", "verified"]);
    expect(finalized.find(({ state }) => state === "rejected")).toMatchObject({ rejectionReason: "duplicate_sha256" });
    const trajectories = [
      { intent: first, result: finalized[0]!, keys: [key, `${key}-finalize`] },
      { intent: second, result: finalized[1]!, keys: [`${key}-second`, `${key}-second-finalize`] }
    ];
    const verified = trajectories.find(({ result }) => result.state === "verified")!;
    const rejected = trajectories.find(({ result }) => result.state === "rejected")!;
    expect(await countsFor(verified.intent.asset.id, verified.keys)).toMatchObject({ originals: "1", finalized: "1" });
    expect(await countsFor(rejected.intent.asset.id, rejected.keys)).toMatchObject({ originals: "0", finalized: "1" });
  });

  it("serializes finalize against reject and rejects a second finalize key", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-finalize-reject-${randomUUID()}`;
    const intent = uploadIntent(await repository.createUploadIntent(scope, createInput(key)));
    await putUpload(storage, intent.storageKey, key);
    const outcomes = await Promise.allSettled([
      repository.finalizeUpload(scope, finalizeInput(intent, key)),
      repository.rejectAsset(scope, { assetId: intent.asset.id, reason: "race rejection", idempotencyKey: `${key}-reject` })
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const asset = await repository.getAsset(scope, intent.asset.id);
    expect(asset?.state).toMatch(/^(verified|rejected)$/);
  });

  it("permits exactly one concurrent finalize key for an intent", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-finalize-keys-${randomUUID()}`;
    const intent = uploadIntent(await repository.createUploadIntent(scope, createInput(key)));
    await putUpload(storage, intent.storageKey, key);
    const outcomes = await Promise.allSettled([
      repository.finalizeUpload(scope, finalizeInput(intent, key)),
      repository.finalizeUpload(scope, finalizeInput(intent, `${key}-alternate`))
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const errors = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(String(errors[0]?.reason)).toMatch(/ALREADY_FINALIZED/);
    expect(await countsFor(intent.asset.id, [key, `${key}-finalize`, `${key}-alternate-finalize`])).toMatchObject({ originals: "1", finalized: "1" });
  });

  it("rejects storage key and storage MIME mismatches before SQL mutation", async () => {
    const keyStorage = new LocalDeterministicMediaStorage();
    const keyRepository = new PostgresMediaRepository(database!, mismatchingKeyStorage(keyStorage));
    const key = `media-storage-key-${randomUUID()}`;
    const keyIntent = uploadIntent(await keyRepository.createUploadIntent(scope, createInput(key)));
    await putUpload(keyStorage, keyIntent.storageKey, key);
    await expect(keyRepository.finalizeUpload(scope, finalizeInput(keyIntent, key))).rejects.toThrow("STORAGE_KEY_MISMATCH");

    const mimeStorage = new LocalDeterministicMediaStorage();
    const mimeRepository = new PostgresMediaRepository(database!, mimeStorage);
    const mimeKey = `media-storage-mime-${randomUUID()}`;
    const mimeIntent = uploadIntent(await mimeRepository.createUploadIntent(scope, createInput(mimeKey)));
    await mimeStorage.putImmutable({ key: mimeIntent.storageKey, bytes: mediaBytes(mimeKey), mediaType: "image/jpeg" });
    await expect(mimeRepository.finalizeUpload(scope, finalizeInput(mimeIntent, mimeKey))).rejects.toThrow("STORAGE_MIME_MISMATCH");
  });

  it("rejects unbounded metadata, excessive TTL, and oversized idempotency keys", async () => {
    const repository = new PostgresMediaRepository(database!, new LocalDeterministicMediaStorage());
    const key = `media-boundary-${randomUUID()}`;
    await expect(repository.createUploadIntent(scope, { ...createInput(key), idempotencyKey: "x".repeat(129) })).rejects.toThrow("IDEMPOTENCY_KEY_INVALID");
    await expect(repository.createUploadIntent(scope, { ...createInput(`${key}-ttl`), expiresAt: new Date(Date.now() + 16 * 60_000).toISOString() })).rejects.toThrow("INTENT_INVALID");
    await expect(repository.createUploadIntent(scope, { ...createInput(`${key}-provenance`), provenance: { kind: "upload", receivedAt: new Date().toISOString(), receivedBy: scope.principalId, unbounded: "x" } })).rejects.toThrow("PROVENANCE_INVALID");
    await expect(repository.createUploadIntent(scope, { ...createInput(`${key}-rights`), rights: { license: "x".repeat(201), restricted: false } })).rejects.toThrow("RIGHTS_INVALID");
  });

  it("bounds storage reads using HEAD and rejects a lying provider body", async () => {
    const key = `media-bounded-read-${randomUUID()}`;
    const input = createInput(key);
    let readCalled = false;
    const oversizedHead: MediaStorage = fakeStorage({
      head: async () => ({ byteSize: input.expectedSize + 1, sha256: input.expectedSha256, mediaType: "image/png" }),
      read: async () => { readCalled = true; return undefined; }
    });
    const repository = new PostgresMediaRepository(database!, oversizedHead);
    const intent = uploadIntent(await repository.createUploadIntent(scope, input));
    await expect(repository.finalizeUpload(scope, finalizeInput(intent, key))).rejects.toThrow("STORAGE_SIZE_MISMATCH");
    expect(readCalled).toBe(false);

    let requestedLimit: number | undefined;
    const lyingHead: MediaStorage = fakeStorage({
      head: async () => ({ byteSize: input.expectedSize, sha256: input.expectedSha256, mediaType: "image/png" }),
      read: async (storageKey, maxBytes) => {
        requestedLimit = maxBytes;
        return { key: storageKey, bytes: new Uint8Array(input.expectedSize + 1), mediaType: "image/png" };
      }
    });
    const lyingRepository = new PostgresMediaRepository(database!, lyingHead);
    const lyingIntent = uploadIntent(await lyingRepository.createUploadIntent(scope, { ...input, idempotencyKey: `${key}-lying` }));
    await expect(lyingRepository.finalizeUpload(scope, finalizeInput(lyingIntent, `${key}-lying`))).rejects.toThrow("STORAGE_SIZE_MISMATCH");
    expect(requestedLimit).toBe(input.expectedSize);
  });

  it("enforces 16..128 idempotency keys before records are created", async () => {
    const repository = new PostgresMediaRepository(database!, new LocalDeterministicMediaStorage());
    const shortKey = "x".repeat(15);
    await expect(repository.createUploadIntent(scope, { ...createInput(`media-short-${randomUUID()}`), idempotencyKey: shortKey })).rejects.toThrow("IDEMPOTENCY_KEY_INVALID");
    const shortRecords = await database!.withScope(scope, async (client) => (
      await client.query<{ count: string }>("SELECT count(*) FROM navocms.idempotency_records WHERE idempotency_key = $1", [shortKey])
    ).rows[0]!.count);
    expect(shortRecords).toBe("0");
    const accepted = await repository.createUploadIntent(scope, { ...createInput(`media-minimum-${randomUUID()}`), idempotencyKey: "a".repeat(16) });
    expect(accepted.kind).toBe("upload-intent");
  });

  it("separates event idempotency identities for finalize and reject using one client key", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-event-idempotency-${randomUUID()}`;
    const primary = uploadIntent(await repository.createUploadIntent(scope, createInput(key)));
    const duplicate = uploadIntent(await repository.createUploadIntent(scope, createInput(`${key}-duplicate`, "image/png", mediaBytes(key))));
    await putUpload(storage, primary.storageKey, key);
    await putUpload(storage, duplicate.storageKey, key);
    await repository.finalizeUpload(scope, finalizeInput(primary, key));
    const clientKey = `shared-client-key-${randomUUID()}`;
    await expect(repository.finalizeUpload(scope, { ...finalizeInput(duplicate, `${key}-duplicate`), idempotencyKey: clientKey })).resolves.toMatchObject({ state: "rejected" });
    const rejectTarget = uploadIntent(await repository.createUploadIntent(scope, createInput(`${key}-reject-target`)));
    await expect(repository.rejectAsset(scope, { assetId: rejectTarget.asset.id, reason: "manual rejection", idempotencyKey: clientKey })).resolves.toMatchObject({ state: "rejected" });
    const ids = [`media_upload_finalize:${clientKey}`, `media_asset_reject:${clientKey}`];
    const stored = await database!.withScope(scope, async (client) => (
      await client.query<{ ledger: string; outbox: string }>(
        `SELECT
          (SELECT count(*) FROM navocms.event_ledger WHERE event_json->>'navoidempotencykey' = ANY($1::text[])) AS ledger,
          (SELECT count(*) FROM navocms.domain_outbox WHERE payload_json->>'navoidempotencykey' = ANY($1::text[])) AS outbox`,
        [ids]
      )).rows[0]!);
    expect(stored).toEqual({ ledger: "2", outbox: "2" });
  });

  it("fails closed when an existing SHA disagrees with declared size or MIME", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-dedup-metadata-${randomUUID()}`;
    const intent = uploadIntent(await repository.createUploadIntent(scope, createInput(key)));
    await finalize(repository, storage, intent, key);
    const before = await mediaRowCounts();
    const sizeKey = `media-dedup-size-${randomUUID()}`;
    const mimeKey = `media-dedup-mime-${randomUUID()}`;
    await expect(repository.createUploadIntent(scope, { ...createInput(sizeKey, "image/png", mediaBytes(key)), expectedSize: mediaBytes(key).byteLength + 1 })).rejects.toThrow("DEDUP_METADATA_MISMATCH");
    await expect(repository.createUploadIntent(scope, { ...createInput(mimeKey, "image/jpeg", mediaBytes(key)) })).rejects.toThrow("DEDUP_METADATA_MISMATCH");
    expect(await mediaRowCounts()).toEqual(before);
    const idempotency = await database!.withScope(scope, async (client) => (
      await client.query<{ count: string }>("SELECT count(*) FROM navocms.idempotency_records WHERE idempotency_key = ANY($1::text[])", [[sizeKey, mimeKey]])
    ).rows[0]!.count);
    expect(idempotency).toBe("0");
  });
});

function createInput(key: string, expectedMediaType: "image/jpeg" | "image/png" = "image/png", bytes = mediaBytes(key)) {
  return {
    idempotencyKey: key, expectedSha256: digest(bytes), expectedSize: bytes.byteLength, expectedMediaType,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    provenance: { kind: "upload", receivedAt: new Date().toISOString(), receivedBy: scope.principalId },
    rights: { license: "test", restricted: false }
  };
}

function finalizeInput(intent: { readonly intentId: string; readonly storageKey: string }, key: string): FinalizeUploadInput {
  return { intentId: intent.intentId, idempotencyKey: `${key}-finalize`, uploadedStorageKey: intent.storageKey,
  };
}

async function finalize(repository: PostgresMediaRepository, storage: LocalDeterministicMediaStorage, intent: { readonly intentId: string; readonly storageKey: string }, key: string) {
  await putUpload(storage, intent.storageKey, key);
  return repository.finalizeUpload(scope, finalizeInput(intent, key));
}

async function putUpload(storage: LocalDeterministicMediaStorage, key: string, value: string): Promise<void> {
  await storage.putImmutable({ key, bytes: mediaBytes(value), mediaType: "image/png" });
}

function mediaBytes(value: string, width = 2): Uint8Array {
  const bytes = new Uint8Array(24 + Buffer.byteLength(value));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  bytes[16] = (width >>> 24) & 0xff; bytes[17] = (width >>> 16) & 0xff; bytes[18] = (width >>> 8) & 0xff; bytes[19] = width & 0xff;
  bytes[20] = 0; bytes[21] = 0; bytes[22] = 0; bytes[23] = 2;
  bytes.set(Buffer.from(value), 24);
  return bytes;
}

async function countsFor(assetId: string, idempotencyKeys: readonly string[]) {
  return database!.withScope(scope, async (client) => {
    const result = await client.query<{ assets: string; originals: string; finalized: string; idempotency: string; ledger: string; outbox: string }>(
      `SELECT
        (SELECT count(*) FROM navocms.media_assets WHERE id = $1) AS assets,
        (SELECT count(*) FROM navocms.media_originals WHERE asset_id = $1) AS originals,
        (SELECT count(*) FROM navocms.media_upload_intents WHERE asset_id = $1 AND finalized_at IS NOT NULL) AS finalized,
        (SELECT count(*) FROM navocms.idempotency_records WHERE idempotency_key = ANY($2::text[])) AS idempotency,
        (SELECT count(*) FROM navocms.event_ledger WHERE correlation_id = $1) AS ledger,
        (SELECT count(*) FROM navocms.domain_outbox WHERE correlation_id = $1) AS outbox`, [assetId, idempotencyKeys]
    );
    return result.rows[0]!;
  });
}

async function mediaRowCounts() {
  return database!.withScope(scope, async (client) => (
    await client.query<{ assets: string; intents: string; originals: string; ledger: string; outbox: string }>(
      `SELECT
        (SELECT count(*) FROM navocms.media_assets) AS assets,
        (SELECT count(*) FROM navocms.media_upload_intents) AS intents,
        (SELECT count(*) FROM navocms.media_originals) AS originals,
        (SELECT count(*) FROM navocms.event_ledger) AS ledger,
        (SELECT count(*) FROM navocms.domain_outbox) AS outbox`
    )).rows[0]!
  );
}

function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

function uploadIntent(result: Awaited<ReturnType<PostgresMediaRepository["createUploadIntent"]>>): UploadIntentResult {
  if (result.kind !== "upload-intent") throw new Error("Expected a new upload intent");
  return result;
}

function mismatchingKeyStorage(storage: LocalDeterministicMediaStorage): MediaStorage {
  return {
    putImmutable: storage.putImmutable.bind(storage), head: storage.head.bind(storage),
    read: async (key, maxBytes) => {
      const object = await storage.read(key, maxBytes);
      return object && { ...object, key: `${key}-mismatch` };
    },
    deleteRecoverable: storage.deleteRecoverable.bind(storage), restore: storage.restore.bind(storage), reclaim: storage.reclaim.bind(storage)
  };
}

function fakeStorage(overrides: Pick<MediaStorage, "head" | "read">): MediaStorage {
  return {
    putImmutable: async () => undefined,
    head: overrides.head,
    read: overrides.read,
    deleteRecoverable: async () => undefined,
    restore: async () => false,
    reclaim: async () => []
  };
}
