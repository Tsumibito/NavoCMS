# Sprint 7.1 code-gate completion task

**Owner level:** mid-level backend/platform engineer  
**Expected size:** one focused implementation package, approximately 3–5 engineering days  
**Goal:** close the remaining Sprint 7.1 code gate without activating an external publication
provider. The operational staging gate remains a separate follow-up requiring Neon, Coolify, and
Claude access.

## Baseline

The acceptance-hardening work already provides human-only exact-hash approval, G2 publication,
single-transaction mutation/idempotency/Event Ledger/outbox persistence, document-root correlation,
atomic migration registration, bounded Markdown diffing, metadata synchronization, and migration
0004/0005 RLS checks.

The current local baseline is `pnpm check`: 68 tests pass, four PostgreSQL integration tests are
skipped without a database URL, and four visual tests pass.

Do not replace or weaken the existing transaction boundary, OAuth authorization, forced RLS,
exact-hash approval, immutable release records, or the embedded-only provider restriction.

## Work checklist

- [ ] **1. Boot a pinned production site profile and plugin graph**
  Spec ref: `docs/roadmap/SPRINTS.md > Sprint 7.1`
  What to build: Add a checked-in, digest-pinned profile for the current embedded staging runtime,
  validated through `@navocms/contracts`, and boot it through `PluginHost` before the MCP server
  becomes ready. Register only implemented manifests/runtimes; do not add placeholder Astro,
  Cloudflare, or media providers. Production startup must fail closed on an invalid profile,
  missing runtime, version/digest drift, unhealthy plugin, or unresolved binding. Shutdown must
  dispose the host.
  Acceptance: The running MCP process exposes the validated profile identity and activation order;
  readiness is false until the host is healthy; invalid or unpinned configuration prevents startup.
  Verify: Unit tests for valid boot, invalid digest/version, missing runtime, unhealthy runtime, and
  cleanup, followed by `pnpm typecheck` and the MCP test suite.

- [ ] **2. Add durable quota and kill-switch enforcement**
  Spec ref: `docs/roadmap/SPRINTS.md > Sprint 2` and `Sprint 7.1`
  What to build: Implement PostgreSQL-backed runtime policy checks over `quota_limits`,
  `usage_events`, and `kill_switches`. Add an ordered migration if schema changes are required.
  Enforce active global/tenant/site/plugin switches and atomically meter configured hourly, daily,
  monthly, and lifetime limits. Meter a retry-safe operation identity so an idempotent replay is not
  charged twice. Apply the guard to the production MCP tool pipeline before state mutation or plugin
  invocation; fail closed on policy-store errors.
  Acceptance: Limits and switches survive process restart, remain site-isolated under RLS, reject
  over-limit/disabled operations before effects, and do not double-charge idempotent retries.
  Verify: PostgreSQL concurrency, restart, period-boundary, retry, policy-store failure, and
  cross-site RLS tests.

- [ ] **3. Make readiness prove the deployed contract**
  Spec ref: `docs/roadmap/SPRINTS.md > Sprint 6` and `Sprint 7.1`
  What to build: Replace table-existence readiness with one structured readiness check that verifies
  every expected migration name/checksum, the runtime login is `NOBYPASSRLS`, all application tables
  that require isolation have both RLS enabled and forced, the configured tenant/site/environment
  tuple exists under the runtime scope, and `PluginHost` is healthy. Keep `/healthz` as liveness only.
  Return no secrets or database URLs in failures.
  Acceptance: `/readyz` fails for a stale/modified migration, BYPASSRLS role, missing forced RLS,
  wrong deployment scope, missing environment, or unhealthy plugin; it succeeds only for the exact
  current deployment contract.
  Verify: PostgreSQL integration tests for every negative case and one complete positive case.

- [ ] **4. Expose only permission-appropriate MCP tools**
  Spec ref: `docs/roadmap/SPRINTS.md > Sprint 4` and `Sprint 7.1`
  What to build: Derive effective permissions from the resolved authorization layers before tool
  registration. A viewer discovers read-only tools only; an editor additionally discovers draft and
  patch tools; a human publisher discovers approval/publication tools; non-human principals never
  discover human approval. Keep service-layer authorization as defense in depth.
  Acceptance: Unauthorized tools are absent from MCP discovery, not merely rejected after
  invocation, while authorized tools remain discoverable with their existing annotations.
  Verify: Executable MCP list/call evaluations for viewer, editor, human publisher, agent publisher,
  expired authorization, and cross-site context. Delete or replace hard-coded routing assertions
  that do not execute the server.

- [ ] **5. Run the complete persistence suite in CI**
  Spec ref: `docs/roadmap/SPRINTS.md > Sprint 7.1`
  What to build: Provision the CI PostgreSQL database with the ordered migration runner and a real
  `navocms_runtime` login, bootstrap the fixed integration tenant/site/environment/principal, then
  run the four TypeScript PostgreSQL integration tests with
  `NAVOCMS_INTEGRATION_DATABASE_URL`. Preserve the separate SQL RLS adversarial tests. Any local
  non-TLS allowance must be explicitly test-only, restricted to loopback, and impossible in
  production mode.
  Acceptance: CI reports zero skipped PostgreSQL tests and executes the failure-injection scenario
  after real Ledger/outbox writes. Migration checksum drift or a persistence failure makes the job
  fail.
  Verify: A clean CI run shows all unit/integration/visual tests passing and no skipped persistence
  suite.

- [ ] **6. Add an end-to-end production-path code evaluation**
  Spec ref: `docs/roadmap/SPRINTS.md > Sprint 7.1 exit gate`
  What to build: In CI, boot the MCP application with the pinned profile, runtime role, durable
  policies, enhanced readiness, and embedded release provider. Execute an authenticated local
  `draft -> preview -> human approve -> publish -> reconcile/status` trajectory plus an unauthorized
  trajectory. This is code evidence only and does not replace the retained staging/Claude proof.
  Acceptance: One correlation ID covers the authorized trajectory, publication remains G2, exact
  hashes match, policy usage is persisted once, and unauthorized discovery/invocation exposes no
  publish effect.
  Verify: The test queries the persisted release, approval, checkpoint, idempotency, Ledger, outbox,
  and usage records after completion.

- [ ] **7. Close the code report without closing operations**
  Spec ref: `docs/operations/SPRINT_7_1_REPORT.md`
  What to build: Update the report with exact commands and test counts from CI, the pinned profile
  name/version/digest, migrations applied, and the remaining staging evidence. Mark the code gate
  closed only after items 1–6 pass. Keep the operational gate open until the same artifact completes
  the Neon/Coolify/Claude restart trajectory.
  Acceptance: The report distinguishes merged state, code gate, and operational gate and contains
  no claim based solely on a skipped test.
  Verify: `pnpm check`, Markdown lint, local-link check, and reviewer comparison against the Sprint
  7.1 roadmap exit gate.

## Required delivery

- One reviewable branch/PR based on the current Sprint 7.1 work; do not mix Sprint 8 media or
  Cloudflare provider code into it.
- Ordered, registered, idempotent migration for any schema change.
- Tests must use the real production wiring; no in-memory quota/kill-switch implementation counts as
  acceptance evidence.
- No plaintext secrets, no relaxed production TLS/RLS checks, and no manual SQL outside committed
  migrations/tests.
- Final handoff must include CI links or retained output and a short list of operational-only steps
  still blocked by staging access.

## Stop conditions

Escalate instead of guessing if the current embedded runtime cannot be represented by an honest
profile/plugin graph, if a test-only database configuration would weaken production validation, or
if the authorization model cannot distinguish a human publisher during MCP discovery.
