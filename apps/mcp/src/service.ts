import { randomUUID } from "node:crypto";

import type { StructuralPatchOperation } from "@navocms/content";
import { DomainEventFactory, InMemoryEventStore, type EventStore } from "@navocms/kernel";
import { assertSafeProjection, requirePermission } from "@navocms/security";

import { McpEditingError } from "./errors.js";
import { MCP_LIMITS, type McpRequestContext, type PreviewPreparation } from "./model.js";
import { inputFingerprint, type EditingRepository } from "./repository.js";

interface IdempotentRecord<T> {
  readonly fingerprint: string;
  readonly value: T;
}

export class McpEditingService {
  readonly #repository: EditingRepository;
  readonly #events: EventStore;
  readonly #idempotency = new Map<string, IdempotentRecord<unknown>>();

  public constructor(repository: EditingRepository, events: EventStore = new InMemoryEventStore()) {
    this.#repository = repository;
    this.#events = events;
  }

  public listSites(context: McpRequestContext): readonly object[] {
    const site = this.requireSite(context, "content:read");
    return Object.freeze([safe({
      siteId: site.siteId,
      name: site.name,
      primaryLocale: site.primaryLocale,
      locales: site.locales
    })]);
  }

  public search(context: McpRequestContext, query: string, requestedLimit?: number): object {
    const site = this.requireSite(context, "content:read");
    const limit = boundedLimit(requestedLimit);
    const results = this.#repository.search(site, query, limit);
    return safe({ query, results, count: results.length, limit });
  }

  public fetch(context: McpRequestContext, id: string): object {
    const site = this.requireSite(context, "content:read");
    const documentId = id.replace(/^document:/, "");
    const hit = this.#repository.findDocument(site, documentId);
    if (!hit) throw new McpEditingError("CONTENT_NOT_FOUND", "Content item was not found in the authorized site");
    const content = this.getContent(context, hit.revisionId) as Record<string, unknown>;
    return safe({
      id: `document:${hit.id}`,
      title: hit.title,
      text: content.markdown,
      url: `navocms://document/${hit.id}`,
      metadata: {
        typeName: hit.typeName,
        slug: hit.slug,
        locale: hit.locale,
        revisionId: hit.revisionId,
        revisionNumber: hit.revisionNumber,
        sourceHash: hit.sourceHash,
        truncated: content.truncated,
        totalCharacters: content.totalCharacters
      }
    });
  }

  public getContent(context: McpRequestContext, revisionId: string): object {
    const site = this.requireSite(context, "content:read");
    const revision = this.#repository.getRevision(site, revisionId);
    const truncated = revision.source.length > MCP_LIMITS.maxMarkdownCharacters;
    return safe({
      revisionId: revision.id,
      documentId: revision.documentId,
      variantId: revision.variantId,
      revisionNumber: revision.number,
      sourceHash: revision.sourceHash,
      metadata: revision.metadata,
      markdown: truncated ? revision.source.slice(0, MCP_LIMITS.maxMarkdownCharacters) : revision.source,
      truncated,
      totalCharacters: revision.source.length,
      astNodes: revision.ast.nodes.map(({ id, type, parentId, text }) => ({
        id,
        type,
        ...(parentId ? { parentId } : {}),
        text: text.slice(0, MCP_LIMITS.maxExcerptCharacters)
      }))
    });
  }

  public listDrafts(context: McpRequestContext, requestedLimit?: number): object {
    const site = this.requireSite(context, "content:read");
    const limit = boundedLimit(requestedLimit);
    const drafts = this.#repository.listDrafts(site, limit);
    return safe({ drafts, count: drafts.length, limit });
  }

  public async createDraft(context: McpRequestContext, input: {
    readonly typeName: string;
    readonly slug: string;
    readonly locale: string;
    readonly title: string;
    readonly markdown: string;
    readonly metadata?: Readonly<Record<string, unknown>> | undefined;
    readonly idempotencyKey: string;
  }): Promise<object> {
    const site = this.requireSite(context, "content:draft");
    return this.idempotent(`${site.tenantId}:${site.siteId}`, "draft_create", input.idempotencyKey, input, async () => {
      const draft = this.#repository.createDraft({
        site,
        typeName: input.typeName,
        slug: input.slug,
        locale: input.locale,
        title: input.title,
        source: input.markdown,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        actorId: context.authorization.principal.id
      });
      await this.appendEvent(context, "io.navocms.content.draft.created.v1", draft.revisionId, input.idempotencyKey, {
        phase: "applied",
        documentId: draft.id,
        revisionId: draft.revisionId,
        sourceHash: draft.sourceHash
      });
      return safe({ draft, next: "Review the exact revision or prepare a structural patch." });
    });
  }

  public async patchRevision(context: McpRequestContext, input: {
    readonly revisionId: string;
    readonly baseSourceHash: string;
    readonly operations: readonly StructuralPatchOperation[];
    readonly idempotencyKey: string;
  }): Promise<object> {
    const site = this.requireSite(context, "content:draft");
    return this.idempotent(`${site.tenantId}:${site.siteId}`, "revision_patch", input.idempotencyKey, input, async () => {
      const result = this.#repository.patchDraft({
        site,
        revisionId: input.revisionId,
        baseSourceHash: input.baseSourceHash,
        operations: input.operations,
        actorId: context.authorization.principal.id
      });
      await this.appendEvent(context, "io.navocms.content.revision.patched.v1", result.draft.revisionId, input.idempotencyKey, {
        phase: "applied",
        baseRevisionId: input.revisionId,
        revisionId: result.draft.revisionId,
        sourceHash: result.draft.sourceHash,
        operationCount: input.operations.length
      });
      return safe({ draft: result.draft, diff: boundDiff(result.diff) });
    });
  }

  public compare(context: McpRequestContext, fromRevisionId: string, toRevisionId: string): object {
    const site = this.requireSite(context, "content:read");
    return safe({ fromRevisionId, toRevisionId, diff: boundDiff(this.#repository.compare(site, fromRevisionId, toRevisionId)) });
  }

  public preparePreview(context: McpRequestContext, revisionId: string): PreviewPreparation {
    const site = this.requireSite(context, "content:read");
    const revision = this.#repository.getRevision(site, revisionId);
    return safe({
      status: "ready-for-workflow",
      revisionId: revision.id,
      sourceHash: revision.sourceHash,
      workflow: this.#repository.workflowFor(site, revision.id),
      previewUrl: null,
      nextStep: "enqueue-protected-preview",
      note: "Sprint 5 only binds the immutable revision. Protected preview execution and URLs arrive in Sprint 7."
    });
  }

  private requireSite(context: McpRequestContext, permission: "content:read" | "content:draft") {
    requirePermission(context.authorization, permission, {
      tenantId: context.authorization.tenantId,
      siteId: context.authorization.siteId
    });
    const site = this.#repository.getSite(context.authorization.tenantId, context.authorization.siteId);
    if (!site) throw new McpEditingError("SITE_NOT_REGISTERED", "Authorized site is not registered");
    return site;
  }

  private async idempotent<T>(
    scope: string,
    operation: string,
    key: string,
    input: unknown,
    create: () => Promise<T>
  ): Promise<T> {
    const identity = `${scope}:${operation}:${key}`;
    const fingerprint = inputFingerprint(input);
    const existing = this.#idempotency.get(identity);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new McpEditingError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with different input");
      }
      return existing.value as T;
    }
    const value = await create();
    this.#idempotency.set(identity, { fingerprint, value });
    return value;
  }

  private async appendEvent(
    context: McpRequestContext,
    type: string,
    subject: string,
    idempotencyKey: string,
    data: Record<string, unknown>
  ): Promise<void> {
    const factory = new DomainEventFactory({
      source: "urn:navocms:mcp",
      tenantId: context.authorization.tenantId,
      siteId: context.authorization.siteId,
      correlationId: randomUUID(),
      actor: {
        type: context.authorization.principal.kind,
        id: context.authorization.principal.id
      }
    });
    await this.#events.append(factory.create({ type, subject, consequence: "G1", idempotencyKey, data }));
  }
}

function boundedLimit(limit?: number): number {
  if (limit === undefined) return MCP_LIMITS.defaultSearchResults;
  return Math.max(1, Math.min(Math.floor(limit), MCP_LIMITS.maxSearchResults));
}

function boundDiff(diff: { readonly fromHash: string; readonly toHash: string; readonly lines: readonly object[] }) {
  const truncated = diff.lines.length > MCP_LIMITS.maxDiffLines;
  return {
    fromHash: diff.fromHash,
    toHash: diff.toHash,
    lines: truncated ? diff.lines.slice(0, MCP_LIMITS.maxDiffLines) : diff.lines,
    truncated,
    totalLines: diff.lines.length
  };
}

function safe<T>(value: T): T {
  assertSafeProjection(value);
  return Object.freeze(value);
}
