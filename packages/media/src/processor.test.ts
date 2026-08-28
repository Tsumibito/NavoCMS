import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { processVariant } from "./processor.js";
import { resolvePreset } from "./presets.js";
import { sha256 } from "./storage.js";

describe("pinned media processor", () => {
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
