# Sprint 8 — operational completion ledger

**Status:** Closed — the staging operational acceptance completed and its test release was rolled back to the prior verified publication.

**Scope:** NavoCMS staging only. Production was not activated or changed.

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

## Executed evidence chain

| Step | Immutable evidence |
| --- | --- |
| Corrective deployment | PR #48; image-attested source commit `af40f55c56eae8aab3534f5f0ed9846c2d72362f`. |
| Original | Asset `0f4476e8-2e20-4932-a127-1bb1e3853d79`; PNG, 1440×811, 85,056 bytes; SHA-256 `e2a53c9454965da044e3c07a60e46575bfd79996c2f51b5083940ebeb997264f`. |
| Variants | `responsive@v1`: WebP 320×180 (`6b261286f17f8c85a79c01d227f6a01623b039dd964cf1b3b24dc23246c963ac`), WebP 640×360 (`ec641308620305545a876c796a617f12d985fe17defe0eb66ae406d98af0d957`), JPEG 640×360 (`4246fed4bd5697c123be72b24e19ffbc9acbfd03206ce08fa116927ee895d0e4`). |
| Revision binding | Live hero reference `926a0d43-ddcc-4a70-b401-8f7802653d72` to revision `a4fb6ae9-4f29-46a8-89a7-1ac5f31d2a33`. |
| Reviewed release | Release `3efd68d9-2d8d-4b68-af7a-879b262131fc`; release hash `31e902c84dde88bb97d88ce8f29de896664cbad5f405f705edd0c494d67b5fee`; preview artifact hash `887e8f714161bcb7bf777bd97fa1b4ec25b8d3aff3d36c3ab25f5ad126503a89`. |
| Object evidence | R2 source object SHA-256 `fa15d07e9fe2092638663389695265180b7c0c7205a68bee6166a3288457c594` (53,137 bytes); output object SHA-256 `1799a9f87952d108cedf16e623d8d1ba9867f9b3e642731034d4351ae5105034` (48,051 bytes); binding evidence `sha256:7fba64c522c4a92682581fa95732cd69ba028445a238ae6f350f53493183b5b9`. |

## Release trajectory

1. The protected preview body had SHA-256 `887e8f714161bcb7bf777bd97fa1b4ec25b8d3aff3d36c3ab25f5ad126503a89`, exactly matching the preview artifact hash. Its capability response was private/no-store and `noindex, nofollow, noarchive`.
2. A human approved the exact reviewed release hash. The first trusted-build attempt stopped before any provider effect because the former 512 MiB staging limit OOM-killed `astro check`; the release remained `approved`.
3. The staging-only Coolify memory and swap limits were raised to 1 GiB. `release_reconcile` safely resumed the same approved release and published one verified artifact. The live route `/sprint-eight-operational-proof/` was 47,962 bytes with SHA-256 `a40a404fa07cf13d57d2cf54afda947258fe80419ab3552620cd85ba2ec5b499`, `Cache-Control: public, max-age=300, must-revalidate`, and `<picture>`, `data-navocms-variant`, Zaraz, consent-bridge, and analytics-bootstrap markers.
4. `release_rollback` restored prior verified publication `4a2f7cf1-87f4-433f-912a-58b208697f29`. The same route then returned the predecessor's 874-byte body with SHA-256 `12bcd5130a6a3b3ecdce50f4d838d6b864b04f917d5a35d300442aa5195b89cb`.
5. A final reconcile remained `rolled_back`. The staging runtime was restarted after that durable checkpoint; `/healthz` and `/readyz` were healthy/ready and confirmed the reviewed Pages, builder, resolver, and R2 bindings.

## Duplicate-effect and audit proof

- One exact human approval and one publication row exist for the test release; its publication is `rolled_back`.
- The media trajectory has one asset, one original, three variants, and one live revision reference. No duplicate variant or reference was created.
- Durable checkpoints contain one `approval.validated`, `provider.applied`, `live.verified`, `rollback.pending`, and `rollback.completed` record. Both delivery reservation and completion checkpoints are present exactly once.
- The failed pre-provider publish remains audit evidence of the OOM stop. Recovery used the dedicated reconcile workflow rather than a duplicate publish call.

## Sitemap scope note

`navocms-staging-site.pages.dev` serves this isolated reviewed artifact only; it has no site-level sitemap and `sitemap-index.xml` returns 404. This is not a deployment of the separate `navi-astra` public site, so its sitemap gate is not applicable to this Sprint 8 staging acceptance. No production SEO surface was changed.

## Outcome

Sprint 8's required staging trajectory — upload, variants, revision binding, preview, exact human approval, publish/reconcile, live verification, durable restart, rollback, and post-rollback reconciliation — completed successfully. Production activation remains explicitly outside Sprint 8.
