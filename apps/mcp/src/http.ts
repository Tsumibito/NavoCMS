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

export interface McpHttpOptions {
  readonly service: McpEditingService;
  readonly verifier: AccessTokenVerifier;
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  readonly documentationUrl?: string;
  readonly readiness?: () => Promise<boolean>;
}

export function createMcpHttpServer(options: McpHttpOptions) {
  const metadata = protectedResourceMetadata({
    resource: options.resource,
    authorizationServers: options.authorizationServers,
    scopes: NAVOCMS_PERMISSIONS,
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
        const ready = options.readiness ? await options.readiness() : true;
        return sendJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not-ready" });
      } catch {
        return sendJson(response, 503, { status: "not-ready" });
      }
    }
    if (request.method === "GET" && request.url === metadataPath) {
      return sendJson(response, 200, metadata);
    }
    if (request.url !== resourceUrl.pathname) return sendJson(response, 404, { error: "NOT_FOUND" });

    const token = bearerToken(request.headers.authorization);
    if (!token) {
      response.setHeader("www-authenticate", bearerChallenge(options.resource, metadataUrl, ["content:read"]));
      return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
    }

    let verified: VerifiedAccessToken;
    try {
      verified = await options.verifier.verify(token);
    } catch {
      response.setHeader("www-authenticate", bearerChallenge(options.resource, metadataUrl, ["content:read"]));
      return sendJson(response, 401, { error: "ACCESS_TOKEN_REJECTED" });
    }

    const context = authorizationContext(verified);
    const server = createMcpServer(options.service, { authorization: context });
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
