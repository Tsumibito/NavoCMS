import type { VariantMediaType } from "./domain.js";

export interface MediaPreset {
  readonly presetId: "responsive" | "hero-lcp" | "og" | "thumbnail";
  readonly presetVersion: "v1" | "v2";
  readonly widths: readonly number[];
  readonly formats: readonly VariantMediaType[];
  readonly fit: "cover" | "inside";
  readonly maxHeight?: number;
}

/** Immutable processing policy. Altering bytes requires a new presetVersion. */
export const MEDIA_PRESETS = Object.freeze([
  Object.freeze({ presetId: "responsive", presetVersion: "v2", widths: Object.freeze([320, 640, 960, 1280, 1600, 1920] as const), formats: Object.freeze(["image/avif", "image/webp", "image/jpeg"] as const), fit: "inside" }),
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

/** One native-size candidate, plus smaller screens; never upscale the source. */
export function automaticResponsiveTransforms(width: number): readonly { width: number; format: VariantMediaType }[] {
  if (!Number.isSafeInteger(width) || width < 1) throw new Error("MEDIA_DIMENSIONS_INVALID");
  const preset = resolvePreset("responsive", "v2");
  const ceiling = preset.widths.find(candidate => candidate >= width) ?? preset.widths.at(-1)!;
  const widths = preset.widths.filter(candidate => candidate <= ceiling);
  return [...widths.flatMap(width => [{ width, format: "image/avif" as const }, { width, format: "image/webp" as const }]),
    { width: Math.min(ceiling, 1280), format: "image/jpeg" as const }];
}

/** Bounded delivery weight; fail closed rather than serve the original. */
export function responsiveByteBudget(width: number): number { return Math.max(24 * 1024, Math.min(192 * 1024, width * 112)); }
