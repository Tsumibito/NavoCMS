import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CloudflareDeliveryError } from "@navocms/delivery-cloudflare";
import { InMemoryEventStore, type ReleaseProvider, type ReleaseProviderPublication, type ReleaseProviderPublishInput } from "@navocms/kernel";
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
import { InMemoryEditingRepository, inputFingerprint } from "./repository.js";
import { InMemoryIdempotencyStore, McpEditingService } from "./service.js";

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
    expect((await service.search(context, "", { limit: 999 }) as { limit: number }).limit).toBe(20);
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

  it("fails closed with the current head when two edits start from the same base revision", async () => {
    const { service, context } = fixture("editor");
    const created = await service.createDraft(context, {
      typeName: "article",
      slug: "two-edits-one-base",
      locale: "en",
      title: "Two edits one base",
      markdown: "# Two edits\n\nFirst paragraph.\n\nSecond paragraph.\n",
      idempotencyKey: "two-edits-draft-0001"
    }) as DraftResult;
    const content = await service.getContent(context, created.draft.revisionId) as ContentResult;
    const paragraphs = content.astNodes.filter((node) => node.type === "text");
    const firstEdit = await service.patchRevision(context, {
      revisionId: created.draft.revisionId,
      baseSourceHash: created.draft.sourceHash,
      operations: [{ op: "replaceText", nodeId: paragraphs[0]!.id, value: "First edit." }],
      idempotencyKey: "two-edits-patch-0001"
    }) as PatchResult;
    expect(firstEdit.draft.revisionNumber).toBe(2);

    // The second edit still targets r1 and must fail with the actual current head.
    await expect(service.patchRevision(context, {
      revisionId: created.draft.revisionId,
      baseSourceHash: created.draft.sourceHash,
      operations: [{ op: "replaceText", nodeId: paragraphs[1]!.id, value: "Second edit." }],
      idempotencyKey: "two-edits-patch-0002"
    })).rejects.toMatchObject({
      code: "REVISION_NOT_CURRENT",
      details: {
        currentRevisionId: firstEdit.draft.revisionId,
        currentRevisionNumber: 2,
        currentSourceHash: firstEdit.draft.sourceHash
      }
    });

    // Replaying the first key after the head advanced returns the same result.
    const replayed = await service.patchRevision(context, {
      revisionId: created.draft.revisionId,
      baseSourceHash: created.draft.sourceHash,
      operations: [{ op: "replaceText", nodeId: paragraphs[0]!.id, value: "First edit." }],
      idempotencyKey: "two-edits-patch-0001"
    }) as PatchResult;
    expect(replayed.draft.revisionId).toBe(firstEdit.draft.revisionId);

    // Different input with the same key still fails closed.
    await expect(service.patchRevision(context, {
      revisionId: created.draft.revisionId,
      baseSourceHash: created.draft.sourceHash,
      operations: [{ op: "replaceText", nodeId: paragraphs[0]!.id, value: "Different edit." }],
      idempotencyKey: "two-edits-patch-0001"
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    // The rebased application carries both edits; the stale base stays gated.
    const rebased = await service.patchRevision(context, {
      revisionId: firstEdit.draft.revisionId,
      baseSourceHash: firstEdit.draft.sourceHash,
      operations: [{ op: "replaceText", nodeId: paragraphs[1]!.id, value: "Second edit." }],
      idempotencyKey: "two-edits-patch-0003"
    }) as PatchResult;
    expect(rebased.draft.revisionNumber).toBe(3);
    const rebasedContent = await service.getContent(context, rebased.draft.revisionId) as ContentResult;
    expect(rebasedContent.markdown).toContain("First edit.");
    expect(rebasedContent.markdown).toContain("Second edit.");
    await expect(service.patchRevision(context, {
      revisionId: created.draft.revisionId,
      baseSourceHash: created.draft.sourceHash,
      operations: [{ op: "replaceText", nodeId: paragraphs[1]!.id, value: "Late edit." }],
      idempotencyKey: "two-edits-patch-0004"
    })).rejects.toMatchObject({ code: "REVISION_NOT_CURRENT" });
  });

  it("enumerates 45 documents through cursors without gaps or duplicates", async () => {
    const { service, context } = fixture("editor");
    const secondSite = { ...site, siteId: "33333333-3333-4333-8333-333333333333", name: "Other site" };
    const otherRepository = new InMemoryEditingRepository();
    otherRepository.registerSite(secondSite);
    const otherService = new McpEditingService(otherRepository, new InMemoryEventStore());
    for (let index = 1; index <= 45; index += 1) {
      const slug = `cursor-doc-${String(index).padStart(3, "0")}`;
      const input = {
        typeName: "article" as const,
        slug,
        locale: "en",
        title: `Cursor doc ${index}`,
        markdown: `# Cursor doc ${index}\n`,
        idempotencyKey: `cursor-draft-${String(index).padStart(4, "0")}`
      };
      await service.createDraft(context, input);
      await otherService.createDraft(requestContext("editor", secondSite.siteId), input);
    }

    const collected = new Map<string, number>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await service.search(context, "", { limit: 7, ...(cursor !== undefined ? { cursor } : {}) }) as { results: { id: string }[]; nextCursor?: string };
      pages += 1;
      for (const hit of page.results) {
        expect(collected.has(hit.id)).toBe(false);
        collected.set(hit.id, page.results.indexOf(hit));
      }
      cursor = page.nextCursor;
    } while (cursor && pages < 20);
    expect(collected.size).toBe(45);
    expect(collected.size).toBeLessThanOrEqual(pages * 7);

    const draftQueue = new Set<string>();
    let draftCursor: string | undefined;
    let draftPages = 0;
    do {
      const page = await service.listDrafts(context, { limit: 7, ...(draftCursor !== undefined ? { cursor: draftCursor } : {}) }) as { drafts: { revisionId: string }[]; nextCursor?: string };
      draftPages += 1;
      for (const draft of page.drafts) {
        expect(draftQueue.has(draft.revisionId)).toBe(false);
        draftQueue.add(draft.revisionId);
      }
      draftCursor = page.nextCursor;
    } while (draftCursor && draftPages < 20);
    expect(draftQueue.size).toBe(45);

    // An unknown-but-well-formed cursor yields an empty page instead of crossing scope.
    const foreignCursor = await otherService.search(
      requestContext("editor", secondSite.siteId), "", { limit: 5 }
    ) as { nextCursor?: string };
    expect(foreignCursor.nextCursor).toBeDefined();
    const foreignPage = await service.search(context, "", { limit: 7, cursor: foreignCursor.nextCursor! }) as { results: unknown[] };
    expect(foreignPage.results).toEqual([]);
  });

  it("reads a 25k-character document fully through bounded windows without duplicating body", async () => {
    const { service, context } = fixture("editor");
    const paragraphs = Array.from({ length: 130 }, (_, index) => `Paragraph ${index + 1} ${"y".repeat(60)}`).join("\n\n");
    const body = `# Long document\n\n${"x".repeat(12_000)}\n\n${paragraphs}\n`;
    const created = await service.createDraft(context, {
      typeName: "article",
      slug: "long-document",
      locale: "en",
      title: "Long document",
      markdown: body,
      idempotencyKey: "long-document-draft-01"
    }) as DraftResult;

    const content = await service.getContent(context, created.draft.revisionId) as ContentResult & {
      metadata: Record<string, unknown>;
      totalCharacters: number;
      totalNodes: number;
      truncatedNodes: boolean;
    };
    expect(content.markdown).toHaveLength(20_000);
    expect(content.truncated).toBe(true);
    expect(content.totalCharacters).toBe(body.length);
    expect(content.metadata).not.toHaveProperty("body");
    expect(JSON.stringify(content.metadata.length ?? 0)).toBeDefined();
    expect(JSON.stringify(content).length).toBeLessThan(60_000);
    expect(content.astNodes.length).toBe(100);
    expect(content.truncatedNodes).toBe(true);
    expect(content.totalNodes).toBeGreaterThan(100);

    let offset = 0;
    let assembled = "";
    let windows = 0;
    while (windows < 10) {
      const window = await service.readContent(context, { revisionId: created.draft.revisionId, markdownOffset: offset }) as {
        markdown: string;
        nextOffset?: number;
        truncated: boolean;
      };
      windows += 1;
      expect(window.markdown.length).toBeLessThanOrEqual(20_000);
      assembled += window.markdown;
      if (!window.truncated) break;
      offset = window.nextOffset!;
    }
    expect(assembled).toBe(body);
    expect(windows).toBe(2);

    const nodePage = await service.readContent(context, {
      revisionId: created.draft.revisionId,
      nodeOffset: 0,
      nodeLimit: 5
    }) as { nodes: { id: string; type: string }[]; totalNodes: number };
    expect(nodePage.nodes).toHaveLength(5);
    const detail = await service.readContent(context, {
      revisionId: created.draft.revisionId,
      nodeId: nodePage.nodes.find((node) => node.type === "heading")?.id ?? nodePage.nodes[0]!.id
    }) as { node: { id: string; text: string }; truncated: boolean };
    expect(detail.node.id).toBeDefined();
    expect(detail.truncated).toBe(false);
  });

  it("bounds the read response budget across metadata and offers a bounded metadata continuation", async () => {
    const { service, context } = fixture("editor");
    const longKey = `key-${"k".repeat(300)}`;
    const metadata = {
      contact: { description: "x".repeat(180_000), [longKey]: { note: "\u{1F30D}".repeat(500) } },
      legalName: "Bounded metadata organization"
    };
    const created = await service.createDraft(context, {
      typeName: "organization",
      slug: "bounded-metadata",
      locale: "en",
      title: "Bounded metadata",
      markdown: "# Test\n",
      metadata,
      idempotencyKey: "bounded-metadata-draft-1"
    }) as DraftResult;
    const content = await service.getContent(context, created.draft.revisionId) as ContentResult & {
      metadata: Record<string, unknown>;
      metadataTruncated: boolean;
      metadataTotalCharacters: number;
      metadataOmittedKeys?: readonly string[];
    };
    const serialized = JSON.stringify(content);
    expect(serialized.length).toBeLessThan(60_000);
    expect(serialized).not.toContain("x".repeat(1_000));
    expect(content.metadataTruncated).toBe(true);
    expect(content.metadataTotalCharacters).toBeGreaterThan(180_000);
    expect(content.metadataOmittedKeys).toEqual(["contact"]);
    expect(content.metadata.legalName).toBe("Bounded metadata organization");

    // The omitted value stays reachable through bounded windows on the
    // immutable revision, without widening the site scope.
    const contactJson = JSON.stringify(metadata.contact);
    const readInput = { revisionId: created.draft.revisionId, metadataKey: "contact" };
    let assembled = "";
    let offset = 0;
    for (let window = 0; window < 20 && (offset === 0 || assembled.length < contactJson.length); window += 1) {
      const page = await service.readContent(context, { ...readInput, markdownOffset: offset }) as {
        text: string;
        truncated: boolean;
        nextOffset?: number;
        totalCharacters: number;
      };
      expect(page.totalCharacters).toBe(contactJson.length);
      expect(page.text.length).toBeLessThanOrEqual(20_000);
      assembled += page.text;
      if (!page.truncated) break;
      offset = page.nextOffset!;
    }
    expect(assembled).toBe(contactJson);

    // A deep unicode key with a long name survives a window aligned to its own
    // serialized position inside the contact value.
    const fragment = JSON.stringify(metadata.contact[longKey]);
    const fragmentStart = contactJson.indexOf(fragment);
    expect(fragmentStart).toBeGreaterThan(0);
    const aligned = await service.readContent(context, {
      revisionId: created.draft.revisionId, metadataKey: "contact", markdownOffset: fragmentStart
    }) as { text: string };
    expect(aligned.text.startsWith(fragment)).toBe(true);

    await expect(service.readContent(context, { revisionId: created.draft.revisionId, metadataKey: "missing-key" }))
      .rejects.toMatchObject({ code: "METADATA_KEY_NOT_FOUND" });
  });

  it("advertises and reads omitted metadata through the MCP transport", async () => {
    const { service, context } = fixture("editor");
    const server = createMcpServer(service, context);
    const client = new Client({ name: "metadata-acceptance", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.find(({ name }) => name === "content_read")?.inputSchema.properties)
        .toHaveProperty("metadataKey");
      const contact = { description: "🌍".repeat(12_000) };
      const created = await client.callTool({ name: "draft_create", arguments: {
        typeName: "organization", slug: "metadata-transport", locale: "en", title: "Metadata transport",
        markdown: "# Short Markdown\n", metadata: { contact }, idempotencyKey: "metadata-transport-create"
      } });
      expect(created.isError).not.toBe(true);
      const revisionId = (created.structuredContent as unknown as DraftResult).draft.revisionId;
      const summary = await client.callTool({ name: "content_get", arguments: { revisionId } });
      expect(summary.structuredContent).toMatchObject({ metadataTruncated: true, metadataOmittedKeys: ["contact"] });
      let assembled = "";
      let offset = 0;
      for (let page = 0; page < 10; page += 1) {
        const result = await client.callTool({ name: "content_read", arguments: { revisionId, metadataKey: "contact", markdownOffset: offset } });
        expect(result.isError).not.toBe(true);
        const window = result.structuredContent as { text: string; metadataKey: string; truncated: boolean; nextOffset?: number };
        expect(window.metadataKey).toBe("contact");
        expect(window.text.length).toBeLessThanOrEqual(20_000);
        assembled += window.text;
        if (!window.truncated) break;
        expect(window.nextOffset).toBeGreaterThan(offset);
        offset = window.nextOffset!;
      }
      expect(JSON.parse(assembled)).toEqual(contact);
      const missing = await client.callTool({ name: "content_read", arguments: { revisionId, metadataKey: "absent" } });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toMatchObject({ code: "METADATA_KEY_NOT_FOUND" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("aligns idempotency key bounds across tools, service, and the event ledger", async () => {
    const { service, context, events } = fixture("editor");
    const base = {
      typeName: "article",
      slug: "key-bounds",
      locale: "en",
      title: "Key bounds",
      markdown: "# Key bounds\n"
    } as const;
    await expect(service.createDraft(context, { ...base, idempotencyKey: "short-key-15x" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_INVALID" });

    const server = createMcpServer(service, context);
    const client = new Client({ name: "navocms-key-bound-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const rejected = await client.callTool({ name: "draft_create", arguments: {
        ...base, idempotencyKey: "short-key-15x"
      } });
      expect(rejected.isError).toBe(true);

      const accepted = await client.callTool({ name: "draft_create", arguments: {
        ...base, slug: "key-bounds-accepted", idempotencyKey: "exactly-16-chars"
      } });
      expect(accepted.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
    const records = await events.query({
      tenantId: site.tenantId,
      siteId: site.siteId,
      type: "io.navocms.content.draft.created.v1"
    });
    expect(records.some(({ event }) => event.navoidempotencykey === "exactly-16-chars")).toBe(true);
  });

  it("reports a valid previewed handoff as ready in text and structured results", async () => {
    const { service, context } = fixture("editor");
    const created = await service.createDraft(context, {
      typeName: "article",
      slug: "handoff-ready",
      locale: "en",
      title: "Handoff ready",
      markdown: "# Handoff ready\n",
      idempotencyKey: "handoff-draft-00001"
    }) as DraftResult;
    const server = createMcpServer(service, context);
    const client = new Client({ name: "navocms-handoff-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const handoff = await client.callTool({ name: "review_preview_handoff", arguments: {
        revisionId: created.draft.revisionId,
        idempotencyKey: "handoff-preview-0001"
      } });
      expect(handoff.isError).not.toBe(true);
      const text = (handoff.content as { type: string; text?: string }[])[0]?.text ?? "";
      expect(text).toContain("ready");
      expect(text).toContain("Markdown proof artifact");
      expect(text).not.toContain("Blocked");
      expect(handoff.structuredContent).toMatchObject({
        view: "workflow",
        status: "previewed",
        nextStep: "approve-exact-release"
      });
      const structured = handoff.structuredContent as Record<string, unknown> | undefined;
      expect(String(structured?.previewUrl)).toMatch(/^https:\/\/preview\.example\.test\/previews\//);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps applied-effect evidence when a retry meets an incomplete reservation", async () => {
    const provider = new ThrowingVerifyProvider();
    const session = await publishSession(provider);
    const publishArgs = {
      releaseId: session.preview.releaseId,
      releaseHash: session.preview.releaseHash,
      idempotencyKey: "review-publish-000001"
    };
    try {
      const first = await session.client.callTool({ name: "release_publish", arguments: publishArgs });
      expect(first.isError).toBe(true);
      expect(((first.content as { type: string; text?: string }[])[0]?.text ?? "")).toContain("LIVE_VERIFICATION_FAILED");
      expect(provider.publishCalls).toBe(1);

      const retry = await session.client.callTool({ name: "release_publish", arguments: publishArgs });
      expect(retry.isError).toBe(true);
      const retryText = (retry.content as { type: string; text?: string }[])[0]?.text ?? "";
      expect(retryText).not.toContain("No content was published");
      expect(retryText).toContain("release_reconcile");
      expect(retry.structuredContent).toMatchObject({ code: "IDEMPOTENCY_INCOMPLETE", effectState: "unknown" });

      // Reconciliation re-verifies the recorded effect without repeating it.
      provider.verificationSucceeds = true;
      const reconciled = await session.client.callTool({ name: "release_reconcile", arguments: {
        releaseId: session.preview.releaseId,
        releaseHash: session.preview.releaseHash,
        idempotencyKey: "review-reconcile-0001"
      } });
      expect(reconciled.isError).not.toBe(true);
      expect(reconciled.structuredContent).toMatchObject({ release: { status: "published" } });
      expect(provider.publishCalls).toBe(1);
    } finally {
      await session.client.close();
      await session.server.close();
    }
  });

  it("reports an unknown effect state while a non-transactional reservation is pending", async () => {
    const repository = new InMemoryEditingRepository();
    repository.registerSite(site);
    const store = new InMemoryIdempotencyStore();
    const service = new McpEditingService(repository, new InMemoryEventStore(), store);
    const context = requestContext("publisher");
    const draft = await service.createDraft(context, {
      typeName: "article",
      slug: "pending-reservation-surface",
      locale: "en",
      title: "Pending reservation surface",
      markdown: "# Pending reservation surface\n",
      idempotencyKey: "pending-reserve-draft-01"
    }) as DraftResult;
    const preview = await service.preparePreview(context, draft.draft.revisionId, "pending-reserve-preview-1") as { releaseId: string; releaseHash: string };
    await service.approveRelease(context, {
      releaseId: preview.releaseId,
      releaseHash: preview.releaseHash,
      idempotencyKey: "pending-reserve-approve-1"
    });
    const input = { releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "pending-reserve-publish" };
    await store.reserve(
      { tenantId: site.tenantId, siteId: site.siteId },
      "release_publish", input.idempotencyKey, inputFingerprint(input)
    );
    await expect(service.publishRelease(context, input)).rejects.toMatchObject({
      code: "IDEMPOTENCY_INCOMPLETE",
      effectState: "unknown"
    });
  });

  it("reports provider effect state instead of claiming nothing was published", async () => {
    const failingVerification = await releasePublishWithProvider(new ThrowingVerifyProvider());
    expect(failingVerification.isError).toBe(true);
    const verificationText = (failingVerification.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(verificationText).toContain("LIVE_VERIFICATION_FAILED");
    expect(verificationText).toContain("applied");
    expect(verificationText).toContain("release_reconcile");
    expect(verificationText).not.toContain("No content was published");

    const unknownOutcome = await releasePublishError(new Error("provider connection reset"));
    expect(unknownOutcome.isError).toBe(true);
    const unknownText = (unknownOutcome.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(unknownText).toContain("unknown");
    expect(unknownText).toContain("release_reconcile");
    expect(unknownText).not.toContain("No content was published");

    const stale = await releasePublishStaleHash();
    const staleText = (stale.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(staleText).toContain("STALE_RELEASE_APPROVAL");
    expect(staleText).toContain("No content was published");
  });

});

class ThrowingVerifyProvider implements ReleaseProvider {
  readonly key = "test-verify-failure-provider";
  publishCalls = 0;
  verificationSucceeds = false;
  async publish(input: ReleaseProviderPublishInput): Promise<ReleaseProviderPublication> {
    this.publishCalls += 1;
    return {
      providerKey: this.key,
      providerReference: `ref-${input.releaseHash.slice(0, 12)}`,
      artifactHash: input.artifact.hash
    };
  }
  async verify() { return this.verificationSucceeds; }
  async rollback() {}
}

async function releasePublishStaleHash() {
  const repository = new InMemoryEditingRepository();
  repository.registerSite(site);
  const service = new McpEditingService(repository, new InMemoryEventStore());
  const context = requestContext("publisher");
  const draft = await service.createDraft(context, {
    typeName: "article",
    slug: "stale-publish-surface",
    locale: "en",
    title: "Stale publish surface",
    markdown: "# Stale publish surface\n",
    idempotencyKey: "stale-publish-draft-001"
  }) as DraftResult;
  const preview = await service.preparePreview(context, draft.draft.revisionId, "stale-publish-preview-001") as { releaseId: string };
  const server = createMcpServer(service, context);
  const client = new Client({ name: "navocms-stale-publish-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name: "release_publish", arguments: {
      releaseId: preview.releaseId,
      releaseHash: "0".repeat(64),
      idempotencyKey: "stale-publish-publish-01"
    } });
  } finally {
    await client.close();
    await server.close();
  }
}

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

  it("exposes only the statically validated Cloudflare recovery code", async () => {
    const known = await releasePublishError(new CloudflareDeliveryError("CLOUDFLARE_HTTP_403", "token=must-not-leak", 403));
    expect(known.isError).toBe(true);
    const knownText = (known.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(knownText).toContain("CLOUDFLARE_HTTP_403");
    expect(knownText).not.toContain("token=must-not-leak");
    expect(knownText).not.toContain("No content was published");

    const unknown = await releasePublishError(new Error("provider body: token=must-not-leak"));
    expect(unknown.isError).toBe(true);
    const unknownText = (unknown.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(unknownText).toContain("REQUEST_REJECTED");
    expect(unknownText).not.toContain("token=must-not-leak");
    expect(unknownText).not.toContain("No content was published");

    const unsafeProviderCode = await releasePublishError(new CloudflareDeliveryError("CLOUDFLARE_HTTP_403_SECRET", "token=must-not-leak"));
    expect(unsafeProviderCode.isError).toBe(true);
    const unsafeText = (unsafeProviderCode.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(unsafeText).toContain("REQUEST_REJECTED");
    expect(unsafeText).not.toContain("No content was published");
  });

});

async function releasePublishWithProvider(provider: ReleaseProvider) {
  const session = await publishSession(provider);
  try {
    return await session.client.callTool({ name: "release_publish", arguments: {
      releaseId: session.preview.releaseId,
      releaseHash: session.preview.releaseHash,
      idempotencyKey: "provider-error-publish-001"
    } });
  } finally {
    await session.client.close();
    await session.server.close();
  }
}

async function publishSession(provider: ReleaseProvider): Promise<{
  readonly service: McpEditingService;
  readonly context: { authorization: AuthorizationContext };
  readonly preview: { releaseId: string; releaseHash: string };
  readonly client: Client;
  readonly server: ReturnType<typeof createMcpServer>;
}> {
  const repository = new InMemoryEditingRepository();
  repository.registerSite(site);
  const service = new McpEditingService(repository, new InMemoryEventStore(), undefined, undefined, provider);
  const context = requestContext("publisher");
  const draft = await service.createDraft(context, {
    typeName: "article",
    slug: "provider-error-surface",
    locale: "en",
    title: "Provider error surface",
    markdown: "# Provider error surface\n",
    idempotencyKey: "provider-error-draft-001"
  }) as DraftResult;
  const preview = await service.preparePreview(context, draft.draft.revisionId, "provider-error-preview-001") as { releaseId: string; releaseHash: string };
  await service.approveRelease(context, {
    releaseId: preview.releaseId,
    releaseHash: preview.releaseHash,
    idempotencyKey: "provider-error-approve-001"
  });
  const server = createMcpServer(service, context);
  const client = new Client({ name: "navocms-provider-error-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { service, context, preview, client, server };
}

function releasePublishError(error: Error) {
  return releasePublishWithProvider({
    key: "test-throwing-provider",
    async publish() { throw error; },
    async verify() { return false; },
    async rollback() {}
  });
}

function fixture(role: SiteRole) {
  const repository = new InMemoryEditingRepository();
  repository.registerSite(site);
  const events = new InMemoryEventStore();
  return { service: new McpEditingService(repository, events), context: requestContext(role), events };
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
