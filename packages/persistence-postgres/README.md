# `@navocms/persistence-postgres`

PostgreSQL persistence boundary for NavoCMS.

The application supplies any driver that implements `SqlClient`. `withDatabaseScope` starts a
transaction and sets transaction-local tenant, site, environment, and principal identifiers before
queries run. The database independently enforces those values through forced Row-Level Security.

Production identities are intentionally separate:

- `navocms_migrator`: short-lived schema owner with `BYPASSRLS` for migrations and restore work;
- `navocms_app`: ordinary API identity with `NOBYPASSRLS`;
- `navocms_plugin`: ordinary service-plugin identity with `NOBYPASSRLS`.

Apply migrations only through a privileged deployment job. Never give the API the migrator
credential.

The migration creates the roles for a self-hosted PostgreSQL instance. Managed providers that do
not permit `CREATEROLE` must provision equivalent `NOBYPASSRLS` application/plugin identities and
run the schema statements as their migration owner. CI applies the migration to PostgreSQL and runs
[`tests/rls-isolation.sql`](tests/rls-isolation.sql) as an adversarial database test.
