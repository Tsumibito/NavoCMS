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
second job. *(Corrected after independent acceptance: "no live executor" must be judged against
durable state, not a per-process map — two server instances share the database and would
otherwise both resume one job.)* Job ownership is therefore leased in the database under a transaction advisory lock on the job
key: the lock serializes every claimant — including the first two racers, where neither a lease
nor a workflow row exists — and the running row (with its durable checkpoint) plus the lease
row commit together inside the lock. A unique partial index on `workflow_runs` makes "one build
run per release" a database invariant rather than a hope. A second live instance sees a foreign
active lease and stays idle; a repeated start on the owning instance is a local no-op. While an
executor is alive its lease is renewed, so a long live build is never mistaken for a crashed
one; if ownership is still lost, a stale owner's terminal write is skipped by an
ownership check locked in the same transaction as the terminal write, and re-execution after a genuine crash is a safe recomputation (registration
idempotency `astro-build:<releaseHash>`), never a duplicated publication. Publication workflow
helpers filter by the release's own `workflow_key` so build-job rows are never advanced by
publication checkpoints. Both deterministic builds complete before any review or approval.

Registration authority for runtime-initiated builds is the service principal. There is no MCP
tool that registers reviewed artifacts; the path is reachable only in-process, so widening
`assertAuthority` to `service` does not create an external authority route.

### 2. The preview shows the built output

`GET /previews/:token` keeps serving the Markdown proof artifact while the build runs; once the
release has a registered reviewed artifact it serves the built `index` page instead. The
response also serves the **entire built tree under the token's namespace**
(`/previews/<token>/...`), and relative and root-relative resource URLs in served HTML and CSS is rewritten at
serve time to point into that namespace. *(Corrected after the second acceptance round: a
shared preview cookie mixed two previews opened in one browser — the first page received the
second page's stylesheet. A capability in the URL path needs no cookie and no Referer, both of
which the preview's own `no-referrer`/cookie-sharing semantics defeat.)* The stored output
bytes remain untouched — binding happens only at serve time — so publication still promotes
the exact reviewed files. The preview CSP allows same-origin styles, images, and fonts
(`style-src 'self' 'unsafe-inline'`, `img-src 'self' data:`, `font-src 'self' data:`) while
keeping `default-src 'none'`; traversal and ascending paths 404, and assets carry the same
noindex/no-store headers.

### 3. The human decision is an authorized independent session receipt

*(Corrected after independent acceptance: the first implementation treated the bare capability
URL as authority — a plain HTTP client could record the "human decision". A capability
identifies the request; it never grants the authority to approve.)*

*(Corrected again in the second acceptance round: accepting a bearer on the confirmation
endpoints still let the agent's own MCP token record the "human decision" — the same bearer
worked on `/mcp` and on the decision POST. A bearer proves nothing about a separate browser
session; the login must be its own interactive flow.)*

Preparing a release also mints a second, separate **confirmation capability** (256-bit, stored
hashed) whose URL the agent hands to the human alongside the preview URL. The capability routes
and identifies the confirmation; it grants nothing on its own. Recording a decision requires a
**server-side browser session that exists only after an interactive OIDC authorization-code
login through the existing identity provider**: anonymous navigation redirects into the
provider's authorization endpoint (PKCE S256, single-use state bound to a short-lived cookie);
the callback exchanges the code (client credentials + verifier), verifies the returned token
through the same verifier and identity resolver as MCP, rejects non-human identities, and
creates an `HttpOnly`/`SameSite=Lax` session cookie whose credential never appears in any MCP
output. Authorization bearers are not accepted on confirmation endpoints and cannot be
exchanged for a session, so an agent's working token cannot record the decision. At decision
time the session must still resolve to a `human` principal holding `content:publish` for the
release's exact tenant/site. This is not a second identity platform: the provider, its client
registration, and its login UI stay as-is — the deployment only registers one extra
confidential client (settings in the submission runbook).

The confirmation page is rendered by NavoCMS (not part of the built output): it shows the release
hash, the output manifest digest, file count/bytes, policy version, expiry, and the decided-by
reference, and contains one CSRF-protected form.

Submitting that form is the decision. The server computes the output manifest digest itself
from the registered artifact — the form never carries trust-bearing values — and records an
append-once receipt (`release_confirmations`, new ordered migration) bound to tenant, site,
release, release hash, output manifest digest, **policy version**, **decided-by principal
reference**, decision time, and expiry. The receipt is a domain event with hash-only data. A
POST before the build completed, after expiry, with a foreign or replayed token, with a bearer
that is not a current human session scoped to this site, or without the CSRF pairing
(double-submit cookie, `SameSite=Strict`; a known foreign `Origin` is rejected, and
`Origin: null` requests still cannot carry the Strict cookie cross-site) is rejected;
re-delivering an already-recorded decision is idempotent and returns the same receipt view. The
agent's bearer — delegated or not — can mint neither the receipt nor the decision; it can only
read the outcome through `release_confirm_status`. Trust boundary, stated plainly: the receipt
proves that a session holding a verified human identity for this site acted within the window;
it does not biometrically prove a physical click, and delegated MCP access is never accepted as
that session.

`release_approve` becomes a durable workflow checkpoint that copies the decision: it requires a
current, unrevoked, unexpired confirmation receipt whose release hash, **policy version**, and
output manifest digest match the candidate **and the currently configured approval policy**, and
it records `outputManifestDigest` + receipt reference + policy in its evidence. A change of the
approval policy version between confirmation and approval, or between approval and publication,
invalidates the decision (fail closed before any provider effect). Recovery of an already
checkpointed `publishing` release relies on the durable validation checkpoint instead of
re-asking for a fresh human decision. This retires the old behavior where an MCP `human` bearer
alone could approve; that authority change is versioned in the MCP editing spec compatibility
note, and `AGENTS.md` is amended so the MCP-only wording no longer forbids the independent human
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

## Maintainer review, 2026-09-12

The callback enforces the ten-minute login-state deadline itself. Browser sessions expire no
later than their verified access token and resolved authorization, and membership is re-resolved
when the production authorization resolver is configured. Session loss on restart requires a
new login; durable confirmation receipts remain in PostgreSQL. Token exchange has a bounded
network timeout. Expired in-memory session records are pruned during new logins.

Preview URL binding resolves relative paths against the original output document, including
nested HTML and CSS resources. Malformed percent encoding returns a controlled HTTP error.
Served preview HTML/CSS are a URL-bound projection, not byte-identical HTTP responses to the
stored manifest; publication retains the unmodified stored bytes. Hash verification applies to
those stored/published files, while browser checks verify the preview projection.

The local executor guard is repeated after asynchronous job acquisition. Terminal writes hold
the lease row lock, check the current owner and lease expiry, and commit the workflow update
before releasing that lock; reclaim cannot interleave between validation and the terminal write.
