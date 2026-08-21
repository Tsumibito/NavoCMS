import { SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import type { DomainEvent } from "@navocms/contracts";

export async function withEventSpan<T>(
  name: string,
  event: DomainEvent,
  operation: () => Promise<T>,
  tracer: Tracer = trace.getTracer("@navocms/kernel")
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    {
      attributes: {
        "navocms.event_id": event.id,
        "navocms.event_type": event.type,
        "navocms.tenant_id": event.navotenantid,
        "navocms.site_id": event.navositeid,
        "navocms.correlation_id": event.navocorrelationid,
        "navocms.consequence": event.navoconsequence
      }
    },
    async (span) => {
      try {
        const result = await operation();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    }
  );
}
