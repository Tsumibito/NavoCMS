# ADR 0017 — Cloudflare preview delivery provider

**Status:** Proposed

**Date:** 2026-08-25

## Context

Sprint 8B.1 produces a deterministic, verified Astro source artifact and built
output, but it deliberately has no deployment side effect. A public deployment
must preserve the existing exact-hash release workflow: an interrupted provider
call must be discoverable, verification must be independent from application,
and rollback must target an already recorded publication.

The staging incident retained in Sprint 7.1 also established two operational
requirements: deployment retries need structured, secret-free telemetry, and
the exact accepted commit must be promoted to Coolify rather than relying on a
moving branch head.

## Decision

`@navocms/delivery-cloudflare` supplies a dormant `ReleaseProvider` adapter.
It only operates when a host injects all of the following capabilities:

- a resolver from the existing immutable release row to a verified Astro
  artifact and complete built output;
- a Cloudflare Pages Direct Upload transport; and
- a Coolify exact-commit transport.

The adapter builds `io.navocms.cloudflare-artifact-reference.v1` only after
`verifyAstroArtifact` and `verifyBuiltAstroOutput` pass. The reference binds:

- release and existing release-artifact hashes;
- Astro artifact and full built-output hashes;
- deterministic HTML-route digest, bounded file count, byte size, and a sorted
  per-file byte-hash manifest; and
- a complete source commit SHA.

Cloudflare deployment creation searches first for the immutable reference hash
and explicit `preview`/`production` environment embedded in the Pages deployment
commit message. A preview call rejects the configured production branch and
requires the API response to report `environment=preview`; the separate release
deployment call requires the configured production branch and
`environment=production`. Direct Upload follows the
documented upload-token, missing-hash, asset-upload, and deployment sequence.
The deployment receives deterministic `_headers` containing the release,
output, and reference hashes plus an explicit cache contract. An HTTPS
Pages-scoped live probe first checks the project’s authoritative
`production_branch` and `canonical_deployment`, then uses an allowed canonical
Pages alias. It streams every expected output file within its exact declared
byte bound and checks each digest, response headers, and cache policy.
It therefore does not trust matching headers when a live file was replaced.
An HTTP 200 alone cannot mark a publication verified.

Coolify is subordinate to the static-artifact proof: it is asked to pin and
deploy the exact commit from the immutable reference, never a branch head.
Coolify exposes the applied commit but not an arbitrary artifact-reference
field, so it independently proves the application/commit binding while
Cloudflare independently proves the content-addressed output binding. A
commit-only Coolify history record is intentionally never reused as an artifact
reference: the provider repeats a bounded exact-commit promotion when no exact
binding can be attested. This prevents a second reference for the same commit
from silently inheriting a prior deployment.
Every HTTP call has an abortable bounded deadline; the same deadline spans the
sequential live-file probes. Coolify’s deployment trigger returns a fresh
deployment UUID, which is retained and inspected during rollback rather than
assuming the old target run represents the new external effect.

The provider uses a scoped adapter over the existing workflow checkpoint store
for external phases. Reservation is serialized by site/release/reference/phase
inside the existing PostgreSQL transaction, so only one concurrent caller owns
an external effect. The returned provider ID is checkpointed immediately after
that effect. A restart reuses and verifies a completed ID. A reservation with
no ID never causes a second effect: Cloudflare reconciliation proves the
authoritative `canonical_deployment` and immutable live bytes before completing
the phase; Coolify has no immutable operation lookup, so a human operator must
record a candidate deployment UUID plus evidence hash. The provider then
inspects that exact candidate against the commit/reference binding before it
marks the phase completed. Missing, zero, or invalid evidence stays fail-closed
but remains resolvable by another bounded human resolution record.

Rollback intent also records `workflow_runs.current_step = rollback.pending`
through the existing release-workflow repository. This is a durable recovery
index, not a second release or idempotency mechanism: the precise target remains
the immutable linked publication pair in the checkpoint, and a restart may only
reconstruct that same pair while the run is still pending.

Release publish, reconciliation, and rollback deliberately commit their
idempotency reservation and provider prepare/checkpoint before calling an
external provider. They do not keep an outer PostgreSQL transaction open across
Cloudflare or Coolify: a provider crash must leave durable recovery state, not
roll it back with the request transaction. Completion and subsequent Ledger or
outbox work still use the existing persistence boundaries.

The existing `McpEditingService`, release repository, PostgreSQL idempotency
store, Event Ledger, transactional outbox, reconciliation, and rollback remain
the sole release workflow. The provider introduces no database tables,
transaction manager, or idempotency store. Its optional telemetry bridge appends
to the existing Event Ledger rather than creating a telemetry database. Each
discover, preview, verify, promotion, retry, and rollback attempt carries only
hashes, operation names, attempt counts, stable error codes, and optional HTTP
status. Credentials, URLs, headers, bodies, and provider error text are
excluded.

The checked-in production profile remains pinned to the embedded provider. No
Cloudflare token, Coolify token, binding, environment variable, deployment, or
production activation is part of this decision.

## Failure model

| Interruption | Retry / reconciliation behavior |
|---|---|
| Before Pages effect | No provider reference exists; retry performs bounded discovery then creation. |
| After Pages effect, before PostgreSQL checkpoint | Discovery finds the Pages environment-specific commit-message marker and returns the same deployment. |
| Pages 502 during discovery or live verification | At most three bounded attempts emit sanitized telemetry; a failed live verification remains reconcilable. |
| Transport stalls | Cloudflare, Coolify, and the full sequential live probe abort at their configured bounded deadline. |
| Failed or canceled Pages/Coolify deployment | A terminal record is never accepted as success; Pages uses its retry operation and Coolify repeats the exact pinned commit deployment. |
| Same commit, different reference | Coolify's commit-only history is not reused; a bounded exact-commit promotion is required. |
| After provider effect, before publication record | The durable release remains `publishing`; existing `release_reconcile` re-enters the provider without replaying a reserved external effect. |
| Cloudflare rollback after effect, before checkpoint | `release_reconcile` proves the project canonical deployment, target byte hashes, and cache policy, then completes the reserved phase without another rollback POST. |
| Coolify effect after reservation, before checkpoint | The provider does not replay because Coolify cannot search by immutable reference. A human-only resolution records a candidate UUID and evidence hash; only a subsequent exact inspect completes the phase. Missing or invalid candidates remain fail-closed and can be replaced by a new evidence record. |

## Consequences

- Preview deployment accepts only verified, bounded static output and emits an
  immutable provider reference suitable for existing PostgreSQL publication
  records.
- API clients are injectable and have no ambient configuration. Their token
  callbacks are expected to read encrypted runtime configuration outside this
  package.
- Cloudflare Pages API behavior is based on the official [Direct Upload
  guide](https://developers.cloudflare.com/pages/get-started/direct-upload/)
  and [deployment API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/create/).
  Coolify commit pinning uses its documented [application update
  endpoint](https://coolify.io/docs/api-reference/api/applications/update-application-by-uuid)
  followed by [deployment trigger](https://coolify.io/docs/api-reference/api/deployments/deploy-by-tag-or-uuid).
- A future operational activation must supply an immutable resolver and an
  explicit one-artifact-per-commit attestation, then add a separately reviewed
  profile binding. This package alone cannot activate delivery.

## Alternatives considered

- **Deploy the current Git branch:** rejected because a branch head is mutable
  and cannot preserve exact review/approval.
- **Let Cloudflare or Coolify deployment history be the release audit:**
  rejected because it lacks site scope, human approval, and durable NavoCMS
  correlation.
- **Embed tokens or enable a production provider now:** rejected because this
  package is a capability boundary, not operational activation.

## Validation

Focused tests prove immutable reference replay, failed reference resolution,
bounded 502 retry telemetry, live-hash verification, external rollback targets,
direct-upload credential separation, project/application scope denial, and
existing release reconciliation without a duplicate external effect. GitHub CI
is required before this proposed decision is accepted.
