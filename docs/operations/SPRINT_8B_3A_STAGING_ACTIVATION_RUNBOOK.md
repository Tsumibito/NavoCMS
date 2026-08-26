# Sprint 8B.3A — staging activation boundary

**Status:** Review required / Pending CI / no external effects performed

## Scope

This package pins the reviewed, external-effect-capable `cloudflare-staging`
profile and the versioned `io.navocms.cloudflare-staging-binding.v2` contract.
The default and production profiles remain the pinned embedded release
provider. This package does not create a Cloudflare project, call a provider
API, forward a secret to a transport, or publish an artifact.

## Implemented 8B.3B local boundary

The staging composition now reads a durable reviewed Astro record from
PostgreSQL and injects the strict resolver into the real Cloudflare provider
only when `NAVOCMS_RELEASE_PROVIDER=cloudflare-staging`. Embedded remains the
default and production provider. `/readyz` exposes only non-secret provider
and resolver readiness coordinates. It never reports a specific release as a
global readiness dependency; the dry run for that release still requires its
exact persisted record.

No provider transport is called by resolver readiness, record registration, or
the persisted dry-run proof. Missing readiness, missing record, scope/hash
drift, tampered source, or tampered output fails closed before secret forwarding
or Cloudflare/Coolify transport use.

## 8B.3C trusted reviewed-build prerequisite

Sprint 8B.3C adds the internal `TrustedAstroBuilder`; it is not a public MCP
tool. The builder receives an exact reviewed release identity and bounded
idempotency key, loads the complete reviewed content/design/media/delivery/
governance input through a private boundary, renders with
`@navocms/design-astro`, and creates two clean pinned Astro builds. It checks
the configured reviewed checkout is clean and detached, derives
`sourceCommitSha` only with `git rev-parse --verify HEAD^{commit}`, and
performs one bounded offline frozen-lockfile preparation for the checkout-local
toolchain. It re-attests the same checkout-bound lock and executable toolchain
closure before registration. Each build has an independent materialization and
isolated cache. It rejects
non-identical output and then uses the existing
`PostgresReviewedAstroArtifactStore` transaction, idempotency,
Ledger, and outbox path as an authenticated human with `content:publish`.

The private runtime composition that supplies the reviewed-input store remains
required before an operational dry run. Do not expose its source/output objects
or commit selector in MCP; do not wire the builder to Cloudflare, Coolify,
credentials, or the production profile.

## Operator input for 8B.3B

The private deployment overlay must supply a validated binding containing only:

- tenant ID, site ID, and `staging` environment;
- Cloudflare account/project IDs, actual production and preview branches, a
  Pages preview hostname suffix, and the exact allowed staging hostname;
- Coolify HTTPS base endpoint and application UUID;
- dotenvx secret-reference names for the Cloudflare and Coolify API tokens.

Do not put token values, Authorization headers, dotenvx decryption keys, or
encrypted environment files in this repository, an MCP request, test fixture,
or log. The runtime secret broker resolves the two references only after the
staging profile has passed readiness.

## 8B.3B execution checklist

1. Review and compose the trusted builder/registration prerequisite above with
   a durable reviewed-input source; no MCP payload fallback is allowed.
2. Confirm the deployment is `staging`; reject the profile for production.
3. Validate the binding schema, tenant/site scope, distinct Pages branches,
   HTTPS Coolify endpoint, and secret-reference names.
4. Run the dry proof as an authenticated WorkOS human with `content:publish`:
   resolver → immutable artifact → provider coordinates. Retain its digest.
5. Inject short-lived secrets through the private dotenvx overlay; never print
   them. Boot only the reviewed staging provider capability.
6. Execute and retain one trajectory: draft → preview → exact human approval →
   publish → live-byte verification.
7. Restart after a durable phase reservation and use reconciliation rather than
   reissuing a mutation. Retain checkpoint, Ledger/outbox, and provider IDs.
8. Roll back to the exact previous immutable reference, verify canonical Pages
   bytes/cache contract and the finished Coolify deployment, then reconcile
   after a second restart.

## Stop conditions and rollback

Stop before any external effect if the environment is not `staging`, binding
scope mismatches, a reference is absent, a token reference is malformed, or
the caller is not a WorkOS human with `content:publish`. For an interrupted
effect, preserve the phase reservation: Cloudflare resolves from canonical
bytes; Coolify requires authenticated evidence-bound resolution. Do not delete
checkpoints, retry mutations automatically, or promote the staging profile to
production.

## Evidence required for Sprint 8B.3B acceptance and P5/P6 closure

- binding digest and readiness output without secrets;
- release/artifact/reference hashes and authenticated approval identity;
- Cloudflare preview/production deployment IDs, live-byte and cache evidence;
- Coolify deployment UUID and finished state;
- PostgreSQL phase/checkpoint, Event Ledger, and outbox trajectory;
- restart/reconcile and rollback/restart transcripts tied to the same artifact.

Sprint 7.1's operational gate was closed in `main` on 25 August 2026 and is not reopened by this package. This evidence supports the real Astro/Cloudflare vertical and closure of the remaining P5/P6 acceptance items.
