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
import { MCP_LIMITS, type McpRequestContext, type PreviewPreparation } from "./model.js";
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

/** Internal runtime boundary; it is never registered in MCP tool discovery. */
export interface StagingAstroOperations {
  prepare(context: McpRequestContext, site: RepositoryContext["site"], revision: ContentRevision): Promise<AstroRenderInput>;
  persistPreviewInput(context: McpRequestContext, repository: RepositoryContext, release: StoredRelease, render: AstroRenderInput): Promise<void>;
  ensureArtifact(context: McpRequestContext, repository: RepositoryContext, release: StoredRelease): Promise<void>;
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
        correlationId: revision.documentId
      });
      if (stagingRender) await this.#stagingAstro!.persistPreviewInput(context, repositoryContext, release, stagingRender);
      await this.appendEvent(context, "io.navocms.release.preview.created.v1", release.id, idempotencyKey, {
        phase: "verified",
        releaseId: release.id,
        releaseHash,
        artifactHash: artifact.hash,
        revisionId: revision.id,
        expiresAt
      }, "G1", release.correlationId);
      return safe({
        status: "previewed",
        releaseId: release.id,
        releaseHash,
        revisionId: revision.id,
        sourceHash: revision.sourceHash,
        artifactHash: artifact.hash,
        workflow,
        previewUrl: `${this.#releaseConfig.previewBaseUrl}/previews/${token}`,
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
      const release = await this.#releases.approve(repositoryContext, input.releaseId, input.releaseHash,
        this.approvalFor(context, repositoryContext, candidate.environmentId));
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
        if (!valid) throw new McpEditingError("LIVE_VERIFICATION_FAILED", "Provider still does not expose the previewed artifact");
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

  private async applyAndVerify(context: McpRequestContext, repositoryContext: RepositoryContext, releaseId: string, releaseHash: string): Promise<PublicationRecord> {
    const candidate = await this.#releases.getRelease(repositoryContext, releaseId);
    if (candidate.releaseHash !== releaseHash) throw new McpEditingError("STALE_RELEASE_APPROVAL", "Release hash does not match the previewed candidate");
    // The trusted local build is completed before release state moves to
    // publishing or the external provider receives any coordinates.
    if (this.#stagingAstro) await this.#stagingAstro.ensureArtifact(context, repositoryContext, candidate);
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
      throw new McpEditingError("LIVE_VERIFICATION_FAILED", "Provider did not expose the previewed artifact hash");
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
    await this.#policyGuard?.consume({ ...scope, operation, idempotencyKey: key });
    // Provider calls cross an external trust boundary. Their durable prepare
    // state must commit before an effect, so they cannot share an outer SQL
    // transaction that would roll it back when the provider crashes.
    if (this.#database && transactional) return this.#database.withScope(scope, () => this.idempotentInTransaction(scope, operation, key, input, create));
    return this.idempotentInTransaction(scope, operation, key, input, create);
  }

  private async idempotentInTransaction<T>(
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

  private approvalFor(context: McpRequestContext, repositoryContext: RepositoryContext, environmentId: string): ReleaseApprovalInput {
    return Object.freeze({
      policyVersion: this.#releaseConfig.approvalPolicyVersion,
      // Keep verifiable, non-secret evidence; the OIDC subject itself remains in the identity store.
      evidence: Object.freeze({ actorReferenceHash: sha256(`${context.authorization.principal.issuer}|${context.authorization.principal.subject}`), channel: "authenticated-mcp" }),
      expiresAt: new Date(Date.now() + this.#releaseConfig.approvalTtlSeconds * 1000).toISOString(),
      actorKind: "human",
      scope: Object.freeze({
        tenantId: repositoryContext.site.tenantId,
        siteId: repositoryContext.site.siteId,
        environmentId
      })
    });
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
