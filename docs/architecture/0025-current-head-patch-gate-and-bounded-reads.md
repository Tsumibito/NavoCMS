# ADR 0025 — Current-head patch gate and bounded editorial reads

**Status:** Accepted

**Date:** 2026-09-05

**Owners:** NavoCMS maintainers

## Context

Sprint 8.1 targets reliable everyday editing. The audit of the Sprint 8 baseline found that
everyday operations could lose work or report false outcomes:

- `revision_patch` validated the base revision's source hash but not its currency. Two edits
  prepared from the same revision r1 both succeeded: the second created a sibling revision whose
  higher number silently became the variant head, orphaning the first edit's text from the
  current view. An advisory lock serialized revision numbering but not the lost update.
- `content_search` and `drafts_list` were hard-limited to the first 20 rows, so enumerating 45
  documents was impossible through the supported tool surface.
- `content_get` returned a 20,000-character Markdown window but also returned the full
  `metadata.body` mirror and every AST node, so a 25,000-character document produced an
  unbounded response with the source duplicated, and no supported continuation read existed.
- Mutating tools accepted 8–128 character idempotency keys while the event envelope schema
  requires at least 16, so a tool-valid key failed only at event validation after the mutation
  was prepared.
- The review widget treated a valid `previewed` handoff as blocked because it expected a stale
  status literal, and the tool error path always claimed "No content was published", including
  when the provider had already applied an artifact and only the live verification failed.

## Decision

- **Patches require the current head.** `revision_patch` fails closed with
  `REVISION_NOT_CURRENT` when its base revision is not the variant's head. The error carries the
  current revision id, number, and source hash so a rebase is a supported path, not a guess. The
  engine enforces this on the in-memory path; the PostgreSQL repository re-checks the head under
  the variant's advisory lock inside the same transaction that inserts the new revision, which
  makes the check-and-insert atomic across concurrent MCP transactions. Branching remains
  possible through explicit engine imports; only the editorial patch intent is gated.
- **Keyset cursors for site listings.** `content_search` and `drafts_list` accept an opaque
  cursor (the previous page's last content variant id) and return `nextCursor` while rows
  remain. The cursor only positions the scan inside the authorized site; tenant and site filters
  always apply. Search order is `(slug, locale, variant id)`; drafts order is
  `(latest revision created_at, variant id)` descending. Behavior under concurrent changes is
  documented in `mcp-editing-v0alpha1.md` instead of being left implicit.
- **Bounded reads with an explicit continuation.** `content_get` returns the first 20,000
  characters, at most 100 AST nodes with 280-character excerpts, and omits the `metadata.body`
  mirror. The new `content_read` tool returns a bounded Markdown window, a page of AST nodes, or
  one node's full text (capped at 20,000 characters). Revisions are immutable, so offsets are
  stable and the full source is always reachable through consecutive bounded windows.
- **One idempotency key bound.** Mutating tools and the editing service enforce 16–128
  characters, matching the event envelope minimum, before any reservation, policy charge, or
  effect. The released event envelope schema is unchanged.
- **Honest error and handoff projections.** Tool errors carry a safe `effectState` projection:
  `none` (nothing happened), `applied` (the provider effect happened; verification or
  checkpointing did not complete; reconcile), or `unknown` (outcome cannot be proven; check
  status and reconcile). The unconditional "No content was published" text is reserved for
  pre-effect failures. The review widget renders `previewed` handoffs as ready, links the
  expiring capability URL, and states that it renders a Markdown proof artifact rather than the
  future rendered-design preview.
- **Bounded metadata projection.** Content reads never trust stored metadata to be small. The
  projection drops the `body` mirror and packs the remaining fields into a 4,000 serialized
  JSON-character budget per response; fields that do not fit are omitted whole and reported by
  name (`metadataTruncated`, `metadataTotalCharacters`, `metadataOmittedKeys`), never cut
  mid-value, and remain reachable through bounded `content_read` windows (`metadataKey` mode)
  on the same immutable revision. Independent acceptance proved that a 180 KB allowed metadata
  field otherwise bypassed the read budget, so the budget covers serialized keys and values,
  not just AST node counts.
- **Incomplete reservations keep effect evidence.** Retrying an operation whose idempotency
  reservation is `pending` or `failed` reports what the durable record can prove: `none` only
  when the operation is transactional and its rollback provably included the effect, `unknown`
  (with `release_status`/`release_reconcile` guidance and the recorded error code) when the
  operation crossed the provider boundary. The presence of a reservation alone is never treated
  as evidence that nothing was published.

## Consequences

- Concurrent edits conflict loudly and rebase explicitly; no everyday path silently drops a
  saved change. Callers rebasing after a conflict must use a new idempotency key.
- Large sites are enumerable through supported tools, and large documents are fully readable
  without unbounded responses or duplicated bodies. Stored metadata values above the response
  budget cost one extra bounded window per 20,000 characters to read back.
- The 8–15 character key range is a compatibility break for clients that used short keys;
  `mcp-editing-v0alpha1.md` documents the tightened bound.
- No database migration is required: cursors, head checks, read bounds, and reservation state
  (`status`, `error_code`) use existing columns and indexes.
- The proof-artifact wording keeps the widget and the text fallback honest until Sprint 8.2
  delivers the real rendered-design preview; it does not promise that capability early.
