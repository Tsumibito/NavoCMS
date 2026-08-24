import type { DatabaseScope } from "./context.js";
import type { PostgresDatabase } from "./database.js";

export type IdempotencyReservation<T> =
  | { readonly status: "reserved" }
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "pending" | "failed"; readonly errorCode?: string };

interface IdempotencyRow extends Record<string, unknown> {
  readonly input_fingerprint: string;
  readonly status: "pending" | "completed" | "failed";
  readonly response_json: unknown;
  readonly error_code: string | null;
}

export class PostgresIdempotencyStore {
  readonly #database: PostgresDatabase;

  public constructor(database: PostgresDatabase) {
    this.#database = database;
  }

  /**
   * Read an existing reservation before an external effect. Reservations are
   * still created exclusively by {@link reserve}; this method never changes
   * their lifecycle.
   */
  public async lookup<T>(scope: DatabaseScope, operation: string, key: string, fingerprint: string): Promise<IdempotencyReservation<T> | undefined> {
    return this.#database.withScope(scope, async (client) => {
      const existing = await client.query<IdempotencyRow>(
        `SELECT input_fingerprint, status, response_json, error_code
           FROM navocms.idempotency_records
          WHERE tenant_id = $1 AND site_id = $2 AND operation = $3 AND idempotency_key = $4`,
        [scope.tenantId, scope.siteId, operation, key]
      );
      const row = existing.rows[0];
      if (!row) return undefined;
      if (row.input_fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED");
      if (row.status === "completed") return { status: "completed", value: row.response_json as T };
      return { status: row.status, ...(row.error_code ? { errorCode: row.error_code } : {}) };
    });
  }

  public async reserve<T>(scope: DatabaseScope, operation: string, key: string, fingerprint: string): Promise<IdempotencyReservation<T>> {
    return this.#database.withScope(scope, async (client) => {
      const inserted = await client.query(
        `INSERT INTO navocms.idempotency_records (
           tenant_id, site_id, operation, idempotency_key, input_fingerprint, status
         ) VALUES ($1, $2, $3, $4, $5, 'pending') ON CONFLICT DO NOTHING RETURNING idempotency_key`,
        [scope.tenantId, scope.siteId, operation, key, fingerprint]
      );
      if ((inserted.rowCount ?? 0) === 1) return { status: "reserved" };
      const existing = await client.query<IdempotencyRow>(
        `SELECT input_fingerprint, status, response_json, error_code
           FROM navocms.idempotency_records
          WHERE tenant_id = $1 AND site_id = $2 AND operation = $3 AND idempotency_key = $4`,
        [scope.tenantId, scope.siteId, operation, key]
      );
      const row = existing.rows[0];
      if (!row) throw new Error("Idempotency record disappeared during reservation");
      if (row.input_fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED");
      if (row.status === "completed") return { status: "completed", value: row.response_json as T };
      return { status: row.status, ...(row.error_code ? { errorCode: row.error_code } : {}) };
    });
  }

  public async complete(scope: DatabaseScope, operation: string, key: string, fingerprint: string, value: unknown): Promise<void> {
    await this.#database.withScope(scope, async (client) => {
      const updated = await client.query(
        `UPDATE navocms.idempotency_records
            SET status = 'completed', response_json = $5::jsonb, completed_at = now()
          WHERE tenant_id = $1 AND site_id = $2 AND operation = $3 AND idempotency_key = $4
            AND input_fingerprint = $6 AND status = 'pending'`,
        [scope.tenantId, scope.siteId, operation, key, JSON.stringify(value), fingerprint]
      );
      if ((updated.rowCount ?? 0) !== 1) throw new Error("Idempotency completion lost its reservation");
    });
  }

  public async fail(scope: DatabaseScope, operation: string, key: string, fingerprint: string, errorCode: string): Promise<void> {
    await this.#database.withScope(scope, async (client) => {
      await client.query(
        `UPDATE navocms.idempotency_records SET status = 'failed', error_code = $5, completed_at = now()
          WHERE tenant_id = $1 AND site_id = $2 AND operation = $3 AND idempotency_key = $4
            AND input_fingerprint = $6 AND status = 'pending'`,
        [scope.tenantId, scope.siteId, operation, key, errorCode, fingerprint]
      );
    });
  }
}
