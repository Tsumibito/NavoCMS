# Sprint 8 — operational completion ledger

**Status:** Staging runtime active; authenticated publication trajectory open

## Accepted code boundary

- Media originals, variants, lifecycle, safe ingest boundaries, review tools,
  and site-scoped PostgreSQL persistence are implemented.
- Reviewed Astro source and output bundles are deterministic, independently
  verified, and stored through immutable object bindings. Legacy JSON records
  remain a read-only compatibility path pending a retention decision.
- Cloudflare Pages owns preview, publish, verification, reconcile, and rollback.
  Content publication never deploys or restarts the Coolify runtime.
- Coolify deploy is a separate operator action pinned to an exact application
  commit.
- Staging R2 uses one shared S3 transport and fixed physical namespaces under
  `navocms/v1/`; media and artifact logical keys cannot escape their reviewed
  child namespace.
- Production remains embedded and has no external provider activation.

## Staging evidence

- Ordered PostgreSQL migration `0012` was applied with its registered checksum
  and the release/RLS gates passed.
- The reviewed staging runtime was deployed through Coolify from `main`.
- `/healthz` and `/readyz` returned healthy/ready; readiness exposed only safe
  Pages, artifact-builder, resolver, and R2 identifiers.
- R2 readiness verified the reviewed root, media, and artifact namespace
  markers. No provider-wide delete or existing-object migration was performed.

## Cleanup decisions

- Removed dormant PluginHost, checkout runner, remote-ingest runtime, direct
  upload, Coolify publication client, and unused telemetry surfaces.
- Removed migrated Cloudflare binding v1/v2 activation readers and duplicated
  semantic contract validation.
- Replaced duplicate Pages/R2 secret brokers with one dotenvx boundary and
  collapsed the extra R2 composition layer.
- Reviewed Astro registrations now require source. The durable empty
  `legacyComponentIds` field remains only to preserve existing hashes.
- Historical sprint progress reports were removed; Git history and pull-request
  runs remain the immutable evidence. Active runbooks and this ledger remain.

## Still required before Sprint 8 closes

Retain one authenticated human staging trajectory tied to the same immutable
release chain:

1. draft → preview;
2. exact human approval;
3. publish and live byte/cache verification;
4. restart → reconcile without a duplicate external effect;
5. rollback to the previous immutable reference and reconcile once more.

The evidence must include the release/artifact/reference hashes, WorkOS actor,
Pages deployment identifiers, PostgreSQL phase checkpoints, Event Ledger, and
outbox records. This is an operational acceptance step, not another code
package. Production activation is explicitly outside Sprint 8.
