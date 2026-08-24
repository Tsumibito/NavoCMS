# Sprint 7.1 hardening report

**Date:** 2026-08-24

**Implementation state:** completion package implemented and the complete local PostgreSQL 17 gate
passes; the official code gate awaits a successful GitHub CI run; operational gate open. The work
is ready for review and is not merged.

## Verified local code checks

The local code gate passed against an isolated PostgreSQL 17 instance provisioned through the same
migration/runtime-role/bootstrap path as CI:

- contract, boundary, secret, Markdown, and local-link checks;
- TypeScript build and package smoke checks;
- all six ordered migrations applied with checksum registration;
- 73 unit, agent-evaluation, and PostgreSQL integration tests passed with no skipped persistence
  test;
- four visual/accessibility checks passed.
- the tenant, content, runtime, and release-workflow SQL RLS adversarial suites passed.

The GitHub workflow now applies all migrations through the ordered runner, provisions the
`NOBYPASSRLS` runtime login and integration deployment scope, runs the complete TypeScript
persistence suite without skips, runs all four SQL RLS suites, and builds the production container.
The code gate must remain open until that workflow succeeds for the pushed commit.

The completion scope and its acceptance criteria are recorded in
[`SPRINT_7_1_CODE_GATE_TASK.md`](SPRINT_7_1_CODE_GATE_TASK.md).

## Implemented hardening

- Migration 0005 introduces approval policy/evidence/scope/expiry/revocation fields and a
  site-scoped transactional outbox. Event idempotency is now unique by site, operation, and key.
- Release approval is human-only. Publication re-checks a live, non-revoked approval bound to the
  exact release hash and environment. Publication events are classified as G2.
- Migration execution commits a migration body and its checksum registry record in one
  transaction.
- The persistence suite contains failure injection that writes the ledger/outbox and then fails;
  its PostgreSQL 17 run proves the shared rollback boundary.
- Markdown comparison is linear-space/linear-time for adversarial documents. Structural patches
  keep mirrored `metadata.body` synchronized with the resulting Markdown.
- The production runtime boots and shuts down a digest-pinned, validated embedded-provider profile
  through `PluginHost`; readiness requires the host to be healthy.
- Migration 0006 adds durable, retry-safe PostgreSQL quotas and kill switches with runtime
  least-privilege grants and site-scoped RLS.
- Readiness verifies exact migration checksums, a non-superuser `NOBYPASSRLS` runtime role, forced
  RLS across the complete application schema, and the deployment-bound site/environment.
- MCP discovery exposes only tools allowed by effective permissions and hides human approval from
  agent and service principals. Executable MCP evaluations cover viewer, editor, publisher, agent,
  expired, and cross-site contexts.

## Operational gate — still open

No Neon/Coolify staging credentials, deployed image digest, or authenticated Claude session were
available in this checkout. Therefore the following evidence has not been produced and must be run
against the same deployed artifact before the gate is closed:

1. run migrations with the dedicated migration owner, then use the runtime role only to capture
   readiness showing current checksums, forced RLS, and `NOBYPASSRLS`;
2. run the authenticated Claude trajectory: draft, preview, human approval, embedded publish,
   reconciliation/status;
3. restart the staging container and prove persisted content, events, approval, checkpoints,
   idempotency, and cross-site RLS behavior;
4. retain the command output, image digest, release hashes, and timestamped evidence in the
   deployment record.

Until that evidence exists, P1–P4 and the Sprint 6 staging gate remain operationally open, and the
embedded provider remains the only permitted publication provider.
