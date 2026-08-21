# ADR 0002 — TypeScript kernel and language-neutral service plugins

**Status:** Proposed

**Date:** 2026-08-21

## Context

The kernel must serve MCP, validate JSON Schema contracts, compose plugins, integrate with web
renderers, and expose an SDK. SEO, translation, data science, and existing automation commonly use
Python and should not be rewritten merely to join the platform.

## Decision

Implement the trusted kernel, first-party SDK, in-process modules, and MCP boundary in TypeScript.
Use PostgreSQL for durable relational state. Keep service plugins language-neutral over versioned
HTTP/MCP/event contracts; publish at least one Python example plugin.

Astro and Cloudflare are the first renderer/deployment providers, not kernel dependencies.

The durable workflow provider remains an experiment for Sprint 1. DBOS, Restate, and a small
Postgres-backed worker must be evaluated against replay, signal/approval, idempotency, operations,
and portability requirements.

## Consequences

- One type/schema ecosystem spans MCP, JSON contracts, design tools, and web renderers.
- Python capabilities stay isolated and independently deployable.
- Cross-process contracts need compatibility tests and bounded data projections.
- The kernel must not import provider or site-specific packages through reverse dependencies.

## Alternatives considered

- **Python/FastAPI for everything:** viable but weaker alignment with renderer/design/MCP tooling and
  does not eliminate the need for language-neutral plugins.
- **TypeScript for every plugin:** rejected because it would force unnecessary rewrites.
- **Rust kernel:** attractive for sandbox/runtime work but premature for the initial product team.

## Validation

Sprint 1 must run an external service plugin without importing kernel code. Sprint 13 must ship a
Python example that passes the same contract suite as a TypeScript provider.
