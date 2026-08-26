# Sprint 8B.3B — Durable reviewed Astro artifact resolver

**Implementation status:** Senior review accepted / Pending CI

## Delivered local boundary

- Migration `0010_reviewed_astro_artifacts.sql` adds the append-only reviewed
  record with exact environment and release-artifact composite foreign keys,
  strict 40-or-64-character source-commit SHA validation, bounded JSON-object
  envelopes, FORCE RLS, site policy, SELECT/INSERT-only runtime privileges,
  and immutable update/delete trigger protection.
- `PostgresReviewedAstroArtifactStore` verifies the Astro source and complete
  built output before any SQL. It uses the existing PostgreSQL transaction,
  idempotency record, Event Ledger, and transactional outbox. Exact retries
  return the stored record; key reuse or a second differing record fails
  closed and event-append failure rolls back every durable write.
- Registration records the verified authenticated actor, the release row's
  document correlation ID, and `io.navocms.release.astro-artifact-registered.v1`
  as an internal `G1` event. It contains hashes and identifiers only.
- The strict resolver and store readiness are dynamic. They require the applied
  migration/table, FORCE RLS/site policy, and the configured staging scope;
  a missing particular release remains a dry-run/resolve error.
- The composition root injects the real Cloudflare provider only for
  `cloudflare-staging`; embedded remains the default and production provider.
  `/readyz` reports non-secret provider/resolver state. Persisted dry run is
  resolver → `verifyDeployableArtifact` with no transport or secret callback.
- This package deliberately has no public large-payload MCP registration tool
  and no trusted reviewed-build producer. A subsequent package must build from
  the checked-out reviewed commit, derive `sourceCommitSha` from that checkout,
  and bind it to the record; it must never accept that value from untrusted MCP
  input. Until then, the boundary alone cannot execute an operational dry run.

## Coverage added

- PostgreSQL integration exercises readiness, exact replay/key drift, second
  record drift, concurrency, event/outbox rollback injection, restart lookup,
  persisted dry-run, and malformed/tampered/missing/extra/oversized inputs.
  Registration is scoped to an authenticated human; restart resolution uses a
  distinct service principal while the Ledger retains the human actor.
- `release-workflow-isolation.sql` now verifies reviewed-artifact RLS
  same-tenant cross-site visibility/writes, exact foreign-key bindings,
  JSON/output bounds, precise commit SHA validation, and privilege-plus-trigger
  immutability.
- Resolver unit tests prove fail-closed runtime behavior before readiness and
  release-specific failure when the capability is otherwise ready.
- A composition regression test proves explicit `cloudflare-staging` selects
  the real provider plus reviewed resolver; missing or invalid records fail
  before any secret callback or Cloudflare/Coolify transport call. Readiness
  rejects an additional permissive RLS policy.
- The pinned staging manifest declares bounded data access, `content:publish`,
  and binding-derived exact network destinations. Pages access is restricted
  to the configured project rather than all `pages.dev` projects.

## Remaining external gates

No Cloudflare or Coolify effect, deploy, commit, push, or CI run has occurred.
The required remaining gates are one CI run with its provisioned PostgreSQL
suite and separately authorized isolated-staging operational proof.
Sprint 7.1 remains closed and is not reopened by this work.
