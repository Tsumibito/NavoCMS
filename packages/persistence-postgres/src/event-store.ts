import { contracts, type DomainEvent } from "@navocms/contracts";
import { assertSafeProjection } from "@navocms/security";

import type { PostgresDatabase } from "./database.js";

interface EventRow extends Record<string, unknown> {
  readonly sequence: string | number;
  readonly event_json: unknown;
}

export interface PostgresEventQuery {
  readonly tenantId?: string;
  readonly siteId?: string;
  readonly principalId?: string;
  readonly correlationId?: string;
  readonly type?: string;
}

export interface PostgresLedgerRecord<
  TData extends Record<string, unknown> = Record<string, unknown>
> {
  readonly sequence: number;
  readonly event: DomainEvent<TData>;
}

export class PostgresEventStore {
  readonly #database: PostgresDatabase;

  public constructor(database: PostgresDatabase) {
    this.#database = database;
  }

  public async append<TData extends Record<string, unknown>>(
    eventInput: DomainEvent<TData>
  ): Promise<PostgresLedgerRecord<TData>> {
    assertSafeProjection(eventInput.data);
    const event = contracts.event.parse(structuredClone(eventInput)) as DomainEvent<TData>;
    return this.#database.withScope({
      tenantId: event.navotenantid,
      siteId: event.navositeid,
      principalId: event.navoactor.id
    }, async (client) => {
      const result = await client.query<EventRow>(
        `INSERT INTO navocms.event_ledger (
           event_id, tenant_id, site_id, correlation_id, event_type,
           operation_key, idempotency_key, event_json, occurred_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         RETURNING sequence, event_json`,
        [event.id, event.navotenantid, event.navositeid, event.navocorrelationid, event.type,
          event.type, event.navoidempotencykey ?? null, JSON.stringify(event), event.time]
      );
      if (event.navoidempotencykey) {
        await client.query(
          `INSERT INTO navocms.domain_outbox (
             id, tenant_id, site_id, correlation_id, causation_id, operation_key,
             event_type, consequence, idempotency_key, payload_json
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
           ON CONFLICT (tenant_id, site_id, operation_key, idempotency_key) DO NOTHING`,
          [event.id, event.navotenantid, event.navositeid, event.navocorrelationid,
            event.navocausationid ?? null, event.type, event.type, event.navoconsequence,
            event.navoidempotencykey, JSON.stringify(event)]
        );
      }
      const row = result.rows[0]!;
      const stored = contracts.event.parse(row.event_json) as DomainEvent<TData>;
      return Object.freeze({ sequence: Number(row.sequence), event: Object.freeze(stored) });
    });
  }

  public async query(query: PostgresEventQuery): Promise<readonly PostgresLedgerRecord[]> {
    if (!query.tenantId || !query.siteId || !query.principalId) {
      throw new Error("PostgreSQL event queries must include tenantId, siteId, and principalId");
    }
    return this.#database.withScope({
      tenantId: query.tenantId,
      siteId: query.siteId,
      principalId: query.principalId
    }, async (client) => {
      const result = await client.query<EventRow>(
        `SELECT sequence, event_json
           FROM navocms.event_ledger
          WHERE tenant_id = $1 AND site_id = $2
            AND ($3::uuid IS NULL OR correlation_id = $3)
            AND ($4::text IS NULL OR event_type = $4)
          ORDER BY sequence`,
        [query.tenantId, query.siteId, query.correlationId ?? null, query.type ?? null]
      );
      return Object.freeze(result.rows.map((row) => {
        const event = contracts.event.parse(row.event_json) as DomainEvent<Record<string, unknown>>;
        return Object.freeze({ sequence: Number(row.sequence), event: Object.freeze(event) });
      }));
    });
  }
}
