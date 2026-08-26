import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  NAVOCMS_PERMISSIONS,
  bearerChallenge,
  protectedResourceMetadata,
  type AccessTokenVerifier,
  type AuthorizationContext,
  type Permission,
  type VerifiedAccessToken
} from "@navocms/security";

import { createMcpServer } from "./mcp.js";
import { MCP_LIMITS } from "./model.js";
import { McpEditingService } from "./service.js";
import { McpMediaService } from "./media-service.js";

export interface McpHttpOptions {
  readonly service: McpEditingService;
  readonly media?: McpMediaService;
  readonly verifier: AccessTokenVerifier;
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  /**
   * Optional standard OAuth/OIDC scopes expected by the authorization server.
   * Product permissions arrive as verified token claims and are enforced
   * independently from OAuth consent.
   */
  readonly scopes?: readonly string[];
  readonly documentationUrl?: string;
  readonly readiness?: () => Promise<boolean | ReadinessResult>;
  readonly resolveAuthorization?: (token: VerifiedAccessToken) => Promise<AuthorizationContext>;
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly pluginHost?: Readonly<Record<string, unknown>>;
  readonly provider?: "embedded";
  readonly staging?: Readonly<{ provider: string; profileDigest: string; bindingDigest: string; tenantId: string; siteId: string; hostname: string }>;
}

export function createMcpHttpServer(options: McpHttpOptions) {
  const metadata = protectedResourceMetadata({
    resource: options.resource,
    authorizationServers: options.authorizationServers,
    ...(options.scopes ? { scopes: options.scopes } : {}),
    ...(options.documentationUrl ? { documentationUrl: options.documentationUrl } : {})
  });
  const resourceUrl = new URL(options.resource);
  const metadataPath = `/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`;
  const metadataUrl = `${resourceUrl.origin}${metadataPath}`;

  return createNodeServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      return sendJson(response, 200, { status: "ok" });
    }
    if (request.method === "GET" && request.url === "/readyz") {
      try {
        const result = options.readiness ? await options.readiness() : true;
        const readiness = typeof result === "boolean" ? { ready: result } : result;
        return sendJson(response, readiness.ready ? 200 : 503, {
          status: readiness.ready ? "ready" : "not-ready",
          ...(readiness.pluginHost ? { pluginHost: readiness.pluginHost } : {}),
          ...(readiness.provider ? { provider: readiness.provider } : {}),
          ...(readiness.staging ? { staging: readiness.staging } : {})
        });
      } catch {
        return sendJson(response, 503, { status: "not-ready" });
      }
    }
    if (request.method === "GET" && request.url === metadataPath) {
      return sendJson(response, 200, metadata);
    }
    if (request.method === "GET" && request.url?.startsWith("/previews/")) {
      const token = request.url.slice("/previews/".length);
      const preview = await options.service.resolvePreview(token);
      if (!preview) return sendJson(response, 404, { error: "PREVIEW_NOT_FOUND" });
      response.statusCode = 200;
      response.setHeader("content-type", preview.mediaType);
      response.setHeader("cache-control", "private, no-store, max-age=0");
      response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      response.end(preview.body);
      return;
    }
    if (request.url !== resourceUrl.pathname) return sendJson(response, 404, { error: "NOT_FOUND" });

    const token = bearerToken(request.headers.authorization);
    if (!token) {
      response.setHeader("www-authenticate", bearerChallenge(options.resource, metadataUrl, []));
      return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
    }

    let verified: VerifiedAccessToken;
    try {
      verified = await options.verifier.verify(token);
    } catch {
      response.setHeader("www-authenticate", bearerChallenge(options.resource, metadataUrl, []));
      return sendJson(response, 401, { error: "ACCESS_TOKEN_REJECTED" });
    }

    let context: AuthorizationContext;
    try {
      context = options.resolveAuthorization
        ? await options.resolveAuthorization(verified)
        : authorizationContext(verified);
    } catch {
      return sendJson(response, 403, { error: "SITE_MEMBERSHIP_REQUIRED" });
    }
    const server = createMcpServer(options.service, { authorization: context }, options.media);
    const transport = new StreamableHTTPServerTransport();
    response.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      const body = request.method === "POST" ? await readJson(request) : undefined;
      await server.connect(transport as Transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) sendJson(response, 400, { error: "MCP_REQUEST_REJECTED" });
    }
  });
}

export function authorizationContext(token: VerifiedAccessToken): AuthorizationContext {
  const permissions = token.scopes.filter((scope): scope is Permission =>
    NAVOCMS_PERMISSIONS.includes(scope as Permission)
  );
  return Object.freeze({
    tenantId: token.tenantId,
    siteId: token.siteId,
    principal: token.principal,
    layers: Object.freeze([
      Object.freeze({ name: "principal" as const, permissions: Object.freeze(permissions) }),
      Object.freeze({ name: "operation" as const, permissions: NAVOCMS_PERMISSIONS })
    ]),
    expiresAt: new Date(token.claims.exp * 1000).toISOString()
  });
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  return match?.[1];
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MCP_LIMITS.maxRequestBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}
