import { randomBytes } from "node:crypto";
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
  /** Marks preview cookies Secure when the preview base URL is https. */
  readonly previewCookieSecure?: boolean;
}

const PREVIEW_COOKIE = "navocms_preview_token";
const CONFIRMATION_CSRF_COOKIE = "navocms_confirmation_csrf";
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CONFIRMATION_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export interface ReadinessResult {
  readonly ready: boolean;
  readonly provider?: Readonly<{ key: "embedded" | "cloudflare-staging"; ready: boolean }>;
  readonly resolver?: Readonly<{ ready: boolean; environment: "staging"; environmentKey: string }>;
  readonly builder?: Readonly<{ ready: boolean; environment: "staging"; environmentKey: string; policyDigest: string }>;
  readonly staging?: Readonly<{ provider: string; profileDigest: string; bindingDigest: string; tenantId: string; siteId: string; hostname: string }>;
  readonly r2?: Readonly<{ provider: "r2"; ready: boolean; tenantId: string; siteId: string; bucket: string; namespace: "navocms/v1/"; prefix: "navocms/v1/"; bindingDigest: string }>;
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
          ...(readiness.provider ? { provider: readiness.provider } : {}),
          ...(readiness.resolver ? { resolver: readiness.resolver } : {}),
          ...(readiness.builder ? { builder: readiness.builder } : {}),
          ...(readiness.staging ? { staging: readiness.staging } : {}),
          ...(readiness.r2 ? { r2: readiness.r2 } : {})
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
      const surface = await options.service.resolvePreviewSurface(token);
      if (!surface) return sendJson(response, 404, { error: "PREVIEW_NOT_FOUND" });
      response.setHeader("cache-control", "private, no-store, max-age=0");
      response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("content-security-policy", PREVIEW_CSP);
      response.setHeader("set-cookie", previewCookie(token, surface.expiresAt, options.previewCookieSecure === true));
      response.statusCode = 200;
      if (surface.built) {
        // Serve the exact built page; the cookie set above lets same-origin
        // absolute asset URLs resolve from the same immutable output.
        const entry = pickEntryHtml(surface.built.output);
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(entry ? surface.built.output[entry] : surface.proof.body);
        return;
      }
      response.setHeader("content-type", surface.proof.mediaType);
      response.end(surface.proof.body);
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/confirmations/")) {
      return confirmationPage(response, options, resourceUrl, request.url.slice("/confirmations/".length));
    }
    if (request.method === "POST" && request.url?.startsWith("/confirmations/")) {
      return confirmDecision(response, options, request.url.slice("/confirmations/".length), request);
    }
    if (request.method === "GET") {
      // Same-origin relay for absolute built-asset URLs (e.g. /_astro/*.css).
      const served = await servePreviewAsset(response, options, request);
      if (served) return;
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

async function servePreviewAsset(response: ServerResponse, options: McpHttpOptions, request: IncomingMessage): Promise<boolean> {
  const previewToken = parseCookies(request.headers.cookie)[PREVIEW_COOKIE];
  if (!previewToken) return false;
  const surface = await options.service.resolvePreviewSurface(previewToken);
  if (!surface?.built) return false;
  const path = decodeURIComponent((request.url ?? "").replace(/^\//, "").split("?")[0] ?? "");
  if (!safeOutputPath(path) || surface.built.output[path] === undefined) return false;
  response.statusCode = 200;
  response.setHeader("content-type", outputContentType(path));
  response.setHeader("cache-control", "private, no-store, max-age=0");
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
  response.end(surface.built.output[path]);
  return true;
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "private, no-store, max-age=0");
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
  response.setHeader("content-security-policy", CONFIRMATION_CSP);
  response.setHeader("referrer-policy", "no-referrer");
  response.end(body);
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function confirmationPage(response: ServerResponse, options: McpHttpOptions, resourceUrl: URL, token: string): Promise<void> {
  const view = await options.service.resolveConfirmationView(token);
  if (!view) return sendHtml(response, 404, confirmationShell("Confirmation unavailable", "This confirmation link is invalid or has expired. Ask the agent for a fresh preview."));
  if (view.revokedAt) return sendHtml(response, 410, confirmationShell("Confirmation revoked", "This confirmation has been revoked; prepare a new preview."));
  if (view.decisionAt) {
    return sendHtml(response, 200, confirmationShell("Decision already recorded", escapeHtml(`This release was confirmed on ${view.decisionAt}. Receipt ${view.receiptHash ?? "unknown"}. Re-delivery is safe; nothing was published by revisiting this page.`)));
  }
  if (new Date(view.previewExpiresAt ?? 0).getTime() <= Date.now()) {
    return sendHtml(response, 410, confirmationShell("Confirmation expired", "This confirmation link has expired. Ask the agent for a fresh preview and confirm again."));
  }
  if (!view.build.ready) {
    return sendHtml(response, 409, confirmationShell("Build not finished", escapeHtml(`The trusted build for release ${shortHash(view.releaseHash)} has not completed yet. Ask the agent for the build status, then reopen this page to confirm.`)));
  }
  const csrf = randomBytes(32).toString("hex");
  response.setHeader("set-cookie", `${CONFIRMATION_CSRF_COOKIE}=${csrf}; HttpOnly; SameSite=Strict; Path=/confirmations; Max-Age=900${options.previewCookieSecure ? "; Secure" : ""}`);
  const summaryRows: readonly (readonly [string, string])[] = [
    ["Release hash", view.releaseHash],
    ["Output manifest digest", view.build.outputManifestDigest ?? "—"],
    ["Files", String(view.build.fileCount ?? "—")],
    ["Total bytes", String(view.build.totalBytes ?? "—")],
    ["Policy", view.policyVersion],
    ["Decision expires", String(view.receiptExpiresAt ?? view.previewExpiresAt ?? "—")]
  ];
  const summary = summaryRows
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(value)}</code></dd>`)
    .join("");
  sendHtml(response, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex, nofollow"><title>Confirm release ${escapeHtml(shortHash(view.releaseHash))}</title></head><body><main><h1>Confirm publication of this exact build</h1><p>Confirming records your human decision for this exact build. Publication happens afterwards through the agent workflow and uses these exact files.</p><dl>${summary}</dl><form method="post" action="${escapeHtml(`/confirmations/${token}`)}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Confirm this build</button></form><p>This page belongs to an independent confirmation session; the agent cannot press this button or record the decision through its token.</p></main></body></html>`);
}

async function confirmDecision(response: ServerResponse, options: McpHttpOptions, token: string, request: IncomingMessage): Promise<void> {
  // Cross-origin form posts are rejected: a known foreign Origin never
  // matches the host that served the confirmation page (scheme-agnostic
  // behind TLS termination). A `null` Origin (sandboxed contexts) is still
  // guarded by the SameSite=Strict cookie pairing below, which cross-site
  // requests cannot carry.
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin && origin !== "null" && host && origin !== `https://${host}` && origin !== `http://${host}`) {
    console.error("ORIGIN-DEBUG", JSON.stringify({ origin, host }));
    return sendHtml(response, 403, confirmationShell("Request rejected", "This confirmation must be submitted from its own page."));
  }
  const cookies = parseCookies(request.headers.cookie);
  let form: Record<string, string> = {};
  try {
    form = parseForm(await readBody(request, 64 * 1024));
  } catch {
    return sendHtml(response, 400, confirmationShell("Request rejected", "The confirmation form could not be read."));
  }
  if (!form.csrf || form.csrf !== cookies[CONFIRMATION_CSRF_COOKIE]) {
    return sendHtml(response, 403, confirmationShell("Request rejected", "The confirmation form was not opened in this session. Reopen the confirmation link and try again."));
  }
  try {
    const decision = await options.service.recordConfirmationDecision(token);
    if (!decision) return sendHtml(response, 404, confirmationShell("Confirmation unavailable", "This confirmation link is invalid or has expired."));
    const body = decision.recorded
      ? escapeHtml(`Your decision was recorded at ${decision.decidedAt}. Receipt ${decision.receiptHash}. It covers output manifest ${decision.outputManifestDigest}. Publication is a separate step and uses exactly these files.`)
      : escapeHtml(`This decision was already recorded at ${decision.decidedAt}. Receipt ${decision.receiptHash}. Re-delivery is safe.`);
    return sendHtml(response, 200, confirmationShell(decision.recorded ? "Decision recorded" : "Decision already recorded", body));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "REQUEST_REJECTED";
    if (code === "RELEASE_CONFIRMATION_REVOKED") return sendHtml(response, 410, confirmationShell("Confirmation revoked", "This confirmation has been revoked."));
    if (code === "RELEASE_CONFIRMATION_EXPIRED") return sendHtml(response, 410, confirmationShell("Confirmation expired", "This confirmation link is no longer valid."));
    if (code === "REVIEWED_ASTRO_ARTIFACT_NOT_BUILT") return sendHtml(response, 409, confirmationShell("Build not finished", "The trusted build for this release has not completed yet; ask the agent for the build status, then reopen this page."));
    return sendHtml(response, 400, confirmationShell("Request rejected", "The decision could not be recorded."));
  }
}

function confirmationShell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1><p>${body}</p></main></body></html>`;
}

function previewCookie(token: string, expiresAt: string, secure: boolean): string {
  const maxAge = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return `${PREVIEW_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function pickEntryHtml(output: Readonly<Record<string, string>>): string | undefined {
  const htmlFiles = Object.keys(output).filter((path) => path.endsWith(".html")).sort();
  return htmlFiles.find((path) => path === "index.html") ?? htmlFiles[0];
}

function outputContentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif",
    gif: "image/gif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
    txt: "text/plain; charset=utf-8", xml: "application/xml", webmanifest: "application/manifest+json"
  };
  return types[extension] ?? "application/octet-stream";
}

function safeOutputPath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.includes("\\\\") &&
    !value.includes("//") && !value.split("/").some((part) => !part || part === "." || part === "..");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function parseForm(body: string): Record<string, string> {
  const form: Record<string, string> = {};
  for (const pair of new URLSearchParams(body)) form[pair[0]] = pair[1];
  return form;
}

function shortHash(value: string): string {
  return value.slice(0, 10);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]!);
}
