import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DomainEventFactory, InMemoryEventStore, projectTrajectory } from "./index.js";

function factory(): DomainEventFactory {
  return new DomainEventFactory(
    {
      source: "/test/kernel",
      tenantId: randomUUID(),
      siteId: randomUUID(),
      correlationId: randomUUID(),
      actor: { type: "agent", id: "test-agent" }
    },
    { now: () => new Date("2026-08-21T12:00:00.000Z") }
  );
}

describe("Event Ledger", () => {
  it("stores immutable CloudEvents and reconstructs a trajectory", async () => {
    const events = factory();
    const store = new InMemoryEventStore();
    await store.append(
      events.create({
        type: "io.navocms.workflow.requested.v1",
        consequence: "G1",
        idempotencyKey: "workflow:request:0001",
        data: { phase: "requested" }
      })
    );
    await store.append(
      events.create({
        type: "io.navocms.workflow.applied.v1",
        consequence: "G1",
        idempotencyKey: "workflow:apply:0001",
        data: { phase: "applied" }
      })
    );
    await store.append(
      events.create({
        type: "io.navocms.workflow.verified.v1",
        consequence: "G0",
        data: { phase: "verified" }
      })
    );

    const records = await store.query({});
    expect(records).toHaveLength(3);
    expect(Object.isFrozen(records[0]?.event)).toBe(true);
    expect(projectTrajectory(records)).toMatchObject({ phase: "verified", eventIds: expect.any(Array) });
  });

  it("rejects duplicate idempotency keys within a site", async () => {
    const events = factory();
    const store = new InMemoryEventStore();
    const first = events.create({
      type: "io.navocms.workflow.requested.v1",
      consequence: "G1",
      idempotencyKey: "same-operation-key",
      data: { phase: "requested" }
    });
    await store.append(first);
    await expect(
      store.append(
        events.create({
          type: "io.navocms.workflow.requested.v1",
          consequence: "G1",
          idempotencyKey: "same-operation-key",
          data: { phase: "requested" }
        })
      )
    ).rejects.toMatchObject({ code: "EVENT_IDEMPOTENCY_DUPLICATE" });
  });

  it("rejects invalid trajectory transitions", async () => {
    const events = factory();
    const store = new InMemoryEventStore();
    await store.append(
      events.create({
        type: "io.navocms.workflow.requested.v1",
        consequence: "G1",
        idempotencyKey: "invalid:request:1",
        data: { phase: "requested" }
      })
    );
    await store.append(
      events.create({
        type: "io.navocms.workflow.verified.v1",
        consequence: "G0",
        data: { phase: "verified" }
      })
    );

    const records = await store.query({});
    expect(() => projectTrajectory(records)).toThrowError(
      expect.objectContaining({ code: "TRAJECTORY_TRANSITION_INVALID" })
    );
  });
});
