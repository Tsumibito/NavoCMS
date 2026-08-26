# Sprint 8 — operational completion package

**Status:** Review required / Pending CI and staging proof

## Delivered code boundary

- Migration `0011_reviewed_astro_build_inputs.sql` adds append-only,
  tenant/site-scoped durable snapshots bound by exact composite foreign keys to
  a staging release and its preview artifact. It has FORCE RLS and runtime
  `SELECT`/`INSERT` only.
- `preparePreview()` now derives the reviewed staging Astro input before the
  immutable release hash is made. The release manifest anchors and persisted
  render snapshot therefore describe the same content/design/delivery/
  governance/media evidence.
- Snapshot registration reloads the durable release manifest; an operator
  cannot promote a caller-provided manifest/hash/anchor. The authenticated
  draft principal, canonical idempotency, the existing Event Ledger/outbox,
  document-root correlation ID, and transaction path are retained; the later
  build/artifact registration remains human-`content:publish` gated.
- Publish and approved-release reconciliation first ensure the durable
  reviewed artifact, then use the already reviewed Cloudflare/Coolify provider.
  No public MCP tool exposes the snapshot, build output, or commit selector.
- The staged runtime uses an image-attested toolchain and Coolify source SHA;
  it never expects `.git` or catalogue modules in the application image.
  Missing `NAVOCMS_REVIEWED_SOURCE_COMMIT` fails staging readiness closed.

## Local evidence

- The full non-PostgreSQL gate passed: contracts, boundaries, secret policy,
  docs/links, typecheck/build/catalogue, 191 unit tests, and 5 visual tests.
  Thirty-eight PostgreSQL-dependent tests were skipped because the local Docker
  daemon is unavailable.
- After the senior fixes, focused operational/runner/workflow suites passed:
  17 tests, with typecheck and `git diff --check` also green.
- The image runner's staged production-toolchain fixture proves whole-closure
  fingerprinting, source-commit fail-closed readiness, and executable-file
  mutation detection. A real `pnpm --prod deploy --legacy` production layout
  also passed image attestation and a materialized Astro check/build locally.
  The two-clean-build protocol remains covered at the trusted-builder boundary;
  the real container and PostgreSQL paths remain CI/staging evidence.

## Required single CI and operations trajectory

1. Senior-review this package, commit/push one PR, and wait for one ordinary
   GitHub CI run; do not manually rerun it. PostgreSQL must execute migration
   `0011`, input-store integration, and RLS suites without skips.
2. Merge only after that run is green. Let the usual post-merge CI run finish.
3. In the encrypted staging overlay set the reviewed binding/secret references,
   `NAVOCMS_REVIEWED_ASTRO_TOOLCHAIN=/app/node_modules`, and configure Coolify
   **Include Source Commit** so Coolify supplies the standard `SOURCE_COMMIT`
   build input, which the image binds to `NAVOCMS_REVIEWED_SOURCE_COMMIT`.
4. Confirm `/readyz` shows `cloudflare-staging`, the expected binding digest,
   resolver, and non-secret Astro policy digest. Run dry resolver proof before
   a transport is allowed to use a token.
5. Retain one authenticated human trajectory: draft → preview (input snapshot)
   → exact approval → publish (two builds, artifact registration, provider) →
   live bytes/cache verification. Then retain restart/reconcile and rollback
   evidence from the same immutable release chain.

Sprint 8 is not closed by this code package alone; only the green CI and the
real staging trajectory above can close it. Production remains embedded and
unactivated.
