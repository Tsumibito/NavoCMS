# ADR 0026 — Real pre-review build, independent human confirmation, and no-rebuild publication

**Status:** Accepted

**Date:** 2026-09-05

**Owners:** NavoCMS maintainers

## Context

Sprint 8.1 delivers reliable editing, but the release boundary still shows the human a Markdown
proof artifact and builds the real Astro output only during publication (`applyAndVerify` calls
`ensureArtifact` before the provider is invoked). The human therefore approves a release hash
without ever seeing the rendered result, and the MCP approval path trusts the OAuth bearer's
`principal.kind === "human"` claim — an agent acting with a human subject passes it.

Sprint 8.2 changes the product promise: the human sees the exact build that will be published,
confirms it in an independent browser session, and publication promotes the already-built
immutable output. Existing pieces constrain the design: the trusted Astro builder already runs
two attested clean builds and registers them idempotently into append-only object storage; the
Cloudflare provider already discovers deployments by release-hash marker and re-verifies every
published byte; workflow runs and checkpoints already survive restarts.

## Decision

### 1. Build moves before review

`preview_prepare` persists the render inputs (unchanged) and additionally starts a durable
**build job** through the staging operational runtime. The build executes outside the MCP
request context under the configured service principal — a trusted-runtime identity, not the
calling agent's bearer — and registers its result through the existing append-only artifact
store. Job state lives in `workflow_runs`/`workflow_checkpoints` (`build.requested` →
`build.completed`/`build.failed`); a new `preview_build_status` tool reads it, and a restarted
server resumes a `running` build job it finds without a live executor instead of creating a
second job. Registration idempotency (`astro-build:<releaseHash>`) makes re-execution safe; both
deterministic builds complete before any review or approval.

Registration authority for runtime-initiated builds is the service principal. There is no MCP
tool that registers reviewed artifacts; the path is reachable only in-process, so widening
`assertAuthority` to `service` does not create an external authority route.

### 2. The preview shows the built output

`GET /previews/:token` keeps serving the Markdown proof artifact while the build runs; once the
release has a registered reviewed artifact it serves the built `index` page instead. The
response also issues a short-lived `HttpOnly` preview cookie that a same-origin asset relay
(`/_astro/*`, plus any other absolute output path) uses to stream the remaining built files for
that token. Preview responses stay `noindex`, `no-store`, script-blocked, and scope-bound to
the token's release; they are capability-gated and never listed. A known limitation, documented
rather than hidden: two previews opened in the same browser profile share the last-issued
cookie, so only the most recently opened preview's assets resolve — a staging-privacy trade-off
that never affects publication (files are served from the immutable record, hash-verified).

### 3. The human decision is an independent browser receipt

Preparing a release also mints a second, separate **confirmation capability** (256-bit, stored
hashed) whose URL the agent hands to the human alongside the preview URL. The confirmation page
is rendered by NavoCMS (not part of the built output): it shows the release hash, the output
manifest digest, file count/bytes, policy version, and expiry, and contains one form.

Submitting that form is the decision. The server computes the output manifest digest itself
from the registered artifact — the form never carries trust-bearing values — and records an
append-once receipt (`release_confirmations`, new ordered migration) bound to tenant, site,
release, release hash, output manifest digest, policy version, decision time, and expiry. The
receipt is a domain event with hash-only data. A POST before the build completed, after expiry,
with a foreign or replayed token, or without the CSRF pairing (double-submit cookie,
`SameSite=Strict`; a known foreign `Origin` is rejected, and `Origin: null`
requests still cannot carry the Strict cookie cross-site) is rejected; re-delivering an already-recorded decision is idempotent
and returns the same receipt view. The OAuth bearer of the agent can mint neither the receipt
nor the decision; it can only read the outcome through `release_confirm_status`.

`release_approve` becomes a durable workflow checkpoint that copies the decision: it requires a
current, unrevoked, unexpired confirmation receipt whose release hash **and** output manifest
digest match the candidate, and it records `outputManifestDigest` + receipt reference in its
evidence. This retires the old behavior where an MCP `human` bearer alone could approve; that
authority change is versioned in the MCP editing spec compatibility note, and
`AGENTS.md` is amended so the MCP-only wording no longer forbids the independent human
confirmation session.

### 4. Publication promotes, never rebuilds

`release_publish` no longer calls `ensureArtifact`. It fails closed with
`REVIEWED_ASTRO_ARTIFACT_NOT_BUILT` when no reviewed artifact is registered, and re-verifies
that the registered output's manifest digest equals the digest bound to the confirmation
receipt and the approval before the provider is invoked. Zero build-runner invocations during
publish (including retries and reconcile) are proven by spy/transport evidence in tests; the
provider continues to discover-or-create the deployment by release-hash marker so a repeated
publish remains a single external effect. Releases registered before this ADR carry no output
manifest digest and fail publication closed; preparing a new release is the upgrade path.

## Consequences

- The human sees layout, CSS, and bound media before any approval; the artifact chain
  (release hash → output manifest digest → per-file SHA-256) is verifiable end to end.
- The approval guarantee no longer depends on token claims: the receipt proves a separate
  browser acted within the window with CSRF protection.
- Long builds return a job/status and survive disconnect and restart without duplicate
  external effects.
- The confirmation capability is a second bearer-worthy capability URL; it must never be logged
  (same policy as the preview token).
- Old MCP clients that approve without a confirmation now receive
  `HUMAN_CONFIRMATION_REQUIRED`; the v0alpha1 compatibility note documents the tightened
  semantics.
- One staging-only constraint exists (shared preview cookie across concurrently open previews)
  and is explicit in the spec.
