# Sprint 8B.3C — Trusted Astro builder and reviewed artifact registration

**Status:** Senior review accepted / Pending CI

## Delivered boundary

- `TrustedAstroBuilder` accepts only release ID/hash, preview-artifact hash,
  and an 8–128-byte idempotency key. It exact-validates the runtime shape
  before consulting any store or runner; it has no MCP tool or source/output
  payload contract.
- Complete reviewed content, design, media, delivery, and governance render
  inputs are supplied by a private `ReviewedAstroBuildInputStore`. The builder
  supplies an immutable release manifest and reviewed binding digest. The
  builder recomputes release hash, anchors, and canonical complete render input
  digest before rendering with `@navocms/design-astro`.
- `GitPinnedAstroBuildRunner` accepts no commit selector. It derives a canonical
  full SHA only from its configured clean detached reviewed checkout. It makes
  one bounded checkout-local `corepack pnpm@10.24.0 install --offline
  --frozen-lockfile` preparation, then uses only
  `apps/design-catalogue/node_modules` in that checkout. The executed
  Astro/check/TypeScript dependency closure is content-fingerprinted and
  re-attested before both builds and immediately before registration. Two
  independent artifact directories use an explicit local cache that is removed
  with each directory. The toolchain is checked against artifact and
  reviewed-lock pins (Astro 7.2.4,
  `@astrojs/check` 0.9.10, TypeScript 5.9.3), and runs bounded Astro `check`
  then `build` twice. Stable wrong SHA, source-SHA drift, or byte-output drift
  fails before registration.
- Output traversal rejects symlinks, invalid paths, depth/file/aggregate-byte
  overflow, and TOCTOU/background-writer growth with descriptor-based bounded
  reads. All Git/Astro processes are kill-bounded; build-directory cleanup failure is
  visible and does not mask a primary error.
- Existing `verifyAstroArtifact` and `verifyBuiltAstroOutput` run before the
  durable registration. The existing PostgreSQL store remains the sole owner
  of append-only registration, idempotency, Event Ledger, and outbox writes.
  Its authority check is additionally explicit about human-only registration.
- No migration, public contract, public MCP tool, secret activation,
  Cloudflare/Coolify call, production-profile change, deployment, commit,
  push, or CI run occurred.

## Local evidence

- `pnpm typecheck` passed after the bounded process-group timeout correction.
  `pnpm check` was deliberately not repeated.
- The narrow runner suite passed in a fresh, addressable temporary directory
  under `Navi/tmp`: `pnpm exec vitest run
  apps/mcp/src/trusted-astro-builder.test.ts` — 8/8. It includes the required
  single offline frozen-lockfile preparation in a clean detached checkout,
  two real Astro materializations, malicious replacement of the actually
  executed checkout-local CLI/dependency closure, byte-drift rejection,
  timeout group termination with no registrar call, and test-worktree cleanup.
  The malicious-replacement test first removes the package file to break its
  pnpm hardlink before writing the replacement. A post-test `pnpm store status`
  was clean, confirming that it did not mutate the shared offline store.
- The Docker client did not return a server version within the bounded local
  probe, so no provisioning PostgreSQL suite was run. This remains Pending CI;
  it is not represented as a successful local database validation.
- Existing reviewed-artifact PostgreSQL integration/SQL coverage remains the
  durable registration proof for replay/key drift, concurrency, injected
  event/outbox rollback, restart resolution, malformed/bounded input, RLS, and
  immutable records. The new builder deliberately reuses that path rather than
  creating another transaction or idempotency mechanism.

## Remaining review and CI gates

The local Docker daemon remains unavailable for the PostgreSQL suite in this
workspace. Before acceptance, run the standard CI PostgreSQL provisioned suite
without skips, including the reviewed-artifact integration and RLS isolation
SQL, once after senior review. Do not manually rerun CI. The operational gate
remains open: a durable `ReviewedAstroBuildInputStore` and private runtime
composition have not been delivered. A separately approved staging proof must
retain exact release/artifact/source/output evidence and must not activate
credentials until the staging profile is explicitly selected.
