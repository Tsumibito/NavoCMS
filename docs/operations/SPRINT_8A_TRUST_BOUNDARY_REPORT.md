# Sprint 8A trust-boundary report

## Status

**Trust-boundary gate is closed.** GitHub Actions run
[`32727867816`](https://github.com/Tsumibito/NavoCMS/actions/runs/32727867816) applied all seven
registered migrations, ran the complete PostgreSQL persistence suite without skipped tests, and
completed `media-isolation.sql` successfully.

No external media, R2, S3, Astro, or Cloudflare provider is active in the production profile.

## Implemented boundary

- Originals are currently limited to JPEG and PNG, the formats with complete bounded header
  inspection in this package. GIF, WebP, and AVIF are rejected before storage or decoder work.
- Original and variant keys are content-addressed and bind the exact tenant/site scope.
- `media_originals` are immutable after insertion; variants reference the matching
  `(tenant_id, site_id, asset_id, original_sha256)` tuple.
- Migration `0007_media_pipeline.sql` enables and forces RLS on every new media table.

## Negative evidence

The focused TypeScript suite rejects:

- checksum mismatch, MIME mismatch, oversized input, SVG, unsupported GIF/WebP;
- unreadable dimensions and pixel-limit violations before any decoder can run;
- partially specified original dimensions at the public contract boundary;
- non-JSON transform values (`NaN`, `undefined`);
- immutable-key rewrites with changed bytes or changed media type;
- malformed addresses, loopback/private/link-local/ULA IPv4 and IPv6, IPv4-mapped private IPv6,
  TEST-NET ranges, unspecified addresses, and multicast addresses.

The PostgreSQL SQL suite, run in CI, proves:

- RLS read isolation for `media_assets`, `media_originals`, `media_variants`,
  `media_references`, `media_upload_intents`, and `media_gc_candidates`;
- foreign-site write denial;
- immutable-original trigger enforcement;
- cross-site foreign-key rejection and same-site asset A/original B mismatch rejection;
- rejection of `deleted_at`-only, `purge_after`-only, `width`-only, and `height`-only rows.

## Local verification

Run on 2026-08-24:

```text
pnpm check
Validated 7 schemas and 10 contract fixtures.
75 tests passed; 5 PostgreSQL integration tests skipped without a database URL.
4 visual tests passed.
```

## Closure evidence

- Migration runner reported `Applied 7 migration(s)`, covering the ordered registry through
  `0007_media_pipeline.sql`.
- Vitest reported 24 test files and 80 tests passed, with no skipped tests.
- The standalone SQL gate reported `Media isolation checks passed`.
- The complete GitHub job, including four visual checks and the production container build,
  completed successfully in 1 minute 34 seconds.
