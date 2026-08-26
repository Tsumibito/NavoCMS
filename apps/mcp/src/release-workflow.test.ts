import type {
  ReleaseProvider,
  ReleaseProviderPublication,
  ReleaseProviderPublishInput
} from "@navocms/kernel";
import { InMemoryEventStore } from "@navocms/kernel";
import { NAVOCMS_PERMISSIONS, siteRoleAuthority, type AuthorizationContext } from "@navocms/security";
import type { AstroRenderInput } from "@navocms/design-astro";
import { describe, expect, it, vi } from "vitest";

import { InMemoryReleaseWorkflowRepository } from "./release-repository.js";
import { InMemoryEditingRepository } from "./repository.js";
import { McpEditingService, type StagingAstroOperations } from "./service.js";

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

  it("automatically persists the trusted staging input at preview and gates publish before provider I/O", async () => {
    const provider = new RecoverableProvider();
    const operations = new CapturingStagingOperations();
    const repository = new InMemoryEditingRepository(); repository.registerSite(site);
    const service = new McpEditingService(repository, new InMemoryEventStore(), undefined, new InMemoryReleaseWorkflowRepository(), provider, {}, undefined, undefined, operations);
    const context = requestContext();
    const preview = await draftPreviewApprove(service, context, "staging-input", "Staging input", "staging-input");
    expect(operations.persisted).toEqual([preview.releaseId]);
    await service.publishRelease(context, { releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "publish-staging-input-001" });
    expect(operations.built).toEqual([preview.releaseId]);
    expect(provider.publishCount).toBe(1);
  });

  it("restarts from an approved staging release, builds once during reconcile, and continues without duplicate provider effect", async () => {
    const provider = new RecoverableProvider();
    const operations = new CapturingStagingOperations();
    const repository = new InMemoryEditingRepository(); repository.registerSite(site);
    const releases = new InMemoryReleaseWorkflowRepository(); const events = new InMemoryEventStore();
    const first = new McpEditingService(repository, events, undefined, releases, provider, {}, undefined, undefined, operations);
    const context = requestContext();
    const preview = await draftPreviewApprove(first, context, "restart-approved", "Restart approved", "restart-approved");
    const restarted = new McpEditingService(repository, events, undefined, releases, provider, {}, undefined, undefined, operations);
    await expect(restarted.reconcileRelease(context, { releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "reconcile-approved-restart-001" })).resolves.toMatchObject({ release: { status: "published" } });
    expect(operations.built).toEqual([preview.releaseId]);
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
});

class CapturingStagingOperations implements StagingAstroOperations {
  public readonly persisted: string[] = [];
  public readonly built: string[] = [];
  public prepare(): AstroRenderInput { return { anchors: { content: `sha256:${"a".repeat(64)}`, design: `sha256:${"b".repeat(64)}`, delivery: `sha256:${"c".repeat(64)}`, governance: `sha256:${"d".repeat(64)}` } } as AstroRenderInput; }
  public async persistPreviewInput(_: Parameters<StagingAstroOperations["persistPreviewInput"]>[0], __: Parameters<StagingAstroOperations["persistPreviewInput"]>[1], release: Parameters<StagingAstroOperations["persistPreviewInput"]>[2]): Promise<void> { this.persisted.push(release.id); }
  public async ensureArtifact(_: Parameters<StagingAstroOperations["ensureArtifact"]>[0], __: Parameters<StagingAstroOperations["ensureArtifact"]>[1], release: Parameters<StagingAstroOperations["ensureArtifact"]>[2]): Promise<void> { this.built.push(release.id); }
}

class RecoverableProvider implements ReleaseProvider {
  public readonly key = "test.recoverable.v1";
  public publishCount = 0;
  public rollbackCount = 0;
  public verifyLive = true;
  public failRollbackOnce = false;
  public failPublishOnce = false;

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
