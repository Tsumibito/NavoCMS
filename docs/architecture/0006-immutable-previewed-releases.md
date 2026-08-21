# ADR 0006 — Immutable previewed releases

**Status:** Proposed

**Date:** 2026-08-21

## Context

Publishing mutable content after a human reviewed an earlier preview creates a time-of-check to
time-of-use failure. Builds and deployments can also partially succeed, be retried, or diverge from
the reviewed state.

## Decision

Represent every content/design/profile change as a new immutable revision. Assemble a release
candidate containing exact content, design, delivery, governance, plugin, and artifact hashes.
Preview, quality gates, and approval bind to that release hash. Publication deploys the identical
artifact and then records live verification.

Any anchor or release-item change invalidates prior approval. Public reversible actions are
idempotent and carry rollback targets. External irreversible effects declare compensation or use a
higher consequence gate.

## Consequences

- Mutable drafts are a user-facing projection over immutable revisions.
- Preview providers must protect access, set noindex, expire links, and identify the release hash.
- Publication status distinguishes requested, applied, verified, failed, and rolled back.
- A durable workflow engine may replay technical execution, while the NavoCMS Event Ledger remains
  the portable human-readable domain audit.

## Alternatives considered

- **Publish current draft after approval:** rejected because approval can become stale.
- **Trust deployment provider history as audit:** rejected because it lacks domain policy context
  and is not portable.

## Validation

Sprint 7 must prove crash-safe retry without duplicate effects, stale-approval rejection, identical
preview/publication artifact hashes, live verification, partial-failure reconciliation, and rollback.
