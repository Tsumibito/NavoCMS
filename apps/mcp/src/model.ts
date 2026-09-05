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
  readonly expiresAt: string;
  readonly nextStep: "approve-exact-release";
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
