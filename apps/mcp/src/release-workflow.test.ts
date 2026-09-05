import type {
  ReleaseProvider,
  ReleaseProviderPublication,
  ReleaseProviderPublishInput
} from "@navocms/kernel";
import { InMemoryEventStore } from "@navocms/kernel";
import { NAVOCMS_PERMISSIONS, siteRoleAuthority, type AuthorizationContext } from "@navocms/security";
import type { AstroRenderInput } from "@navocms/design-astro";
import { describe, expect, it, vi } from "vitest";

import { InMemoryReleaseWorkflowRepository, type StoredRelease } from "./release-repository.js";
import { InMemoryEditingRepository } from "./repository.js";
import { outputManifestDigest } from "./output-manifest.js";
import { McpEditingService, type StagingAstroOperations } from "./service.js";
import type { PreviewBuildStatus, PreviewPreparation } from "./model.js";

const site = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  name: "Release proving site",
  primaryLocale: "en",
  locales: ["en"]
});

describe("durable release workflow", () => {
  it("rejects non-human approval even when the caller has publish permission", async () => {
    const repository = new InMemoryEditingRepository();
    repository.registerSite(site);
    const service = new McpEditingService(repository);
    const human = requestContext();
    const created = await service.createDraft(human, {
      typeName: "article", slug: "human-approval", locale: "en", title: "Human approval",
      markdown: "# Human approval\n", idempotencyKey: "draft-human-approval-001"
    }) as { draft: { revisionId: string } };
    const preview = await service.preparePreview(human, created.draft.revisionId, "preview-human-approval-001");
    const agent = {
      authorization: {
        ...human.authorization,
        principal: { ...human.authorization.principal, kind: "agent" as const }
      }
    };
    await expect(service.approveRelease(agent, {
      releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "approve-agent-denied-001"
    })).rejects.toMatchObject({ code: "HUMAN_APPROVAL_REQUIRED" });
  });

  it("reconciles a partial verification without duplicate publish and rolls back", async () => {
    const provider = new RecoverableProvider();
    const repository = new InMemoryEditingRepository();
    repository.registerSite(site);
    const service = new McpEditingService(
      repository,
      new InMemoryEventStore(),
      undefined,
      new InMemoryReleaseWorkflowRepository(),
      provider
    );
    const context = requestContext();

    const first = await draftPreviewApprove(service, context, "first-release", "First release", "first");
    await service.publishRelease(context, {
      releaseId: first.releaseId,
      releaseHash: first.releaseHash,
      idempotencyKey: "publish-first-release-001"
    });

    const second = await draftPreviewApprove(service, context, "second-release", "Second release", "second");
    provider.verifyLive = false;
    await expect(service.publishRelease(context, {
      releaseId: second.releaseId,
      releaseHash: second.releaseHash,
      idempotencyKey: "publish-second-release-001"
    })).rejects.toMatchObject({ code: "LIVE_VERIFICATION_FAILED" });
    expect(provider.publishCount).toBe(2);

    provider.verifyLive = true;
    await expect(service.reconcileRelease(context, {
      releaseId: second.releaseId,
      releaseHash: second.releaseHash,
      idempotencyKey: "reconcile-second-release-001"
    })).resolves.toMatchObject({ release: { status: "published" } });
    expect(provider.publishCount).toBe(2);

    await expect(service.rollbackRelease(context, {
      releaseId: second.releaseId,
      releaseHash: second.releaseHash,
      idempotencyKey: "rollback-second-release-001"
    })).resolves.toMatchObject({
      release: { status: "rolled_back" },
      restoredPublication: { releaseId: first.releaseId, artifactHash: first.artifactHash }
    });
    expect(provider.rollbackCount).toBe(1);
  });

  it("persists a rollback checkpoint and resumes the exact target after an interrupted provider rollback", async () => {
    const provider = new RecoverableProvider();
    const repository = new InMemoryEditingRepository(); repository.registerSite(site);
    const service = new McpEditingService(repository, new InMemoryEventStore(), undefined, new InMemoryReleaseWorkflowRepository(), provider);
    const context = requestContext();
    const first = await draftPreviewApprove(service, context, "rollback-first", "Rollback first", "rollback-first");
    await service.publishRelease(context, { releaseId: first.releaseId, releaseHash: first.releaseHash, idempotencyKey: "publish-rollback-first-001" });
    const second = await draftPreviewApprove(service, context, "rollback-second", "Rollback second", "rollback-second");
    await service.publishRelease(context, { releaseId: second.releaseId, releaseHash: second.releaseHash, idempotencyKey: "publish-rollback-second-001" });
    provider.failRollbackOnce = true;
    await expect(service.rollbackRelease(context, { releaseId: second.releaseId, releaseHash: second.releaseHash, idempotencyKey: "rollback-interrupted-001" })).rejects.toThrow("interrupted rollback");
    await expect(service.reconcileRelease(context, { releaseId: second.releaseId, releaseHash: second.releaseHash, idempotencyKey: "reconcile-rollback-001" })).resolves.toMatchObject({ release: { status: "rolled_back" }, publication: { releaseId: first.releaseId } });
    expect(provider.rollbackCount).toBe(2);
  });

  it("builds the trusted staging output before review and never builds during publish or reconcile", async () => {
    const provider = new RecoverableProvider();
    const operations = new CapturingStagingOperations();
    const repository = new InMemoryEditingRepository(); repository.registerSite(site);
    const service = new McpEditingService(repository, new InMemoryEventStore(), undefined, new InMemoryReleaseWorkflowRepository(), provider, {}, undefined, undefined, operations);
    const context = requestContext();
    const preview = await service.preparePreview(context, (await service.createDraft(context, {
      typeName: "article", slug: "staging-input", locale: "en", title: "Staging input",
      markdown: "# Staging input\n", idempotencyKey: "draft-staging-input-release-001"
    }) as { draft: { revisionId: string } }).draft.revisionId, "preview-staging-input-release-001") as PreviewPreparation;
    // Both deterministic builds complete before any review: the job already
    // ran during prepare, and the summary exposes the output manifest digest.
    expect(operations.persisted).toEqual([preview.releaseId]);
    expect(operations.built).toEqual([preview.releaseId]);
    expect(operations.startCount).toBe(1);
    expect(preview.build).toMatchObject({ status: "ready" });
    const summary = await operations.artifactSummary({ site, principalId: "user-publisher" }, preview.releaseId);
    expect(summary?.outputManifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const buildToken = preview.confirmationUrl!.split("/confirmations/")[1]!;
    await expect(service.recordConfirmationDecision(buildToken)).resolves.toMatchObject({ recorded: true });
    await service.approveRelease(context, { releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "approve-staging-input-release-001" });
    await service.publishRelease(context, { releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "publish-staging-input-001" });
    await service.reconcileRelease(context, { releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "reconcile-staging-input-001" });
    // Zero build-runner work after review, across publish, retry, and reconcile.
    expect(operations.startCount).toBe(1);
    expect(provider.publishCount).toBe(1);
  });

  it("requires an independent browser confirmation before approving a built release", async () => {
    const provider = new RecoverableProvider();
    const operations = new CapturingStagingOperations();
    const repository = new InMemoryEditingRepository(); repository.registerSite(site);
    const service = new McpEditingService(repository, new InMemoryEventStore(), undefined, new InMemoryReleaseWorkflowRepository(), provider, {}, undefined, undefined, operations);
    const context = requestContext();
    const created = await service.createDraft(context, {
      typeName: "article", slug: "confirmation-gate", locale: "en", title: "Confirmation gate",
      markdown: "# Confirmation gate\n", idempotencyKey: "draft-confirmation-gate-001"
    }) as { draft: { revisionId: string } };
    const preview = await service.preparePreview(context, created.draft.revisionId, "preview-confirmation-gate-001") as PreviewPreparation;
    expect(preview.confirmationUrl).toMatch(/^https:\/\/preview\.example\.test\/confirmations\/[A-Za-z0-9_-]{43}$/);
    // The MCP bearer — even a human one — cannot approve a built release.
    await expect(service.approveRelease(context, {
      releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "approve-confirmation-gate-001"
    })).rejects.toMatchObject({ code: "HUMAN_CONFIRMATION_REQUIRED" });
    // The human records the decision in the independent browser session.
    const token = preview.confirmationUrl!.split("/confirmations/")[1]!;
    const recorded = await service.recordConfirmationDecision(token);
    expect(recorded).toMatchObject({ recorded: true });
    expect(recorded!.outputManifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    // Re-delivery of the same decision is a safe no-op.
    await expect(service.recordConfirmationDecision(token)).resolves.toMatchObject({ recorded: false });
    const status = await service.releaseConfirmationStatus(context, { releaseId: preview.releaseId, releaseHash: preview.releaseHash });
    expect(status).toMatchObject({ status: "confirmed" });
    // The digest drift check fails closed when the recorded output differs.
    operations.corruptOutput(preview.releaseId);
    await expect(service.approveRelease(context, {
      releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "approve-confirmation-gate-002"
    })).rejects.toMatchObject({ code: "RELEASE_DECISION_STALE" });
    operations.restoreOutput(preview.releaseId);
    await service.approveRelease(context, { releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "approve-confirmation-gate-003" });
    await expect(service.publishRelease(context, {
      releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "publish-confirmation-gate-001"
    })).resolves.toMatchObject({ release: { status: "published" } });
    expect(operations.startCount).toBe(1);
    expect(provider.publishCount).toBe(1);
  });

  it("keeps the proof-only pipeline for releases without a staging runtime", async () => {
    const provider = new RecoverableProvider();
    const repository = new InMemoryEditingRepository(); repository.registerSite(site);
    const releases = new InMemoryReleaseWorkflowRepository(); const events = new InMemoryEventStore();
    const first = new McpEditingService(repository, events, undefined, releases, provider, {}, undefined, undefined, undefined);
    const context = requestContext();
    const preview = await draftPreviewApprove(first, context, "restart-approved", "Restart approved", "restart-approved");
    const restarted = new McpEditingService(repository, events, undefined, releases, provider, {}, undefined, undefined, undefined);
    await expect(restarted.reconcileRelease(context, { releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "reconcile-approved-restart-001" })).resolves.toMatchObject({ release: { status: "published" } });
    expect(provider.publishCount).toBe(1);
    await restarted.reconcileRelease(context, { releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "reconcile-approved-restart-002" });
    expect(provider.publishCount).toBe(1);
  });

  it("reconciles an exact publishing checkpoint after its approval expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-26T20:00:00.000Z"));
      const provider = new RecoverableProvider();
      provider.failPublishOnce = true;
      const repository = new InMemoryEditingRepository(); repository.registerSite(site);
      const releases = new InMemoryReleaseWorkflowRepository(); const events = new InMemoryEventStore();
      const first = new McpEditingService(repository, events, undefined, releases, provider, { approvalTtlSeconds: 1 });
      const context = requestContext();
      const preview = await draftPreviewApprove(first, context, "approval-expiry", "Approval expiry", "approval-expiry");
      await expect(first.publishRelease(context, { releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "publish-approval-expiry-001" })).rejects.toThrow("interrupted publish");
      vi.advanceTimersByTime(2_000);
      const restarted = new McpEditingService(repository, events, undefined, releases, provider, { approvalTtlSeconds: 1 });
      await expect(restarted.reconcileRelease(context, { releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "reconcile-approval-expiry-001" })).resolves.toMatchObject({ release: { status: "published" } });
      expect(provider.publishCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles an applied publication after provider verification throws without republishing", async () => {
    const provider = new RecoverableProvider();
    provider.failVerifyOnce = true;
    const repository = new InMemoryEditingRepository(); repository.registerSite(site);
    const releases = new InMemoryReleaseWorkflowRepository(); const events = new InMemoryEventStore();
    const service = new McpEditingService(repository, events, undefined, releases, provider);
    const context = requestContext();
    const preview = await draftPreviewApprove(service, context, "verification-crash", "Verification crash", "verification-crash");
    await expect(service.publishRelease(context, {
      releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "publish-verification-crash-001"
    })).rejects.toThrow("interrupted verification");
    expect(provider.publishCount).toBe(1);
    await expect(service.reconcileRelease(context, {
      releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "reconcile-verification-crash-001"
    })).resolves.toMatchObject({ release: { status: "published" }, publication: { status: "applied" } });
    expect(provider.publishCount).toBe(1);
  });
});

class CapturingStagingOperations implements StagingAstroOperations {
  public readonly persisted: string[] = [];
  public readonly built: string[] = [];
  public startCount = 0;
  readonly #outputs = new Map<string, Readonly<Record<string, string>>>();
  readonly #originals = new Map<string, Readonly<Record<string, string>>>();
  public async prepare(): Promise<AstroRenderInput> { return { anchors: { content: `sha256:${"a".repeat(64)}`, design: `sha256:${"b".repeat(64)}`, delivery: `sha256:${"c".repeat(64)}`, governance: `sha256:${"d".repeat(64)}` } } as AstroRenderInput; }
  public async persistPreviewInput(_: Parameters<StagingAstroOperations["persistPreviewInput"]>[0], __: Parameters<StagingAstroOperations["persistPreviewInput"]>[1], release: Parameters<StagingAstroOperations["persistPreviewInput"]>[2]): Promise<void> { this.persisted.push(release.id); }
  public async startBuild(_: Parameters<StagingAstroOperations["startBuild"]>[0], release: Parameters<StagingAstroOperations["startBuild"]>[1]): Promise<PreviewBuildStatus> {
    this.startCount += 1;
    if (!this.#outputs.has(release.id)) {
      this.built.push(release.id);
      this.#outputs.set(release.id, Object.freeze({
        "index.html": `<!doctype html><html lang="en"><head><link rel="stylesheet" href="/_astro/styles.css"></head><body><h1>${release.id}</h1></body></html>`,
        "_astro/styles.css": "body { margin: 0; }\n"
      }));
    }
    return { releaseId: release.id, status: "ready" };
  }
  public async buildStatus(_: Parameters<StagingAstroOperations["buildStatus"]>[0], releaseId: string): Promise<PreviewBuildStatus> {
    return { releaseId, status: this.#outputs.has(releaseId) ? "ready" : "building" };
  }
  public async artifactSummary(_: Parameters<StagingAstroOperations["artifactSummary"]>[0], releaseId: string) {
    const output = this.#outputs.get(releaseId);
    return output ? { outputManifestDigest: outputManifestDigest(output), fileCount: Object.keys(output).length, totalBytes: Object.values(output).reduce((total, body) => total + body.length, 0), sourceCommitSha: "a".repeat(40) } : undefined;
  }
  public async artifactFor(scope: Parameters<StagingAstroOperations["artifactFor"]>[0]) {
    const output = this.#outputs.get(scope.releaseId);
    return output ? Object.freeze({ output, outputManifestDigest: outputManifestDigest(output), fileCount: Object.keys(output).length, totalBytes: Object.values(output).reduce((total, body) => total + body.length, 0), sourceCommitSha: "a".repeat(40) }) : undefined;
  }
  /** Simulates the registered output changing after the decision was recorded. */
  public corruptOutput(releaseId: string): void {
    this.#originals.set(releaseId, this.#outputs.get(releaseId)!);
    this.#outputs.set(releaseId, Object.freeze({ ...this.#originals.get(releaseId)!, "_astro/extra.css": "h1 { color: red; }\n" }));
  }
  public restoreOutput(releaseId: string): void {
    const original = this.#originals.get(releaseId);
    if (original) this.#outputs.set(releaseId, original);
    this.#originals.delete(releaseId);
  }
}

class RecoverableProvider implements ReleaseProvider {
  public readonly key = "test.recoverable.v1";
  public publishCount = 0;
  public rollbackCount = 0;
  public verifyLive = true;
  public failRollbackOnce = false;
  public failPublishOnce = false;
  public failVerifyOnce = false;

  public async publish(input: ReleaseProviderPublishInput): Promise<ReleaseProviderPublication> {
    this.publishCount += 1;
    if (this.failPublishOnce) { this.failPublishOnce = false; throw new Error("interrupted publish"); }
    return {
      providerKey: this.key,
      providerReference: `test:${input.releaseHash}:${input.artifact.hash}`,
      artifactHash: input.artifact.hash
    };
  }

  public async verify(): Promise<boolean> {
    if (this.failVerifyOnce) { this.failVerifyOnce = false; throw new Error("interrupted verification"); }
    return this.verifyLive;
  }

  public async rollback(): Promise<void> {
    this.rollbackCount += 1;
    if (this.failRollbackOnce) { this.failRollbackOnce = false; throw new Error("interrupted rollback"); }
  }
}

async function draftPreviewApprove(
  service: McpEditingService,
  context: { authorization: AuthorizationContext },
  slug: string,
  title: string,
  key: string
) {
  const created = await service.createDraft(context, {
    typeName: "article",
    slug,
    locale: "en",
    title,
    markdown: `# ${title}\n`,
    idempotencyKey: `draft-${key}-release-001`
  }) as { draft: { revisionId: string } };
  const preview = await service.preparePreview(context, created.draft.revisionId, `preview-${key}-release-001`);
  await service.approveRelease(context, {
    releaseId: preview.releaseId,
    releaseHash: preview.releaseHash,
    idempotencyKey: `approve-${key}-release-001`
  });
  return preview;
}

function requestContext(): { authorization: AuthorizationContext } {
  return {
    authorization: {
      tenantId: site.tenantId,
      siteId: site.siteId,
      principal: { id: "user-publisher", kind: "human", issuer: "https://identity.example", subject: "publisher" },
      layers: [
        { name: "principal", permissions: NAVOCMS_PERMISSIONS },
        siteRoleAuthority("publisher"),
        { name: "operation", permissions: NAVOCMS_PERMISSIONS }
      ]
    }
  };
}
