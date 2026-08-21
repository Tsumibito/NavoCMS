import { ContractValidationError, contracts } from "@navocms/contracts";
import { KernelError, PluginHost } from "@navocms/kernel";
import {
  NAVOCMS_PERMISSIONS,
  protectedResourceMetadata,
  type OAuthResourceConfig
} from "@navocms/security";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

export interface ApiOptions {
  readonly pluginHost?: PluginHost;
  readonly logger?: FastifyServerOptions["logger"];
  readonly oauthResource?: Omit<OAuthResourceConfig, "scopes"> & {
    readonly scopes?: OAuthResourceConfig["scopes"];
  };
}

export function createApi(options: ApiOptions = {}): FastifyInstance {
  const pluginHost = options.pluginHost ?? new PluginHost();
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_048_576 });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ContractValidationError) {
      void reply.status(400).send({
        error: "CONTRACT_VALIDATION_FAILED",
        message: error.message,
        issues: error.issues
      });
      return;
    }
    if (error instanceof KernelError) {
      void reply.status(409).send({ error: error.code, message: error.message });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: "INTERNAL_ERROR", message: "Unexpected internal error" });
  });

  app.get("/health", async () => ({
    status: "ok",
    product: "NavoCMS",
    apiVersion: "navocms.io/v0alpha1"
  }));

  if (options.oauthResource) {
    const metadata = protectedResourceMetadata({
      ...options.oauthResource,
      scopes: options.oauthResource.scopes ?? NAVOCMS_PERMISSIONS
    });
    app.get("/.well-known/oauth-protected-resource", async () => metadata);
  }

  app.get("/ready", async (_request, reply) => {
    const status = pluginHost.status();
    if (status.state !== "healthy") return reply.status(503).send(status);
    return status;
  });

  app.get("/v1/kernel/status", async () => pluginHost.status());

  app.post("/v1/contracts/plugins/validate", async (request) => {
    const manifest = contracts.plugin.parse(request.body);
    return {
      valid: true,
      id: manifest.metadata.id,
      version: manifest.metadata.version,
      provides: manifest.spec.provides
    };
  });

  app.post("/v1/contracts/profiles/validate", async (request) => {
    const profile = contracts.profile.parse(request.body);
    return {
      valid: true,
      name: profile.metadata.name,
      version: profile.metadata.version,
      plugins: profile.spec.plugins.length,
      bindings: profile.spec.bindings.length
    };
  });

  return app;
}
