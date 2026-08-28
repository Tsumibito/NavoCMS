import { sha256 } from "@navocms/kernel";
import {
  CloudflarePagesReleaseProvider,
  InMemoryDeliveryPhaseStore,
  type CloudflareDeployment,
  type CloudflarePagesTransport,
  type CloudflareLiveProbe,
  type ImmutableArtifactReference,
  type ImmutableArtifactResolver
} from "@navocms/delivery-cloudflare";
import { NAVOCMS_PERMISSIONS, siteRoleAuthority, type AuthorizationContext } from "@navocms/security";
import { describe, expect, it } from "vitest";

import { InMemoryReleaseWorkflowRepository } from "./release-repository.js";
import { InMemoryEditingRepository } from "./repository.js";
import { McpEditingService } from "./service.js";

const site = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  name: "Cloudflare delivery proving site",
  primaryLocale: "en",
  locales: ["en"]
});

describe("Cloudflare provider through the durable release workflow", () => {
  it("reconciles a verified Pages publication without a second Pages or Coolify effect", async () => {
    const cloudflare = new WorkflowCloudflare();
    const coolifyCalls = 0;
    const repository = new InMemoryEditingRepository();
    repository.registerSite(site);
    const service = new McpEditingService(
      repository,
      undefined,
      undefined,
      new InMemoryReleaseWorkflowRepository(),
      new CloudflarePagesReleaseProvider({
        projectKey: "pages-project",
        previewBranch: "preview",
        productionBranch: "main",
        resolver: resolver(),
        cloudflare,
        phases: new InMemoryDeliveryPhaseStore()
      })
    );
    const context = requestContext();
    const preview = await draftPreviewApprove(service, context);
    cloudflare.live = false;

    await expect(service.publishRelease(context, {
      releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "publish-cloudflare-release-001"
    })).rejects.toMatchObject({ code: "LIVE_VERIFICATION_FAILED" });
    expect(cloudflare.createCount).toBe(1);
    expect(coolifyCalls).toBe(0);

    cloudflare.live = true;
    await expect(service.reconcileRelease(context, {
      releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "reconcile-cloudflare-release-001"
    })).resolves.toMatchObject({ release: { status: "published" } });
    expect(cloudflare.createCount).toBe(1);
    expect(coolifyCalls).toBe(0);
  });
});

function resolver(): ImmutableArtifactResolver {
  return {
    resolve: async ({ releaseHash, releaseArtifact }) => {
      const files = { "en/index.html": "<html>safe output</html>" };
      return {
        reference: {
          schema: "io.navocms.cloudflare-artifact-reference.v1",
          releaseHash,
          releaseArtifactHash: releaseArtifact.hash,
          astroArtifactHash: `sha256:${"c".repeat(64)}`,
          outputHash: sha256('{"en/index.html":"<html>safe output</html>"}'),
          routeDigest: sha256('["en/index.html"]'),
          sourceCommitSha: releaseHash.slice(0, 40),
          fileCount: 1,
          byteSize: 24,
          files: Object.freeze([Object.freeze({ path: "en/index.html", sha256: sha256("<html>safe output</html>"), byteSize: 24 })])
        },
        files
      };
    }
  };
}

class WorkflowCloudflare implements CloudflarePagesTransport {
  public createCount = 0;
  public live = true;
  readonly #deployments = new Map<string, CloudflareDeployment>();
  readonly #references = new Map<string, ImmutableArtifactReference>();

  public async findDeployment(input: Parameters<CloudflarePagesTransport["findDeployment"]>[0]) { return this.#deployments.get(`${input.referenceHash}:${input.environment}`); }
  public async createPreview(input: Parameters<CloudflarePagesTransport["createPreview"]>[0]) {
    this.createCount += 1;
    const deployment: CloudflareDeployment = { id: `preview-${this.createCount}`, projectKey: input.projectKey, referenceHash: input.referenceHash, environment: "preview", status: "success" };
    this.#deployments.set(`${input.referenceHash}:preview`, deployment);
    this.#references.set(input.referenceHash, input.reference);
    return deployment;
  }
  public async deployProduction(input: Parameters<CloudflarePagesTransport["deployProduction"]>[0]) {
    const deployment: CloudflareDeployment = { id: `production-${this.createCount}`, projectKey: input.projectKey, referenceHash: input.referenceHash, environment: "production", status: "success" };
    this.#deployments.set(`${input.referenceHash}:production`, deployment);
    return deployment;
  }
  public async retryDeployment(input: Parameters<CloudflarePagesTransport["retryDeployment"]>[0]) {
    const deployment = this.#deployments.get(`${input.referenceHash}:${input.environment}`);
    if (!deployment) throw new Error("missing deployment");
    return { ...deployment, status: "success" as const };
  }
  public async inspectDeployment(input: Parameters<CloudflarePagesTransport["inspectDeployment"]>[0]) { return [...this.#deployments.values()].find((deployment) => deployment.id === input.deploymentId); }
  public async verifyLive(input: Parameters<CloudflarePagesTransport["verifyLive"]>[0]): Promise<CloudflareLiveProbe> {
    const deployment = this.#deployments.get(`${input.referenceHash}:${input.environment}`);
    if (!this.live || !deployment) return { status: 502 };
    const reference = this.#references.get(input.referenceHash)!;
    return { status: 200, referenceHash: input.referenceHash, releaseHash: reference.releaseHash, outputHash: reference.outputHash, cacheControl: "public, max-age=300, must-revalidate", files: reference.files };
  }
  public async rollback(): Promise<void> { return undefined; }
}

async function draftPreviewApprove(service: McpEditingService, context: { authorization: AuthorizationContext }) {
  const created = await service.createDraft(context, {
    typeName: "article", slug: "cloudflare-delivery", locale: "en", title: "Cloudflare delivery",
    markdown: "# Cloudflare delivery\n", idempotencyKey: "draft-cloudflare-release-001"
  }) as { draft: { revisionId: string } };
  const preview = await service.preparePreview(context, created.draft.revisionId, "preview-cloudflare-release-001");
  await service.approveRelease(context, {
    releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "approve-cloudflare-release-001"
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
