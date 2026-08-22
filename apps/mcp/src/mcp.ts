import { existsSync, readFileSync } from "node:fs";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ContentError } from "@navocms/content";
import { KernelError } from "@navocms/kernel";
import { SecurityError } from "@navocms/security";
import { z } from "zod";

import { McpEditingError } from "./errors.js";
import type { McpRequestContext } from "./model.js";
import { McpEditingService } from "./service.js";

const WIDGET_URI = "ui://navocms/editorial-review-v1.html";
const SITE_RESOURCE_URI = "navocms://site/current/profile";
const adjacentWidget = new URL("./widget.html", import.meta.url);
const widgetHtml = readFileSync(
  existsSync(adjacentWidget) ? adjacentWidget : new URL("../dist/widget.html", import.meta.url),
  "utf8"
);

const operationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replaceText"), nodeId: z.string().min(1), value: z.string() }),
  z.object({ op: z.literal("replaceNode"), nodeId: z.string().min(1), markdown: z.string() }),
  z.object({ op: z.literal("insertAfter"), nodeId: z.string().min(1), markdown: z.string() }),
  z.object({ op: z.literal("remove"), nodeId: z.string().min(1) })
]);

export function createMcpServer(service: McpEditingService, context: McpRequestContext): McpServer {
  const server = new McpServer({ name: "NavoCMS", version: "0.1.0" });

  server.registerTool("sites_list", {
    title: "List authorized sites",
    description: "List only the site visible to the current OAuth token. Use before content work when site context is unclear.",
    inputSchema: {},
    annotations: readOnlyAnnotations()
  }, safeTool(async () => result("Authorized site", { sites: await service.listSites(context) })));

  server.registerTool("content_search", {
    title: "Search site content",
    description: "Search titles, slugs, types, and Markdown excerpts inside the authorized site. Returns bounded summaries, revision IDs, and source hashes.",
    inputSchema: {
      query: z.string().max(500).default(""),
      limit: z.number().int().min(1).max(20).optional()
    },
    annotations: readOnlyAnnotations()
  }, safeTool(async ({ query, limit }) => result("Content search completed", await service.search(context, query, limit))));

  server.registerTool("content_get", {
    title: "Read a content revision",
    description: "Read portable Markdown, safe metadata, stable AST node IDs, and the source hash for one authorized revision. Use before proposing a patch.",
    inputSchema: { revisionId: z.string().min(1) },
    annotations: readOnlyAnnotations()
  }, safeTool(async ({ revisionId }) => result("Content revision loaded", await service.getContent(context, revisionId))));

  server.registerTool("drafts_list", {
    title: "List drafts",
    description: "List the newest bounded draft queue for the authorized site.",
    inputSchema: { limit: z.number().int().min(1).max(20).optional() },
    annotations: readOnlyAnnotations()
  }, safeTool(async ({ limit }) => result("Draft queue loaded", await service.listDrafts(context, limit))));

  server.registerTool("draft_create", {
    title: "Create a Markdown draft",
    description: "Create an immutable first revision from Markdown. Requires content:draft and an idempotency key. This never publishes content.",
    inputSchema: {
      typeName: z.enum(["article", "landing-page", "organization", "legal-page"]),
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      locale: z.string().min(2).max(20),
      title: z.string().min(1).max(180),
      markdown: z.string().min(1).max(200_000),
      metadata: z.record(z.string(), z.unknown()).optional(),
      idempotencyKey: z.string().min(8).max(128)
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, safeTool(async (input) => result("Draft created; nothing was published", await service.createDraft(context, input))));

  server.registerTool("revision_patch", {
    title: "Apply a structural Markdown patch",
    description: "Create a new draft revision by applying stable AST operations to an exact source hash. Stale hashes fail closed. This never publishes content.",
    inputSchema: {
      revisionId: z.string().min(1),
      baseSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
      operations: z.array(operationSchema).min(1).max(50),
      idempotencyKey: z.string().min(8).max(128)
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, safeTool(async (input) => result("New draft revision created; nothing was published", await service.patchRevision(context, input))));

  server.registerTool("revision_compare", {
    title: "Compare revisions",
    description: "Compare two revisions of the same variant and return a bounded line diff with exact before/after hashes.",
    inputSchema: { fromRevisionId: z.string().min(1), toRevisionId: z.string().min(1) },
    annotations: readOnlyAnnotations()
  }, safeTool(async ({ fromRevisionId, toRevisionId }) => result(
    "Revision comparison completed",
    await service.compare(context, fromRevisionId, toRevisionId)
  )));

  server.registerTool("preview_prepare", {
    title: "Create a protected immutable preview",
    description: "Build an expiring noindex capability URL and bind it to the exact release and artifact hashes. This does not publish.",
    inputSchema: { revisionId: z.string().min(1), idempotencyKey: z.string().min(8).max(128) },
    annotations: writeAnnotations()
  }, safeTool(async ({ revisionId, idempotencyKey }) => result("Protected preview created; nothing was published", await service.preparePreview(context, revisionId, idempotencyKey))));

  server.registerTool("release_status", {
    title: "Read release status",
    description: "Read the immutable hashes and current durable workflow state for one release.",
    inputSchema: { releaseId: z.string().uuid() },
    annotations: readOnlyAnnotations()
  }, safeTool(async ({ releaseId }) => result("Release status loaded", await service.releaseStatus(context, releaseId))));

  server.registerTool("release_approve", {
    title: "Approve an exact previewed release",
    description: "Approve only the supplied release hash. A stale or changed hash fails closed. Requires content:publish.",
    inputSchema: exactReleaseInput(),
    annotations: writeAnnotations()
  }, safeTool(async (input) => result("Exact release approved; it is not published yet", await service.approveRelease(context, input))));

  server.registerTool("release_publish", {
    title: "Publish and verify an approved release",
    description: "Publish the identical previewed artifact, verify its hash, and checkpoint the durable workflow. Requires content:publish.",
    inputSchema: exactReleaseInput(),
    annotations: writeAnnotations()
  }, safeTool(async (input) => result("Approved release published and verified", await service.publishRelease(context, input))));

  server.registerTool("release_reconcile", {
    title: "Reconcile an incomplete publication",
    description: "Resume or verify a partially completed publication without duplicating an already checkpointed effect.",
    inputSchema: exactReleaseInput(),
    annotations: writeAnnotations()
  }, safeTool(async (input) => result("Release workflow reconciled", await service.reconcileRelease(context, input))));

  server.registerTool("release_rollback", {
    title: "Roll back to the previous verified publication",
    description: "Restore the prior verified artifact and retain the full audit trail. Requires exact hash and content:publish.",
    inputSchema: exactReleaseInput(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  }, safeTool(async (input) => result("Release rolled back to the previous verified publication", await service.rollbackRelease(context, input))));

  registerStandardTools(server, service, context);
  registerReviewTools(server, service, context);

  server.registerResource("authorized-site-profile", SITE_RESOURCE_URI, {
    title: "Authorized NavoCMS site profile",
    description: "Safe agent-readable identity and locale profile for the OAuth-scoped site.",
    mimeType: "application/json"
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ sites: await service.listSites(context) }) }]
  }));

  registerAppResource(server, "NavoCMS editorial review", WIDGET_URI, {
    description: "Portable Markdown, revision diff, draft queue, and preview handoff review surface.",
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } }
  }, async () => ({
    contents: [{
      uri: WIDGET_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: widgetHtml,
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } }
    }]
  }));

  return server;
}

function registerStandardTools(server: McpServer, service: McpEditingService, context: McpRequestContext): void {
  server.registerTool("search", {
    title: "Search NavoCMS",
    description: "Standard connector search over the authorized site's content. Returns document IDs suitable for fetch.",
    inputSchema: { query: z.string().max(500) },
    annotations: readOnlyAnnotations()
  }, safeTool(async ({ query }) => jsonOnly({
    results: extractResults(await service.search(context, query))
      .map((item) => ({ id: `document:${String(item.id)}`, title: item.title, url: `navocms://document/${String(item.id)}` }))
  })));

  server.registerTool("fetch", {
    title: "Fetch NavoCMS content",
    description: "Standard connector fetch for an ID returned by search. Returns one JSON text block with Markdown and safe metadata.",
    inputSchema: { id: z.string().min(1) },
    annotations: readOnlyAnnotations()
  }, safeTool(async ({ id }) => jsonOnly(await service.fetch(context, id))));
}

function registerReviewTools(server: McpServer, service: McpEditingService, context: McpRequestContext): void {
  const appMeta = { ui: { resourceUri: WIDGET_URI, visibility: ["model"] as const } };
  registerAppTool(server, "review_markdown", {
    title: "Show Markdown review",
    description: "Render a requested revision as a compact proof sheet in the conversation. Use after content_get when visual review helps.",
    inputSchema: { revisionId: z.string().min(1) },
    annotations: readOnlyAnnotations(),
    _meta: appMeta
  }, safeTool(async ({ revisionId }) => {
    const content = await service.getContent(context, revisionId) as Record<string, unknown>;
    const metadata = content.metadata as Record<string, unknown>;
    return result("Markdown review opened", {
      view: "markdown",
      title: metadata.title ?? metadata.name ?? "Untitled",
      revisionNumber: content.revisionNumber,
      sourceHash: content.sourceHash,
      markdown: content.markdown,
      truncated: content.truncated
    });
  }));

  registerAppTool(server, "review_diff", {
    title: "Show revision diff",
    description: "Render an exact bounded before/after diff in the conversation.",
    inputSchema: { fromRevisionId: z.string().min(1), toRevisionId: z.string().min(1) },
    annotations: readOnlyAnnotations(),
    _meta: appMeta
  }, safeTool(async ({ fromRevisionId, toRevisionId }) => {
    const compared = await service.compare(context, fromRevisionId, toRevisionId) as { diff: Record<string, unknown> };
    return result("Revision diff opened", { view: "diff", ...compared.diff });
  }));

  registerAppTool(server, "review_drafts", {
    title: "Show draft queue",
    description: "Render the authorized site's draft queue in the conversation.",
    inputSchema: { limit: z.number().int().min(1).max(20).optional() },
    annotations: readOnlyAnnotations(),
    _meta: appMeta
  }, safeTool(async ({ limit }) => {
    const queue = await service.listDrafts(context, limit) as Record<string, unknown>;
    return result("Draft queue opened", { view: "drafts", ...queue });
  }));

  registerAppTool(server, "review_preview_handoff", {
    title: "Show preview handoff",
    description: "Render whether an immutable revision is safely bound and ready for the protected preview workflow.",
    inputSchema: { revisionId: z.string().min(1), idempotencyKey: z.string().min(8).max(128) },
    annotations: writeAnnotations(),
    _meta: appMeta
  }, safeTool(async ({ revisionId, idempotencyKey }) => result("Protected preview opened", {
    view: "workflow",
    ...await service.preparePreview(context, revisionId, idempotencyKey)
  })));
}

function readOnlyAnnotations() {
  return { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
}

function writeAnnotations() {
  return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
}

function exactReleaseInput() {
  return {
    releaseId: z.string().uuid(),
    releaseHash: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().min(8).max(128)
  };
}

function result(message: string, structuredContent: object) {
  return { content: [{ type: "text" as const, text: message }], structuredContent: { ...structuredContent } };
}

function jsonOnly(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function safeTool<TArgs extends Record<string, unknown>>(
  handler: (args: TArgs) => Promise<ReturnType<typeof result> | ReturnType<typeof jsonOnly>>
) {
  return async (args: TArgs) => {
    try {
      return await handler(args);
    } catch (error) {
      const code = error instanceof SecurityError || error instanceof ContentError || error instanceof KernelError || error instanceof McpEditingError
        ? error.code
        : "REQUEST_REJECTED";
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: `NavoCMS rejected the request (${code}). No content was published.` }]
      };
    }
  };
}

function extractResults(value: object): readonly Record<string, unknown>[] {
  const results = (value as { results?: unknown }).results;
  return Array.isArray(results) ? results.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
}
