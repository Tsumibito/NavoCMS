import { randomBytes, randomUUID } from "node:crypto";

import type { StructuralPatchOperation } from "@navocms/content";
import {
  createReleaseManifest,
  DomainEventFactory,
  InMemoryEventStore,
  renderMarkdownProofArtifact,
  sha256,
  type EventStore,
  type ReleaseProvider
} from "@navocms/kernel";
import { assertSafeProjection, requirePermission } from "@navocms/security";
import type { PostgresDatabase } from "@navocms/persistence-postgres";

import { McpEditingError } from "./errors.js";
import { MCP_LIMITS, type ConfirmationStatus, type McpRequestContext, type PreviewBuildStatus, type PreviewPreparation } from "./model.js";
import {
  EmbeddedReleaseProvider,
  InMemoryReleaseWorkflowRepository,
  type PublicationRecord,
  type ReleaseApprovalInput,
  type ReleaseWorkflowRepository,
  type StoredRelease
} from "./release-repository.js";
import { inputFingerprint, type EditingRepository, type RepositoryContext } from "./repository.js";
import type { AstroRenderInput } from "@navocms/design-astro";
import type { ContentRevision } from "@navocms/content";

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

export interface RuntimePolicyGuard {
  consume(request: {
    readonly tenantId: string;
    readonly siteId: string;
    readonly principalId: string;
    readonly operation: string;
    readonly idempotencyKey: string;
  }): Promise<void>;
}

/** Browser preview surface for one capability token. */
export interface PreviewSurface {
  readonly releaseId: string;
  readonly releaseHash: string;
  readonly artifactHash: string;
  readonly expiresAt: string;
  readonly proof: Readonly<{ mediaType: string; body: string }>;
  readonly built?: Readonly<{ output: Readonly<Record<string, string>>; outputManifestDigest: string; sourceCommitSha: string; fileCount: number; totalBytes: number }>;
}

/** Read-only model for the confirmation page. */
export interface ConfirmationView {
  readonly releaseId: string;
  readonly releaseHash: string;
  readonly policyVersion: string;
  readonly previewExpiresAt?: string;
  readonly decisionAt?: string;
  readonly receiptHash?: string;
  readonly receiptExpiresAt?: string;
  readonly revokedAt?: string;
  readonly build: Readonly<{ ready: boolean; outputManifestDigest?: string; fileCount?: number; totalBytes?: number }>;
}

export interface RecordedConfirmation {
  readonly recorded: boolean;
  readonly receiptHash: string;
  readonly decidedAt: string;
  readonly receiptExpiresAt: string;
  readonly outputManifestDigest: string;
}

/** Summary of one registered reviewed artifact, hash-bearing only. */
export interface ReviewedArtifactSummary {
  readonly outputManifestDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly sourceCommitSha: string;
}

/** Internal runtime boundary; it is never registered in MCP tool discovery. */
export interface StagingAstroOperations {
  prepare(context: McpRequestContext, site: RepositoryContext["site"], revision: ContentRevision): Promise<AstroRenderInput>;
  persistPreviewInput(context: McpRequestContext, repository: RepositoryContext, release: StoredRelease, render: AstroRenderInput): Promise<void>;
  /** Starts or resumes the durable pre-review build job; never runs inside a request effect. */
  startBuild(repository: RepositoryContext, release: StoredRelease): Promise<PreviewBuildStatus>;
  buildStatus(repository: RepositoryContext, releaseId: string): Promise<PreviewBuildStatus>;
  artifactSummary(repository: RepositoryContext, releaseId: string): Promise<ReviewedArtifactSummary | undefined>;
  /** Scope-explicit read used by the preview/confirmation browser surfaces. */
  artifactFor(scope: Readonly<{ tenantId: string; siteId: string; releaseId: string }>): Promise<Readonly<{ output: Readonly<Record<string, string>> } & ReviewedArtifactSummary> | undefined>;
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
  readonly #releases: ReleaseWorkflowRepository;
  readonly #releaseProvider: ReleaseProvider;
  readonly #database: Pick<PostgresDatabase, "withScope"> | undefined;
  readonly #policyGuard: RuntimePolicyGuard | undefined;
  readonly #stagingAstro: StagingAstroOperations | undefined;
  readonly #releaseConfig: Readonly<{
    environmentKey: string;
    previewBaseUrl: string;
    previewTtlSeconds: number;
    approvalTtlSeconds: number;
    approvalPolicyVersion: string;
  }>;

  public constructor(
    repository: EditingRepository,
    events: EventStore = new InMemoryEventStore(),
    idempotency: IdempotencyStore = new InMemoryIdempotencyStore(),
    releases: ReleaseWorkflowRepository = new InMemoryReleaseWorkflowRepository(),
    releaseProvider: ReleaseProvider = new EmbeddedReleaseProvider(),
    releaseConfig: {
      readonly environmentKey?: string;
      readonly previewBaseUrl?: string;
      readonly previewTtlSeconds?: number;
      readonly approvalTtlSeconds?: number;
      readonly approvalPolicyVersion?: string;
    } = {},
    database?: Pick<PostgresDatabase, "withScope">,
    policyGuard?: RuntimePolicyGuard,
    stagingAstro?: StagingAstroOperations
  ) {
    this.#repository = repository;
    this.#events = events;
    this.#idempotency = idempotency;
    this.#releases = releases;
    this.#releaseProvider = releaseProvider;
    this.#database = database;
    this.#policyGuard = policyGuard;
    this.#stagingAstro = stagingAstro;
    this.#releaseConfig = Object.freeze({
      environmentKey: releaseConfig.environmentKey ?? "development",
      previewBaseUrl: (releaseConfig.previewBaseUrl ?? "https://preview.example.test").replace(/\/$/, ""),
      previewTtlSeconds: releaseConfig.previewTtlSeconds ?? 3600,
      approvalTtlSeconds: releaseConfig.approvalTtlSeconds ?? 900,
      approvalPolicyVersion: releaseConfig.approvalPolicyVersion ?? "navocms.release-approval.v1"
    });
  }

  /** Safe composition proof; no provider implementation detail or secret is exposed. */
  public releaseProviderKey(): string { return this.#releaseProvider.key; }

  public async listSites(context: McpRequestContext): Promise<readonly object[]> {
    const { site } = await this.requireSite(context, "content:read");
    return Object.freeze([safe({
      siteId: site.siteId,
      name: site.name,
      primaryLocale: site.primaryLocale,
      locales: site.locales
    })]);
  }

  public async search(context: McpRequestContext, query: string, options: { readonly limit?: number; readonly cursor?: string } = {}): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:read");
    const limit = boundedLimit(options.limit);
    assertPageCursor(options.cursor);
    const page = await this.#repository.search(repositoryContext, query, limit, options.cursor);
    return safe({
      query,
      results: page.items,
      count: page.items.length,
      limit,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
    });
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
    const astTotalNodes = revision.ast.nodes.length;
    const astTruncated = astTotalNodes > MCP_LIMITS.maxAstNodes;
    const metadataProjection = boundedMetadataProjection(revision.metadata);
    return safe({
      revisionId: revision.id,
      documentId: revision.documentId,
      variantId: revision.variantId,
      revisionNumber: revision.number,
      sourceHash: revision.sourceHash,
      // The metadata projection never duplicates the Markdown `body` mirror and
      // stays inside its own serialized-character budget; omitted fields stay
      // reachable through `content_read` windows on the immutable revision.
      metadata: metadataProjection.metadata,
      metadataTruncated: metadataProjection.truncated,
      metadataTotalCharacters: metadataProjection.totalCharacters,
      ...(metadataProjection.omittedKeys.length > 0 ? { metadataOmittedKeys: metadataProjection.omittedKeys } : {}),
      markdown: truncated ? revision.source.slice(0, MCP_LIMITS.maxMarkdownCharacters) : revision.source,
      truncated,
      totalCharacters: revision.source.length,
      ...(truncated ? { nextOffset: MCP_LIMITS.maxMarkdownCharacters } : {}),
      astNodes: revision.ast.nodes.slice(0, MCP_LIMITS.maxAstNodes).map(({ id, type, parentId, text }) => ({
        id,
        type,
        ...(parentId ? { parentId } : {}),
        text: text.slice(0, MCP_LIMITS.maxExcerptCharacters)
      })),
      truncatedNodes: astTruncated,
      totalNodes: astTotalNodes
    });
  }

  /**
   * Bounded continuation read for content that does not fit into one response.
   * Revisions are immutable, so offset windows and node pages are stable; the
   * full source can always be assembled from consecutive bounded windows.
   */
  public async readContent(context: McpRequestContext, input: {
    readonly revisionId: string;
    readonly markdownOffset?: number;
    readonly markdownLength?: number;
    readonly nodeId?: string;
    readonly metadataKey?: string;
    readonly nodeOffset?: number;
    readonly nodeLimit?: number;
  }): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:read");
    const revision = await this.#repository.getRevision(repositoryContext, input.revisionId);
    if (input.nodeId !== undefined) {
      const node = revision.ast.nodes.find((candidate) => candidate.id === input.nodeId);
      if (!node) throw new McpEditingError("CONTENT_NODE_NOT_FOUND", "The requested AST node does not exist in this revision");
      const truncated = node.text.length > MCP_LIMITS.maxMarkdownCharacters;
      return safe({
        revisionId: revision.id,
        node: {
          id: node.id,
          type: node.type,
          ...(node.parentId ? { parentId: node.parentId } : {}),
          text: node.text.slice(0, MCP_LIMITS.maxMarkdownCharacters)
        },
        truncated,
        totalCharacters: node.text.length
      });
    }
    if (input.metadataKey !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(revision.metadata, input.metadataKey)) {
        throw new McpEditingError("METADATA_KEY_NOT_FOUND", "The requested metadata key does not exist in this revision");
      }
      const serialized = JSON.stringify(revision.metadata[input.metadataKey]) ?? "null";
      return boundedWindow(revision.id, serialized, input.markdownOffset, input.markdownLength, "text", input.metadataKey);
    }
    if (input.nodeOffset !== undefined || input.nodeLimit !== undefined) {
      const offset = Math.max(0, Math.floor(input.nodeOffset ?? 0));
      const limit = Math.min(Math.max(1, Math.floor(input.nodeLimit ?? MCP_LIMITS.maxAstNodes)), MCP_LIMITS.maxAstNodes);
      const totalNodes = revision.ast.nodes.length;
      const nodes = revision.ast.nodes.slice(offset, offset + limit).map(({ id, type, parentId, text }) => ({
        id,
        type,
        ...(parentId ? { parentId } : {}),
        text: text.slice(0, MCP_LIMITS.maxExcerptCharacters)
      }));
      const nextOffset = offset + nodes.length;
      return safe({
        revisionId: revision.id,
        nodes,
        offset,
        totalNodes,
        ...(nextOffset < totalNodes ? { nextOffset, truncatedNodes: true } : {})
      });
    }
    return boundedWindow(revision.id, revision.source, input.markdownOffset, input.markdownLength, "markdown");
  }

  public async listDrafts(context: McpRequestContext, options: { readonly limit?: number; readonly cursor?: string } = {}): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:read");
    const limit = boundedLimit(options.limit);
    assertPageCursor(options.cursor);
    const page = await this.#repository.listDrafts(repositoryContext, limit, options.cursor);
    return safe({
      drafts: page.items,
      count: page.items.length,
      limit,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
    });
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
      }, "G1", draft.id);
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
      }, "G1", result.draft.id);
      return safe({ draft: result.draft, diff: boundDiff(result.diff) });
    });
  }

  public async compare(context: McpRequestContext, fromRevisionId: string, toRevisionId: string): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:read");
    return safe({ fromRevisionId, toRevisionId, diff: boundDiff(await this.#repository.compare(repositoryContext, fromRevisionId, toRevisionId)) });
  }

  public async preparePreview(context: McpRequestContext, revisionId: string, idempotencyKey: string): Promise<PreviewPreparation> {
    const repositoryContext = await this.requireSite(context, "content:draft");
    return this.idempotent({
      tenantId: repositoryContext.site.tenantId,
      siteId: repositoryContext.site.siteId,
      principalId: context.authorization.principal.id
    }, "preview_create", idempotencyKey, { revisionId }, async () => {
      const revision = await this.#repository.getRevision(repositoryContext, revisionId);
      const workflow = await this.#repository.workflowFor(repositoryContext, revision.id);
      const environmentId = await this.#releases.environmentId(repositoryContext, this.#releaseConfig.environmentKey);
      const stagingRender = this.#stagingAstro ? await this.#stagingAstro.prepare(context, repositoryContext.site, revision) : undefined;
      const { manifest, releaseHash } = createReleaseManifest({
        tenantId: repositoryContext.site.tenantId,
        siteId: repositoryContext.site.siteId,
        environmentId,
        revisionId: revision.id,
        sourceHash: revision.sourceHash,
        workflow,
        ...(stagingRender ? { anchors: Object.fromEntries(Object.entries(stagingRender.anchors).map(([key, value]) => [key, value.slice("sha256:".length)])) } : {})
      });
      const title = typeof revision.metadata.title === "string" ? revision.metadata.title
        : typeof revision.metadata.name === "string" ? revision.metadata.name : "Untitled";
      const locale = typeof revision.metadata.locale === "string" ? revision.metadata.locale : repositoryContext.site.primaryLocale;
      const artifact = renderMarkdownProofArtifact({ releaseHash, title, locale, markdown: revision.source });
      const token = randomBytes(32).toString("base64url");
      const confirmationToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + this.#releaseConfig.previewTtlSeconds * 1000).toISOString();
      const release = await this.#releases.createPreview({
        context: repositoryContext,
        environmentKey: this.#releaseConfig.environmentKey,
        revisionId: revision.id,
        workflow,
        manifest,
        releaseHash,
        artifact,
        previewTokenHash: sha256(token),
        previewExpiresAt: expiresAt,
        confirmationTokenHash: sha256(confirmationToken),
        confirmationPolicyVersion: this.#releaseConfig.approvalPolicyVersion,
        correlationId: revision.documentId
      });
      if (stagingRender) {
        await this.#stagingAstro!.persistPreviewInput(context, repositoryContext, release, stagingRender);
        // The trusted build runs before review, outside this request, under the
        // service principal; its durable job survives disconnects and restarts.
        await this.#stagingAstro!.startBuild(repositoryContext, release);
      }
      await this.appendEvent(context, "io.navocms.release.preview.created.v1", release.id, idempotencyKey, {
        phase: "verified",
        releaseId: release.id,
        releaseHash,
        artifactHash: artifact.hash,
        revisionId: revision.id,
        expiresAt
      }, "G1", release.correlationId);
      const build = this.#stagingAstro
        ? await this.#stagingAstro.buildStatus(repositoryContext, release.id)
        : Object.freeze({ releaseId: release.id, status: "unsupported" as const });
      return safe({
        status: "previewed",
        releaseId: release.id,
        releaseHash,
        revisionId: revision.id,
        sourceHash: revision.sourceHash,
        artifactHash: artifact.hash,
        workflow,
        previewUrl: `${this.#releaseConfig.previewBaseUrl}/previews/${token}`,
        confirmationUrl: `${this.#releaseConfig.previewBaseUrl}/confirmations/${confirmationToken}`,
        build,
        expiresAt,
        nextStep: "approve-exact-release"
      });
    });
  }

  public async releaseStatus(context: McpRequestContext, releaseId: string): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:read");
    return safe({ release: releaseProjection(await this.#releases.getRelease(repositoryContext, releaseId)) });
  }

  public async approveRelease(context: McpRequestContext, input: {
    readonly releaseId: string;
    readonly releaseHash: string;
    readonly idempotencyKey: string;
  }): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:publish");
    if (context.authorization.principal.kind !== "human") {
      throw new McpEditingError("HUMAN_APPROVAL_REQUIRED", "Only a human publisher can approve a release");
    }
    return this.idempotent({ ...scope(repositoryContext), principalId: context.authorization.principal.id }, "release_approve", input.idempotencyKey, input, async () => {
      const candidate = await this.#releases.getRelease(repositoryContext, input.releaseId);
      // The MCP bearer alone — even with a human subject — is never the
      // decision. A built release must carry an independent browser receipt
      // whose output manifest digest still matches the registered artifact.
      let confirmation: Readonly<{ receiptHash: string; outputManifestDigest: string }> | undefined;
      if (this.#stagingAstro) {
        const summary = await this.#stagingAstro.artifactSummary(repositoryContext, candidate.id);
        if (!summary) throw new McpEditingError("REVIEWED_ASTRO_ARTIFACT_NOT_BUILT", "The trusted build for this release has not completed");
        const receipt = await this.#releases.latestConfirmation(repositoryContext, candidate.id, input.releaseHash);
        if (!receipt?.decisionAt || !receipt.outputManifestDigest || !receipt.receiptHash || !receipt.receiptExpiresAt || receipt.revokedAt) {
          throw new McpEditingError("HUMAN_CONFIRMATION_REQUIRED", "An independent human confirmation receipt is required for this release");
        }
        if (new Date(receipt.receiptExpiresAt).getTime() <= Date.now()) {
          throw new McpEditingError("HUMAN_CONFIRMATION_EXPIRED", "The human confirmation receipt has expired; prepare a fresh preview and confirm again");
        }
        if (receipt.outputManifestDigest !== summary.outputManifestDigest) {
          throw new McpEditingError("RELEASE_DECISION_STALE", "The recorded confirmation does not match the registered build output");
        }
        confirmation = Object.freeze({ receiptHash: receipt.receiptHash, outputManifestDigest: receipt.outputManifestDigest });
      }
      const release = await this.#releases.approve(repositoryContext, input.releaseId, input.releaseHash,
        this.approvalFor(context, repositoryContext, candidate.environmentId, confirmation));
      await this.appendEvent(context, "io.navocms.release.approved.v1", release.id, input.idempotencyKey, {
        phase: "applied", releaseId: release.id, releaseHash: release.releaseHash, artifactHash: release.artifactHash
      }, "G1", release.correlationId);
      return safe({ release: releaseProjection(release), nextStep: "publish-exact-release" });
    });
  }

  public async publishRelease(context: McpRequestContext, input: {
    readonly releaseId: string;
    readonly releaseHash: string;
    readonly idempotencyKey: string;
  }): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:publish");
    return this.idempotent({ ...scope(repositoryContext), principalId: context.authorization.principal.id }, "release_publish", input.idempotencyKey, input, async () => {
      const publication = await this.applyAndVerify(context, repositoryContext, input.releaseId, input.releaseHash);
      await this.appendEvent(context, "io.navocms.release.published.v1", input.releaseId, input.idempotencyKey, {
        phase: "verified", releaseId: input.releaseId, releaseHash: input.releaseHash,
        artifactHash: publication.artifactHash, providerKey: publication.providerKey
      }, "G2", (await this.#releases.getRelease(repositoryContext, input.releaseId)).correlationId);
      return safe({ release: releaseProjection(await this.#releases.getRelease(repositoryContext, input.releaseId)), publication });
    }, false);
  }

  public async reconcileRelease(context: McpRequestContext, input: {
    readonly releaseId: string;
    readonly releaseHash: string;
    readonly idempotencyKey: string;
  }): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:publish");
    return this.idempotent({ ...scope(repositoryContext), principalId: context.authorization.principal.id }, "release_reconcile", input.idempotencyKey, input, async () => {
      const state = await this.#releases.reconcile(repositoryContext, input.releaseId);
      if (state.release.releaseHash !== input.releaseHash) throw new McpEditingError("STALE_RELEASE_APPROVAL", "Release hash does not match the previewed candidate");
      let publication = state.publication;
      if (state.rollback) {
        await this.#releaseProvider.rollback(state.rollback.current, state.rollback.target);
        await this.#releases.completeRollback(repositoryContext, input.releaseId, state.rollback.current.id, state.rollback.target.id);
        publication = state.rollback.target;
      } else if ((state.release.status === "approved" || state.release.status === "publishing") && !publication) {
        publication = await this.applyAndVerify(context, repositoryContext, input.releaseId, input.releaseHash);
      } else if (publication && (
        (state.release.status === "publishing" && publication.status === "applied") ||
        state.release.status === "verification_failed" || publication.status === "verification_failed"
      )) {
        const valid = await this.#releaseProvider.verify(publication);
        if (!valid) throw new McpEditingError("LIVE_VERIFICATION_FAILED", "Provider still does not expose the previewed artifact", {
          effectState: "applied",
          nextAction: "release_reconcile"
        });
        await this.#releases.markVerified(repositoryContext, input.releaseId, publication.id);
      }
      const release = await this.#releases.getRelease(repositoryContext, input.releaseId);
      await this.appendEvent(context, "io.navocms.release.reconciled.v1", release.id, input.idempotencyKey, {
        phase: state.rollback ? "rolled_back" : "verified", releaseId: release.id, releaseHash: release.releaseHash, status: release.status
      }, "G1", release.correlationId);
      return safe({ release: releaseProjection(release), ...(publication ? { publication } : {}) });
    }, false);
  }

  public async rollbackRelease(context: McpRequestContext, input: {
    readonly releaseId: string;
    readonly releaseHash: string;
    readonly idempotencyKey: string;
  }): Promise<object> {
    const repositoryContext = await this.requireSite(context, "content:publish");
    return this.idempotent({ ...scope(repositoryContext), principalId: context.authorization.principal.id }, "release_rollback", input.idempotencyKey, input, async () => {
      const prepared = await this.#releases.rollback(repositoryContext, input.releaseId, input.releaseHash);
      await this.#releaseProvider.rollback(prepared.current, prepared.target);
      const release = await this.#releases.completeRollback(repositoryContext, input.releaseId, prepared.current.id, prepared.target.id);
      await this.appendEvent(context, "io.navocms.release.rolled-back.v1", release.id, input.idempotencyKey, {
        phase: "verified", releaseId: release.id, releaseHash: release.releaseHash,
        restoredPublicationId: prepared.target.id, restoredArtifactHash: prepared.target.artifactHash
      }, "G1", release.correlationId);
      return safe({ release: releaseProjection(release), restoredPublication: prepared.target });
    }, false);
  }

  public async resolvePreview(token: string): Promise<{ readonly mediaType: string; readonly body: string } | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const preview = await this.#releases.resolvePreview(sha256(token));
    return preview ? Object.freeze({ mediaType: preview.mediaType, body: preview.body }) : undefined;
  }

  /**
   * Browser preview surface for one capability token. While the trusted build
   * is running this is the Markdown proof artifact; once the reviewed output
   * is registered, `built` carries the exact immutable files that publication
   * promotes. Never a production publication and never indexable.
   */
  public async resolvePreviewSurface(token: string): Promise<PreviewSurface | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const preview = await this.#releases.resolvePreview(sha256(token));
    if (!preview) return undefined;
    let built: PreviewSurface["built"];
    if (this.#stagingAstro) {
      const artifact = await this.#stagingAstro.artifactFor({
        tenantId: preview.tenantId, siteId: preview.siteId, releaseId: preview.releaseId
      });
      if (artifact) {
        built = Object.freeze({
          output: artifact.output,
          outputManifestDigest: artifact.outputManifestDigest,
          sourceCommitSha: artifact.sourceCommitSha,
          fileCount: artifact.fileCount,
          totalBytes: artifact.totalBytes
        });
      }
    }
    return Object.freeze({
      releaseId: preview.releaseId,
      releaseHash: preview.releaseHash,
      artifactHash: preview.artifactHash,
      expiresAt: preview.expiresAt,
      proof: Object.freeze({ mediaType: preview.mediaType, body: preview.body }),
      ...(built ? { built } : {})
    });
  }

  public async releaseBuildStatus(context: McpRequestContext, releaseId: string): Promise<PreviewBuildStatus> {
    const repositoryContext = await this.requireSite(context, "content:read");
    if (!this.#stagingAstro) return Object.freeze({ releaseId, status: "unsupported" });
    return this.#stagingAstro.buildStatus(repositoryContext, releaseId);
  }

  public async releaseConfirmationStatus(context: McpRequestContext, input: {
    readonly releaseId: string;
    readonly releaseHash: string;
  }): Promise<ConfirmationStatus> {
    const repositoryContext = await this.requireSite(context, "content:read");
    const release = await this.#releases.getRelease(repositoryContext, input.releaseId);
    if (release.releaseHash !== input.releaseHash) {
      throw new McpEditingError("STALE_RELEASE_APPROVAL", "Release hash does not match the previewed candidate");
    }
    const confirmation = await this.#releases.latestConfirmation(repositoryContext, input.releaseId, input.releaseHash);
    if (!confirmation) {
      return Object.freeze({ releaseId: input.releaseId, releaseHash: input.releaseHash, status: "pending", policyVersion: this.#releaseConfig.approvalPolicyVersion });
    }
    const status: ConfirmationStatus["status"] = confirmation.revokedAt ? "revoked"
      : !confirmation.decisionAt ? "pending"
        : new Date(confirmation.receiptExpiresAt ?? 0).getTime() <= Date.now() ? "expired" : "confirmed";
    return Object.freeze({
      releaseId: input.releaseId,
      releaseHash: input.releaseHash,
      status,
      policyVersion: confirmation.policyVersion,
      ...(confirmation.decisionAt ? { decidedAt: confirmation.decisionAt } : {}),
      ...(confirmation.receiptHash ? { receiptHash: confirmation.receiptHash } : {}),
      ...(confirmation.outputManifestDigest ? { outputManifestDigest: confirmation.outputManifestDigest } : {}),
      ...(confirmation.receiptExpiresAt ? { receiptExpiresAt: confirmation.receiptExpiresAt } : {})
    });
  }

  /** Read-only summary the confirmation page renders; resolved by capability only. */
  public async resolveConfirmationView(token: string): Promise<ConfirmationView | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const confirmation = await this.#releases.resolveConfirmation(sha256(token));
    if (!confirmation) return undefined;
    const artifact = this.#stagingAstro
      ? await this.#stagingAstro.artifactFor({ tenantId: confirmation.tenantId, siteId: confirmation.siteId, releaseId: confirmation.releaseId })
      : undefined;
    return Object.freeze({
      releaseId: confirmation.releaseId,
      releaseHash: confirmation.releaseHash,
      policyVersion: confirmation.policyVersion,
      ...(confirmation.previewExpiresAt ? { previewExpiresAt: confirmation.previewExpiresAt } : {}),
      ...(confirmation.decisionAt ? { decisionAt: confirmation.decisionAt } : {}),
      ...(confirmation.receiptHash ? { receiptHash: confirmation.receiptHash } : {}),
      ...(confirmation.receiptExpiresAt ? { receiptExpiresAt: confirmation.receiptExpiresAt } : {}),
      ...(confirmation.revokedAt ? { revokedAt: confirmation.revokedAt } : {}),
      build: Object.freeze({
        ready: artifact !== undefined,
        ...(artifact ? {
          outputManifestDigest: artifact.outputManifestDigest,
          fileCount: artifact.fileCount,
          totalBytes: artifact.totalBytes
        } : {})
      })
    });
  }

  /**
   * Records the human decision from the independent browser session. The
   * output manifest digest is computed server-side from the registered
   * artifact; the browser request carries no trust-bearing values. Repeated
   * delivery of an already-recorded decision is a safe no-op.
   */
  public async recordConfirmationDecision(token: string): Promise<RecordedConfirmation | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const tokenHash = sha256(token);
    const confirmation = await this.#releases.resolveConfirmation(tokenHash);
    if (!confirmation) return undefined;
    if (confirmation.revokedAt) throw new McpEditingError("RELEASE_CONFIRMATION_REVOKED", "This confirmation has been revoked");
    if (confirmation.decisionAt) {
      return Object.freeze({
        recorded: false,
        receiptHash: confirmation.receiptHash!,
        decidedAt: confirmation.decisionAt,
        receiptExpiresAt: confirmation.receiptExpiresAt!,
        outputManifestDigest: confirmation.outputManifestDigest!
      });
    }
    if (!this.#stagingAstro) throw new McpEditingError("REVIEWED_ASTRO_ARTIFACT_NOT_BUILT", "No staging runtime is configured for this release");
    if (!confirmation.previewExpiresAt) throw new McpEditingError("RELEASE_CONFIRMATION_EXPIRED", "This confirmation link is no longer valid");
    const artifact = await this.#stagingAstro.artifactFor({
      tenantId: confirmation.tenantId, siteId: confirmation.siteId, releaseId: confirmation.releaseId
    });
    if (!artifact) throw new McpEditingError("REVIEWED_ASTRO_ARTIFACT_NOT_BUILT", "The trusted build for this release has not completed yet; ask the agent for the build status");
    const decidedAt = new Date().toISOString();
    const receiptExpiresAt = new Date(Math.min(
      new Date(confirmation.previewExpiresAt).getTime(),
      Date.now() + this.#releaseConfig.approvalTtlSeconds * 1000
    )).toISOString();
    const receiptHash = `sha256:${sha256(inputFingerprint({
      releaseId: confirmation.releaseId,
      releaseHash: confirmation.releaseHash,
      outputManifestDigest: artifact.outputManifestDigest,
      policyVersion: confirmation.policyVersion,
      decidedAt,
      receiptExpiresAt
    }))}`;
    const result = await this.#releases.recordConfirmation(tokenHash, {
      decidedAt,
      outputManifestDigest: artifact.outputManifestDigest,
      receiptHash,
      receiptExpiresAt
    });
    if (!result) throw new McpEditingError("RELEASE_CONFIRMATION_EXPIRED", "This confirmation link is no longer valid");
    if (result.recorded) {
      const factory = new DomainEventFactory({
        source: "urn:navocms:mcp",
        tenantId: confirmation.tenantId,
        siteId: confirmation.siteId,
        correlationId: confirmation.releaseId,
        // The receipt records the decision, not an identity: the bearer of the
        // confirmation capability acted in an independent browser session.
        actor: { type: "human", id: "independent-browser-session" }
      });
      await this.#events.append(factory.create({
        type: "io.navocms.release.human-confirmed.v1",
        subject: `release:${confirmation.releaseId}`,
        consequence: "G1",
        idempotencyKey: `release_confirm:${receiptHash}`,
        data: Object.freeze({
          releaseId: confirmation.releaseId,
          releaseHash: confirmation.releaseHash,
          outputManifestDigest: artifact.outputManifestDigest,
          policyVersion: confirmation.policyVersion,
          receiptHash,
          decidedAt,
          receiptExpiresAt
        })
      }));
    }
    return Object.freeze({
      recorded: result.recorded,
      receiptHash,
      decidedAt,
      receiptExpiresAt,
      outputManifestDigest: artifact.outputManifestDigest
    });
  }

  private async applyAndVerify(context: McpRequestContext, repositoryContext: RepositoryContext, releaseId: string, releaseHash: string): Promise<PublicationRecord> {
    const candidate = await this.#releases.getRelease(repositoryContext, releaseId);
    if (candidate.releaseHash !== releaseHash) throw new McpEditingError("STALE_RELEASE_APPROVAL", "Release hash does not match the previewed candidate");
    // Publication promotes the reviewed output; it never builds. When the
    // staging runtime is active the registered artifact must already exist and
    // its output manifest digest must equal the digest bound to the recorded
    // human confirmation — a stale or missing build fails closed here.
    if (this.#stagingAstro) {
      const summary = await this.#stagingAstro.artifactSummary(repositoryContext, releaseId);
      if (!summary) throw new McpEditingError("REVIEWED_ASTRO_ARTIFACT_NOT_BUILT", "The trusted build for this release has not completed; publication never builds");
      const receipt = await this.#releases.latestConfirmation(repositoryContext, releaseId, releaseHash);
      if (!receipt?.outputManifestDigest || receipt.revokedAt) {
        throw new McpEditingError("HUMAN_CONFIRMATION_REQUIRED", "An independent human confirmation receipt is required before publication");
      }
      if (receipt.outputManifestDigest !== summary.outputManifestDigest) {
        throw new McpEditingError("RELEASE_DECISION_STALE", "The recorded confirmation does not match the registered build output");
      }
    }
    const prepared = await this.#releases.beginPublication(repositoryContext, releaseId, releaseHash);
    const applied = await this.#releaseProvider.publish({
      releaseId,
      releaseHash,
      artifact: prepared.release.artifact,
      ...(prepared.previous ? { previousProviderReference: prepared.previous.providerReference } : {})
    });
    const publication = await this.#releases.completePublication(repositoryContext, releaseId, applied);
    const valid = await this.#releaseProvider.verify(publication);
    if (!valid) {
      await this.#releases.markVerificationFailed(repositoryContext, releaseId, publication.id);
      // The provider already applied the artifact; the durable state is
      // verification-failed. Clients must reconcile, not repeat the effect.
      throw new McpEditingError("LIVE_VERIFICATION_FAILED", "Provider did not expose the previewed artifact hash", {
        effectState: "applied",
        nextAction: "release_reconcile"
      });
    }
    await this.#releases.markVerified(repositoryContext, releaseId, publication.id);
    return publication;
  }

  private async requireSite(context: McpRequestContext, permission: "content:read" | "content:draft" | "content:publish"): Promise<RepositoryContext> {
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
    create: () => Promise<T>,
    transactional = true
  ): Promise<T> {
    // Validate the key before any reservation or policy charge so a key that
    // would later fail event-schema validation never reaches an effect.
    assertIdempotencyKey(key);
    await this.#policyGuard?.consume({ ...scope, operation, idempotencyKey: key });
    // Provider calls cross an external trust boundary. Their durable prepare
    // state must commit before an effect, so they cannot share an outer SQL
    // transaction that would roll it back when the provider crashes.
    if (this.#database && transactional) return this.#database.withScope(scope, () => this.idempotentInTransaction(scope, operation, key, input, create, transactional));
    return this.idempotentInTransaction(scope, operation, key, input, create, transactional);
  }

  private async idempotentInTransaction<T>(
    scope: { readonly tenantId: string; readonly siteId: string; readonly principalId: string },
    operation: string,
    key: string,
    input: unknown,
    create: () => Promise<T>,
    transactional: boolean
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
      // An incomplete reservation does not prove the first attempt had no
      // effect. A transactional operation rolled back with its effect, but a
      // non-transactional provider operation may already have been applied.
      throw new McpEditingError("IDEMPOTENCY_INCOMPLETE", incompleteReservationMessage(reservation.errorCode, transactional), {
        effectState: transactional ? "none" : "unknown",
        ...(transactional ? {} : { nextAction: "release_reconcile" })
      });
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
    data: Record<string, unknown>,
    consequence: "G1" | "G2" = "G1",
    correlationId?: string
  ): Promise<void> {
    const factory = new DomainEventFactory({
      source: "urn:navocms:mcp",
      tenantId: context.authorization.tenantId,
      siteId: context.authorization.siteId,
      correlationId: correlationId ?? randomUUID(),
      actor: {
        type: context.authorization.principal.kind,
        id: context.authorization.principal.id
      }
    });
    await this.#events.append(factory.create({ type, subject, consequence, idempotencyKey, data }));
  }

  private approvalFor(context: McpRequestContext, repositoryContext: RepositoryContext, environmentId: string, confirmation?: Readonly<{ receiptHash: string; outputManifestDigest: string }>): ReleaseApprovalInput {
    return Object.freeze({
      policyVersion: this.#releaseConfig.approvalPolicyVersion,
      // Keep verifiable, non-secret evidence; the OIDC subject itself remains in the identity store.
      evidence: Object.freeze({
        actorReferenceHash: sha256(`${context.authorization.principal.issuer}|${context.authorization.principal.subject}`),
        channel: "authenticated-mcp",
        ...(confirmation ? {
          confirmationChannel: "browser-confirmation",
          confirmationReceiptHash: confirmation.receiptHash,
          outputManifestDigest: confirmation.outputManifestDigest
        } : {})
      }),
      expiresAt: new Date(Date.now() + this.#releaseConfig.approvalTtlSeconds * 1000).toISOString(),
      actorKind: "human",
      scope: Object.freeze({
        tenantId: repositoryContext.site.tenantId,
        siteId: repositoryContext.site.siteId,
        environmentId
      }),
      ...(confirmation ? { confirmation: Object.freeze(confirmation) } : {})
    });
  }
}

function boundedLimit(limit?: number): number {
  if (limit === undefined) return MCP_LIMITS.defaultSearchResults;
  return Math.max(1, Math.min(Math.floor(limit), MCP_LIMITS.maxSearchResults));
}

function assertPageCursor(cursor: string | undefined): void {
  if (cursor !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor)) {
    throw new McpEditingError("PAGE_CURSOR_INVALID", "The page cursor is not a valid content variant identifier");
  }
}

function assertIdempotencyKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.length < MCP_LIMITS.idempotencyKeyMinLength ||
    key.length > MCP_LIMITS.idempotencyKeyMaxLength
  ) {
    throw new McpEditingError(
      "IDEMPOTENCY_KEY_INVALID",
      `Idempotency key must be ${MCP_LIMITS.idempotencyKeyMinLength}-${MCP_LIMITS.idempotencyKeyMaxLength} characters`
    );
  }
}

/**
 * Explains an incomplete reservation without claiming the first attempt had no
 * effect: only a committed transactional rollback proves that.
 */
function incompleteReservationMessage(previousErrorCode: string | undefined, transactional: boolean): string {
  const recorded = previousErrorCode ? ` (recorded error: ${previousErrorCode})` : "";
  if (transactional) {
    return `A previous attempt with this idempotency key did not complete${recorded}. No content was published because its database transaction did not commit.`;
  }
  return `A previous attempt with this idempotency key did not complete${recorded}. Its external outcome is unknown. Read release_status, then run release_reconcile with the same release hash; the provider treats the release hash as its idempotency key, so reconciliation does not duplicate the effect. Do not reuse the key for new input.`;
}

/**
 * Metadata projection for one read response. The `body` mirror duplicates the
 * Markdown source and is dropped; every remaining field is included whole as
 * long as the cumulative serialized size fits its budget, and larger fields
 * are reported by name instead of being silently cut. Values stay reachable
 * through bounded `content_read` windows on the immutable revision.
 */
function boundedMetadataProjection(metadata: Readonly<Record<string, unknown>>): {
  readonly metadata: Record<string, unknown>;
  readonly truncated: boolean;
  readonly totalCharacters: number;
  readonly omittedKeys: readonly string[];
} {
  const entries = Object.entries(metadata)
    .filter(([key]) => key !== "body")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const projected: Record<string, unknown> = {};
  const omittedKeys: string[] = [];
  let used = 0;
  let total = 0;
  for (const [key, value] of entries) {
    const serialized = JSON.stringify({ [key]: value }) ?? "";
    total += serialized.length;
    if (serialized.length > MCP_LIMITS.maxMetadataCharacters || used + serialized.length > MCP_LIMITS.maxMetadataCharacters) {
      omittedKeys.push(key);
      continue;
    }
    projected[key] = value;
    used += serialized.length;
  }
  return Object.freeze({
    metadata: projected,
    truncated: omittedKeys.length > 0,
    totalCharacters: total,
    omittedKeys: Object.freeze(omittedKeys)
  });
}

/**
 * One bounded slice of an immutable string with explicit totals. `field`
 * selects the payload property name (`markdown` for source windows, `text`
 * for serialized metadata values); the unit is UTF-16 code units.
 */
function boundedWindow(
  revisionId: string,
  source: string,
  rawOffset: number | undefined,
  rawLength: number | undefined,
  field: "markdown" | "text",
  metadataKey?: string
): object {
  const offset = Math.max(0, Math.floor(rawOffset ?? 0));
  const length = Math.min(
    Math.max(1, Math.floor(rawLength ?? MCP_LIMITS.maxMarkdownCharacters)),
    MCP_LIMITS.maxMarkdownCharacters
  );
  const text = source.slice(offset, offset + length);
  const nextOffset = offset + text.length;
  return safe({
    revisionId,
    ...(metadataKey !== undefined ? { metadataKey } : {}),
    totalCharacters: source.length,
    offset,
    [field]: text,
    ...(nextOffset < source.length ? { nextOffset, truncated: true } : { truncated: false })
  });
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

function scope(context: RepositoryContext) {
  return { tenantId: context.site.tenantId, siteId: context.site.siteId };
}

function releaseProjection(release: StoredRelease): object {
  return Object.freeze({
    id: release.id,
    environmentId: release.environmentId,
    revisionId: release.revisionId,
    workflow: release.workflow,
    releaseHash: release.releaseHash,
    artifactHash: release.artifactHash,
    status: release.status,
    createdAt: release.createdAt,
    updatedAt: release.updatedAt,
    ...(release.approvedAt ? { approvedAt: release.approvedAt } : {}),
    ...(release.publishedAt ? { publishedAt: release.publishedAt } : {})
  });
}
