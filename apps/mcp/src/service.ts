import { randomUUID } from "node:crypto";

import type { StructuralPatchOperation } from "@navocms/content";
import { DomainEventFactory, InMemoryEventStore, type EventStore } from "@navocms/kernel";
import { assertSafeProjection, requirePermission } from "@navocms/security";

import { McpEditingError } from "./errors.js";
import { MCP_LIMITS, type McpRequestContext, type PreviewPreparation } from "./model.js";
import { inputFingerprint, type EditingRepository, type RepositoryContext } from "./repository.js";

interface IdempotentRecord<T> {
  readonly fingerprint: string;
  readonly status: "pending" | "completed" | "failed";
  readonly errorCode?: string;
  readonly value: T;
}

interface IdempotencyReservation<T> {
  readonly status: "reserved" | "completed" | "pending" | "failed";
  readonly value?: T;
  readonly errorCode?: string;
}

export interface IdempotencyStore {
  reserve<T>(scope: { readonly tenantId: string; readonly siteId: string; readonly principalId: string }, operation: string, key: string, fingerprint: string): Promise<IdempotencyReservation<T>>;
  complete(scope: { readonly tenantId: string; readonly siteId: string; readonly principalId: string }, operation: string, key: string, fingerprint: string, value: unknown): Promise<void>;
  fail(scope: { readonly tenantId: string; readonly siteId: string; readonly principalId: string }, operation: string, key: string, fingerprint: string, errorCode: string): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, IdempotentRecord<unknown>>();

  public async reserve<T>(scope: { readonly tenantId: string; readonly siteId: string }, operation: string, key: string, fingerprint: string): Promise<IdempotencyReservation<T>> {
    const identity = `${scope.tenantId}:${scope.siteId}:${operation}:${key}`;
    const existing = this.#records.get(identity);
    if (!existing) {
      this.#records.set(identity, { fingerprint, status: "pending", value: undefined });
      return { status: "reserved" };
    }
    if (existing.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED");
    return {
      status: existing.status,
      ...(existing.status === "completed" ? { value: existing.value as T } : {}),
      ...(existing.errorCode ? { errorCode: existing.errorCode } : {})
    };
  }

  public async complete(scope: { readonly tenantId: string; readonly siteId: string }, operation: string, key: string, fingerprint: string, value: unknown): Promise<void> {
    this.#records.set(`${scope.tenantId}:${scope.siteId}:${operation}:${key}`, { fingerprint, status: "completed", value });
  }

  public async fail(scope: { readonly tenantId: string; readonly siteId: string }, operation: string, key: string, fingerprint: string, errorCode: string): Promise<void> {
    this.#records.set(`${scope.tenantId}:${scope.siteId}:${operation}:${key}`, { fingerprint, status: "failed", errorCode, value: undefined });
  }
}

export class McpEditingService {
  readonly #repository: EditingRepository;
  readonly #events: EventStore;
  readonly #idempotency: IdempotencyStore;

  public constructor(
    repository: EditingRepository,
    events: EventStore = new InMemoryEventStore(),
    idempotency: IdempotencyStore = new InMemoryIdempotencyStore()
  ) {
    this.#repository = repository;
    this.#events = events;
    this.#idempotency = idempotency;
  }

  public async listSites(context: McpRequestContext): Promise<readonly object[]> {
    const { site } = await this.requireSite(context, "content:read");
    return Object.freeze([safe({
      siteId: site.siteId,
      name: site.name,
      primaryLocale: site.primaryLocale,
      locales: site.locales
    })]);
  }

  public async search(context: McpRequestContext, query: string, requestedLimit?: number): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:read");
    const limit = boundedLimit(requestedLimit);
    const results = await this.#repository.search(repositoryContext, query, limit);
    return safe({ query, results, count: results.length, limit });
  }

  public async fetch(context: McpRequestContext, id: string): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:read");
    const documentId = id.replace(/^document:/, "");
    const hit = await this.#repository.findDocument(repositoryContext, documentId);
    if (!hit) throw new McpEditingError("CONTENT_NOT_FOUND", "Content item was not found in the authorized site");
    const content = await this.getContent(context, hit.revisionId) as Record<string, unknown>;
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

  public async getContent(context: McpRequestContext, revisionId: string): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:read");
    const revision = await this.#repository.getRevision(repositoryContext, revisionId);
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

  public async listDrafts(context: McpRequestContext, requestedLimit?: number): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:read");
    const limit = boundedLimit(requestedLimit);
    const drafts = await this.#repository.listDrafts(repositoryContext, limit);
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
    const { site } = await this.requireSite(context, "content:draft");
    return this.idempotent({ tenantId: site.tenantId, siteId: site.siteId, principalId: context.authorization.principal.id }, "draft_create", input.idempotencyKey, input, async () => {
      const draft = await this.#repository.createDraft({
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
    const { site } = await this.requireSite(context, "content:draft");
    return this.idempotent({ tenantId: site.tenantId, siteId: site.siteId, principalId: context.authorization.principal.id }, "revision_patch", input.idempotencyKey, input, async () => {
      const result = await this.#repository.patchDraft({
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

  public async compare(context: McpRequestContext, fromRevisionId: string, toRevisionId: string): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:read");
    return safe({ fromRevisionId, toRevisionId, diff: boundDiff(await this.#repository.compare(repositoryContext, fromRevisionId, toRevisionId)) });
  }

  public async preparePreview(context: McpRequestContext, revisionId: string): Promise<PreviewPreparation> {
    const repositoryContext = await this.requireSite(context, "content:read");
    const revision = await this.#repository.getRevision(repositoryContext, revisionId);
    return safe({
      status: "ready-for-workflow",
      revisionId: revision.id,
      sourceHash: revision.sourceHash,
      workflow: await this.#repository.workflowFor(repositoryContext, revision.id),
      previewUrl: null,
      nextStep: "enqueue-protected-preview",
      note: "Sprint 5 only binds the immutable revision. Protected preview execution and URLs arrive in Sprint 7."
    });
  }

  private async requireSite(context: McpRequestContext, permission: "content:read" | "content:draft"): Promise<RepositoryContext> {
    requirePermission(context.authorization, permission, {
      tenantId: context.authorization.tenantId,
      siteId: context.authorization.siteId
    });
    const site = await this.#repository.getSite({
      tenantId: context.authorization.tenantId,
      siteId: context.authorization.siteId,
      principalId: context.authorization.principal.id
    });
    if (!site) throw new McpEditingError("SITE_NOT_REGISTERED", "Authorized site is not registered");
    return Object.freeze({ site, principalId: context.authorization.principal.id });
  }

  private async idempotent<T>(
    scope: { readonly tenantId: string; readonly siteId: string; readonly principalId: string },
    operation: string,
    key: string,
    input: unknown,
    create: () => Promise<T>
  ): Promise<T> {
    const fingerprint = inputFingerprint(input);
    let reservation: IdempotencyReservation<T>;
    try {
      reservation = await this.#idempotency.reserve<T>(scope, operation, key, fingerprint);
    } catch (error) {
      if (error instanceof Error && error.message === "IDEMPOTENCY_KEY_REUSED") {
        throw new McpEditingError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with different input");
      }
      throw error;
    }
    if (reservation.status === "completed") return reservation.value as T;
    if (reservation.status !== "reserved") {
      throw new McpEditingError("IDEMPOTENCY_INCOMPLETE", "A previous attempt is pending or requires reconciliation");
    }
    try {
      const value = await create();
      await this.#idempotency.complete(scope, operation, key, fingerprint, value);
      return value;
    } catch (error) {
      const errorCode = error instanceof McpEditingError || (error !== null && typeof error === "object" && "code" in error)
        ? String((error as { code: unknown }).code)
        : "REQUEST_FAILED";
      try {
        await this.#idempotency.fail(scope, operation, key, fingerprint, errorCode);
      } catch {
        // Preserve the original failure; an incomplete reservation fails closed on retry.
      }
      throw error;
    }
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
