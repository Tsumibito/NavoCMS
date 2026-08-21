import { SecurityError } from "./errors.js";

export interface UsageScope {
  readonly tenantId: string;
  readonly siteId?: string;
  readonly pluginId?: string;
}

export interface UsageRecord extends UsageScope {
  readonly metric: string;
  readonly amount: number;
  readonly occurredAt: string;
}

function scopeKey(scope: UsageScope, metric: string): string {
  return `${scope.tenantId}:${scope.siteId ?? "*"}:${scope.pluginId ?? "*"}:${metric}`;
}

export class InMemoryQuotaMeter {
  readonly #limits = new Map<string, number>();
  readonly #usage = new Map<string, number>();
  readonly #records: UsageRecord[] = [];

  public setLimit(scope: UsageScope, metric: string, amount: number): void {
    if (!Number.isFinite(amount) || amount < 0) throw new SecurityError("QUOTA_LIMIT_INVALID", "Quota must be non-negative");
    this.#limits.set(scopeKey(scope, metric), amount);
  }

  public consume(scope: UsageScope, metric: string, amount: number, occurredAt: Date = new Date()): UsageRecord {
    if (!Number.isFinite(amount) || amount <= 0) throw new SecurityError("USAGE_AMOUNT_INVALID", "Usage must be positive");
    const key = scopeKey(scope, metric);
    const current = this.#usage.get(key) ?? 0;
    const limit = this.#limits.get(key);
    if (limit !== undefined && current + amount > limit) {
      throw new SecurityError("QUOTA_EXCEEDED", `Quota exceeded for ${metric}`, { metric, limit, current });
    }
    this.#usage.set(key, current + amount);
    const record = Object.freeze({ ...scope, metric, amount, occurredAt: occurredAt.toISOString() });
    this.#records.push(record);
    return record;
  }

  public usage(scope: UsageScope, metric: string): number {
    return this.#usage.get(scopeKey(scope, metric)) ?? 0;
  }

  public records(): readonly UsageRecord[] {
    return Object.freeze([...this.#records]);
  }
}

export type KillSwitchLevel = "global" | "tenant" | "site" | "plugin";

export interface KillSwitch {
  readonly level: KillSwitchLevel;
  readonly tenantId?: string;
  readonly siteId?: string;
  readonly pluginId?: string;
  readonly reason: string;
}

export class KillSwitchRegistry {
  readonly #switches: KillSwitch[] = [];

  public enable(killSwitch: KillSwitch): void {
    this.#switches.push(Object.freeze({ ...killSwitch }));
  }

  public assertEnabled(scope: UsageScope): void {
    const active = this.#switches.find((candidate) => {
      if (candidate.level === "global") return true;
      if (candidate.tenantId !== scope.tenantId) return false;
      if (candidate.level === "tenant") return true;
      if (candidate.siteId !== scope.siteId) return false;
      if (candidate.level === "site") return true;
      return candidate.pluginId === scope.pluginId;
    });
    if (active) throw new SecurityError("OPERATION_DISABLED", active.reason, { level: active.level });
  }
}
