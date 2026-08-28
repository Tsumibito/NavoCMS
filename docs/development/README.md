# Development

NavoCMS currently requires Node.js 22 or newer, Corepack, and pnpm 10.24.0.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

## Workspace

| Package | Responsibility | Allowed dependencies |
|---|---|---|
| `@navocms/contracts` | Public types, validators, packaged JSON Schemas | AJV only |
| `@navocms/security` | OAuth and intersected authority | Node.js only |
| `@navocms/content` | Markdown, types/packs, revisions, patches, portable bundles | Contracts, security, remark, AJV |
| `@navocms/design` | Design validation, DTCG tokens, overrides, digests, catalogue model | Contracts only |
| `@navocms/design-astro` | Complete component/recipe bindings for Astro | Design only |
| `@navocms/persistence-postgres` | Scoped transactions and ordered RLS migrations | Driver-neutral |
| `@navocms/kernel` | Capabilities, plugin graph/host, events, and trajectories | Contracts, security |
| `@navocms/mcp` | OAuth-scoped agent editing tools and optional MCP Apps review UI | Content, kernel, security, MCP SDK |
| `@navocms/design-catalogue` | Generated Astro review and quality surface | Design, Astro adapter, Astro |

Build all packages:

```bash
pnpm build
```

The [MCP application](../../apps/mcp/README.md) has a separate development entry point and refuses
to start without an OAuth issuer/resource plus an explicit tenant and site. Sprint 5 uses an
in-memory editing adapter; it is a protocol and policy proving surface, not production persistence.

## Checks

- `pnpm check:contracts`: public schema compilation, fixtures, and semantic invariants;
- `pnpm check:boundaries`: forbidden package dependency directions;
- `pnpm check:secrets`: public-repository environment and decryption-key policy;
- `pnpm check:build`: built package and MCP smoke checks;
- `pnpm check:catalogue`: contract compilation, Astro bindings, diagnostics, and static catalogue build;
- `pnpm check:docs`: Markdown consistency;
- `pnpm check:links`: local documentation links;
- `pnpm typecheck`: source and test type safety;
- `pnpm test`: unit and integration tests;
- `pnpm test:visual`: Chromium visual baselines, responsive overflow, and WCAG checks.

Install the pinned Playwright browser once before local visual checks:

```bash
pnpm exec playwright install chromium
```

Build artifacts under package `dist/` directories are generated and must not be committed.
