# Contributing to NavoCMS

NavoCMS is currently contract-first. Early contributions should improve product boundaries,
specifications, schemas, security, and small vertical experiments rather than build an unreviewed
full CMS implementation.

## Before starting

1. Read the [PRD](docs/product/PRD.md), [architecture decisions](docs/architecture/README.md), and
   [threat model](docs/security/THREAT_MODEL.md).
2. Search existing issues and discussions.
3. Open a proposal issue before changing a public contract, trusted-kernel boundary, storage model,
   plugin trust model, or authentication design.
4. Keep provider-specific behavior behind a capability contract.

## Local checks

Requirements: Node.js 22 or newer and Corepack.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

## Pull requests

- Use a focused branch and explain the user-visible or contract-level outcome.
- Link an issue or ADR when the change affects architecture.
- Add tests or fixtures for every changed machine-readable contract.
- State security, tenancy, migration, compatibility, and rollback impact.
- Do not combine formatting sweeps with semantic changes.
- A maintainer may ask for an experiment before accepting a new abstraction.

## Contract versioning

Schemas begin at `navocms.io/v0alpha1`. During the alpha period, breaking changes are allowed only
with an explicit compatibility note and updated examples. Once a schema is released as stable, its
meaning is immutable; incompatible changes use a new API version.

## Developer Certificate of Origin

By contributing, you certify that you have the right to submit the work under the project's
Apache-2.0 license. Add a sign-off to commits when requested:

```text
Signed-off-by: Your Name <your-email@example.com>
```

## Conduct and security

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report vulnerabilities using
the private process in [SECURITY.md](SECURITY.md), never a public issue.
