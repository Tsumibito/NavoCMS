import { randomUUID } from "node:crypto";

import {
  releaseTransition,
  type ReleaseArtifact,
  type ReleaseManifestV1,
  type ReleaseProvider,
  type ReleaseProviderPublication,
  type ReleaseStatus
} from "@navocms/kernel";

import { McpEditingError } from "./errors.js";
import type { RepositoryContext } from "./repository.js";

export interface ReleaseSummary {
  readonly id: string;
  readonly environmentId: string;
  readonly revisionId: string;
  readonly workflow: string;
  readonly releaseHash: string;
  readonly artifactHash: string;
  readonly correlationId: string;
  readonly status: ReleaseStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly approvedAt?: string;
  readonly publishedAt?: string;
}

export interface StoredRelease extends ReleaseSummary {
  readonly manifest: ReleaseManifestV1;
  readonly artifact: ReleaseArtifact;
}

export interface PreviewDocument {
  readonly releaseId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly mediaType: string;
  readonly body: string;
  readonly releaseHash: string;
  readonly artifactHash: string;
  readonly expiresAt: string;
}

/** A pending or decided independent human confirmation, resolved by capability hash. */
export interface ConfirmationRecord {
  readonly releaseId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly releaseHash: string;
  readonly policyVersion: string;
  readonly previewExpiresAt?: string;
  readonly decisionAt?: string;
  readonly outputManifestDigest?: string;
  readonly receiptHash?: string;
  readonly receiptExpiresAt?: string;
  readonly revokedAt?: string;
}

export interface ConfirmationDecision {
  readonly decidedAt: string;
  readonly outputManifestDigest: string;
  readonly receiptHash: string;
  readonly receiptExpiresAt: string;
}

export interface PublicationRecord extends ReleaseProviderPublication {
  readonly id: string;
  readonly releaseId: string;
  readonly environmentId: string;
  readonly status: "applied" | "verified" | "verification_failed" | "superseded" | "rolled_back";
  readonly previousPublicationId?: string;
}

export interface CreateReleaseInput {
  readonly context: RepositoryContext;
  readonly environmentKey: string;
  readonly revisionId: string;
  readonly workflow: string;
  readonly manifest: ReleaseManifestV1;
  readonly releaseHash: string;
  readonly artifact: ReleaseArtifact;
  readonly previewTokenHash: string;
  readonly previewExpiresAt: string;
  readonly confirmationTokenHash: string;
  readonly confirmationPolicyVersion: string;
  readonly correlationId: string;
}

export interface ReleaseApprovalInput {
  readonly policyVersion: string;
  readonly evidence: Readonly<Record<string, string>>;
  readonly expiresAt: string;
  readonly actorKind: "human";
  readonly scope: Readonly<{ tenantId: string; siteId: string; environmentId: string }>;
  /** Present when the approval copies an independent confirmation receipt. */
  readonly confirmation?: Readonly<{ receiptHash: string; outputManifestDigest: string }>;
}

export interface ReleaseWorkflowRepository {
  environmentId(context: RepositoryContext, environmentKey: string): Promise<string>;
  createPreview(input: CreateReleaseInput): Promise<StoredRelease>;
  resolvePreview(tokenHash: string): Promise<PreviewDocument | undefined>;
  resolveConfirmation(tokenHash: string): Promise<ConfirmationRecord | undefined>;
  recordConfirmation(tokenHash: string, decision: ConfirmationDecision): Promise<{ readonly record: ConfirmationRecord; readonly recorded: boolean } | undefined>;
  latestConfirmation(context: RepositoryContext, releaseId: string, releaseHash: string): Promise<ConfirmationRecord | undefined>;
  getRelease(context: RepositoryContext, releaseId: string): Promise<StoredRelease>;
  approve(context: RepositoryContext, releaseId: string, releaseHash: string, approval: ReleaseApprovalInput): Promise<StoredRelease>;
  beginPublication(context: RepositoryContext, releaseId: string, releaseHash: string): Promise<{
    readonly release: StoredRelease;
    readonly previous?: PublicationRecord;
  }>;
  completePublication(context: RepositoryContext, releaseId: string, publication: ReleaseProviderPublication): Promise<PublicationRecord>;
  markVerificationFailed(context: RepositoryContext, releaseId: string, publicationId: string): Promise<void>;
  markVerified(context: RepositoryContext, releaseId: string, publicationId: string): Promise<StoredRelease>;
  reconcile(context: RepositoryContext, releaseId: string): Promise<{ readonly release: StoredRelease; readonly publication?: PublicationRecord; readonly rollback?: { readonly current: PublicationRecord; readonly target: PublicationRecord } }>;
  rollback(context: RepositoryContext, releaseId: string, releaseHash: string): Promise<{
    readonly release: StoredRelease;
    readonly current: PublicationRecord;
    readonly target: PublicationRecord;
  }>;
  completeRollback(context: RepositoryContext, releaseId: string, currentPublicationId: string, targetPublicationId: string): Promise<StoredRelease>;
}

interface MutableRelease {
  id: string;
  tenantId: string;
  siteId: string;
  environmentId: string;
  revisionId: string;
  workflow: string;
  releaseHash: string;
  artifactHash: string;
  correlationId: string;
  status: ReleaseStatus;
  manifest: ReleaseManifestV1;
  artifact: ReleaseArtifact;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  publishedAt?: string;
  approval?: ReleaseApprovalInput;
}

export class InMemoryReleaseWorkflowRepository implements ReleaseWorkflowRepository {
  readonly #environmentId: string;
  readonly #releases = new Map<string, MutableRelease>();
  readonly #previews = new Map<string, PreviewDocument>();
  readonly #confirmations = new Map<string, MutableConfirmation>();
  readonly #publications = new Map<string, PublicationRecord>();
  readonly #pendingRollbacks = new Map<string, { readonly current: PublicationRecord; readonly target: PublicationRecord }>();

  public constructor(environmentId = "33333333-3333-4333-8333-333333333333") {
    this.#environmentId = environmentId;
  }

  public async environmentId(): Promise<string> {
    return this.#environmentId;
  }

  public async createPreview(input: CreateReleaseInput): Promise<StoredRelease> {
    const existing = [...this.#releases.values()].find((candidate) =>
      candidate.tenantId === input.context.site.tenantId && candidate.siteId === input.context.site.siteId &&
      candidate.releaseHash === input.releaseHash
    );
    const now = new Date().toISOString();
    const release = existing ?? {
      id: randomUUID(), tenantId: input.context.site.tenantId, siteId: input.context.site.siteId,
      environmentId: this.#environmentId, revisionId: input.revisionId, workflow: input.workflow,
      releaseHash: input.releaseHash, artifactHash: input.artifact.hash, status: "previewed" as const,
      correlationId: input.correlationId,
      manifest: input.manifest, artifact: input.artifact, createdAt: now, updatedAt: now
    };
    this.#releases.set(release.id, release);
    this.#previews.set(input.previewTokenHash, Object.freeze({
      releaseId: release.id,
      tenantId: release.tenantId,
      siteId: release.siteId,
      mediaType: input.artifact.mediaType,
      body: input.artifact.body,
      releaseHash: input.releaseHash,
      artifactHash: input.artifact.hash,
      expiresAt: input.previewExpiresAt
    }));
    this.#confirmations.set(input.confirmationTokenHash, {
      releaseId: release.id, tenantId: release.tenantId, siteId: release.siteId,
      releaseHash: input.releaseHash, policyVersion: input.confirmationPolicyVersion,
      previewExpiresAt: input.previewExpiresAt
    });
    return freezeRelease(release);
  }

  public async resolvePreview(tokenHash: string): Promise<PreviewDocument | undefined> {
    const preview = this.#previews.get(tokenHash);
    if (!preview || new Date(preview.expiresAt).getTime() <= Date.now()) return undefined;
    return preview;
  }

  public async resolveConfirmation(tokenHash: string): Promise<ConfirmationRecord | undefined> {
    const confirmation = this.#confirmations.get(tokenHash);
    if (!confirmation || new Date(confirmation.previewExpiresAt).getTime() <= Date.now()) return undefined;
    return freezeConfirmation(confirmation);
  }

  public async recordConfirmation(tokenHash: string, decision: ConfirmationDecision) {
    const confirmation = this.#confirmations.get(tokenHash);
    if (!confirmation || new Date(confirmation.previewExpiresAt).getTime() <= Date.now()) return undefined;
    if (confirmation.decisionAt) {
      return Object.freeze({ record: freezeConfirmation(confirmation), recorded: false });
    }
    confirmation.decisionAt = decision.decidedAt;
    confirmation.outputManifestDigest = decision.outputManifestDigest;
    confirmation.receiptHash = decision.receiptHash;
    confirmation.receiptExpiresAt = decision.receiptExpiresAt;
    return Object.freeze({ record: freezeConfirmation(confirmation), recorded: true });
  }

  public async latestConfirmation(context: RepositoryContext, releaseId: string, releaseHash: string): Promise<ConfirmationRecord | undefined> {
    const candidates = [...this.#confirmations.values()]
      .filter((confirmation) => confirmation.tenantId === context.site.tenantId &&
        confirmation.siteId === context.site.siteId && confirmation.releaseId === releaseId &&
        confirmation.releaseHash === releaseHash)
      .sort((left, right) => (right.decisionAt ?? right.previewExpiresAt).localeCompare(left.decisionAt ?? left.previewExpiresAt));
    return candidates[0] ? freezeConfirmation(candidates[0]) : undefined;
  }

  public async getRelease(context: RepositoryContext, releaseId: string): Promise<StoredRelease> {
    return freezeRelease(this.requireScoped(context, releaseId));
  }

  public async approve(context: RepositoryContext, releaseId: string, releaseHash: string, approval: ReleaseApprovalInput): Promise<StoredRelease> {
    const release = this.requireExact(context, releaseId, releaseHash);
    this.assertApproval(release, approval);
    if (release.status === "approved") return freezeRelease(release);
    release.status = releaseTransition(release.status, "approved");
    release.approval = approval;
    release.approvedAt = release.updatedAt = new Date().toISOString();
    return freezeRelease(release);
  }

  public async beginPublication(context: RepositoryContext, releaseId: string, releaseHash: string) {
    const release = this.requireExact(context, releaseId, releaseHash);
    if (release.status !== "publishing") {
      if (!release.approval || new Date(release.approval.expiresAt).getTime() <= Date.now()) {
        throw new McpEditingError("RELEASE_APPROVAL_EXPIRED", "A current human approval is required before publication");
      }
      release.status = releaseTransition(release.status, "publishing");
    } else if (!release.approval || release.approval.actorKind !== "human" ||
      release.approval.scope.tenantId !== release.tenantId || release.approval.scope.siteId !== release.siteId ||
      release.approval.scope.environmentId !== release.environmentId) {
      throw new McpEditingError("RELEASE_APPROVAL_CHECKPOINT_INVALID", "Publication approval or its durable validation checkpoint is missing");
    }
    release.updatedAt = new Date().toISOString();
    return Object.freeze({ release: freezeRelease(release), ...this.previousFor(release) });
  }

  public async completePublication(context: RepositoryContext, releaseId: string, publication: ReleaseProviderPublication): Promise<PublicationRecord> {
    const release = this.requireScoped(context, releaseId);
    if (release.artifactHash !== publication.artifactHash) throw new McpEditingError("ARTIFACT_HASH_MISMATCH", "Provider applied an artifact that was not previewed");
    const previous = this.activeFor(release.environmentId);
    if (previous) this.#publications.set(previous.id, Object.freeze({ ...previous, status: "superseded" }));
    const record = Object.freeze({
      id: randomUUID(), releaseId, environmentId: release.environmentId,
      ...publication, status: "applied" as const,
      ...(previous ? { previousPublicationId: previous.id } : {})
    });
    this.#publications.set(record.id, record);
    return record;
  }

  public async markVerificationFailed(context: RepositoryContext, releaseId: string, publicationId: string): Promise<void> {
    const release = this.requireScoped(context, releaseId);
    release.status = releaseTransition(release.status, "verification_failed");
    release.updatedAt = new Date().toISOString();
    const publication = this.requirePublication(publicationId, release);
    this.#publications.set(publicationId, Object.freeze({ ...publication, status: "verification_failed" }));
  }

  public async markVerified(context: RepositoryContext, releaseId: string, publicationId: string): Promise<StoredRelease> {
    const release = this.requireScoped(context, releaseId);
    release.status = releaseTransition(release.status, "published");
    release.publishedAt = release.updatedAt = new Date().toISOString();
    const publication = this.requirePublication(publicationId, release);
    this.#publications.set(publicationId, Object.freeze({ ...publication, status: "verified" }));
    return freezeRelease(release);
  }

  public async reconcile(context: RepositoryContext, releaseId: string) {
    const release = this.requireScoped(context, releaseId);
    const publication = [...this.#publications.values()].find((candidate) => candidate.releaseId === releaseId);
    const rollback = this.#pendingRollbacks.get(releaseId);
    return Object.freeze({ release: freezeRelease(release), ...(publication ? { publication } : {}), ...(rollback ? { rollback } : {}) });
  }

  public async rollback(context: RepositoryContext, releaseId: string, releaseHash: string) {
    const release = this.requireExact(context, releaseId, releaseHash);
    if (release.status !== "published" && release.status !== "verification_failed") {
      throw new McpEditingError("ROLLBACK_NOT_AVAILABLE", "Only an applied release can be rolled back");
    }
    const current = [...this.#publications.values()].find((candidate) =>
      candidate.releaseId === releaseId && ["applied", "verified", "verification_failed"].includes(candidate.status)
    );
    const target = current?.previousPublicationId ? this.#publications.get(current.previousPublicationId) : undefined;
    if (!current || !target) throw new McpEditingError("ROLLBACK_TARGET_MISSING", "No previous verified publication is available");
    const prepared = Object.freeze({ release: freezeRelease(release), current, target });
    this.#pendingRollbacks.set(releaseId, { current, target });
    return prepared;
  }

  public async completeRollback(context: RepositoryContext, releaseId: string, currentPublicationId: string, targetPublicationId: string): Promise<StoredRelease> {
    const release = this.requireScoped(context, releaseId);
    const current = this.requirePublication(currentPublicationId, release);
    const target = this.#publications.get(targetPublicationId);
    if (!target || current.previousPublicationId !== target.id) throw new McpEditingError("ROLLBACK_TARGET_MISMATCH", "Rollback target changed");
    this.#publications.set(current.id, Object.freeze({ ...current, status: "rolled_back" }));
    this.#publications.set(target.id, Object.freeze({ ...target, status: "verified" }));
    release.status = releaseTransition(release.status, "rolled_back");
    release.updatedAt = new Date().toISOString();
    this.#pendingRollbacks.delete(releaseId);
    return freezeRelease(release);
  }

  private requireScoped(context: RepositoryContext, releaseId: string): MutableRelease {
    const release = this.#releases.get(releaseId);
    if (!release || release.tenantId !== context.site.tenantId || release.siteId !== context.site.siteId) {
      throw new McpEditingError("RELEASE_NOT_FOUND", "Release was not found in the authorized site");
    }
    return release;
  }

  private requireExact(context: RepositoryContext, releaseId: string, releaseHash: string): MutableRelease {
    const release = this.requireScoped(context, releaseId);
    if (release.releaseHash !== releaseHash) throw new McpEditingError("STALE_RELEASE_APPROVAL", "Release hash does not match the previewed candidate");
    return release;
  }

  private activeFor(environmentId: string): PublicationRecord | undefined {
    return [...this.#publications.values()].find((candidate) =>
      candidate.environmentId === environmentId && ["applied", "verified", "verification_failed"].includes(candidate.status)
    );
  }

  private previousFor(release: MutableRelease): { readonly previous?: PublicationRecord } {
    const previous = this.activeFor(release.environmentId);
    return previous ? { previous } : {};
  }

  private requirePublication(publicationId: string, release: MutableRelease): PublicationRecord {
    const publication = this.#publications.get(publicationId);
    if (!publication || publication.environmentId !== release.environmentId) throw new McpEditingError("PUBLICATION_NOT_FOUND", "Publication record was not found");
    return publication;
  }

  private assertApproval(release: MutableRelease, approval: ReleaseApprovalInput): void {
    if (approval.actorKind !== "human" || approval.scope.tenantId !== release.tenantId ||
      approval.scope.siteId !== release.siteId || approval.scope.environmentId !== release.environmentId ||
      new Date(approval.expiresAt).getTime() <= Date.now()) {
      throw new McpEditingError("RELEASE_APPROVAL_INVALID", "Approval must be current, human, and scoped to this exact release");
    }
    // An approval inside the real preview pipeline must copy an independent
    // browser confirmation: the MCP bearer alone is never the decision.
    if (approval.confirmation) {
      const receipt = [...this.#confirmations.values()].find((confirmation) =>
        confirmation.tenantId === release.tenantId && confirmation.siteId === release.siteId &&
        confirmation.releaseId === release.id && confirmation.releaseHash === release.releaseHash &&
        confirmation.receiptHash === approval.confirmation!.receiptHash);
      if (!receipt || !receipt.decisionAt || receipt.revokedAt ||
        receipt.outputManifestDigest !== approval.confirmation.outputManifestDigest ||
        new Date(receipt.receiptExpiresAt ?? 0).getTime() <= Date.now()) {
        throw new McpEditingError("HUMAN_CONFIRMATION_REQUIRED", "A current independent human confirmation receipt is required for this release");
      }
    }
  }
}

interface MutableConfirmation {
  releaseId: string;
  tenantId: string;
  siteId: string;
  releaseHash: string;
  policyVersion: string;
  previewExpiresAt: string;
  decisionAt?: string;
  outputManifestDigest?: string;
  receiptHash?: string;
  receiptExpiresAt?: string;
  revokedAt?: string;
}

function freezeConfirmation(confirmation: MutableConfirmation): ConfirmationRecord {
  return Object.freeze({
    releaseId: confirmation.releaseId,
    tenantId: confirmation.tenantId,
    siteId: confirmation.siteId,
    releaseHash: confirmation.releaseHash,
    policyVersion: confirmation.policyVersion,
    previewExpiresAt: confirmation.previewExpiresAt,
    ...(confirmation.decisionAt ? { decisionAt: confirmation.decisionAt } : {}),
    ...(confirmation.outputManifestDigest ? { outputManifestDigest: confirmation.outputManifestDigest } : {}),
    ...(confirmation.receiptHash ? { receiptHash: confirmation.receiptHash } : {}),
    ...(confirmation.receiptExpiresAt ? { receiptExpiresAt: confirmation.receiptExpiresAt } : {}),
    ...(confirmation.revokedAt ? { revokedAt: confirmation.revokedAt } : {})
  });
}

export class EmbeddedReleaseProvider implements ReleaseProvider {
  public readonly key = "navocms.embedded.v1";

  public async publish(input: Parameters<ReleaseProvider["publish"]>[0]): Promise<ReleaseProviderPublication> {
    return Object.freeze({
      providerKey: this.key,
      providerReference: `embedded:${input.releaseHash}:${input.artifact.hash}`,
      artifactHash: input.artifact.hash
    });
  }

  public async verify(publication: ReleaseProviderPublication): Promise<boolean> {
    return publication.providerKey === this.key && publication.providerReference.endsWith(`:${publication.artifactHash}`);
  }

  public async rollback(current: ReleaseProviderPublication, target: ReleaseProviderPublication): Promise<void> {
    if (current.providerKey !== this.key || target.providerKey !== this.key) {
      throw new McpEditingError("ROLLBACK_PROVIDER_MISMATCH", "Embedded provider cannot roll back another provider");
    }
  }
}

function freezeRelease(release: MutableRelease): StoredRelease {
  return Object.freeze({
    id: release.id,
    environmentId: release.environmentId,
    revisionId: release.revisionId,
    workflow: release.workflow,
    releaseHash: release.releaseHash,
    artifactHash: release.artifactHash,
    correlationId: release.correlationId,
    status: release.status,
    manifest: release.manifest,
    artifact: release.artifact,
    createdAt: release.createdAt,
    updatedAt: release.updatedAt,
    ...(release.approvedAt ? { approvedAt: release.approvedAt } : {}),
    ...(release.publishedAt ? { publishedAt: release.publishedAt } : {})
  });
}
