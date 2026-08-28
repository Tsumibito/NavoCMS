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
| [0007](0007-microkernel-package-boundaries.md) | Accepted | Enforced contracts, kernel, API, and service-plugin package boundaries |
| [0008](0008-identity-and-isolation-boundary.md) | Accepted | OAuth identity, intersected authority, RLS, and secret boundaries |
| [0009](0009-versioned-design-contracts.md) | Accepted | Portable design contracts, bounded overrides, and renderer adapters |
| [0010](0010-decoupled-mcp-editing-surface.md) | Accepted | OAuth-scoped tools with decoupled MCP Apps review surfaces |
| [0011](0011-production-environment-topology.md) | Accepted | Persistent staging, scale-to-zero Neon branches, and separate release previews |
| [0012](0012-provider-neutral-mcp-oauth.md) | Accepted | Provider-neutral MCP OAuth with deployment-bound tenant/site membership |
| [0013](0013-media-persistence-boundary.md) | Accepted | Media domain facade with a constrained PostgreSQL transactional adapter |
| [0016](0016-astro-renderer-artifact-boundary.md) | Proposed | Deterministic Astro source artifact and delivery-layout boundary |
| [0017](0017-cloudflare-preview-delivery-provider.md) | Proposed | Immutable Cloudflare preview and exact-commit Coolify delivery boundary |
| [0018](0018-trusted-astro-builder-registration.md) | Superseded | Trusted internal Astro build and durable reviewed-artifact registration |
| [0019](0019-staging-astro-release-input-and-image-attestation.md) | Proposed | Preview-bound staging Astro input and image-attested build runner |
| [0022](0022-reviewed-astro-object-storage.md) | Proposed | Immutable object storage for reviewed Astro source and output |

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
