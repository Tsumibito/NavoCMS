import pg, { type PoolClient, type PoolConfig } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

import { withDatabaseScope, type DatabaseScope, type QueryResult, type SqlClient } from "./context.js";
import { expectedMigrations } from "./migrate.js";

const { Pool } = pg;

export interface PostgresDatabaseOptions {
  readonly connectionString: string;
  readonly applicationName?: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMilliseconds?: number;
  readonly idleTimeoutMilliseconds?: number;
  readonly readinessScope?: ReadinessScope;
}

export interface ReadinessScope extends DatabaseScope {
  readonly environmentKey: string;
}

const ISOLATED_APPLICATION_TABLES = [
  "tenants", "sites", "environments", "identities", "tenant_memberships", "site_memberships",
  "service_accounts", "secret_references", "content_types", "content_documents", "content_variants",
  "content_revisions", "content_relations",
  "event_ledger", "idempotency_records", "runtime_jobs", "runtime_leases", "domain_outbox",
  "release_candidates", "release_previews", "release_approvals", "workflow_runs",
  "workflow_checkpoints", "release_publications", "quota_limits", "kill_switches", "usage_events",
  "media_assets", "media_originals", "media_variants", "media_references", "media_upload_intents", "media_gc_candidates", "media_lifecycle_checkpoints", "media_variant_checkpoints", "reviewed_astro_artifacts", "reviewed_astro_build_inputs"
] as const;

export class PostgresDatabase {
  readonly #pool: pg.Pool;
  readonly #transactions = new AsyncLocalStorage<{ readonly client: SqlClient; readonly scope: DatabaseScope }>();
  readonly #readinessScope: ReadinessScope | undefined;

  public constructor(options: PostgresDatabaseOptions) {
    const config: PoolConfig = {
      connectionString: options.connectionString,
      application_name: options.applicationName ?? "navocms",
      max: options.maxConnections ?? 8,
      connectionTimeoutMillis: options.connectionTimeoutMilliseconds ?? 10_000,
      idleTimeoutMillis: options.idleTimeoutMilliseconds ?? 30_000,
      keepAlive: true,
      allowExitOnIdle: false
    };
    this.#pool = new Pool(config);
    this.#readinessScope = options.readinessScope;
  }

  public async withScope<T>(scope: DatabaseScope, operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const active = this.#transactions.getStore();
    if (active) {
      if (active.scope.tenantId !== scope.tenantId || active.scope.siteId !== scope.siteId ||
        active.scope.principalId !== scope.principalId) {
        throw new Error("Nested database operation changed its authorization scope");
      }
      return operation(active.client);
    }
    const client = await this.#pool.connect();
    try {
      const scoped = new PgClient(client);
      return await this.#transactions.run({ client: scoped, scope }, () => withDatabaseScope(scoped, scope, operation));
    } finally {
      client.release();
    }
  }

  public async ready(): Promise<boolean> {
    try {
      const expected = await expectedMigrations();
      const applied = await this.#pool.query<{ name: string; checksum: string }>(
        "SELECT name, checksum FROM navocms.schema_migrations"
      );
      const appliedByName = new Map(applied.rows.map((migration) => [migration.name, migration.checksum]));
      if (expected.some((migration) => appliedByName.get(migration.name) !== migration.checksum)) return false;

      const role = await this.#pool.query<{ safe_runtime_role: boolean }>(
        `SELECT NOT rolbypassrls AND NOT rolsuper AS safe_runtime_role
           FROM pg_roles WHERE rolname = current_user`
      );
      if (role.rows[0]?.safe_runtime_role !== true) return false;

      const tables = await this.#pool.query<{ relname: string; rls: boolean; forced: boolean }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'navocms' AND c.relname = ANY($1::text[])`,
        [ISOLATED_APPLICATION_TABLES]
      );
      const tableState = new Map(tables.rows.map((table) => [table.relname, table]));
      if (ISOLATED_APPLICATION_TABLES.some((name) => {
        const table = tableState.get(name);
        return table?.rls !== true || table?.forced !== true;
      })) return false;
      const readinessScope = this.#readinessScope;
      if (!readinessScope) return true;
      return this.withScope(readinessScope, async (client) => {
        const deployment = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM navocms.environments
              WHERE tenant_id = $1 AND site_id = $2 AND environment_key = $3
           ) AS exists`,
          [readinessScope.tenantId, readinessScope.siteId, readinessScope.environmentKey]
        );
        return deployment.rows[0]?.exists === true;
      });
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }
}

class PgClient implements SqlClient {
  readonly #client: PoolClient;

  public constructor(client: PoolClient) {
    this.#client = client;
  }

  public async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<TRow>> {
    const result = await this.#client.query<TRow>(text, values ? [...values] : undefined);
    return { rows: result.rows, ...(result.rowCount === null ? {} : { rowCount: result.rowCount }) };
  }
}

export function requireDatabaseUrl(value: string | undefined, variable = "NAVOCMS_DATABASE_URL"): string {
  if (!value) throw new Error(`${variable} is required`);
  const parsed = new URL(value);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${variable} must be a PostgreSQL URL`);
  }
  const sslmode = parsed.searchParams.get("sslmode") ?? "";
  const isExplicitLoopbackTest = process.env.NODE_ENV === "test"
    && process.env.NAVOCMS_ALLOW_INSECURE_TEST_DATABASE === "true"
    && ["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)
    && ["disable", "allow", "prefer", ""].includes(sslmode);
  if (!["require", "verify-full"].includes(sslmode) && !isExplicitLoopbackTest) {
    throw new Error(`${variable} must require verified TLS with sslmode=require or sslmode=verify-full`);
  }
  return value;
}
