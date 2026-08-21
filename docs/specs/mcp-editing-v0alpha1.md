# MCP editing v0alpha1

The MCP editing boundary exposes goal-oriented, site-scoped operations over portable Markdown and
immutable revisions. It is an application boundary, not a trusted-kernel plugin and not a direct
database interface.

## Connection and authority

- Remote HTTP uses Streamable HTTP at the configured resource URL.
- Every request requires a verified OAuth access token with issuer, audience, expiry, tenant, site,
  principal, and scopes.
- An MCP server instance is bound to the token's single tenant/site scope. `sites_list` therefore
  returns at most that authorized site; it cannot enumerate a tenant by inference.
- Read tools require `content:read`. Draft and patch tools require `content:draft`.
- UI resources receive only the structured result selected for display. They receive no database,
  token, secret-broker, network, clipboard, or geolocation access.

## Tool surface

| Tool | Intent | Permission | Effect |
|---|---|---|---|
| `sites_list` | Confirm authorized site context | `content:read` | Read only |
| `content_search` | Discover content with bounded excerpts | `content:read` | Read only |
| `content_get` | Read one Markdown revision and stable node IDs | `content:read` | Read only |
| `drafts_list` | Inspect current drafts | `content:read` | Read only |
| `draft_create` | Create an immutable first draft revision | `content:draft` | G1, idempotent |
| `revision_patch` | Apply stable structural operations to an exact hash | `content:draft` | G1, idempotent |
| `revision_compare` | Compare two revisions of one variant | `content:read` | Read only |
| `preview_prepare` | Bind revision, hash, and workflow for future preview | `content:read` | Read only |
| `search` | Standard connector search alias | `content:read` | Read only |
| `fetch` | Standard connector fetch alias | `content:read` | Read only |

Four decoupled review tools attach the same versioned review resource:

- `review_markdown`;
- `review_diff`;
- `review_drafts`;
- `review_preview_handoff`.

Each has a text fallback. A host without MCP Apps support can complete the corresponding workflow by
calling the underlying data tool and presenting its result.

## Bounds and redaction

- Search and draft lists return at most 20 items; the default is 8.
- Markdown returns at most 20,000 characters and reports truncation and total size.
- Diffs return at most 400 lines and report truncation and total size.
- AST node text excerpts return at most 280 characters.
- HTTP request bodies are limited to 256 KiB before MCP parsing.
- Every structured result passes the shared safe-projection check. Secret-shaped keys are rejected,
  not masked after exposure.
- Tool errors return stable safe codes and never include stack traces, tokens, hidden reasoning, or
  unrestricted input payloads.

## Mutation semantics

`draft_create` and `revision_patch` require an 8–128 character idempotency key. Repeating the same
operation, site, key, and input returns the original result. Reusing a key with different input
fails closed.

Draft creation accepts optional content-type metadata. The repository always derives `slug`, the
portable Markdown `body`, and the type's title/name field from explicit tool arguments; remaining
required fields, such as a legal page's effective date, must be supplied and pass the content-type
schema. The MCP layer never invents legal or publication dates.

Every mutation creates an immutable revision and appends a G1 domain event containing identifiers,
hashes, phase, and operation count only. It never records full Markdown or agent reasoning.

`revision_patch` accepts `replaceText`, `replaceNode`, `insertAfter`, and `remove`. The content engine
rejects stale hashes, invalid targets, overlapping operations, unsafe Markdown, and invalid metadata.

## Preview boundary

`preview_prepare` is intentionally not a preview deployment. It verifies that a revision exists in
the authorized site and returns:

- exact revision ID and source hash;
- selected workflow ID;
- `ready-for-workflow` status;
- `enqueue-protected-preview` as the next step;
- `previewUrl: null`.

Sprint 7 will add durable execution, protected noindex URLs, exact-hash approval, release creation,
publication, verification, and rollback. An MCP client must not interpret a Sprint 5 handoff as an
approval or publication.

## Compatibility note

This adds a new v0alpha1 application contract and does not change released JSON Schemas. Tool names,
input fields, and structured result fields may evolve before v0.1; breaking changes require a new
tool or resource version and an explicit migration note. The review URI includes `v1` so a later UI
can coexist without changing existing tool results.
