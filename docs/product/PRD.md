# Product requirements — NavoCMS

**Status:** Draft foundation contract

**Product:** NavoCMS

**Domain:** [navocms.com](https://navocms.com)

**Repository:** [Tsumibito/NavoCMS](https://github.com/Tsumibito/NavoCMS)

## 1. Product decision

Build an open-source, multisite content platform whose primary operator interface is an authorized
agent in ChatGPT, Claude, Codex, or another MCP client. A conventional CMS administration
application is not the primary product.

Focused visual surfaces may be returned through MCP Apps when preview, comparison, asset selection,
tables, or confirmation are materially better than prose. Essential workflows must still work in
clients that do not render those surfaces.

The platform consists of versioned capability plugins around a small trusted kernel. Content
models and design systems are versioned site contracts. Renderers, deployment targets, media,
localization, SEO, structured data, forms, analytics, CRM, and email are replaceable providers.

## 2. Problem

Operators of small and medium websites want to complete outcomes, not administer a CMS:

- review and publish an article received through chat or an API;
- change a price, contact, photograph, policy, or service description;
- create a commercial page that follows the site's visual language;
- translate, optimize, preview, approve, publish, and verify a release;
- inspect leads, analytics, failures, and improvement opportunities;
- understand why an automation made or proposed a change.

Traditional admin panels expose storage structure and make the operator manually coordinate media,
SEO, localization, preview, deployment, and verification. Generic coding agents can edit anything,
but have excessive authority for routine content operations. NavoCMS provides a bounded middle
layer: agent ergonomics with CMS-grade permissions, revisions, workflows, and auditability.

## 3. Product thesis

> Everything domain-specific is a plugin. Every consequential action is an event. Every public
> change is an immutable release. Every site is pinned to versioned content, design, delivery, and
> governance contracts.

NavoCMS is successful when routine website operation no longer requires a CMS admin panel, while
code-level changes remain deliberate development work in Codex or a normal repository workflow.

## 4. Site anchors

Each site is pinned to four versioned anchors:

1. **Content contract** — types, fields, relations, locale rules, indexes, and validation.
2. **Design contract** — tokens, components, variants, page recipes, responsive and accessibility
   rules.
3. **Delivery contract** — renderer, interaction model, preview, deployment, domains, redirects,
   cache behavior, and release verification.
4. **Governance contract** — memberships, scopes, consequence levels, approvals, budgets,
   retention, automation limits, and rollback rules.

A release records the exact version and integrity hash of every anchor. Content publication cannot
silently install a plugin, change a design system, or widen authority.

## 5. Principles

1. **Agent-first, UI-optional.** Core operations use typed, goal-oriented MCP tools.
2. **Small trusted kernel.** Identity, isolation, policy, event integrity, secrets, migrations,
   quotas, and release safety are not replaceable business plugins.
3. **Capabilities, not vendors.** Workflows request `site.publish` or `image.transform`, never a
   vendor-specific function.
4. **Profiles compose sites.** Profiles pin plugins, providers, policies, schemas, and configuration.
5. **Markdown is the conversational source.** Prose remains readable and editable by humans and
   agents; structured blocks use restricted schema-validated directives.
6. **Immutable revisions and releases.** Approval binds to the exact artifact that was previewed.
7. **Durable and observable work.** Tool calls, policy decisions, artifacts, effects, retries, and
   verification are reconstructable without storing secrets, unrestricted PII, or hidden reasoning.
8. **Plugins cannot expand authority.** Effective permission is the intersection of actor, tenant,
   site, profile, plugin, tool, workflow, and consequence policy.
9. **Fail closed on ambiguity.** Stale revisions, invalid schemas, missing providers, or unverifiable
   previews stop publication.
10. **Portable before convenient.** Public contracts prefer JSON Schema, CloudEvents, OAuth/MCP,
    SQL, Markdown, and object storage over one vendor.

## 6. Users and roles

| Role | Typical abilities |
|---|---|
| Account owner | Create tenants/sites, choose policy, delegate administration, export owned data |
| Site administrator | Configure allowed plugins, domains, design, workflows, integrations, and roles |
| Editor/marketer | Create content, translations, forms, and assets; generate previews |
| Publisher | Approve and publish an exact release; roll back a verified release |
| Analyst/lead operator | Read separately scoped analytics or lead projections |
| Service account | Perform declared site-bound capabilities under quotas and expiry |

A user may belong to many tenants and sites with different roles. Tenant membership does not grant
implicit access to every site. Publisher, lead, analytics, and plugin-administration permissions are
independent.

## 7. Trusted kernel

The kernel owns cross-cutting invariants only:

- tenants, sites, environments, identities, memberships, roles, and service accounts;
- plugin manifests, installations, profiles, compatibility, and configuration revisions;
- capability resolution and provider selection;
- append-only domain events, artifact integrity, idempotency, and projections;
- consequence classification, approvals, budgets, and kill switches;
- durable workflow interface and scheduling;
- secret references and scoped credential brokerage;
- ordered migrations, health, usage, quotas, and audit export;
- OAuth-protected MCP and stable domain API boundaries.

The kernel does not know what an article, yacht, booking, newsletter, or SEO title is. Those
semantics arrive through plugins and declarative content-type packs.

## 8. Plugin model

Every capability seam has three roles:

- **definition:** the versioned semantic interface;
- **provider:** an implementation of the interface;
- **consumer:** a tool, workflow, renderer, or plugin requesting it.

Plugin execution classes:

| Class | Intended use | Trust |
|---|---|---|
| Kernel extension | First-party definitions and repositories | Reviewed and shipped with kernel |
| Site module | First-party content, renderer, and interface modules | Activated only by profile release |
| Service plugin | SEO, translation, CRM, email, analytics, generation | Separate identity and network/data scopes |
| UI plugin | MCP Apps review projection | No direct database or secret access |
| Sandboxed transform | Future third-party pure transform | Deny-by-default host capabilities |

An agent may propose a plugin installation, but only an authorized configuration release activates
it. Runtime package installation by a model is prohibited.

## 9. Content model

Individual collections are declarative content-type definitions, not arbitrary executable plugins.
A coherent content pack may ship several definitions, relations, workflows, renderers, and tools.

Initial packs:

- Editorial: articles, authors, tags, and topics;
- Marketing: pages, offers, testimonials, FAQs, and navigation;
- Business identity: organizations, people, locations, contacts, and legal documents;
- Forms: form definitions, consent versions, and submissions;
- Catalogue: domain-specific entities such as products, yachts, or destinations.

Canonical prose is CommonMark/GFM-compatible Markdown plus restricted typed directives. The stored
revision contains source Markdown, source hash, parsed AST, parser/schema versions, actor, and
provenance references. AST and HTML are reproducible derived artifacts. Managed content excludes
arbitrary MDX, JavaScript, and unsafe HTML.

## 10. Design system

The design system is a mandatory site anchor and plugin family. It contains:

- DTCG-compatible primitive, semantic, component, and contextual tokens;
- typography, color, spacing, breakpoints, motion, and layering;
- component props, slots, variants, states, and accessibility requirements;
- layout primitives, section recipes, and page templates;
- asset roles, crops, focal points, responsive variants, and LCP policy;
- locale stress cases and content-density limits;
- scoped, versioned design overrides with reason and optional expiry.

Every design release generates a catalogue for typography, controls, cards, navigation, forms,
layouts, loading/error states, viewports, locales, motion, contrast, and asset crops. Visual,
accessibility, responsive, and performance gates run against that catalogue.

## 11. Delivery model

Renderer, interaction, preview, deployment, cache, and domain routing are separate capabilities.
Astro and Next.js are renderer providers; Alpine and HTMX are interaction providers; Cloudflare and
Vercel may provide preview or deployment. A renderer declares supported directives, components,
routing, media, and interaction capabilities. Unsupported requirements fail before build.

## 12. MCP product surface

The MCP surface is goal-oriented rather than table CRUD:

```text
sites.list                 content.search
content.get                content.createDraft
content.proposeChange      revision.compare
asset.ingest               asset.replace
workflow.start             workflow.status
preview.create             release.requestApproval
release.publish            release.rollback
design.openCatalogue       leads.list
analytics.summary
```

Tool discovery and the authenticated principal determine visible groups. Read, draft, approve,
publish, plugins, secrets, analytics, and leads use separate OAuth scopes.

Optional widgets provide Markdown review/editing, revision diffs, previews, release confirmation,
design catalogue, media crop/focal-point selection, drafts, workflows, analytics, and lead tables.

## 13. Publication workflow

```text
ingest content
→ validate schema and Markdown
→ create immutable draft revision
→ run source, rights, and editorial checks
→ resolve and optimize assets
→ localize and verify parity
→ propose SEO, links, and structured data
→ assemble immutable release candidate
→ build protected noindex preview
→ run design, accessibility, performance, and route gates
→ approve exact release hash
→ publish the identical artifact
→ verify routes, cache, sitemap, analytics, structured data, and forms
→ measure and schedule freshness work
```

## 14. Initial plugin catalogue

Required foundations:

- content schema, Markdown/AST, revision/release, design system;
- media/assets, localization, renderer, preview, deployment;
- MCP tools and optional MCP Apps UI;
- SEO foundation, semantic entity graph and JSON-LD;
- quality gates, import/export, backup and restore.

Acquisition and operations:

- forms, consent/privacy, PII-isolated leads, CRM adapters, transactional/marketing email;
- analytics, tag/consent bridge, search console, notifications, scheduler, and webhooks;
- performance/RUM, accessibility, visual regression, links/routes, CSP/security, uptime, and tracing.

Content intelligence:

- SEO intent, topic graph, internal links, translation QA, source/rights/fact checks;
- brand/style linting, media generation and selection, freshness, duplication/cannibalization;
- search indexing and related-content recommendations.

Future plugins:

- video/animation, experiments/personalization, comments/community;
- members, protected areas, entitlements, payments, subscriptions, commerce, and booking;
- plugin marketplace, signatures, trust levels, compatibility, and plugin billing.

## 15. Multitenancy and SaaS

Core hierarchy:

```text
identity
└── tenant memberships
    └── tenant
        ├── billing and plugin policy
        └── site memberships per site
```

Every site-owned row carries `tenant_id` and `site_id`. PostgreSQL Row-Level Security is defense in
depth; application authorization still derives scope from the authenticated principal. Application
and plugin roles cannot bypass RLS. Object storage, secrets, service accounts, events, quotas, and
exports are site-scoped.

Tenants may use a hosted model account or bring a provider key. Secret values are brokered to only
the selected plugin and never appear in ordinary configuration, events, logs, MCP output, or export.

The open-source core must remain self-hostable. Hosted NavoCMS may add managed infrastructure,
billing, support, and operations without making portable export dependent on the hosted service.

## 16. Consequence levels

| Level | Meaning | Examples | Default gate |
|---|---|---|---|
| G0 | Read-only | Content or aggregate analytics read | Authenticated scope and quota |
| G1 | Internal reversible | Draft, proposal, preview, transform | Allowlist and idempotency |
| G2 | Public reversible | Publish content or metadata | Exact preview hash and approval initially |
| G3 | External commitment | Email, CRM sequence, access change | Fresh evidence and named policy/approval |
| G4 | Financial, legal, destructive | Charge, refund, delete, permanent URL mutation | Dedicated workflow; disabled by default |

Automatic approval is introduced only for narrow actions with production evidence, independent
evaluation, bounded volume, cooldown, and rollback.

## 17. Portability

An owner can export a complete site bundle: profile, plugin manifests, content types, Markdown
revisions, releases, design contracts, assets or asset manifest, routes, redirects, locales,
navigation, semantic entities, and a redacted audit export. Secrets and PII require separately
authorized encrypted domain exports.

## 18. Non-goals for the first production release

- full visual no-code page builder;
- arbitrary agent-supplied CSS, JavaScript, MDX, or runtime packages;
- public plugin marketplace;
- payments, bookings, comments, or member areas;
- universal CRM or marketing automation suite;
- replacing coding agents for component and renderer development;
- automatic publication of new legal or commercial claims without policy approval;
- reproducing every feature of an incumbent CMS before the first migration.

## 19. Success metrics

- 90% of routine content operations complete without a CMS admin panel;
- median supplied article to verified preview under 10 minutes excluding human review;
- median approved text/image change to verified live state under 5 minutes;
- one operator manages at least 10 sites without cross-site permission mistakes;
- every public change links actor, preview, decision, release, and live verification;
- zero unknown production mutations, cross-site exposures, or stale-hash publications;
- all G2 releases are rollback-capable;
- three pilot sites share the same kernel and contracts without application forks;
- a Python service plugin works without importing the TypeScript kernel;
- full export and clean restore pass before a stable release.

## 20. Foundation decisions and open experiments

Accepted direction:

- TypeScript trusted kernel and SDK;
- PostgreSQL for durable relational state and tenant isolation;
- Markdown plus typed AST/directives for prose;
- JSON Schema for public contracts;
- CloudEvents-compatible integration envelope;
- Astro and Cloudflare as first providers, not permanent kernel dependencies;
- service plugins remain language-neutral.

Experiments required before locking implementation:

- durable workflow provider: DBOS, Restate, or a small Postgres-backed worker;
- in-process plugin encapsulation and unload semantics;
- stable Markdown AST node identity and safe structural patches;
- RLS behavior across application, service, migration, backup, and restore roles;
- protected preview portability across hosts;
- design component capability negotiation across renderers.
