# ADR 0033 — Operator recovery bundles

**Status:** Accepted

**Date:** 2026-10-20

## Context

A content export alone cannot recover an operating CMS. Recovery must retain
contracts, revisions, presentation, references, releases and audit history,
as well as original/derived media and reviewed build objects.

## Decision

Support one bounded pilot profile: one dedicated site database, PostgreSQL 18,
Docker, WorkOS and reviewed Cloudflare Pages/R2 staging delivery. Coolify is an
optional Docker/HTTPS operator. Sites remains an optional consumer. This is not
an offline, standalone production hosting claim.

An operator exports the navocms schema using pg_dump with the same exported
repeatable-read snapshot used for its table inventory. Objects are immutable,
scoped by tenant/site and verified by SHA-256. Only committed live media,
completed transform checkpoints and referenced build objects enter the bundle.
Pending uploads and physically deleted trash are outside recovery retention.
Concurrent GC may make a backup fail safely; retain objects until backup succeeds.

A versioned gzip payload is encrypted using AES-256-GCM, a random nonce and
an independent operator-owned key. No plaintext dump is written. The initial
limit is 128 MiB serialized payload and 32 MiB per object; larger installations
need a reviewed streaming recovery format. No secrets are exported from the
runtime environment. Database identity records are personal data and remain
inside the encrypted archive. Keys, OAuth configuration and provider credentials
have a separate recovery procedure.

Restore accepts only an empty target, exact migration checksums, PostgreSQL
major and database-owner role name. It creates registered schema/roles, restores
objects without overwriting different bytes, restores the dump transactionally
with its ACLs, then compares every table and object hash. Failed restore never
activates a server. Activation and external-provider reconciliation are explicit
operator steps; restoring data does not publish or reverse a schema migration.

Privileged operations remain an operator CLI, not an MCP capability. They emit
bounded domain events to the protected operations journal, which is independent
of the database being recovered. Runtime credentials cannot read backups or
invoke restore. Timers emit local actionable failures; an external alert channel
and off-host archive retention require operator configuration and verification.

## Compatibility and validation

No schema migration is introduced. Runtime readiness now includes the existing
page_editor_records RLS contract from migration 0019. Existing site APIs and
publication receipt policy are unchanged. A fresh-database rehearsal restores
real content, composition, comments, release state and responsive photo bytes.
Encryption corruption, wrong keys, foreign objects, repeat bootstrap, mismatched
versions and non-empty restore targets fail closed. Model/client acceptance and
seven days of owner use remain independently recorded gates.

Reference behavior: [PostgreSQL restore](https://www.postgresql.org/docs/18/app-pgrestore.html)
and [R2 conditional writes](https://developers.cloudflare.com/r2/api/s3/extensions/).
