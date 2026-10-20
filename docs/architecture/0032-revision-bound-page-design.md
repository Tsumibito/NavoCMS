# ADR 0032 — Revision-bound page design

**Status:** Accepted

**Date:** 2026-10-20

## Context

An editor and an MCP agent need to change text and reviewed presentation without
creating separate sources of truth or installing executable content.

## Decision

Attach optional `io.navocms.page-composition.v1` data to immutable content
revisions. Stable section IDs derive from the variant and slot, independent of
order. Content references name the same revision's body or media field. Reviewed
components, variants, recipes and bounded tokens are an explicit allowlist.
Unsupported choices produce a durable development request rather than runtime
CSS, JavaScript or a new component.

Both MCP and the focused browser editor call the same page-change application
service. Each save records the base revision, affected elements, before/after,
validation and resulting revision in one transaction with its event and
idempotency record. Preview preparation attaches an immutable release reference
to that change. Existing head checks serialize competing saves; conflict leaves
browser input intact. Comments retain their original site, variant, revision,
element, field and optional viewport. A missing target is reported as orphaned.

The editor reuses the human OIDC session and existing expiry/revocation checks.
Links identify revisions and do not expire. Writes require content:draft,
same-origin requests and a session/revision-bound signed CSRF value. Its script
uses a fresh CSP nonce. RLS protects editor records independently of HTTP/MCP.
Publication still requires the independent human decision from ADR 0026.

## Compatibility

Migration 0019 adds nullable composition data and an append-only scoped record
table. Existing revisions, source hashes, bundles and routes remain valid.
Composition is additive in exported bundles and delivery snapshots; legacy
routes retain their rendering path. Reviewed Astro rendering includes design
in its digest and uses stable element/field anchors. No new runtime dependency
or editable executable content is introduced.

## Validation

Exercise text/design saves, order and stable IDs, unsupported choices, removed
comment targets, idempotency, concurrent heads, transaction rollback and RLS.
Build the generated Astro project. Check the real browser editor on desktop and
mobile with accessibility scanning, CSRF rejection, read-only access, session
revocation and conflicts. Live acceptance remains separate from automated tests.
