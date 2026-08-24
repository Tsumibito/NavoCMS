# Sprint 8A.4 — Deterministic media variants

## Status

Accepted. The code gate is closed by retained GitHub PostgreSQL CI evidence for
commit `1d830f8`; no PostgreSQL scenarios were skipped.

## Current design

- Pinned `sharp@0.35.3` provides orientation-correct, metadata-free AVIF,
  WebP, and JPEG output with explicit encoder settings.
- Versioned responsive, hero/LCP, OG, and thumbnail presets restrict widths,
  formats, crop behaviour, and focal points.
- Variant identity binds original SHA-256, preset version, and canonical
  transform; output keys remain tenant/site content-addressed.
- `0009_media_variants.sql` adds FORCE RLS checkpoints before object writes and
  records the exact expected output SHA, key, byte size, MIME, dimensions,
  preset, and transform. Completed checkpoints require a completion timestamp.
- Generated variants are immutable, and the public contract/review projection
  includes the exact variant identity, storage key, SHA-256, and byte size.
- The read-only media review projection now includes generated variants. No
  MCP processing mutation tool, external provider, or publication path is
  included.

## Code-review hardening

- Preset arrays are deeply frozen; changing encoder policy requires a new
  preset version.
- Invalid crop/focal combinations reject before source reads, checkpoints, or
  storage effects, including adversarial runtime values outside TypeScript.
- Processing completes before the durable effect checkpoint, while the
  checkpoint is always committed before the immutable storage write.
- Variant storage is read back and checked for exact key, size, MIME, and SHA
  before PostgreSQL completion.
- A site/identity advisory lock prevents concurrent absent-row inserts from
  surfacing raw unique conflicts. Existing rows and checkpoints are compared
  against the exact deterministic output and fail closed on drift.
- Final variant record, checkpoint completion, idempotency result, Event
  Ledger, and outbox remain in one scoped PostgreSQL transaction.
- The first PostgreSQL run exposed that `SELECT ... FOR UPDATE` required an
  intentionally revoked runtime `UPDATE` privilege. The final implementation
  keeps variants immutable, uses the existing advisory lock for serialization,
  and performs a privilege-safe exact read. Integration fixtures also use a
  distinct real PNG per scenario so site-level SHA dedup cannot leak state
  between tests.

## Verification

- Local `pnpm check` passes with 84 tests passed, 28 PostgreSQL scenarios
  skipped without a local database, and 5 visual tests passed.
- PostgreSQL coverage now includes three formats, replay/drift, concurrency,
  cross-site denial, invalid transforms before effects, source mismatch,
  post-storage crash recovery, and injected Ledger/outbox rollback.
- Retained GitHub run
  [32754399753](https://github.com/Tsumibito/NavoCMS/actions/runs/32754399753)
  applied all 9 migrations and passed 28 test files / 112 tests with no skips,
  5 visual tests, the media isolation SQL suite, and the production-container
  build.
