import { randomUUID } from "node:crypto";

import { DomainEventFactory, sha256, type EventStore } from "@navocms/kernel";
import { CloudflareDeliveryError, type DeliveryPhaseResolution, type DeliveryPhaseStore } from "@navocms/delivery-cloudflare";
import type { PostgresDatabase, SqlClient } from "@navocms/persistence-postgres";

import { McpEditingError } from "./errors.js";
import type { McpRequestContext } from "./model.js";
import type { RepositoryContext } from "./repository.js";
import { requirePermission } from "@navocms/security";

/** Created only by the authenticated operational boundary, never from tool input. */
export interface AuthenticatedDeliveryPhaseAuthority {
  readonly principal: Readonly<{ id: string; kind: "human" | "agent" | "service" }>;
  readonly permissions: readonly string[];
}

/**
 * The sole adapter from an authenticated MCP request to phase-resolution
 * authority.  Operational forms supply evidence and provider identifiers,
 * never an actor identity; this derives it from verified authorization.
 */
export function deliveryPhaseAuthority(context: McpRequestContext): AuthenticatedDeliveryPhaseAuthority {
  requirePermission(context.authorization, "content:publish", { tenantId: context.authorization.tenantId, siteId: context.authorization.siteId });
  if (context.authorization.principal.kind !== "human") throw new McpEditingError("DELIVERY_PHASE_HUMAN_REQUIRED", "Only an authenticated human may resolve a delivery phase");
  return Object.freeze({ principal: Object.freeze({ id: context.authorization.principal.id, kind: "human" }), permissions: Object.freeze(["content:publish"]) });
}

/** Bridges provider effects to the existing durable workflow checkpoint tables. */
export class PostgresDeliveryPhaseStore implements DeliveryPhaseStore {
  readonly #database: PostgresDatabase;
  readonly #context: RepositoryContext;
  readonly #authority: AuthenticatedDeliveryPhaseAuthority | undefined;
  readonly #events: EventStore | undefined;

  public constructor(database: PostgresDatabase, context: RepositoryContext, options: Readonly<{ authority?: AuthenticatedDeliveryPhaseAuthority; events?: EventStore }> = {}) {
    this.#database = database;
    this.#context = context;
    this.#authority = options.authority;
    this.#events = options.events;
  }

  public async reserve(input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): Promise<"new" | "reserved" | "completed"> {
    return this.#database.withScope(scope(this.#context), async (client) => {
      await lock(client, this.#context, input);
      const completed = await phase(client, this.#context, input, "completed");
      if (completed) return "completed";
      const current = await phase(client, this.#context, input, "reserved");
      if (current) {
        const firstNotApplied = await phase(client, this.#context, input, "not-applied");
        const second = await phase(client, this.#context, input, "reserved-2");
        if (firstNotApplied && !second) {
          await checkpoint(client, this.#context, input.releaseId, key(input, "reserved-2"), input.referenceHash, { referenceHash: input.referenceHash, phase: input.phase, attempt: 2 });
          return "new";
        }
        return "reserved";
      }
      await checkpoint(client, this.#context, input.releaseId, key(input, "reserved"), input.referenceHash, { referenceHash: input.referenceHash, phase: input.phase, attempt: 1 });
      return "new";
    });
  }

  public async complete(input: Readonly<{ releaseId: string; referenceHash: string; phase: string; externalId: string }>): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(input.externalId)) throw new McpEditingError("DELIVERY_PHASE_INVALID", "Provider external identifier is invalid");
    await this.#database.withScope(scope(this.#context), async (client) => {
      await lock(client, this.#context, input);
      const existing = await phase(client, this.#context, input, "completed");
      const prior = externalId(existing?.output_json);
      if (prior) {
        if (prior !== input.externalId) throw new McpEditingError("DELIVERY_PHASE_CONFLICT", "Provider phase already has another external identifier");
        return;
      }
      await checkpoint(client, this.#context, input.releaseId, key(input, "completed"), input.referenceHash, { referenceHash: input.referenceHash, phase: input.phase, externalId: input.externalId });
    });
  }

  public async externalId(input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): Promise<string | undefined> {
    return this.#database.withScope(scope(this.#context), async (client) => {
      const row = await phase(client, this.#context, input, "completed");
      const value = row?.output_json;
      return value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).externalId === "string" ? (value as Record<string, string>).externalId : undefined;
    });
  }

  public async resolve(input: Readonly<{ releaseId: string; referenceHash: string; phase: string; externalId: string; evidenceHash: string; observedAt: string }>): Promise<void> {
    const resolution = resolutionInput({ ...input, actor: this.#humanActor() });
    await this.#database.withScope(scope(this.#context), async (client) => {
      await lock(client, this.#context, input);
      if (await phase(client, this.#context, input, "completed")) return;
      if (!await phase(client, this.#context, input, "reserved")) throw new McpEditingError("DELIVERY_PHASE_MISSING", "Cannot resolve a provider phase that was not reserved");
      await checkpoint(client, this.#context, input.releaseId, resolutionKey(input, resolution), input.referenceHash, {
        referenceHash: input.referenceHash, phase: input.phase, externalId: resolution.externalId,
        actor: resolution.actor, evidenceHash: resolution.evidenceHash, observedAt: resolution.observedAt
      });
      if (this.#events) {
        const factory = new DomainEventFactory({ source: "urn:navocms:delivery", tenantId: this.#context.site.tenantId, siteId: this.#context.site.siteId, correlationId: input.releaseId, actor: { type: "human", id: resolution.actor.id } });
        await this.#events.append(factory.create({ type: "io.navocms.delivery.phase-resolved.v1", subject: `release:${input.releaseId}`, consequence: "G2", idempotencyKey: `delivery_phase_resolution:${sha256(`${input.referenceHash}:${input.phase}:${resolution.evidenceHash}`)}`, data: { phase: input.phase, referenceHash: input.referenceHash, externalId: input.externalId, evidenceHash: input.evidenceHash, observedAt: input.observedAt } }));
      }
    });
  }

  public async notApplied(input: Readonly<{ releaseId: string; referenceHash: string; phase: string; evidenceHash: string; observedAt: string }>): Promise<void> {
    const actor = this.#humanActor();
    if (!/^[a-f0-9]{64}$/.test(input.evidenceHash) || !Number.isFinite(Date.parse(input.observedAt))) throw new CloudflareDeliveryError("DELIVERY_PHASE_RESOLUTION_INVALID", "Not-applied evidence is invalid");
    await this.#database.withScope(scope(this.#context), async (client) => {
      await lock(client, this.#context, input);
      if (await phase(client, this.#context, input, "completed")) return;
      if (!await phase(client, this.#context, input, "reserved")) throw new McpEditingError("DELIVERY_PHASE_MISSING", "Cannot retry a provider phase that was not reserved");
      if (await phase(client, this.#context, input, "reserved-2")) throw new McpEditingError("DELIVERY_PHASE_NOT_APPLIED_INVALID", "The bounded recovery attempt was already consumed");
      await checkpoint(client, this.#context, input.releaseId, key(input, "not-applied"), input.referenceHash, { referenceHash: input.referenceHash, phase: input.phase, attempt: 1, actor, evidenceHash: input.evidenceHash, observedAt: input.observedAt });
      if (this.#events) {
        const factory = new DomainEventFactory({ source: "urn:navocms:delivery", tenantId: this.#context.site.tenantId, siteId: this.#context.site.siteId, correlationId: input.releaseId, actor: { type: "human", id: actor.id } });
        await this.#events.append(factory.create({ type: "io.navocms.delivery.phase-not-applied.v1", subject: `release:${input.releaseId}`, consequence: "G2", idempotencyKey: `delivery_phase_not_applied:${sha256(`${input.referenceHash}:${input.phase}:${input.evidenceHash}`)}`, data: { phase: input.phase, referenceHash: input.referenceHash, evidenceHash: input.evidenceHash, observedAt: input.observedAt } }));
      }
    });
  }

  public async attempt(input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): Promise<1 | 2> {
    return this.#database.withScope(scope(this.#context), async (client) => (await phase(client, this.#context, input, "reserved-2")) ? 2 : 1);
  }

  #humanActor(): Readonly<{ kind: "human"; id: string }> {
    const authority = this.#authority;
    if (!authority || authority.principal.kind !== "human" || authority.principal.id !== this.#context.principalId || !authority.permissions.includes("content:publish")) throw new McpEditingError("DELIVERY_PHASE_HUMAN_REQUIRED", "Delivery-phase resolution requires an authenticated human principal with content:publish");
    return Object.freeze({ kind: "human", id: authority.principal.id });
  }

  public async resolution(input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): Promise<DeliveryPhaseResolution | undefined> {
    return this.#database.withScope(scope(this.#context), async (client) => {
      const row = (await client.query<{ output_json: unknown }>(
        `SELECT checkpoint.output_json FROM navocms.workflow_checkpoints checkpoint
           JOIN navocms.workflow_runs run ON run.id = checkpoint.run_id AND run.tenant_id = checkpoint.tenant_id AND run.site_id = checkpoint.site_id
          WHERE run.tenant_id = $1 AND run.site_id = $2 AND run.release_id = $3 AND checkpoint.step_key LIKE $4
          ORDER BY checkpoint.completed_at DESC LIMIT 1`,
        [this.#context.site.tenantId, this.#context.site.siteId, input.releaseId, `${key(input, "resolution")}.%`]
      )).rows[0];
      return row ? storedResolution(row.output_json) : undefined;
    });
  }
}

function scope(context: RepositoryContext) { return { tenantId: context.site.tenantId, siteId: context.site.siteId, principalId: context.principalId }; }
function key(input: Readonly<{ referenceHash: string; phase: string }>, state: "reserved" | "reserved-2" | "completed" | "resolution" | "not-applied"): string { return `delivery.${sha256(`${input.referenceHash}:${input.phase}`)}.${state}`; }
function resolutionKey(input: Readonly<{ referenceHash: string; phase: string }>, resolution: DeliveryPhaseResolution): string { return `delivery.${sha256(`${input.referenceHash}:${input.phase}`)}.resolution.${sha256(`${resolution.externalId}:${resolution.actor.id}:${resolution.evidenceHash}:${resolution.observedAt}`)}`; }

async function phase(client: SqlClient, context: RepositoryContext, input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>, state: "reserved" | "reserved-2" | "completed" | "not-applied"): Promise<{ output_json: unknown } | undefined> {
  return (await client.query<{ output_json: unknown }>(
    `SELECT checkpoint.output_json FROM navocms.workflow_checkpoints checkpoint
       JOIN navocms.workflow_runs run ON run.id = checkpoint.run_id AND run.tenant_id = checkpoint.tenant_id AND run.site_id = checkpoint.site_id
      WHERE run.tenant_id = $1 AND run.site_id = $2 AND run.release_id = $3 AND checkpoint.step_key = $4
      ORDER BY checkpoint.completed_at DESC LIMIT 1`,
    [context.site.tenantId, context.site.siteId, input.releaseId, key(input, state)]
  )).rows[0];
}

async function checkpoint(client: SqlClient, context: RepositoryContext, releaseId: string, step: string, inputHash: string, output: object): Promise<void> {
  let run = (await client.query<{ id: string }>(
    `SELECT id FROM navocms.workflow_runs WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
    [context.site.tenantId, context.site.siteId, releaseId]
  )).rows[0];
  if (!run) {
    const release = (await client.query<{ workflow_key: string }>(
      `SELECT workflow_key FROM navocms.release_candidates WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
      [context.site.tenantId, context.site.siteId, releaseId]
    )).rows[0];
    if (!release) throw new McpEditingError("RELEASE_NOT_FOUND", "Release was not found in the authorized site");
    run = { id: randomUUID() };
    await client.query(`INSERT INTO navocms.workflow_runs (id, tenant_id, site_id, release_id, workflow_key, status, current_step) VALUES ($1,$2,$3,$4,$5,'running','delivery.phase')`, [run.id, context.site.tenantId, context.site.siteId, releaseId, release.workflow_key]);
  }
  await client.query(`INSERT INTO navocms.workflow_checkpoints (id, tenant_id, site_id, run_id, step_key, input_hash, output_json) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`, [randomUUID(), context.site.tenantId, context.site.siteId, run.id, step, inputHash, JSON.stringify(output)]);
}

async function lock(client: SqlClient, context: RepositoryContext, input: Readonly<{ releaseId: string; referenceHash: string; phase: string }>): Promise<void> {
  // withScope is one PostgreSQL transaction, so this lock serializes the
  // read-then-reserve sequence across process restarts without a new table.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${context.site.tenantId}:${context.site.siteId}:${input.releaseId}:${input.referenceHash}:${input.phase}`]);
}

function externalId(value: unknown): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).externalId === "string" ? (value as Record<string, string>).externalId : undefined;
}

function resolutionInput(input: Readonly<{ externalId: unknown; actor: unknown; evidenceHash: unknown; observedAt: unknown }>): DeliveryPhaseResolution {
  const actor = input.actor && typeof input.actor === "object" && !Array.isArray(input.actor) ? input.actor as Record<string, unknown> : undefined;
  if (typeof input.externalId !== "string" || typeof input.evidenceHash !== "string" || typeof input.observedAt !== "string" || !actor || actor.kind !== "human" || typeof actor.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(input.externalId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(actor.id) || !/^[a-f0-9]{64}$/.test(input.evidenceHash) || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new CloudflareDeliveryError("DELIVERY_PHASE_RESOLUTION_INVALID", "Human delivery-phase resolution is invalid");
  }
  return Object.freeze({ externalId: input.externalId, actor: Object.freeze({ kind: "human", id: actor.id }), evidenceHash: input.evidenceHash, observedAt: input.observedAt });
}

function storedResolution(value: unknown): DeliveryPhaseResolution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  try {
    return resolutionInput({ externalId: row.externalId, actor: row.actor as { kind: "human"; id: string }, evidenceHash: row.evidenceHash, observedAt: row.observedAt });
  } catch { return undefined; }
}
