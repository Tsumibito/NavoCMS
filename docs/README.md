# NavoCMS documentation

This directory is the authoritative human-readable source for NavoCMS product and platform
contracts.

| Area | Purpose |
|---|---|
| [Product](product/PRD.md) | Users, outcomes, scope, constraints, and success metrics |
| [Project identity](product/BRAND.md) | Name, domain, tagline, namespace, and positioning |
| [Architecture](architecture/README.md) | Decision records and trusted boundaries |
| [Specifications](specs/README.md) | Versioned plugin, profile, content, event, and policy contracts |
| [Security](security/THREAT_MODEL.md) | Assets, threats, controls, and open security work |
| [Secrets](security/SECRETS.md) | Public-core, private-deployment, dotenvx, and rotation policy |
| [Roadmap](roadmap/SPRINTS.md) | Sequenced delivery gates and scope control |
| [Development](development/README.md) | Workspace boundaries, local commands, and safety warnings |

Machine-readable counterparts live under [`schemas/`](../schemas/README.md). If prose and schema
disagree, the discrepancy blocks release of that contract until both are reconciled.
