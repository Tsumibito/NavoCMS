import pg, { type PoolClient, type PoolConfig } from "pg";

import { withDatabaseScope, type DatabaseScope, type QueryResult, type SqlClient } from "./context.js";

const { Pool } = pg;

export interface PostgresDatabaseOptions {
  readonly connectionString: string;
  readonly applicationName?: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMilliseconds?: number;
  readonly idleTimeoutMilliseconds?: number;
}

export class PostgresDatabase {
  readonly #pool: pg.Pool;

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
  }

  public async withScope<T>(scope: DatabaseScope, operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await withDatabaseScope(new PgClient(client), scope, operation);
    } finally {
      client.release();
    }
  }

  public async ready(): Promise<boolean> {
    const result = await this.#pool.query<{ schema_ready: boolean }>(
      `SELECT to_regclass('navocms.content_revisions') IS NOT NULL
          AND to_regclass('navocms.release_candidates') IS NOT NULL
          AND to_regclass('navocms.workflow_checkpoints') IS NOT NULL AS schema_ready`
    );
    return result.rows[0]?.schema_ready === true;
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
  if (!["require", "verify-full"].includes(parsed.searchParams.get("sslmode") ?? "")) {
    throw new Error(`${variable} must require verified TLS with sslmode=require or sslmode=verify-full`);
  }
  return value;
}
