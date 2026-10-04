import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NAVOCMS_PERMISSIONS, siteRoleAuthority } from "@navocms/security";
import { describe, it, expect } from "vitest";
import { createMcpServer } from "./mcp.js";
import { InMemoryEditingRepository } from "./repository.js";
import { McpEditingService } from "./service.js";

const site = { tenantId: "11111111-1111-4111-8111-111111111111", siteId: "22222222-2222-4222-8222-222222222222", name: "Pilot", primaryLocale: "en", locales: ["en", "fr"] };
const context = { authorization: { ...site, principal: { id: "editor", kind: "agent" as const, issuer: "urn:test", subject: "editor" }, layers: [{ name: "principal" as const, permissions: NAVOCMS_PERMISSIONS }, siteRoleAuthority("editor"), { name: "operation" as const, permissions: NAVOCMS_PERMISSIONS }] } };

describe("site passport through MCP", () => {
  it("discovers the catalogue schema, creates related localized records, patches fields and rejects foreign references", async () => {
    const repository = new InMemoryEditingRepository(); repository.registerSite(site);
    const service = new McpEditingService(repository);
    const server = createMcpServer(service, context);
    const client = new Client({ name: "new-session", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toContain("site_passport");
      const passport = await client.callTool({ name: "site_passport", arguments: {} });
      const data = passport.structuredContent as { types: { metadata: { name: string } }[] };
      expect(data.types.some(type => type.metadata.name === "catalog-item")).toBe(true);
      const schema = await client.callTool({ name: "content_schema", arguments: { typeName: "catalog-item" } });
      expect(schema.isError).not.toBe(true);
      const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
      const category = await call("draft_create", { typeName: "catalog-category", slug: "sailing", locale: "en", title: "Sailing", markdown: "# Sailing", idempotencyKey: "passport-category-create-001" });
      const categoryDraft = (category.structuredContent as { draft: { id: string } }).draft;
      const translated = await call("draft_create", { typeName: "catalog-category", slug: "sailing", locale: "fr", title: "Voile", markdown: "# Voile", idempotencyKey: "passport-category-french-001" });
      expect((translated.structuredContent as { draft: { id: string } }).draft.id).toBe(categoryDraft.id);
      const item = await call("draft_create", { typeName: "catalog-item", slug: "aurora", locale: "en", title: "Aurora", markdown: "# Aurora", metadata: { category: categoryDraft.id }, idempotencyKey: "passport-item-create-0001" });
      expect(item.isError).not.toBe(true);
      const draft = (item.structuredContent as { draft: { revisionId: string; sourceHash: string } }).draft;
      const patched = await call("revision_patch", { revisionId: draft.revisionId, baseSourceHash: draft.sourceHash, operations: [], metadataPatch: { title: "Aurora II" }, idempotencyKey: "passport-fields-patch-001" });
      expect(patched.isError, JSON.stringify(patched)).not.toBe(true);
      const invalid = await call("revision_patch", { revisionId: (patched.structuredContent as { draft: { revisionId: string } }).draft.revisionId, baseSourceHash: draft.sourceHash, operations: [], metadataPatch: { unknownField: true }, idempotencyKey: "passport-invalid-field-001" });
      expect(invalid.isError).toBe(true);
      expect((invalid.structuredContent as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
      const foreign = await call("draft_create", { typeName: "catalog-item", slug: "foreign", locale: "en", title: "Foreign", markdown: "# Foreign", metadata: { category: "33333333-3333-4333-8333-333333333333" }, idempotencyKey: "passport-foreign-create-01" });
      expect(foreign.isError).toBe(true);
      const dependencies = await call("content_dependencies", { documentId: categoryDraft.id });
      expect((dependencies.structuredContent as { affected: unknown[] }).affected).toHaveLength(1);
    } finally { await client.close(); await server.close(); }
  });
});
