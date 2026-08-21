import { describe, expect, it } from "vitest";

import { createNoopService } from "./app.js";

const token = "test-token-at-least-16-characters";

describe("external no-op service plugin", () => {
  it("does not import the kernel and enforces service authentication", async () => {
    const app = createNoopService({ token });
    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/noop",
      headers: { "x-navocms-idempotency-key": "noop-operation-0001" },
      payload: { message: "hello" }
    });
    expect(unauthorized.statusCode).toBe(401);
    await app.close();
  });

  it("replays the same result for an idempotency key", async () => {
    const app = createNoopService({ token });
    const request = {
      method: "POST" as const,
      url: "/v1/noop",
      headers: {
        authorization: `Bearer ${token}`,
        "x-navocms-idempotency-key": "noop-operation-0002"
      },
      payload: { message: "hello" }
    };
    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ requestId: first.json().requestId, replayed: true });
    await app.close();
  });

  it("bounds its in-memory idempotency reference store", async () => {
    const app = createNoopService({ token, maxEntries: 1 });
    const invoke = (key: string) =>
      app.inject({
        method: "POST",
        url: "/v1/noop",
        headers: { authorization: `Bearer ${token}`, "x-navocms-idempotency-key": key },
        payload: { message: "hello" }
      });

    expect((await invoke("noop-capacity-0001")).statusCode).toBe(200);
    expect((await invoke("noop-capacity-0002")).statusCode).toBe(503);
    await app.close();
  });
});
