# ADR 0019 — Staging Astro release inputs and image-attested build runner

**Status:** Proposed

**Date:** 2026-08-26

## Context

An Astro render snapshot added after `preparePreview()` cannot repair a release
whose manifest carries the embedded/default delivery anchors. The previous
checkout-bound runner also cannot execute in the deployed MCP image: the
production image deliberately excludes `.git` and the catalogue workspace.

## Decision

For the reviewed `cloudflare-staging` profile, `McpEditingService` receives a
private `StagingAstroOperations` composition. Before it creates a previewed
release, `StagingAstroPreviewPreparer` derives a bounded single-revision Astro
render input from the durable revision and a reviewed static staging policy.
The policy contains only code-pinned component registrations, CSS, delivery
layout, and governance rules; it rejects unsupported locale/slug and accepts
only media references owned by that exact immutable revision. A bound staging
media selection requires verified `responsive@v1` WebP 320/640 variants plus a
JPEG 640 fallback. It re-reads every selected R2 object under the reviewed
site scope, checks size, type, and SHA-256 against PostgreSQL, and embeds the
bounded variants as `data:image/*` sources in the generated static Astro
artifact. This preserves the text-only Pages artifact transport while binding
real R2-derived responsive bytes into the reviewed input; caller-supplied
asset IDs, URLs, or raw bytes remain impossible. Its content, design,
delivery, governance, and media digests are computed in the deterministic
reviewed input; the first four anchors are copied into the exact release
manifest before the release hash is calculated, while the media digest is
retained in the release-bound reviewed input and Astro artifact evidence.

The private runtime persists that snapshot in `reviewed_astro_build_inputs`
inside the existing preview transaction. The table is site-scoped, append-only,
FORCE RLS, and has only runtime `SELECT`/`INSERT` privileges. Registration
reloads the exact release manifest and artifact hash from `release_candidates`;
the caller cannot provide a manifest, correlation ID, or release anchor. It
requires the authenticated draft principal that created the preview, uses
canonical operation-scoped idempotency, and appends its Ledger/outbox event
under the release document-root correlation ID. The later build and artifact
registration remain human-`content:publish` gated.

Publishing or reconciling an approved/publishing staging release invokes the
same private build gate before `beginPublication()` or any provider call. It
uses deterministic internal keys derived from the immutable release hash, so a
restart/reconcile converges on the same artifact record. This capability is not
an MCP tool and accepts no source/output or commit payload.

The deployed runner is `ImageAttestedAstroBuildRunner`, not a Git checkout.
Coolify passes the exact build source commit as its standard non-secret
`SOURCE_COMMIT` build argument; the image binds that value internally to
`NAVOCMS_REVIEWED_SOURCE_COMMIT`. Astro 7.2.4,
`@astrojs/check` 0.9.10, and TypeScript 5.9.3 are direct production
dependencies of the MCP package at `NAVOCMS_REVIEWED_ASTRO_TOOLCHAIN`. The
runner validates versions and hashes the complete executable package closure
before/after two clean deterministic builds. An absent/unbound commit makes
staging readiness false. `/readyz` exposes only the non-secret policy digest.

## Consequences

The first staging vertical is intentionally a reviewed one-revision page
policy; it permits only its exact `content.revision` media references and the
fixed responsive trio above. Expanding it to catalogue-wide routes, additional
media policy, or directives requires a new reviewed input policy rather than
arbitrary input JSON. Default and production profiles remain embedded and do
not load this composition. Git checkout attestation remains a local review
runner only.

## Validation

Focused tests cover pre-preview anchor derivation, automatic snapshot
persistence, approved-release restart/reconcile without a repeated provider
effect, whole-image-closure mutation detection, unbound source-commit
rejection, the two-build trusted-builder protocol, and the existing provider
no-effect-before-resolver behavior. PostgreSQL CI must still
prove the new migration, input-store replay/drift/concurrency/rollback/restart,
and RLS isolation before operational activation.
