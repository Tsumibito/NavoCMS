# NavoCMS

**The agent-native CMS. No admin panel. Your agent is the interface.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Project status](https://img.shields.io/badge/status-sprint_1_microkernel-orange.svg)](docs/roadmap/SPRINTS.md)

NavoCMS is an open-source, multisite content platform designed to be operated through ChatGPT,
Claude, Codex, or any compatible MCP client. It gives agents safe, typed operations for drafting,
reviewing, previewing, publishing, and operating websites without requiring a conventional CMS
administration panel.

Website: [navocms.com](https://navocms.com) · Repository:
[github.com/Tsumibito/NavoCMS](https://github.com/Tsumibito/NavoCMS)

> [!IMPORTANT]
> NavoCMS is in its microkernel implementation stage. It is not yet production software. The public
> schemas under `schemas/` are version `v0alpha1` and may change before the first release.

## What makes it different

- **Agent-first:** routine operations are goal-oriented MCP tools, not table CRUD in an admin UI.
- **UI-optional:** focused review widgets may improve diffs, previews, assets, and tables, but every
  core workflow remains usable by MCP clients without embedded UI support.
- **Plugin-oriented:** content, design, rendering, deployment, media, SEO, localization, forms,
  analytics, CRM, and email are replaceable capabilities around a small trusted kernel.
- **Safe publication:** consequential actions are policy-gated, auditable, idempotent, and bound to
  immutable release artifacts.
- **Multisite from the start:** a user can own many sites while each site has independent members,
  roles, providers, design, and governance.
- **Portable content:** prose is stored as Markdown; schemas, releases, design contracts, and assets
  can be exported without a proprietary editor format.

## Product model

Every site is pinned to four versioned anchors:

| Anchor | Controls |
|---|---|
| Content | Types, fields, relations, locales, validation, and revisions |
| Design | Tokens, components, recipes, responsive and accessibility rules |
| Delivery | Renderer, preview, deployment, routes, redirects, domains, and cache |
| Governance | Memberships, scopes, approvals, limits, retention, and rollback |

A release records exact versions and hashes for all four. An agent or plugin cannot silently change
an anchor while publishing content.

## Current status

Sprint 0 established the public product and safety contracts. Sprint 1 implements the TypeScript
microkernel and plugin graph:

- [Product requirements](docs/product/PRD.md)
- [Delivery roadmap](docs/roadmap/SPRINTS.md)
- [Architecture decisions](docs/architecture/README.md)
- [Plugin and platform specifications](docs/specs/README.md)
- [Threat model](docs/security/THREAT_MODEL.md)
- [Machine-readable schemas](schemas/README.md)

The intended implementation direction is a TypeScript trusted kernel with PostgreSQL and
language-neutral service plugins. Python remains a first-class option for SEO, translation,
analytics, and other independently deployed capabilities.

## Repository map

```text
.github/                 contribution and CI automation
docs/architecture/       accepted and proposed ADRs
docs/product/            product requirements and terminology
docs/roadmap/            milestones and sprint gates
docs/security/           threat model and security design
docs/specs/              human-readable platform contracts
examples/profiles/       contract fixtures for representative sites
schemas/                  machine-readable v0alpha1 JSON Schemas
scripts/                  deterministic repository checks
apps/                     transport applications; not the trusted kernel
packages/                 public contracts and trusted microkernel
plugins/                  independently deployable example/service plugins
```

## Contributing

NavoCMS welcomes early design discussion, specification review, security feedback, and future code
contributions. Start with [CONTRIBUTING.md](CONTRIBUTING.md), read [GOVERNANCE.md](GOVERNANCE.md),
and use GitHub Discussions or an issue before implementing a large architectural change.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Please do not report vulnerabilities in public issues; follow [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
