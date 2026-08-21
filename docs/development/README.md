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
| `@navocms/security` | OAuth, intersected authority, secrets, storage, quotas | Node.js only |
| `@navocms/content` | Markdown, types/packs, revisions, patches, portable bundles | Contracts, security, remark, AJV |
| `@navocms/design` | Design validation, DTCG tokens, overrides, digests, catalogue model | Contracts only |
| `@navocms/design-astro` | Complete component/recipe bindings for Astro | Design only |
| `@navocms/persistence-postgres` | Scoped transactions and ordered RLS migrations | Driver-neutral |
| `@navocms/kernel` | Capabilities, plugin graph/host, events, trajectories, tracing | Contracts, security, OpenTelemetry API |
| `@navocms/api` | Fastify transport, OAuth metadata, and development probes | Contracts, kernel, security, Fastify |
| `@navocms/design-catalogue` | Generated Astro review and quality surface | Design, Astro adapter, Astro |
| `@navocms/plugin-noop-service` | External authenticated/idempotent service example | Fastify; never kernel |

Build all packages:

```bash
pnpm build
```

Run the development API:

```bash
pnpm --filter @navocms/api dev
```

The API listens on `127.0.0.1:3000` by default. Its contract-validation endpoints remain development
scaffolding, not a production management API. A deployment configures the OAuth protected-resource
metadata and must place every future content/management route behind the verified scope boundary.

Run the external no-op service with a local development token:

```bash
NAVOCMS_PLUGIN_TOKEN=replace-with-at-least-16-characters \
  pnpm --filter @navocms/plugin-noop-service dev
```

## Checks

- `pnpm check:contracts`: public schema compilation, fixtures, and semantic invariants;
- `pnpm check:boundaries`: forbidden package dependency directions;
- `pnpm check:secrets`: public-repository environment and decryption-key policy;
- `pnpm check:build`: packaged-schema, API, and service-plugin smoke checks;
- `pnpm check:catalogue`: contract compilation, Astro bindings, diagnostics, and static catalogue build;
- `pnpm check:docs`: Markdown consistency;
- `pnpm check:links`: local documentation links;
- `pnpm typecheck`: source and test type safety;
- `pnpm test`: unit and Fastify injection tests.
- `pnpm test:visual`: Chromium visual baselines, responsive overflow, and WCAG checks.

Install the pinned Playwright browser once before local visual checks:

```bash
pnpm exec playwright install chromium
```

Build artifacts under package `dist/` directories are generated and must not be committed.
