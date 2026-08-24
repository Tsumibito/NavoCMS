import { describe, expect, it } from "vitest";
import { type Permission } from "@navocms/security";

import { createMcpHttpServer } from "./http.js";
import { McpEditingService } from "./service.js";

describe("MCP OAuth metadata", () => {
  it("advertises only the scopes enabled for a deployment", async () => {
    const enabledScopes: readonly Permission[] = ["content:read", "content:draft", "content:publish"];
    const server = createMcpHttpServer({
      service: {} as McpEditingService,
      verifier: { verify: async () => { throw new Error("not called"); } },
      resource: "https://cms.example.test/mcp",
      authorizationServers: ["https://identity.example.test"],
      scopes: enabledScopes
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/.well-known/oauth-protected-resource/mcp`);
      await expect(response.json()).resolves.toMatchObject({ scopes_supported: enabledScopes });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
