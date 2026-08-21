import { readFile } from "node:fs/promises";

import { createApi } from "../apps/api/dist/app.js";
import { createMcpServer, InMemoryEditingRepository, McpEditingService } from "../apps/mcp/dist/index.js";
import { contracts } from "../packages/contracts/dist/index.js";
import { canonicalMarkdown } from "../packages/content/dist/index.js";
import { compileDesignSystem } from "../packages/design/dist/index.js";
import { createAstroDesignAdapter } from "../packages/design-astro/dist/index.js";
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
const designFixture = JSON.parse(
  await readFile(new URL("../examples/design-systems/tidal-signal.design-system.json", import.meta.url), "utf8")
);
const compiledDesign = compileDesignSystem(designFixture);
createAstroDesignAdapter(compiledDesign, [
  { id: "signal-button", module: "./SignalButton.astro" },
  { id: "story-card", module: "./StoryCard.astro" },
  { id: "section-shell", module: "./SectionShell.astro" }
]);
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

const mcpRepository = new InMemoryEditingRepository();
mcpRepository.registerSite({
  tenantId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  name: "Build smoke",
  primaryLocale: "en",
  locales: ["en"]
});
const mcp = createMcpServer(new McpEditingService(mcpRepository), {
  authorization: {
    tenantId: "11111111-1111-4111-8111-111111111111",
    siteId: "22222222-2222-4222-8222-222222222222",
    principal: { id: "build-smoke", kind: "agent", issuer: "https://identity.example", subject: "build-smoke" },
    layers: [{ name: "principal", permissions: ["content:read"] }]
  }
});
if (typeof mcp.connect !== "function") throw new Error("Built MCP server smoke failed");

const service = createNoopService({ token: "build-smoke-token-0001" });
const serviceHealth = await service.inject({ method: "GET", url: "/health" });
if (serviceHealth.statusCode !== 200) throw new Error("Built no-op service health smoke failed");
await service.close();

console.log("Built contracts, API, MCP, and service plugin smoke checks pass.");
