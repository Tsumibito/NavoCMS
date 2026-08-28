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

## Operator/runtime release boundary

Coolify is an operator/runtime release procedure, not a content delivery
provider. Editorial draft, preview, approval, publish, reconcile, and rollback
release only immutable static output to Cloudflare Pages. They must not update,
restart, deploy, or roll back either Coolify application.

For a runtime release, an operator separately selects a reviewed immutable
commit or tag, applies the migration gate when required, deploys the matching
Coolify application, and records the resulting deployment identifier and
evidence outside the content release. Verify `/healthz`, `/readyz`, OAuth
metadata, and one authenticated API read after the deployment. Roll back the
runtime only through this operator procedure; use a Pages release rollback only
to restore public static content.

Legacy v1 content publication references remain Pages-reconcilable during their
retention period. Do not reactivate their former Coolify coupling: migrate an
activated v1/v2 staging binding to the Pages-only v3 binding and pin its new
digest before the next content publish.

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
NAVOCMS_ENVIRONMENT_KEY=<reviewed deployment environment key>
NAVOCMS_REVIEWED_ASTRO_TOOLCHAIN=/app/node_modules
NAVOCMS_OIDC_ISSUER=<authorization server issuer>
NAVOCMS_OIDC_JWKS_URL=<authorization server JWKS URL>
PORT=8788
```

For the `cloudflare-staging` profile only, enable Coolify's **Include Source
Commit** setting. Coolify supplies the exact commit as the standard
`SOURCE_COMMIT` build argument; the image binds it internally to
`NAVOCMS_REVIEWED_SOURCE_COMMIT`. The image contains the pinned Astro,
`@astrojs/check`, and TypeScript closure as production dependencies. The
runtime refuses external staging delivery when this value is absent or is not a
full immutable commit SHA; it never relies on `.git` or a mutable checkout in
the running container.

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
