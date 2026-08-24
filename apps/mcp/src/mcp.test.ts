import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryEventStore } from "@navocms/kernel";
import {
  NAVOCMS_PERMISSIONS,
  SecurityError,
  siteRoleAuthority,
  type AuthorizationContext,
  type SiteRole
} from "@navocms/security";
import { describe, expect, it } from "vitest";

import { createMcpHttpServer } from "./http.js";
import { createMcpServer } from "./mcp.js";
import { InMemoryEditingRepository } from "./repository.js";
import { McpEditingService } from "./service.js";

const site = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  name: "Editorial proving site",
  primaryLocale: "en",
  locales: ["en", "fr"]
});

describe("MCP editing service", () => {
  it("creates an idempotent draft, applies a stable patch, and binds preview to the new hash", async () => {
    const { service, context } = fixture("publisher");
    const input = {
      typeName: "article",
      slug: "agent-editing",
      locale: "en",
      title: "Agent editing",
      markdown: "# Agent editing\n\nOriginal paragraph.\n",
      metadata: { description: "A safe agent editing test", author: "NavoCMS" },
      idempotencyKey: "draft-agent-editing-001"
    } as const;
    const first = await service.createDraft(context, input) as DraftResult;
    const retried = await service.createDraft(context, {
      ...input,
      metadata: { author: "NavoCMS", description: "A safe agent editing test" }
    }) as DraftResult;
    expect(retried.draft.revisionId).toBe(first.draft.revisionId);

    const content = await service.getContent(context, first.draft.revisionId) as ContentResult;
    const paragraphText = content.astNodes.find((node) => node.type === "text" && node.text.includes("Original"));
    expect(paragraphText).toBeDefined();
    const patched = await service.patchRevision(context, {
      revisionId: first.draft.revisionId,
      baseSourceHash: first.draft.sourceHash,
      operations: [{ op: "replaceText", nodeId: paragraphText!.id, value: "Reviewed paragraph." }],
      idempotencyKey: "patch-agent-editing-001"
    }) as PatchResult;
    expect(patched.draft.revisionNumber).toBe(2);
    expect(patched.diff.lines.some((line) => line.kind === "add" && line.line.includes("Reviewed"))).toBe(true);
    const preview = await service.preparePreview(context, patched.draft.revisionId, "preview-agent-editing-001");
    expect(preview).toMatchObject({
      status: "previewed",
      sourceHash: patched.draft.sourceHash,
      nextStep: "approve-exact-release"
    });
    expect(preview.previewUrl).toMatch(/^https:\/\/preview\.example\.test\/previews\/[A-Za-z0-9_-]{43}$/);
    await expect(service.approveRelease(context, {
      releaseId: preview.releaseId,
      releaseHash: "0".repeat(64),
      idempotencyKey: "approve-stale-release-001"
    })).rejects.toMatchObject({ code: "STALE_RELEASE_APPROVAL" });
    await service.approveRelease(context, {
      releaseId: preview.releaseId,
      releaseHash: preview.releaseHash,
      idempotencyKey: "approve-agent-editing-001"
    });
    await expect(service.publishRelease(context, {
      releaseId: preview.releaseId,
      releaseHash: preview.releaseHash,
      idempotencyKey: "publish-agent-editing-001"
    })).resolves.toMatchObject({
      release: { status: "published", artifactHash: preview.artifactHash },
      publication: { artifactHash: preview.artifactHash, status: "applied" }
    });
  });

  it("fails closed for stale hashes, insufficient permission, and cross-site revision IDs", async () => {
    const repository = new InMemoryEditingRepository();
    repository.registerSite(site);
    const secondSite = { ...site, siteId: "33333333-3333-4333-8333-333333333333", name: "Other site" };
    repository.registerSite(secondSite);
    const service = new McpEditingService(repository);
    const editor = requestContext("editor");
    const created = await service.createDraft(editor, {
      typeName: "article",
      slug: "scope-test",
      locale: "en",
      title: "Scope test",
      markdown: "# Scope test\n",
      idempotencyKey: "scope-draft-0001"
    }) as DraftResult;
    await expect(service.patchRevision(editor, {
      revisionId: created.draft.revisionId,
      baseSourceHash: "0".repeat(64),
      operations: [{ op: "replaceText", nodeId: "missing", value: "No" }],
      idempotencyKey: "stale-patch-0001"
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(service.createDraft(requestContext("viewer"), {
      typeName: "article",
      slug: "forbidden",
      locale: "en",
      title: "Forbidden",
      markdown: "# Forbidden\n",
      idempotencyKey: "viewer-draft-0001"
    })).rejects.toBeInstanceOf(SecurityError);
    await expect(service.getContent(requestContext("editor", secondSite.siteId), created.draft.revisionId))
      .rejects.toThrow(/does not exist|not found|another tenant or site/i);
  });

  it("bounds search and Markdown projections and rejects idempotency-key drift", async () => {
    const { service, context } = fixture("editor");
    const base = {
      typeName: "article",
      locale: "en",
      title: "Bounded content",
      markdown: `# Long\n\n${"x".repeat(25_000)}\n`
    } as const;
    const created = await service.createDraft(context, {
      ...base,
      slug: "bounded-content",
      idempotencyKey: "bounded-draft-0001"
    }) as DraftResult;
    const content = await service.getContent(context, created.draft.revisionId) as ContentResult;
    expect(content.markdown).toHaveLength(20_000);
    expect(content.truncated).toBe(true);
    expect((await service.search(context, "", 999) as { limit: number }).limit).toBe(20);
    await expect(service.createDraft(context, {
      ...base,
      slug: "different-input",
      idempotencyKey: "bounded-draft-0001"
    })).rejects.toThrow(/Idempotency key/);
  });

  it("requires schema metadata instead of inventing legal dates", async () => {
    const { service, context } = fixture("editor");
    const base = {
      typeName: "legal-page",
      slug: "privacy-policy",
      locale: "en",
      title: "Privacy policy",
      markdown: "# Privacy policy\n",
      idempotencyKey: "legal-draft-0001"
    } as const;
    await expect(service.createDraft(context, base)).rejects.toMatchObject({ code: "CONTENT_FIELDS_INVALID" });
    const created = await service.createDraft(context, {
      ...base,
      idempotencyKey: "legal-draft-0002",
      metadata: { effectiveAt: "2026-08-21T00:00:00.000Z" }
    }) as DraftResult;
    expect(created.draft.revisionNumber).toBe(1);
  });
});

describe("MCP protocol and agent evaluations", () => {
  it("publishes OAuth resource metadata and rejects an unauthenticated MCP request", async () => {
    const { service, context } = fixture("editor");
    const draft = await service.createDraft(context, {
      typeName: "article",
      slug: "protected-preview",
      locale: "en",
      title: "Protected preview",
      markdown: "# Protected preview\n\nPrivate proof.\n",
      idempotencyKey: "protected-preview-draft-001"
    }) as DraftResult;
    const preview = await service.preparePreview(context, draft.draft.revisionId, "protected-preview-create-001");
    const http = createMcpHttpServer({
      service,
      verifier: { verify: async () => { throw new Error("not called"); } },
      resource: "https://cms.example.test/mcp",
      authorizationServers: ["https://identity.example.test"]
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    try {
      const metadata = await fetch(`http://127.0.0.1:${address.port}/.well-known/oauth-protected-resource/mcp`);
      expect(metadata.status).toBe(200);
      const metadataBody = await metadata.json();
      expect(metadataBody).toMatchObject({
        resource: "https://cms.example.test/mcp",
        authorization_servers: ["https://identity.example.test"],
        bearer_methods_supported: ["header"]
      });
      expect(metadataBody).not.toHaveProperty("scopes_supported");
      const rejected = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: "POST", body: "{}" });
      expect(rejected.status).toBe(401);
      expect(rejected.headers.get("www-authenticate")).toContain("resource_metadata=");
      const previewToken = preview.previewUrl.split("/").at(-1)!;
      const rendered = await fetch(`http://127.0.0.1:${address.port}/previews/${previewToken}`);
      expect(rendered.status).toBe(200);
      expect(rendered.headers.get("x-robots-tag")).toContain("noindex");
      expect(rendered.headers.get("cache-control")).toContain("no-store");
      expect(await rendered.text()).toContain(preview.releaseHash);
    } finally {
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("exposes goal-oriented tools, standard search/fetch, safe fallbacks, resources, and review UI", async () => {
    const { service, context } = fixture("publisher");
    const server = createMcpServer(service, context);
    const client = new Client({ name: "navocms-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const names = tools.tools.map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining([
      "sites_list", "content_search", "content_get", "draft_create", "revision_patch",
      "revision_compare", "preview_prepare", "search", "fetch", "review_markdown",
      "review_diff", "review_drafts", "review_preview_handoff", "release_status",
      "release_approve", "release_publish", "release_reconcile", "release_rollback"
    ]));
    expect(tools.tools.find(({ name }) => name === "draft_create")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });

    const created = await client.callTool({ name: "draft_create", arguments: {
      typeName: "article",
      slug: "protocol-check",
      locale: "en",
      title: "Protocol check",
      markdown: "# Protocol check\n",
      idempotencyKey: "protocol-draft-0001"
    } });
    expect(created.isError).not.toBe(true);
    expect(created.content).toEqual([{ type: "text", text: "Draft created; nothing was published" }]);

    const searched = await client.callTool({ name: "search", arguments: { query: "Protocol" } });
    const searchContent = searched.content as { type: string; text?: string }[];
    expect(searchContent).toHaveLength(1);
    const searchText = searchContent[0];
    expect(searchText?.type).toBe("text");
    const parsed = JSON.parse(searchText?.type === "text" ? searchText.text ?? "{}" : "{}") as { results: { id: string }[] };
    expect(parsed.results[0]?.id).toMatch(/^document:/);
    const fetched = await client.callTool({ name: "fetch", arguments: { id: parsed.results[0]!.id } });
    const fetchContent = fetched.content as { type: string; text?: string }[];
    expect(fetchContent).toHaveLength(1);
    const fetchedDocument = JSON.parse(fetchContent[0]?.text ?? "{}") as Record<string, unknown>;
    expect(Object.keys(fetchedDocument).sort()).toEqual(["id", "metadata", "text", "title", "url"]);
    expect(fetchedDocument.text).toContain("Protocol check");

    const resources = await client.listResources();
    expect(resources.resources.map(({ uri }) => uri)).toEqual(expect.arrayContaining([
      "navocms://site/current/profile",
      "ui://navocms/editorial-review-v1.html"
    ]));
    const widget = await client.readResource({ uri: "ui://navocms/editorial-review-v1.html" });
    expect(widget.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
    expect("text" in widget.contents[0]! ? widget.contents[0].text : "").toContain("revision");

    await client.close();
    await server.close();
  });

  it("discovers only tools allowed by the resolved authorization layers", async () => {
    const { service } = fixture("publisher");
    const namesFor = async (context: ReturnType<typeof requestContext>) => {
      const server = createMcpServer(service, context);
      const client = new Client({ name: "navocms-permission-evaluation", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        return (await client.listTools()).tools.map(({ name }) => name);
      } finally {
        await client.close();
        await server.close();
      }
    };

    const viewer = await namesFor(requestContext("viewer"));
    expect(viewer).toContain("content_get");
    expect(viewer).not.toEqual(expect.arrayContaining(["draft_create", "preview_prepare", "release_approve", "release_publish"]));

    const editor = await namesFor(requestContext("editor"));
    expect(editor).toEqual(expect.arrayContaining(["draft_create", "revision_patch", "preview_prepare"]));
    expect(editor).not.toEqual(expect.arrayContaining(["release_approve", "release_publish"]));

    const publisher = await namesFor(requestContext("publisher"));
    expect(publisher).toEqual(expect.arrayContaining(["release_approve", "release_publish", "release_reconcile"]));

    const agentPublisher = requestContext("publisher");
    const agentContext = { authorization: { ...agentPublisher.authorization, principal: { ...agentPublisher.authorization.principal, kind: "agent" as const } } };
    const agent = await namesFor(agentContext);
    expect(agent).toContain("release_publish");
    expect(agent).not.toContain("release_approve");

    const expired = await namesFor({ authorization: { ...requestContext("publisher").authorization, expiresAt: "2020-01-01T00:00:00.000Z" } });
    expect(expired).toEqual([]);

    const crossSite = await namesFor(requestContext("publisher", "33333333-3333-4333-8333-333333333333"));
    expect(crossSite).toContain("release_publish");
    await expect(service.listSites(requestContext("publisher", "33333333-3333-4333-8333-333333333333"))).rejects.toMatchObject({ code: "SITE_NOT_REGISTERED" });
  });

});

function fixture(role: SiteRole) {
  const repository = new InMemoryEditingRepository();
  repository.registerSite(site);
  return { service: new McpEditingService(repository, new InMemoryEventStore()), context: requestContext(role) };
}

function requestContext(role: SiteRole, siteId: string = site.siteId): { authorization: AuthorizationContext } {
  return {
    authorization: {
      tenantId: site.tenantId,
      siteId,
      principal: { id: `user-${role}`, kind: "human", issuer: "https://identity.example", subject: role },
      layers: [
        { name: "principal", permissions: NAVOCMS_PERMISSIONS },
        siteRoleAuthority(role),
        { name: "operation", permissions: NAVOCMS_PERMISSIONS }
      ]
    }
  };
}

interface DraftResult {
  draft: { revisionId: string; revisionNumber: number; sourceHash: string };
}

interface ContentResult {
  markdown: string;
  truncated: boolean;
  astNodes: { id: string; type: string; text: string }[];
}

interface PatchResult extends DraftResult {
  diff: { lines: { kind: string; line: string }[] };
}
