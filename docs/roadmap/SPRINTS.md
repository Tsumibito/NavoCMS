# Delivery roadmap

**Planning unit:** two-week sprint

**Capacity baseline:** one primary engineer using agent-assisted development, with product review
and access to representative production sites

This roadmap is gated by verified outcomes, not dates. A sprint number describes dependency order;
parallel work may reduce calendar time but cannot remove a gate.

## Program gates

| Gate | Outcome |
|---|---|
| P0 — Contracts | Product, trust, plugin, content, design, event, and threat contracts approved |
| P1 — Kernel | A profile boots from a validated plugin graph with a complete trajectory |
| P2 — Isolation | Cross-tenant/site access is denied by application policy and PostgreSQL RLS |
| P3 — Content | Markdown types, revisions, relations, patches, and portable export are stable |
| P4 — Agent editing | MCP clients can inspect, draft, patch, diff, and preview safely |
| P5 — Design/media | A release is design-valid and has verified responsive assets |
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

**Status:** Completed and accepted in [PR #4](https://github.com/Tsumibito/NavoCMS/pull/4).

- workspace boundaries for kernel, SDK, first-party plugins, and examples;
- Fastify service shell and stable domain API boundary;
- manifest/config validation, capability registry, dependency DAG, profiles, and health gates;
- append-only Event Ledger and trajectory projections;
- CloudEvents-compatible external events and OpenTelemetry correlation;
- one external no-op service plugin and unload/failure tests.

Gate: P1.

## Sprint 2 — Multitenancy, identity, RLS, secrets, and quotas

**Status:** Implemented in [PR #5](https://github.com/Tsumibito/NavoCMS/pull/5); P2 closes on merge.

- tenants, sites, environments, memberships, roles, service accounts, OAuth/OIDC, and MCP OAuth;
- PostgreSQL RLS, separate migration identity, site-scoped storage, secret broker, usage, quotas,
  kill switches, and adversarial isolation tests.

Gate: P2.

## Sprint 3 — Content schemas, Markdown AST, and revisions

- declarative types and packs, revisions, relations, variants, stable AST patches, conflict handling,
  import/export, and representative legacy-editor conversion.

Gate: P3.

## Sprint 4 — Design-system contract and catalogue

- DTCG tokens, component/variant/recipe schemas, overrides, Astro adapter, generated catalogue,
  responsive fixtures, visual regression, and accessibility checks.

## Sprint 5 — Agent/MCP editing product

- goal-oriented MCP tools and resources, scoped discovery, Markdown/diff/draft/workflow widgets,
  non-UI fallbacks, bounded outputs, redaction, and agent evaluations.

Gate: P4.

## Sprint 6 — Media and asset pipeline

- immutable originals, provenance, safe upload/remote ingest, isolated decode, object storage,
  AVIF/WebP/JPEG presets, crops, focal points, responsive variants, and asset review UI.

Gate: P5 with Sprint 4.

## Sprint 7 — Durable workflow, preview, release, and rollback

- workflow provider abstraction, checkpointed editorial flow, protected noindex preview, exact-hash
  approval, idempotent publication, verification, reconciliation, and tested rollback.

Gate: P6.

## Sprint 8 — Astro/Cloudflare provider and first-site shadow migration

- Astro renderer, Cloudflare preview/deploy/cache providers, legacy import, route and content parity,
  shadow builds, delta reconciliation, and verified fallback.

## Sprint 9 — SEO, structured data, and localization

- semantic entity graph and JSON-LD, metadata/canonical/sitemap/hreflang, translation state, SEO
  service plugins, intent, links, freshness, duplication, evidence, and indexability gates.

## Sprint 10 — Forms, leads, consent, CRM, email, and analytics

- declarative responsive forms, typed triggers, consent receipts, anti-abuse, PII-isolated leads,
  provider-neutral analytics, email and CRM capabilities, scoped MCP tables, and delivery events.

## Sprint 11 — Quality, observability, backup, and operations

- performance/RUM, accessibility, visual/route/security gates, synthetics, SLOs, alerts, backup,
  clean restore, retention/deletion, cost attribution, and security review.

## Sprint 12 — First-site cutover

- parity lock, incremental import, new content authority, old CMS read-only/retirement, full release
  gates, rollback rehearsal, runbooks, and observation window.

Gate: P7.

## Sprint 13 — Three-site pilot and SDK hardening

- two more sites, distinct memberships and profiles, meaningful provider swap, SDK/templates,
  contract tests, Python example plugin, onboarding, cloning, export/import, staged upgrades.

Gate: P8.

## Sprint 14 — Open-source v0.1

- bootstrap CLI, install/deploy guides, examples, API/MCP docs, plugin author kit, SBOM, signed
  release artifacts, upgrade and restore tests, and explicit hosted/core separation.

Gate: P9.

## Sprint 15 — Limited hosted beta

- onboarding, invitations, account recovery, billing, quotas, platform models and BYOK, abuse/spend
  controls, support audit, offboarding, deletion, incident/backup/key runbooks, and bounded beta
  provider support.

Gate: P10.

## Milestones

| Outcome | Sprint |
|---|---:|
| Contracts accepted | 0 |
| Multi-tenant plugin kernel | 2 |
| Agent-readable content engine | 3 |
| Usable ChatGPT/Claude draft and diff flow | 5 |
| Exact-hash publish and rollback | 7 |
| First real site without its old CMS | 12 |
| Three-site reusable pilot | 13 |
| Open-source v0.1 | 14 |
| Limited hosted beta | 15 |

## Scope control

The following do not enter Sprints 0–13 unless required by a pilot site:

- payments, gated areas, courses, comments, booking, or marketplace;
- full visual page builder or arbitrary agent-authored CSS/JavaScript;
- runtime plugin installation;
- public third-party plugin execution before a sandbox/trust model is proven;
- multiple production providers per integration before the capability contract is proven;
- personalization/A/B testing beyond its contract and a no-op provider.

Any addition must state which milestone moves or which existing deliverable is removed.
