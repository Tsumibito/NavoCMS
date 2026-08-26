# Sprint 8B.2 — Cloudflare preview/deploy provider report

**Implementation status:** Review changes required / Pending CI

## Scope

This package adds `@navocms/delivery-cloudflare`, a provider capability behind
the existing release workflow. It does not add a production binding, token,
credential, environment variable, Cloudflare deployment, Coolify deployment,
or release/idempotency implementation.

## Implemented boundary

- `io.navocms.cloudflare-artifact-reference.v1` binds a release artifact,
  verified Astro artifact, full built output, route set, source commit, and a
  complete bounded per-file byte-hash manifest.
- Cloudflare Pages Direct Upload keeps preview and production operations
  separate: preview rejects the production branch and requires
  `environment=preview`; production requires the configured production branch
  and `environment=production`. Both use environment-specific immutable markers.
- Pages live verification requires HTTPS, an allowed Pages hostname suffix,
  HTTP 200, immutable headers, the explicit cache contract, and a bounded
  byte-hash comparison for every expected live output file. It derives the
  authoritative production target from the Pages project `production_branch`,
  `canonical_deployment`, and allowed aliases.
- Coolify receives an exact `git_commit_sha` update before deployment is
  queued. It never receives a branch name as a release target.
- Reconciliation and rollback use the existing durable workflow checkpoints.
  PostgreSQL serializes every release/reference/phase reservation before an
  external effect. A completed phase reuses its recorded external ID; a
  reserved Cloudflare rollback resolves only after canonical deployment and
  immutable live-byte proof. A reserved Coolify effect requires a human-only,
  evidence-hash-bound UUID candidate, which is inspected before completion.
  Neither path replays an uncertain external effect. Automatic HTTP retries
  are read-only only; a mutation failure leaves a durable reservation.
- A crash after reservation but before an external request is recoverable only
  through authenticated human, evidence-bound `not_applied` proof. It creates
  one numbered second attempt and emits an Event Ledger record; arbitrary input
  can neither name the human actor nor grant this authority. Each attempt
  accepts exactly one of applied-candidate and not-applied, and the authority
  cannot be constructed without the Ledger.
- Retry telemetry records stable operation/status metadata only and can append
  to the existing Event Ledger. Tests cover a transient 502; no credential or
  upstream response text enters errors.
- Cloudflare, Coolify, and a complete sequential live-file probe use abortable
  bounded deadlines. Coolify rollback returns and verifies the new deployment
  UUID instead of discarding its external-effect identity.

## Local evidence before CI

- focused provider/release-workflow tests: **22 passed** locally after the
  final review-fix package;
- PostgreSQL integration adds concurrent phase reservation and a persisted
  `reserved → restart → human resolution → completed` recovery trajectory; it
  requires the GitHub-provisioned PostgreSQL target;
- full local test suite: **159 passed**, **32 PostgreSQL tests skipped locally**
  because no local PostgreSQL integration target was configured, and **5 visual
  tests passed**;
- contract validation: **9 schemas** and **12 fixtures**, including the valid
  Cloudflare reference plus malformed short-commit and extra-field fixtures;
- architecture boundaries, secret policy, TypeScript build, Markdown, local
  links, and `git diff --check`: passed.
- no PostgreSQL migration was added or changed.

## CI evidence

- The first PR run exposed a real PostgreSQL restart-recovery gap: a persisted
  `rollback.pending` checkpoint was still inside the request transaction and
  was rolled back when the provider faulted. The run is
  retained as [failed CI evidence](https://github.com/Tsumibito/NavoCMS/actions/runs/32903327905).
- The correction commits the existing prepare/checkpoint and idempotency state
  before any provider call, and retains the workflow run's `rollback.pending`
  state as the recovery index.
- The current pre-fix PR head passed the full PostgreSQL, isolation, visual,
  and production-container gate: [Quality checks run
  32949186343](https://github.com/Tsumibito/NavoCMS/actions/runs/32949186343).
  This evidence predates the current final review-fix package and is not
  evidence of its acceptance.

## Remaining activation work

1. Bind a reviewed resolver that maps one approved release to one verified
   Astro artifact/output and attests the source-commit relationship.
2. Add encrypted runtime token providers and a separately pinned non-embedded
   deployment profile only after operational approval.
3. Run the provider against an isolated staging Pages project and Coolify
   application, retain live hash/rollback/retry evidence, then evaluate the
   public-release Sprint 8C gate.

The implementation status remains **Review changes required / Pending CI**
until the revised diff passes local gates and one final GitHub run. No external
provider was activated.
