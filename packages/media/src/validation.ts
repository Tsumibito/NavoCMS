import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { SecurityError } from "@navocms/security";

export const MEDIA_LIMITS = Object.freeze({ maxBytes: 25 * 1024 * 1024, maxPixels: 40_000_000, maxDimension: 16_384, maxFrames: 300, maxRedirects: 3 });
/** Only formats with a complete, bounded header inspector are accepted for originals. */
export type SupportedMediaType = "image/jpeg" | "image/png";
export interface MediaInspection { readonly mediaType: SupportedMediaType; readonly width: number; readonly height: number; readonly frames: number; }

export function sniffMediaType(bytes: Uint8Array): SupportedMediaType {
  if (bytes.byteLength < 12) throw reject("MEDIA_TYPE_UNSUPPORTED", "Media is too short to identify safely");
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a" || (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") || (ascii(bytes, 4, 4) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 4)))) {
    throw reject("MEDIA_TYPE_UNSUPPORTED", "Only JPEG and PNG originals have an implemented bounded inspector");
  }
  // SVG is text and must never reach a decoder by default.
  if (new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 512))).trimStart().startsWith("<svg")) throw reject("SVG_REJECTED", "SVG uploads are disabled");
  throw reject("MEDIA_TYPE_UNSUPPORTED", "Media signature is not an allowed image type");
}

export function verifyUpload(bytes: Uint8Array, expected: { readonly sha256: string; readonly byteSize: number; readonly mediaType?: string }): SupportedMediaType {
  if (bytes.byteLength !== expected.byteSize || bytes.byteLength > MEDIA_LIMITS.maxBytes) throw reject("MEDIA_SIZE_INVALID", "Upload size does not match a bounded intent");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const expectedDigest = Buffer.from(expected.sha256, "hex");
  if (expectedDigest.byteLength !== 32 || !timingSafeEqual(Buffer.from(digest, "hex"), expectedDigest)) throw reject("MEDIA_CHECKSUM_MISMATCH", "Upload checksum did not match intent");
  const mediaType = sniffMediaType(bytes);
  if (expected.mediaType && expected.mediaType !== mediaType) throw reject("MEDIA_TYPE_MISMATCH", "Upload content type did not match intent");
  inspectMedia(bytes, mediaType);
  return mediaType;
}

/** Header-only inspection is the mandatory guard before any isolated decoder. */
export function inspectMedia(bytes: Uint8Array, mediaType = sniffMediaType(bytes)): MediaInspection {
  const dimensions = mediaType === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (!dimensions) throw reject("MEDIA_DIMENSIONS_UNREADABLE", "Image dimensions could not be verified before decode");
  const frames = 1;
  if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width > MEDIA_LIMITS.maxDimension || dimensions.height > MEDIA_LIMITS.maxDimension || dimensions.width * dimensions.height > MEDIA_LIMITS.maxPixels || frames > MEDIA_LIMITS.maxFrames) {
    throw reject("MEDIA_DECODE_LIMIT", "Image exceeds safe decoder limits");
  }
  return Object.freeze({ mediaType, ...dimensions, frames });
}

export function assertSafeRemoteUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw reject("REMOTE_URL_INVALID", "Remote media URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw reject("REMOTE_URL_FORBIDDEN", "Remote ingest only permits HTTPS default-port URLs without credentials or fragments");
  return url;
}

export function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (family === 0) throw reject("REMOTE_ADDRESS_INVALID", "Remote host returned a malformed IP address");
  if (family === 4 && !isGlobalIpv4(address)) throw reject("REMOTE_ADDRESS_FORBIDDEN", "Remote host resolved to a non-global IPv4 address");
  if (family === 6 && !isGlobalIpv6(address)) throw reject("REMOTE_ADDRESS_FORBIDDEN", "Remote host resolved to a non-global IPv6 address");
}

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean { return prefix.every((value, index) => bytes[index] === value); }
function ascii(bytes: Uint8Array, offset: number, length: number): string { return String.fromCharCode(...bytes.slice(offset, offset + length)); }
function reject(code: string, message: string): SecurityError { return new SecurityError(code, message); }
function uint32be(bytes: Uint8Array, offset: number): number { return ((bytes[offset]! << 24) >>> 0) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!; }
function pngDimensions(bytes: Uint8Array) { return ascii(bytes, 12, 4) === "IHDR" && bytes.byteLength >= 24 ? { width: uint32be(bytes, 16), height: uint32be(bytes, 20) } : undefined; }
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  for (let index = 2; index + 9 < bytes.byteLength;) {
    if (bytes[index] !== 0xff) { index += 1; continue; }
    const marker = bytes[index + 1]!; const length = (bytes[index + 2]! << 8) | bytes[index + 3]!;
    if (length < 2) return undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { height: (bytes[index + 5]! << 8) | bytes[index + 6]!, width: (bytes[index + 7]! << 8) | bytes[index + 8]! };
    index += 2 + length;
  }
  return undefined;
}

function isGlobalIpv4(address: string): boolean {
  const parts = address.split(".").map(Number); const [a = -1, b = -1, c = -1] = parts;
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if ((a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

function isGlobalIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return false;
  const [first = 0, second = 0, third = 0] = groups;
  const mapped = groups.slice(0, 6).every((value, index) => value === (index === 5 ? 0xffff : 0));
  if (mapped) return isGlobalIpv4(`${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`);
  // Global-unicast is 2000::/3. Everything else is unspecified, loopback,
  // link-local, ULA, multicast, documentation, or otherwise non-global.
  if (first < 0x2000 || first >= 0x4000) return false;
  if (first === 0x2001 && (second === 0 || (second === 2 && third === 0) || second === 0x0db8)) return false;
  if (first === 0x2002) return isGlobalIpv4(`${second >> 8}.${second & 0xff}.${third >> 8}.${third & 0xff}`);
  if (first === 0x3fff && second < 0x1000) return false;
  return true;
}

function ipv6Groups(address: string): number[] | undefined {
  let normalized = address.toLowerCase();
  const dotted = normalized.lastIndexOf(":");
  if (dotted >= 0 && normalized.slice(dotted + 1).includes(".")) {
    const tail = normalized.slice(dotted + 1).split(".").map(Number);
    if (tail.length !== 4 || tail.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    normalized = `${normalized.slice(0, dotted + 1)}${((tail[0]! << 8) | tail[1]!).toString(16)}:${((tail[2]! << 8) | tail[3]!).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => part ? part.split(":").map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN)) : [];
  const left = parse(halves[0]!); const right = parse(halves[1] ?? "");
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return undefined;
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
  return groups.length === 8 ? groups : undefined;
}
