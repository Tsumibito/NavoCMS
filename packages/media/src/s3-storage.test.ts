import { describe, expect, it } from "vitest";

import type { S3Transport, S3TransportResponse } from "@navocms/s3-core";
import { S3CompatibleMediaStorage } from "./s3-storage.js";
import { sha256 } from "./storage.js";

const scope = { tenantId: "11111111-1111-4111-8111-111111111111", siteId: "22222222-2222-4222-8222-222222222222" };
const now = new Date("2026-08-24T12:00:00.000Z");
const pendingKey = `tenants/${scope.tenantId}/sites/${scope.siteId}/pending/33333333-3333-4333-8333-333333333333`;
const originalOne = `tenants/${scope.tenantId}/sites/${scope.siteId}/originals/${"a".repeat(64)}`;
const originalTwo = `tenants/${scope.tenantId}/sites/${scope.siteId}/originals/${"b".repeat(64)}`;

describe("S3-compatible media storage contract", () => {
  it("uses conditional immutable PUT and rejects a foreign key before transport", async () => {
    const transport = new RecordingTransport(); const storage = adapter(transport);
    await storage.putImmutable({ key: pendingKey, bytes: bytes("one"), mediaType: "image/png" });
    expect(transport.requests[0]).toMatchObject({ method: "PUT", key: physical(pendingKey), headers: { "if-none-match": "*" } });
    await expect(storage.head(pendingKey.replace(scope.siteId, "44444444-4444-4444-8444-444444444444"))).rejects.toThrow("SCOPE");
    expect(transport.requests).toHaveLength(1);
  });

  it("treats a conditional conflict as a safe replay only for exact persisted bytes and MIME", async () => {
    const transport = new RecordingTransport(); const storage = adapter(transport); const body = bytes("same");
    transport.responses.push(response(412), response(200, metadata(body)), response(200, {}, stream(body)));
    await expect(storage.putImmutable({ key: pendingKey, bytes: body, mediaType: "image/png" })).resolves.toBeUndefined();
    transport.responses.push(response(412), response(200, metadata(body, "image/jpeg")), response(200, {}, stream(body)));
    await expect(storage.putImmutable({ key: pendingKey, bytes: body, mediaType: "image/png" })).rejects.toThrow("IMMUTABLE");
  });

  it("does not GET an oversized HEAD and aborts a lying oversized stream", async () => {
    const transport = new RecordingTransport(); const storage = adapter(transport); const body = bytes("payload");
    transport.responses.push(response(200, metadata(body)));
    await expect(storage.read(pendingKey, body.byteLength - 1)).rejects.toThrow("READ_LIMIT");
    expect(transport.requests.map(({ method }) => method)).toEqual(["HEAD"]);
    let aborted = 0;
    transport.responses.push(response(200, metadata(body)), response(200, {}, stream(body, bytes("overflow")), () => { aborted += 1; }));
    await expect(storage.read(pendingKey, body.byteLength)).rejects.toThrow("READ_LIMIT");
    expect(aborted).toBeGreaterThan(0);
    expect(transport.requests.at(-1)?.headers).toMatchObject({ range: `bytes=0-${body.byteLength}` });
  });

  it("normalizes thrown transports and thrown body iterators and cancels the response", async () => {
    const throwing: S3Transport = { async request() { throw new Error("https://secret.example/token"); } };
    await expect(adapter(throwing).head(pendingKey)).rejects.toThrow("STORAGE_PROVIDER_UNAVAILABLE");
    const transport = new RecordingTransport(); const storage = adapter(transport); let aborted = 0;
    transport.responses.push(response(200, metadata(bytes("one"))), response(200, {}, brokenStream(), () => { aborted += 1; }));
    await expect(storage.read(pendingKey, 3)).rejects.toThrow("STORAGE_PROVIDER_UNAVAILABLE");
    expect(aborted).toBeGreaterThan(0);
  });

  it("preserves verified metadata through copy/delete/restore and enforces the stored reclaim deadline", async () => {
    const transport = new RecordingTransport(); const storage = adapter(transport); const body = bytes("one"); const deadline = new Date("2026-08-24T12:05:00.000Z");
    transport.responses.push(response(200, metadata(body)), response(200), response(200, { ...metadata(body), "x-amz-meta-recoverable-until": deadline.toISOString() }), response(204));
    await storage.deleteRecoverable(originalOne, deadline);
    expect(transport.requests[1]).toMatchObject({ method: "PUT", key: physical(recoveryKey(originalOne)), headers: { "x-amz-copy-source": `/navocms-media/${physical(originalOne)}`, "x-amz-metadata-directive": "REPLACE", "x-amz-meta-sha256": sha256(body), "x-amz-meta-media-type": "image/png", "x-amz-meta-recoverable-until": deadline.toISOString() } });
    transport.responses.push(response(200, { ...metadata(body), "x-amz-meta-recoverable-until": deadline.toISOString() }), response(200, { ...metadata(body), "x-amz-meta-recoverable-until": deadline.toISOString() }), response(200, {}, stream(body)), response(200), response(204));
    await expect(storage.restore(originalOne)).resolves.toBe(true);
    transport.responses.push(response(200, { ...metadata(body), "x-amz-meta-recoverable-until": deadline.toISOString() }));
    await expect(storage.reclaim(originalOne, new Date("2026-08-24T12:04:59.000Z"))).rejects.toThrow("GRACE");
    transport.responses.push(response(200, { ...metadata(body), "x-amz-meta-recoverable-until": deadline.toISOString() }), response(204));
    await expect(storage.reclaim(originalOne, deadline)).resolves.toBe(true);
  });

  it("retries safely when recovery copy succeeded before source deletion failed", async () => {
    const transport = new RecordingTransport(); const storage = adapter(transport); const body = bytes("one"); const deadline = new Date("2026-08-24T12:05:00.000Z");
    transport.responses.push(response(200, metadata(body)), response(200), response(200, { ...metadata(body), "x-amz-meta-recoverable-until": deadline.toISOString() }), response(503));
    await expect(storage.deleteRecoverable(originalOne, deadline)).rejects.toThrow("UNAVAILABLE");
    transport.responses.push(response(200, metadata(body)), response(200), response(200, { ...metadata(body), "x-amz-meta-recoverable-until": deadline.toISOString() }), response(204));
    await expect(storage.deleteRecoverable(originalOne, deadline)).resolves.toBeUndefined();
    expect(transport.requests.filter(({ method, key }) => method === "PUT" && key !== physical(originalOne))).toHaveLength(2);
  });

  it("reconciles an exact existing original on restore retry and then deletes recovery", async () => {
    const transport = new RecordingTransport(); const storage = adapter(transport); const body = bytes("one"); const deadline = new Date("2026-08-24T12:05:00.000Z");
    transport.responses.push(
      response(200, { ...metadata(body), "x-amz-meta-recoverable-until": deadline.toISOString() }),
      response(200, { ...metadata(body), "x-amz-meta-recoverable-until": deadline.toISOString() }), response(200, {}, stream(body)),
      response(412), response(200, metadata(body)), response(200, {}, stream(body)), response(204)
    );
    await expect(storage.restore(originalOne)).resolves.toBe(true);
    expect(transport.requests.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("uses a validated lexical start-after cursor across two inventory pages", async () => {
    const transport = new RecordingTransport(); const storage = adapter(transport); const one = bytes("one"); const two = bytes("two"); const prefix = `tenants/${scope.tenantId}/sites/${scope.siteId}/originals/`;
    transport.responses.push(response(200, {}, streamText(listPage(physical(originalOne), one.byteLength, true))), response(200, metadata(one)));
    const first = await storage.inventory(prefix, 1);
    expect(first).toMatchObject({ nextCursor: originalOne });
    transport.responses.push(response(200, {}, streamText(listPage(physical(originalTwo), two.byteLength, false))), response(200, metadata(two)));
    const second = await storage.inventory(prefix, 1, first.nextCursor);
    expect(second.objects.map(({ key }) => key)).toEqual([originalTwo]);
    expect(transport.requests[2]?.query).toMatchObject({ "start-after": physical(originalOne), prefix: physical(prefix) });
    await expect(storage.inventory(prefix, 1, pendingKey)).rejects.toThrow("CURSOR");
  });

  it("rejects provider failures without provider headers, URLs, or credentials", async () => {
    const transport = new RecordingTransport(); const storage = adapter(transport);
    transport.responses.push(response(503, { "x-provider-secret": "must-not-leak" }));
    await expect(storage.head(pendingKey)).rejects.toThrow("STORAGE_PROVIDER_UNAVAILABLE");
  });
});

class RecordingTransport implements S3Transport {
  readonly requests: Array<Parameters<S3Transport["request"]>[0]> = [];
  readonly responses: S3TransportResponse[] = [];
  async request(input: Parameters<S3Transport["request"]>[0]): Promise<S3TransportResponse> { this.requests.push(input); return this.responses.shift() ?? response(200); }
}
function adapter(transport: S3Transport) { return new S3CompatibleMediaStorage({ ...scope, bucket: "navocms-media", transport, clock: () => now }); }
function physical(key: string): string { return `navocms/v1/media/${key}`; }
function recoveryKey(key: string): string { const [prefix] = key.split("/originals/"); return `${prefix}/__recoverable/${Buffer.from(key).toString("base64url")}`; }
function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function metadata(body: Uint8Array, mediaType = "image/png"): Record<string, string> { return { "content-length": String(body.byteLength), "x-amz-meta-sha256": sha256(body), "x-amz-meta-media-type": mediaType }; }
function response(status: number, headers: Record<string, string> = {}, body?: AsyncIterable<Uint8Array>, abort?: () => void): S3TransportResponse { return { status, headers, ...(body ? { body } : {}), ...(abort ? { abort } : {}) }; }
function listPage(key: string, size: number, truncated: boolean): string { return `<ListBucketResult><Contents><Key>${key}</Key><Size>${size}</Size></Contents><IsTruncated>${truncated}</IsTruncated></ListBucketResult>`; }
async function* stream(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> { yield* chunks; }
async function* brokenStream(): AsyncIterable<Uint8Array> { throw new Error("secret body error"); }
async function* streamText(value: string): AsyncIterable<Uint8Array> { yield bytes(value); }
