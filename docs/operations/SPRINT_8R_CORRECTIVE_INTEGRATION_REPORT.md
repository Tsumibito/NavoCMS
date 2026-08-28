# Sprint 8R — corrective integration report

**Status:** local code gate passed; staging runtime deployment pending

## Result

The corrective branches are integrated in dependency order: repository cleanup,
reviewed Astro object bindings, Pages-only content publication, simplified runtime
composition, the shared S3/R2 core, and the reviewed R2 binding.

R2 uses the existing Navi Training bucket without moving or deleting its objects.
NavoCMS owns only these reviewed physical namespaces:

- `navocms/v1/`;
- `navocms/v1/media/`;
- `navocms/v1/artifacts/`.

Media and reviewed Astro artifacts share one SigV4 transport but use different
domain adapters. Application keys such as `tenants/...` remain logical and can
never be sent as bucket-root keys. Cloudflare Pages publication no longer invokes
Coolify; Coolify remains an independent operator-controlled runtime deployment.

The encrypted staging overlay contains the reviewed R2 binding, its independent
digest, and two dotenvx secret references. No plaintext credential was added to
the repository or Coolify platform variables.

## Evidence

- Three immutable namespace markers were created under the reviewed prefix.
  Existing bucket objects were not changed and no delete operation was issued.
- A live read-only smoke check through the integrated transport verified binding
  scope, digest, and all three exact marker bodies.
- R2 startup fails closed before media or artifact storage injection on a missing
  marker, marker drift, binding drift, scope mismatch, unavailable secret, or
  provider failure.
- Full local gate passed: 192 unit tests, 43 PostgreSQL-dependent skips,
  and 5 visual tests. Contracts, boundaries, secret policy, docs, links, builds,
  typecheck, and catalogue checks passed.

## Retained compatibility and remaining operation

Migration `0012_reviewed_astro_artifact_object_bindings.sql` is additive. Legacy
`0010` artifact JSON remains a bounded read fallback; no backfill, retention drop,
or destructive cleanup is claimed in this sprint.

The code gate is complete locally. Do not declare the staging operational gate
closed until a migration owner applies `0012`, the combined branch is reviewed
and deployed, `/readyz` reports the reviewed R2 binding and storage readiness,
and one authenticated staging publication proves artifact persistence and Pages
delivery. GitHub CI was intentionally not started because the Actions budget is
exhausted; use one ordinary run only when the integration is ready to merge.
