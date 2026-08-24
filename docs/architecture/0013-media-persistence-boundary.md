# ADR 0013 — Media persistence boundary

**Status:** Proposed

**Date:** 2026-08-24

## Context

Media finalization crosses an object-storage boundary and must then atomically persist an asset
state change, idempotency completion, Event Ledger entry, and transactional outbox entry. Splitting
the PostgreSQL repository into a separately published adapter before the workflow stabilizes would
duplicate public interfaces and weaken review of this security-critical sequence.

## Decision

`@navocms/media` owns provider-neutral media domain interfaces and the first-party
`PostgresMediaRepository`. The package may import only `@navocms/security`, the kernel event
interface, and `@navocms/persistence-postgres`; it may not import application, MCP, plugin,
transport, Cloudflare, or storage-provider code. The boundary checker enforces this allow-list.

The repository receives a provider-neutral `MediaStorage` interface. It validates the uploaded
object before starting a SQL mutation, performs content-addressed immutable object storage outside
the SQL transaction, then uses the existing PostgreSQL transaction, idempotency store, Event Store,
and outbox. A failed SQL transaction can therefore leave a safe content-addressed orphan; later GC
and reconciliation own that cleanup.

## Consequences

- The transactional media path is compact and reviews as one trust boundary.
- MCP remains a consumer of domain interfaces and never owns media persistence.
- R2/S3 and other providers remain adapters of `MediaStorage`, not runtime dependencies of the
  production profile.
- A future extracted `@navocms/media-postgres` adapter must preserve these interfaces and add an
  explicit migration ADR.

## Alternatives considered

- **Extract the adapter now:** deferred until a second persistence implementation justifies a new
  public package boundary.
- **Put SQL in MCP tools:** rejected because transport must not own authorization, transaction, or
  storage trust boundaries.
- **Put storage writes inside PostgreSQL:** rejected because object storage cannot participate in
  the database transaction.

## Validation

`pnpm check:boundaries` must reject unapproved workspace dependencies from `@navocms/media`.
PostgreSQL integration tests must prove RLS, idempotent replay and drift rejection, and complete
rollback of database-side state after Event Ledger/outbox failure.
