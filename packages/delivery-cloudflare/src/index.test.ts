import { sha256, type ReleaseProviderPublishInput } from "@navocms/kernel";
import { describe, expect, it } from "vitest";

import { CLOUDFLARE_CACHE_CONTROL, CloudflarePagesReleaseProvider, InMemoryDeliveryPhaseStore, type CloudflareDeployment, type CloudflareLiveProbe, type CloudflarePagesReleaseProviderOptions, type CloudflarePagesTransport, type ImmutableArtifactReference } from "./index.js";

const input: ReleaseProviderPublishInput = Object.freeze({ releaseId: "release-pages-only", releaseHash: "a".repeat(64), artifact: { mediaType: "text/html; charset=utf-8" as const, body: "release", hash: "b".repeat(64) } });

describe("Cloudflare Pages release provider", () => {
  it("publishes, reconciles, and rolls back Pages without serializing or invoking Coolify", async () => {
    const cloudflare = new FakeCloudflare();
    const provider = createProvider(cloudflare);
    const first = await provider.publish(input);
    await expect(provider.verify(first)).resolves.toBe(true);
    await provider.publish(input);
    const secondInput = { ...input, releaseId: "release-pages-only-next", releaseHash: "c".repeat(64), artifact: { ...input.artifact, hash: "d".repeat(64) } };
    const second = await provider.publish(secondInput);
    await provider.rollback(second, first);

    expect(cloudflare.createPreviewCalls).toBe(2);
    expect(cloudflare.deployProductionCalls).toBe(2);
    expect(cloudflare.rollbackCalls).toBe(1);
    expect(first.providerReference).toMatch(/^navocms-cloudflare-pages\/v2:/);
    expect(JSON.stringify(first)).not.toContain("coolify");
  });

  it("reads legacy v1 references through the isolated Pages-only compatibility path", async () => {
    const cloudflare = new FakeCloudflare();
    const provider = createProvider(cloudflare);
    const publication = await provider.publish(input);
    const current = await provider.publish({ ...input, releaseId: "legacy-current", releaseHash: "c".repeat(64), artifact: { ...input.artifact, hash: "d".repeat(64) } });
    const encoded = publication.providerReference.slice("navocms-cloudflare-pages/v2:".length);
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    const legacy = { ...decoded, format: "navocms-cloudflare-pages/v1", coolifyApplicationKey: "legacy-coolify-app", coolifyPromotionId: "legacy-promotion" };
    const legacyPublication = { ...publication, providerReference: `navocms-cloudflare-pages/v1:${Buffer.from(JSON.stringify(legacy)).toString("base64url")}` };

    await expect(provider.verify(legacyPublication)).resolves.toBe(true);
    await expect(provider.rollback(current, legacyPublication)).resolves.toBeUndefined();
    expect(cloudflare.rollbackCalls).toBe(1);
  });

  it("never reads a Coolify capability during new Pages publish, reconcile, or rollback", async () => {
    const cloudflare = new FakeCloudflare();
    const pagesOnly: CloudflarePagesReleaseProviderOptions = { projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", resolver: { resolve: async ({ releaseHash, releaseArtifact }) => deployable(releaseHash, releaseArtifact.hash) }, cloudflare, phases: new InMemoryDeliveryPhaseStore() };
    const guarded = new Proxy(pagesOnly, {
      get(target, property, receiver) {
        if (property === "coolify") throw new Error("content publication must not read Coolify");
        return Reflect.get(target, property, receiver);
      }
    });
    const provider = new CloudflarePagesReleaseProvider(guarded);
    const first = await provider.publish(input);
    await provider.publish(input);
    const second = await provider.publish({ ...input, releaseId: "guarded-next", releaseHash: "c".repeat(64), artifact: { ...input.artifact, hash: "d".repeat(64) } });
    await expect(provider.rollback(second, first)).resolves.toBeUndefined();
  });
});

function createProvider(cloudflare: FakeCloudflare) {
  return new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", resolver: { resolve: async ({ releaseHash, releaseArtifact }) => deployable(releaseHash, releaseArtifact.hash) }, cloudflare, phases: new InMemoryDeliveryPhaseStore() });
}

function deployable(releaseHash: string, releaseArtifactHash: string) {
  const files = Object.freeze({ "en/index.html": "<html>Pages only</html>" });
  const reference: ImmutableArtifactReference = Object.freeze({ schema: "io.navocms.cloudflare-artifact-reference.v1", releaseHash, releaseArtifactHash, astroArtifactHash: `sha256:${"e".repeat(64)}`, outputHash: sha256(JSON.stringify(files)), routeDigest: sha256('["en/index.html"]'), sourceCommitSha: "f".repeat(40), fileCount: 1, byteSize: 23, files: Object.freeze([{ path: "en/index.html", sha256: sha256(files["en/index.html"]), byteSize: 23 }]) });
  return Object.freeze({ reference, files });
}

class FakeCloudflare implements CloudflarePagesTransport {
  public createPreviewCalls = 0; public deployProductionCalls = 0; public rollbackCalls = 0;
  readonly #deployments = new Map<string, CloudflareDeployment>();
  public async findDeployment(input: Parameters<CloudflarePagesTransport["findDeployment"]>[0]) { return this.#deployments.get(`${input.referenceHash}:${input.environment}`); }
  public async createPreview(input: Parameters<CloudflarePagesTransport["createPreview"]>[0]) { this.createPreviewCalls += 1; return this.#put(input.projectKey, input.referenceHash, "preview", `preview-${this.createPreviewCalls}`); }
  public async deployProduction(input: Parameters<CloudflarePagesTransport["deployProduction"]>[0]) { this.deployProductionCalls += 1; return this.#put(input.projectKey, input.referenceHash, "production", `production-${this.deployProductionCalls}`); }
  public async retryDeployment(input: Parameters<CloudflarePagesTransport["retryDeployment"]>[0]) { return this.#deployments.get(`${input.referenceHash}:${input.environment}`)!; }
  public async inspectDeployment(input: Parameters<CloudflarePagesTransport["inspectDeployment"]>[0]) { return [...this.#deployments.values()].find((item) => item.id === input.deploymentId); }
  public async verifyLive(input: Parameters<CloudflarePagesTransport["verifyLive"]>[0]): Promise<CloudflareLiveProbe> { return { status: 200, referenceHash: input.referenceHash, releaseHash: input.reference.releaseHash, outputHash: input.reference.outputHash, cacheControl: CLOUDFLARE_CACHE_CONTROL.production, files: input.reference.files }; }
  public async rollback(): Promise<void> { this.rollbackCalls += 1; }
  #put(projectKey: string, referenceHash: string, environment: "preview" | "production", id: string): CloudflareDeployment { const deployment = { id, projectKey, referenceHash, environment, status: "success" as const }; this.#deployments.set(`${referenceHash}:${environment}`, deployment); return deployment; }
}
