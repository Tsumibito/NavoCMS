# ADR 0010 — Decoupled MCP editing surface

**Status:** Accepted

**Date:** 2026-08-21

**Owners:** NavoCMS maintainers

## Context

NavoCMS needs to work in ChatGPT, Claude, and other MCP clients without recreating a conventional
CMS admin panel. The agent needs small, predictable operations for discovery, Markdown reading,
draft creation, stable patches, comparison, and preview preparation. Some hosts can render MCP Apps;
others expose tools and text only.

The MCP boundary is security-sensitive. It must not become a parallel authorization or content
implementation, and UI state must not become authoritative.

## Decision

Create `@navocms/mcp` as a transport application over the existing security, content, and event
packages.

- Every server instance is bound to one verified OAuth principal, tenant, and site.
- Tools express one recognizable editorial intent and declare read-only, destructive, idempotent,
  and open-world annotations.
- Data tools return concise text plus bounded structured data. `search` and `fetch` provide standard
  connector aliases with a single JSON text block.
- Draft and patch operations require `content:draft`, an idempotency key, and an auditable G1 event.
- Patches address stable Markdown AST nodes and bind to the complete source hash.
- Review tools are separate from data tools. They attach a versioned `ui://` resource for Markdown,
  diff, draft-queue, and workflow views.
- The review resource uses the standard MCP Apps bridge, requests no network or device permission,
  and is never the only way to complete a workflow.
- Preview preparation returns an immutable revision/hash/workflow handoff only. It cannot create a
  URL, deploy, approve, or publish until the durable workflow and release boundary exists.

## Consequences

- The same content operations remain usable in non-UI MCP clients.
- Embedded UI can evolve independently from tool data contracts.
- A token cannot enumerate other sites; a different site requires a separately authorized MCP
  connection.
- Output limits and redaction reduce accidental disclosure and context flooding.
- Sprint 5 uses an in-memory editing repository as an executable adapter fixture. Production
  persistence remains behind the same repository interface and is not implied by this ADR.
- Actual protected previews, exact-hash approval, publication, and rollback remain Sprint 7 work.

## Alternatives considered

- **One large `manage_site` tool:** rejected because ambiguous authority, retries, and review are
  harder to reason about.
- **Widget-first editor:** rejected because it would fail the UI-optional product invariant.
- **Direct database tools:** rejected because they bypass content validation, authorization, events,
  and immutable revisions.
- **Publishing in Sprint 5:** rejected because no durable workflow or immutable release provider is
  available yet.

## Validation

- MCP protocol tests list and call the registered tools through an in-memory transport.
- Security tests cover viewer denial, cross-site revision denial, and stale-source failure.
- Retry tests prove same-input idempotency and reject idempotency-key drift.
- Projection tests enforce bounded Markdown, search, and diff results.
- Resource tests verify the standard MCP Apps MIME type and the no-network CSP.
- Deterministic agent scenarios cover draft listing, comparison, patching, and preview preparation.

Implementation follows the official MCP server, tool, and UI guidance and adapts the pinned minimal
Node example rather than inventing a host-specific transport:

- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [Define tools](https://developers.openai.com/plugins/plan/tools)
- [Build ChatGPT UI](https://developers.openai.com/plugins/build/chatgpt-ui)
- [OpenAI Apps SDK examples](https://github.com/openai/openai-apps-sdk-examples)

### Upstream adaptation record

- **Archetype:** interactive, decoupled data and render tools.
- **Upstream example:**
  [`mcp_app_basics_node`](https://github.com/openai/openai-apps-sdk-examples/tree/18cc38e78a968712c357bacdc3c79fead5bfc6b4/mcp_app_basics_node).
- **Pinned commit:** `18cc38e78a968712c357bacdc3c79fead5bfc6b4`.
- **Retained:** `McpServer`, stateless Streamable HTTP, `registerAppTool`,
  `registerAppResource`, versioned `ui://` resources, the MCP Apps bridge, tool annotations, text
  fallback, and structured widget data.
- **Replaced:** the educational Express/CORS shell, demo tools, React walkthrough widgets, and open
  unauthenticated access. NavoCMS uses its OAuth boundary, content/security/event packages, vanilla
  bundled UI, bounded projections, and site-scoped repository interface.
