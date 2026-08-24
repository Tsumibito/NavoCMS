import type { VariantMediaType } from "./domain.js";

export interface MediaPreset {
  readonly presetId: "responsive" | "hero-lcp" | "og" | "thumbnail";
  readonly presetVersion: "v1";
  readonly widths: readonly number[];
  readonly formats: readonly VariantMediaType[];
  readonly fit: "cover" | "inside";
  readonly maxHeight?: number;
}

/** Immutable processing policy. Altering bytes requires a new presetVersion. */
export const MEDIA_PRESETS = Object.freeze([
  Object.freeze({ presetId: "responsive", presetVersion: "v1", widths: Object.freeze([320, 640, 960, 1280, 1600] as const), formats: Object.freeze(["image/avif", "image/webp", "image/jpeg"] as const), fit: "inside" }),
  Object.freeze({ presetId: "hero-lcp", presetVersion: "v1", widths: Object.freeze([768, 1280, 1920] as const), formats: Object.freeze(["image/avif", "image/webp", "image/jpeg"] as const), fit: "cover", maxHeight: 1080 }),
  Object.freeze({ presetId: "og", presetVersion: "v1", widths: Object.freeze([1200] as const), formats: Object.freeze(["image/jpeg"] as const), fit: "cover", maxHeight: 630 }),
  Object.freeze({ presetId: "thumbnail", presetVersion: "v1", widths: Object.freeze([160, 320] as const), formats: Object.freeze(["image/avif", "image/webp", "image/jpeg"] as const), fit: "cover", maxHeight: 320 })
] satisfies readonly MediaPreset[]);

export function resolvePreset(presetId: string, presetVersion: string): MediaPreset {
  const preset = MEDIA_PRESETS.find((item) => item.presetId === presetId && item.presetVersion === presetVersion);
  if (!preset) throw new Error("MEDIA_VARIANT_PRESET_UNKNOWN");
  return preset;
}
