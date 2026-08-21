# ADR 0003 — Capability-based plugin model

**Status:** Accepted

**Date:** 2026-08-21

## Context

NavoCMS needs replaceable renderers, media processors, SEO systems, forms, analytics, CRM, and email
without turning the kernel into a universal application or allowing arbitrary packages to inherit
all process authority.

## Decision

Model extension seams as versioned capabilities with definition, provider, and consumer roles.
Resolve a site's plugin graph from a versioned profile before serving or running a workflow. The
resolved graph is immutable for the workflow run.

Execution/trust classes are kernel extension, in-process site module, external service plugin,
MCP Apps UI projection, and future sandboxed pure transform. Runtime installation by an agent is
forbidden. Installation follows verify, graph validation, migration plan, approval, inactive
install, migration, healthcheck, activation, drain, and removal.

Identity, authorization, tenant isolation, event integrity, idempotency, migrations, secrets,
quotas, and release policy stay in the trusted kernel.

## Consequences

- Plugins declare capabilities, dependencies, data/network permissions, effects, and health.
- Provider replacement is testable at the semantic contract, not just TypeScript interface level.
- In-process third-party code is not considered safely isolated.
- Collections remain declarative definitions; coherent domain packs may be plugins.

## Alternatives considered

- **Everything is an in-process package:** rejected because process authority defeats permission
  declarations.
- **Every collection is a plugin:** rejected because it creates package and migration sprawl.
- **Only remote services:** rejected for simple trusted definitions and latency-sensitive adapters.

## Validation

Sprint 1 must reject missing, cyclic, incompatible, unhealthy, or over-permissioned providers before
serving. Deactivation must remove registrations and subscriptions without restarting unrelated work.
