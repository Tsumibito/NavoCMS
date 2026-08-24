# Production foundation

## Environment topology

NavoCMS starts with one EU-region Neon project and separate branches/computes for production and
staging. The database region should be close to the Coolify host; changing region later requires a
new Neon project and a data migration.
Each compute keeps scale-to-zero enabled. The first database request after an idle period may take a
few hundred milliseconds; the public sites are separately rendered and remain available while the
control plane wakes.

Applications use Neon's pooled endpoint. Migration, dump, and restore commands use the direct
endpoint because PgBouncer transaction pooling does not preserve session-level migration behavior.
Every application query obtains one pooled client, opens one transaction, establishes transaction-
local tenant/site/principal context, and relies on forced PostgreSQL RLS.

## Database identities

| Identity | Credential location | Authority |
|---|---|---|
| Neon branch owner | migration job only | schema migration, restore, runtime-role provisioning |
| `navocms_runtime` | encrypted environment file | member of `navocms_app`, `NOBYPASSRLS` |
| `navocms_app` | no login | grants and RLS policy target |
| `navocms_plugin` | no login initially | narrower plugin data access |

Never connect the application with the Neon owner URL: Neon owners have `BYPASSRLS` and would erase
the database isolation boundary.

## Migrations and recovery

- Migration files are ordered, checksummed, and run under an advisory lock.
- Staging receives every migration before production.
- Applied migration text is immutable; checksum drift fails closed.
- Neon branches provide fast isolated migration and restore rehearsal.
- Before a consequential production migration, create a protected restore point or recovery branch.
- A logical `pg_dump` uses the direct endpoint and is stored encrypted outside the Neon project.
- Restore is verified only after registry, RLS, content-integrity, and readiness checks pass.

## Operational minimum

- Coolify container health: `/healthz`.
- Dependency readiness: `/readyz`.
- Graceful `SIGTERM` closes HTTP and database pools.
- Logs contain environment and error codes, never tokens, database URLs, Markdown bodies, or secrets.
- Production and staging use different dotenvx keys, database branches, OAuth audiences, and hostnames.
- Runtime connection pools stay small because Neon also pools at PgBouncer.

## WorkOS MCP authorization

AuthKit OAuth scopes establish the identity session and must use standard OIDC scopes (for example,
`openid` and client-requested `offline_access`). NavoCMS content authority is not an OAuth scope:
WorkOS supplies it through the access token's `permissions` claim based on the user's organization
role, and NavoCMS intersects that claim with the tenant/site membership enforced by PostgreSQL RLS.

## Preview policy

Protected editorial previews in Sprint 7 are immutable release artifacts and do not need a complete
CMS deployment. Database preview branches are reserved for pull requests that contain schema or
persistence changes. This keeps previews cheap without sacrificing a stable integration environment.
