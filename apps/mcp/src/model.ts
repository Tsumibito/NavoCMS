import type { AuthorizationContext } from "@navocms/security";

export interface SiteDescriptor {
  readonly tenantId: string;
  readonly siteId: string;
  readonly name: string;
  readonly primaryLocale: string;
  readonly locales: readonly string[];
}

export interface McpRequestContext {
  readonly authorization: AuthorizationContext;
}

export interface ContentHit {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly typeName: string;
  readonly locale: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly sourceHash: string;
  readonly excerpt: string;
}

export interface DraftSummary extends ContentHit {
  readonly updatedAt: string;
}

export interface PreviewPreparation {
  readonly status: "previewed";
  readonly releaseId: string;
  readonly releaseHash: string;
  readonly revisionId: string;
  readonly sourceHash: string;
  readonly artifactHash: string;
  readonly workflow: string;
  readonly previewUrl: string;
  readonly confirmationUrl?: string;
  readonly build: PreviewBuildStatus;
  readonly expiresAt: string;
  readonly nextStep: "approve-exact-release";
}

/** Durable trusted-Astro build job state for one release candidate. */
export interface PreviewBuildStatus {
  readonly releaseId: string;
  readonly status: "building" | "ready" | "failed" | "unsupported";
  readonly outputManifestDigest?: string;
  readonly sourceCommitSha?: string;
  readonly fileCount?: number;
  readonly totalBytes?: number;
  readonly errorCode?: string;
}

/** The independently recorded human decision for one release candidate. */
export interface ConfirmationStatus {
  readonly releaseId: string;
  readonly releaseHash: string;
  readonly status: "pending" | "confirmed" | "expired" | "revoked";
  readonly policyVersion: string;
  readonly decidedAt?: string;
  readonly receiptHash?: string;
  readonly outputManifestDigest?: string;
  readonly receiptExpiresAt?: string;
}

export const MCP_LIMITS = Object.freeze({
  maxSearchResults: 20,
  defaultSearchResults: 8,
  maxMarkdownCharacters: 20_000,
  maxExcerptCharacters: 280,
  maxAstNodes: 100,
  maxMetadataCharacters: 4_000,
  maxDiffLines: 400,
  maxRequestBytes: 256 * 1024,
  idempotencyKeyMinLength: 16,
  idempotencyKeyMaxLength: 128
});
