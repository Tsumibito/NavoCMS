import { describe, expect, it } from "vitest";

import type { S3Transport, S3TransportResponse } from "@navocms/s3-core";

import { LocalDeterministicReviewedAstroObjectStorage, reviewedAstroObjectDigest, reviewedAstroObjectKey, reviewedAstroObjectPrefix, S3ReviewedAstroObjectStorage } from "./reviewed-astro-object-storage.js";

const scope = Object.freeze({ tenantId: "tenant-a", siteId: "site-a" });
const source = new TextEncoder().encode('{"source":true}');

describe("reviewed Astro object storage boundary", () => {
  it("uses site-scoped content-addressed immutable keys and bounded reads", async () => {
    const storage = new LocalDeterministicReviewedAstroObjectStorage();
    const key = reviewedAstroObjectKey(scope, "source", reviewedAstroObjectDigest(source));
    await storage.putImmutable({ key, bytes: source, mediaType: "application/vnd.navocms.astro-source-bundle+json" });
    await storage.putImmutable({ key, bytes: source, mediaType: "application/vnd.navocms.astro-source-bundle+json" });
    await expect(storage.putImmutable({ key, bytes: new TextEncoder().encode("different"), mediaType: "application/vnd.navocms.astro-source-bundle+json" })).rejects.toThrow("IMMUTABLE");
    await expect(storage.read(key, source.byteLength - 1)).rejects.toThrow("READ_LIMIT");
    await expect(storage.read(key, source.byteLength)).resolves.toMatchObject({ key, mediaType: "application/vnd.navocms.astro-source-bundle+json" });
    expect(key).toContain("tenants/tenant-a/sites/site-a/reviewed-astro/source/sha256/");
  });

  it("exposes only a bounded scoped inventory for orphan reconciliation", async () => {
    const storage = new LocalDeterministicReviewedAstroObjectStorage();
    for (const body of ["one", "two"]) {
      const bytes = new TextEncoder().encode(body);
      await storage.putImmutable({ key: reviewedAstroObjectKey(scope, "output", reviewedAstroObjectDigest(bytes)), bytes, mediaType: "application/vnd.navocms.astro-output-bundle+json" });
    }
    await expect(storage.inventory(reviewedAstroObjectPrefix(scope), 1)).resolves.toMatchObject({ objects: [{ key: expect.stringContaining("tenants/tenant-a/sites/site-a/") }], nextCursor: expect.any(String) });
    await expect(storage.inventory("tenants/other/sites/site-a/reviewed-astro/", 1)).resolves.toEqual({ objects: [] });
    await expect(storage.inventory(reviewedAstroObjectPrefix(scope), 101)).rejects.toThrow("INVENTORY");
  });

  it("maps logical tenant/site keys into only the reviewed artifacts namespace", async () => {
    const transport = new RecordingTransport(); const storage = s3Storage(transport);
    const key = reviewedAstroObjectKey(scope, "source", reviewedAstroObjectDigest(source));
    await storage.putImmutable({ key, bytes: source, mediaType: "application/vnd.navocms.astro-source-bundle+json" });
    expect(transport.requests[0]).toMatchObject({ method: "PUT", key: `navocms/v1/artifacts/${key}`, headers: { "if-none-match": "*" } });
    expect(transport.requests[0]?.key).not.toContain("navocms/v1/media/");
  });

  it("rejects root, foreign, and traversal tenant keys before the provider", async () => {
    const transport = new RecordingTransport(); const storage = s3Storage(transport);
    await expect(storage.head("tenants/")).rejects.toThrow("KEY_SCOPE");
    await expect(storage.head("tenants/../sites/site-a/reviewed-astro/source/sha256/" + "a".repeat(64) + ".json")).rejects.toThrow("KEY_SCOPE");
    await expect(storage.inventory("tenants/tenant-a/sites/../reviewed-astro/", 1)).rejects.toThrow("PREFIX_SCOPE");
    await expect(storage.inventory("tenants/tenant-a/sites/site-a/", 1)).rejects.toThrow("PREFIX_SCOPE");
    expect(transport.requests).toHaveLength(0);
  });

  it("reconciles an exact immutable replay and preserves bounded read defence", async () => {
    const transport = new RecordingTransport(); const storage = s3Storage(transport); const key = reviewedAstroObjectKey(scope, "output", reviewedAstroObjectDigest(source));
    transport.responses.push(response(200), response(412), response(200, metadata(source, "application/vnd.navocms.astro-output-bundle+json")), response(200, {}, stream(source)));
    await storage.putImmutable({ key, bytes: source, mediaType: "application/vnd.navocms.astro-output-bundle+json" });
    await expect(storage.putImmutable({ key, bytes: source, mediaType: "application/vnd.navocms.astro-output-bundle+json" })).resolves.toBeUndefined();
    transport.responses.push(response(200, metadata(source, "application/vnd.navocms.astro-output-bundle+json")));
    await expect(storage.read(key, source.byteLength - 1)).rejects.toThrow("READ_LIMIT");
    expect(transport.requests.map(({ method }) => method)).toEqual(["PUT", "PUT", "HEAD", "GET", "HEAD"]);
  });
});

class RecordingTransport implements S3Transport {
  readonly requests: Parameters<S3Transport["request"]>[0][] = [];
  readonly responses: S3TransportResponse[] = [];
  async request(input: Parameters<S3Transport["request"]>[0]): Promise<S3TransportResponse> { this.requests.push(input); return this.responses.shift() ?? response(200); }
}
function s3Storage(transport: S3Transport): S3ReviewedAstroObjectStorage { return new S3ReviewedAstroObjectStorage({ bucket: "navocms-artifacts", transport }); }
function metadata(bytes: Uint8Array, mediaType: string): Record<string, string> { return { "content-length": String(bytes.byteLength), "x-amz-meta-sha256": reviewedAstroObjectDigest(bytes), "x-amz-meta-media-type": mediaType }; }
function response(status: number, headers: Record<string, string> = {}, body?: AsyncIterable<Uint8Array>): S3TransportResponse { return { status, headers, ...(body ? { body } : {}) }; }
async function* stream(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }
