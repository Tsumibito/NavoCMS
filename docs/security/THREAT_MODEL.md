# Threat model

**Status:** Foundation baseline; revisit at every program gate

## Assets

- tenant/site content, drafts, revisions, releases, routes, and domains;
- identities, memberships, approvals, service accounts, and audit evidence;
- secrets, model/provider keys, deployment credentials, webhook keys, and signing material;
- private previews, unpublished commercial/legal claims, and source documents;
- lead/customer PII and consent records;
- media originals, provenance/rights, and generated artifacts;
- availability, billing/usage integrity, and open-source supply chain.

## Trust boundaries

1. Human or agent client to OAuth-protected MCP resource server.
2. MCP/API boundary to trusted kernel and PostgreSQL.
3. Kernel to in-process first-party modules.
4. Kernel to independently authenticated service plugins.
5. Kernel to object storage, workflow, model, renderer, and deployment providers.
6. Public/inbound forms and webhooks to PII-aware ingestion services.
7. Optional MCP Apps iframe to MCP tools; the iframe has no direct database or secret access.

## Primary threats and controls

| Threat | Baseline controls | Verification gate |
|---|---|---|
| Cross-tenant/site access | Application policy, RLS, site-scoped IDs/storage/secrets, adversarial tests | P2 |
| Confused deputy/plugin authority expansion | Capability intersection, plugin identity, scoped data/network permissions | P1/P2 |
| Prompt injection from content or tools | Treat content as untrusted data, goal tools, bounded outputs, consequence gates | P4 |
| Stale or swapped approval | Immutable release hash, exact preview artifact, approval expiry | P6 |
| Duplicate external effect | Idempotency keys, event/effect ledger, deterministic retry | P1/P6 |
| Plugin supply-chain compromise | No runtime install, source/signature policy, lockfiles, SBOM, trust classes | P1/P9 |
| Secret leakage | Secret references, brokered credentials, redaction, log/event/export rejection | P2 |
| PII leakage | Isolated schema/roles, opaque references, scoped projections, retention/deletion | P2/P10 |
| Preview discovery/indexing | Authenticated or signed access, noindex, expiry, unguessable release reference | P6 |
| SSRF and media bombs | URL allow/deny policy, isolated fetch/decode, MIME sniffing, byte/pixel/frame limits | P5 |
| Malicious SVG/HTML/MDX | Safe parser, directive allowlist, sanitization, no executable managed content | P3/P5 |
| Forged webhook/form | Signature/nonce/timestamp checks, rate limit, replay protection, anti-bot | P10 |
| Route/domain takeover | Immutable URL policy, separate G4 domain workflow, DNS not agent-default | P6/P7 |
| Audit tampering | Append-only events, integrity hashes, restricted writers, external backup/export | P1/P11 |
| Unbounded model/provider spend | Tenant/site/plugin quotas, budgets, kill switches, metering | P2/P15 |
| Availability/provider outage | Durable workflow, retry policy, health gates, fallback only before run, rollback | P6/P11 |

## Security invariants

- Authority is derived from the authenticated principal, never a caller-supplied tenant/site ID.
- Database application and service roles cannot bypass Row-Level Security.
- Secrets never appear in ordinary plugin config, events, logs, MCP results, or portable exports.
- An agent cannot install executable code or increase its own permissions.
- Preview approval cannot authorize a different release artifact.
- Domain, destructive, financial, and legal effects are disabled by default.
- Content and plugin output are untrusted until schema, policy, and quality validation complete.

## Open security work

- Select identity provider and specify OAuth 2.1 resource/authorization metadata and PKCE behavior.
- Define plugin provenance, signing, trusted publisher, and revocation policy.
- Prototype database roles and RLS across migrations, backup, restore, and background workers.
- Select secret manager and short-lived credential mechanism.
- Define CSP and origin policy for MCP Apps and protected previews.
- Define event integrity/checkpoint and redaction test strategy.
- Commission an external security review before hosted external tenants.

## Abuse cases required in tests

- editor calls publish, lead read, plugin install, or secret tools;
- publisher reuses an approval after a content/design/profile change;
- plugin requests foreign site IDs or follows cross-site artifact URLs;
- content instructs an agent to disclose secrets or bypass publication policy;
- remote asset redirects to localhost, metadata service, or an oversized decode;
- duplicated webhook/workflow delivery sends duplicate mail or creates duplicate leads;
- backup/restore or cache keys cross tenant boundaries;
- compromised service plugin attempts undeclared network/data access.
