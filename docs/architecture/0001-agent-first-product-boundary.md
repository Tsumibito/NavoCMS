# ADR 0001 — Agent-first product boundary

**Status:** Accepted

**Date:** 2026-08-21

## Context

Conventional CMS products make an administration UI the primary interface. NavoCMS aims to let an
operator complete routine website outcomes through an authorized agent while retaining permissions,
revisions, preview, approval, audit, and rollback.

## Decision

The primary product surface is an OAuth-protected MCP server exposing goal-oriented operations.
Focused MCP Apps or protected web views may support visual preview, comparison, media selection,
tables, and confirmation. No essential workflow may require those views.

Code-level changes to components, templates, and providers remain repository development tasks.
NavoCMS does not give a content operator unrestricted code-editing authority.

## Consequences

- Tool semantics and safety are product design, not an API afterthought.
- Storage-level CRUD is insufficient as the public agent interface.
- The platform must support non-visual MCP clients.
- A large conventional admin panel is a non-goal, while small operator/recovery surfaces remain
  permissible.

## Alternatives considered

- **Traditional headless CMS plus generated MCP:** rejected because low-level CRUD exposes storage
  structure and fails to encode workflow intent and consequence.
- **Coding agent with repository/database credentials:** rejected for excessive routine authority.
- **Full chat application owned by NavoCMS:** deferred; compatible external agent clients are the
  initial distribution advantage.

## Validation

Sprint 5 must complete draft, diff, preview, and approval-request workflows in both a widget-capable
client and a client that renders structured text only.
