# Architecture decision records

NavoCMS uses Architecture Decision Records (ADRs) for decisions that constrain public contracts,
trust boundaries, persistence, security, compatibility, or major dependencies.

| ADR | Status | Decision |
|---|---|---|
| [0001](0001-agent-first-product-boundary.md) | Accepted | Agent-first product with optional focused UI |
| [0002](0002-typescript-kernel-language-neutral-plugins.md) | Accepted | TypeScript kernel and language-neutral service plugins |
| [0003](0003-capability-plugin-model.md) | Accepted | Capability-based plugin graph around a trusted kernel |
| [0004](0004-markdown-content-model.md) | Accepted | Markdown source with typed directives and immutable revisions |
| [0005](0005-multitenancy-from-foundation.md) | Accepted | Tenant and site isolation from the first implementation |
| [0006](0006-immutable-previewed-releases.md) | Accepted | Approval and publication bind to immutable release hashes |
| [0007](0007-microkernel-package-boundaries.md) | Proposed | Enforced contracts, kernel, API, and service-plugin package boundaries |
| [0008](0008-identity-and-isolation-boundary.md) | Proposed | OAuth identity, intersected authority, RLS, and secret boundaries |

The [research reference map](REFERENCES.md) records the external projects and standards that inform
these decisions without making them undeclared runtime dependencies.

## Statuses

- **Proposed:** open for maintainer acceptance or revision.
- **Accepted:** governs implementation.
- **Superseded:** replaced by a newer ADR but retained as history.
- **Rejected:** considered and intentionally not adopted.

## Creating an ADR

Copy the structure below into the next numbered file:

```text
# ADR NNNN — Title

Status · Date · Owners

## Context
## Decision
## Consequences
## Alternatives considered
## Validation
```

Merging a Proposed ADR into the default branch changes its status to Accepted unless the pull
request explicitly preserves Proposed status for a time-bounded experiment.
