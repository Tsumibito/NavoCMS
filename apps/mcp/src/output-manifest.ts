import { createHash } from "node:crypto";

/**
 * Canonical manifest digest of one built output map. This is the value the
 * confirmation receipt, the approval checkpoint, and the registered artifact
 * must all agree on before publication. The canonical form matches the
 * trusted builder's ordering (sorted keys, stable JSON) so every side
 * computes the same digest independently.
 */
export function outputManifestDigest(output: Readonly<Record<string, string>>): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(output)).digest("hex")}` as `sha256:${string}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
