import { randomUUID } from "node:crypto";

import { SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";

import { DomainEventFactory, withEventSpan } from "./index.js";

describe("OpenTelemetry correlation", () => {
  it("projects event identity into a span and closes it", async () => {
    const factory = new DomainEventFactory({
      source: "/test/tracing",
      tenantId: randomUUID(),
      siteId: randomUUID(),
      correlationId: randomUUID(),
      actor: { type: "system", id: "test" }
    });
    const event = factory.create({
      type: "io.navocms.test.requested.v1",
      consequence: "G1",
      idempotencyKey: "trace-operation-0001",
      data: { phase: "requested" }
    });
    const setStatus = vi.fn();
    const end = vi.fn();
    const span = {
      setStatus,
      end,
      recordException: vi.fn()
    } as unknown as Span;
    let attributes: Readonly<Record<string, unknown>> | undefined;
    const tracer = {
      startActiveSpan: async <T>(
        _name: string,
        options: { attributes?: Readonly<Record<string, unknown>> },
        operation: (activeSpan: Span) => T
      ): Promise<Awaited<T>> => {
        attributes = options.attributes;
        return await operation(span);
      }
    } as unknown as Tracer;

    await expect(withEventSpan("test.operation", event, async () => "done", tracer)).resolves.toBe("done");
    expect(attributes).toMatchObject({
      "navocms.event_id": event.id,
      "navocms.correlation_id": event.navocorrelationid,
      "navocms.tenant_id": event.navotenantid,
      "navocms.site_id": event.navositeid
    });
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(end).toHaveBeenCalledOnce();
  });
});
