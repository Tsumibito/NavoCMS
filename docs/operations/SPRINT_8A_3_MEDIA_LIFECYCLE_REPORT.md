# Sprint 8A.3 — Media lifecycle and orphan reconciliation

## Status

The Sprint 8A.3 code gate is accepted. The retained PostgreSQL CI run applied
all eight migrations, executed every test without skips, passed the media RLS
and integrity suite, and built the production container. No provider or
staging operational gate is claimed by this package.

## Implemented boundary

- `0008_media_lifecycle.sql` creates FORCE RLS lifecycle checkpoints and adds
  a validated, database-enforced 24-hour minimum deletion grace. Orphan
  checkpoints have the same floor and completed checkpoints require a
  completion timestamp.
- A media asset moves through schedule → recoverable storage delete → restore
  or reclaim. Reclaim is addressable, requires a completed recoverable-delete
  checkpoint, and rechecks the grace deadline before calling storage.
- Every completed lifecycle mutation uses the existing PostgreSQL
  idempotency store, Event Ledger, and transactional outbox in one scoped
  transaction. Event identities include their operation name.
- Storage effects have an `effect_pending` checkpoint before the effect and
  are safe to repeat after a crash before the completion transaction.
- Reconciliation inventories only the exact site original prefix, with a
  limit of at most 100. A shared lexical cursor merges storage and database
  keys without skipping database-only originals. It recoverably deletes a
  storage orphan and quarantines an asset whose recorded original is missing
  from storage.

## Code-review corrections

- Restore now requires a completed recoverable-delete checkpoint from the
  current delete cycle; a checkpoint from an older restored cycle is not
  accepted.
- Reclaim fails closed when the provider reports no deleted object while a
  live object still exists. A retry after a completed storage reclaim remains
  safe.
- Reconciliation pagination now advances across both provider inventory and
  PostgreSQL originals. Integration coverage uses a one-item page to prove
  that multiple missing originals are all reached.
- A retried orphan preparation reuses its persisted grace deadline rather
  than silently extending it or publishing a different deadline.
- The first PostgreSQL CI run exposed a contradictory lifecycle CHECK that
  rejected a valid `reconcile_missing` checkpoint. The redundant condition
  was removed and the SQL suite now inserts that valid state explicitly.
- The second run exposed a shared-fixture assumption in the reconciliation
  test: the corrected scanner also found missing originals created by earlier
  scenarios. The test now consumes every bounded page and asserts the target
  state without assuming an otherwise empty integration tenant.

## Negative coverage

- Live `media_references` reject deletion.
- Reclaim before the stored deadline rejects before a storage call.
- Local storage proves scoped, paginated inventory, recoverable delete,
  restore, and addressable reclaim.
- PostgreSQL integration coverage exercises restore/reclaim retries after a
  simulated post-storage crash, a foreign-prefix orphan, a missing stored
  original, merged pagination, invalid restore ordering, live-storage reclaim
  denial, and rollback after an injected Ledger/outbox append failure.
- The SQL isolation suite includes the new table in its FORCE RLS visibility
  checks and rejects foreign-site writes and composite foreign keys.

## Verification evidence

- Baseline `pnpm check` on merge commit `5f6e8b84f0fe996fb6c7888f43b62d4c70292ff6`:
  79 passed, 20 PostgreSQL tests skipped locally, 5 visual tests passed.
- Current full local `pnpm check`: 80 passed, 24 PostgreSQL tests skipped
  locally, 5 visual tests passed.
- Retained GitHub Actions evidence: [run 32750922886](https://github.com/Tsumibito/NavoCMS/actions/runs/32750922886)
  passed with all 8 migrations applied, 27 test files and 104 tests passed
  with no skips, 5 visual tests passed, Media isolation checks passed, and the
  production container built.

## Deliberately not included

- R2/Cloudflare provider bindings or credentials.
- MCP lifecycle mutation tools.
- Variants/transcoding, GC workers, Astro publication, or background loops.
