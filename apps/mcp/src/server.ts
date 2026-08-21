import { createRemoteJwksProvider, OidcJwtVerifier } from "@navocms/security";

import { createMcpHttpServer } from "./http.js";
import { InMemoryEditingRepository } from "./repository.js";
import { McpEditingService } from "./service.js";

const resource = required("NAVOCMS_MCP_RESOURCE");
const issuer = required("NAVOCMS_OIDC_ISSUER");
const jwksUrl = required("NAVOCMS_OIDC_JWKS_URL");
const repository = new InMemoryEditingRepository();
const configuredTenant = required("NAVOCMS_DEVELOPMENT_TENANT_ID");
const configuredSite = required("NAVOCMS_DEVELOPMENT_SITE_ID");
repository.registerSite({
  tenantId: configuredTenant,
  siteId: configuredSite,
  name: process.env.NAVOCMS_DEVELOPMENT_SITE_NAME ?? "NavoCMS development site",
  primaryLocale: process.env.NAVOCMS_DEVELOPMENT_PRIMARY_LOCALE ?? "en",
  locales: (process.env.NAVOCMS_DEVELOPMENT_LOCALES ?? "en").split(",").map((locale) => locale.trim())
});

const verifier = new OidcJwtVerifier({
  issuer,
  audience: resource,
  jwks: createRemoteJwksProvider(jwksUrl)
});
const server = createMcpHttpServer({
  service: new McpEditingService(repository),
  verifier,
  resource,
  authorizationServers: [issuer]
});
const port = Number(process.env.PORT ?? "8788");
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`NavoCMS MCP development server listening on 127.0.0.1:${port}\n`);
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
