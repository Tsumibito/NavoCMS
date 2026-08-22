# Coolify deployment

NavoCMS uses two long-lived Coolify applications built from the repository `Dockerfile`:

| Application | Git branch | Database | Purpose |
|---|---|---|---|
| `navocms-staging` | reviewed `main` or release candidate | Neon `staging` branch | migration, OAuth, RLS, workflow, and release verification |
| `navocms-production` | pinned release tag | Neon production branch | public control plane |

Both applications run on the operator's Coolify-managed Docker host, expose container port `8788`,
and use `/healthz` for container
liveness. `/readyz` also checks that Neon is reachable and the required schema exists. Coolify should
route traffic only after the Docker health check passes.

## Persistent staging versus previews

Staging is permanent. It proves stateful behavior that a short-lived preview cannot safely replace:
ordered migrations, OAuth callbacks, background jobs, RLS, recovery, and Coolify rolling updates.
Sprint 7 adds protected content-preview releases. Later CI may also create short-lived Neon branches
named `preview/pr-<number>-<branch>` for schema-changing pull requests; those branches are not the
editorial staging environment.

## Required runtime configuration

The public repository contains names and safe defaults only. Store encrypted `.env.staging` and
`.env.production` in the private operator deployment repository. Mount the matching file read-only
at `/run/navocms/.env` and configure only:

```env
NAVOCMS_ENV_FILE=/run/navocms/.env
DOTENV_PRIVATE_KEY_STAGING=<platform secret, staging only>
```

Production uses `DOTENV_PRIVATE_KEY_PRODUCTION`. Do not copy the migration-owner URL into the
application. The runtime receives a pooled Neon URL for a `NOBYPASSRLS` login that inherits only
`navocms_app`. A separate one-off migration job receives the direct owner URL.

The encrypted runtime file defines:

```env
NAVOCMS_RUNTIME_MODE=production
NAVOCMS_ENVIRONMENT=staging
NAVOCMS_DATABASE_URL=<pooled runtime-role URL; prefer sslmode=verify-full>
NAVOCMS_DATABASE_POOL_MAX=8
NAVOCMS_TENANT_ID=<deployment-bound tenant UUID>
NAVOCMS_SITE_ID=<deployment-bound site UUID>
NAVOCMS_MCP_RESOURCE=https://staging-cms.navocms.com/mcp
NAVOCMS_PREVIEW_BASE_URL=https://staging-cms.navocms.com
NAVOCMS_PREVIEW_TTL_SECONDS=3600
NAVOCMS_OIDC_ISSUER=<authorization server issuer>
NAVOCMS_OIDC_JWKS_URL=<authorization server JWKS URL>
PORT=8788
```

Use `production` and the production resource URL in the production file. The OIDC token must contain
the resource audience, stable subject, and requested NavoCMS scopes. PostgreSQL maps issuer and
subject to the internal principal and site membership; custom NavoCMS UUID claims are not required.

## Migration gate

Run migrations against staging first with the direct, non-pooled owner URL:

```sh
NAVOCMS_MIGRATION_DATABASE_URL=... pnpm db:migrate
```

After the staging database isolation suite and application smoke test pass, run the same immutable
migration set against production. Never add the owner URL to the running application and never use
Coolify's first-deploy pre-deployment hook: Coolify skips it when no old container exists.

## Rollout order

1. Apply migrations to the Neon staging branch.
2. Deploy `navocms-staging`; verify `/healthz`, `/readyz`, OAuth metadata, and one authenticated read.
3. Promote the reviewed release tag.
4. Apply the identical migrations to the Neon production branch.
5. Deploy `navocms-production`; repeat the smoke checks.

Production remains unexposed until its OAuth issuer and hostname exist. An auto-generated Coolify
domain is acceptable for staging infrastructure checks, but it must not be registered as the final
MCP resource URL.
