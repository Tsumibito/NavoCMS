import { describe, expect, it } from "vitest";

import { createFetchS3Transport, NAVOCMS_ARTIFACTS_NAMESPACE, NAVOCMS_MEDIA_NAMESPACE, S3NamespaceStorage, sha256, type S3Transport, type S3TransportResponse } from "./s3-namespace-storage.js";

const namespace = NAVOCMS_MEDIA_NAMESPACE;
const logicalKey = "tenants/11111111-1111-4111-8111-111111111111/sites/22222222-2222-4222-8222-222222222222/originals/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const logicalPrefix = logicalKey.slice(0, logicalKey.lastIndexOf("/") + 1);

describe("S3 namespace storage", () => {
  it("exposes only reviewed media and artifact children below the shared root", () => {
    expect(namespace).toBe("navocms/v1/media/");
    expect(NAVOCMS_ARTIFACTS_NAMESPACE).toBe("navocms/v1/artifacts/");
    expect(() => new S3NamespaceStorage({ bucket: "navocms-media", namespace: "navocms/v1/other/" as never, transport: new RecordingTransport() })).toThrow("NAMESPACE");
  });

  it("rejects traversal, control characters, backslashes, and physical-key overflows before transport", async () => {
    const transport = new RecordingTransport(); const storage = core(transport);
    for (const invalid of ["../outside", "tenant/../outside", "tenant//empty", "tenant/\\windows", `tenant/${String.fromCharCode(0)}nul`, `tenant/${String.fromCharCode(31)}control`, "a".repeat(1025)]) {
      await expect(storage.head(invalid)).rejects.toThrow("SCOPE");
    }
    await expect(storage.inventory(`${"a".repeat(1024)}/`, 1)).rejects.toThrow("SCOPE");
    expect(transport.requests).toHaveLength(0);
  });
  it("maps every provider key, list prefix, cursor, and copy source into its fixed namespace", async () => {
    const transport = new RecordingTransport(); const storage = core(transport); const body = bytes("one");
    await storage.putImmutable({ key: logicalKey, bytes: body, mediaType: "image/png" });
    expect(transport.requests[0]).toMatchObject({ method: "PUT", key: `${namespace}${logicalKey}`, headers: { "if-none-match": "*", "x-amz-meta-byte-size": String(body.byteLength) } });
    transport.responses.push(response(200, {}, text(listPage(`${namespace}${logicalKey}`, body.byteLength, true))), response(200, metadata(body)));
    const page = await storage.inventory(logicalPrefix, 1);
    expect(page).toMatchObject({ nextCursor: logicalKey });
    expect(transport.requests[1]?.query).toMatchObject({ prefix: `${namespace}${logicalPrefix}` });
    transport.responses.push(response(200, {}, text(listPage(`${namespace}${logicalKey.replace(/a+$/, "b".repeat(64))}`, 3, false))), response(200, metadata(body)));
    await storage.inventory(logicalPrefix, 1, page.nextCursor);
    expect(transport.requests[3]?.query).toMatchObject({ "start-after": `${namespace}${logicalKey}` });
    await storage.copy(logicalKey, logicalKey.replace(/a+$/, "c".repeat(64)), { "x-amz-metadata-directive": "REPLACE" });
    expect(transport.requests.at(-1)).toMatchObject({ key: `${namespace}${logicalKey.replace(/a+$/, "c".repeat(64))}`, headers: { "x-amz-copy-source": `/navocms-media/${namespace}${logicalKey}` } });
  });

  it("rejects provider list keys outside the requested physical prefix, including namespace markers", async () => {
    const transport = new RecordingTransport(); const storage = core(transport);
    transport.responses.push(response(200, {}, text(listPage(`${namespace}_namespace.json`, 2, false))));
    await expect(storage.inventory(logicalPrefix, 1)).rejects.toThrow("SCOPE");
    transport.responses.push(response(200, {}, text(listPage("navocms/v1/artifacts/report.json", 2, false))));
    await expect(storage.inventory(logicalPrefix, 1)).rejects.toThrow("SCOPE");
  });

  it("cancels a lying stream after its bounded read and normalizes body errors", async () => {
    const transport = new RecordingTransport(); const storage = core(transport); const body = bytes("one"); let aborted = 0;
    transport.responses.push(response(200, metadata(body)), response(200, {}, stream(body, bytes("extra")), () => { aborted += 1; }));
    await expect(storage.read(logicalKey, body.byteLength)).rejects.toThrow("READ_LIMIT");
    expect(aborted).toBe(1);
    transport.responses.push(response(200, metadata(body)), response(200, {}, brokenStream(), () => { aborted += 1; }));
    await expect(storage.read(logicalKey, body.byteLength)).rejects.toThrow("PROVIDER_UNAVAILABLE");
    expect(aborted).toBe(2);
  });

  it("uses immutable byte-size metadata when an R2 fetch omits content-length", async () => {
    const transport = new RecordingTransport(); const storage = core(transport); const body = bytes("one");
    const { "content-length": _omitted, ...withoutContentLength } = metadata(body);
    transport.responses.push(response(200, { ...withoutContentLength, "x-amz-meta-byte-size": String(body.byteLength) }), response(200, {}, stream(body)));
    await expect(storage.read(logicalKey, body.byteLength)).resolves.toMatchObject({ key: logicalKey, mediaType: "image/png" });
  });

  it("signs exact payload checksums with injected runtime configuration and never leaks failures", async () => {
    let capturedUrl: string | undefined; let capturedHeaders: Headers | undefined;
    const transport = createFetchS3Transport({
      endpoint: () => "https://r2.example.test/root", bucket: () => "navocms-media",
      credentials: () => ({ accessKeyId: "AKID", secretAccessKey: "secret" }), clock: () => new Date("2026-08-24T12:00:00.000Z"),
      fetch: async (input, init) => { capturedUrl = String(input); capturedHeaders = new Headers(init?.headers); return new Response(null, { status: 200 }); }
    });
    await transport.request({ method: "PUT", key: `${namespace}artifact.bin`, body: bytes("one"), headers: { "x-amz-meta-sha256": "a".repeat(64) } });
    expect(capturedUrl).toBe("https://r2.example.test/root/navocms-media/navocms/v1/media/artifact.bin");
    expect(capturedHeaders?.get("x-amz-content-sha256")).toBe("7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed");
    expect(capturedHeaders?.get("authorization")).toBe("AWS4-HMAC-SHA256 Credential=AKID/20260824/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256, Signature=c639aa23397695ae5bdc11d5dc56551ef01b7a47d5633a81d9f3cab4c2a53ebd");
    const unavailable = createFetchS3Transport({ endpoint: () => "https://r2.example.test", bucket: () => "navocms-media", credentials: () => ({ accessKeyId: "AKID", secretAccessKey: "secret" }), fetch: async () => { throw new Error("https://credential.example/secret"); } });
    await expect(unavailable.request({ method: "HEAD", key: `${namespace}nope` })).rejects.toThrow("S3_TRANSPORT_UNAVAILABLE");
    const timedOut = createFetchS3Transport({ endpoint: () => "https://r2.example.test", bucket: () => "navocms-media", credentials: () => ({ accessKeyId: "AKID", secretAccessKey: "secret" }), timeoutMs: 10, fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true })) });
    await expect(timedOut.request({ method: "HEAD", key: `${namespace}slow` })).rejects.toThrow("S3_TRANSPORT_UNAVAILABLE");
  });

  it("normalizes unsafe endpoint and credential configuration before signing", async () => {
    const request = { method: "HEAD" as const, key: `${namespace}nope` };
    for (const endpoint of ["https://user:pass@r2.example.test", "https://r2.example.test/?query=1", "https://r2.example.test/#fragment"]) {
      const transport = createFetchS3Transport({ endpoint: () => endpoint, bucket: () => "navocms-media", credentials: () => ({ accessKeyId: "AKID", secretAccessKey: "secret" }), fetch: unexpectedFetch });
      await expect(transport.request(request)).rejects.toThrow("S3_TRANSPORT_UNAVAILABLE");
    }
    for (const options of [
      { bucket: () => "x".repeat(64), credentials: () => ({ accessKeyId: `AK${String.fromCharCode(10)}ID`, secretAccessKey: "secret" }), region: () => "auto" },
      { bucket: () => "navocms-media", credentials: () => ({ accessKeyId: "AKID", secretAccessKey: "secret".repeat(50) }), region: () => `auto${String.fromCharCode(127)}` }
    ]) {
      const transport = createFetchS3Transport({ endpoint: () => "https://r2.example.test/root", ...options, fetch: unexpectedFetch });
      await expect(transport.request(request)).rejects.toThrow("S3_TRANSPORT_UNAVAILABLE");
    }
  });
});

class RecordingTransport implements S3Transport {
  readonly requests: S3Transport["request"] extends (input: infer Input) => Promise<unknown> ? Input[] : never[] = [];
  readonly responses: S3TransportResponse[] = [];
  async request(input: Parameters<S3Transport["request"]>[0]): Promise<S3TransportResponse> { this.requests.push(input); return this.responses.shift() ?? response(200); }
}
function core(transport: S3Transport): S3NamespaceStorage { return new S3NamespaceStorage({ bucket: "navocms-media", namespace, transport }); }
function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function metadata(body: Uint8Array): Record<string, string> { return { "content-length": String(body.byteLength), "x-amz-meta-sha256": sha256(body), "x-amz-meta-media-type": "image/png" }; }
function response(status: number, headers: Record<string, string> = {}, body?: AsyncIterable<Uint8Array>, abort?: () => void): S3TransportResponse { return { status, headers, ...(body ? { body } : {}), ...(abort ? { abort } : {}) }; }
function listPage(key: string, size: number, truncated: boolean): string { return `<ListBucketResult><Contents><Key>${key}</Key><Size>${size}</Size></Contents><IsTruncated>${truncated}</IsTruncated></ListBucketResult>`; }
async function* stream(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> { yield* chunks; }
async function* brokenStream(): AsyncIterable<Uint8Array> { throw new Error("body failure"); }
async function* text(value: string): AsyncIterable<Uint8Array> { yield bytes(value); }
async function unexpectedFetch(): Promise<Response> { throw new Error("fetch must not be called"); }
