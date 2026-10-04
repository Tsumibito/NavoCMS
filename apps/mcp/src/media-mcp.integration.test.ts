import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { LocalDeterministicMediaStorage, PostgresMediaRepository } from "@navocms/media";
import { bootstrapSite, PostgresDatabase, PostgresEventStore, PostgresIdempotencyStore } from "@navocms/persistence-postgres";
import { NAVOCMS_PERMISSIONS, SecurityError, siteRoleAuthority, type AuthorizationContext } from "@navocms/security";
import { afterAll, describe, expect, it } from "vitest";

import { McpMediaService } from "./media-service.js";
import { MediaUploadGateway } from "./media-upload-gateway.js";
import { PostgresEditingRepository } from "./postgres-repository.js";
import { StagingOperationalRuntime } from "./staging-operational-runtime.js";
import { McpEditingService, type IdempotencyStore } from "./service.js";
import { PostgresReleaseWorkflowRepository } from "./postgres-release-repository.js";
import { EmbeddedReleaseProvider } from "./release-repository.js";
const sharp = createRequire(new URL("../../../packages/media/package.json", import.meta.url))("sharp");

const databaseUrl = process.env.NAVOCMS_INTEGRATION_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const scope = { tenantId: "a2af348f-58b8-4efe-b873-8bd032ecbc5c", siteId: "2e0bcd4f-6780-470c-844b-d72abb6737ca", principalId: "016ef382-bf28-406b-9321-1fc580b6ea00" };
const database = databaseUrl ? new PostgresDatabase({ connectionString: databaseUrl, applicationName: "navocms-mcp-media-integration", maxConnections: 4 }) : undefined;

afterAll(async () => database?.close());

integration("MCP media PostgreSQL bridge", () => {
  it("uploads through a scoped capability, rejects altered bytes and expiry, and preserves media after a field patch", async () => {
    const scope = { tenantId: "a2af348f-58b8-4efe-b873-8bd032ecbc5c", siteId: randomUUID(), principalId: "016ef382-bf28-406b-9321-1fc580b6ea00" };
    await bootstrapSite(process.env.NAVOCMS_INTEGRATION_ADMIN_DATABASE_URL!, { tenantId: scope.tenantId, tenantSlug: "sprint-seven", tenantName: "Integration", siteId: scope.siteId, siteSlug: `media-${scope.siteId}`, siteName: "Upload isolation", primaryLocale: "en", locales: ["en"], environmentId: randomUUID(), environmentKind: "staging", environmentKey: "default", principal: { id: scope.principalId, issuer: "urn:navocms:integration", subject: "sprint-6", kind: "human", siteRole: "owner" } });
    const request = { authorization: { ...editorContext().authorization, siteId: scope.siteId } };
    const storage = new LocalDeterministicMediaStorage();
    const repository = new PostgresMediaRepository(database!, storage);
    const gateway = new MediaUploadGateway(database!, storage, repository, { ...scope, principalKind: "service" }, "https://cms.example.test");
    const media = new McpMediaService(repository, { storageInjected: true, uploadGateway: gateway });
    const suffix = randomUUID();
    const bytes = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: "#123456" } }).png().toBuffer());
    const prepared = await media.prepare(request, { idempotencyKey: `gateway-${suffix}`, expectedSha256: digest(bytes), expectedSize: bytes.length, expectedMediaType: "image/png", expiresAt: new Date(Date.now()+60_000).toISOString(), provenance: { kind: "upload", receivedAt: new Date().toISOString() }, rights: { license: "test", restricted: false } }) as { uploadUrl: string; intentId: string };
    const token = prepared.uploadUrl.split("/").at(-1)!;
    await expect(gateway.receive(token, bytes.slice(1))).rejects.toThrow();
    const received = await gateway.receive(token, bytes) as { assetId: string };
    expect(await gateway.receive(token, bytes)).toEqual(received);
    const other = new MediaUploadGateway(database!, storage, repository, { ...scope, siteId: randomUUID(), principalKind: "service" }, "https://cms.example.test");
    await expect(other.receive(token, bytes)).rejects.toThrow("UPLOAD_SESSION_EXPIRED");
    expect(await database!.withScope({ ...scope, siteId: randomUUID() }, async client => (await client.query("SELECT token_hash FROM navocms.media_upload_sessions")).rows)).toEqual([]);
    const expired = (await gateway.create({ ...scope, principalKind: "human" }, prepared.intentId, new Date(Date.now()-1000).toISOString())).split("/").at(-1)!;
    await expect(gateway.receive(expired, bytes)).rejects.toThrow("UPLOAD_SESSION_EXPIRED");
    const editing = new PostgresEditingRepository(database!);
    const site = { tenantId: scope.tenantId, siteId: scope.siteId, name: "Media test", primaryLocale: "en", locales: ["en"] };
    const draft = await editing.createDraft({ site, typeName: "landing-page", slug: `media-patch-${suffix}`, title: "Media patch", source: "# Media patch\n", locale: "en", actorId: scope.principalId });
    await repository.createReference({ ...scope, principalKind: "human" }, { assetId: received.assetId, ownerType: "content.revision", ownerId: draft.revisionId, purpose: "hero", alt: "Sailing photograph", idempotencyKey: `reference-${suffix}` });
    const patched = await editing.patchDraft({ site, revisionId: draft.revisionId, baseSourceHash: draft.sourceHash, operations: [], metadataPatch: { title: "Updated media patch" }, actorId: scope.principalId });
    const refs = await database!.withScope(scope, async client => (await client.query<{ owner_id: string; alt: string; purpose: string }>("SELECT owner_id,alt,purpose FROM navocms.media_references WHERE asset_id=$1", [received.assetId])).rows);
    expect(refs).toEqual(expect.arrayContaining([{ owner_id: draft.revisionId, alt: "Sailing photograph", purpose: "hero" }, { owner_id: patched.draft.revisionId, alt: "Sailing photograph", purpose: "hero" }]));
    const runtime = new StagingOperationalRuntime({ database: database!, environmentKey: "default", reviewedSourceCommit: "a".repeat(40), toolchainDirectory: "/unused", readinessContext: { site, principalId: scope.principalId }, runtimePrincipalId: scope.principalId, mediaStorage: storage, mediaBaseUrl: "https://cms.example.test", runner: { attest: async () => { throw new Error("Media-boundary test does not build Astro"); }, build: async () => { throw new Error("Unexpected build"); } } });
    const service = new McpEditingService(editing, new PostgresEventStore(database!), new PostgresIdempotencyStore(database!) as IdempotencyStore, new PostgresReleaseWorkflowRepository(database!), new EmbeddedReleaseProvider(), { environmentKey: "staging" }, database!, undefined, runtime);
    const preview = await service.preparePreview(request, patched.draft.revisionId, `media-preview-${suffix}`);
    await expect.poll(() => runtime.buildStatus({ site, principalId: scope.principalId }, preview.releaseId)).toMatchObject({ status: "failed" });
    const identities = await database!.withScope(scope, async client => (await client.query<{ variant_identity: string }>("SELECT variant_identity FROM navocms.media_variants WHERE asset_id=$1", [received.assetId])).rows);
    expect(identities).toHaveLength(3);
    for (const variant of identities) {
      expect(await runtime.readMedia(variant.variant_identity)).toBeUndefined();
      expect(await runtime.readMedia(variant.variant_identity, preview.releaseId)).toMatchObject({ mediaType: expect.stringMatching(/^image\//) });
    }
    expect(await runtime.publicSnapshot(preview.releaseHash)).toBeUndefined();
  });

  it("enforces permission and retains replay, drift, Ledger, and outbox trajectory", async () => {
    const storage = new LocalDeterministicMediaStorage();
    const media = new McpMediaService(new PostgresMediaRepository(database!, storage), { storageInjected: true });
    const key = `mcp-media-${randomUUID()}`;
    const bytes = png(key);
    const input = { idempotencyKey: key, expectedSha256: digest(bytes), expectedSize: bytes.byteLength, expectedMediaType: "image/png" as const, expiresAt: new Date(Date.now() + 60_000).toISOString(), provenance: { kind: "upload" as const, receivedAt: new Date().toISOString() }, rights: { license: "test", restricted: false } };
    await expect(media.prepare(viewerContext(), input)).rejects.toBeInstanceOf(SecurityError);
    const prepared = await media.prepare(editorContext(), input) as { kind: "upload-intent"; intentId: string; storageKey: string; asset: { id: string } };
    await expect(media.get(editorContext(), prepared.asset.id, 20)).resolves.toMatchObject({
      provenance: { receivedBy: scope.principalId }
    });
    await expect(media.prepare(editorContext(), { ...input, expectedSize: input.expectedSize + 1 })).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    await storage.putImmutable({ key: prepared.storageKey, bytes, mediaType: "image/png" });
    const finalize = { intentId: prepared.intentId, uploadedStorageKey: prepared.storageKey, idempotencyKey: `${key}-finalize` };
    const first = await media.finalize(editorContext(), finalize);
    expect(await media.finalize(editorContext(), finalize)).toEqual(first);
    const trajectory = await database!.withScope(scope, async (client) => (
      await client.query<{ ledger: string; outbox: string }>(
        `SELECT
          (SELECT count(*) FROM navocms.event_ledger WHERE correlation_id = $1) AS ledger,
          (SELECT count(*) FROM navocms.domain_outbox WHERE correlation_id = $1) AS outbox`, [prepared.asset.id]
      )).rows[0]!
    );
    expect(trajectory).toEqual({ ledger: "3", outbox: "3" });
  });
});

function editorContext(): { authorization: AuthorizationContext } { return context("editor"); }
function viewerContext(): { authorization: AuthorizationContext } { return context("viewer"); }
function context(role: "editor" | "viewer"): { authorization: AuthorizationContext } {
  return { authorization: { tenantId: scope.tenantId, siteId: scope.siteId, principal: { id: scope.principalId, kind: "human", issuer: "https://identity.example", subject: role }, layers: [{ name: "principal", permissions: NAVOCMS_PERMISSIONS }, siteRoleAuthority(role), { name: "operation", permissions: NAVOCMS_PERMISSIONS }] } };
}
function png(value: string): Uint8Array {
  const bytes = new Uint8Array(24 + Buffer.byteLength(value));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 2]);
  bytes.set(Buffer.from(value), 24); return bytes;
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
