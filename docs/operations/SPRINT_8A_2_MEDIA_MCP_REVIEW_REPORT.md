# Sprint 8A.2 media MCP review report

## Status

**The media MCP review code gate is closed.** GitHub Actions run
[`32746568380`](https://github.com/Tsumibito/NavoCMS/actions/runs/32746568380) applied all seven
registered migrations, ran every TypeScript and PostgreSQL scenario without skipped tests,
completed the media RLS/isolation suite, passed five visual/accessibility checks, and built the
production container.

The pinned production runtime remains read-only for media. It has no media storage binding and
does not advertise upload or mutation tools. R2/Cloudflare, variants, reconciliation/GC, Astro, and
real publication remain outside this package.

## Implemented surface

- `media:read` exposes bounded asset pages, asset review, reference pages, and the read-only media
  review widget.
- `media:write` exposes prepare, finalize, reject, reference-create, and reference-remove only when
  the composition root injects a storage capability.
- Asset and reference lists use site-scoped, deterministic cursor pagination with bounded page
  sizes.
- Upload schemas accept only declared checksum, size, MIME, timing, provenance, rights, and
  idempotency metadata. They contain no binary, file, bytes, or base64 field.
- `receivedBy` is derived from the authenticated principal and cannot be supplied by an MCP caller.
- Reject and reference removal are accurately marked as destructive, idempotent, closed-world MCP
  operations.
- `McpMediaService` delegates to the existing `MediaRepository`; it introduces no transaction,
  idempotency, Event Ledger, or outbox mechanism.

## Evidence

The MCP and PostgreSQL suites prove:

- viewer/editor discovery differences and direct permission denial;
- absence of write tools when storage is not injected;
- binary-free schemas and destructive-operation annotations;
- server-derived provenance identity;
- cursor pagination without repeated assets or references;
- replay, idempotency drift rejection, and one asset-correlated Ledger/outbox trajectory;
- production-profile absence of a media storage provider;
- bounded, escaped media integrity rendering without mobile overflow or accessibility violations.

The retained CI run reported:

```text
Applied 7 migration(s).
27 test files passed; 99 tests passed; 0 skipped.
Media isolation checks passed.
5 visual/accessibility tests passed.
Production container build passed.
```

## Local verification

Run on 2026-08-24 without a local PostgreSQL URL:

```text
pnpm check
79 tests passed; 20 PostgreSQL scenarios skipped.
5 visual/accessibility tests passed.
```

The skipped local scenarios are covered by the retained GitHub PostgreSQL run above.
