# ADR 0022 — Reviewed Astro object-storage boundary

**Status:** Proposed

**Date:** 2026-08-28

## Context

`reviewed_astro_artifacts` (ADR 0017/0019) stores complete reviewed Astro
source and built-output JSON in PostgreSQL. Those bundles are bounded but are
not relational evidence, increase database backup/restore blast radius, and
cannot be shared safely as immutable storage objects.

## Decision

New registrations write canonical JSON source and output bundles to a
provider-neutral immutable object-storage interface. Object keys are
tenant/site-scoped and content-addressed by the SHA-256 of the exact stored
bytes. PostgreSQL stores only the exact environment/release binding, logical
and object hashes, source commit, keys, byte counts, `ready` state, and a
binding-evidence hash in `reviewed_astro_artifact_object_bindings`.

The existing idempotency store, scoped transaction, Event Ledger, and outbox
remain the only durable workflow mechanisms. An object PUT occurs before the
SQL transaction because it cannot participate in PostgreSQL atomicity. It is
safe to replay only at the same immutable key and exact bytes. A transaction
failure therefore leaves an orphan object, never a database binding to a
missing object. Reads prefer the new binding and recheck size, object digest,
source/output verifier, release scope, and route parity; they fall back to the
legacy row only while compatibility is required.

This expand-only migration does not alter `0010`/`0011` or drop legacy JSON
columns. The included local deterministic adapter is test-only. The future
real S3-compatible/R2 composition must reuse/extract the existing provider
core rather than add a second S3 HTTP stack; it is deliberately not activated,
credentialed, or called here.

## Recovery and cutover

Reconciliation inventories only the exact tenant/site reviewed-Astro prefix,
with a maximum page size of 100. Operators compare that inventory with binding
metadata and retain evidence. An unbound object is recoverable garbage: do not
delete it inline or provider-wide. A later lifecycle job may apply the existing
recoverable-GC pattern after an approved retention window and an evidence-bound
checkpoint. New writes require object storage; legacy rows remain read-only
fallback until backfill evidence and a separate destructive-retention ADR.

## Validation

Focused tests cover content-addressed immutability, bounded reads/inventory,
new PostgreSQL replay/concurrency/rollback behavior, and RLS readiness. Full
PostgreSQL and CI validation remains required before acceptance.
