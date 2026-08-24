import sharp from "sharp";

import type { VariantMediaType } from "./domain.js";
import type { MediaPreset } from "./presets.js";
import { MEDIA_LIMITS, inspectMedia } from "./validation.js";

export interface VariantProcessInput {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg" | "image/png";
  readonly preset: MediaPreset;
  readonly width: number;
  readonly format: VariantMediaType;
  readonly crop: "center" | "focal";
  readonly focalPoint?: Readonly<{ x: number; y: number }>;
}

export interface ProcessedVariant {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly mediaType: VariantMediaType;
}

export interface MediaProcessor {
  process(input: VariantProcessInput): Promise<ProcessedVariant>;
}

/**
 * Pinned sharp/libvips engine. The explicit encoder options and `rotate()`
 * provide a stable, orientation-correct, metadata-free output in the pinned
 * production image. No `withMetadata()` call is permitted here.
 */
export class PinnedMediaProcessor implements MediaProcessor {
  public async process(input: VariantProcessInput): Promise<ProcessedVariant> {
    inspectMedia(input.bytes, input.mediaType);
    assertVariantTransform(input.preset, input.width, input.format, input.crop, input.focalPoint);
    const focal = input.crop === "focal" ? input.focalPoint : undefined;
    const pipeline = sharp(input.bytes, { failOn: "error", limitInputPixels: MEDIA_LIMITS.maxPixels, sequentialRead: true })
      .rotate()
      .resize({ width: input.width, ...(input.preset.maxHeight ? { height: input.preset.maxHeight } : {}), fit: input.preset.fit, position: focal ? focalGravity(focal) : "centre", withoutEnlargement: true });
    const encoded = input.format === "image/avif"
      ? pipeline.avif({ quality: 50, effort: 4, chromaSubsampling: "4:2:0" })
      : input.format === "image/webp"
        ? pipeline.webp({ quality: 75, effort: 4, smartSubsample: false })
        : pipeline.jpeg({ quality: 82, chromaSubsampling: "4:2:0", progressive: false, mozjpeg: false });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height || info.width > MEDIA_LIMITS.maxDimension || info.height > MEDIA_LIMITS.maxDimension || info.width * info.height > MEDIA_LIMITS.maxPixels) throw new Error("MEDIA_VARIANT_DECODE_LIMIT");
    return Object.freeze({ bytes: new Uint8Array(data), width: info.width, height: info.height, mediaType: input.format });
  }
}

export function assertVariantTransform(
  preset: MediaPreset,
  width: number,
  format: VariantMediaType,
  crop: "center" | "focal",
  focalPoint?: Readonly<{ x: number; y: number }>
): void {
  if (!preset.widths.includes(width) || !preset.formats.includes(format)) throw new Error("MEDIA_VARIANT_PRESET_TRANSFORM_INVALID");
  if (crop !== "center" && crop !== "focal") throw new Error("MEDIA_VARIANT_CROP_INVALID");
  if (preset.fit === "inside" && (crop !== "center" || focalPoint !== undefined)) throw new Error("MEDIA_VARIANT_CROP_INVALID");
  if (crop === "focal" && preset.fit !== "cover") throw new Error("MEDIA_VARIANT_CROP_INVALID");
  if ((crop === "focal") !== (focalPoint !== undefined && focalPoint !== null)) throw new Error("MEDIA_VARIANT_FOCAL_INVALID");
  if (focalPoint && (!Number.isFinite(focalPoint.x) || !Number.isFinite(focalPoint.y) || focalPoint.x < 0 || focalPoint.x > 1 || focalPoint.y < 0 || focalPoint.y > 1)) throw new Error("MEDIA_VARIANT_FOCAL_INVALID");
}

function focalGravity(focal: Readonly<{ x: number; y: number }>): "northwest" | "north" | "northeast" | "west" | "centre" | "east" | "southwest" | "south" | "southeast" {
  const horizontal = focal.x < 1 / 3 ? "west" : focal.x > 2 / 3 ? "east" : "centre";
  const vertical = focal.y < 1 / 3 ? "north" : focal.y > 2 / 3 ? "south" : "centre";
  if (vertical === "centre") return horizontal;
  if (horizontal === "centre") return vertical;
  return `${vertical}${horizontal}` as "northwest" | "northeast" | "southwest" | "southeast";
}
