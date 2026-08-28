# ADR 0023 — Shared S3/R2 object core

**Status:** Proposed

**Date:** 2026-08-28

## Context

Media and future immutable artifacts share one provider bucket but must not
share physical object namespaces. Reimplementing S3 request signing, bounded
reads, conditional writes, and list pagination in each domain adapter would
make namespace and integrity regressions likely.

## Decision

`@navocms/s3-core` owns the provider-neutral S3/R2 protocol boundary:

- immutable conditional PUT, verified HEAD, bounded GET, and bounded paginated
  inventory;
- copy and delete primitives for domain lifecycle adapters;
- fetch transport SigV4 signing, with endpoint, bucket, and credentials read
  through injected callbacks; and
- bidirectional mapping between logical keys/cursors and a reviewed physical
  namespace.

The reviewed root is `navocms/v1/`. Storage instances select a reviewed child,
currently `navocms/v1/media/` or `navocms/v1/artifacts/`; logical domain keys
are never stored or exposed with that prefix. The media adapter remains the
owner of tenant/site key validation, upload-intent authority, and recovery
lifecycle policy.

## Consequences

Provider requests, copy sources, list prefixes/cursors, and direct-upload URLs
are namespaced in one place. A provider list response outside the requested
physical prefix fails closed, which also excludes root markers such as
`_namespace.json` from tenant/site inventory. Artifact storage can reuse the
same core with its separate reviewed namespace and no media import.
