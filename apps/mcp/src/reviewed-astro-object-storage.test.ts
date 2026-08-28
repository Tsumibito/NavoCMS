import { describe, expect, it } from "vitest";

import { LocalDeterministicReviewedAstroObjectStorage, reviewedAstroObjectDigest, reviewedAstroObjectKey, reviewedAstroObjectPrefix } from "./reviewed-astro-object-storage.js";

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
});
