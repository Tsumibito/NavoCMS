# NavoCMS agent contract

These rules apply to every automated agent and human contributor in this repository.

## Product invariants

- The primary operator interface is an authenticated MCP agent. Focused UI is optional and cannot
  become the only way to complete a core workflow. One guarantee is deliberately not MCP-only: a
  human publication decision is recorded through an independent browser confirmation session
  (ADR 0026); the agent reads the decision and can never issue the receipt.
- Keep the trusted kernel small. Identity, tenant isolation, authorization, event integrity,
  idempotency, migrations, secrets, quotas, and release policy are not ordinary plugins.
- Plugins request versioned capabilities. They never expand the authority of their caller.
- Every consequential action emits an auditable domain event. Never log hidden model reasoning,
  credentials, unrestricted PII, or full lead/customer payloads.
- Public publication uses immutable revisions and releases. Approval binds to the exact previewed
  release hash; stale approval fails closed.
- Canonical prose is portable Markdown plus schema-validated directives. Do not introduce Lexical,
  arbitrary MDX, or executable HTML as managed content formats.
- Multitenancy is foundational. Every site-owned resource must be tenant- and site-scoped, with
  database isolation tested independently from application filtering.
- Runtime installation of unreviewed plugin packages by an agent is prohibited.

## Contract changes

- Changes to `schemas/` require matching specification updates, fixtures, validation tests, and a
  compatibility note.
- Breaking contract changes require a new version; never silently alter an already released schema.
- Architecture changes require an ADR in `docs/architecture/`.
- Update roadmap gates only when their verification criteria have actually passed.

## Working practices

- Prefer small pull requests with one reviewable architectural outcome.
- Preserve unrelated work and never commit secrets, decrypted dotenv files, customer content, or
  production exports.
- Pin dependencies and GitHub Actions deliberately. Minimize new runtime dependencies.
- Run `pnpm check` before proposing a change.
- Treat examples as executable contract fixtures, not illustrative pseudocode.
