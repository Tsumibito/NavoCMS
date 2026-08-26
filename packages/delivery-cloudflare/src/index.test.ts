import { InMemoryEventStore, sha256, type ReleaseArtifact, type ReleaseProviderPublishInput } from "@navocms/kernel";
import { describe, expect, it } from "vitest";

import {
  CloudflareDeliveryError,
  CLOUDFLARE_DELIVERY_LIMITS,
  CloudflarePagesReleaseProvider,
  EventLedgerDeliveryTelemetry,
  InMemoryDeliveryPhaseStore,
  InMemoryDeliveryTelemetry,
  immutableReferenceHash,
  type CloudflareDeployment,
  type CloudflarePagesTransport,
  type CoolifyCommitTransport,
  type CoolifyPromotion,
  type DeployableArtifact,
  type ImmutableArtifactResolver
} from "./index.js";

const releaseHash = "a".repeat(64);
const artifactHash = "b".repeat(64);
const reference = Object.freeze({
  schema: "io.navocms.cloudflare-artifact-reference.v1" as const,
  releaseHash,
  releaseArtifactHash: artifactHash,
  astroArtifactHash: `sha256:${"c".repeat(64)}`,
  outputHash: sha256('{"en/index.html":"<html>en</html>","fr/index.html":"<html>fr</html>"}'),
  routeDigest: sha256('["en/index.html","fr/index.html"]'),
  sourceCommitSha: "f".repeat(40),
  fileCount: 2,
  byteSize: 30,
  files: Object.freeze([
    Object.freeze({ path: "en/index.html", sha256: sha256("<html>en</html>"), byteSize: 15 }),
    Object.freeze({ path: "fr/index.html", sha256: sha256("<html>fr</html>"), byteSize: 15 })
  ])
});
const referenceHash = immutableReferenceHash(reference);
const artifact: ReleaseArtifact = Object.freeze({ mediaType: "text/html; charset=utf-8", body: "proof", hash: artifactHash });
const input: ReleaseProviderPublishInput = Object.freeze({ releaseId: "release-1", releaseHash, artifact });

describe("Cloudflare Pages release provider", () => {
  it("uses one immutable Cloudflare preview and one exact Coolify commit promotion across replay", async () => {
    const cloudflare = new FakeCloudflare();
    const coolify = new FakeCoolify();
    const telemetry = new InMemoryDeliveryTelemetry();
    const provider = createProvider(cloudflare, coolify, telemetry);

    const first = await provider.publish(input);
    const second = await provider.publish(input);

    expect(second).toEqual(first);
    expect(cloudflare.createCalls).toHaveLength(1);
    expect(coolify.promoteCalls).toHaveLength(1);
    expect(cloudflare.createCalls[0]).toMatchObject({ referenceHash, reference });
    expect(coolify.promoteCalls[0]).toMatchObject({ sourceCommitSha: reference.sourceCommitSha, referenceHash });
    await expect(provider.verify(first)).resolves.toBe(true);
  });

  it("retries and records a transient Cloudflare 502 without recording a second deployment", async () => {
    const cloudflare = new FakeCloudflare();
    cloudflare.failDiscoveries = 1;
    const coolify = new FakeCoolify();
    const telemetry = new InMemoryDeliveryTelemetry();
    const provider = createProvider(cloudflare, coolify, telemetry);

    await provider.publish(input);

    expect(cloudflare.createCalls).toHaveLength(1);
    expect(telemetry.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "cloudflare-pages", operation: "discover", outcome: "retry", httpStatus: 502, errorCode: "CLOUDFLARE_HTTP_502" })
    ]));
  });

  it("never automatically retries a mutating Coolify request after an ambiguous 502", async () => {
    const cloudflare = new FakeCloudflare();
    const coolify = new FakeCoolify();
    coolify.failPromoteAfterEffectOnce = true;
    const phases = new InMemoryDeliveryPhaseStore();
    const provider = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver: { resolve: async () => deployable(reference) }, cloudflare, coolify, phases });

    await expect(provider.publish(input)).rejects.toMatchObject({ httpStatus: 502 });
    expect(coolify.promoteCalls).toHaveLength(1);
    await expect(provider.publish(input)).rejects.toMatchObject({ code: "DELIVERY_PHASE_HUMAN_RESOLUTION_REQUIRED" });
    expect(coolify.promoteCalls).toHaveLength(1);
  });

  it("never automatically retries a mutating Pages request after an ambiguous 502", async () => {
    const cloudflare = new FakeCloudflare(); const coolify = new FakeCoolify();
    cloudflare.failPreviewAfterEffectOnce = true;
    const provider = createProvider(cloudflare, coolify);
    await expect(provider.publish(input)).rejects.toMatchObject({ httpStatus: 502 });
    expect(cloudflare.createCalls).toHaveLength(1);
    await expect(provider.publish(input)).resolves.toBeDefined();
    expect(cloudflare.createCalls).toHaveLength(1);
  });

  it("allows exactly one evidence-bound second attempt after crash before Coolify publish", async () => {
    const cloudflare = new FakeCloudflare(); const coolify = new FakeCoolify(); const phases = new InMemoryDeliveryPhaseStore();
    const phase = { releaseId: input.releaseId, referenceHash, phase: "publish.coolify" };
    await phases.reserve(phase); // process stopped after reserve, before request
    await phases.notApplied({ ...phase, evidenceHash: "e".repeat(64), observedAt: "2026-08-26T00:00:00.000Z" });
    const provider = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver: { resolve: async () => deployable(reference) }, cloudflare, coolify, phases });

    await expect(provider.publish(input)).resolves.toBeDefined();
    expect(coolify.promoteCalls).toHaveLength(1);
    expect(coolify.promoteCalls[0]!.operationKey).toContain("promote:2:");
    await expect(phases.notApplied({ ...phase, evidenceHash: "f".repeat(64), observedAt: "2026-08-26T00:00:01.000Z" })).rejects.toMatchObject({ code: "DELIVERY_PHASE_NOT_APPLIED_INVALID" });
  });

  it("fails closed before any provider effect when a resolver returns a different immutable artifact", async () => {
    const cloudflare = new FakeCloudflare();
    const coolify = new FakeCoolify();
    const resolver: ImmutableArtifactResolver = { resolve: async () => ({ reference: { ...reference, releaseHash: "0".repeat(64) }, files: { "en/index.html": "html", "fr/index.html": "html" } }) };
    const provider = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver, cloudflare, coolify, phases: new InMemoryDeliveryPhaseStore() });

    await expect(provider.publish(input)).rejects.toMatchObject({ code: "ARTIFACT_REFERENCE_MISMATCH" });
    expect(cloudflare.createCalls).toHaveLength(0);
    expect(coolify.promoteCalls).toHaveLength(0);
  });

  it("rejects a 502 live probe, retains retry telemetry, and allows later reconcile verification", async () => {
    const cloudflare = new FakeCloudflare();
    const coolify = new FakeCoolify();
    const telemetry = new InMemoryDeliveryTelemetry();
    const provider = createProvider(cloudflare, coolify, telemetry);
    const publication = await provider.publish(input);
    cloudflare.liveStatus = 502;

    await expect(provider.verify(publication)).resolves.toBe(false);
    expect(telemetry.records.filter((record) => record.operation === "verify" && record.httpStatus === 502)).toHaveLength(3);
    cloudflare.liveStatus = 200;
    await expect(provider.verify(publication)).resolves.toBe(true);
  });

  it("rejects a live-file substitution even when the immutable response headers still match", async () => {
    const cloudflare = new FakeCloudflare();
    const provider = createProvider(cloudflare, new FakeCoolify());
    const publication = await provider.publish(input);
    cloudflare.swappedLiveBytes = true;
    await expect(provider.verify(publication)).resolves.toBe(false);
  });

  it("retries failed or canceled Pages and Coolify work instead of reusing terminal effects", async () => {
    const cloudflare = new FakeCloudflare();
    const coolify = new FakeCoolify();
    cloudflare.deployments.set(`${referenceHash}:preview`, { id: "failed-preview", projectKey: "pages-project", referenceHash, environment: "preview", status: "canceled" });
    coolify.promotions.set(`${reference.sourceCommitSha}:${referenceHash}`, { id: "failed-promotion", applicationKey: "coolify-app", sourceCommitSha: reference.sourceCommitSha, referenceHash, status: "failed" });
    const provider = createProvider(cloudflare, coolify);

    await expect(provider.publish(input)).resolves.toBeDefined();
    expect(cloudflare.retryCalls).toHaveLength(1);
    expect(coolify.retryCalls).toHaveLength(0);
    expect(coolify.promoteCalls).toHaveLength(1);
  });

  it("does not reuse a Coolify promotion for the same commit under another immutable reference", async () => {
    const cloudflare = new FakeCloudflare();
    const coolify = new FakeCoolify();
    const first = createProvider(cloudflare, coolify);
    await first.publish(input);
    const changed = { ...reference, releaseHash: "1".repeat(64), releaseArtifactHash: "2".repeat(64) };
    const second = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver: { resolve: async () => deployable(changed) }, cloudflare, coolify, phases: new InMemoryDeliveryPhaseStore() });
    await second.publish({ releaseId: "release-2", releaseHash: changed.releaseHash, artifact: { ...artifact, hash: changed.releaseArtifactHash } });
    expect(coolify.promoteCalls).toHaveLength(2);
  });

  it("rolls back only to the exact recorded Cloudflare deployment and Coolify commit", async () => {
    const cloudflare = new FakeCloudflare();
    const coolify = new FakeCoolify();
    const provider = createProvider(cloudflare, coolify);
    const first = await provider.publish(input);
    const secondInput = { ...input, releaseId: "release-2", releaseHash: "1".repeat(64), artifact: { ...artifact, hash: "2".repeat(64) } };
    const secondReference = { ...reference, releaseHash: secondInput.releaseHash, releaseArtifactHash: secondInput.artifact.hash, sourceCommitSha: "3".repeat(40) };
    const resolver: ImmutableArtifactResolver = { resolve: async (value) => value.releaseHash === secondInput.releaseHash ? deployable(secondReference) : deployable(reference) };
    const rollbackProvider = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver, cloudflare, coolify, phases: new InMemoryDeliveryPhaseStore() });
    const second = await rollbackProvider.publish(secondInput);

    await rollbackProvider.rollback(second, first);

    expect(cloudflare.rollbackCalls[0]).toMatchObject({ currentEnvironment: "production", targetEnvironment: "production" });
    expect(cloudflare.rollbackCalls[0]!.currentDeploymentId).not.toBe(cloudflare.rollbackCalls[0]!.targetDeploymentId);
    expect(coolify.rollbackCalls[0]).toMatchObject({ targetCommitSha: reference.sourceCommitSha });
  });

  it("recovers an uncertain Cloudflare rollback from canonical target bytes without replaying it", async () => {
    const cloudflare = new FakeCloudflare(); const coolify = new FakeCoolify(); const phases = new InMemoryDeliveryPhaseStore();
    const firstProvider = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver: { resolve: async () => deployable(reference) }, cloudflare, coolify, phases });
    const first = await firstProvider.publish(input);
    const secondInput = { ...input, releaseId: "release-canonical-recovery", releaseHash: "1".repeat(64), artifact: { ...artifact, hash: "2".repeat(64) } };
    const secondReference = { ...reference, releaseHash: secondInput.releaseHash, releaseArtifactHash: secondInput.artifact.hash, sourceCommitSha: "3".repeat(40) };
    const provider = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver: { resolve: async (value) => value.releaseHash === secondInput.releaseHash ? deployable(secondReference) : deployable(reference) }, cloudflare, coolify, phases });
    const second = await provider.publish(secondInput);
    cloudflare.failRollbackAfterEffectOnce = true;

    await expect(provider.rollback(second, first)).rejects.toThrow("interrupted Cloudflare rollback after effect");
    await expect(provider.rollback(second, first)).resolves.toBeUndefined();
    expect(cloudflare.rollbackCalls).toHaveLength(1);
  });

  it("allows one evidence-bound second attempt after crash before Cloudflare rollback", async () => {
    const cloudflare = new FakeCloudflare(); const coolify = new FakeCoolify(); const phases = new InMemoryDeliveryPhaseStore();
    const provider = createProvider(cloudflare, coolify);
    const first = await provider.publish(input);
    const secondInput = { ...input, releaseId: "release-before-cloudflare", releaseHash: "1".repeat(64), artifact: { ...artifact, hash: "2".repeat(64) } };
    const secondReference = { ...reference, releaseHash: secondInput.releaseHash, releaseArtifactHash: secondInput.artifact.hash, sourceCommitSha: "3".repeat(40) };
    const rollback = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver: { resolve: async (value) => value.releaseHash === secondInput.releaseHash ? deployable(secondReference) : deployable(reference) }, cloudflare, coolify, phases });
    const second = await rollback.publish(secondInput);
    const phase = { releaseId: secondInput.releaseId, referenceHash, phase: "rollback.cloudflare" };
    await phases.reserve(phase); await phases.notApplied({ ...phase, evidenceHash: "e".repeat(64), observedAt: "2026-08-26T00:00:00.000Z" });
    await rollback.rollback(second, first);
    expect(cloudflare.rollbackCalls).toHaveLength(1);
    expect(cloudflare.rollbackCalls[0]!.operationKey).toContain("rollback:2:");
  });

  it("allows one evidence-bound second attempt after crash before Coolify rollback", async () => {
    const cloudflare = new FakeCloudflare(); const coolify = new FakeCoolify(); const phases = new InMemoryDeliveryPhaseStore();
    const firstProvider = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver: { resolve: async () => deployable(reference) }, cloudflare, coolify, phases });
    const first = await firstProvider.publish(input);
    const secondInput = { ...input, releaseId: "release-before-coolify", releaseHash: "1".repeat(64), artifact: { ...artifact, hash: "2".repeat(64) } };
    const secondReference = { ...reference, releaseHash: secondInput.releaseHash, releaseArtifactHash: secondInput.artifact.hash, sourceCommitSha: "3".repeat(40) };
    const rollback = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver: { resolve: async (value) => value.releaseHash === secondInput.releaseHash ? deployable(secondReference) : deployable(reference) }, cloudflare, coolify, phases });
    const second = await rollback.publish(secondInput);
    const phase = { releaseId: secondInput.releaseId, referenceHash, phase: "rollback.coolify" };
    await phases.reserve(phase); await phases.notApplied({ ...phase, evidenceHash: "e".repeat(64), observedAt: "2026-08-26T00:00:00.000Z" });
    await rollback.rollback(second, first);
    expect(coolify.rollbackCalls).toHaveLength(1);
    expect(coolify.rollbackCalls[0]!.operationKey).toContain("rollback:2:");
  });

  it("requires a human evidence-bound Coolify resolution after an uncertain rollback instead of replaying it", async () => {
    const cloudflare = new FakeCloudflare();
    const coolify = new FakeCoolify();
    const phases = new InMemoryDeliveryPhaseStore();
    const firstProvider = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver: { resolve: async () => deployable(reference) }, cloudflare, coolify, phases });
    const first = await firstProvider.publish(input);
    const secondInput = { ...input, releaseId: "release-restart", releaseHash: "1".repeat(64), artifact: { ...artifact, hash: "2".repeat(64) } };
    const secondReference = { ...reference, releaseHash: secondInput.releaseHash, releaseArtifactHash: secondInput.artifact.hash, sourceCommitSha: "3".repeat(40) };
    const provider = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver: { resolve: async (value) => value.releaseHash === secondInput.releaseHash ? deployable(secondReference) : deployable(reference) }, cloudflare, coolify, phases });
    const second = await provider.publish(secondInput);
    coolify.failRollbackAfterEffectOnce = true;
    await expect(provider.rollback(second, first)).rejects.toThrow("interrupted Coolify rollback after effect");
    await expect(provider.rollback(second, first)).rejects.toMatchObject({ code: "DELIVERY_PHASE_HUMAN_RESOLUTION_REQUIRED" });
    await expect(phases.resolve({ releaseId: secondInput.releaseId, referenceHash, phase: "rollback.coolify", externalId: coolify.lastRollbackId!, evidenceHash: "d".repeat(64), observedAt: "2026-08-25T00:00:00.000Z" })).resolves.toBeUndefined();
    await expect(provider.rollback(second, first)).resolves.toBeUndefined();
    expect(cloudflare.rollbackCalls).toHaveLength(1);
    expect(coolify.rollbackCalls).toHaveLength(1);
  });

  it("rejects malformed operational resolution before it can complete a phase", async () => {
    const phases = new InMemoryDeliveryPhaseStore();
    const phase = { releaseId: input.releaseId, referenceHash, phase: "publish.coolify" };
    await phases.reserve(phase);
    await expect(phases.resolve({ ...phase, externalId: "coolify-1", evidenceHash: "invalid", observedAt: "not-a-date" })).rejects.toMatchObject({ code: "DELIVERY_PHASE_RESOLUTION_INVALID" });
    await expect(phases.reserve(phase)).resolves.toBe("reserved");
  });

  it("resumes a rollback after its provider IDs were durably checkpointed without repeating either external effect", async () => {
    const cloudflare = new FakeCloudflare(); const coolify = new FakeCoolify();
    const phases = new CrashAfterCoolifyCheckpointStore();
    const firstProvider = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver: { resolve: async () => deployable(reference) }, cloudflare, coolify, phases });
    const first = await firstProvider.publish(input);
    const secondInput = { ...input, releaseId: "release-phase-restart", releaseHash: "1".repeat(64), artifact: { ...artifact, hash: "2".repeat(64) } };
    const secondReference = { ...reference, releaseHash: secondInput.releaseHash, releaseArtifactHash: secondInput.artifact.hash, sourceCommitSha: "3".repeat(40) };
    const provider = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver: { resolve: async (value) => value.releaseHash === secondInput.releaseHash ? deployable(secondReference) : deployable(reference) }, cloudflare, coolify, phases });
    const second = await provider.publish(secondInput);
    await expect(provider.rollback(second, first)).rejects.toThrow("simulated process interruption");
    await expect(provider.rollback(second, first)).resolves.toBeUndefined();
    expect(cloudflare.rollbackCalls).toHaveLength(1);
    expect(coolify.rollbackCalls).toHaveLength(1);
  });

  it("does not accept a recomputed reference with an extra envelope field", async () => {
    const cloudflare = new FakeCloudflare();
    const coolify = new FakeCoolify();
    const provider = createProvider(cloudflare, coolify);
    const publication = await provider.publish(input);
    const encoded = publication.providerReference.slice("navocms-cloudflare-pages/v1:".length);
    const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    const tampered = `navocms-cloudflare-pages/v1:${Buffer.from(JSON.stringify({ ...envelope, unexpected: true })).toString("base64url")}`;

    await expect(provider.verify({ ...publication, providerReference: tampered })).resolves.toBe(false);
  });

  it("fails closed for recomputed internal references and file entries with unexpected fields", () => {
    const extraReference = { ...reference, unexpected: true } as unknown as typeof reference;
    const extraFile = { ...reference, files: [{ ...reference.files[0]!, unexpected: true }, reference.files[1]!] } as unknown as typeof reference;
    expect(() => immutableReferenceHash(extraReference)).toThrow(expect.objectContaining({ code: "ARTIFACT_REFERENCE_INVALID" }));
    expect(() => immutableReferenceHash(extraFile)).toThrow(expect.objectContaining({ code: "ARTIFACT_REFERENCE_INVALID" }));
  });

  it("encodes the maximum valid 512-path manifest within the calculated provider-reference bound", async () => {
    const files = Object.fromEntries(Array.from({ length: 512 }, (_, index) => {
      const prefix = `assets/${index.toString().padStart(3, "0")}-`;
      return [`${prefix}${"a".repeat(512 - Buffer.byteLength(prefix, "utf8") - 4)}.txt`, "x"];
    }));
    const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
    const wide = {
      ...reference,
      outputHash: sha256(JSON.stringify(Object.fromEntries(entries))),
      routeDigest: sha256("[]"),
      fileCount: entries.length,
      byteSize: entries.length,
      files: entries.map(([path, body]) => ({ path, sha256: sha256(body), byteSize: 1 }))
    };
    const provider = new CloudflarePagesReleaseProvider({ projectKey: "pages-project", previewBranch: "preview", productionBranch: "main", coolifyApplicationKey: "coolify-app", resolver: { resolve: async () => ({ reference: wide, files }) }, cloudflare: new FakeCloudflare(), coolify: new FakeCoolify(), phases: new InMemoryDeliveryPhaseStore() });
    const publication = await provider.publish(input);
    expect(Buffer.byteLength(publication.providerReference, "utf8")).toBeGreaterThan(384 * 1024);
    expect(Buffer.byteLength(publication.providerReference, "utf8")).toBeLessThanOrEqual(CLOUDFLARE_DELIVERY_LIMITS.providerReferenceBytes);
  });

  it("can retain sanitized retry telemetry through the existing Event Ledger", async () => {
    const cloudflare = new FakeCloudflare();
    cloudflare.failDiscoveries = 1;
    const events = new InMemoryEventStore();
    const telemetry = new EventLedgerDeliveryTelemetry(events, {
      source: "urn:test:delivery",
      tenantId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      correlationId: "33333333-3333-4333-8333-333333333333",
      actor: { type: "service", id: "delivery-provider" }
    });
    const provider = createProvider(cloudflare, new FakeCoolify(), telemetry);

    await provider.publish(input);

    const records = await events.query({ correlationId: "33333333-3333-4333-8333-333333333333" });
    expect(records.some(({ event }) => event.type === "io.navocms.delivery.provider.attempt.v1" && event.data.errorCode === "CLOUDFLARE_HTTP_502")).toBe(true);
    expect(JSON.stringify(records)).not.toContain("token");
  });
});

function createProvider(cloudflare: FakeCloudflare, coolify: FakeCoolify, telemetry?: { record(record: import("./index.js").DeliveryTelemetryRecord): Promise<void> }) {
  return new CloudflarePagesReleaseProvider({
    projectKey: "pages-project",
    previewBranch: "preview",
    productionBranch: "main",
    coolifyApplicationKey: "coolify-app",
    resolver: { resolve: async () => deployable(reference) },
    cloudflare,
    coolify,
    phases: new InMemoryDeliveryPhaseStore(),
    ...(telemetry ? { telemetry } : {})
  });
}

function deployable(value = reference): DeployableArtifact {
  return { reference: value, files: { "en/index.html": "<html>en</html>", "fr/index.html": "<html>fr</html>" } };
}

class FakeCloudflare implements CloudflarePagesTransport {
  readonly deployments = new Map<string, CloudflareDeployment>();
  readonly createCalls: Parameters<CloudflarePagesTransport["createPreview"]>[0][] = [];
  readonly rollbackCalls: Parameters<CloudflarePagesTransport["rollback"]>[0][] = [];
  readonly retryCalls: Parameters<CloudflarePagesTransport["retryDeployment"]>[0][] = [];
  failDiscoveries = 0;
  liveStatus = 200;
  swappedLiveBytes = false;
  failRollbackAfterEffectOnce = false;
  failPreviewAfterEffectOnce = false;
  canonicalProductionId: string | undefined;

  public async findDeployment(input: Parameters<CloudflarePagesTransport["findDeployment"]>[0]): Promise<CloudflareDeployment | undefined> {
    if (this.failDiscoveries > 0) {
      this.failDiscoveries -= 1;
      throw new CloudflareDeliveryError("CLOUDFLARE_HTTP_502", "upstream unavailable", 502);
    }
    return this.deployments.get(`${input.referenceHash}:${input.environment}`);
  }

  public async createPreview(input: Parameters<CloudflarePagesTransport["createPreview"]>[0]): Promise<CloudflareDeployment> {
    this.createCalls.push(input);
    const deployment = { id: `preview-${this.createCalls.length}`, projectKey: input.projectKey, referenceHash: input.referenceHash, environment: "preview" as const, status: "success" as const };
    this.deployments.set(`${input.referenceHash}:preview`, deployment);
    if (this.failPreviewAfterEffectOnce) {
      this.failPreviewAfterEffectOnce = false;
      throw new CloudflareDeliveryError("CLOUDFLARE_HTTP_502", "proxy lost the deployment response", 502);
    }
    return deployment;
  }

  public async deployProduction(input: Parameters<CloudflarePagesTransport["deployProduction"]>[0]): Promise<CloudflareDeployment> {
    const deployment = { id: `production-${this.createCalls.length + 1}`, projectKey: input.projectKey, referenceHash: input.referenceHash, environment: "production" as const, status: "success" as const };
    this.deployments.set(`${input.referenceHash}:production`, deployment);
    this.canonicalProductionId = deployment.id;
    return deployment;
  }

  public async retryDeployment(input: Parameters<CloudflarePagesTransport["retryDeployment"]>[0]): Promise<CloudflareDeployment> {
    this.retryCalls.push(input);
    const deployment = this.deployments.get(`${input.referenceHash}:${input.environment}`);
    if (!deployment) throw new CloudflareDeliveryError("MISSING", "missing");
    const resumed = { ...deployment, status: "success" as const };
    this.deployments.set(`${input.referenceHash}:${input.environment}`, resumed);
    return resumed;
  }

  public async inspectDeployment(input: Parameters<CloudflarePagesTransport["inspectDeployment"]>[0]): Promise<CloudflareDeployment | undefined> {
    return [...this.deployments.values()].find((deployment) => deployment.id === input.deploymentId && deployment.projectKey === input.projectKey);
  }

  public async verifyLive(input: Parameters<CloudflarePagesTransport["verifyLive"]>[0]) {
    const deployment = this.deployments.get(`${input.referenceHash}:${input.environment}`);
    if (input.environment === "production" && this.canonicalProductionId !== input.deploymentId) return { status: 409 };
    return {
      status: this.liveStatus,
      referenceHash: input.referenceHash,
      ...(deployment ? { releaseHash: reference.releaseHash, outputHash: reference.outputHash, cacheControl: "public, max-age=300, must-revalidate", files: this.swappedLiveBytes ? [{ ...reference.files[0]!, sha256: "0".repeat(64) }, reference.files[1]!] : reference.files } : {})
    };
  }

  public async rollback(input: Parameters<CloudflarePagesTransport["rollback"]>[0]): Promise<void> {
    this.rollbackCalls.push(input);
    this.canonicalProductionId = input.targetDeploymentId;
    if (this.failRollbackAfterEffectOnce) {
      this.failRollbackAfterEffectOnce = false;
      throw new Error("interrupted Cloudflare rollback after effect");
    }
  }
}

class FakeCoolify implements CoolifyCommitTransport {
  readonly promotions = new Map<string, CoolifyPromotion>();
  readonly promoteCalls: Parameters<CoolifyCommitTransport["promoteCommit"]>[0][] = [];
  readonly rollbackCalls: Parameters<CoolifyCommitTransport["rollback"]>[0][] = [];
  readonly retryCalls: Parameters<CoolifyCommitTransport["retryPromotion"]>[0][] = [];
  failRollbackOnce = false;
  failRollbackAfterEffectOnce = false;
  failPromoteAfterEffectOnce = false;
  lastRollbackId: string | undefined;

  public async findPromotion(input: Parameters<CoolifyCommitTransport["findPromotion"]>[0]): Promise<CoolifyPromotion | undefined> { return this.promotions.get(`${input.sourceCommitSha}:${input.referenceHash}`); }
  public async promoteCommit(input: Parameters<CoolifyCommitTransport["promoteCommit"]>[0]): Promise<CoolifyPromotion> {
    this.promoteCalls.push(input);
    const promotion = { id: `promotion-${this.promoteCalls.length}`, applicationKey: input.applicationKey, sourceCommitSha: input.sourceCommitSha, referenceHash: input.referenceHash, status: "finished" as const };
    this.promotions.set(`${input.sourceCommitSha}:${input.referenceHash}`, promotion);
    if (this.failPromoteAfterEffectOnce) {
      this.failPromoteAfterEffectOnce = false;
      throw new CloudflareDeliveryError("COOLIFY_HTTP_502", "proxy lost the mutation response", 502);
    }
    return promotion;
  }
  public async retryPromotion(input: Parameters<CoolifyCommitTransport["retryPromotion"]>[0]): Promise<CoolifyPromotion> { this.retryCalls.push(input); return this.promoteCommit(input); }
  public async inspectPromotion(input: Parameters<CoolifyCommitTransport["inspectPromotion"]>[0]): Promise<CoolifyPromotion | undefined> { return [...this.promotions.values()].find((promotion) => promotion.id === input.promotionId && promotion.applicationKey === input.applicationKey); }
  public async rollback(input: Parameters<CoolifyCommitTransport["rollback"]>[0]): Promise<CoolifyPromotion> {
    this.rollbackCalls.push(input);
    if (this.failRollbackOnce) { this.failRollbackOnce = false; throw new Error("interrupted Coolify rollback"); }
    const target = this.promotions.get(`${input.targetCommitSha}:${input.referenceHash}`);
    if (!target) throw new Error("missing rollback target");
    this.lastRollbackId = target.id;
    if (this.failRollbackAfterEffectOnce) { this.failRollbackAfterEffectOnce = false; throw new Error("interrupted Coolify rollback after effect"); }
    return target;
  }
}

class CrashAfterCoolifyCheckpointStore extends InMemoryDeliveryPhaseStore {
  #crashed = false;
  public override async complete(input: Readonly<{ releaseId: string; referenceHash: string; phase: string; externalId: string }>): Promise<void> {
    await super.complete(input);
    if (!this.#crashed && input.phase === "rollback.coolify") { this.#crashed = true; throw new Error("simulated process interruption"); }
  }
}
