# Sprint 8R.1 — reviewed Astro artifact object-storage runbook

**Status:** Review required / Pending CI

## Scope and non-goals

This is an expand/backfill/cutover boundary. Migration `0012` adds only
metadata bindings; `0010` and `0011` stay unchanged and no legacy JSON column
is dropped. No R2 activation, credentials, provider API call, deployment,
commit, or push is authorised by this sprint.

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

## Gates before the next package

1. Apply the ordered migration and prove registry checksum integrity.
2. Run the PostgreSQL/RLS/failure suites and record the evidence.
3. Reuse or extract the existing S3-compatible provider core for a real
   adapter; review it separately. Inject credentials only through dotenvx.
4. Backfill each legacy row with verified source/output objects and binding
   evidence. Keep read fallback until its report is accepted.
5. Propose any legacy-column retention/drop only in a separate destructive
   migration and ADR after retention approval.
