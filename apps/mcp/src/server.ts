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
import { environmentInteger, environmentRolePermissions } from "./config.js";
import { PostgresEditingRepository } from "./postgres-repository.js";
import { PostgresMediaRepository } from "@navocms/media";
import { McpMediaService } from "./media-service.js";
import { PostgresReleaseWorkflowRepository } from "./postgres-release-repository.js";
import { EmbeddedReleaseProvider, InMemoryReleaseWorkflowRepository } from "./release-repository.js";
import { InMemoryEditingRepository } from "./repository.js";
import { McpEditingService, type IdempotencyStore } from "./service.js";
import { assertPinnedProductionProfile } from "./production-profile.js";
import { assertStagingActivationGuard, createDotenvxSecretBroker, safeStagingRuntimeIdentifiers, selectReleaseProvider, stagingBindingFromEnvironment, stagingExpectationFromEnvironment } from "./staging-runtime.js";
import { PostgresDeliveryPhaseStore } from "./postgres-delivery-phase-store.js";
import { PostgresReviewedAstroArtifactStore } from "./postgres-reviewed-astro-artifact-store.js";
import { ReviewedAstroArtifactResolver } from "./reviewed-astro-resolver.js";
import { composeCloudflareStagingReleaseProvider } from "./staging-composition.js";
import { StagingOperationalRuntime } from "./staging-operational-runtime.js";
import { composeR2Runtime } from "./r2-composition.js";
import { createR2StorageRuntime } from "./r2-storage-runtime.js";
import { createDotenvxR2SecretBroker, r2RuntimeBindingFromEnvironment, r2RuntimeExpectationFromEnvironment } from "./r2-runtime.js";

const resource = required("NAVOCMS_MCP_RESOURCE");
const issuer = required("NAVOCMS_OIDC_ISSUER");
const jwksUrl = required("NAVOCMS_OIDC_JWKS_URL");
const runtimeMode = process.env.NAVOCMS_RUNTIME_MODE ?? (process.env.NODE_ENV === "production" ? "production" : "development");
const databaseUrl = process.env.NAVOCMS_DATABASE_URL;
const issuerRolePermissions = environmentRolePermissions("NAVOCMS_OIDC_ROLE_PERMISSIONS");
const organizationId = process.env.NAVOCMS_OIDC_ORGANIZATION_ID;
if (issuerRolePermissions && !organizationId) {
  throw new Error("NAVOCMS_OIDC_ORGANIZATION_ID is required with NAVOCMS_OIDC_ROLE_PERMISSIONS");
}
const deploymentScope = Object.freeze({
  tenantId: databaseUrl ? required("NAVOCMS_TENANT_ID") : required("NAVOCMS_DEVELOPMENT_TENANT_ID"),
  siteId: databaseUrl ? required("NAVOCMS_SITE_ID") : required("NAVOCMS_DEVELOPMENT_SITE_ID")
});
const environmentKey = runtimeMode === "production" ? required("NAVOCMS_ENVIRONMENT") : (process.env.NAVOCMS_ENVIRONMENT ?? runtimeMode);
const deploymentEnvironmentKey = process.env.NAVOCMS_ENVIRONMENT_KEY ?? "default";
const runtimePrincipalId = databaseUrl && runtimeMode === "production"
  ? required("NAVOCMS_RUNTIME_PRINCIPAL_ID")
  : undefined;
const database = databaseUrl ? new PostgresDatabase({
  connectionString: requireDatabaseUrl(databaseUrl),
  applicationName: `navocms-mcp-${environmentKey}`,
  maxConnections: environmentInteger("NAVOCMS_DATABASE_POOL_MAX", 8, 100),
  ...(runtimeMode === "production" ? {
    readinessScope: {
      ...deploymentScope,
      principalId: runtimePrincipalId!,
      environmentKey: deploymentEnvironmentKey
    }
  } : {})
}) : undefined;
const requestedProvider = process.env.NAVOCMS_RELEASE_PROVIDER;
if (requestedProvider === "cloudflare-staging") assertStagingActivationGuard({ runtimeMode, environment: environmentKey, hasPostgresReadinessScope: Boolean(database && runtimeMode === "production"), organizationId });
const stagingExpectation = requestedProvider === "cloudflare-staging" ? stagingExpectationFromEnvironment() : undefined;
const stagingRuntime = requestedProvider === "cloudflare-staging"
  ? selectReleaseProvider({ requested: requestedProvider, environment: environmentKey, binding: stagingBindingFromEnvironment(), expected: stagingExpectation!, secrets: createDotenvxSecretBroker() })
  : selectReleaseProvider({ requested: requestedProvider, environment: environmentKey, binding: {}, expected: { tenantId: deploymentScope.tenantId, siteId: deploymentScope.siteId, allowedHostname: "unused.invalid", bindingDigest: "sha256:unused" }, secrets: createDotenvxSecretBroker() });
if (stagingRuntime.selection === "cloudflare-staging" && !database) throw new Error("cloudflare-staging requires PostgreSQL");
const requestedR2 = process.env.NAVOCMS_R2_RUNTIME;
if (requestedR2 !== undefined && requestedR2 !== "disabled" && requestedR2 !== "r2") throw new Error("NAVOCMS_R2_RUNTIME must be disabled or r2");
const r2Composition = requestedR2 === "r2" ? composeR2Runtime({
  requested: requestedR2,
  runtimeMode,
  environment: environmentKey,
  binding: r2RuntimeBindingFromEnvironment(),
  expected: r2RuntimeExpectationFromEnvironment(),
  secrets: createDotenvxR2SecretBroker()
}) : undefined;
if (r2Composition && !database) throw new Error("R2 runtime requires PostgreSQL");
if (stagingRuntime.selection === "cloudflare-staging" && !r2Composition) throw new Error("cloudflare-staging requires reviewed R2 object storage");
const r2Storage = r2Composition ? createR2StorageRuntime({ composition: r2Composition, ...deploymentScope }) : undefined;
if (r2Storage && !await r2Storage.ready()) throw new Error("R2 namespace readiness failed");
if (runtimeMode === "production" && stagingRuntime.selection === "embedded") assertPinnedProductionProfile();
const identityResolver = database ? new PostgresIdentityResolver(database, deploymentScope, {
  ...(issuerRolePermissions ? { issuerRolePermissions } : {})
}) : undefined;
// Embedded production stays read-only. The staging media mutation surface is
// enabled only after the reviewed R2 binding and all namespace markers pass.
const media = database ? new McpMediaService(new PostgresMediaRepository(database, r2Storage?.media), { storageInjected: Boolean(r2Storage) }) : undefined;

let service: McpEditingService;
let reviewedAstroResolver: ReviewedAstroArtifactResolver | undefined;
let stagingOperations: StagingOperationalRuntime | undefined;
if (database) {
  const deliveryRepositoryContext = {
    site: { ...deploymentScope, name: "staging-delivery", primaryLocale: "en", locales: ["en"] },
    principalId: runtimePrincipalId!
  };
  const artifactStore = stagingRuntime.selection === "cloudflare-staging"
    ? new PostgresReviewedAstroArtifactStore(database, deliveryRepositoryContext, deploymentEnvironmentKey, { storage: r2Storage!.artifacts })
    : undefined;
  const stagingComposition = stagingRuntime.selection === "cloudflare-staging"
    ? composeCloudflareStagingReleaseProvider({
      binding: stagingRuntime.binding,
      environmentKey: deploymentEnvironmentKey,
      store: artifactStore!,
      phases: new PostgresDeliveryPhaseStore(database, deliveryRepositoryContext, { events: new PostgresEventStore(database) }),
      secrets: stagingRuntime.secrets
    })
    : undefined;
  if (stagingRuntime.selection === "cloudflare-staging") {
    // Required only by the private trusted builder. This directory is never an
    // MCP argument and may be a detached read-only checkout on the host.
    stagingOperations = new StagingOperationalRuntime({
      database,
      environmentKey: deploymentEnvironmentKey,
      reviewedSourceCommit: required("NAVOCMS_REVIEWED_SOURCE_COMMIT"),
      toolchainDirectory: required("NAVOCMS_REVIEWED_ASTRO_TOOLCHAIN"),
      readinessContext: deliveryRepositoryContext,
      objectStorage: r2Storage!.artifacts
    });
  }
  reviewedAstroResolver = stagingComposition?.resolver;
  const releaseProvider = stagingComposition?.provider ?? new EmbeddedReleaseProvider();
  service = new McpEditingService(
    new PostgresEditingRepository(database),
    new PostgresEventStore(database),
    new PostgresIdempotencyStore(database) as IdempotencyStore,
    new PostgresReleaseWorkflowRepository(database),
    releaseProvider,
    {
      environmentKey,
      previewBaseUrl: process.env.NAVOCMS_PREVIEW_BASE_URL ?? new URL(resource).origin,
      previewTtlSeconds: environmentInteger("NAVOCMS_PREVIEW_TTL_SECONDS", 3600, 604_800),
      approvalTtlSeconds: environmentInteger("NAVOCMS_APPROVAL_TTL_SECONDS", 900, 86_400),
      approvalPolicyVersion: process.env.NAVOCMS_APPROVAL_POLICY_VERSION ?? "navocms.release-approval.v1"
    }, database, new PostgresRuntimePolicyGuard(database), stagingOperations
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
  ...(organizationId ? { organizationId } : {}),
  jwks: createRemoteJwksProvider(jwksUrl)
});
const server = createMcpHttpServer({
  service,
  ...(media ? { media } : {}),
  verifier,
  resource,
  authorizationServers: [issuer],
  scopes: ["openid"],
  ...(identityResolver ? { resolveAuthorization: (token) => identityResolver.resolve(token) } : {}),
  ...(database ? {
    readiness: async () => {
      const databaseReady = await database.ready();
      const resolverReady = reviewedAstroResolver ? await reviewedAstroResolver.ready() : true;
      const builderReady = stagingOperations ? await stagingOperations.ready() : true;
      const objectStorageReady = r2Storage ? await r2Storage.ready() : true;
      const providerReady = stagingRuntime.selection !== "cloudflare-staging" || (resolverReady && builderReady && objectStorageReady);
      return {
        ready: databaseReady && providerReady && objectStorageReady,
        ...(r2Composition && r2Storage ? { r2: {
          provider: "r2" as const,
          ready: objectStorageReady,
          tenantId: r2Composition.readiness.tenantId,
          siteId: r2Composition.readiness.siteId,
          bucket: r2Composition.readiness.bucket,
          namespace: r2Composition.readiness.namespace,
          prefix: r2Composition.readiness.prefix,
          bindingDigest: r2Composition.readiness.bindingDigest
        } } : {}),
        ...(stagingRuntime.selection === "cloudflare-staging" ? {
          provider: { key: "cloudflare-staging" as const, ready: providerReady },
          resolver: { ready: resolverReady, environment: "staging" as const, environmentKey: deploymentEnvironmentKey },
          builder: { ready: builderReady, environment: "staging" as const, environmentKey: deploymentEnvironmentKey, policyDigest: stagingOperations!.policyDigest() },
          staging: safeStagingRuntimeIdentifiers(stagingRuntime)
        } : { provider: { key: "embedded" as const, ready: true } })
      };
    }
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
      database?.close();
      process.exit(0);
    });
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
