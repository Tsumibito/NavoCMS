# Sprint 7.1 hardening and operational acceptance report

**Acceptance date:** 2026-08-25

**Implementation state:** completed and accepted. The code gate and operational gate are closed on
`main` commit `c17c1fea9d1232196812afdcc412622d4045dadc`. Production remains private and the embedded
proving provider remains the only active publication provider.

## Code-gate evidence

The Sprint 7.1 hardening entered `main` through the reviewed completion work and the WorkOS
organization/role binding fix in PR #31. The post-merge GitHub workflow passed on 2026-08-25:

- [GitHub Actions run 32889095328](https://github.com/Tsumibito/NavoCMS/actions/runs/32889095328);
- all ordered migrations through `0009` applied with checksum registration;
- the complete PostgreSQL persistence and RLS isolation suites ran without skipped database tests;
- the production container and visual checks passed.

The implemented invariants include:

- state mutation, operation-aware idempotency, Event Ledger append, and transactional outbox append
  in one PostgreSQL transaction;
- one document-root correlation trajectory across preview, approval, publication, reconciliation,
  verification, and rollback;
- human-only exact-hash approval with persisted policy version, evidence, scope, expiry, and
  revocation;
- atomic migration/checksum registration, bounded Markdown diff, and synchronized
  `metadata.body`;
- a digest-pinned production profile booted through `PluginHost`, durable quotas and kill switches,
  exact migration readiness, runtime `NOBYPASSRLS`, forced RLS, and deployment-scope checks;
- permission-scoped MCP discovery and executable authorization tests.

The detailed completion criteria remain recorded in
[`SPRINT_7_1_CODE_GATE_TASK.md`](SPRINT_7_1_CODE_GATE_TASK.md).

## Staging deployment evidence

The accepted artifact was deployed to the Coolify application `navocms-staging` from the exact
`main` commit above.

- image digest: `sha256:7bc07b6adc4b31c94c24ffc4cd31a109b618c7a3313819bc3c53371ae46f0973`;
- `/healthz`: `{"status":"ok"}`;
- `/readyz`: `{"status":"ready","pluginHost":{"state":"healthy","activePlugins":["navocms.release.embedded"],"profile":"embedded-release-production@0.1.0"}}`;
- readiness was captured before and after the container restart. A `ready` response on this build
  requires the expected migration checksums, a non-superuser `NOBYPASSRLS` runtime role, forced RLS
  on the complete current application schema, the configured deployment scope, and a healthy pinned
  `PluginHost`.

The encrypted staging env file remains mounted at `/run/navocms/.env`. WorkOS organization binding
and the server-side role ceiling were added as dotenvx-encrypted values; no application secret or
plaintext authorization configuration was added to Coolify platform variables.

## Organization-bound OAuth evidence

The WorkOS staging JWT Template now emits the exact organization membership role. Its preview and
three fresh authorization flows produced:

- organization: `org_01M0SK87T1XJJ0RWSFKV2P05GX` (`NavoCMS`);
- role: `navocms-owner`;
- MCP audience: the staging `/mcp` resource;
- effective tools bounded by the persisted site membership and the configured server-side role
  ceiling: `content:read`, `content:draft`, and `content:publish`.

The operational client was Codex using the same public MCP OAuth flow intended for third-party MCP
clients. The client brand is not an authorization invariant: the retained proof is the exact WorkOS
organization claim, human principal, audience, site membership, and effective permission
intersection.

## Retained publication trajectory

The authenticated human trajectory completed against staging on 2026-08-25:

| Evidence | Value |
|---|---|
| Site | `2e0bcd4f-6780-470c-844b-d72abb6737ca` (`navocms.com`) |
| Draft document | `65f06b32-4cd8-4fc3-9580-13bd7f1cef63` |
| Revision | `49e5bfa6-77e6-4b64-83f3-bc74fd79762d` |
| Source hash | `1bb7918eee558c772f1dd06cad99b4eea52147bd6e72c0b65ef578c28596a6c2` |
| Release | `425bc6fa-0be7-413b-8995-bf9921a7ebb5` |
| Release hash | `0b9c20e8dbeaa5ce4aec4d90a9da8d155854e49d7aea4717b10cd6353c9d7e1a` |
| Artifact hash | `92c861ff6de180a5e5d6a20f5f604473464b245b8421985b3f4b4db8d7e7a197` |
| Preview created | `2026-08-25T19:43:10.766Z` |
| Human approval | `2026-08-25T19:43:17.325Z` |
| Publication | `ab7379c4-68f4-4734-8e81-7ca4eac4d443` |
| Published/verified | `2026-08-25T19:45:01.859Z` |
| Provider | `navocms.embedded.v1` |

The sequence was `draft_create -> preview_prepare -> release_approve -> release_publish ->
release_status/release_reconcile`. Approval was accepted only for the exact release hash and the
publication retained the identical artifact hash.

The first publish HTTP attempt received a transient `502` while the durable release remained
`approved`. Reusing the same operation and idempotency key completed publication exactly once. A
second replay returned the same publication ID and hashes. This is retained retry evidence, not a
hidden duplicate effect.

## Restart and persistence proof

After the successful publication, the Coolify container was restarted without rebuilding. The
following checks then passed through a new organization-bound OAuth session:

- `/readyz` returned `ready` with the same pinned healthy profile;
- `release_status` returned the same release as `published` with unchanged release/artifact hashes;
- `release_reconcile` returned publication `ab7379c4-68f4-4734-8e81-7ca4eac4d443` as `verified`;
- replaying the original draft operation with the original idempotency key returned the same
  document, revision, source hash, revision number, and timestamp;
- post-merge PostgreSQL RLS suites retained alongside this exact commit cover cross-site reads and
  writes for the complete current schema, while staging readiness re-proved forced RLS and the
  runtime-role/deployment constraints after restart.

## Gate decision and follow-up

Sprint 7.1 is accepted. P1, P2, P3, and P4 are operationally closed, and the Sprint 6 staging gate
is closed. P5, P6, and public production publication remain open for the real Astro/Cloudflare
vertical.

Two observations are non-blocking follow-up for Sprint 8 delivery operations:

- Coolify had the previous commit SHA pinned, so the accepted `main` SHA had to be promoted
  explicitly before the successful deployment;
- the transient first-attempt `502` should be included in delivery-provider telemetry and SLO
  tests, although the required exact-once retry behavior already passed.
