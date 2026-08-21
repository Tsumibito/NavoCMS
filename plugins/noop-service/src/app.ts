import { randomUUID, timingSafeEqual } from "node:crypto";

import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

export interface NoopOptions {
  readonly token: string;
  readonly maxEntries?: number;
  readonly logger?: FastifyServerOptions["logger"];
}

interface NoopRequest {
  readonly message: string;
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createNoopService(options: NoopOptions): FastifyInstance {
  if (options.token.length < 16) throw new Error("No-op service token must contain at least 16 characters");
  const maxEntries = options.maxEntries ?? 1_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16_384 });
  const results = new Map<string, Readonly<Record<string, unknown>>>();

  app.get("/health", async () => ({
    status: "ok",
    pluginId: "navocms.example.noop-service",
    version: "0.1.0",
    provides: ["test.noop@1"]
  }));

  app.post<{ Body: NoopRequest }>(
    "/v1/noop",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["message"],
          properties: { message: { type: "string", minLength: 1, maxLength: 1_000 } }
        }
      },
      preHandler: async (request, reply) => {
        const authorization = request.headers.authorization;
        const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
        if (!tokensEqual(supplied, options.token)) {
          return reply.status(401).send({ error: "UNAUTHORIZED" });
        }
      }
    },
    async (request, reply) => {
      const key = request.headers["x-navocms-idempotency-key"];
      if (typeof key !== "string" || key.length < 16 || key.length > 200) {
        return reply.status(400).send({ error: "IDEMPOTENCY_KEY_REQUIRED" });
      }
      const prior = results.get(key);
      if (prior) return { ...prior, replayed: true };
      if (results.size >= maxEntries) {
        return reply.status(503).send({ error: "IDEMPOTENCY_STORE_CAPACITY" });
      }
      const result = Object.freeze({
        requestId: randomUUID(),
        message: request.body.message,
        processed: true,
        replayed: false
      });
      results.set(key, result);
      return result;
    }
  );

  return app;
}
