import { readFile } from "node:fs/promises";

import { createApi } from "../apps/api/dist/app.js";
import { contracts } from "../packages/contracts/dist/index.js";
import { canonicalMarkdown } from "../packages/content/dist/index.js";
import { withDatabaseScope } from "../packages/persistence-postgres/dist/index.js";
import { protectedResourceMetadata } from "../packages/security/dist/index.js";
import { createNoopService } from "../plugins/noop-service/dist/app.js";

const pluginFixture = JSON.parse(
  await readFile(new URL("../examples/plugins/media-imgproxy.plugin.json", import.meta.url), "utf8")
);
contracts.plugin.parse(pluginFixture);
if (canonicalMarkdown("# Portable content") !== "# Portable content\n") {
  throw new Error("Built content engine smoke failed");
}
protectedResourceMetadata({
  resource: "https://api.navocms.com",
  authorizationServers: ["https://identity.example"],
  scopes: ["content:read"]
});
if (typeof withDatabaseScope !== "function") throw new Error("Built PostgreSQL adapter smoke failed");

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
