# ADR 0005 — Multitenancy from the foundation

**Status:** Accepted

**Date:** 2026-08-21

## Context

The first operator will manage several sites and share selected sites with different administrators.
Retrofitting tenant isolation after building a single-site CMS would affect every identifier,
authorization check, object path, event, secret, cache key, and workflow.

## Decision

Model identities, tenants, tenant memberships, sites, site memberships, roles, environments, and
service accounts in the first persistence version. Every site-owned record and event carries
`tenantId` and `siteId`.

Apply authorization in the application and PostgreSQL Row-Level Security. Application and service
roles cannot use `BYPASSRLS`; migrations use a separate short-lived owner. Scope object storage,
secrets, service credentials, workflows, caches, quotas, and exports to tenant/site.

Use a shared database initially while preserving provider contracts for dedicated databases or
buckets later.

## Consequences

- Single-site installations still use explicit tenant/site identity.
- Tenant membership does not grant access to every site.
- Tests must attempt foreign-ID enumeration, confused-deputy calls, cross-site cache/storage access,
  and backup/restore mistakes.
- Operational break-glass access is separately scoped and audited.

## Alternatives considered

- **Add tenancy for hosted SaaS later:** rejected because isolation affects all durable contracts.
- **Database per site immediately:** rejected for early operational cost, while remaining a future
  deployment option.
- **Application filters only:** rejected as an insufficient isolation boundary.

## Validation

Sprint 2 must pass adversarial application and direct-database isolation tests across human,
service, migration, background-worker, backup, and restore identities.
