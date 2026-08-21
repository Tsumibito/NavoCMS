# ADR 0007 — Microkernel package boundaries

**Status:** Accepted

**Date:** 2026-08-21

## Context

The first implementation must prove the trusted-kernel boundary rather than create a monolith that
is later renamed as plugins. Public contracts, capability resolution, HTTP transport, and external
service plugins have different dependency and security responsibilities.

## Decision

Use a pnpm TypeScript workspace with four initial boundaries:

- `@navocms/contracts`: public types, JSON Schema validators, and packaged schemas;
- `@navocms/kernel`: capability registry, plugin graph/host, Event Ledger, trajectory, and tracing;
- `@navocms/api`: Fastify transport shell consuming kernel/contracts;
- `@navocms/plugin-noop-service`: independently deployable service example that does not import the
  kernel.

The kernel has no Fastify dependency and cannot import applications or concrete plugins. External
plugins may consume public wire contracts but cannot import trusted-kernel internals. Automated
boundary checks reject reverse dependencies.

The API shell exposes liveness, readiness, bounded contract validation, and kernel status only. It
is development infrastructure, not a production unauthenticated management API. Identity and OAuth
arrive with the Sprint 2 security boundary before any site data endpoint.

## Consequences

- Package direction is executable and reviewable from the first code sprint.
- Public schemas ship with the contracts package rather than relying on repository-relative files.
- The no-op service demonstrates authentication and idempotency without sharing process authority.
- Persistence remains behind interfaces; Sprint 1 uses an in-memory Event Store only for contract
  and trajectory verification.

## Alternatives considered

- **Single application package:** rejected because dependency direction would be conventional rather
  than enforced.
- **One process per plugin immediately:** rejected for trusted first-party definitions and early
  operational overhead.
- **Fastify inside the kernel:** rejected because transport must not define domain boundaries.

## Validation

The build, boundary checker, contract validator, unit tests, API injection tests, and independent
service tests must pass in a clean checkout. A plugin health or activation failure must never leave
partial registrations active.
