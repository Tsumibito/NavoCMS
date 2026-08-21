import { readFile } from "node:fs/promises";

import { createApi } from "../apps/api/dist/app.js";
import { contracts } from "../packages/contracts/dist/index.js";
import { createNoopService } from "../plugins/noop-service/dist/app.js";

const pluginFixture = JSON.parse(
  await readFile(new URL("../examples/plugins/media-imgproxy.plugin.json", import.meta.url), "utf8")
);
contracts.plugin.parse(pluginFixture);

const api = createApi();
const health = await api.inject({ method: "GET", url: "/health" });
if (health.statusCode !== 200 || health.json().product !== "NavoCMS") {
  throw new Error("Built API health smoke failed");
}
await api.close();

const service = createNoopService({ token: "build-smoke-token-0001" });
const serviceHealth = await service.inject({ method: "GET", url: "/health" });
if (serviceHealth.statusCode !== 200) throw new Error("Built no-op service health smoke failed");
await service.close();

console.log("Built contracts, API, and service plugin smoke checks pass.");
