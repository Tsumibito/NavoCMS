# MCP editing v0alpha1

The MCP editing boundary exposes goal-oriented, site-scoped operations over portable Markdown and
immutable revisions. It is an application boundary, not a trusted-kernel plugin and not a direct
database interface.

## Connection and authority

- Remote HTTP uses Streamable HTTP at the configured resource URL.
- Every request requires a verified OAuth access token with issuer, audience, expiry, subject, and
  scopes. The deployed resource supplies its immutable tenant/site binding; matching token claims are
  accepted but never required.
- PostgreSQL resolves `issuer + subject` to an internal identity and site membership. Token scopes,
  persisted role, optional restrictions, and operation authority are intersected.
- An MCP server instance is bound to one tenant/site scope. `sites_list` therefore
  returns at most that authorized site; it cannot enumerate a tenant by inference.
- Read tools require `content:read`. Draft and patch tools require `content:draft`.
- UI resources receive only the structured result selected for display. They receive no database,
  token, secret-broker, network, clipboard, or geolocation access.

## Tool surface

| Tool | Intent | Permission | Effect |
|---|---|---|---|
| `sites_list` | Confirm authorized site context | `content:read` | Read only |
| `content_search` | Discover content with bounded excerpts and a keyset cursor | `content:read` | Read only |
| `content_get` | Read one Markdown revision window and stable node IDs | `content:read` | Read only |
| `content_read` | Read a bounded Markdown window, AST node page, or one full node | `content:read` | Read only |
| `drafts_list` | Inspect current drafts with a keyset cursor | `content:read` | Read only |
| `draft_create` | Create an immutable first draft revision | `content:draft` | G1, idempotent |
| `revision_patch` | Apply stable structural operations to an exact hash | `content:draft` | G1, idempotent |
| `revision_compare` | Compare two revisions of one variant | `content:read` | Read only |
| `preview_prepare` | Create an expiring exact-hash preview | `content:read` | G1, idempotent |
| `release_status` | Inspect durable release state and hashes | `content:read` | Read only |
| `release_approve` | Approve the exact previewed release hash | `content:publish` | G1, idempotent |
| `release_publish` | Apply and verify the identical artifact | `content:publish` | G1, idempotent |
| `release_reconcile` | Resume or verify an incomplete effect | `content:publish` | G1, idempotent |
| `release_rollback` | Restore the previous verified artifact | `content:publish` | G2, idempotent |
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

- Search and draft lists return at most 20 items; the default is 8. Both accept an opaque
  `cursor` (the previous page's last content variant id) and return `nextCursor` until the
  current set is exhausted. Search rows are ordered by `(slug, locale, variant id)`; drafts by
  `(latest revision created_at, variant id)` descending. Slugs and locales are immutable, so a
  full pass over an unchanged set yields every row exactly once. Draft positions move forward
  when a draft is patched, so an in-flight draft pass may shift rows into later pages; documents
  or drafts created after the cursor was issued are picked up on the next pass. The cursor only
  positions the scan inside the authorized site — tenant and site filters always apply, and an
  unknown-but-well-formed cursor yields an empty page.
- Markdown windows return at most 20,000 characters and report truncation and total size.
- `content_read` returns the remaining source through repeated bounded Markdown windows, one
  AST node's full text (at most 20,000 characters), or a page of AST nodes. Revisions are
  immutable, so window offsets and node pages are stable across calls.
- AST node listings return at most 100 nodes per response with 280-character text excerpts and
  report truncation and the total node count. Larger ASTs never bypass the budget through
  multiple excerpted pages plus full-node reads; each response stays inside its own bound.
- Structured content projections omit the `metadata.body` mirror so the full source is never
  duplicated behind a bounded field.
- Diffs return at most 400 lines and report truncation and total size.
- HTTP request bodies are limited to 256 KiB before MCP parsing.
- Every structured result passes the shared safe-projection check. Secret-shaped keys are rejected,
  not masked after exposure.
- Tool errors return stable safe codes, an `effectState` projection (`none`, `applied`, or
  `unknown`), and — for revision conflicts — the current revision id and source hash. They never
  include stack traces, tokens, hidden reasoning, or unrestricted input payloads. An error after
  the provider applied an effect is never reported as "no content was published"; it names the
  applied effect and the `release_reconcile` recovery path, or honestly reports the outcome as
  unknown.

## Mutation semantics

Every mutating tool requires a 16–128 character idempotency key. The floor matches the event
envelope's `navoidempotencykey` minimum, so a key accepted by a tool can never fail only at
event validation after the mutation was prepared. Repeating the same operation, site, key, and
input returns the original result — including after the variant head advanced. Reusing a key
with different input fails closed. A rebased retry after a `REVISION_NOT_CURRENT` conflict is a
new operation and needs a new key.

Draft creation accepts optional content-type metadata. The repository always derives `slug`, the
portable Markdown `body`, and the type's title/name field from explicit tool arguments; remaining
required fields, such as a legal page's effective date, must be supplied and pass the content-type
schema. The MCP layer never invents legal or publication dates.

Every mutation creates an immutable revision and appends a G1 domain event containing identifiers,
hashes, phase, and operation count only. It never records full Markdown or agent reasoning.

`revision_patch` accepts `replaceText`, `replaceNode`, `insertAfter`, and `remove`. The content engine
rejects stale hashes, invalid targets, overlapping operations, unsafe Markdown, and invalid metadata.
A patch must also be based on the variant's **current head revision**. A patch that targets an older
revision fails closed with `REVISION_NOT_CURRENT` and reports the current revision id, number, and
source hash, so the caller can re-read the head and reapply the change on top of it. Two concurrent
edits from the same base therefore cannot silently orphan each other: in-memory, the engine compares
the base against the variant head; in PostgreSQL, the head check runs under the variant's advisory
lock inside the same transaction as the insert.

## Preview and release boundary

`preview_prepare` assembles a canonical release manifest, renders one immutable proof artifact, and
returns an expiring 256-bit capability URL. The response contains revision, source, release, and
artifact hashes. Preview responses set `X-Robots-Tag: noindex, nofollow, noarchive`, a matching HTML
robots directive, `Cache-Control: private, no-store`, a restrictive CSP, and no referrer policy.

Approval stores the exact release hash. Publication fails closed if the supplied hash or provider's
artifact hash differs. Workflow runs and step outputs are checkpointed in PostgreSQL. Verification
is distinct from provider application; an interrupted or failed verification is resumed through
`release_reconcile` without repeating a completed effect. Rollback targets only the previous recorded
publication and preserves both histories.

Release providers must treat the release hash as their idempotency key. If a process stops after the
provider applies an artifact but before NavoCMS records its reference, reconciliation may repeat the
provider call; it must return the same effect instead of creating a second publication.

The embedded provider proves the release protocol but is not a public-site renderer. Astro,
Cloudflare, and alternative delivery providers arrive behind the same interface in Sprint 8.

## Compatibility note

Sprint 7 changes the v0alpha1 `preview_prepare` input by requiring `idempotencyKey` and replaces the
Sprint 5 handoff fields with a real capability URL and release/artifact hashes. It also adds the five
release tools above. No released JSON Schema changes. The review URI remains `v1` because the widget
continues to consume a backwards-compatible workflow-shaped projection.

Sprint 8.1 tightens the mutating-tool idempotency key from 8–128 to 16–128 characters (the event
envelope minimum was already 16; keys of 8–15 characters previously passed tool validation and then
failed event validation after the mutation was prepared). `content_get` now returns only the first
20,000-character Markdown window with bounded AST projections and omits the `metadata.body` mirror;
`content_read` is added for bounded continuation reads. `content_search` and `drafts_list` accept an
optional cursor and return `nextCursor` when more rows exist. `revision_patch` additionally rejects
patches whose base revision is no longer the variant head with `REVISION_NOT_CURRENT` including the
current head coordinates; callers that previously patched from a stale base must rebase onto the
current head. Tool error results now carry a safe `effectState` structured projection. The preview
handoff renders `previewed` (and the legacy `ready-for-workflow`) payloads as ready and states the
honest limitation that the capability URL renders a Markdown proof artifact, not a rendered design
preview. No released JSON Schema changes; the v0alpha1 tool descriptions and this note document the
new bounds.
