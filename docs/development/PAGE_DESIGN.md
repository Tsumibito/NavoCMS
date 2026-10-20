# Page design and focused editing

Sprint 9.2 introduces reviewed composition on immutable revisions. The default
editorial page has body and media slots with permanent IDs `<variantId>:body`
and `<variantId>:media`. Order changes preserve those IDs and references.
Only section-shell/story-card, regular/compact, plain/muted, editorial/image-led
and regular/tight spacing are allowed. Media can be removed from composition
without deleting its editorial source. The body remains required.

## Agent workflow

1. Read `site_passport`, then `page_design_get(revisionId)`. It returns the base
   source hash, composition, approved policy, bounded full editable text and a
   stable authenticated `/editor/<revisionId>` link.
2. Call `page_change_apply` with revisionId, baseSourceHash, idempotencyKey and
   structural operations, metadataPatch and/or designOperations. Supported design
   operations are variant, component, tone, move (before another stable ID, or
   last when value is omitted), remove, recipe and gap.
3. Read `page_change_status(changeSetId)` for durable before/after, affected
   elements, validation and result revision. Unsupported design choices return
   development_required and explicit missing capabilities without applying any
   part of the request.
4. Call `page_change_preview(changeSetId)` and read change status for the actual
   release/build result. Existing preview and independent publication review
   continue to work. A save or preview does not publish.
5. Use `page_comment_create` and paginated `page_comments_list` for anchored
   comments. Comments retain original revision and optional viewport. Removed
   targets are explicitly orphaned.

The protected editor uses these same application methods without a model call.
It offers title/block text edits, approved component/density/background, recipes,
spacing, section order, comments and preview. A stale save returns a conflict;
input remains in the form with a link to the new head. Reapply deliberately.
Editor links have no capability expiry and reuse the existing human session.
CSRF values last 24 hours; after expiry reload the same stable editor link.
Read-only, expired and revoked sessions cannot write.

## Storage and compatibility

Migration 0019 is required before this runtime. Composition is optional additive
revision data; source Markdown hashes retain their meaning. Exported bundles and
public snapshots carry it when present. Old snapshots retain legacy rendering.
The Astro renderer and Sites pilot consume the same approved choices, stable
anchors and responsive media. Unsupported properties fail closed.

Page changes, comments and preview associations are append-only site-scoped
records protected by RLS, with audit events and idempotency in the same database
transaction. New content never gains executable CSS or JavaScript.

## Verification

`pnpm check` covers unit contracts, real Astro builds, desktop/mobile browser
accessibility and protected editing. Fresh database integration tests cover
restart persistence, duplicate replay, concurrent saves, event-failure rollback,
media references and database isolation. Independent owner acceptance on the
pilot is recorded separately; automated verification does not imply a human
publication decision.
