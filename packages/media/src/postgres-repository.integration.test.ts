import { createHash, randomUUID } from "node:crypto";

import type { EventStore } from "@navocms/kernel";
import { PostgresDatabase, PostgresEventStore, PostgresIdempotencyStore } from "@navocms/persistence-postgres";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import type { FinalizeUploadInput, GenerateMediaVariantInput, MediaScope, MediaVariantSummary, UploadIntentResult } from "./domain.js";
import { PostgresMediaRepository } from "./postgres-repository.js";
import { PostgresMediaUploadIntentSigner, S3CompatibleMediaStorage, type S3Transport } from "./s3-storage.js";
import { LocalDeterministicMediaStorage, originalKey, type MediaStorage } from "./storage.js";

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
    const firstPage = await repository.listAssets(scope, 1);
    expect(firstPage.assets).toHaveLength(1);
    const secondIntent = uploadIntent(await repository.createUploadIntent(scope, createInput(`${key}-page-two`)));
    const pageWithCursor = await repository.listAssets(scope, 1);
    expect(pageWithCursor.nextCursor).toBeDefined();
    const secondPage = await repository.listAssets(scope, 1, pageWithCursor.nextCursor);
    expect(secondPage.assets[0]?.id).not.toBe(pageWithCursor.assets[0]?.id);
    expect(secondIntent.asset.id).toBeTruthy();
    await expect(repository.listAssets(scope, 0)).rejects.toThrow("LIMIT");
    await expect(repository.listAssets(scope, 1, "invalid")).rejects.toThrow("CURSOR");
    const counts = await countsFor(intent.asset.id, [key, `${key}-finalize`]);
    expect(counts).toMatchObject({ assets: "1", originals: "1", finalized: "1", idempotency: "2", ledger: "3", outbox: "3" });
  });

  it("issues direct-upload authority only for a current pending PostgreSQL intent in its site", async () => {
    const storage = new S3CompatibleMediaStorage({
      tenantId: scope.tenantId, siteId: scope.siteId, bucket: "navocms-media", transport: noTransport(),
      directUploadSigning: { endpoint: "https://r2.example.test", region: "auto", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-only" }
    });
    const signer = new PostgresMediaUploadIntentSigner(database!, storage);
    const repository = new PostgresMediaRepository(database!, new LocalDeterministicMediaStorage());
    const key = `media-presign-${randomUUID()}`;
    const intent = uploadIntent(await repository.createUploadIntent(scope, createInput(key)));
    await expect(signer.sign(scope, intent.intentId, 60)).resolves.toMatchObject({ key: intent.storageKey, method: "PUT" });
    await expect(signer.sign({ ...scope, siteId: "22222222-2222-4222-8222-222222222222" }, intent.intentId, 60)).rejects.toThrow("INTENT");
    // Marking the intent finalized is sufficient to verify signing authority;
    // upload data itself is never passed through this issuer.
    await database!.withScope(scope, (client) => client.query("UPDATE navocms.media_upload_intents SET finalized_at = now() WHERE id = $1", [intent.intentId]));
    await expect(signer.sign(scope, intent.intentId, 60)).rejects.toThrow("INTENT");
    const rejected = uploadIntent(await repository.createUploadIntent(scope, createInput(`${key}-rejected`)));
    await repository.rejectAsset(scope, { assetId: rejected.asset.id, reason: "operator_rejected", idempotencyKey: `${key}-reject` });
    await expect(signer.sign(scope, rejected.intentId, 60)).rejects.toThrow("INTENT");
    const expired = uploadIntent(await repository.createUploadIntent(scope, createInput(`${key}-expired`)));
    await database!.withScope(scope, (client) => client.query("UPDATE navocms.media_upload_intents SET created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second' WHERE id = $1", [expired.intentId]));
    await expect(signer.sign(scope, expired.intentId, 60)).rejects.toThrow("INTENT");
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
    await database!.withScope(scope, (client) => client.query(
      `UPDATE navocms.media_upload_intents
          SET created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [intent.intentId]
    ));
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
    const secondReference = await repository.createReference(scope, {
      assetId: intent.asset.id, ownerType: "content.entry", ownerId: randomUUID(), purpose: "thumbnail", idempotencyKey: `${key}-reference-two`
    });
    const firstPage = await repository.listReferences(scope, intent.asset.id, 1);
    expect(firstPage).toMatchObject({ references: [{ id: expect.any(String) }], nextCursor: expect.any(String) });
    const secondPage = await repository.listReferences(scope, intent.asset.id, 1, firstPage.nextCursor);
    expect(secondPage.references[0]?.id).not.toBe(firstPage.references[0]?.id);
    await expect(repository.getAssetReview(scope, intent.asset.id, 10)).resolves.toMatchObject({
      provenance: { receivedBy: scope.principalId }, rights: { license: "test" }, references: expect.arrayContaining([
        expect.objectContaining({ id: reference.id }), expect.objectContaining({ id: secondReference.id })
      ])
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
    const sizeKey = `media-dedup-size-${randomUUID()}`;
    const mimeKey = `media-dedup-mime-${randomUUID()}`;
    const sourceUrls = [`https://example.com/${sizeKey}`, `https://example.com/${mimeKey}`];
    const sizeInput = createInput(sizeKey, "image/png", mediaBytes(key));
    const mimeInput = createInput(mimeKey, "image/jpeg", mediaBytes(key));
    await expect(repository.createUploadIntent(scope, {
      ...sizeInput, expectedSize: mediaBytes(key).byteLength + 1,
      provenance: { ...sizeInput.provenance, sourceUrl: sourceUrls[0] }
    })).rejects.toThrow("DEDUP_METADATA_MISMATCH");
    await expect(repository.createUploadIntent(scope, {
      ...mimeInput, provenance: { ...mimeInput.provenance, sourceUrl: sourceUrls[1] }
    })).rejects.toThrow("DEDUP_METADATA_MISMATCH");
    expect(await failedDedupCounts([sizeKey, mimeKey], sourceUrls)).toEqual({
      assets: "0", intents: "0", originals: "0", idempotency: "0", ledger: "0", outbox: "0"
    });
  });

  it("persists deterministic AVIF, WebP, and JPEG variants and replays the exact artifact", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-variant-happy-${randomUUID()}`;
    const { asset } = await verifiedSharpAsset(repository, storage, key);
    const formats = ["image/avif", "image/webp", "image/jpeg"] as const;
    const generated: MediaVariantSummary[] = [];
    for (const format of formats) {
      generated.push(await repository.generateVariant(scope, variantInput(asset.id, `${key}-${format}`, format)));
    }
    const replayed = await repository.generateVariant(scope, variantInput(asset.id, `${key}-${formats[0]}`, formats[0]));
    expect(replayed).toEqual(generated[0]);
    expect(generated.map(({ mediaType }) => mediaType)).toEqual(formats);
    for (const variant of generated) {
      expect(variant).toMatchObject({
        variantIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
        storageKey: `tenants/${scope.tenantId}/sites/${scope.siteId}/variants/${variant.variantIdentity}`,
        byteSize: expect.any(Number), presetId: "thumbnail", presetVersion: "v1"
      });
      await expect(storage.head(variant.storageKey)).resolves.toMatchObject({
        byteSize: variant.byteSize, sha256: variant.sha256, mediaType: variant.mediaType
      });
    }
    await expect(repository.getAssetReview(scope, asset.id, 10)).resolves.toMatchObject({
      variants: expect.arrayContaining(generated.map(({ variantIdentity }) => expect.objectContaining({ variantIdentity })))
    });
    await expect(repository.generateVariant(scope, {
      ...variantInput(asset.id, `${key}-${formats[0]}`, formats[0]), format: "image/jpeg"
    })).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    await expect(repository.generateVariant(scope, {
      ...variantInput(asset.id, `${key}-unknown-preset`, "image/webp"), presetVersion: "v2"
    })).rejects.toThrow("PRESET_UNKNOWN");
  });

  it("serializes concurrent generation of one variant without a raw unique conflict", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-variant-concurrent-${randomUUID()}`;
    const { asset } = await verifiedSharpAsset(repository, storage, key);
    const outcomes = await Promise.all([
      repository.generateVariant(scope, variantInput(asset.id, `${key}-first`, "image/webp")),
      repository.generateVariant(scope, variantInput(asset.id, `${key}-second`, "image/webp"))
    ]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    const counts = await variantCounts(asset.id, outcomes[0].variantIdentity);
    expect(counts).toMatchObject({ variants: "1", checkpoints: "1", completed: "1" });
  });

  it("recovers a crash after the variant storage effect and rejects invalid transforms before effects", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const normal = new PostgresMediaRepository(database!, storage);
    const key = `media-variant-crash-${randomUUID()}`;
    const { asset } = await verifiedSharpAsset(normal, storage, key);
    let crash = true;
    const interrupted: MediaStorage = {
      putImmutable: async (object) => {
        await storage.putImmutable(object);
        if (object.key.includes("/variants/") && crash) { crash = false; throw new Error("injected post-storage crash"); }
      },
      head: storage.head.bind(storage), read: storage.read.bind(storage),
      deleteRecoverable: storage.deleteRecoverable.bind(storage), restore: storage.restore.bind(storage),
      reclaim: storage.reclaim.bind(storage), inventory: storage.inventory.bind(storage)
    };
    const input = variantInput(asset.id, `${key}-generate`, "image/webp");
    await expect(new PostgresMediaRepository(database!, interrupted).generateVariant(scope, input)).rejects.toThrow("post-storage crash");
    const pending = await variantCheckpointForAsset(asset.id);
    expect(pending).toMatchObject({ status: "effect_pending", variants: "0" });
    const recovered = await normal.generateVariant(scope, input);
    expect(await variantCheckpointForAsset(asset.id)).toMatchObject({ status: "completed", variants: "1" });
    expect(await storage.head(recovered.storageKey)).toBeDefined();

    const invalidAsset = randomUUID();
    await expect(normal.generateVariant(scope, {
      ...variantInput(invalidAsset, `${key}-invalid-focal`, "image/webp"), crop: "center", focalPoint: { x: 0.5, y: 0.5 }
    })).rejects.toThrow("FOCAL_INVALID");
    await expect(normal.generateVariant(scope, {
      ...variantInput(invalidAsset, `${key}-invalid-responsive`, "image/webp"), presetId: "responsive", width: 320, crop: "focal", focalPoint: { x: 0.5, y: 0.5 }
    })).rejects.toThrow("CROP_INVALID");
    expect(await variantCounts(invalidAsset)).toMatchObject({ variants: "0", checkpoints: "0" });
  });

  it("fails closed on source/storage mismatch and rolls final Ledger/outbox mutation back", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const normal = new PostgresMediaRepository(database!, storage);
    const key = `media-variant-failure-${randomUUID()}`;
    const { asset } = await verifiedSharpAsset(normal, storage, key);
    const mismatchingSource: MediaStorage = {
      putImmutable: storage.putImmutable.bind(storage),
      head: async (storageKey) => {
        const value = await storage.head(storageKey);
        return value && storageKey.includes("/originals/") ? { ...value, sha256: "0".repeat(64) } : value;
      },
      read: storage.read.bind(storage), deleteRecoverable: storage.deleteRecoverable.bind(storage),
      restore: storage.restore.bind(storage), reclaim: storage.reclaim.bind(storage), inventory: storage.inventory.bind(storage)
    };
    await expect(new PostgresMediaRepository(database!, mismatchingSource).generateVariant(
      scope, variantInput(asset.id, `${key}-source-mismatch`, "image/webp")
    )).rejects.toThrow("SOURCE_MISMATCH");
    expect(await variantCounts(asset.id)).toMatchObject({ variants: "0", checkpoints: "0" });

    const outputAsset = await verifiedSharpAsset(normal, storage, `${key}-output`);
    const lyingOutput: MediaStorage = {
      putImmutable: storage.putImmutable.bind(storage), head: storage.head.bind(storage),
      read: async (storageKey, maxBytes) => {
        const object = await storage.read(storageKey, maxBytes);
        if (!object || !storageKey.includes("/variants/")) return object;
        const bytes = new Uint8Array(object.bytes);
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
        return { ...object, bytes };
      },
      deleteRecoverable: storage.deleteRecoverable.bind(storage), restore: storage.restore.bind(storage),
      reclaim: storage.reclaim.bind(storage), inventory: storage.inventory.bind(storage)
    };
    await expect(new PostgresMediaRepository(database!, lyingOutput).generateVariant(
      scope, variantInput(outputAsset.asset.id, `${key}-output-mismatch`, "image/webp")
    )).rejects.toThrow("STORAGE_MISMATCH");
    expect(await variantCounts(outputAsset.asset.id)).toMatchObject({ variants: "0", checkpoints: "1", completed: "0" });

    const store = new PostgresEventStore(database!);
    const failingEvents: EventStore = {
      append: async (event) => {
        const record = await store.append(event);
        if (event.type === "io.navocms.media.variant.generated.v1") throw new Error("injected variant event failure");
        return record;
      },
      query: (query: Parameters<PostgresEventStore["query"]>[0]) => store.query(query)
    };
    const input = variantInput(asset.id, `${key}-rollback`, "image/webp");
    const failing = new PostgresMediaRepository(database!, storage, new PostgresIdempotencyStore(database!), failingEvents);
    await expect(failing.generateVariant(scope, input)).rejects.toThrow("variant event failure");
    const rolledBack = await database!.withScope(scope, async (client) => (
      await client.query<{ variants: string; pending: string; final_idempotency: string; ledger: string; outbox: string }>(
        `SELECT
          (SELECT count(*) FROM navocms.media_variants WHERE asset_id = $1) AS variants,
          (SELECT count(*) FROM navocms.media_variant_checkpoints WHERE asset_id = $1 AND status = 'effect_pending') AS pending,
          (SELECT count(*) FROM navocms.idempotency_records WHERE operation = 'media_variant_generate' AND idempotency_key = $2) AS final_idempotency,
          (SELECT count(*) FROM navocms.event_ledger WHERE correlation_id = $1 AND event_type = 'io.navocms.media.variant.generated.v1') AS ledger,
          (SELECT count(*) FROM navocms.domain_outbox WHERE correlation_id = $1 AND event_type = 'io.navocms.media.variant.generated.v1') AS outbox`,
        [asset.id, input.idempotencyKey]
      )).rows[0]!
    );
    expect(rolledBack).toEqual({ variants: "0", pending: "1", final_idempotency: "0", ledger: "0", outbox: "0" });
    await expect(normal.generateVariant(scope, input)).resolves.toMatchObject({ mediaType: "image/webp" });
    await expect(normal.generateVariant({ ...scope, siteId: randomUUID() }, variantInput(asset.id, `${key}-foreign`, "image/webp"))).rejects.toThrow("SOURCE_NOT_FOUND");
  });

  it("blocks live references, persists a recoverable lifecycle, and never reclaims before grace", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-lifecycle-${randomUUID()}`;
    const { asset } = await verifiedAsset(repository, storage, key);
    await repository.createReference(scope, { assetId: asset.id, ownerType: "content.entry", ownerId: randomUUID(), purpose: "hero", idempotencyKey: `${key}-reference` });
    await expect(repository.scheduleDelete(scope, { assetId: asset.id, idempotencyKey: `${key}-schedule` })).rejects.toThrow("LIVE_REFERENCES");
    const page = await repository.listReferences(scope, asset.id, 10);
    await repository.removeReference(scope, page.references[0]!.id, `${key}-remove`);
    await expect(repository.scheduleDelete(scope, { assetId: asset.id, idempotencyKey: `${key}-schedule` })).resolves.toMatchObject({ state: "deleted" });
    await expect(repository.restore(scope, { assetId: asset.id, idempotencyKey: `${key}-early-restore` })).rejects.toThrow("RECOVERABLE_DELETE_REQUIRED");
    await repository.recoverableDelete(scope, { assetId: asset.id, idempotencyKey: `${key}-recover` });
    const storageKey = originalKey(scope, asset.sha256!);
    expect(await storage.head(storageKey)).toBeUndefined();
    await expect(repository.reclaim(scope, { assetId: asset.id, idempotencyKey: `${key}-reclaim` })).rejects.toThrow("GRACE_NOT_ELAPSED");
    await storage.restore(storageKey); // storage effect succeeds, process crashes before its checkpoint.
    await expect(repository.restore(scope, { assetId: asset.id, idempotencyKey: `${key}-restore` })).resolves.toMatchObject({ state: "verified" });
    expect(await storage.head(storageKey)).toBeDefined();
    await expect(repository.restore(scope, { assetId: asset.id, idempotencyKey: `${key}-restore` })).resolves.toMatchObject({ state: "verified" });
  });

  it("retries interrupted reclaim and reconciles only the requested site prefix", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-reconcile-${randomUUID()}`;
    const { asset } = await verifiedAsset(repository, storage, key);
    const storageKey = originalKey(scope, asset.sha256!);
    await repository.scheduleDelete(scope, { assetId: asset.id, idempotencyKey: `${key}-schedule` });
    await repository.recoverableDelete(scope, { assetId: asset.id, idempotencyKey: `${key}-recover` });
    await database!.withScope(scope, (client) => client.query(
      `UPDATE navocms.media_assets SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 second'
        WHERE tenant_id = $1 AND site_id = $2 AND id = $3`, [scope.tenantId, scope.siteId, asset.id]
    ));
    await database!.withScope(scope, (client) => client.query(
      `UPDATE navocms.media_gc_candidates SET recoverable_until = now() - interval '1 second'
        WHERE tenant_id = $1 AND site_id = $2 AND asset_id = $3`, [scope.tenantId, scope.siteId, asset.id]
    ));
    await storage.restore(storageKey);
    await expect(repository.reclaim(scope, { assetId: asset.id, idempotencyKey: `${key}-reclaim` })).rejects.toThrow("STORAGE_STILL_LIVE");
    await storage.deleteRecoverable(storageKey, new Date(Date.now() - 1));
    await storage.reclaim(storageKey, new Date()); // crash after the storage effect, before the DB checkpoint.
    await repository.reclaim(scope, { assetId: asset.id, idempotencyKey: `${key}-reclaim` });
    await repository.reclaim(scope, { assetId: asset.id, idempotencyKey: `${key}-reclaim` });

    const orphanBytes = mediaBytes(`${key}-orphan`);
    const orphanKey = originalKey(scope, digest(orphanBytes));
    const foreignScope = { ...scope, tenantId: "b2af348f-58b8-4efe-b873-8bd032ecbc5c", siteId: "3e0bcd4f-6780-470c-844b-d72abb6737ca" };
    const foreignBytes = mediaBytes(`${key}-foreign`);
    const foreignKey = originalKey(foreignScope, digest(foreignBytes));
    await storage.putImmutable({ key: orphanKey, bytes: orphanBytes, mediaType: "image/png" });
    await storage.putImmutable({ key: foreignKey, bytes: foreignBytes, mediaType: "image/png" });
    const missing = await verifiedAsset(repository, storage, `${key}-missing`);
    const missingKey = originalKey(scope, missing.asset.sha256!);
    await storage.deleteRecoverable(missingKey, new Date(Date.now() - 1));
    await storage.reclaim(missingKey, new Date());
    let cursor: string | undefined;
    let orphanedStorageObjects = 0;
    let missingStorageObjects = 0;
    for (let page = 0; page < 100; page += 1) {
      const result = await repository.reconcile(scope, {
        idempotencyKey: `${key}-batch`, limit: 10, ...(cursor ? { cursor } : {})
      });
      orphanedStorageObjects += result.orphanedStorageObjects;
      missingStorageObjects += result.missingStorageObjects;
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(orphanedStorageObjects).toBe(1);
    expect(missingStorageObjects).toBeGreaterThanOrEqual(1);
    expect(await storage.head(orphanKey)).toBeUndefined();
    expect(await storage.head(foreignKey)).toBeDefined();
    await expect(repository.getAsset(scope, missing.asset.id)).resolves.toMatchObject({ state: "quarantined" });
  });

  it("paginates the merged storage and database inventory without skipping missing originals", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const key = `media-reconcile-pages-${randomUUID()}`;
    const assets = await Promise.all([0, 1, 2].map((index) => verifiedAsset(repository, storage, `${key}-${index}`)));
    for (const { asset } of assets) {
      const storageKey = originalKey(scope, asset.sha256!);
      await storage.deleteRecoverable(storageKey, new Date(Date.now() - 1));
      await storage.reclaim(storageKey, new Date());
    }

    let cursor: string | undefined;
    let missing = 0;
    for (let page = 0; page < 10; page += 1) {
      const result = await repository.reconcile(scope, { idempotencyKey: `${key}-batch`, limit: 1, ...(cursor ? { cursor } : {}) });
      missing += result.missingStorageObjects;
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    expect(missing).toBe(3);
    for (const { asset } of assets) {
      await expect(repository.getAsset(scope, asset.id)).resolves.toMatchObject({ state: "quarantined" });
    }
  });

  it("rolls lifecycle state, idempotency, ledger, and outbox back when append fails", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const normal = new PostgresMediaRepository(database!, storage);
    const key = `media-lifecycle-rollback-${randomUUID()}`;
    const { asset } = await verifiedAsset(normal, storage, key);
    const failingEvents = {
      append: async (event: Parameters<PostgresEventStore["append"]>[0]) => {
        await new PostgresEventStore(database!).append(event);
        throw new Error("injected lifecycle event failure");
      },
      query: (query: Parameters<PostgresEventStore["query"]>[0]) => new PostgresEventStore(database!).query(query)
    };
    const failing = new PostgresMediaRepository(database!, storage, new PostgresIdempotencyStore(database!), failingEvents);
    const deleteKey = `${key}-schedule`;
    await expect(failing.scheduleDelete(scope, { assetId: asset.id, idempotencyKey: deleteKey })).rejects.toThrow("injected lifecycle event failure");
    const state = await database!.withScope(scope, async (client) => (
      await client.query<{ state: string; candidates: string; checkpoints: string; idempotency: string; ledger: string; outbox: string }>(
        `SELECT (SELECT state FROM navocms.media_assets WHERE id = $1) AS state,
          (SELECT count(*) FROM navocms.media_gc_candidates WHERE asset_id = $1) AS candidates,
          (SELECT count(*) FROM navocms.media_lifecycle_checkpoints WHERE asset_id = $1) AS checkpoints,
          (SELECT count(*) FROM navocms.idempotency_records WHERE operation = 'media_delete_schedule' AND idempotency_key = $2) AS idempotency,
          (SELECT count(*) FROM navocms.event_ledger WHERE correlation_id = $1 AND event_type = 'io.navocms.media.asset.delete.scheduled.v1') AS ledger,
          (SELECT count(*) FROM navocms.domain_outbox WHERE correlation_id = $1 AND event_type = 'io.navocms.media.asset.delete.scheduled.v1') AS outbox`,
        [asset.id, deleteKey]
      )).rows[0]!
    );
    expect(state).toEqual({ state: "verified", candidates: "0", checkpoints: "0", idempotency: "0", ledger: "0", outbox: "0" });
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

async function verifiedAsset(repository: PostgresMediaRepository, storage: LocalDeterministicMediaStorage, key: string) {
  const intent = uploadIntent(await repository.createUploadIntent(scope, createInput(key)));
  const asset = await finalize(repository, storage, intent, key);
  return { asset, intent };
}

async function verifiedSharpAsset(repository: PostgresMediaRepository, storage: LocalDeterministicMediaStorage, key: string) {
  const sourceColor = `#${createHash("sha256").update(key).digest("hex").slice(0, 6)}`;
  const bytes = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: sourceColor } }).png().toBuffer());
  const intent = uploadIntent(await repository.createUploadIntent(scope, createInput(key, "image/png", bytes)));
  await storage.putImmutable({ key: intent.storageKey, bytes, mediaType: "image/png" });
  const asset = await repository.finalizeUpload(scope, finalizeInput(intent, key));
  return { asset, intent };
}

function variantInput(assetId: string, idempotencyKey: string, format: GenerateMediaVariantInput["format"]): GenerateMediaVariantInput {
  return {
    assetId, idempotencyKey, presetId: "thumbnail", presetVersion: "v1", width: 160,
    format, crop: "focal", focalPoint: { x: 0.5, y: 0.5 }
  };
}

async function variantCounts(assetId: string, variantIdentity?: string) {
  return database!.withScope(scope, async (client) => (
    await client.query<{ variants: string; checkpoints: string; completed: string }>(
      `SELECT
        (SELECT count(*) FROM navocms.media_variants WHERE asset_id = $1 AND ($2::text IS NULL OR variant_identity = $2)) AS variants,
        (SELECT count(*) FROM navocms.media_variant_checkpoints WHERE asset_id = $1 AND ($2::text IS NULL OR variant_identity = $2)) AS checkpoints,
        (SELECT count(*) FROM navocms.media_variant_checkpoints WHERE asset_id = $1 AND ($2::text IS NULL OR variant_identity = $2) AND status = 'completed') AS completed`,
      [assetId, variantIdentity ?? null]
    )).rows[0]!
  );
}

async function variantCheckpointForAsset(assetId: string) {
  return database!.withScope(scope, async (client) => (
    await client.query<{ status: string; variants: string }>(
      `SELECT checkpoint.status,
          (SELECT count(*) FROM navocms.media_variants WHERE asset_id = $1) AS variants
         FROM navocms.media_variant_checkpoints checkpoint
        WHERE checkpoint.asset_id = $1 ORDER BY checkpoint.created_at DESC LIMIT 1`,
      [assetId]
    )).rows[0]!
  );
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

async function failedDedupCounts(keys: readonly string[], sourceUrls: readonly string[]) {
  const eventKeys = keys.map((key) => `media_upload_intent_create:${key}`);
  return database!.withScope(scope, async (client) => (
    await client.query<{ assets: string; intents: string; originals: string; idempotency: string; ledger: string; outbox: string }>(
      `SELECT
        (SELECT count(*) FROM navocms.media_assets WHERE provenance_json->>'sourceUrl' = ANY($2::text[])) AS assets,
        (SELECT count(*) FROM navocms.media_upload_intents WHERE operation_key = ANY($1::text[])) AS intents,
        (SELECT count(*) FROM navocms.media_originals o JOIN navocms.media_assets a ON a.id = o.asset_id
          WHERE a.provenance_json->>'sourceUrl' = ANY($2::text[])) AS originals,
        (SELECT count(*) FROM navocms.idempotency_records WHERE idempotency_key = ANY($1::text[])) AS idempotency,
        (SELECT count(*) FROM navocms.event_ledger WHERE event_json->>'navoidempotencykey' = ANY($3::text[])) AS ledger,
        (SELECT count(*) FROM navocms.domain_outbox WHERE payload_json->>'navoidempotencykey' = ANY($3::text[])) AS outbox`,
      [keys, sourceUrls, eventKeys]
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
    deleteRecoverable: storage.deleteRecoverable.bind(storage), restore: storage.restore.bind(storage),
    reclaim: storage.reclaim.bind(storage), inventory: storage.inventory.bind(storage)
  };
}

function noTransport(): S3Transport {
  return { async request() { throw new Error("transport must not be called while presigning"); } };
}

function fakeStorage(overrides: Pick<MediaStorage, "head" | "read">): MediaStorage {
  return {
    putImmutable: async () => undefined,
    head: overrides.head,
    read: overrides.read,
    deleteRecoverable: async () => undefined,
    restore: async () => false,
    reclaim: async () => false,
    inventory: async () => ({ objects: [] })
  };
}
