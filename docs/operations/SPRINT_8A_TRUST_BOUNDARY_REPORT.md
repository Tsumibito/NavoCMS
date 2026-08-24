# Sprint 8A trust-boundary report

## Status

**Trust-boundary code is implemented; the gate is not closed yet.** Local checks do not execute
the PostgreSQL suite because no integration database URL is available. The gate may be marked
closed only after the GitHub Actions PostgreSQL job applies migration `0007` and runs its media
isolation suite without skipped persistence tests.

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

## Required before declaring the gate closed

1. Push this branch and retain the green GitHub Actions run URL.
2. Confirm the CI PostgreSQL job applies `0007` through the migration registry and executes
   `media-isolation.sql` with no skipped persistence tests.
3. Review the retained CI output; only then change this report's status to closed.
