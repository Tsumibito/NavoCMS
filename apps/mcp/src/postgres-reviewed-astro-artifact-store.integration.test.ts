import { randomUUID } from "node:crypto";

import { dryRunCloudflareStaging } from "./staging-profile.js";
import { PostgresEditingRepository } from "./postgres-repository.js";
import { PostgresReleaseWorkflowRepository } from "./postgres-release-repository.js";
import { PostgresReviewedAstroArtifactStore, reviewedAstroArtifactAuthority, type RegisterReviewedAstroArtifactInput } from "./postgres-reviewed-astro-artifact-store.js";
import { LocalDeterministicReviewedAstroObjectStorage, reviewedAstroObjectPrefix } from "./reviewed-astro-object-storage.js";
import { PostgresReviewedAstroBuildInputStore } from "./postgres-reviewed-astro-build-input-store.js";
import { ReviewedAstroArtifactResolver } from "./reviewed-astro-resolver.js";
import { StagingAstroPreviewPreparer } from "./staging-astro-preview-preparer.js";
import { EmbeddedReleaseProvider } from "./release-repository.js";
import { McpEditingService, type IdempotencyStore, type StagingAstroOperations } from "./service.js";
import { PostgresDatabase, PostgresEventStore, PostgresIdempotencyStore } from "@navocms/persistence-postgres";
import { createReleaseManifest, renderMarkdownProofArtifact, sha256, type EventStore } from "@navocms/kernel";
import { NAVOCMS_PERMISSIONS, type AuthorizationContext } from "@navocms/security";
import type { AstroArtifact } from "@navocms/design-astro";
import { afterAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.NAVOCMS_INTEGRATION_DATABASE_URL;
const adminDatabaseUrl = process.env.NAVOCMS_INTEGRATION_ADMIN_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const policyIntegration = describe.skipIf(!databaseUrl || !adminDatabaseUrl);
const tenantId = "a2af348f-58b8-4efe-b873-8bd032ecbc5c";
const siteId = "2e0bcd4f-6780-470c-844b-d72abb6737ca";
const humanPrincipalId = "016ef382-bf28-406b-9321-1fc580b6ea00";
const servicePrincipalId = "216ef382-bf28-406b-9321-1fc580b6ea01";
const database = databaseUrl ? new PostgresDatabase({ connectionString: databaseUrl, applicationName: "navocms-reviewed-astro-integration", maxConnections: 4 }) : undefined;
const adminDatabase = adminDatabaseUrl ? new PostgresDatabase({ connectionString: adminDatabaseUrl, applicationName: "navocms-reviewed-astro-policy-integration", maxConnections: 1 }) : undefined;
const artifactStorage = new LocalDeterministicReviewedAstroObjectStorage();
const humanRepositoryContext = Object.freeze({
  site: { tenantId, siteId, name: "Persistence suite", primaryLocale: "en", locales: ["en"] },
  principalId: humanPrincipalId
});
const serviceRepositoryContext = Object.freeze({
  site: { tenantId, siteId, name: "Persistence suite", primaryLocale: "en", locales: ["en"] },
  principalId: servicePrincipalId
});
const binding = Object.freeze({
  schema: "io.navocms.cloudflare-staging-binding.v3" as const,
  tenantId, siteId, environment: "staging" as const,
  cloudflare: { accountId: "test-account", projectId: "test-pages", productionBranch: "staging", previewBranch: "preview", previewHostnameSuffix: ".pages.dev", allowedHostname: "staging.example.test", tokenSecretRef: "secret:delivery/cloudflare-token" }
});

afterAll(async () => { await database?.close(); await adminDatabase?.close(); });

integration("reviewed Astro artifact PostgreSQL boundary", () => {
  it("registers as a human, resolves after restart as a service, and rejects replay drift", async () => {
    const release = await createRelease("durable");
    const store = new PostgresReviewedAstroArtifactStore(database!, humanRepositoryContext, "default", { storage: artifactStorage });
    await expect(store.ready()).resolves.toBe(true);
    const input = registrationInput(release);
    const first = await store.register(input, authority());
    const replay = await store.register(structuredClone(input), authority());
    expect(replay).toEqual(first);

    const restartedStore = new PostgresReviewedAstroArtifactStore(database!, serviceRepositoryContext, "default", { storage: artifactStorage });
    const resolver = new ReviewedAstroArtifactResolver(restartedStore, { tenantId, siteId, environment: "staging", environmentKey: "default" });
    await expect(resolver.ready()).resolves.toBe(true);
    await expect(resolver.resolve({ releaseId: release.id, releaseHash: release.releaseHash, releaseArtifact: release.artifact })).resolves.toMatchObject({
      reference: { releaseHash: release.releaseHash, releaseArtifactHash: release.artifact.hash }
    });
    const dryRun = await dryRunCloudflareStaging({ context: requestContext(), binding, resolver, release: { releaseId: release.id, releaseHash: release.releaseHash, artifact: release.artifact } });
    expect(dryRun).toEqual({ referenceHash: expect.any(String), cloudflareProjectId: "test-pages" });

    await expect(store.register({ ...input, output: { ...input.output, "assets/drift.txt": "different" } }, authority())).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(store.register({ ...input, idempotencyKey: `reviewed-second-${randomUUID()}`, output: { ...input.output, "assets/drift.txt": "different" } }, authority())).rejects.toMatchObject({ code: "REVIEWED_ASTRO_ARTIFACT_DRIFT" });

    const events = await new PostgresEventStore(database!).query({ tenantId, siteId, principalId: servicePrincipalId, type: "io.navocms.release.astro-artifact-registered.v1" });
    const event = events.find(({ event: candidate }) => candidate.data.releaseId === release.id)?.event;
    expect(event).toMatchObject({ navoactor: { id: humanPrincipalId, type: "human" }, navoconsequence: "G1", navocorrelationid: release.correlationId });
    const columns = await database!.withScope({ tenantId, siteId, principalId: servicePrincipalId }, async (client) => (
      await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'navocms' AND table_name = 'reviewed_astro_artifact_object_bindings'")
    ).rows.map(({ column_name }) => column_name));
    expect(columns).not.toContain("artifact_json");
    expect(columns).not.toContain("output_json");
  });

  it("serializes concurrent registrations and rolls back artifact, idempotency, ledger, and outbox after event failure", async () => {
    const concurrentRelease = await createRelease("concurrent");
    const input = registrationInput(concurrentRelease);
    const first = new PostgresReviewedAstroArtifactStore(database!, humanRepositoryContext, "default", { storage: artifactStorage });
    const second = new PostgresReviewedAstroArtifactStore(database!, humanRepositoryContext, "default", { storage: artifactStorage });
    const results = await Promise.all([first.register(input, authority()), second.register(structuredClone(input), authority())]);
    expect(results[0]).toEqual(results[1]);
    const concurrentCount = await database!.withScope({ tenantId, siteId, principalId: servicePrincipalId }, async (client) => (
      await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM navocms.reviewed_astro_artifact_object_bindings WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3",
        [tenantId, siteId, concurrentRelease.id]
      )).rows[0]!.count
    );
    expect(concurrentCount).toBe("1");

    const failedRelease = await createRelease("rollback");
    const failedInput = registrationInput(failedRelease, "rollback-orphan");
    const objectsBeforeFailure = await artifactStorage.inventory(reviewedAstroObjectPrefix({ tenantId, siteId }), 100);
    const persisted = new PostgresEventStore(database!);
    const failingEvents: EventStore = {
      append: async (event) => { await persisted.append(event); throw new Error("injected event/outbox failure"); },
      query: (query) => persisted.query(query)
    };
    const failingStore = new PostgresReviewedAstroArtifactStore(database!, humanRepositoryContext, "default", { events: failingEvents, storage: artifactStorage });
    await expect(failingStore.register(failedInput, authority())).rejects.toThrow("injected event/outbox failure");
    const counts = await database!.withScope({ tenantId, siteId, principalId: servicePrincipalId }, async (client) => (
      await client.query<{ artifacts: string; idempotency: string; ledger: string; outbox: string }>(
        `SELECT
          (SELECT count(*) FROM navocms.reviewed_astro_artifact_object_bindings WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3) AS artifacts,
          (SELECT count(*) FROM navocms.idempotency_records WHERE tenant_id = $1 AND site_id = $2 AND operation = $4 AND idempotency_key = $5) AS idempotency,
          (SELECT count(*) FROM navocms.event_ledger WHERE tenant_id = $1 AND site_id = $2 AND idempotency_key = $6) AS ledger,
          (SELECT count(*) FROM navocms.domain_outbox WHERE tenant_id = $1 AND site_id = $2 AND idempotency_key = $6) AS outbox`,
        [tenantId, siteId, failedRelease.id, "reviewed_astro_artifact.register.v1", failedInput.idempotencyKey, `reviewed_astro_artifact.register.v1:${failedInput.idempotencyKey}`]
      )).rows[0]!
    );
    expect(counts).toEqual({ artifacts: "0", idempotency: "0", ledger: "0", outbox: "0" });
    const objectsAfterFailure = await artifactStorage.inventory(reviewedAstroObjectPrefix({ tenantId, siteId }), 100);
    expect(objectsAfterFailure.objects).toHaveLength(objectsBeforeFailure.objects.length + 2);
  });

  it("allows two releases in one site to reuse exactly the same immutable source and output objects", async () => {
    const firstRelease = await createRelease("shared-one");
    const secondRelease = await createRelease("shared-two");
    const store = new PostgresReviewedAstroArtifactStore(database!, humanRepositoryContext, "default", { storage: artifactStorage });
    const firstInput = registrationInput(firstRelease, "shared-object");
    const secondInput: RegisterReviewedAstroArtifactInput = Object.freeze({
      ...firstInput, idempotencyKey: `reviewed-shared-${randomUUID()}`,
      releaseId: secondRelease.id, releaseHash: secondRelease.releaseHash, releaseArtifactHash: secondRelease.artifact.hash
    });
    const before = await artifactStorage.inventory(reviewedAstroObjectPrefix({ tenantId, siteId }), 100);
    await store.register(firstInput, authority());
    const afterFirst = await artifactStorage.inventory(reviewedAstroObjectPrefix({ tenantId, siteId }), 100);
    await store.register(secondInput, authority());
    const afterSecond = await artifactStorage.inventory(reviewedAstroObjectPrefix({ tenantId, siteId }), 100);
    expect(afterFirst.objects).toHaveLength(before.objects.length + 2);
    expect(afterSecond.objects).toHaveLength(afterFirst.objects.length);
    const rows = await database!.withScope({ tenantId, siteId, principalId: servicePrincipalId }, async (client) => (
      await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM navocms.reviewed_astro_artifact_object_bindings
          WHERE tenant_id = $1 AND site_id = $2 AND release_id = ANY($3::uuid[])`,
        [tenantId, siteId, [firstRelease.id, secondRelease.id]]
      )).rows[0]!.count
    );
    expect(rows).toBe("2");
  });

  it("reads a legacy row when no object binding exists", async () => {
    const release = await createRelease("legacy");
    const input = registrationInput(release);
    await database!.withScope({ tenantId, siteId, principalId: servicePrincipalId }, async (client) => {
      await client.query(
        `INSERT INTO navocms.reviewed_astro_artifacts (
           tenant_id, site_id, environment_id, environment_key, release_id, release_hash,
           artifact_hash, astro_artifact_hash, source_commit_sha, artifact_json, output_json
         ) SELECT r.tenant_id, r.site_id, r.environment_id, $1, r.id, r.release_hash,
                  r.artifact_hash, $2, $3, $4::jsonb, $5::jsonb
             FROM navocms.release_candidates r WHERE r.tenant_id = $6 AND r.site_id = $7 AND r.id = $8`,
        ["default", input.expectedAstroArtifactHash, input.sourceCommitSha, JSON.stringify(input.artifact), JSON.stringify(input.output), tenantId, siteId, release.id]
      );
    });
    const legacyOnly = new PostgresReviewedAstroArtifactStore(database!, serviceRepositoryContext, "default");
    await expect(legacyOnly.get({ tenantId, siteId, environment: "staging", environmentKey: "default", releaseId: release.id })).resolves.toMatchObject({ expectedAstroArtifactHash: input.expectedAstroArtifactHash, output: input.output });
  });

  it("rejects malformed, missing, extra, and oversized source/output before SQL", async () => {
    const release = await createRelease("invalid");
    const store = new PostgresReviewedAstroArtifactStore(database!, humanRepositoryContext, "default", { storage: artifactStorage });
    const input = registrationInput(release);
    const cases: readonly RegisterReviewedAstroArtifactInput[] = [
      { ...input, idempotencyKey: `reviewed-missing-${randomUUID()}`, artifact: { ...input.artifact, files: {} } },
      { ...input, idempotencyKey: `reviewed-tampered-${randomUUID()}`, artifact: { ...input.artifact, files: { ...input.artifact.files, "src/pages/index.astro": "tampered" } } },
      { ...input, idempotencyKey: `reviewed-extra-${randomUUID()}`, artifact: { ...input.artifact, files: { ...input.artifact.files, "src/extra.astro": "extra" } } },
      { ...input, idempotencyKey: `reviewed-output-${randomUUID()}`, output: { "index.html": `${html()}${"x".repeat(8 * 1024 * 1024)}` } }
    ];
    for (const candidate of cases) {
      await expect(store.register(candidate, authority())).rejects.toMatchObject({ code: "REVIEWED_ASTRO_ARTIFACT_INVALID" });
    }
    const count = await database!.withScope({ tenantId, siteId, principalId: servicePrincipalId }, async (client) => (
      await client.query<{ count: string }>("SELECT count(*)::text AS count FROM navocms.reviewed_astro_artifact_object_bindings WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3", [tenantId, siteId, release.id])
    ).rows[0]!.count);
    expect(count).toBe("0");
  });
});

policyIntegration("reviewed Astro artifact readiness policy", () => {
  it("fails closed when an additional permissive policy is present", async () => {
    const store = new PostgresReviewedAstroArtifactStore(database!, serviceRepositoryContext, "default", { storage: artifactStorage });
    await expect(store.ready()).resolves.toBe(true);
    try {
      await adminDatabase!.withScope({ tenantId, siteId, principalId: servicePrincipalId }, async (client) => {
        await client.query("CREATE POLICY reviewed_astro_artifact_object_bindings_extra_scope ON navocms.reviewed_astro_artifact_object_bindings TO navocms_app USING (true) WITH CHECK (true)");
      });
      await expect(store.ready()).resolves.toBe(false);
    } finally {
      await adminDatabase!.withScope({ tenantId, siteId, principalId: servicePrincipalId }, async (client) => {
        await client.query("DROP POLICY IF EXISTS reviewed_astro_artifact_object_bindings_extra_scope ON navocms.reviewed_astro_artifact_object_bindings");
      });
    }
    await expect(store.ready()).resolves.toBe(true);
  });
});

integration("reviewed Astro build-input PostgreSQL boundary", () => {
  it("reloads exact durable release evidence across restart and rejects manifest/hash promotion", async () => {
    const bound = await createBoundAstroRelease("input-restart");
    const store = new PostgresReviewedAstroBuildInputStore(database!, humanRepositoryContext, "default");
    await expect(store.ready()).resolves.toBe(true);
    const input = { idempotencyKey: `astro-input-${randomUUID()}`, releaseId: bound.release.id, releaseHash: bound.release.releaseHash, releaseArtifactHash: bound.release.artifactHash, render: bound.render };
    const first = await store.register(requestContext(), input);
    await expect(store.register(requestContext(), structuredClone(input))).resolves.toEqual(first);
    const restarted = new PostgresReviewedAstroBuildInputStore(database!, serviceRepositoryContext, "default");
    await expect(restarted.get({ tenantId, siteId, environment: "staging", environmentKey: "default", releaseId: bound.release.id })).resolves.toMatchObject({ releaseHash: bound.release.releaseHash, bindingDigest: first.bindingDigest });
    await expect(store.register(requestContext(), { ...input, idempotencyKey: `astro-drift-${randomUUID()}`, releaseHash: "f".repeat(64) })).rejects.toMatchObject({ code: "REVIEWED_ASTRO_RELEASE_BINDING_MISMATCH" });
    await expect(store.register(requestContext(), { ...input, idempotencyKey: `astro-anchor-${randomUUID()}`, render: { ...bound.render, anchors: { ...bound.render.anchors, governance: `sha256:${"f".repeat(64)}` } } })).rejects.toMatchObject({ code: "REVIEWED_ASTRO_BUILD_INPUT_INVALID" });
  });

  it("rolls back snapshot, idempotency, ledger and outbox when event append fails", async () => {
    const bound = await createBoundAstroRelease("input-rollback");
    const idempotencyKey = `astro-input-failure-${randomUUID()}`;
    const persisted = new PostgresEventStore(database!);
    const failingEvents: EventStore = { append: async (event) => { await persisted.append(event); throw new Error("injected input event failure"); }, query: (query) => persisted.query(query) };
    const store = new PostgresReviewedAstroBuildInputStore(database!, humanRepositoryContext, "default", { events: failingEvents });
    await expect(store.register(requestContext(), { idempotencyKey, releaseId: bound.release.id, releaseHash: bound.release.releaseHash, releaseArtifactHash: bound.release.artifactHash, render: bound.render })).rejects.toThrow("injected input event failure");
    const counts = await database!.withScope({ tenantId, siteId, principalId: servicePrincipalId }, async (client) => (
      await client.query<{ input: string; idempotency: string; ledger: string; outbox: string }>(
        `SELECT (SELECT count(*) FROM navocms.reviewed_astro_build_inputs WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3) AS input,
                (SELECT count(*) FROM navocms.idempotency_records WHERE tenant_id = $1 AND site_id = $2 AND operation = $4 AND idempotency_key = $5) AS idempotency,
                (SELECT count(*) FROM navocms.event_ledger WHERE tenant_id = $1 AND site_id = $2 AND idempotency_key = $6) AS ledger,
                (SELECT count(*) FROM navocms.domain_outbox WHERE tenant_id = $1 AND site_id = $2 AND idempotency_key = $6) AS outbox`,
        [tenantId, siteId, bound.release.id, "reviewed_astro_build_input.register.v1", idempotencyKey, `reviewed_astro_build_input.register.v1:${idempotencyKey}`]
      )).rows[0]!
    );
    expect(counts).toEqual({ input: "0", idempotency: "0", ledger: "0", outbox: "0" });
  });

  it("atomically rolls back the preview release and reviewed input when post-registration composition fails", async () => {
    const suffix = randomUUID().replace(/-/g, "");
    const repository = new PostgresEditingRepository(database!);
    const preparer = new StagingAstroPreviewPreparer();
    let attemptedRelease: Parameters<StagingAstroOperations["persistPreviewInput"]>[2] | undefined;
    const operations: StagingAstroOperations = {
      prepare: async (_context, site, revision) => preparer.prepare(site, revision),
      persistPreviewInput: async (context, repositoryContext, release, render) => {
        attemptedRelease = release;
        await new PostgresReviewedAstroBuildInputStore(database!, repositoryContext, "default").register(context, {
          idempotencyKey: `astro-input:${release.releaseHash}`,
          releaseId: release.id,
          releaseHash: release.releaseHash,
          releaseArtifactHash: release.artifactHash,
          render
        });
        throw new Error("injected post-input failure");
      },
      ensureArtifact: async () => undefined
    };
    const service = new McpEditingService(repository, new PostgresEventStore(database!), new PostgresIdempotencyStore(database!) as IdempotencyStore,
      new PostgresReleaseWorkflowRepository(database!), new EmbeddedReleaseProvider(), { environmentKey: "staging" }, database!, undefined, operations);
    const draft = await service.createDraft(requestContext(), { typeName: "article", slug: `atomic-${suffix}`, locale: "en", title: "Atomic preview", markdown: "# Atomic preview\n", idempotencyKey: `atomic-draft-${suffix}` }) as { draft: { revisionId: string } };
    const previewKey = `atomic-preview-${suffix}`;
    await expect(service.preparePreview(requestContext(), draft.draft.revisionId, previewKey)).rejects.toThrow("injected post-input failure");
    expect(attemptedRelease).toBeDefined();
    const release = attemptedRelease!;
    const inputKey = `astro-input:${release.releaseHash}`;
    const eventKey = `reviewed_astro_build_input.register.v1:${inputKey}`;
    const counts = await database!.withScope({ tenantId, siteId, principalId: servicePrincipalId }, async (client) => (
      await client.query<{ releases: string; inputs: string; preview_idempotency: string; input_idempotency: string; ledger: string; outbox: string }>(
        `SELECT
           (SELECT count(*) FROM navocms.release_candidates WHERE tenant_id = $1 AND site_id = $2 AND id = $3) AS releases,
           (SELECT count(*) FROM navocms.reviewed_astro_build_inputs WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3) AS inputs,
           (SELECT count(*) FROM navocms.idempotency_records WHERE tenant_id = $1 AND site_id = $2 AND operation = 'preview_create' AND idempotency_key = $4) AS preview_idempotency,
           (SELECT count(*) FROM navocms.idempotency_records WHERE tenant_id = $1 AND site_id = $2 AND operation = 'reviewed_astro_build_input.register.v1' AND idempotency_key = $5) AS input_idempotency,
           (SELECT count(*) FROM navocms.event_ledger WHERE tenant_id = $1 AND site_id = $2 AND idempotency_key = $6) AS ledger,
           (SELECT count(*) FROM navocms.domain_outbox WHERE tenant_id = $1 AND site_id = $2 AND idempotency_key = $6) AS outbox`,
        [tenantId, siteId, release.id, previewKey, inputKey, eventKey]
      )).rows[0]!
    );
    expect(counts).toEqual({ releases: "0", inputs: "0", preview_idempotency: "0", input_idempotency: "0", ledger: "0", outbox: "0" });
  });
});

async function createRelease(label: string) {
  const service = new McpEditingService(
    new PostgresEditingRepository(database!),
    new PostgresEventStore(database!),
    new PostgresIdempotencyStore(database!) as IdempotencyStore,
    new PostgresReleaseWorkflowRepository(database!),
    new EmbeddedReleaseProvider(),
    { environmentKey: "staging", previewBaseUrl: "https://staging-cms.navocms.test" },
    database!
  );
  const suffix = randomUUID().replace(/-/g, "");
  const draft = await service.createDraft(requestContext(), {
    typeName: "article", slug: `reviewed-${label}-${suffix}`, locale: "en", title: `Reviewed ${label}`,
    markdown: `# Reviewed ${label}\n`, idempotencyKey: `reviewed-draft-${suffix}`
  }) as { draft: { revisionId: string } };
  const preview = await service.preparePreview(requestContext(), draft.draft.revisionId, `reviewed-preview-${suffix}`);
  const stored = await new PostgresReleaseWorkflowRepository(database!).getRelease(serviceRepositoryContext, preview.releaseId);
  return stored;
}

async function createBoundAstroRelease(label: string) {
  const service = new McpEditingService(new PostgresEditingRepository(database!), new PostgresEventStore(database!), new PostgresIdempotencyStore(database!) as IdempotencyStore, new PostgresReleaseWorkflowRepository(database!), new EmbeddedReleaseProvider(), { environmentKey: "staging" }, database!);
  const suffix = randomUUID().replace(/-/g, "");
  const draft = await service.createDraft(requestContext(), { typeName: "article", slug: `astro-${label}-${suffix}`, locale: "en", title: `Astro ${label}`, markdown: "# Astro input\n", idempotencyKey: `astro-draft-${suffix}` }) as { draft: { revisionId: string } };
  const repository = new PostgresEditingRepository(database!); const releases = new PostgresReleaseWorkflowRepository(database!);
  const revision = await repository.getRevision(humanRepositoryContext, draft.draft.revisionId);
  const render = new StagingAstroPreviewPreparer().prepare(humanRepositoryContext.site, revision);
  const environmentId = await releases.environmentId(humanRepositoryContext, "staging");
  const { manifest, releaseHash } = createReleaseManifest({ tenantId, siteId, environmentId, revisionId: revision.id, sourceHash: revision.sourceHash, workflow: await repository.workflowFor(humanRepositoryContext, revision.id), anchors: Object.fromEntries(Object.entries(render.anchors).map(([key, value]) => [key, value.slice(7)])) });
  const release = await releases.createPreview({ context: humanRepositoryContext, environmentKey: "staging", revisionId: revision.id, workflow: manifest.workflow, manifest, releaseHash, artifact: renderMarkdownProofArtifact({ releaseHash, title: `Astro ${label}`, locale: "en", markdown: revision.source }), previewTokenHash: sha256(`preview-${suffix}`), previewExpiresAt: new Date(Date.now() + 60_000).toISOString(), correlationId: revision.documentId });
  return { release, render };
}

function registrationInput(release: Awaited<ReturnType<typeof createRelease>>, marker = "reviewed"): RegisterReviewedAstroArtifactInput {
  const artifact = astroArtifact(marker);
  return Object.freeze({
    idempotencyKey: `reviewed-register-${randomUUID()}`,
    releaseId: release.id,
    releaseHash: release.releaseHash,
    releaseArtifactHash: release.artifact.hash,
    expectedAstroArtifactHash: artifact.hash,
    sourceCommitSha: "c".repeat(40),
    artifact,
    output: Object.freeze({ "index.html": html(marker) })
  });
}

function astroArtifact(marker = "reviewed"): AstroArtifact {
  const source = Object.freeze({ "src/pages/index.astro": `<main>${marker}</main>` });
  const manifest = Object.freeze({
    schema: "io.navocms.astro-artifact.v1" as const,
    format: "navocms-astro-source-bundle/v1" as const,
    tenantId,
    siteId,
    digests: Object.freeze({ content: `sha256:${"a".repeat(64)}`, design: `sha256:${"b".repeat(64)}`, delivery: `sha256:${"c".repeat(64)}`, governance: `sha256:${"d".repeat(64)}`, registrations: `sha256:${"e".repeat(64)}`, media: `sha256:${"f".repeat(64)}` }),
    files: Object.freeze(Object.entries(source).map(([path, body]) => Object.freeze({ path, sha256: sha256(body) })))
  });
  const files = Object.freeze({ ...source, "navocms-artifact-manifest.json": canonical(manifest) });
  return Object.freeze({ format: "navocms-astro-source-bundle/v1" as const, manifest, files, hash: `sha256:${sha256(canonical({ manifest, files }))}` });
}

function html(marker = "reviewed"): string {
  return `<!doctype html><html><head><meta data-navocms-consent-bridge="io.navocms.consent-bridge.v1"><meta data-navocms-analytics-bootstrap="io.navocms.analytics-bootstrap.v1"><script src="/cdn-cgi/zaraz/i.js" data-navocms-zaraz-loader="v1"></script></head><body>${marker}</body></html>`;
}

function authority() { return reviewedAstroArtifactAuthority(requestContext()); }
function requestContext(): { authorization: AuthorizationContext } {
  return { authorization: { tenantId, siteId, principal: { id: humanPrincipalId, kind: "human", issuer: "urn:navocms:integration", subject: "sprint-6" }, layers: [
    { name: "principal", permissions: NAVOCMS_PERMISSIONS }, { name: "site", permissions: NAVOCMS_PERMISSIONS }, { name: "operation", permissions: NAVOCMS_PERMISSIONS }
  ] } };
}
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
