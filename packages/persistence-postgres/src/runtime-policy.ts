import { randomUUID } from "node:crypto";

import { SecurityError } from "@navocms/security";

import type { PostgresDatabase } from "./database.js";
import type { SqlClient } from "./context.js";

export interface RuntimePolicyRequest {
  readonly tenantId: string;
  readonly siteId: string;
  readonly principalId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly pluginId?: string;
  readonly amount?: number;
}

interface QuotaLimit extends Record<string, unknown> {
  readonly id: string;
  readonly plugin_id: string | null;
  readonly period: "hour" | "day" | "month" | "lifetime";
  readonly limit_amount: string;
}

/** Durable, fail-closed policy gate for consequential MCP operations. */
export class PostgresRuntimePolicyGuard {
  readonly #database: Pick<PostgresDatabase, "withScope">;

  public constructor(database: Pick<PostgresDatabase, "withScope">) {
    this.#database = database;
  }

  public async consume(request: RuntimePolicyRequest): Promise<void> {
    if (!Number.isSafeInteger(request.amount ?? 1) || (request.amount ?? 1) <= 0) {
      throw new SecurityError("USAGE_AMOUNT_INVALID", "Policy usage amount must be a positive integer");
    }
    const operationKey = `${request.operation}:${request.idempotencyKey}`;
    try {
      await this.#database.withScope(request, (client) => this.consumeInTransaction(client, request, operationKey));
    } catch (error) {
      if (error instanceof SecurityError) throw error;
      throw new SecurityError("POLICY_STORE_UNAVAILABLE", "Runtime policy store rejected the operation");
    }
  }

  private async consumeInTransaction(client: SqlClient, request: RuntimePolicyRequest, operationKey: string): Promise<void> {
    if (await usageAlreadyRecorded(client, request, operationKey)) return;

    const switches = await client.query<{ level: string; reason: string }>(
      `SELECT level, reason FROM navocms.kill_switches
        WHERE active
          AND (level = 'global'
            OR (level = 'tenant' AND tenant_id = $1)
            OR (level = 'site' AND tenant_id = $1 AND site_id = $2)
            OR (level = 'plugin' AND tenant_id = $1 AND site_id = $2 AND plugin_id = $3))
        ORDER BY CASE level WHEN 'global' THEN 1 WHEN 'tenant' THEN 2 WHEN 'site' THEN 3 ELSE 4 END
        LIMIT 1`,
      [request.tenantId, request.siteId, request.pluginId ?? null]
    );
    if (switches.rows[0]) {
      throw new SecurityError("OPERATION_DISABLED", switches.rows[0].reason, { level: switches.rows[0].level });
    }

    const limits = await client.query<QuotaLimit>(
      `SELECT id, plugin_id, period, limit_amount FROM navocms.quota_limits
        WHERE enabled AND operation_key = $1
          AND (tenant_id IS NULL OR tenant_id = $2)
          AND (site_id IS NULL OR site_id = $3)
          AND (plugin_id IS NULL OR plugin_id = $4)
        ORDER BY tenant_id NULLS FIRST, site_id NULLS FIRST, plugin_id NULLS FIRST, period`,
      [request.operation, request.tenantId, request.siteId, request.pluginId ?? null]
    );
    for (const limit of limits.rows) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [limit.id]);
      // A concurrent retry can only become visible after the quota lock is
      // acquired. Treat it as the same charge before evaluating the limit.
      if (await usageAlreadyRecorded(client, request, operationKey)) return;
      const used = await client.query<{ amount: string }>(
        `SELECT COALESCE(sum(amount), 0)::text AS amount FROM navocms.usage_events
          WHERE tenant_id = $1 AND site_id = $2 AND operation_key LIKE ($3 || ':%')
            AND ($4::text IS NULL OR plugin_id = $4)
            AND occurred_at >= CASE $5
              WHEN 'hour' THEN date_trunc('hour', now())
              WHEN 'day' THEN date_trunc('day', now())
              WHEN 'month' THEN date_trunc('month', now())
              ELSE '-infinity'::timestamptz END`,
        [request.tenantId, request.siteId, request.operation, limit.plugin_id, limit.period]
      );
      const current = BigInt(used.rows[0]?.amount ?? "0");
      const amount = BigInt(request.amount ?? 1);
      const maximum = BigInt(limit.limit_amount);
      if (current + amount > maximum) {
        throw new SecurityError("QUOTA_EXCEEDED", `Quota exceeded for ${request.operation}`, {
          period: limit.period, limit: maximum.toString(), current: current.toString()
        });
      }
    }

    // A unique operation identity is inserted only after all checks. A retry
    // is harmless: ON CONFLICT avoids a second durable charge.
    await client.query(
      `INSERT INTO navocms.usage_events (id, tenant_id, site_id, plugin_id, operation_key, amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, site_id, operation_key) DO NOTHING`,
      [randomUUID(), request.tenantId, request.siteId, request.pluginId ?? null, operationKey, request.amount ?? 1]
    );
  }
}

async function usageAlreadyRecorded(
  client: SqlClient,
  request: RuntimePolicyRequest,
  operationKey: string
): Promise<boolean> {
  const existing = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM navocms.usage_events
        WHERE tenant_id = $1 AND site_id = $2 AND operation_key = $3
     ) AS present`,
    [request.tenantId, request.siteId, operationKey]
  );
  return existing.rows[0]?.present === true;
}
