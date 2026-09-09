import { createHash, randomBytes } from "node:crypto";
import { TLSSocket } from "node:tls";
import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  NAVOCMS_PERMISSIONS,
  bearerChallenge,
  effectivePermissions,
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
  /**
   * Browser confirmation login (OIDC authorization code + PKCE). Absent
   * configuration renders the confirmation flow as login-unavailable instead
   * of silently accepting weaker authority.
   */
  readonly confirmationLogin?: ConfirmationLoginConfig;
}

const CONFIRMATION_CSRF_COOKIE = "navocms_confirmation_csrf";
const CONFIRMATION_SESSION_COOKIE = "navocms_confirmation_session";
const CONFIRMATION_OIDC_STATE_COOKIE = "navocms_confirmation_oidc";

/** External identity-provider settings for the confirmation browser login. */
export interface ConfirmationLoginConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly scopes?: readonly string[];
}
const PREVIEW_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
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
  // Server-side browser-session store for the confirmation flow. Sessions are
  // created only through the OIDC authorization-code callback below; MCP
  // bearer tokens are never exchanged for one and never accepted as one.
  const browserAuth: BrowserAuth = { sessions: new Map(), pendingLogins: new Map() };

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
    const previewRoute = request.method === "GET"
      ? /^\/previews\/([A-Za-z0-9_-]{43})(?:\/(.*))?$/.exec(request.url ?? "")
      : null;
    if (previewRoute) {
      const token = previewRoute[1]!;
      const rest = previewRoute[2];
      const surface = await options.service.resolvePreviewSurface(token);
      if (!surface) return sendJson(response, 404, { error: "PREVIEW_NOT_FOUND" });
      response.setHeader("cache-control", "private, no-store, max-age=0");
      response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("content-security-policy", PREVIEW_CSP);
      response.statusCode = 200;
      if (rest === undefined || rest === "") {
        // The entry page. Every root-relative URL is bound to this token's
        // namespace so resources can never come from another preview.
        response.setHeader("content-type", "text/html; charset=utf-8");
        if (surface.built) {
          const entry = pickEntryHtml(surface.built.output);
          const entryBody = entry !== undefined ? surface.built.output[entry] : undefined;
          response.end(entryBody !== undefined
            ? bindCapabilityUrls(entryBody, `/previews/${token}`, "html")
            : surface.proof.body);
        } else {
          response.setHeader("content-type", surface.proof.mediaType);
          response.end(surface.proof.body);
        }
        return;
      }
      // The whole built tree is served under the token's namespace: the path
      // addresses exactly this preview, so no shared cookie can mix releases.
      const path = decodeURIComponent(rest.split("?")[0] ?? "");
      const body = surface.built?.output[path];
      if (!safeOutputPath(path) || body === undefined) return sendJson(response, 404, { error: "PREVIEW_NOT_FOUND" });
      response.setHeader("content-type", outputContentType(path));
      if (path.endsWith(".html")) {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(bindCapabilityUrls(body, `/previews/${token}`, "html"));
      } else if (path.endsWith(".css")) {
        response.setHeader("content-security-policy", "default-src 'none'");
        response.end(bindCapabilityUrls(body, `/previews/${token}`, "css"));
      } else {
        response.setHeader("content-security-policy", "default-src 'none'");
        response.end(body);
      }
      return;
    }
    if (request.url?.startsWith("/confirmations/")) {
      const callbackRoute = request.url === "/confirmations/callback" || request.url.startsWith("/confirmations/callback?");
      const tokenRoute = /^\/confirmations\/([A-Za-z0-9_-]{43})$/.exec(request.url);
      const secure = request.socket instanceof TLSSocket || request.headers["x-forwarded-proto"] === "https";
      if (callbackRoute && request.method === "GET") {
        return loginCallback(response, options, browserAuth, request, secure);
      }
      if (tokenRoute && request.method === "GET") {
        return confirmationPage(response, options, browserAuth, tokenRoute[1]!, request, secure);
      }
      if (tokenRoute && request.method === "POST") {
        return confirmDecision(response, options, browserAuth, tokenRoute[1]!, request, secure);
      }
      return sendJson(response, 404, { error: "NOT_FOUND" });
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

/**
 * Rewrites root-relative URLs in served preview content so they address this
 * token's namespace (`/previews/<token>/...`). The stored output bytes stay
 * untouched; binding happens at serve time. `data:` URIs, protocol-relative
 * URLs, and already-bound paths are left as-is.
 */
function bindCapabilityUrls(text: string, basePath: string, kind: "html" | "css"): string {
  if (kind === "css") {
    return text.replace(/url\(\s*(["']?)\/(?!\/|previews\/)/g, `url($1${basePath}/`);
  }
  let bound = text.replace(
    /(\s(?:src|href|poster|action)\s*=\s*)(["'])\/(?!\/|previews\/)/g,
    (_match, attribute: string, quote: string) => `${attribute}${quote}${basePath}/`
  );
  bound = bound.replace(
    /(srcset\s*=\s*)(["'])([^"']*)(["'])/g,
    (_match, attribute: string, open: string, value: string, close: string) =>
      `${attribute}${open}${value.replace(/(^|[\s,])\/(?!\/|previews\/)/g, `$1${basePath}/`)}${close}`
  );
  return bound.replace(/url\(\s*(["']?)\/(?!\/|previews\/)/g, `url($1${basePath}/`);
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

async function confirmationPage(response: ServerResponse, options: McpHttpOptions, browserAuth: BrowserAuth, token: string, request: IncomingMessage, secure: boolean): Promise<void> {
  const view = await options.service.resolveConfirmationView(token);
  if (!view) return sendHtml(response, 404, confirmationShell("Confirmation unavailable", "This confirmation link is invalid or has expired. Ask the agent for a fresh preview."));
  const session = resolveBrowserSession(browserAuth, request, view);
  if (session.error) {
    if (session.error.status === 401) return startLogin(response, options, browserAuth, token, request, secure);
    return sendHtml(response, session.error.status, confirmationShell(session.error.title, escapeHtml(session.error.body)));
  }
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
  response.setHeader("set-cookie", `${CONFIRMATION_CSRF_COOKIE}=${csrf}; HttpOnly; SameSite=Strict; Path=/confirmations; Max-Age=900${request.socket instanceof TLSSocket ? "; Secure" : ""}`);
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

async function confirmDecision(response: ServerResponse, options: McpHttpOptions, browserAuth: BrowserAuth, token: string, request: IncomingMessage, secure: boolean): Promise<void> {
  // The capability routes the request; only a logged-in browser session may
  // decide. Bearer tokens — the same ones MCP clients use — are never
  // consulted here. This check comes before CSRF so stale or foreign
  // sessions get a clear rejection regardless of form contents.
  const view = await options.service.resolveConfirmationView(token);
  if (!view) return sendHtml(response, 404, confirmationShell("Confirmation unavailable", "This confirmation link is invalid or has expired."));
  const session = resolveBrowserSession(browserAuth, request, view);
  if (session.error) return sendHtml(response, session.error.status, confirmationShell(session.error.title, escapeHtml(session.error.body)));
  // Cross-origin form posts are rejected: a known foreign Origin never
  // matches the host that served the confirmation page (scheme-agnostic
  // behind TLS termination). A `null` Origin (sandboxed contexts) is still
  // guarded by the SameSite=Strict cookie pairing below, which cross-site
  // requests cannot carry.
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin && origin !== "null" && host && origin !== `https://${host}` && origin !== `http://${host}`) {
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
    const decision = await options.service.recordConfirmationDecision(token, session.principal!);
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

interface BrowserAuth {
  readonly sessions: Map<string, { readonly context: AuthorizationContext; readonly expiresAt: number }>;
  readonly pendingLogins: Map<string, { readonly verifier: string; readonly returnUrl: string; readonly createdAt: number }>;
}

const SESSION_TTL_SECONDS = 3600;
const LOGIN_STATE_TTL_MS = 600_000;

function sessionKey(cookieValue: string): string {
  return createHash("sha256").update(cookieValue).digest("hex");
}

/**
 * Resolves the request's browser session into a principal with publication
 * authority over the release's site. Sessions exist only after an
 * interactive OIDC authorization-code login in a real browser; MCP bearer
 * tokens are never accepted here and never exchanged for a session. A
 * missing or expired session is a 401 (the page flow redirects to login);
 * delegated agent identities, foreign sites, and read-only principals are
 * rejected before any form or decision exists.
 */
function resolveBrowserSession(browserAuth: BrowserAuth, request: IncomingMessage, view: { tenantId: string; siteId: string }): { principal?: { principalId?: string; issuer: string; subject: string }; error?: { status: number; title: string; body: string } } {
  const cookie = parseCookies(request.headers.cookie)[CONFIRMATION_SESSION_COOKIE];
  const record = cookie !== undefined ? browserAuth.sessions.get(sessionKey(cookie)) : undefined;
  if (!record || record.expiresAt <= Date.now()) {
    if (cookie !== undefined) browserAuth.sessions.delete(sessionKey(cookie));
    return { error: { status: 401, title: "Human session required", body: "This confirmation records a human publication decision and requires your own logged-in session. The link the agent shared identifies the request; it does not authorize the decision by itself." } };
  }
  const { context } = record;
  if (context.principal.kind !== "human") {
    return { error: { status: 403, title: "Not authorized", body: "A delegated agent session cannot record this decision; the confirmation must come from your own logged-in human session." } };
  }
  if (context.tenantId !== view.tenantId || context.siteId !== view.siteId) {
    return { error: { status: 403, title: "Not authorized", body: "Your session belongs to another site; this confirmation is scoped to the release's site." } };
  }
  if (!effectivePermissions(context.layers).includes("content:publish")) {
    return { error: { status: 403, title: "Not authorized", body: "Your session does not hold publication authority for this site." } };
  }
  return { principal: { principalId: context.principal.id, issuer: context.principal.issuer, subject: context.principal.subject } };
}

/** Starts the OIDC authorization-code login (PKCE S256, single-use state). */
function startLogin(response: ServerResponse, options: McpHttpOptions, browserAuth: BrowserAuth, token: string, request: IncomingMessage, secure: boolean): void {
  const login = options.confirmationLogin;
  if (!login) {
    return sendHtml(response, 503, confirmationShell("Login unavailable", "Confirmation login is not configured for this deployment; the administrator must register the confirmation client with the identity provider first."));
  }
  for (const [state, pending] of browserAuth.pendingLogins) {
    if (Date.now() - pending.createdAt > LOGIN_STATE_TTL_MS) browserAuth.pendingLogins.delete(state);
  }
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  browserAuth.pendingLogins.set(state, { verifier, returnUrl: `/confirmations/${token}`, createdAt: Date.now() });
  const proto = request.headers["x-forwarded-proto"] === "https" || secure ? "https" : "http";
  const redirectUri = `${proto}://${request.headers.host ?? "localhost"}/confirmations/callback`;
  const authorization = new URL(login.authorizationEndpoint);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", login.clientId);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("scope", (login.scopes ?? ["openid"]).join(" "));
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  response.statusCode = 302;
  response.setHeader("location", authorization.toString());
  response.setHeader("set-cookie", `${CONFIRMATION_OIDC_STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/confirmations; Max-Age=600${secure ? "; Secure" : ""}`);
  response.end();
}

/** Exchanges the authorization code for a verified human browser session. */
async function loginCallback(response: ServerResponse, options: McpHttpOptions, browserAuth: BrowserAuth, request: IncomingMessage, secure: boolean): Promise<void> {
  const login = options.confirmationLogin;
  if (!login) return sendHtml(response, 503, confirmationShell("Login unavailable", "Confirmation login is not configured for this deployment."));
  const query = new URL(request.url ?? "/", "http://localhost").searchParams;
  const state = query.get("state");
  const code = query.get("code");
  const stateCookie = parseCookies(request.headers.cookie)[CONFIRMATION_OIDC_STATE_COOKIE];
  const pending = state !== null && stateCookie === state ? browserAuth.pendingLogins.get(state) : undefined;
  // Single-use, bound to the browser that started the login.
  if (state !== null) browserAuth.pendingLogins.delete(state);
  response.setHeader("set-cookie", `${CONFIRMATION_OIDC_STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/confirmations; Max-Age=0${secure ? "; Secure" : ""}`);
  if (!pending || !code) {
    return sendHtml(response, 400, confirmationShell("Login could not be completed", "This sign-in response is unknown, expired, or was already used. Open the confirmation link again."));
  }
  const proto = request.headers["x-forwarded-proto"] === "https" || secure ? "https" : "http";
  const redirectUri = `${proto}://${request.headers.host ?? "localhost"}/confirmations/callback`;
  let accessToken: string | undefined;
  try {
    const tokenResponse = await fetch(login.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: login.clientId,
        client_secret: login.clientSecret,
        code_verifier: pending.verifier
      })
    });
    if (tokenResponse.ok) {
      const payload = await tokenResponse.json() as { access_token?: unknown };
      if (typeof payload.access_token === "string") accessToken = payload.access_token;
    }
  } catch {
    accessToken = undefined;
  }
  if (accessToken === undefined) {
    return sendHtml(response, 401, confirmationShell("Sign-in failed", "The identity provider rejected this sign-in. Open the confirmation link and try again."));
  }
  let context: AuthorizationContext;
  try {
    const verified = await options.verifier.verify(accessToken);
    context = options.resolveAuthorization ? await options.resolveAuthorization(verified) : authorizationContext(verified);
  } catch {
    return sendHtml(response, 403, confirmationShell("Sign-in rejected", "Your account could not be resolved as a publisher for this deployment."));
  }
  if (context.principal.kind !== "human") {
    return sendHtml(response, 403, confirmationShell("Sign-in rejected", "A delegated agent identity cannot sign in for a human confirmation; use your own account."));
  }
  const sessionValue = randomBytes(32).toString("base64url");
  browserAuth.sessions.set(sessionKey(sessionValue), { context, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 });
  response.statusCode = 302;
  response.setHeader("location", pending.returnUrl);
  response.setHeader("set-cookie", `${CONFIRMATION_SESSION_COOKIE}=${sessionValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`);
  response.end();
}

function confirmationShell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1><p>${body}</p></main></body></html>`;
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
