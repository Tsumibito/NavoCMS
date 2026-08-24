# Sprint 8B.1 media-persistence report

## Status

**The media-persistence code gate is closed.** GitHub Actions run
[`32740386506`](https://github.com/Tsumibito/NavoCMS/actions/runs/32740386506) applied all seven
registered migrations, ran the complete PostgreSQL persistence suite without skipped tests,
completed the media RLS/isolation suite, and built the production container.

This working-package name does not close the roadmap's Sprint 8B Astro and Cloudflare delivery
providers. It completes the atomic persistence portion of the Sprint 8 media pipeline. MCP media
tools, provider activation, variants, orphan reconciliation/GC, Astro delivery, and a real staging
publication remain separate gates.

## Implemented boundary

- `@navocms/media` owns provider-neutral domain and storage interfaces plus the first-party
  PostgreSQL repository under the dependency allow-list accepted in ADR 0013.
- Finalization performs bounded storage `HEAD` and read checks before content inspection, then
  revalidates the storage key, MIME, size, and checksum.
- Asset mutation, intent finalization, idempotency completion, Event Ledger append, and
  transactional outbox append share the existing PostgreSQL transaction.
- Site-local SHA deduplication is serialized and validates canonical size and MIME metadata before
  returning an existing asset.
- Client idempotency keys are bounded to 16–128 characters before SQL or storage effects; event
  identities are operation-aware and bounded independently.
- Storage writes remain outside the SQL transaction. A database rollback can leave a safe,
  content-addressed orphan for the later reconciliation/GC package.

## PostgreSQL evidence

The 14 media repository scenarios prove:

- intent creation, finalization, replay, drift rejection, expiry, RLS denial, and read projections;
- size, checksum, MIME, storage-key, decoder-limit, and lying-provider rejection;
- exact-key concurrent replay, different-key finalization, finalize/reject races, and concurrent
  deduplication without raw uniqueness failures;
- rollback of asset state, intent, idempotency, Event Ledger, and outbox after injected append
  failure;
- operation-separated event identities and fail-closed dedup metadata mismatch;
- bounded TTL, provenance, rights, list limits, and idempotency inputs.

The same CI run also reported:

```text
Applied 7 migration(s).
25 test files passed; 94 tests passed; 0 skipped.
Media isolation checks passed.
4 visual tests passed.
Production container build passed.
```

## Local verification

Run on 2026-08-24 without a local PostgreSQL URL:

```text
pnpm check
75 tests passed; 19 PostgreSQL scenarios skipped.
4 visual tests passed.
```

The skipped local scenarios are covered by the retained GitHub PostgreSQL run above.
