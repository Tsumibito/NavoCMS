import { createRemoteJwksProvider, OidcJwtVerifier } from "@navocms/security";
import {
  PostgresDatabase,
  PostgresEventStore,
  PostgresIdentityResolver,
  PostgresIdempotencyStore,
  requireDatabaseUrl
} from "@navocms/persistence-postgres";

import { createMcpHttpServer } from "./http.js";
import { environmentInteger } from "./config.js";
import { PostgresEditingRepository } from "./postgres-repository.js";
import { PostgresReleaseWorkflowRepository } from "./postgres-release-repository.js";
import { EmbeddedReleaseProvider, InMemoryReleaseWorkflowRepository } from "./release-repository.js";
import { InMemoryEditingRepository } from "./repository.js";
import { McpEditingService, type IdempotencyStore } from "./service.js";

const resource = required("NAVOCMS_MCP_RESOURCE");
const issuer = required("NAVOCMS_OIDC_ISSUER");
const jwksUrl = required("NAVOCMS_OIDC_JWKS_URL");
const runtimeMode = process.env.NAVOCMS_RUNTIME_MODE ?? (process.env.NODE_ENV === "production" ? "production" : "development");
const databaseUrl = process.env.NAVOCMS_DATABASE_URL;
const database = databaseUrl ? new PostgresDatabase({
  connectionString: requireDatabaseUrl(databaseUrl),
  applicationName: `navocms-mcp-${process.env.NAVOCMS_ENVIRONMENT ?? runtimeMode}`,
  maxConnections: environmentInteger("NAVOCMS_DATABASE_POOL_MAX", 8, 100)
}) : undefined;
const deploymentScope = Object.freeze({
  tenantId: database ? required("NAVOCMS_TENANT_ID") : required("NAVOCMS_DEVELOPMENT_TENANT_ID"),
  siteId: database ? required("NAVOCMS_SITE_ID") : required("NAVOCMS_DEVELOPMENT_SITE_ID")
});
const identityResolver = database ? new PostgresIdentityResolver(database, deploymentScope) : undefined;

let service: McpEditingService;
if (database) {
  service = new McpEditingService(
    new PostgresEditingRepository(database),
    new PostgresEventStore(database),
    new PostgresIdempotencyStore(database) as IdempotencyStore,
    new PostgresReleaseWorkflowRepository(database),
    new EmbeddedReleaseProvider(),
    {
      environmentKey: process.env.NAVOCMS_ENVIRONMENT ?? runtimeMode,
      previewBaseUrl: process.env.NAVOCMS_PREVIEW_BASE_URL ?? new URL(resource).origin,
      previewTtlSeconds: environmentInteger("NAVOCMS_PREVIEW_TTL_SECONDS", 3600, 604_800)
    }
  );
} else {
  if (runtimeMode !== "development") throw new Error("NAVOCMS_DATABASE_URL is required outside development mode");
  const repository = new InMemoryEditingRepository();
  repository.registerSite({
    tenantId: required("NAVOCMS_DEVELOPMENT_TENANT_ID"),
    siteId: required("NAVOCMS_DEVELOPMENT_SITE_ID"),
    name: process.env.NAVOCMS_DEVELOPMENT_SITE_NAME ?? "NavoCMS development site",
    primaryLocale: process.env.NAVOCMS_DEVELOPMENT_PRIMARY_LOCALE ?? "en",
    locales: (process.env.NAVOCMS_DEVELOPMENT_LOCALES ?? "en").split(",").map((locale) => locale.trim())
  });
  service = new McpEditingService(
    repository,
    undefined,
    undefined,
    new InMemoryReleaseWorkflowRepository(required("NAVOCMS_DEVELOPMENT_ENVIRONMENT_ID")),
    new EmbeddedReleaseProvider(),
    {
      environmentKey: process.env.NAVOCMS_ENVIRONMENT ?? "development",
      previewBaseUrl: process.env.NAVOCMS_PREVIEW_BASE_URL ?? new URL(resource).origin,
      previewTtlSeconds: environmentInteger("NAVOCMS_PREVIEW_TTL_SECONDS", 3600, 604_800)
    }
  );
}

const verifier = new OidcJwtVerifier({
  issuer,
  audience: resource,
  deploymentScope,
  jwks: createRemoteJwksProvider(jwksUrl)
});
const server = createMcpHttpServer({
  service,
  verifier,
  resource,
  authorizationServers: [issuer],
  scopes: ["openid"],
  ...(identityResolver ? { resolveAuthorization: (token) => identityResolver.resolve(token) } : {}),
  ...(database ? { readiness: () => database.ready() } : {})
});
const port = Number(process.env.PORT ?? "8788");
const host = process.env.NAVOCMS_HOST ?? (runtimeMode === "development" ? "127.0.0.1" : "0.0.0.0");
server.listen(port, host, () => {
  process.stdout.write(`NavoCMS MCP server listening on ${host}:${port} (${runtimeMode})\n`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void database?.close().finally(() => process.exit(0));
    });
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
