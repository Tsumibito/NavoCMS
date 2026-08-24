import {
  PostgresDatabase,
  PostgresEventStore,
  PostgresIdentityResolver,
  PostgresIdempotencyStore,
  PostgresRuntimePolicyGuard
} from "@navocms/persistence-postgres";
import type { EventStore } from "@navocms/kernel";
import { randomUUID } from "node:crypto";
import { NAVOCMS_PERMISSIONS, type AuthorizationContext } from "@navocms/security";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresEditingRepository } from "./postgres-repository.js";
import { PostgresReleaseWorkflowRepository } from "./postgres-release-repository.js";
import { EmbeddedReleaseProvider } from "./release-repository.js";
import { McpEditingService, type IdempotencyStore } from "./service.js";
import { bootPinnedProductionPluginHost } from "./production-profile.js";

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

  it("executes the production path with the pinned host and charges durable policy usage once", async () => {
    const suffix = randomUUID().replace(/-/g, "");
    const policy = new PostgresRuntimePolicyGuard(database!);
    const host = await bootPinnedProductionPluginHost();
    expect(host.status()).toMatchObject({ state: "healthy", activePlugins: ["navocms.release.embedded"] });
    try {
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
    } finally {
      await host.shutdown();
    }
  });
});

function service(
  events: EventStore = new PostgresEventStore(database!),
  policyGuard?: PostgresRuntimePolicyGuard
): McpEditingService {
  return new McpEditingService(
    new PostgresEditingRepository(database!),
    events,
    new PostgresIdempotencyStore(database!) as IdempotencyStore,
    new PostgresReleaseWorkflowRepository(database!),
    new EmbeddedReleaseProvider(),
    { environmentKey: "staging", previewBaseUrl: "https://staging-cms.navocms.test" },
    database!, policyGuard
  );
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
