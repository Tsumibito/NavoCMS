# Sprint 8A.5 — External media storage boundary

## Status

Accepted. [PR #27](https://github.com/Tsumibito/NavoCMS/pull/27) and post-merge
[run 32765051398](https://github.com/Tsumibito/NavoCMS/actions/runs/32765051398)
are green: 29 test files / 123 tests ran without skips, PostgreSQL tenant and
media isolation passed, and the production container built. No external
storage provider was activated in the production profile.

## First package

- Scope-bound S3/R2-compatible adapter with conditional immutable writes and
  exact-object replay verification after a conditional conflict.
- Bounded streaming GET with provider abort, lexical-key pagination via
  `start-after`, normalized errors, and recoverable copy/delete/restore/reclaim
  preserving SHA-256, MIME, and the grace deadline.
- `PostgresMediaUploadIntentSigner` projects only a pending, unexpired,
  RLS-scoped PostgreSQL intent whose asset is also pending; the low-level
  signer is guarded by a module-private capability.
- Provider contract tests cover overwrite and exact replay/drift, foreign key,
  oversized HEAD/body, thrown transport/body, lifecycle partial failure and
  retry, restore replay, two-page pagination, official AWS SDK v3 SigV4
  vector/header binding, expiry, oversized intent, and provider partial
  failures. PostgreSQL integration coverage includes pending, rejected,
  finalized, expired, and foreign-site intent checks.

## Enforcement note

Presigned PUT signs `host`, `If-None-Match: *`, MIME, key, checksum metadata,
expected-size metadata, and expiry; expected size is bounded by
`MEDIA_LIMITS.maxBytes`. It uses S3's `UNSIGNED-PAYLOAD` and emits it as
`X-Amz-Content-Sha256`; metadata is in the signed query to match AWS SDK v3
presigning. It deliberately does not return or sign browser-forbidden
`Content-Length`. Compatibility providers may not enforce a maximum body size
server-side; no such enforcement is claimed. Finalize's bounded
body/checksum/MIME/size/dimensions validation is the only authoritative
acceptance point.

## Closure evidence

- retained GitHub PostgreSQL CI with no skipped provider/integration tests;
- production-container build;
- no activation of an external provider in production profile.
