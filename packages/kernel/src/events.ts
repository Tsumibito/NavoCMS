import { randomUUID } from "node:crypto";

import { contracts, type ConsequenceLevel, type DomainEvent, type EventActor } from "@navocms/contracts";

import { KernelError } from "./errors.js";

export interface LedgerRecord<TData extends Record<string, unknown> = Record<string, unknown>> {
  readonly sequence: number;
  readonly event: DomainEvent<TData>;
}

export interface EventQuery {
  readonly tenantId?: string;
  readonly siteId?: string;
  readonly correlationId?: string;
  readonly type?: string;
}

export interface EventStore {
  append<TData extends Record<string, unknown>>(event: DomainEvent<TData>): Promise<LedgerRecord<TData>>;
  query(query: EventQuery): Promise<readonly LedgerRecord[]>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export class InMemoryEventStore implements EventStore {
  readonly #records: LedgerRecord[] = [];
  readonly #eventIds = new Set<string>();
  readonly #idempotencyKeys = new Set<string>();

  public async append<TData extends Record<string, unknown>>(
    eventInput: DomainEvent<TData>
  ): Promise<LedgerRecord<TData>> {
    const event = contracts.event.parse(structuredClone(eventInput)) as DomainEvent<TData>;
    if (this.#eventIds.has(event.id)) {
      throw new KernelError("EVENT_ID_DUPLICATE", `Event ID ${event.id} already exists`, { eventId: event.id });
    }
    const idempotencyIdentity = event.navoidempotencykey
      ? `${event.navotenantid}:${event.navositeid}:${event.navoidempotencykey}`
      : undefined;
    if (idempotencyIdentity && this.#idempotencyKeys.has(idempotencyIdentity)) {
      throw new KernelError("EVENT_IDEMPOTENCY_DUPLICATE", "Event idempotency key already exists", {
        siteId: event.navositeid
      });
    }
    const immutableEvent = deepFreeze(event);
    const record = deepFreeze({ sequence: this.#records.length + 1, event: immutableEvent });
    this.#eventIds.add(event.id);
    if (idempotencyIdentity) this.#idempotencyKeys.add(idempotencyIdentity);
    this.#records.push(record);
    return record;
  }

  public async query(query: EventQuery): Promise<readonly LedgerRecord[]> {
    return Object.freeze(
      this.#records.filter(({ event }) => {
        if (query.tenantId && event.navotenantid !== query.tenantId) return false;
        if (query.siteId && event.navositeid !== query.siteId) return false;
        if (query.correlationId && event.navocorrelationid !== query.correlationId) return false;
        if (query.type && event.type !== query.type) return false;
        return true;
      })
    );
  }
}

export interface EventFactoryContext {
  readonly source: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly correlationId: string;
  readonly actor: EventActor;
  readonly causationId?: string;
}

export interface CreateEventInput<TData extends Record<string, unknown>> {
  readonly type: string;
  readonly subject?: string;
  readonly consequence: ConsequenceLevel;
  readonly idempotencyKey?: string;
  readonly data: TData;
}

export class DomainEventFactory {
  readonly #context: EventFactoryContext;
  readonly #now: () => Date;
  readonly #id: () => string;

  public constructor(context: EventFactoryContext, options: { now?: () => Date; id?: () => string } = {}) {
    this.#context = Object.freeze({ ...context, actor: Object.freeze({ ...context.actor }) });
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
  }

  public create<TData extends Record<string, unknown>>(input: CreateEventInput<TData>): DomainEvent<TData> {
    if (input.consequence !== "G0" && !input.idempotencyKey) {
      throw new KernelError("EVENT_IDEMPOTENCY_REQUIRED", `${input.consequence} event requires an idempotency key`);
    }
    return contracts.event.parse({
      specversion: "1.0",
      id: this.#id(),
      source: this.#context.source,
      type: input.type,
      ...(input.subject ? { subject: input.subject } : {}),
      time: this.#now().toISOString(),
      datacontenttype: "application/json",
      navotenantid: this.#context.tenantId,
      navositeid: this.#context.siteId,
      navocorrelationid: this.#context.correlationId,
      ...(this.#context.causationId ? { navocausationid: this.#context.causationId } : {}),
      navoconsequence: input.consequence,
      ...(input.idempotencyKey ? { navoidempotencykey: input.idempotencyKey } : {}),
      navoschemaversion: 1,
      navoactor: this.#context.actor,
      data: input.data
    }) as DomainEvent<TData>;
  }
}

export const TRAJECTORY_PHASES = [
  "requested",
  "proposed",
  "applied",
  "verified",
  "failed",
  "rolled_back"
] as const;

export type TrajectoryPhase = (typeof TRAJECTORY_PHASES)[number];

export interface TrajectoryProjection {
  readonly correlationId: string;
  readonly phase: TrajectoryPhase;
  readonly eventIds: readonly string[];
  readonly updatedAt: string;
}

const transitions: Readonly<Record<TrajectoryPhase, readonly TrajectoryPhase[]>> = {
  requested: ["proposed", "applied", "failed"],
  proposed: ["applied", "failed"],
  applied: ["verified", "failed", "rolled_back"],
  verified: ["rolled_back"],
  failed: [],
  rolled_back: []
};

function eventPhase(event: DomainEvent): TrajectoryPhase {
  const phase = event.data.phase;
  if (typeof phase !== "string" || !TRAJECTORY_PHASES.includes(phase as TrajectoryPhase)) {
    throw new KernelError("TRAJECTORY_PHASE_INVALID", `Event ${event.id} has no valid trajectory phase`, {
      eventId: event.id
    });
  }
  return phase as TrajectoryPhase;
}

export function projectTrajectory(records: readonly LedgerRecord[]): TrajectoryProjection {
  if (records.length === 0) throw new KernelError("TRAJECTORY_EMPTY", "Cannot project an empty trajectory");
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence);
  const first = ordered[0]!;
  const correlationId = first.event.navocorrelationid;
  let phase = eventPhase(first.event);
  if (phase !== "requested") {
    throw new KernelError("TRAJECTORY_INITIAL_PHASE", `Trajectory must start as requested, got ${phase}`);
  }

  for (const record of ordered.slice(1)) {
    if (record.event.navocorrelationid !== correlationId) {
      throw new KernelError("TRAJECTORY_CORRELATION_MISMATCH", "Trajectory contains multiple correlation IDs");
    }
    const next = eventPhase(record.event);
    if (!transitions[phase].includes(next)) {
      throw new KernelError("TRAJECTORY_TRANSITION_INVALID", `Invalid trajectory transition ${phase} -> ${next}`, {
        from: phase,
        to: next,
        eventId: record.event.id
      });
    }
    phase = next;
  }

  const last = ordered.at(-1)!;
  return Object.freeze({
    correlationId,
    phase,
    eventIds: Object.freeze(ordered.map(({ event }) => event.id)),
    updatedAt: last.event.time
  });
}
