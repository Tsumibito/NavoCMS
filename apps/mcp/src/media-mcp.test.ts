import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MediaRepository } from "@navocms/media";
import { NAVOCMS_PERMISSIONS, SecurityError, siteRoleAuthority, type AuthorizationContext, type SiteRole } from "@navocms/security";
import { describe, expect, it } from "vitest";

import { createMcpServer } from "./mcp.js";
import { McpMediaService } from "./media-service.js";
import { InMemoryEditingRepository } from "./repository.js";
import { McpEditingService } from "./service.js";

const site = { tenantId: "11111111-1111-4111-8111-111111111111", siteId: "22222222-2222-4222-8222-222222222222", name: "Media site", primaryLocale: "en", locales: ["en"] };

describe("MCP media discovery", () => {
  it("scopes read and write tools by media permission and storage capability", async () => {
    const viewer = await toolNames("viewer", true);
    expect(viewer).toEqual(expect.arrayContaining(["media_list", "media_get", "media_references_list", "media_review"]));
    expect(viewer).not.toEqual(expect.arrayContaining(["media_upload_prepare", "media_upload_finalize", "media_reject", "media_reference_create", "media_reference_remove"]));
    const editorWithoutStorage = await toolNames("editor", false);
    expect(editorWithoutStorage).toContain("media_list");
    expect(editorWithoutStorage).not.toContain("media_upload_prepare");
    const editor = await toolNames("editor", true);
    expect(editor).toEqual(expect.arrayContaining(["media_upload_prepare", "media_upload_finalize", "media_reject", "media_reference_create", "media_reference_remove"]));
  });

  it("denies direct write calls without media:write", async () => {
    const media = new McpMediaService(repository(), { storageInjected: true });
    await expect(media.prepare(context("viewer"), intentInput())).rejects.toBeInstanceOf(SecurityError);
    const withoutStorage = new McpMediaService(repository(), { storageInjected: false });
    await expect(withoutStorage.prepare(context("editor"), intentInput())).rejects.toMatchObject({ code: "MEDIA_STORAGE_UNAVAILABLE" });
  });

  it("keeps upload schemas binary-free and marks destructive mutations accurately", async () => {
    const tools = await listedTools("editor", true);
    const prepare = tools.find(({ name }) => name === "media_upload_prepare")!;
    const properties = (prepare.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual([
      "expectedMediaType", "expectedSha256", "expectedSize", "expiresAt", "idempotencyKey", "provenance", "rights"
    ]);
    expect(JSON.stringify(prepare.inputSchema)).not.toMatch(/base64|binary|receivedBy/i);
    expect(tools.find(({ name }) => name === "media_reject")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find(({ name }) => name === "media_reference_remove")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find(({ name }) => name === "media_upload_finalize")?.annotations?.destructiveHint).toBe(false);
  });
});

async function toolNames(role: SiteRole, storageInjected: boolean): Promise<readonly string[]> {
  return (await listedTools(role, storageInjected)).map(({ name }) => name);
}

async function listedTools(role: SiteRole, storageInjected: boolean) {
  const editingRepository = new InMemoryEditingRepository(); editingRepository.registerSite(site);
  const server = createMcpServer(new McpEditingService(editingRepository), context(role), new McpMediaService(repository(), { storageInjected }));
  const client = new Client({ name: "media-discovery", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try { return (await client.listTools()).tools; }
  finally { await client.close(); await server.close(); }
}

function context(role: SiteRole): { authorization: AuthorizationContext } {
  return { authorization: { tenantId: site.tenantId, siteId: site.siteId, principal: { id: "016ef382-bf28-406b-9321-1fc580b6ea00", kind: "human", issuer: "https://identity.example", subject: role }, layers: [{ name: "principal", permissions: NAVOCMS_PERMISSIONS }, siteRoleAuthority(role), { name: "operation", permissions: NAVOCMS_PERMISSIONS }] } };
}

function repository(): MediaRepository {
  const asset = { id: "11111111-1111-4111-8111-111111111111", state: "pending" as const, createdAt: "2026-01-01T00:00:00.000Z" };
  return {
    createUploadIntent: async () => ({ kind: "upload-intent", asset, intentId: "22222222-2222-4222-8222-222222222222", storageKey: "pending", expiresAt: "2026-01-01T00:01:00.000Z" }),
    finalizeUpload: async () => asset, getAsset: async () => asset,
    getAssetReview: async () => ({ ...asset, provenance: {}, rights: {}, references: [] }),
    listAssets: async () => ({ assets: [asset] }), listReferences: async () => ({ references: [] }),
    createReference: async () => ({ id: "33333333-3333-4333-8333-333333333333" }), removeReference: async () => undefined, rejectAsset: async () => ({ ...asset, state: "rejected" as const, rejectionReason: "rejected" })
  };
}

function intentInput() {
  return { idempotencyKey: "media-permission-0001", expectedSha256: "a".repeat(64), expectedSize: 1, expectedMediaType: "image/png" as const, expiresAt: "2026-12-01T00:00:00.000Z", provenance: { kind: "upload" as const, receivedAt: "2026-01-01T00:00:00.000Z" }, rights: { license: "test", restricted: false } };
}
