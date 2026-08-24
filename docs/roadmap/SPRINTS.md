# Delivery roadmap

**Planning unit:** two-week sprint

**Capacity baseline:** one primary engineer using agent-assisted development, with product review
and access to representative production sites

This roadmap is gated by verified outcomes, not dates. A sprint number describes dependency order;
parallel work may reduce calendar time but cannot remove a gate.

Acceptance has three separate states:

1. **Merged** — the reviewed implementation is present on `main`.
2. **Code gate closed** — repository checks and adversarial tests prove the declared invariants.
3. **Operational gate closed** — the same artifact and workflow pass in staging or production-like
   infrastructure with retained evidence.

A merged pull request does not close an operational gate by itself. The 2026-08-24 acceptance audit
keeps the Sprint 0 contracts accepted, preserves the merged Sprint 1–7 work, and moves the remaining
cross-cutting and operational proof into mandatory Sprint 7.1 before a real delivery provider is
allowed to publish.

## Program gates

| Gate | Outcome |
|---|---|
| P0 — Contracts | Product, trust, plugin, content, design, event, and threat contracts approved |
| P1 — Kernel | A profile boots from a validated plugin graph with a complete trajectory |
| P2 — Isolation | Cross-tenant/site access is denied by application policy and PostgreSQL RLS |
| P3 — Content | Markdown types, revisions, relations, patches, and portable export are stable |
| P4 — Agent editing | MCP clients can inspect, draft, patch, diff, and preview safely |
| P5 — Design/media | A release is design-valid and has verified responsive assets |
| P6A — Release protocol | Exact-hash approval, retry, reconciliation, verification, and rollback work with a non-public proving provider |
| P6 — Publication | The exact approved preview publishes, verifies, and rolls back |
| P7 — First migration | A real site reaches route/content/SEO/consent parity and retires its old CMS |
| P8 — Multisite pilot | Three sites run without code forks and with distinct memberships/profiles |
| P9 — OSS v0.1 | Clean install, SDK, examples, export/restore, security, and release artifacts work |
| P10 — Hosted beta | Billing, quotas, abuse controls, support, and operations are responsible |

## Sprint 0 — Foundation contracts

**Status:** Completed and accepted in [PR #1](https://github.com/Tsumibito/NavoCMS/pull/1).

Goal: make the project implementable without hiding product or security decisions in code.

Deliverables:

- public project identity, README, Apache-2.0 license, governance, contribution, conduct, and
  security reporting;
- product requirements and scope boundaries;
- ADR process and decisions for product boundary, technology strategy, plugin capabilities,
  content model, multitenancy, and immutable releases;
- versioned plugin manifest, site profile, content type, event envelope, and consequence contracts;
- machine-readable JSON Schemas and representative blog, multilingual-business, and catalogue site
  fixtures;
- trusted-kernel boundary and plugin lifecycle;
- threat model covering supply chain, prompt injection, cross-site access, preview leakage, stale
  approvals, SSRF/media bombs, PII, secrets, webhooks, and rollback;
- CI validation for documentation, schemas, and examples;
- explicit experiments and deferred decisions for Sprint 1.

Verification:

- three example profiles resolve conceptually without site-specific kernel forks;
- every example validates against the published schemas;
- every planned effect maps to a consequence level and rollback/compensation rule;
- every kernel responsibility has a named trust reason;
- local and GitHub checks pass from a clean checkout;
- unresolved implementation choices are visible experiments, not accidental commitments.

Gate: P0 closed.

## Sprint 1 — TypeScript microkernel and plugin graph

**Status:** Implementation merged in [PR #4](https://github.com/Tsumibito/NavoCMS/pull/4).
The isolated kernel tests are accepted; runtime profile boot and atomic trajectory evidence are
re-opened for Sprint 7.1 before a real publication provider is activated.

- workspace boundaries for kernel, SDK, first-party plugins, and examples;
- Fastify service shell and stable domain API boundary;
- manifest/config validation, capability registry, dependency DAG, profiles, and health gates;
- append-only Event Ledger and trajectory projections;
- CloudEvents-compatible external events and OpenTelemetry correlation;
- one external no-op service plugin and unload/failure tests.

Gate: P1 closes operationally in Sprint 7.1.

## Sprint 2 — Multitenancy, identity, RLS, secrets, and quotas

**Status:** Core isolation implementation merged in
[PR #5](https://github.com/Tsumibito/NavoCMS/pull/5). Existing RLS tests are accepted; release-table
RLS, persistent quota/kill-switch enforcement, and production-path integration remain in Sprint 7.1.

- tenants, sites, environments, memberships, roles, service accounts, OAuth/OIDC, and MCP OAuth;
- PostgreSQL RLS, separate migration identity, site-scoped storage, secret broker, usage, quotas,
  kill switches, and adversarial isolation tests.

Gate: P2 closes across the complete current schema in Sprint 7.1.

## Sprint 3 — Content schemas, Markdown AST, and revisions

**Status:** Content engine implementation merged in
[PR #6](https://github.com/Tsumibito/NavoCMS/pull/6). Portable content and immutable revisions are
accepted; bounded diff complexity and PostgreSQL metadata/source consistency are hardened in Sprint
7.1.

- declarative types and packs, revisions, relations, variants, stable AST patches, conflict handling,
  import/export, and representative legacy-editor conversion.

Gate: P3 closes after the Sprint 7.1 content hardening checks.

## Sprint 4 — Design-system contract and catalogue

**Status:** Completed and accepted in [PR #9](https://github.com/Tsumibito/NavoCMS/pull/9).

- DTCG tokens, component/variant/recipe schemas, overrides, Astro adapter, generated catalogue,
  responsive fixtures, visual regression, and accessibility checks.

The component-level implementation is accepted. P5 remains open until Sprint 8 binds the compiled
design digest and verified media artifacts into a real release.

## Sprint 5 — Agent/MCP editing product

**Status:** MCP implementation merged in [PR #11](https://github.com/Tsumibito/NavoCMS/pull/11).
The editing flow is code-complete; permission-scoped tool discovery, meaningful agent evaluations,
and an authenticated staging client proof remain in Sprint 7.1.

- goal-oriented MCP tools and resources, scoped discovery, Markdown/diff/draft/workflow widgets,
  non-UI fallbacks, bounded outputs, redaction, and agent evaluations.

Gate: P4 closes operationally in Sprint 7.1.

## Sprint 6 — Production runtime and deployment foundation

**Status:** Runtime implementation merged in [PR #13](https://github.com/Tsumibito/NavoCMS/pull/13)
and staging is deployed. Health and readiness are live; forced-RLS/current-migration readiness,
restart persistence, and retained same-artifact evidence remain in Sprint 7.1.

- Neon production/staging topology with scale-to-zero, direct migration and pooled runtime
  identities, durable MCP persistence, event ledger and idempotency, Docker image, health/readiness,
  and matching applications on an operator-managed Coolify Docker host.

Operational gate: Sprint 7.1 must prove migrations, forced RLS, restart persistence, and the same
container artifact that production will run.

## Sprint 7 — Durable workflow, preview, release, and rollback

**Status:** Release-protocol implementation merged in
[PR #15](https://github.com/Tsumibito/NavoCMS/pull/15). P6A is code-complete with the embedded proving
provider. It is not evidence of an Astro or Cloudflare publication and does not close P6.

- workflow provider abstraction, checkpointed editorial flow, protected noindex preview, exact-hash
  approval, idempotent publication, verification, reconciliation, and tested rollback.

Gate: P6A. P6 closes with the real staging vertical in Sprint 8.

## Sprint 7.1 — Acceptance hardening and authenticated staging proof

**Entry rule:** mandatory before Sprint 8 can activate an external media or deployment provider.

- make domain-event persistence atomic with the state change through a transactional outbox or an
  equivalent single-transaction design;
- preserve one correlation/causation trajectory across draft, preview, approval, publication,
  reconciliation, verification, and rollback;
- align event idempotency identity with operation identity and classify public publication as G2;
- require a human publisher for approval, and persist approval policy version, evidence, expiry,
  revocation, actor, scope, and exact release hash;
- boot the production MCP runtime from a pinned, validated site profile and plugin graph;
- enforce persistent quotas and kill switches on the production-path tool pipeline;
- make migration application and registry recording atomic and make readiness verify current
  checksums, runtime `NOBYPASSRLS`, forced RLS, and the deployment-bound site/environment;
- add release-workflow RLS tests for migration 0004 and run the PostgreSQL persistence suite in CI;
- replace the quadratic unbounded diff path and verify adversarial large-document bounds;
- keep persisted Markdown metadata consistent after structural patches;
- expose only permission-appropriate MCP tools and replace routing assertions with executable
  authorized/unauthorized agent evaluations;
- complete Claude re-auth against the `NavoCMS` organization and retain one authenticated staging
  `draft -> preview -> approve -> publish -> reconcile/status` trajectory;
- restart the staging container and prove content, events, approvals, checkpoints, idempotent results,
  and RLS isolation survive unchanged.

Exit gate: P1, P2, P3, and P4 operational evidence is current; Sprint 6 staging gate is closed; no
P0/P1 security finding remains open; production stays private and the embedded provider remains the
only publication provider.

## Sprint 8 — Media pipeline and first Astro publication vertical

### Sprint 8A — Media trust boundary

- immutable originals, provenance and rights, hashes, deduplication, references, retention, and
  recoverable garbage reconciliation;
- site-prefixed R2/S3 storage, signed direct upload, safe remote ingest, redirect/DNS/private-network
  SSRF controls, MIME sniffing, byte/pixel/frame limits, SVG policy, and isolated decoding;
- deterministic AVIF/WebP/JPEG presets, responsive widths, crops, focal points, OG/LCP variants,
  metadata stripping, and an asset review widget;
- media RLS/storage isolation, malformed input, decompression bomb, retry, and orphan tests.

### Sprint 8B — Astro and Cloudflare delivery providers

- a renderer capability that consumes versioned content, design, route, locale, and asset contracts;
- a real Astro artifact rather than the embedded Markdown proof page;
- release manifests bound to actual content, design, delivery, and governance digests;
- idempotent Cloudflare preview/deploy/cache providers with immutable artifact references, live hash
  verification, cache checks, reconciliation, and rollback;
- preservation of required Zaraz loader, consent bridge, analytics bootstrap, immutable URLs, and
  route-parity contracts for the first Navi vertical.

### Sprint 8C — First real staging publication

- publish one human-authored page or article with real responsive media to an isolated staging Astro
  route through authenticated MCP approval;
- verify the live route, media variants, release hash, noindex/indexability policy, cache behavior,
  accessibility, and analytics/consent bootstrap;
- rehearse provider interruption, idempotent retry, container restart, and rollback to the previous
  verified artifact;
- establish the pre-publication operations floor: structured release alerts, encrypted backup,
  isolated restore proof, owner, RPO/RTO target, and rollback runbook.

Gate: P5 and P6. Production remains unexposed until its domain, OAuth resource, operational gates,
and explicit launch approval exist.

## Sprint 9 — Webstudio importer and first-site shadow migration

- freeze the route, locale, metadata, canonical, redirect, and structured-data import contracts
  needed by the first site before bulk conversion;
- retain immutable raw Webstudio source artifacts and deterministic versioned transformations;
- Webstudio extraction/conversion, legacy import, media mapping, unsupported-component quarantine,
  route/content/locale/SEO parity, shadow builds, resumable delta reconciliation, domain inventory,
  and verified fallback;
- fail closed on changed legacy URLs, missing locale variants, lossy transforms, or unverifiable
  external assets.

## Sprint 10 — SEO, structured data, and localization

- implement the import contracts frozen in Sprint 9 as versioned platform capabilities;
- semantic entity graph and validated JSON-LD, metadata/canonical/sitemap/hreflang, locale fallback,
  translation state, immutable public slugs, redirects, and indexability gates;
- SEO service plugins for intent, internal links, freshness, duplication, evidence, proposals, and
  post-publication verification;
- route-parity and multilingual fixtures become release-blocking tests.

## Sprint 11A — Forms, consent, and PII-isolated leads

- declarative responsive forms, accessible states, typed triggers, versioned consent receipts,
  anti-abuse/replay controls, retention/deletion, PII-isolated lead storage, opaque event references,
  and separately scoped MCP projections;
- verify that content publishers cannot read leads without an independent permission.

## Sprint 11B — CRM, email, and analytics providers

- provider-neutral analytics, email, and CRM capabilities with scoped credentials;
- immutable message previews, recipient and locale checks, webhook authenticity, delivery events,
  retries, suppression, reconciliation, attribution, and provider-outage behavior;
- customer contact and CRM enrollment remain individually approved G3 effects until production
  evidence authorizes a narrower policy.

## Sprint 12 — Quality, observability, backup, and operations

- expand the Sprint 8 operations floor into performance/RUM, accessibility, visual/route/security
  gates, synthetics, SLOs, alert delivery, capacity and cold-start monitoring;
- automated encrypted backup, clean isolated restore, migration/checksum and ledger-integrity
  verification, retention/deletion, key rotation, incident drills, and cost attribution;
- complete a focused external security review or an explicitly scoped independent review before the
  first-site cutover.

## Sprint 13 — First-site cutover

- parity lock, incremental import, new content authority, old CMS read-only/retirement, full release
  gates, DNS/domain readiness, rollback rehearsal against measured RTO/RPO, runbooks, ownership,
  observation window, and an explicit go/no-go record.

Gate: P7.

## Sprint 14 — Three-site pilot and SDK hardening

- two more sites, distinct memberships and profiles, meaningful provider swap, SDK/templates,
  contract tests, Python example plugin, onboarding, cloning, export/import, staged upgrades, and
  proof that all three sites run without code forks or cross-site operational access.

Gate: P8.

## Sprint 15 — Open-source v0.1

- bootstrap CLI, install/deploy guides, examples, API/MCP docs, plugin author kit, SBOM, signed
  release artifacts, dependency/license provenance, clean-room install, upgrade and restore tests,
  and explicit hosted/core separation.

Gate: P9.

## Sprint 16 — Limited hosted beta

- dynamic tenant/site resource routing without trusting caller-supplied scope, onboarding,
  invitations, account recovery, billing, persistent quotas, platform models and BYOK, abuse/spend
  controls, support audit, offboarding, deletion, incident/backup/key runbooks, and bounded beta
  provider support;
- entry requires closed external-security findings, successful multi-site restore, tested tenant
  deletion/export, and an explicitly bounded beta cohort.

Gate: P10.

## Milestones

| Outcome | Sprint |
|---|---:|
| Contracts accepted | 0 |
| Multi-tenant plugin kernel | 2 |
| Agent-readable content engine | 3 |
| Usable ChatGPT/Claude draft and diff flow | 5 |
| Exact-hash release protocol | 7 |
| Authenticated staging acceptance | 7.1 |
| First real Astro/Cloudflare publication and rollback | 8 |
| Staging control plane on Neon and Coolify | 6–7.1 |
| First real site without its old CMS | 13 |
| Three-site reusable pilot | 14 |
| Open-source v0.1 | 15 |
| Limited hosted beta | 16 |

## Scope control

The following do not enter Sprints 0–14 unless required by a pilot site:

- payments, gated areas, courses, comments, booking, or marketplace;
- full visual page builder or arbitrary agent-authored CSS/JavaScript;
- runtime plugin installation;
- public third-party plugin execution before a sandbox/trust model is proven;
- multiple production providers per integration before the capability contract is proven;
- personalization/A/B testing beyond its contract and a no-op provider.

Any addition must state which milestone moves or which existing deliverable is removed.
