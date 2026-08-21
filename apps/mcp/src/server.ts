import { createRemoteJwksProvider, OidcJwtVerifier } from "@navocms/security";
import {
  PostgresDatabase,
  PostgresEventStore,
  PostgresIdempotencyStore,
  requireDatabaseUrl
} from "@navocms/persistence-postgres";

import { createMcpHttpServer } from "./http.js";
import { PostgresEditingRepository } from "./postgres-repository.js";
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
  maxConnections: integer("NAVOCMS_DATABASE_POOL_MAX", 8)
}) : undefined;

let service: McpEditingService;
if (database) {
  service = new McpEditingService(
    new PostgresEditingRepository(database),
    new PostgresEventStore(database),
    new PostgresIdempotencyStore(database) as IdempotencyStore
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
  service = new McpEditingService(repository);
}

const verifier = new OidcJwtVerifier({
  issuer,
  audience: resource,
  jwks: createRemoteJwksProvider(jwksUrl)
});
const server = createMcpHttpServer({
  service,
  verifier,
  resource,
  authorizationServers: [issuer],
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

function integer(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) throw new Error(`${name} must be an integer from 1 to 100`);
  return parsed;
}
