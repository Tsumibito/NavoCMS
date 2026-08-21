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
  readonly status: "ready-for-workflow";
  readonly revisionId: string;
  readonly sourceHash: string;
  readonly workflow: string;
  readonly previewUrl: null;
  readonly nextStep: "enqueue-protected-preview";
  readonly note: string;
}

export const MCP_LIMITS = Object.freeze({
  maxSearchResults: 20,
  defaultSearchResults: 8,
  maxMarkdownCharacters: 20_000,
  maxExcerptCharacters: 280,
  maxDiffLines: 400,
  maxRequestBytes: 256 * 1024
});
