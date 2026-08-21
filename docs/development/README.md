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
| `@navocms/kernel` | Capabilities, plugin graph/host, events, trajectories, tracing | Contracts, OpenTelemetry API |
| `@navocms/api` | Fastify transport and development probes | Contracts, kernel, Fastify |
| `@navocms/plugin-noop-service` | External authenticated/idempotent service example | Fastify; never kernel |

Build all packages:

```bash
pnpm build
```

Run the development API:

```bash
pnpm --filter @navocms/api dev
```

The API listens on `127.0.0.1:3000` by default. Its current contract-validation endpoints are
development scaffolding. Do not expose them as a production management API before the Sprint 2
identity, tenancy, and OAuth boundary exists.

Run the external no-op service with a local development token:

```bash
NAVOCMS_PLUGIN_TOKEN=replace-with-at-least-16-characters \
  pnpm --filter @navocms/plugin-noop-service dev
```

## Checks

- `pnpm check:contracts`: public schema compilation, fixtures, and semantic invariants;
- `pnpm check:boundaries`: forbidden package dependency directions;
- `pnpm check:build`: packaged-schema, API, and service-plugin smoke checks;
- `pnpm check:docs`: Markdown consistency;
- `pnpm check:links`: local documentation links;
- `pnpm typecheck`: source and test type safety;
- `pnpm test`: unit and Fastify injection tests.

Build artifacts under package `dist/` directories are generated and must not be committed.
