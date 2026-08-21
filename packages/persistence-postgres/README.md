# `@navocms/persistence-postgres`

PostgreSQL persistence boundary for NavoCMS.

The application supplies any driver that implements `SqlClient`. `withDatabaseScope` starts a
transaction and sets transaction-local tenant, site, environment, and principal identifiers before
queries run. The database independently enforces those values through forced Row-Level Security.

Production identities are intentionally separate:

- the Neon branch owner or another short-lived migration login: schema migrations, restores, and
  runtime-login provisioning only;
- `navocms_migrator`: a provider-independent `NOLOGIN BYPASSRLS` role retained as the portable
  migration authority boundary;
- `navocms_app`: ordinary API identity with `NOBYPASSRLS`;
- `navocms_plugin`: ordinary service-plugin identity with `NOBYPASSRLS`.

Apply migrations only through a privileged deployment job using the direct Neon endpoint. Never
give the API a migration or branch-owner credential. The runtime uses a separately provisioned
login that is a member of `navocms_app` and connects through Neon's pooled endpoint.

The migration creates the group roles when the provider permits `CREATEROLE`; the migration itself
does not assume those roles. Managed providers that do not permit `CREATEROLE` must provision
equivalent `NOBYPASSRLS` application/plugin identities and run the schema statements as their
migration owner. CI applies the migration to PostgreSQL and runs
[`tests/rls-isolation.sql`](tests/rls-isolation.sql) as an adversarial database test.
