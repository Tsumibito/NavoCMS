# Sprint 8R.1 Phase A / Boundary — artifact object-storage report

**Implementation status:** Phase A / Boundary — Review required / Pending CI

## Delivered for review

- Ordered migration `0012_reviewed_astro_artifact_object_bindings.sql` is
  expand-only and leaves migrations `0010`/`0011` and their JSON columns
  untouched. The new table is append-only, FORCE RLS, SELECT/INSERT-only, and
  binds the exact tenant/site/environment/release hashes to object metadata.
- `PostgresReviewedAstroArtifactStore` verifies both bundles before storage,
  writes content-addressed immutable objects, then records only metadata using
  the existing transaction, idempotency, Event Ledger, and outbox. Its
  idempotency value contains binding metadata, not bundle JSON.
- Reads prefer object bindings, perform bounded exact-byte/checksum/scope
  verification, and retain a backward-compatible legacy-row fallback.
- A deterministic local object store supports focused tests. The duplicated
  S3/R2 transport draft was deliberately removed; no credentials, provider
  activation, network call, deploy, commit, or push occurred.

## Known follow-up gates

The real S3-compatible/R2 adapter must reuse or extract the existing provider
core in a separately reviewed package. Actual production cutover is not
complete in Phase A. Before any legacy backfill/cutover, run the full
PostgreSQL/RLS/failure suite and CI, reconcile object-orphan evidence, and
obtain retention approval. This report is not operational activation evidence.
