import { createRemoteJwksProvider, OidcJwtVerifier } from "@navocms/security";
import {
  PostgresDatabase,
  PostgresEventStore,
  PostgresIdentityResolver,
  PostgresIdempotencyStore,
  PostgresRuntimePolicyGuard,
  requireDatabaseUrl
} from "@navocms/persistence-postgres";

import { createMcpHttpServer } from "./http.js";
import { environmentInteger } from "./config.js";
import { PostgresEditingRepository } from "./postgres-repository.js";
import { PostgresReleaseWorkflowRepository } from "./postgres-release-repository.js";
import { EmbeddedReleaseProvider, InMemoryReleaseWorkflowRepository } from "./release-repository.js";
import { InMemoryEditingRepository } from "./repository.js";
import { McpEditingService, type IdempotencyStore } from "./service.js";
import { bootPinnedProductionPluginHost } from "./production-profile.js";

const resource = required("NAVOCMS_MCP_RESOURCE");
const issuer = required("NAVOCMS_OIDC_ISSUER");
const jwksUrl = required("NAVOCMS_OIDC_JWKS_URL");
const runtimeMode = process.env.NAVOCMS_RUNTIME_MODE ?? (process.env.NODE_ENV === "production" ? "production" : "development");
const pluginHost = runtimeMode === "production" ? await bootPinnedProductionPluginHost() : undefined;
const databaseUrl = process.env.NAVOCMS_DATABASE_URL;
const deploymentScope = Object.freeze({
  tenantId: databaseUrl ? required("NAVOCMS_TENANT_ID") : required("NAVOCMS_DEVELOPMENT_TENANT_ID"),
  siteId: databaseUrl ? required("NAVOCMS_SITE_ID") : required("NAVOCMS_DEVELOPMENT_SITE_ID")
});
const environmentKey = runtimeMode === "production" ? required("NAVOCMS_ENVIRONMENT") : (process.env.NAVOCMS_ENVIRONMENT ?? runtimeMode);
const deploymentEnvironmentKey = process.env.NAVOCMS_ENVIRONMENT_KEY ?? "default";
const database = databaseUrl ? new PostgresDatabase({
  connectionString: requireDatabaseUrl(databaseUrl),
  applicationName: `navocms-mcp-${environmentKey}`,
  maxConnections: environmentInteger("NAVOCMS_DATABASE_POOL_MAX", 8, 100),
  ...(runtimeMode === "production" ? {
    readinessScope: {
      ...deploymentScope,
      principalId: required("NAVOCMS_RUNTIME_PRINCIPAL_ID"),
      environmentKey: deploymentEnvironmentKey
    }
  } : {})
}) : undefined;
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
      environmentKey,
      previewBaseUrl: process.env.NAVOCMS_PREVIEW_BASE_URL ?? new URL(resource).origin,
      previewTtlSeconds: environmentInteger("NAVOCMS_PREVIEW_TTL_SECONDS", 3600, 604_800),
      approvalTtlSeconds: environmentInteger("NAVOCMS_APPROVAL_TTL_SECONDS", 900, 86_400),
      approvalPolicyVersion: process.env.NAVOCMS_APPROVAL_POLICY_VERSION ?? "navocms.release-approval.v1"
    }, database, new PostgresRuntimePolicyGuard(database)
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
      environmentKey,
      previewBaseUrl: process.env.NAVOCMS_PREVIEW_BASE_URL ?? new URL(resource).origin,
      previewTtlSeconds: environmentInteger("NAVOCMS_PREVIEW_TTL_SECONDS", 3600, 604_800),
      approvalTtlSeconds: environmentInteger("NAVOCMS_APPROVAL_TTL_SECONDS", 900, 86_400),
      approvalPolicyVersion: process.env.NAVOCMS_APPROVAL_POLICY_VERSION ?? "navocms.release-approval.v1"
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
  ...(database ? {
    readiness: async () => ({
      ready: await database.ready() && (pluginHost?.state === "healthy"),
      ...(pluginHost ? { pluginHost: pluginHost.status() } : {})
    })
  } : {})
});
const port = Number(process.env.PORT ?? "8788");
const host = process.env.NAVOCMS_HOST ?? (runtimeMode === "development" ? "127.0.0.1" : "0.0.0.0");
server.listen(port, host, () => {
  process.stdout.write(`NavoCMS MCP server listening on ${host}:${port} (${runtimeMode})\n`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void (pluginHost ? pluginHost.shutdown() : Promise.resolve())
        .finally(() => database?.close())
        .finally(() => process.exit(0));
    });
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
