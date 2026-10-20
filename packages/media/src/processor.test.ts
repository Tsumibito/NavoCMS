import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { processVariant } from "./processor.js";
import { automaticResponsiveTransforms, responsiveByteBudget, resolvePreset } from "./presets.js";
import { sha256 } from "./storage.js";

describe("pinned media processor", () => {
  it("converts a multi-megabyte PNG to bounded modern screen sizes without carrying AI XMP or modifying its original", async () => {
    const width = 2048, height = 1536;
    const pixels = Buffer.alloc(width * height * 3); let seed = 7;
    for (let i = 0; i < pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = ((i % (width * 3)) / (width * 3) * 220 + (seed >>> 24) % 24) & 255; }
    const source = new Uint8Array(await sharp(pixels, { raw: { width, height, channels: 3 } }).withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:ai="urn:test:ai" ai:Generator="synthetic-test-ai"/></rdf:RDF></x:xmpmeta>').png().toBuffer());
    expect(source.byteLength).toBeGreaterThan(3_000_000);
    expect((await sharp(source).metadata()).xmp).toBeDefined();
    const originalHash = sha256(source);
    const transforms = automaticResponsiveTransforms(width);
    expect(transforms).toHaveLength(13);
    for (const transform of transforms) {
      const result = await processVariant({ bytes: source, mediaType: "image/png", preset: resolvePreset("responsive", "v2"), ...transform, crop: "center" });
      expect(result.width).toBe(transform.width);
      expect(result.bytes.byteLength).toBeLessThanOrEqual(responsiveByteBudget(result.width));
      const metadata = await sharp(result.bytes).metadata();
      expect(metadata.xmp).toBeUndefined(); expect(metadata.exif).toBeUndefined();
      expect(Buffer.from(result.bytes).includes(Buffer.from("synthetic-test-ai"))).toBe(false);
    }
    expect(sha256(source)).toBe(originalHash);
  }, 120_000);

  it("rejects an uncompressible image instead of falling back to its original", async () => {
    const pixels = Buffer.alloc(1920 * 1080 * 3); let seed = 29;
    for (let i = 0; i < pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = seed >>> 24; }
    const source = new Uint8Array(await sharp(pixels, { raw: { width: 1920, height: 1080, channels: 3 } }).png().toBuffer());
    await expect(processVariant({ bytes: source, mediaType: "image/png", preset: resolvePreset("responsive", "v2"), width: 1920, format: "image/webp", crop: "center" })).rejects.toThrow("MEDIA_VARIANT_BYTE_BUDGET_EXCEEDED");
  }, 30_000);

  it("preserves transparency in modern formats and uses a white JPEG fallback without upscaling", async () => {
    const source = new Uint8Array(await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
    for (const transform of automaticResponsiveTransforms(40)) {
      const result = await processVariant({ bytes: source, mediaType: "image/png", preset: resolvePreset("responsive", "v2"), ...transform, crop: "center" });
      const metadata = await sharp(result.bytes).metadata();
      expect(result.width).toBe(40);
      expect(metadata.hasAlpha).toBe(transform.format !== "image/jpeg");
      if (transform.format === "image/jpeg") expect((await sharp(result.bytes).raw().toBuffer())[0]).toBeGreaterThan(250);
    }
  });

  it("emits deterministic AVIF, WebP, and JPEG variants with bounded transforms", async () => {
    const source = new Uint8Array(await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 12, g: 34, b: 56 } } }).png().toBuffer());
    const preset = resolvePreset("thumbnail", "v1");
    for (const format of preset.formats) {
      const input = { bytes: source, mediaType: "image/png" as const, preset, width: 160, format, crop: "focal" as const, focalPoint: { x: 0.5, y: 0.5 } };
      const first = await processVariant(input);
      const second = await processVariant(input);
      expect(first).toMatchObject({ mediaType: format, width: expect.any(Number), height: expect.any(Number) });
      expect(sha256(first.bytes)).toBe(sha256(second.bytes));
    }
  });

  it("rejects unpinned sizes and invalid focal points before encoding", async () => {
    const source = new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ffffff" } }).png().toBuffer());
    const preset = resolvePreset("thumbnail", "v1");
    await expect(processVariant({ bytes: source, mediaType: "image/png", preset, width: 999, format: "image/webp", crop: "center" })).rejects.toThrow("TRANSFORM");
    await expect(processVariant({ bytes: source, mediaType: "image/png", preset, width: 160, format: "image/webp", crop: "focal", focalPoint: { x: 2, y: 0 } })).rejects.toThrow("FOCAL");
    await expect(processVariant({ bytes: source, mediaType: "image/png", preset, width: 160, format: "image/webp", crop: "center", focalPoint: { x: 0.5, y: 0.5 } })).rejects.toThrow("FOCAL");
    await expect(processVariant({ bytes: source, mediaType: "image/png", preset: resolvePreset("responsive", "v1"), width: 320, format: "image/webp", crop: "focal", focalPoint: { x: 0.5, y: 0.5 } })).rejects.toThrow("CROP");
    await expect(processVariant({ bytes: source, mediaType: "image/png", preset, width: 160, format: "image/webp", crop: "unknown" as "center" })).rejects.toThrow("CROP");
    await expect(processVariant({ bytes: source, mediaType: "image/png", preset, width: 160, format: "image/webp", crop: "focal", focalPoint: null as unknown as { x: number; y: number } })).rejects.toThrow("FOCAL");
  });

  it("deep-freezes preset policy and strips orientation metadata", async () => {
    const preset = resolvePreset("responsive", "v1");
    expect(Object.isFrozen(preset)).toBe(true);
    expect(Object.isFrozen(preset.widths)).toBe(true);
    expect(Object.isFrozen(preset.formats)).toBe(true);
    expect(() => (preset.widths as number[]).push(2048)).toThrow();

    const oriented = new Uint8Array(await sharp({ create: { width: 2, height: 3, channels: 3, background: "#123456" } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer());
    const result = await processVariant({
      bytes: oriented, mediaType: "image/jpeg", preset, width: 320, format: "image/jpeg", crop: "center"
    });
    const metadata = await sharp(result.bytes).metadata();
    expect(result).toMatchObject({ width: 3, height: 2, mediaType: "image/jpeg" });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
  });
});
