import { createHash, randomUUID } from "node:crypto";

import { LocalDeterministicMediaStorage, PostgresMediaRepository } from "@navocms/media";
import { PostgresDatabase } from "@navocms/persistence-postgres";
import { NAVOCMS_PERMISSIONS, SecurityError, siteRoleAuthority, type AuthorizationContext } from "@navocms/security";
import { afterAll, describe, expect, it } from "vitest";

import { McpMediaService } from "./media-service.js";

const databaseUrl = process.env.NAVOCMS_INTEGRATION_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const scope = { tenantId: "a2af348f-58b8-4efe-b873-8bd032ecbc5c", siteId: "2e0bcd4f-6780-470c-844b-d72abb6737ca", principalId: "016ef382-bf28-406b-9321-1fc580b6ea00" };
const database = databaseUrl ? new PostgresDatabase({ connectionString: databaseUrl, applicationName: "navocms-mcp-media-integration", maxConnections: 4 }) : undefined;

afterAll(async () => database?.close());

integration("MCP media PostgreSQL bridge", () => {
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
