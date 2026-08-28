import {
  PostgresDatabase,
  PostgresEventStore,
  PostgresIdentityResolver,
  PostgresIdempotencyStore,
  PostgresRuntimePolicyGuard
} from "@navocms/persistence-postgres";
import { sha256, type EventStore, type ReleaseProvider, type ReleaseProviderPublication, type ReleaseProviderPublishInput } from "@navocms/kernel";
import { randomUUID } from "node:crypto";
import { NAVOCMS_PERMISSIONS, effectivePermissions, type AuthorizationContext } from "@navocms/security";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresEditingRepository } from "./postgres-repository.js";
import { PostgresDeliveryPhaseStore } from "./postgres-delivery-phase-store.js";
import { PostgresReleaseWorkflowRepository } from "./postgres-release-repository.js";
import { EmbeddedReleaseProvider } from "./release-repository.js";
import { McpEditingService, type IdempotencyStore } from "./service.js";
import { assertPinnedProductionProfile } from "./production-profile.js";

const databaseUrl = process.env.NAVOCMS_INTEGRATION_DATABASE_URL;
const adminDatabaseUrl = process.env.NAVOCMS_INTEGRATION_ADMIN_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl || !adminDatabaseUrl);
const tenantId = "a2af348f-58b8-4efe-b873-8bd032ecbc5c";
const siteId = "2e0bcd4f-6780-470c-844b-d72abb6737ca";
const principalId = "016ef382-bf28-406b-9321-1fc580b6ea00";
const database = databaseUrl ? new PostgresDatabase({
  connectionString: databaseUrl,
  applicationName: "navocms-neon-integration",
  maxConnections: 2
}) : undefined;
const adminDatabase = adminDatabaseUrl ? new PostgresDatabase({
  connectionString: adminDatabaseUrl,
  applicationName: "navocms-integration-policy-admin",
  maxConnections: 1
}) : undefined;

afterAll(async () => {
  await database?.close();
  await adminDatabase?.close();
});

integration("Neon production persistence", () => {
  it("persists site-scoped drafts, events, and idempotent responses across service instances", async () => {
    const first = service();
    const input = {
      typeName: "article",
      slug: "sprint-six-neon-check",
      locale: "en",
      title: "Sprint six Neon check",
      markdown: "# Sprint six Neon check\n\nPersistent Markdown.\n",
      idempotencyKey: "sprint-six-neon-draft-0001"
    } as const;
    const created = await first.createDraft(context(), input) as { draft: { revisionId: string; sourceHash: string } };
    const second = service();
    const retried = await second.createDraft(context(), input) as { draft: { revisionId: string; sourceHash: string } };
    expect(retried.draft).toEqual(created.draft);
    await expect(second.getContent(context(), created.draft.revisionId)).resolves.toMatchObject({
      sourceHash: created.draft.sourceHash,
      markdown: "# Sprint six Neon check\n\nPersistent Markdown.\n"
    });
    await expect(database!.ready()).resolves.toBe(true);
  });

  it("rolls back the mutation, idempotency record, ledger, and outbox when event persistence fails", async () => {
    const suffix = randomUUID().replace(/-/g, "");
    const slug = `rollback-${suffix}`;
    const idempotencyKey = `rollback-${suffix}`;
    const persistedEvents = new PostgresEventStore(database!);
    const events: EventStore = {
      append: async (event) => {
        await persistedEvents.append(event);
        throw new Error("injected failure after ledger and outbox persistence");
      },
      query: (query) => persistedEvents.query(query)
    };
    const failingService = service(events);
    await expect(failingService.createDraft(context(), {
      typeName: "article", slug, locale: "en", title: "Rollback proof",
      markdown: "# Rollback proof\n", idempotencyKey
    })).rejects.toThrow("injected failure after ledger and outbox persistence");

    const counts = await database!.withScope({ tenantId, siteId, principalId }, async (client) => {
      const result = await client.query<{ documents: string; idempotency: string; events: string; outbox: string }>(
        `SELECT
           (SELECT count(*) FROM navocms.content_documents WHERE tenant_id = $1 AND site_id = $2 AND slug = $3) AS documents,
           (SELECT count(*) FROM navocms.idempotency_records WHERE tenant_id = $1 AND site_id = $2 AND idempotency_key = $4) AS idempotency,
           (SELECT count(*) FROM navocms.event_ledger WHERE tenant_id = $1 AND site_id = $2 AND idempotency_key = $4) AS events,
           (SELECT count(*) FROM navocms.domain_outbox WHERE tenant_id = $1 AND site_id = $2 AND idempotency_key = $4) AS outbox`,
        [tenantId, siteId, slug, idempotencyKey]
      );
      return result.rows[0]!;
    });
    expect(counts).toEqual({ documents: "0", idempotency: "0", events: "0", outbox: "0" });
  });

  it("persists exact release approval, publication checkpoints, and preview capability", async () => {
    const releaseService = service();
    const created = await releaseService.createDraft(context(), {
      typeName: "article",
      slug: "sprint-seven-release-check",
      locale: "en",
      title: "Sprint seven release check",
      markdown: "# Sprint seven release check\n\nImmutable release proof.\n",
      idempotencyKey: "sprint-seven-neon-draft-0001"
    }) as { draft: { revisionId: string } };
    const preview = await releaseService.preparePreview(context(), created.draft.revisionId, "sprint-seven-neon-preview-0001");
    const token = preview.previewUrl.split("/").at(-1)!;
    await expect(releaseService.resolvePreview(token)).resolves.toMatchObject({ body: expect.stringContaining(preview.releaseHash) });
    await releaseService.approveRelease(context(), {
      releaseId: preview.releaseId,
      releaseHash: preview.releaseHash,
      idempotencyKey: "sprint-seven-neon-approve-0001"
    });
    await expect(releaseService.publishRelease(context(), {
      releaseId: preview.releaseId,
      releaseHash: preview.releaseHash,
      idempotencyKey: "sprint-seven-neon-publish-0001"
    })).resolves.toMatchObject({ release: { status: "published", artifactHash: preview.artifactHash } });
  });

  it("persists rollback.pending across a service restart and completes it only after reconcile", async () => {
    const suffix = randomUUID().replace(/-/g, "");
    const provider = new InterruptingRollbackProvider();
    const firstService = service(new PostgresEventStore(database!), undefined, provider);
    const first = await approvedRelease(firstService, suffix, "first");
    await firstService.publishRelease(context(), { releaseId: first.releaseId, releaseHash: first.releaseHash, idempotencyKey: `publish-${suffix}-first` });
    const second = await approvedRelease(firstService, suffix, "second");
    await firstService.publishRelease(context(), { releaseId: second.releaseId, releaseHash: second.releaseHash, idempotencyKey: `publish-${suffix}-second` });
    provider.interruptOnce = true;
    await expect(firstService.rollbackRelease(context(), { releaseId: second.releaseId, releaseHash: second.releaseHash, idempotencyKey: `rollback-${suffix}` })).rejects.toThrow("injected rollback interruption");

    const restartedService = service(new PostgresEventStore(database!), undefined, provider);
    await expect(restartedService.reconcileRelease(context(), { releaseId: second.releaseId, releaseHash: second.releaseHash, idempotencyKey: `reconcile-${suffix}` })).resolves.toMatchObject({ release: { status: "rolled_back" }, publication: { releaseId: first.releaseId } });
    const steps = await database!.withScope({ tenantId, siteId, principalId }, async (client) => (
      await client.query<{ step_key: string }>(
        `SELECT checkpoint.step_key FROM navocms.workflow_checkpoints checkpoint
           JOIN navocms.workflow_runs run ON run.id = checkpoint.run_id
          WHERE run.tenant_id = $1 AND run.site_id = $2 AND run.release_id = $3
            AND checkpoint.step_key IN ('rollback.pending', 'rollback.completed')
          ORDER BY checkpoint.completed_at`,
        [tenantId, siteId, second.releaseId]
      )).rows.map((row) => row.step_key)
    );
    expect(steps).toEqual(["rollback.pending", "rollback.completed"]);
    expect(provider.rollbackCalls).toBe(2);

    const descriptor = await new PostgresEditingRepository(database!).getSite({ tenantId, siteId, principalId });
    if (!descriptor) throw new Error("integration site missing");
    const phaseInput = { releaseId: second.releaseId, referenceHash: "a".repeat(64), phase: "rollback.coolify" };
    const phaseBeforeRestart = new PostgresDeliveryPhaseStore(database!, { site: descriptor, principalId });
    await expect(phaseBeforeRestart.reserve(phaseInput)).resolves.toBe("new");
    await phaseBeforeRestart.complete({ ...phaseInput, externalId: "coolify-restarted-1" });
    const phaseAfterRestart = new PostgresDeliveryPhaseStore(database!, { site: descriptor, principalId });
    await expect(phaseAfterRestart.reserve(phaseInput)).resolves.toBe("completed");
    await expect(phaseAfterRestart.externalId(phaseInput)).resolves.toBe("coolify-restarted-1");

    const concurrentInput = { releaseId: second.releaseId, referenceHash: "b".repeat(64), phase: "publish.coolify" };
    const firstConcurrent = new PostgresDeliveryPhaseStore(database!, { site: descriptor, principalId });
    const secondConcurrent = new PostgresDeliveryPhaseStore(database!, { site: descriptor, principalId });
    const reservations = await Promise.all([firstConcurrent.reserve(concurrentInput), secondConcurrent.reserve(concurrentInput)]);
    expect([...reservations].sort()).toEqual(["new", "reserved"]);
    const reservationStep = `delivery.${sha256(`${concurrentInput.referenceHash}:${concurrentInput.phase}`)}.reserved`;
    const reservationCount = await database!.withScope({ tenantId, siteId, principalId }, async (client) => (
      await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM navocms.workflow_checkpoints checkpoint
           JOIN navocms.workflow_runs run ON run.id = checkpoint.run_id AND run.tenant_id = checkpoint.tenant_id AND run.site_id = checkpoint.site_id
          WHERE run.tenant_id = $1 AND run.site_id = $2 AND run.release_id = $3 AND checkpoint.step_key = $4`,
        [tenantId, siteId, second.releaseId, reservationStep]
      )).rows[0]!.count
    );
    expect(reservationCount).toBe("1");

    const unknownInput = { releaseId: second.releaseId, referenceHash: "c".repeat(64), phase: "rollback.coolify" };
    const reservedBeforeRestart = new PostgresDeliveryPhaseStore(database!, { site: descriptor, principalId });
    await expect(reservedBeforeRestart.reserve(unknownInput)).resolves.toBe("new");
    const reservedAfterRestart = new PostgresDeliveryPhaseStore(database!, { site: descriptor, principalId }, { authority: { principal: { id: principalId, kind: "human" }, permissions: ["content:publish"] }, events: new PostgresEventStore(database!) });
    await expect(reservedAfterRestart.reserve(unknownInput)).resolves.toBe("reserved");
    await reservedAfterRestart.resolve({ ...unknownInput, externalId: "coolify-human-resolved-1", evidenceHash: "d".repeat(64), observedAt: "2026-08-25T00:00:00.000Z" });
    await expect(reservedAfterRestart.resolution(unknownInput)).resolves.toMatchObject({ attempt: 1, externalId: "coolify-human-resolved-1", actor: { kind: "human", id: principalId } });
    await expect(reservedAfterRestart.notApplied({ ...unknownInput, evidenceHash: "e".repeat(64), observedAt: "2026-08-26T00:00:00.000Z" })).rejects.toMatchObject({ code: "DELIVERY_PHASE_OUTCOME_CONFLICT" });
    await reservedAfterRestart.complete({ ...unknownInput, externalId: "coolify-human-resolved-1" });
    const completedAfterRestart = new PostgresDeliveryPhaseStore(database!, { site: descriptor, principalId });
    await expect(completedAfterRestart.reserve(unknownInput)).resolves.toBe("completed");

    const beforeEffect = { releaseId: second.releaseId, referenceHash: "e".repeat(64), phase: "publish.coolify" };
    const recovery = new PostgresDeliveryPhaseStore(database!, { site: descriptor, principalId }, { authority: { principal: { id: principalId, kind: "human" }, permissions: ["content:publish"] }, events: new PostgresEventStore(database!) });
    await expect(recovery.reserve(beforeEffect)).resolves.toBe("new");
    await recovery.notApplied({ ...beforeEffect, evidenceHash: "f".repeat(64), observedAt: "2026-08-26T00:00:00.000Z" });
    await expect(recovery.resolve({ ...beforeEffect, externalId: "coolify-attempt-one", evidenceHash: "d".repeat(64), observedAt: "2026-08-26T00:00:01.000Z" })).rejects.toMatchObject({ code: "DELIVERY_PHASE_OUTCOME_CONFLICT" });
    await expect(recovery.reserve(beforeEffect)).resolves.toBe("new");
    await expect(recovery.attempt(beforeEffect)).resolves.toBe(2);
    await recovery.resolve({ ...beforeEffect, externalId: "coolify-attempt-two", evidenceHash: "d".repeat(64), observedAt: "2026-08-26T00:00:01.000Z" });
    await expect(recovery.resolution(beforeEffect)).resolves.toMatchObject({ attempt: 2, externalId: "coolify-attempt-two" });
    await expect(recovery.notApplied({ ...beforeEffect, evidenceHash: "a".repeat(64), observedAt: "2026-08-26T00:00:01.000Z" })).rejects.toMatchObject({ code: "DELIVERY_PHASE_NOT_APPLIED_INVALID" });
    expect(() => new PostgresDeliveryPhaseStore(database!, { site: descriptor, principalId }, { authority: { principal: { id: principalId, kind: "human" }, permissions: ["content:publish"] } })).toThrow("Event Ledger");
    const resolutionEvents = await new PostgresEventStore(database!).query({ tenantId, siteId, principalId, correlationId: unknownInput.releaseId });
    expect(resolutionEvents.some(({ event }) => event.type === "io.navocms.delivery.phase-resolved.v1" && event.data.externalId === "coolify-human-resolved-1")).toBe(true);
  });

  it("reconciles a publishing checkpoint after its exact approval expires", async () => {
    const suffix = randomUUID().replace(/-/g, "");
    const provider = new InterruptingPublishProvider();
    const firstService = service(new PostgresEventStore(database!), undefined, provider);
    const release = await approvedRelease(firstService, suffix, "approval-expiry");
    await expect(firstService.publishRelease(context(), {
      releaseId: release.releaseId, releaseHash: release.releaseHash, idempotencyKey: `publish-${suffix}-approval-expiry`
    })).rejects.toThrow("injected publish interruption");
    await database!.withScope({ tenantId, siteId, principalId }, async (client) => {
      await client.query(
        `UPDATE navocms.release_approvals SET expires_at = now() - interval '1 second'
          WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3`,
        [tenantId, siteId, release.releaseId]
      );
    });
    const restartedService = service(new PostgresEventStore(database!), undefined, provider);
    await expect(restartedService.reconcileRelease(context(), {
      releaseId: release.releaseId, releaseHash: release.releaseHash, idempotencyKey: `reconcile-${suffix}-approval-expiry`
    })).resolves.toMatchObject({ release: { status: "published" } });
    expect(provider.publishCalls).toBe(2);
  });

  it("denies publishing recovery after the validated approval is revoked", async () => {
    const suffix = randomUUID().replace(/-/g, "");
    const provider = new InterruptingPublishProvider();
    const firstService = service(new PostgresEventStore(database!), undefined, provider);
    const release = await approvedRelease(firstService, suffix, "approval-revoked");
    await expect(firstService.publishRelease(context(), {
      releaseId: release.releaseId, releaseHash: release.releaseHash, idempotencyKey: `publish-${suffix}-approval-revoked`
    })).rejects.toThrow("injected publish interruption");
    await database!.withScope({ tenantId, siteId, principalId }, async (client) => {
      await client.query(
        `UPDATE navocms.release_approvals
            SET revoked_at = now(), revoked_by = $4, revocation_reason = 'integration recovery denial proof'
          WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3`,
        [tenantId, siteId, release.releaseId, principalId]
      );
    });
    const restartedService = service(new PostgresEventStore(database!), undefined, provider);
    await expect(restartedService.reconcileRelease(context(), {
      releaseId: release.releaseId, releaseHash: release.releaseHash, idempotencyKey: `reconcile-${suffix}-approval-revoked`
    })).rejects.toMatchObject({ code: "RELEASE_APPROVAL_CHECKPOINT_INVALID" });
    expect(provider.publishCalls).toBe(1);
  });

  it("maps a standard issuer subject to persisted site membership", async () => {
    const resolver = new PostgresIdentityResolver(database!, { tenantId, siteId });
    await expect(resolver.resolve({
      claims: {
        iss: "urn:navocms:integration",
        sub: "sprint-6",
        aud: "https://staging-cms.navocms.test/mcp",
        exp: Math.floor(Date.now() / 1000) + 60
      },
      principal: {
        id: "urn:navocms:integration|sprint-6",
        kind: "human",
        issuer: "urn:navocms:integration",
        subject: "sprint-6"
      },
      tenantId,
      siteId,
      scopes: ["content:read", "content:draft", "content:publish"]
    })).resolves.toMatchObject({
      tenantId,
      siteId,
      principal: { id: principalId, subject: "sprint-6" }
    });
  });

  it("maps a WorkOS Connect role and intersects it with persisted site membership", async () => {
    const resolver = new PostgresIdentityResolver(database!, { tenantId, siteId }, {
      issuerRolePermissions: {
        "navocms-owner": ["content:read", "content:draft", "content:publish"]
      }
    });
    const authorization = await resolver.resolve({
      claims: {
        iss: "urn:navocms:integration",
        sub: "sprint-6",
        aud: "https://staging-cms.navocms.test/mcp",
        exp: Math.floor(Date.now() / 1000) + 60,
        org_id: "org-navocms",
        role: "navocms-owner"
      },
      principal: {
        id: "urn:navocms:integration|sprint-6",
        kind: "human",
        issuer: "urn:navocms:integration",
        subject: "sprint-6"
      },
      tenantId,
      siteId,
      scopes: ["openid"]
    });
    expect(effectivePermissions(authorization.layers)).toEqual([
      "content:read", "content:draft", "content:publish"
    ]);
  });

  it("executes the production path with the pinned provider and charges durable policy usage once", async () => {
    const suffix = randomUUID().replace(/-/g, "");
    const policy = new PostgresRuntimePolicyGuard(database!);
    assertPinnedProductionProfile();
    await adminDatabase!.withScope({ tenantId, siteId, principalId }, async (client) => {
      await client.query(
        `DELETE FROM navocms.usage_events
          WHERE tenant_id = $1 AND site_id = $2 AND operation_key LIKE 'draft_create:%'`,
        [tenantId, siteId]
      );
      await client.query(
        `DELETE FROM navocms.quota_limits
          WHERE tenant_id = $1 AND site_id = $2 AND plugin_id IS NULL
            AND operation_key = 'draft_create' AND period = 'lifetime'`,
        [tenantId, siteId]
      );
      await client.query(
        `INSERT INTO navocms.quota_limits (id, tenant_id, site_id, operation_key, period, limit_amount)
         VALUES ($1, $2, $3, 'draft_create', 'lifetime', 1)`,
        [randomUUID(), tenantId, siteId]
      );
    });
    const productionService = service(new PostgresEventStore(database!), policy);
    const input = {
      typeName: "article", slug: `production-path-${suffix}`, locale: "en", title: "Production path",
      markdown: "# Production path\n", idempotencyKey: `production-path-${suffix}`
    } as const;
    const draft = await productionService.createDraft(context(), input) as { draft: { revisionId: string } };
    const retried = await productionService.createDraft(context(), input) as { draft: { revisionId: string } };
    expect(retried.draft.revisionId).toBe(draft.draft.revisionId);
    const preview = await productionService.preparePreview(context(), draft.draft.revisionId, `preview-${suffix}`);
    await productionService.approveRelease(context(), {
      releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: `approve-${suffix}`
    });
    await productionService.publishRelease(context(), {
      releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: `publish-${suffix}`
    });
    const persisted = await database!.withScope({ tenantId, siteId, principalId }, async (client) => (
      await client.query<{ usage: string; release: string; approvals: string; checkpoints: string; ledger: string; outbox: string }>(
        `SELECT
          (SELECT count(*) FROM navocms.usage_events WHERE operation_key = $1) AS usage,
          (SELECT count(*) FROM navocms.release_candidates WHERE id = $2) AS release,
          (SELECT count(*) FROM navocms.release_approvals WHERE release_id = $2) AS approvals,
          (SELECT count(*) FROM navocms.workflow_checkpoints checkpoint JOIN navocms.workflow_runs run ON run.id = checkpoint.run_id WHERE run.release_id = $2) AS checkpoints,
          (SELECT count(*) FROM navocms.event_ledger WHERE correlation_id = (SELECT correlation_id FROM navocms.release_candidates WHERE id = $2)) AS ledger,
          (SELECT count(*) FROM navocms.domain_outbox WHERE correlation_id = (SELECT correlation_id FROM navocms.release_candidates WHERE id = $2)) AS outbox`,
        [`draft_create:${input.idempotencyKey}`, preview.releaseId]
      )).rows[0]!
    );
    expect(persisted).toMatchObject({ usage: "1", release: "1", approvals: "1" });
    expect(Number(persisted.checkpoints)).toBeGreaterThan(0);
    expect(Number(persisted.ledger)).toBeGreaterThan(0);
    expect(Number(persisted.outbox)).toBeGreaterThan(0);
  });
});

function service(
  events: EventStore = new PostgresEventStore(database!),
  policyGuard?: PostgresRuntimePolicyGuard,
  provider: ReleaseProvider = new EmbeddedReleaseProvider()
): McpEditingService {
  return new McpEditingService(
    new PostgresEditingRepository(database!),
    events,
    new PostgresIdempotencyStore(database!) as IdempotencyStore,
    new PostgresReleaseWorkflowRepository(database!),
    provider,
    { environmentKey: "staging", previewBaseUrl: "https://staging-cms.navocms.test" },
    database!, policyGuard
  );
}

async function approvedRelease(releaseService: McpEditingService, suffix: string, label: string): Promise<{ releaseId: string; releaseHash: string }> {
  const created = await releaseService.createDraft(context(), {
    typeName: "article", slug: `rollback-${label}-${suffix}`, locale: "en", title: `Rollback ${label}`,
    markdown: `# Rollback ${label}\n`, idempotencyKey: `draft-${suffix}-${label}`
  }) as { draft: { revisionId: string } };
  const preview = await releaseService.preparePreview(context(), created.draft.revisionId, `preview-${suffix}-${label}`);
  await releaseService.approveRelease(context(), { releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: `approve-${suffix}-${label}` });
  return preview;
}

class InterruptingRollbackProvider implements ReleaseProvider {
  public readonly key = "test.postgres-rollback.v1";
  public interruptOnce = false;
  public rollbackCalls = 0;
  public async publish(input: ReleaseProviderPublishInput): Promise<ReleaseProviderPublication> { return { providerKey: this.key, providerReference: `postgres:${input.releaseHash}:${input.artifact.hash}`, artifactHash: input.artifact.hash }; }
  public async verify(): Promise<boolean> { return true; }
  public async rollback(): Promise<void> { this.rollbackCalls += 1; if (this.interruptOnce) { this.interruptOnce = false; throw new Error("injected rollback interruption"); } }
}

class InterruptingPublishProvider implements ReleaseProvider {
  public readonly key = "test.postgres-publish-recovery.v1";
  public publishCalls = 0;
  public async publish(input: ReleaseProviderPublishInput): Promise<ReleaseProviderPublication> {
    this.publishCalls += 1;
    if (this.publishCalls === 1) throw new Error("injected publish interruption");
    return { providerKey: this.key, providerReference: `postgres:${input.releaseHash}:${input.artifact.hash}`, artifactHash: input.artifact.hash };
  }
  public async verify(): Promise<boolean> { return true; }
  public async rollback(): Promise<void> { /* no-op for publication recovery proof */ }
}

function context(): { authorization: AuthorizationContext } {
  return {
    authorization: {
      tenantId,
      siteId,
      principal: { id: principalId, kind: "human", issuer: "urn:navocms:integration", subject: "sprint-6" },
      layers: [
        { name: "principal", permissions: NAVOCMS_PERMISSIONS },
        { name: "site", permissions: NAVOCMS_PERMISSIONS },
        { name: "operation", permissions: NAVOCMS_PERMISSIONS }
      ]
    }
  };
}
