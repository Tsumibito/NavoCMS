import { createHash } from "node:crypto";

import { KernelError } from "./errors.js";

export type ReleaseStatus =
  | "previewed"
  | "approved"
  | "publishing"
  | "published"
  | "verification_failed"
  | "failed"
  | "rolled_back";

export interface ReleaseManifestV1 {
  readonly schema: "io.navocms.release-manifest.v1";
  readonly tenantId: string;
  readonly siteId: string;
  readonly environmentId: string;
  readonly revisionId: string;
  readonly sourceHash: string;
  readonly workflow: string;
  readonly anchors: Readonly<{
    content: string;
    design: string;
    delivery: string;
    governance: string;
  }>;
}

export interface ReleaseArtifact {
  readonly mediaType: "text/html; charset=utf-8";
  readonly body: string;
  readonly hash: string;
}

export interface ReleaseProviderPublishInput {
  readonly releaseId: string;
  readonly releaseHash: string;
  readonly artifact: ReleaseArtifact;
  readonly previousProviderReference?: string;
}

export interface ReleaseProviderPublication {
  readonly providerKey: string;
  readonly providerReference: string;
  readonly artifactHash: string;
}

export interface ReleaseProvider {
  readonly key: string;
  /** Implementations must treat input.releaseHash as the idempotency key. */
  publish(input: ReleaseProviderPublishInput): Promise<ReleaseProviderPublication>;
  verify(publication: ReleaseProviderPublication): Promise<boolean>;
  rollback(current: ReleaseProviderPublication, target: ReleaseProviderPublication): Promise<void>;
}

export const RELEASE_TRANSITIONS = Object.freeze({
  previewed: ["approved", "failed"],
  approved: ["publishing", "failed"],
  publishing: ["published", "verification_failed", "failed"],
  published: ["rolled_back"],
  verification_failed: ["publishing", "published", "rolled_back", "failed"],
  failed: [],
  rolled_back: []
} satisfies Record<ReleaseStatus, readonly ReleaseStatus[]>);

export function releaseTransition(from: ReleaseStatus, to: ReleaseStatus): ReleaseStatus {
  const allowed: readonly ReleaseStatus[] = RELEASE_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new KernelError("RELEASE_TRANSITION_INVALID", `Release cannot move from ${from} to ${to}`);
  }
  return to;
}

export function createReleaseManifest(input: Omit<ReleaseManifestV1, "schema" | "anchors"> & {
  readonly anchors?: Partial<ReleaseManifestV1["anchors"]>;
}): { readonly manifest: ReleaseManifestV1; readonly releaseHash: string } {
  assertHash(input.sourceHash, "sourceHash");
  const anchors = Object.freeze({
    content: input.anchors?.content ?? input.sourceHash,
    design: input.anchors?.design ?? sha256("navocms:design:unconfigured:v1"),
    delivery: input.anchors?.delivery ?? sha256("navocms:delivery:embedded:v1"),
    governance: input.anchors?.governance ?? sha256("navocms:governance:default:v1")
  });
  for (const [name, value] of Object.entries(anchors)) assertHash(value, `anchors.${name}`);
  const manifest = Object.freeze({
    schema: "io.navocms.release-manifest.v1" as const,
    tenantId: input.tenantId,
    siteId: input.siteId,
    environmentId: input.environmentId,
    revisionId: input.revisionId,
    sourceHash: input.sourceHash,
    workflow: input.workflow,
    anchors
  });
  return Object.freeze({ manifest, releaseHash: sha256(canonicalJson(manifest)) });
}

export function renderMarkdownProofArtifact(input: {
  readonly releaseHash: string;
  readonly title: string;
  readonly markdown: string;
  readonly locale: string;
}): ReleaseArtifact {
  assertHash(input.releaseHash, "releaseHash");
  const body = [
    "<!doctype html>",
    `<html lang="${escapeHtml(input.locale)}">`,
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"robots\" content=\"noindex,nofollow,noarchive\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    `<meta name="navocms-release-hash" content="${input.releaseHash}">`,
    `<title>${escapeHtml(input.title)} — NavoCMS preview</title>`,
    "<style>body{max-width:76ch;margin:3rem auto;padding:0 1.25rem;font:16px/1.6 system-ui,sans-serif;color:#17202a;background:#fff}header{border-bottom:1px solid #dfe6e9;margin-bottom:2rem}code{font-size:.75rem;word-break:break-all}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>",
    "</head><body>",
    `<header><strong>Protected NavoCMS preview</strong><p>Release <code>${input.releaseHash}</code></p></header>`,
    `<main><pre>${escapeHtml(input.markdown)}</pre></main>`,
    "</body></html>"
  ].join("");
  return Object.freeze({ mediaType: "text/html; charset=utf-8", body, hash: sha256(body) });
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertHash(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new KernelError("RELEASE_HASH_INVALID", `${name} must be a SHA-256 hash`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]!);
}
