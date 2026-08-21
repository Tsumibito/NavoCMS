# ADR 0008 — Identity and isolation boundary

**Status:** Accepted

**Date:** 2026-08-21

## Context

An agent-native multisite system must not confuse conversational convenience with ambient
authority. A human, agent, service account, plugin, and operation can each impose a narrower scope.
Database filtering alone cannot determine whether a principal should have received a site scope,
while application filtering alone leaves one mistake between a caller and another tenant's data.

## Decision

Treat authorization as the intersection of principal, tenant, site, delegation, plugin, and
operation permissions. Missing layers never add authority. Verify OIDC access-token signature,
issuer, audience, lifetime, resource scope, tenant, and site claims before constructing that
context. Expose standards-based OAuth protected-resource metadata for MCP clients, while leaving
authorization-server choice to the operator.

Set validated tenant, site, environment, and principal identifiers only inside a database
transaction. Every site-owned table carries tenant and site identifiers and uses forced PostgreSQL
Row-Level Security. Runtime application and plugin roles use `NOBYPASSRLS`; a separate, short-lived
migration identity owns the schema.

Store only secret references and metadata in ordinary persistence. A broker supplies plaintext to
an explicitly permitted plugin for one bounded operation. Reject secret-shaped fields before they
enter events or external projections. Scope storage keys, usage, quotas, and kill switches by
tenant/site/plugin.

## Consequences

- Site membership is required even when a principal belongs to the tenant.
- Plugins receive the intersection of their manifest authority and the invoking principal's
  authority.
- The API cannot use migration credentials in normal operation.
- Self-hosters may replace the identity, secret, and object-storage providers without replacing the
  authorization contracts.
- OAuth metadata is public; content and management resources remain protected.

## Alternatives considered

- **Application filters without RLS:** rejected because one missing predicate becomes a data leak.
- **RLS without application authorization:** rejected because database session scope is not an
  entitlement system.
- **One shared superuser connection:** rejected because it bypasses the isolation boundary.
- **Persist provider keys in plugin configuration:** rejected because configuration, events, and
  export are ordinary projection surfaces.

## Validation

Sprint 2 must pass application scope-confusion tests, secret and storage projection tests, signed
OIDC token tests, and direct PostgreSQL attempts to enumerate or write another site while using a
`NOBYPASSRLS` runtime role.
