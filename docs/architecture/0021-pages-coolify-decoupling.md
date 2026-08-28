# ADR 0021 — Pages publication and runtime release separation

**Status:** Proposed

**Date:** 2026-08-28

## Context

The original Cloudflare staging provider made a content publication promote the
same source commit through Coolify. That couples editorial approval to a
stateful runtime deployment and can restart the CMS while publishing an
otherwise static site change.

## Decision

`ReleaseProvider` is now Pages-only. Draft, preview, approval, publish,
reconcile, verification, and rollback affect Cloudflare Pages only. The
provider's v2 publication reference contains only Pages deployment identifiers
and the immutable artifact reference. Its existing durable rollback phase and
Pages discovery/live-byte verification remain unchanged.

`io.navocms.cloudflare-staging-binding.v3` contains only the non-secret
Cloudflare Pages coordinates and token reference. It is the only binding that
can activate `cloudflare-staging`. The checked-in v1 and v2 schemas remain
unchanged for compatibility. They are parsed only to identify a legacy binding
and fail activation with `STAGING_BINDING_MIGRATION_REQUIRED` before a secret
or transport is used.

Existing v1 publication references remain decodable through an isolated
compatibility path. They may be read, verified against Pages, reconciled, and
rolled back through Pages; that path never creates a new Coolify deployment.
New v2 provider references never serialize or consult Coolify.

Coolify deployment is an operator/runtime release procedure, outside
`ReleaseProvider`, MCP content tools, and the content binding. Operators pin a
reviewed application commit, deploy it through Coolify, then perform the
runtime health, readiness, OAuth, and authenticated API checks documented in
the deployment runbook. It has its own approval and rollback evidence; a
content release neither triggers nor compensates for it.

## Transition

1. Inventory bindings and retained publications without changing either legacy
   schema or stored reference.
2. Replace each activated v1/v2 binding with a separately reviewed v3 Pages
   binding, pin its new digest, and retain the old document for audit only.
3. Deploy the runtime through the separate Coolify operator procedure. Do not
   use content publish/reconcile/rollback as an activation mechanism.
4. Keep the legacy-reference compatibility decoder until all retained v1
   publications have passed their retention window. It only calls Pages.

## Readiness

Pages readiness is true only when the runtime is production/staging, the v3
binding validates and matches the reviewed tenant, site, hostname, and digest,
the Pages secret reference is available, the PostgreSQL resolver is ready, and
the image-attested builder has its exact source commit. The presence, health,
or credentials of Coolify are explicitly not Pages publication readiness.

Runtime-release readiness is evaluated separately by the Coolify runbook: the
operator must have the reviewed commit, completed migration gate where needed,
and successful post-deploy runtime smoke checks. It does not make a content
publication ready or verified.

## Validation

Focused provider and workflow tests prove zero Coolify calls for Pages publish,
reconcile, and rollback, while v1 references remain Pages-reconcilable. Contract
tests validate v1, v2, and v3 independently.
