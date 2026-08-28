# ADR 0018 — Trusted Astro builder and reviewed-artifact registration

**Status:** Superseded by ADR 0019

**Date:** 2026-08-26

## Context

The reviewed-artifact resolver can safely consume an immutable source/output
record, but it intentionally has no producer. Accepting an Astro bundle, built
output, or source commit through MCP would bypass the exact reviewed release
binding and create an unbounded payload surface.

## Decision

Introduce an internal `TrustedAstroBuilder` in the MCP application boundary.
Its request has only an exact release ID, release hash, preview-artifact hash,
and bounded idempotency key. A separate internal durable reviewed-input store
supplies the release manifest, complete content/design/media/delivery/
governance render input, and a reviewed binding digest. The builder recomputes
the manifest release hash, anchor correspondence, and canonical render binding
digest before rendering; it does not accept a commit selector from that store.

The builder renders with `@navocms/design-astro`, then runs a pinned Astro
`check` and `build` twice in independent clean artifact directories. The runner
first requires its configured reviewed checkout itself to be a clean detached
checkout, derives a canonical full object ID with `git rev-parse --verify
HEAD^{commit}`, then performs one bounded `corepack pnpm@10.26.0 install
--offline --frozen-lockfile` preparation inside that checkout. The only
toolchain is the checkout-local `apps/design-catalogue/node_modules`: its
executed Astro/check/TypeScript dependency closure is content-fingerprinted,
must remain inside the checkout, and is re-attested before each build and
registration. Each materialization has its own explicit local Vite cache,
removed with its build directory. `sourceCommitSha` is therefore neither a
request nor reviewed-input-store field. Astro, `@astrojs/check`, and TypeScript
versions must exactly match the artifact package policy and the reviewed lock.
Source and output pass the existing strict verifiers and both output trees must
match byte-for-byte before registration. Every Git/Astro process has a bounded
timeout; output walking uses descriptor-based bounded reads with `O_NOFOLLOW`.

The bounded-process primitive creates a process group where supported and
sends `SIGKILL` to that group on timeout, waiting for process close before it
reports the timeout. This prevents a timed-out CLI child from surviving to
write after its rejected build.

Durable registration is delegated unchanged to
`PostgresReviewedAstroArtifactStore`. The caller must be an authenticated human
with `content:publish`; registration retains its existing scoped PostgreSQL
transaction, idempotency record, Event Ledger event, transactional outbox,
append-only database record, and RLS protection. The builder has no public MCP
tool, credential broker, Cloudflare/Coolify transport, deployment effect, or
production-profile wiring.

## Consequences

Input acquisition and runtime composition stay unimplemented integration work:
this component cannot operationally build until a durable
`ReviewedAstroBuildInputStore` is supplied. A restart or crash before
registration has no durable builder effect; a crash in registration is governed
by the existing atomic store and its idempotent retry. Temporary build
directories are removed after each run, with cleanup failure visible without
masking a primary build error. A retry builds again and can only return the same
stored record or fail closed on drift.

## Alternatives considered

- Public MCP registration carrying source/output: rejected as large,
  caller-controlled payloads would cross the trust boundary.
- Trusting a supplied `sourceCommitSha`: rejected because it does not prove the
  builder actually used that source.
- A second builder transaction/idempotency mechanism: rejected because the
  reviewed-artifact store already owns the durable mutation.

## Validation

Focused tests cover request bounds/exact shape, checkout and final
pre-registration re-attestation, stable wrong-SHA rejection, ignored arbitrary
store commit selectors, render-provenance drift, checkout-local malicious CLI
replacement rejection, temporary test-worktree cleanup, a real timed-out child
kill path with no registration, and descriptor-bounded source/output
verification. Existing PostgreSQL store
integration and SQL suites retain replay/key drift, concurrent registration,
event/outbox rollback, restart lookup, bounded envelope, and RLS/append-only
coverage. This remains a component code gate, not an operational gate.
