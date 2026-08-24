import { describe, expect, it } from "vitest";

import type { CreateUploadIntentInput, CreateUploadResult, FinalizeUploadInput, MediaAssetSummary, MediaRepository, MediaScope, RemoteMediaIngestInput } from "./domain.js";
import { RemoteMediaIngestService, type RemoteDnsResolver, type RemoteFetchRequest, type RemoteFetchResponse, type RemoteFetchTransport } from "./remote-ingest.js";
import { LocalDeterministicMediaStorage, type MediaStorage, type StorageObject } from "./storage.js";
import { MEDIA_LIMITS } from "./validation.js";

const now = new Date("2026-08-24T12:00:00.000Z");
const scope: MediaScope = { tenantId: "11111111-1111-4111-8111-111111111111", siteId: "22222222-2222-4222-8222-222222222222", principalId: "editor-001", principalKind: "human" };

describe("safe remote media ingest", () => {
  it("pins HTTPS TCP to a validated DNS address and routes accepted bytes through intent/finalize", async () => {
    const transport = new QueueTransport([response(200, png(), { "content-type": "image/png", "content-length": "24" })]);
    const repository = new RecordingRepository(); const storage = new CountingStorage();
    const service = ingest(repository, storage, resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), transport);
    const asset = await service.ingestRemote(scope, input());
    expect(asset.state).toBe("verified");
    expect(transport.requests).toEqual([expect.objectContaining({ connectIp: "8.8.8.8", hostHeader: "media.example", serverName: "media.example" })]);
    expect(repository.creates[0]).toMatchObject({ expectedMediaType: "image/png", expectedSize: 24, provenance: { kind: "remote-ingest", sourceUrl: "https://media.example/a.png", receivedBy: scope.principalId } });
    expect(storage.puts).toBe(1);
    expect(repository.finalizes).toHaveLength(1);
  });

  it("fails closed before transport when any A/AAAA result is private, reserved, malformed, or mapped", async () => {
    for (const address of ["10.0.0.1", "0.0.0.0", "192.0.2.1", "224.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "not-an-ip"]) {
      const transport = new QueueTransport([]);
      const service = ingest(new RecordingRepository(), new CountingStorage(), resolver({ "media.example": [{ address, family: address.includes(":") ? 6 : 4 }] }), transport);
      await expect(service.ingestRemote(scope, input())).rejects.toThrow(/(non-global|malformed|REMOTE_DNS_INVALID)/);
      expect(transport.requests).toHaveLength(0);
    }
    const mixed = new QueueTransport([]);
    await expect(ingest(new RecordingRepository(), new CountingStorage(), resolver({ "media.example": [
      { address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }
    ] }), mixed).ingestRemote(scope, input())).rejects.toThrow("non-global");
    expect(mixed.requests).toHaveLength(0);
  });

  it("re-resolves and revalidates every redirect, including same-host DNS rebinding", async () => {
    const transport = new QueueTransport([
      response(302, new Uint8Array(), { location: "https://media.example/next" }),
      response(200, png(), { "content-type": "image/png" })
    ]);
    const rebinding = sequentialResolver([
      [{ address: "8.8.8.8", family: 4 }],
      [{ address: "127.0.0.1", family: 4 }]
    ]);
    const service = ingest(new RecordingRepository(), new CountingStorage(), rebinding, transport);
    await expect(service.ingestRemote(scope, input())).rejects.toThrow("non-global");
    expect(transport.requests).toHaveLength(1);
    expect(transport.aborts).toBeGreaterThan(0);
  });

  it("limits redirects and rejects credential, fragment, and non-default-port redirect targets", async () => {
    const redirects = new QueueTransport([
      response(302, new Uint8Array(), { location: "https://media.example/1" }),
      response(302, new Uint8Array(), { location: "https://media.example/2" }),
      response(302, new Uint8Array(), { location: "https://media.example/3" }),
      response(302, new Uint8Array(), { location: "https://media.example/4" })
    ]);
    const service = ingest(new RecordingRepository(), new CountingStorage(), resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), redirects);
    await expect(service.ingestRemote(scope, input())).rejects.toThrow("REMOTE_REDIRECT_LIMIT");
    expect(redirects.requests).toHaveLength(4);
    for (const target of ["https://user:secret@media.example/a", "https://media.example/a#x", "https://media.example:444/a"]) {
      const transport = new QueueTransport([response(302, new Uint8Array(), { location: target })]);
      await expect(ingest(new RecordingRepository(), new CountingStorage(), resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), transport).ingestRemote(scope, input())).rejects.toThrow("Remote ingest only permits HTTPS");
    }
    const malformed = new QueueTransport([response(302, new Uint8Array(), { location: "https://secret@%" })]);
    await expect(ingest(new RecordingRepository(), new CountingStorage(), resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), malformed).ingestRemote(scope, input())).rejects.toThrow("REMOTE_REDIRECT_URL_INVALID");
  });

  it("aborts on timeout, lying length, body overflow, and unexpected compression before storage", async () => {
    const timeout = new QueueTransport([response(200, never(), { "content-type": "image/png" })]);
    await expect(ingest(new RecordingRepository(), new CountingStorage(), resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), timeout, 5).ingestRemote(scope, input())).rejects.toThrow("REMOTE_TIMEOUT");
    expect(timeout.aborts).toBeGreaterThan(0);

    const oversized = new QueueTransport([response(200, [png(), new Uint8Array(MEDIA_LIMITS.maxBytes)], { "content-type": "image/png", "content-length": "24" })]);
    const storage = new CountingStorage();
    await expect(ingest(new RecordingRepository(), storage, resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), oversized).ingestRemote(scope, input())).rejects.toThrow("REMOTE_BODY_TOO_LARGE");
    expect(oversized.aborts).toBeGreaterThan(0); expect(storage.puts).toBe(0);

    const malformedLength = new QueueTransport([response(200, png(), { "content-type": "image/png", "content-length": "24, 24" })]);
    await expect(ingest(new RecordingRepository(), new CountingStorage(), resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), malformedLength).ingestRemote(scope, input())).rejects.toThrow("REMOTE_CONTENT_LENGTH_INVALID");
    expect(malformedLength.aborts).toBeGreaterThan(0);

    const compressed = new QueueTransport([response(200, png(), { "Content-Type": "image/png", "Content-Encoding": "gzip" })]);
    await expect(ingest(new RecordingRepository(), new CountingStorage(), resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), compressed).ingestRemote(scope, input())).rejects.toThrow("REMOTE_CONTENT_ENCODING_FORBIDDEN");
  });

  it("applies one deadline to DNS and pre-header transport work and propagates abort", async () => {
    const hangingDns: RemoteDnsResolver = { async lookup() { return new Promise(() => undefined); } };
    const noTransport = new QueueTransport([]);
    await expect(ingest(new RecordingRepository(), new CountingStorage(), hangingDns, noTransport, 5).ingestRemote(scope, input())).rejects.toThrow("REMOTE_TIMEOUT");
    expect(noTransport.requests).toHaveLength(0);

    let transportAborted = false;
    const hangingTransport: RemoteFetchTransport = { async get(request) {
      return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => {
        transportAborted = true;
        reject(new Error("raw transport timeout"));
      }, { once: true }));
    } };
    await expect(ingest(new RecordingRepository(), new CountingStorage(), resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), hangingTransport, 5).ingestRemote(scope, input())).rejects.toThrow("REMOTE_TIMEOUT");
    expect(transportAborted).toBe(true);
  });

  it("uses content sniffing and rejects declared MIME drift before intent or storage", async () => {
    const repository = new RecordingRepository(); const storage = new CountingStorage();
    const service = ingest(repository, storage, resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), new QueueTransport([response(200, png(), { "content-type": "image/jpeg" })]));
    await expect(service.ingestRemote(scope, input())).rejects.toThrow("REMOTE_MIME_MISMATCH");
    expect(repository.creates).toHaveLength(0); expect(storage.puts).toBe(0);
    const pixelBomb = ingest(repository, storage, resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), new QueueTransport([response(200, png(99_999, 1), { "content-type": "image/png" })]));
    await expect(pixelBomb.ingestRemote(scope, input())).rejects.toMatchObject({ code: "MEDIA_DECODE_LIMIT" });
    expect(repository.creates).toHaveLength(0); expect(storage.puts).toBe(0);
  });

  it("normalizes DNS, transport, and body failures without leaking remote values", async () => {
    const storage = new CountingStorage();
    const throwingTransport: RemoteFetchTransport = { async get() { throw new Error("https://user:secret@private.example/token"); } };
    await expect(ingest(new RecordingRepository(), storage, resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), throwingTransport).ingestRemote(scope, input())).rejects.toThrow("REMOTE_FETCH_FAILED");
    const throwingBody = {
      abort() { /* assertion is the normalized outcome */ },
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> { throw new Error("provider body https://secret.example"); }
    };
    const response: RemoteFetchResponse = { status: 200, headers: { "content-type": "image/png" }, body: throwingBody, abort() { throwingBody.abort(); } };
    await expect(ingest(new RecordingRepository(), storage, resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), new QueueTransport([response])).ingestRemote(scope, input())).rejects.toThrow("REMOTE_BODY_FAILED");
    expect(storage.puts).toBe(0);
  });

  it("replays identical remote bytes and rejects remote-content drift before a second storage write", async () => {
    const repository = new RecordingRepository(); const storage = new CountingStorage();
    const transport = new QueueTransport([
      response(200, png(), { "content-type": "image/png" }),
      response(200, png(), { "content-type": "image/png" }),
      response(200, png(12, 20), { "content-type": "image/png" })
    ]);
    const service = ingest(repository, storage, resolver({ "media.example": [{ address: "8.8.8.8", family: 4 }] }), transport);
    await expect(service.ingestRemote(scope, input())).resolves.toMatchObject({ state: "verified" });
    await expect(service.ingestRemote(scope, input())).resolves.toMatchObject({ state: "verified" });
    expect(storage.puts).toBe(2); expect(repository.assets).toHaveLength(1);
    await expect(service.ingestRemote(scope, input())).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    expect(storage.puts).toBe(2); expect(repository.assets).toHaveLength(1);
  });
});

function ingest(repository: RecordingRepository, storage: CountingStorage, dns: RemoteDnsResolver, transport: RemoteFetchTransport, timeoutMs = 15_000): RemoteMediaIngestService {
  return new RemoteMediaIngestService(repository, storage, { resolver: dns, transport, timeoutMs, clock: () => now });
}

function input(): RemoteMediaIngestInput { return { sourceUrl: "https://media.example/a.png", idempotencyKey: "remote-ingest-key-0001", receivedAt: now.toISOString(), rights: { license: "CC-BY-4.0", restricted: false } }; }
function png(width = 10, height = 20): Uint8Array { const value = new Uint8Array(24); value.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); value.set([0x49, 0x48, 0x44, 0x52], 12); const view = new DataView(value.buffer); view.setUint32(16, width); view.setUint32(20, height); return value; }
function resolver(records: Record<string, readonly Readonly<{ address: string; family: 4 | 6 }>[]>): RemoteDnsResolver { return { async lookup(hostname) { return records[hostname] ?? []; } }; }
function sequentialResolver(results: readonly (readonly Readonly<{ address: string; family: 4 | 6 }>[])[]): RemoteDnsResolver { let index = 0; return { async lookup() { return results[index++] ?? []; } }; }
function response(status: number, body: Uint8Array | readonly Uint8Array[] | AsyncIterable<Uint8Array>, headers: Record<string, string>): RemoteFetchResponse { let aborted = false; const stream = toBody(body, () => { aborted = true; }); return Object.freeze({ status, headers, body: stream, abort: () => { aborted = true; stream.abort(); }, get _aborted() { return aborted; } }) as RemoteFetchResponse; }
function toBody(value: Uint8Array | readonly Uint8Array[] | AsyncIterable<Uint8Array>, onAbort: () => void) {
  const values = value instanceof Uint8Array ? [value] : Symbol.asyncIterator in value ? value : value;
  return Object.freeze({ abort: onAbort, async *[Symbol.asyncIterator]() { for await (const chunk of values) yield chunk; } });
}
async function* never(): AsyncGenerator<Uint8Array> { await new Promise<void>(() => undefined); }

class QueueTransport implements RemoteFetchTransport {
  readonly requests: RemoteFetchRequest[] = [];
  readonly #responses: RemoteFetchResponse[];
  aborts = 0;
  public constructor(responses: RemoteFetchResponse[]) { this.#responses = responses; }
  public async get(request: RemoteFetchRequest): Promise<RemoteFetchResponse> {
    this.requests.push(request); const current = this.#responses.shift(); if (!current) throw new Error("unexpected transport request");
    const abort = current.abort.bind(current); return Object.freeze({ ...current, abort: (reason?: Error) => { this.aborts += 1; abort(reason); } });
  }
}

class CountingStorage implements MediaStorage {
  readonly #inner = new LocalDeterministicMediaStorage();
  puts = 0;
  public async putImmutable(object: StorageObject): Promise<void> { this.puts += 1; return this.#inner.putImmutable(object); }
  public head(key: string) { return this.#inner.head(key); }
  public read(key: string, maxBytes: number) { return this.#inner.read(key, maxBytes); }
  public deleteRecoverable(key: string, until: Date) { return this.#inner.deleteRecoverable(key, until); }
  public restore(key: string) { return this.#inner.restore(key); }
  public reclaim(key: string, now: Date) { return this.#inner.reclaim(key, now); }
  public inventory(prefix: string, limit: number, cursor?: string) { return this.#inner.inventory(prefix, limit, cursor); }
}

class RecordingRepository implements Pick<MediaRepository, "createUploadIntent" | "finalizeUpload"> {
  readonly creates: CreateUploadIntentInput[] = [];
  readonly finalizes: FinalizeUploadInput[] = [];
  readonly assets: MediaAssetSummary[] = [];
  #fingerprint: string | undefined;
  #result: CreateUploadResult | undefined;
  public async createUploadIntent(_scope: MediaScope, value: CreateUploadIntentInput): Promise<CreateUploadResult> {
    const fingerprint = `${value.expectedSha256}:${value.expectedSize}:${value.expectedMediaType}:${value.expiresAt}:${JSON.stringify(value.provenance)}:${JSON.stringify(value.rights)}`;
    if (this.#fingerprint !== undefined && this.#fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED");
    this.creates.push(value);
    if (this.#result) return this.#result;
    const asset: MediaAssetSummary = { id: "33333333-3333-4333-8333-333333333333", state: "pending", createdAt: now.toISOString() };
    this.assets.push(asset); this.#fingerprint = fingerprint;
    this.#result = { kind: "upload-intent", asset, intentId: "44444444-4444-4444-8444-444444444444", storageKey: `tenants/${scope.tenantId}/sites/${scope.siteId}/pending/44444444-4444-4444-8444-444444444444`, expiresAt: value.expiresAt };
    return this.#result;
  }
  public async finalizeUpload(_scope: MediaScope, value: FinalizeUploadInput): Promise<MediaAssetSummary> {
    this.finalizes.push(value); const asset = { ...this.assets[0]!, state: "verified" as const }; this.assets[0] = asset; return asset;
  }
}
