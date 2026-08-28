# Sprint 8R.1 — reviewed Astro artifact object-storage runbook

**Status:** Active on staging; legacy read fallback retained

## Scope and non-goals

Migration `0012` adds only
metadata bindings; `0010` and `0011` stay unchanged and no legacy JSON column
is dropped. New reviewed source/output bundles use the scoped artifact object
store; legacy JSON remains read-compatible until a separate retention decision.

## Required implementation shape

- New source/output registrations require an injected immutable object store.
  The local deterministic adapter is tests only; an absent production adapter
  fails closed.
- Keys must be exactly
  `tenants/<tenant>/sites/<site>/reviewed-astro/<source|output>/sha256/<digest>.json`.
  The digest, key, byte count, source commit, release hashes, state, and
  evidence hash are recorded in PostgreSQL; the bundle bytes are not.
- A resolver reads object bindings first, performs bounded reads and all
  verifier/hash/scope checks, and only then permits delivery. A row with a
  missing, oversized, altered, or mis-scoped object is invalid.
- Legacy `reviewed_astro_artifacts` rows remain read-compatible while no new
  object binding exists for that exact release.

## Crash recovery / orphan reconciliation

1. Do not delete after an object PUT if the SQL transaction fails. The object
   is immutable, content-addressed, and may be a concurrent retry's valid
   write.
2. Inventory only the exact tenant/site prefix, no more than 100 objects per
   request. Record cursor, timestamp, keys, sizes, and hashes as evidence.
3. Compare inventory items to `reviewed_astro_artifact_object_bindings` for
   that exact tenant/site. Re-read a candidate binding before acting.
4. Treat unbound items as recoverable garbage. A future approved lifecycle job
   must use a scoped checkpoint and the existing recoverable-GC pattern; never
   run a provider-wide delete or synchronous cleanup inside registration.

## Remaining retention work

1. Backfill each legacy row with verified source/output objects and binding
   evidence. Keep read fallback until its report is accepted.
2. Propose any legacy-column retention/drop only in a separate destructive
   migration and ADR after retention approval.
