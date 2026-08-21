import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createApi } from "./app.js";

async function fixture(relativePath: string): Promise<unknown> {
  const url = new URL(`../../../examples/${relativePath}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}

describe("NavoCMS API shell", () => {
  it("reports liveness separately from plugin readiness", async () => {
    const app = createApi();
    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", product: "NavoCMS" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ state: "idle" });
    await app.close();
  });

  it("validates public plugin contracts with bounded errors", async () => {
    const app = createApi();
    const valid = await app.inject({
      method: "POST",
      url: "/v1/contracts/plugins/validate",
      payload: (await fixture("plugins/media-imgproxy.plugin.json")) as Record<string, unknown>
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/contracts/plugins/validate",
      payload: { kind: "PluginManifest" }
    });

    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ valid: true, id: "navocms.media.imgproxy" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "CONTRACT_VALIDATION_FAILED" });
    await app.close();
  });
});
