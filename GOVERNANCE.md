# Governance

NavoCMS currently uses a maintainer-led governance model suitable for its foundation stage.

## Roles

- **Users** operate or evaluate NavoCMS and provide product feedback.
- **Contributors** propose documentation, specifications, tests, code, or design changes.
- **Maintainers** review contributions, manage releases, security, roadmap, and repository settings.

The initial maintainer is the repository owner. Additional maintainers may be added after sustained,
constructive contributions and demonstrated judgment around security and compatibility.

## Decision process

- Routine changes are decided through pull-request review.
- Public contracts, trust boundaries, persistence, authorization, and governance changes require an
  ADR with alternatives and consequences.
- Maintainers seek rough consensus but retain responsibility for coherent product direction and
  safe releases.
- Unresolved decisions are documented as proposed ADRs or roadmap questions rather than hidden in
  implementation code.

## Releases

Before the first stable release, versions may be experimental and explicitly marked alpha. A stable
release requires documented compatibility, migration, security response, support, and deprecation
policies.

## Commercial services

The open-source core and its public specifications remain usable without the future hosted service.
Hosted NavoCMS may provide managed infrastructure, operations, billing, or proprietary convenience
services, but site export and self-hosting cannot depend on those services.
