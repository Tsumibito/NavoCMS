import {
  PostgresDatabase,
  PostgresEventStore,
  PostgresIdentityResolver,
  PostgresIdempotencyStore
} from "@navocms/persistence-postgres";
import { NAVOCMS_PERMISSIONS, type AuthorizationContext } from "@navocms/security";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresEditingRepository } from "./postgres-repository.js";
import { PostgresReleaseWorkflowRepository } from "./postgres-release-repository.js";
import { EmbeddedReleaseProvider } from "./release-repository.js";
import { McpEditingService, type IdempotencyStore } from "./service.js";

const databaseUrl = process.env.NAVOCMS_INTEGRATION_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const tenantId = "a2af348f-58b8-4efe-b873-8bd032ecbc5c";
const siteId = "2e0bcd4f-6780-470c-844b-d72abb6737ca";
const principalId = "016ef382-bf28-406b-9321-1fc580b6ea00";
const database = databaseUrl ? new PostgresDatabase({
  connectionString: databaseUrl,
  applicationName: "navocms-neon-integration",
  maxConnections: 2
}) : undefined;

afterAll(async () => {
  await database?.close();
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
});

function service(): McpEditingService {
  return new McpEditingService(
    new PostgresEditingRepository(database!),
    new PostgresEventStore(database!),
    new PostgresIdempotencyStore(database!) as IdempotencyStore,
    new PostgresReleaseWorkflowRepository(database!),
    new EmbeddedReleaseProvider(),
    { environmentKey: "staging", previewBaseUrl: "https://staging-cms.navocms.test" }
  );
}

function context(): { authorization: AuthorizationContext } {
  return {
    authorization: {
      tenantId,
      siteId,
      principal: { id: principalId, kind: "service", issuer: "urn:navocms:integration", subject: "sprint-6" },
      layers: [
        { name: "principal", permissions: NAVOCMS_PERMISSIONS },
        { name: "site", permissions: NAVOCMS_PERMISSIONS },
        { name: "operation", permissions: NAVOCMS_PERMISSIONS }
      ]
    }
  };
}
