import { describe, expect, it } from "vitest";
import { LocalDeterministicMediaStorage, assertOriginalKey, originalKey, originalPrefix, sha256, variantIdentity } from "./storage.js";
import { assertPublicAddress, assertSafeRemoteUrl, inspectMedia, sniffMediaType, verifyUpload } from "./validation.js";

describe("media trust boundary", () => {
  it("rejects spoofed, SVG, and oversized upload payloads before storage", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffMediaType(jpeg)).toBe("image/jpeg");
    expect(() => verifyUpload(jpeg, { sha256: "0".repeat(64), byteSize: jpeg.byteLength })).toThrow(/checksum/i);
    expect(() => sniffMediaType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>").slice(0, 12))).toThrow(/SVG/i);
    expect(() => verifyUpload(jpeg, { sha256: sha256(jpeg), byteSize: jpeg.byteLength + 1 })).toThrow(/size/i);
  });

  it("blocks private IPv4/IPv6 and unsafe remote URLs", () => {
    for (const address of [
      "127.0.0.1", "10.0.0.1", "169.254.169.254", "0.0.0.0", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1",
      "::1", "fe80::1", "fd00::1", "ff02::1", "2001:db8::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:0.0.0.0", "not-an-ip", "999.1.1.1"
    ]) expect(() => assertPublicAddress(address)).toThrow();
    expect(() => assertSafeRemoteUrl("http://example.com/a.jpg")).toThrow();
    expect(() => assertSafeRemoteUrl("https://user:password@example.com/a.jpg")).toThrow();
    expect(assertSafeRemoteUrl("https://example.com/a.jpg").hostname).toBe("example.com");
  });

  it("uses immutable, scoped object keys and deterministic variants", async () => {
    const scope = { tenantId: "11111111-1111-4111-8111-111111111111", siteId: "22222222-2222-4222-8222-222222222222" };
    const bytes = new Uint8Array([1, 2, 3]); const digest = sha256(bytes); const key = originalKey(scope, digest);
    const storage = new LocalDeterministicMediaStorage();
    await storage.putImmutable({ key, bytes, mediaType: "image/jpeg" });
    await storage.putImmutable({ key, bytes, mediaType: "image/jpeg" });
    await expect(storage.read(key, 2)).rejects.toThrow("READ_LIMIT");
    expect(await storage.read(key, 3)).toMatchObject({ key, mediaType: "image/jpeg" });
    await expect(storage.putImmutable({ key, bytes: new Uint8Array([4]), mediaType: "image/jpeg" })).rejects.toThrow("IMMUTABLE");
    await expect(storage.putImmutable({ key, bytes, mediaType: "image/png" })).rejects.toThrow("IMMUTABLE");
    expect(() => assertOriginalKey(scope, key.replace(scope.siteId, "33333333-3333-4333-8333-333333333333"), digest)).toThrow("SCOPE");
    expect(variantIdentity(digest, "v1", { width: 1200, crop: "center" })).toBe(variantIdentity(digest, "v1", { crop: "center", width: 1200 }));
    expect(() => variantIdentity(digest, "v1", { value: Number.NaN })).toThrow("JSON");
    expect(() => variantIdentity(digest, "v1", { value: undefined })).toThrow("JSON");
  });

  it("inspects dimensions and frames before a decoder could be invoked", () => {
    const png = new Uint8Array(24); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); png.set([0x49, 0x48, 0x44, 0x52], 12); png.set([0, 0, 0, 10, 0, 0, 0, 20], 16);
    expect(inspectMedia(png)).toMatchObject({ mediaType: "image/png", width: 10, height: 20, frames: 1 });
    png.set([0, 0, 0, 0, 0, 0, 0, 20], 16);
    expect(() => inspectMedia(png)).toThrow(/decoder limits/i);
    png.set([0, 1, 0, 0, 0, 1, 0, 0], 16);
    expect(() => inspectMedia(png)).toThrow(/decoder limits/i);
  });

  it("rejects formats without a complete bounded inspector", () => {
    const gif = new TextEncoder().encode("GIF89a000000");
    const webp = new Uint8Array(12); webp.set(new TextEncoder().encode("RIFF"), 0); webp.set(new TextEncoder().encode("WEBP"), 8);
    expect(() => sniffMediaType(gif)).toThrow(/JPEG and PNG/i);
    expect(() => sniffMediaType(webp)).toThrow(/JPEG and PNG/i);
  });

  it("reconciles only a bounded scoped inventory and supports recoverable lifecycle effects", async () => {
    const first = { tenantId: "11111111-1111-4111-8111-111111111111", siteId: "22222222-2222-4222-8222-222222222222" };
    const second = { tenantId: "33333333-3333-4333-8333-333333333333", siteId: "44444444-4444-4444-8444-444444444444" };
    const storage = new LocalDeterministicMediaStorage();
    const firstBytes = new Uint8Array([1]); const secondBytes = new Uint8Array([2]); const foreignBytes = new Uint8Array([3]);
    const firstKey = originalKey(first, sha256(firstBytes)); const secondKey = originalKey(first, sha256(secondBytes));
    const foreignKey = originalKey(second, sha256(foreignBytes));
    await storage.putImmutable({ key: firstKey, bytes: firstBytes, mediaType: "image/jpeg" });
    await storage.putImmutable({ key: secondKey, bytes: secondBytes, mediaType: "image/jpeg" });
    await storage.putImmutable({ key: foreignKey, bytes: foreignBytes, mediaType: "image/jpeg" });
    const page = await storage.inventory(originalPrefix(first), 1);
    expect(page.objects).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    expect((await storage.inventory(originalPrefix(first), 1, page.nextCursor)).objects).toHaveLength(1);
    expect((await storage.inventory(originalPrefix(first), 1, `${originalPrefix(first)}${"0".repeat(64)}`)).objects).toHaveLength(1);
    expect((await storage.inventory(originalPrefix(second), 10)).objects.map(({ key }) => key)).toEqual([foreignKey]);
    const grace = new Date(Date.now() + 60_000);
    await storage.deleteRecoverable(firstKey, grace);
    await expect(storage.reclaim(firstKey, new Date())).rejects.toThrow("GRACE");
    expect(await storage.restore(firstKey)).toBe(true);
    await storage.deleteRecoverable(firstKey, new Date(Date.now() - 1));
    expect(await storage.reclaim(firstKey, new Date())).toBe(true);
    expect(await storage.head(firstKey)).toBeUndefined();
    expect(await storage.head(foreignKey)).toBeDefined();
  });
});
