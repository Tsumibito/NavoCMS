import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { TLSSocket } from "node:tls";
import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  NAVOCMS_PERMISSIONS,
  SecurityError,
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
  readonly browserSessionRevocations?: BrowserSessionRevocations;
}

export interface BrowserSessionRevocations {
  isRevoked(session: Readonly<{ id: string; tenantId: string; siteId: string; principalId: string }>): Promise<boolean>;
  revoke(session: Readonly<{ id: string; tenantId: string; siteId: string; principalId: string; expiresAt: number }>): Promise<void>;
}

const CONFIRMATION_CSRF_COOKIE = "navocms_confirmation_csrf";
const CONFIRMATION_SESSION_COOKIE = "navocms_confirmation_session";
const CONFIRMATION_OIDC_STATE_COOKIE = "navocms_confirmation_oidc";
const CONFIRMATION_SWITCH_HINT_COOKIE = "navocms_confirmation_switch_hint";

/** External identity-provider settings for the confirmation browser login. */
export interface ConfirmationLoginConfig {
  /** Access token: the API resource audience, organization and permissions. */
  readonly verifier: AccessTokenVerifier;
  /** ID token: the dedicated browser client audience, issuer and signature. */
  readonly idTokenVerifier: AccessTokenVerifier;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** Optional provider logout endpoint; required for reliable account switching. */
  readonly logoutEndpoint?: string;
  readonly scopes?: readonly string[];
}
const PREVIEW_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const REVIEW_PREVIEW_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const CONFIRMATION_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

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
  const browserAuth: BrowserAuth = { pendingLogins: new Map(), revoked: new Set() };

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
            ? bindCapabilityUrls(entryBody, `/previews/${token}`, "html", entry!)
            : surface.proof.body);
        } else {
          response.setHeader("content-type", surface.proof.mediaType);
          response.end(surface.proof.body);
        }
        return;
      }
      // The whole built tree is served under the token's namespace: the path
      // addresses exactly this preview, so no shared cookie can mix releases.
      let path: string;
      try { path = decodeURIComponent(rest.split("?")[0] ?? ""); }
      catch { return sendJson(response, 400, { error: "INVALID_PREVIEW_PATH" }); }
      const body = surface.built?.output[path];
      if (!safeOutputPath(path) || body === undefined) return sendJson(response, 404, { error: "PREVIEW_NOT_FOUND" });
      response.setHeader("content-type", outputContentType(path));
      if (path.endsWith(".html")) {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(bindCapabilityUrls(body, `/previews/${token}`, "html", path));
      } else if (path.endsWith(".css")) {
        response.setHeader("content-security-policy", "default-src 'none'");
        response.end(bindCapabilityUrls(body, `/previews/${token}`, "css", path));
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
      const switchRoute = /^\/confirmations\/([A-Za-z0-9_-]{43})\/switch$/.exec(request.url);
      if (switchRoute && request.method === "GET") {
        return switchAccount(response, options, browserAuth, switchRoute[1]!, request, secure);
      }
      const renewRoute = /^\/confirmations\/([A-Za-z0-9_-]{43})\/renew$/.exec(request.url);
      if (renewRoute && request.method === "POST") {
        return renewConfirmation(response, options, browserAuth, renewRoute[1]!, request, secure);
      }
      const reviewPreviewRoute = /^\/confirmations\/([A-Za-z0-9_-]{43})\/preview(?:\/(.*))?$/.exec(request.url);
      if (reviewPreviewRoute && request.method === "GET") {
        return confirmationPreview(response, options, browserAuth, reviewPreviewRoute[1]!, reviewPreviewRoute[2], request);
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
 * Resolves relative URLs in served preview content so they address this
 * token's namespace (`/previews/<token>/...`). The stored output bytes stay
 * untouched; binding happens at serve time against each original output path.
 * Absolute external URLs, fragments and data URIs are left as-is.
 */
function bindCapabilityUrls(text: string, basePath: string, kind: "html" | "css", documentPath = "index.html"): string {
  const bind = (value: string): string => {
    if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return value;
    const url = new URL(value, `https://preview.invalid/${documentPath}`);
    return `${basePath}${url.pathname}${url.search}${url.hash}`;
  };
  let bound = text;
  if (kind === "html") {
    bound = bound.replace(/(\s(?:src|href|poster|action)\s*=\s*)(["'])([^"']*)\2/gi,
      (_match, attribute: string, quote: string, value: string) => `${attribute}${quote}${bind(value)}${quote}`);
    bound = bound.replace(/(srcset\s*=\s*)(["'])([^"']*)\2/gi,
      (_match, attribute: string, quote: string, value: string) =>
        `${attribute}${quote}${value.replace(/(^|,\s*)(data:[^\s]+|[^\s,]+)([^,]*)/g,
          (_candidate: string, separator: string, url: string, descriptor: string) =>
            `${separator}${bind(url)}${descriptor}`)}${quote}`);
  }
  return bound.replace(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi,
    (_match, quote: string, value: string) => `url(${quote}${bind(value)}${quote})`);
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
  if (!view) return sendHtml(response, 404, confirmationShell("Publication link unavailable", "Ask the agent for a new review link."));
  const session = await resolveBrowserSession(response, options, browserAuth, request, view);
  if (session.error) {
    if (session.error.status === 401) return startLogin(response, options, browserAuth, token, request, secure);
    return sendHtml(response, session.error.status, confirmationShell(session.error.title,
      `${escapeHtml(session.error.body)}${session.error.status === 403 ? ` <a href="${escapeHtml(`/confirmations/${token}/switch`)}">Use another account</a>.` : ""}`));
  }
  if (view.revokedAt) return sendHtml(response, 410, confirmationShell("Publication link revoked", "Ask the agent for a new review link."));
  if (view.decisionAt) {
    return sendHtml(response, 200, confirmationShell("Publication approved", "Your decision is saved. The agent can finish publishing and report the result here in the conversation."));
  }
  if (new Date(view.previewExpiresAt ?? 0).getTime() <= Date.now()) {
    const csrf = randomBytes(32).toString("hex");
    appendCookie(response, `${CONFIRMATION_CSRF_COOKIE}=${csrf}; HttpOnly; SameSite=Strict; Path=/confirmations; Max-Age=900${secure ? "; Secure" : ""}`);
    return sendHtml(response, 410, confirmationShell("Review link expired", `<p>The saved build can be reviewed again without rebuilding it.</p><form method="post" action="${escapeHtml(`/confirmations/${token}/renew`)}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Get a new review link</button></form>`));
  }
  if (!view.build.ready) {
    return sendHtml(response, 409, confirmationShell("Build not finished", escapeHtml(`The trusted build for release ${shortHash(view.releaseHash)} has not completed yet. Ask the agent for the build status, then reopen this page to confirm.`)));
  }
  const csrf = randomBytes(32).toString("hex");
  appendCookie(response, `${CONFIRMATION_CSRF_COOKIE}=${csrf}; HttpOnly; SameSite=Strict; Path=/confirmations; Max-Age=900${secure ? "; Secure" : ""}`);
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
  const siteName = await options.service.confirmationSiteName(view, session.principal!.principalId!);
  sendHtml(response, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex, nofollow"><title>Review publication</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#172335}h1{font-size:2rem}iframe{width:100%;height:480px;border:1px solid #8b98aa;border-radius:8px;background:#fff}button{font:inherit;background:#173b67;color:white;border:0;border-radius:6px;padding:.7rem 1.5rem;cursor:pointer}details{margin-top:2rem}dt{font-weight:600;margin-top:.5rem}dd{margin:0;overflow-wrap:anywhere}code{font-size:.85rem}nav{margin:1rem 0}</style></head><body><main><h1>Review publication</h1><p>Site: <strong>${escapeHtml(siteName ?? view.siteId)}</strong></p><p>Review the saved page below. Publishing will use these exact files.</p><iframe title="Page preview" src="${escapeHtml(`/confirmations/${token}/preview`)}"></iframe><nav><a href="${escapeHtml(`/confirmations/${token}/preview`)}" target="_blank" rel="noopener noreferrer">Open full preview</a></nav><p>Signed in as ${escapeHtml(session.accountLabel ?? session.principal!.subject)} · <a href="${escapeHtml(`/confirmations/${token}/switch`)}">Use another account</a></p><form method="post" action="${escapeHtml(`/confirmations/${token}`)}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Publish</button></form><p>The agent will finish publication and report the result after you approve it here.</p><details><summary>Technical details</summary><dl>${summary}</dl></details></main></body></html>`);
}

async function confirmDecision(response: ServerResponse, options: McpHttpOptions, browserAuth: BrowserAuth, token: string, request: IncomingMessage, secure: boolean): Promise<void> {
  // The capability routes the request; only a logged-in browser session may
  // decide. Bearer tokens — the same ones MCP clients use — are never
  // consulted here. This check comes before CSRF so stale or foreign
  // sessions get a clear rejection regardless of form contents.
  const view = await options.service.resolveConfirmationView(token);
  if (!view) return sendHtml(response, 404, confirmationShell("Confirmation unavailable", "This confirmation link is invalid or has expired."));
  const session = await resolveBrowserSession(response, options, browserAuth, request, view);
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
      ? "Your approval is saved for the page you reviewed. The agent can finish publishing and report the result."
      : "Your approval was already saved; no further action is needed.";
    return sendHtml(response, 200, confirmationShell(decision.recorded ? "Publication approved" : "Publication already approved", body));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "REQUEST_REJECTED";
    if (code === "RELEASE_CONFIRMATION_REVOKED") return sendHtml(response, 410, confirmationShell("Confirmation revoked", "This confirmation has been revoked."));
    if (code === "RELEASE_CONFIRMATION_EXPIRED") return sendHtml(response, 410, confirmationShell("Confirmation expired", "This confirmation link is no longer valid."));
    if (code === "REVIEWED_ASTRO_ARTIFACT_NOT_BUILT") return sendHtml(response, 409, confirmationShell("Build not finished", "The trusted build for this release has not completed yet; ask the agent for the build status, then reopen this page."));
    return sendHtml(response, 400, confirmationShell("Request rejected", "The decision could not be recorded."));
  }
}

interface BrowserAuth {
  readonly pendingLogins: Map<string, { readonly verifier: string; readonly nonce: string; readonly returnUrl: string; readonly createdAt: number }>;
  readonly revoked: Set<string>;
}

const SESSION_TTL_SECONDS = 8 * 3600;
const LOGIN_STATE_TTL_MS = 600_000;

interface BrowserSession {
  readonly id: string;
  readonly principalId: string;
  readonly verified: VerifiedAccessToken;
  readonly expiresAt: number;
  readonly refreshToken?: string;
  readonly providerSessionId?: string;
  readonly accountLabel?: string;
}

function sessionKey(secret: string): Buffer {
  return createHash("sha256").update("navocms:browser-session:v1:").update(secret).digest();
}

function sealSession(session: BrowserSession, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

function openSession(value: string | undefined, secret: string | undefined): BrowserSession | undefined {
  if (!value || !secret || value.length > 8192) return undefined;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return undefined;
  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[3]!, "base64url");
    if (iv.length !== 12 || tag.length !== 16) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", sessionKey(secret), iv);
    decipher.setAuthTag(tag);
    const session = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2]!, "base64url")), decipher.final()]).toString("utf8")) as BrowserSession;
    if (typeof session.id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(session.id) || typeof session.principalId !== "string" ||
      !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now() ||
      !session.verified || session.verified.principal.kind !== "human" ||
      typeof session.verified.principal.issuer !== "string" || typeof session.verified.principal.subject !== "string") return undefined;
    return session;
  } catch { return undefined; }
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
async function resolveBrowserSession(response: ServerResponse, options: McpHttpOptions, browserAuth: BrowserAuth, request: IncomingMessage, view: { tenantId: string; siteId: string }): Promise<{ principal?: { principalId?: string; issuer: string; subject: string }; accountLabel?: string; error?: { status: number; title: string; body: string } }> {
  const cookie = parseCookies(request.headers.cookie)[CONFIRMATION_SESSION_COOKIE];
  const record = openSession(cookie, options.confirmationLogin?.clientSecret);
  if (!record) {
    return { error: { status: 401, title: "Human session required", body: "This confirmation records a human publication decision and requires your own logged-in session. The link the agent shared identifies the request; it does not authorize the decision by itself." } };
  }
  // Access-token authority is never extended by the browser cookie. An
  // expired token needs a successful refresh from the identity provider.
  let verified = record.verified;
  let refreshedCookie: string | undefined;
  if (verified.claims.exp * 1000 <= Date.now()) {
    const login = options.confirmationLogin;
    if (!record.refreshToken || !login) {
      return { error: { status: 401, title: "Human session required", body: "Your sign-in expired. Sign in again." } };
    }
    try {
      const refreshed = await fetch(login.tokenEndpoint, {
        method: "POST", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: record.refreshToken,
          client_id: login.clientId, client_secret: login.clientSecret, resource: options.resource })
      });
      if (!refreshed.ok) throw new Error("Refresh denied");
      const tokens = await refreshed.json() as { access_token?: unknown; refresh_token?: unknown };
      if (typeof tokens.access_token !== "string") throw new Error("No access token");
      const next = await login.verifier.verify(tokens.access_token);
      if (next.principal.kind !== "human" || next.claims.iss !== verified.claims.iss || next.claims.sub !== verified.claims.sub ||
        next.tenantId !== verified.tenantId || next.siteId !== verified.siteId) throw new Error("Refresh identity changed");
      verified = next;
      const nextRefresh = typeof tokens.refresh_token === "string" ? tokens.refresh_token : record.refreshToken;
      refreshedCookie = sealSession({ ...record, verified: next, refreshToken: nextRefresh }, login.clientSecret);
    } catch {
      return { error: { status: 401, title: "Human session required", body: "Your sign-in is no longer active. Sign in again." } };
    }
  }
  let context: AuthorizationContext;
  try {
    context = options.resolveAuthorization ? await options.resolveAuthorization(verified) : authorizationContext(verified);
  } catch {
    return { error: { status: 403, title: "Not authorized", body: "Your publication authority is no longer valid." } };
  }
  if (context.expiresAt && Date.parse(context.expiresAt) <= Date.now()) {
    return { error: { status: 401, title: "Human session required", body: "Your session has expired. Sign in again." } };
  }
  if (context.principal.kind !== "human" || verified.principal.kind !== "human") {
    return { error: { status: 403, title: "Not authorized", body: "A delegated agent session cannot record this decision; the confirmation must come from your own logged-in human session." } };
  }
  if (context.tenantId !== view.tenantId || context.siteId !== view.siteId) {
    return { error: { status: 403, title: "Not authorized", body: "Your session belongs to another site; this confirmation is scoped to the release's site." } };
  }
  if (!effectivePermissions(context.layers).includes("content:publish")) {
    return { error: { status: 403, title: "Not authorized", body: "Your session does not hold publication authority for this site." } };
  }
  const scope = { id: record.id, tenantId: context.tenantId, siteId: context.siteId, principalId: context.principal.id };
  let revoked = browserAuth.revoked.has(record.id);
  try { revoked ||= (await options.browserSessionRevocations?.isRevoked(scope)) ?? false; }
  catch { return { error: { status: 503, title: "Review unavailable", body: "The session check is temporarily unavailable. Try again shortly." } }; }
  if (revoked) {
    return { error: { status: 401, title: "Human session required", body: "This session was signed out. Sign in again." } };
  }
  if (refreshedCookie) appendCookie(response, `${CONFIRMATION_SESSION_COOKIE}=${refreshedCookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000))}${isSecureRequest(request) ? "; Secure" : ""}`);
  return { principal: { principalId: context.principal.id, issuer: context.principal.issuer, subject: context.principal.subject }, accountLabel: record.accountLabel ?? context.principal.subject };
}

/** Starts the OIDC authorization-code login (PKCE S256, single-use state). */
function startLogin(response: ServerResponse, options: McpHttpOptions, browserAuth: BrowserAuth, token: string, request: IncomingMessage, secure: boolean, force = false): void {
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
  const nonce = randomBytes(32).toString("base64url");
  browserAuth.pendingLogins.set(state, { verifier, nonce, returnUrl: `/confirmations/${token}`, createdAt: Date.now() });
  const proto = request.headers["x-forwarded-proto"] === "https" || secure ? "https" : "http";
  const redirectUri = `${proto}://${request.headers.host ?? "localhost"}/confirmations/callback`;
  const authorization = new URL(login.authorizationEndpoint);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", login.clientId);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("nonce", nonce);
  authorization.searchParams.set("resource", options.resource);
  authorization.searchParams.set("scope", (login.scopes ?? ["openid"]).join(" "));
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  if (force) authorization.searchParams.set("max_age", "0");
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
  if (!pending || !code || Date.now() - pending.createdAt >= LOGIN_STATE_TTL_MS) {
    return sendHtml(response, 400, confirmationShell("Login could not be completed", "This sign-in response is unknown, expired, or was already used. Open the confirmation link again."));
  }
  const proto = request.headers["x-forwarded-proto"] === "https" || secure ? "https" : "http";
  const redirectUri = `${proto}://${request.headers.host ?? "localhost"}/confirmations/callback`;
  let accessToken: string | undefined;
  let idToken: string | undefined;
  let refreshToken: string | undefined;
  try {
    const tokenResponse = await fetch(login.tokenEndpoint, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: login.clientId,
        client_secret: login.clientSecret,
        code_verifier: pending.verifier,
        resource: options.resource
      })
    });
    if (tokenResponse.ok) {
      const payload = await tokenResponse.json() as { access_token?: unknown; id_token?: unknown; refresh_token?: unknown };
      if (typeof payload.access_token === "string") accessToken = payload.access_token;
      if (typeof payload.id_token === "string") idToken = payload.id_token;
      if (typeof payload.refresh_token === "string") refreshToken = payload.refresh_token;
    }
  } catch {
    accessToken = undefined;
  }
  if (accessToken === undefined || idToken === undefined) {
    return sendHtml(response, 401, confirmationShell("Sign-in failed", "The identity provider rejected this sign-in. Open the confirmation link and try again."));
  }
  let context: AuthorizationContext;
  let verified: VerifiedAccessToken;
  let verifiedForSwitch: VerifiedAccessToken | undefined;
  let identity: VerifiedAccessToken;
  let stage = "identity_token";
  try {
    identity = await login.idTokenVerifier.verify(idToken);
    stage = "access_token";
    verified = await login.verifier.verify(accessToken);
    verifiedForSwitch = verified;
    stage = "exchange_binding";
    const claims = identity.claims;
    if (claims.nonce !== pending.nonce || claims.sub !== verified.claims.sub || claims.iss !== verified.claims.iss
      || (claims.azp !== undefined && claims.azp !== login.clientId)
      || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== login.clientId)
      || (claims.at_hash !== undefined && claims.at_hash !== createHash("sha256").update(accessToken).digest().subarray(0, 16).toString("base64url"))) {
      throw new Error("Browser identity token does not bind this authorization exchange");
    }
    stage = "site_membership";
    context = options.resolveAuthorization ? await options.resolveAuthorization(verified) : authorizationContext(verified);
  } catch (error) {
    // Fixed internal error codes only: never log token claims, identity or provider payloads.
    console.warn(JSON.stringify({ event: "confirmation.login_rejected", stage,
      code: error instanceof SecurityError ? error.code : "LOGIN_REJECTED" }));
    if (typeof verifiedForSwitch?.claims.sid === "string") {
      const hint = sealSession({ id: randomBytes(32).toString("base64url"), principalId: verifiedForSwitch.principal.id,
        verified: verifiedForSwitch, expiresAt: Date.now() + LOGIN_STATE_TTL_MS,
        providerSessionId: verifiedForSwitch.claims.sid }, login.clientSecret);
      const previous = response.getHeader("set-cookie");
      response.setHeader("set-cookie", [...(Array.isArray(previous) ? previous : previous ? [String(previous)] : []),
        `${CONFIRMATION_SWITCH_HINT_COOKIE}=${hint}; HttpOnly; SameSite=Lax; Path=/confirmations; Max-Age=600${secure ? "; Secure" : ""}`]);
    }
    return sendHtml(response, 403, confirmationShell("Sign-in rejected",
      `This account cannot publish to this site. <a href="${escapeHtml(`${pending.returnUrl}/switch`)}">Use another account</a>.`));
  }
  if (context.principal.kind !== "human" || verified.principal.kind !== "human" || identity.principal.kind !== "human") {
    return sendHtml(response, 403, confirmationShell("Sign-in rejected", "A delegated agent identity cannot sign in for a human confirmation; use your own account."));
  }
  const expiresAt = refreshToken ? Date.now() + SESSION_TTL_SECONDS * 1000
    : Math.min(Date.now() + SESSION_TTL_SECONDS * 1000, verified.claims.exp * 1000, identity.claims.exp * 1000);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return sendHtml(response, 401, confirmationShell("Sign-in failed", "Your authorization has expired. Sign in again."));
  }
  const providerSessionId = verified.claims.sid;
  const accountLabel = identity.claims.email;
  const sessionValue = sealSession({ id: randomBytes(32).toString("base64url"), principalId: context.principal.id, verified: {
    ...verified,
    claims: {
      iss: verified.claims.iss, sub: verified.claims.sub, aud: verified.claims.aud, exp: verified.claims.exp,
      ...(verified.claims.role ? { role: verified.claims.role } : {}),
      ...(verified.claims.roles ? { roles: verified.claims.roles } : {})
    }
  }, expiresAt, ...(refreshToken ? { refreshToken } : {}), ...(typeof providerSessionId === "string" ? { providerSessionId } : {}),
    ...(typeof accountLabel === "string" && accountLabel.length < 256 ? { accountLabel } : {}) }, login.clientSecret);
  response.statusCode = 302;
  response.setHeader("location", pending.returnUrl);
  response.setHeader("set-cookie", `${CONFIRMATION_SESSION_COOKIE}=${sessionValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))}${secure ? "; Secure" : ""}`);
  response.end();
}

async function switchAccount(response: ServerResponse, options: McpHttpOptions, browserAuth: BrowserAuth, token: string, request: IncomingMessage, secure: boolean): Promise<void> {
  const view = await options.service.resolveConfirmationView(token);
  if (!view) return sendHtml(response, 404, confirmationShell("Confirmation unavailable", "Ask the agent for a current publication link."));
  const login = options.confirmationLogin;
  if (!login) return sendHtml(response, 503, confirmationShell("Login unavailable", "The site sign-in is not configured."));
  const session = openSession(parseCookies(request.headers.cookie)[CONFIRMATION_SESSION_COOKIE], login.clientSecret);
  const hint = openSession(parseCookies(request.headers.cookie)[CONFIRMATION_SWITCH_HINT_COOKIE], login.clientSecret);
  if (session) {
    try {
      await options.browserSessionRevocations?.revoke({ id: session.id, tenantId: session.verified.tenantId,
        siteId: session.verified.siteId, principalId: session.principalId, expiresAt: session.expiresAt });
      browserAuth.revoked.add(session.id);
    } catch { return sendHtml(response, 503, confirmationShell("Account switch unavailable", "The session could not be signed out. Try again shortly.")); }
  }
  response.setHeader("set-cookie", [
    `${CONFIRMATION_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`,
    `${CONFIRMATION_SWITCH_HINT_COOKIE}=; HttpOnly; SameSite=Lax; Path=/confirmations; Max-Age=0${secure ? "; Secure" : ""}`
  ]);
  const providerSessionId = session?.providerSessionId ?? hint?.providerSessionId;
  if (login.logoutEndpoint && providerSessionId) {
    const providerLogout = new URL(login.logoutEndpoint);
    if (providerLogout.protocol !== "https:" && secure) return sendHtml(response, 503, confirmationShell("Account switch unavailable", "The sign-out provider is not configured securely."));
    const proto = secure ? "https" : "http";
    providerLogout.searchParams.set("session_id", providerSessionId);
    providerLogout.searchParams.set("return_to", `${proto}://${request.headers.host ?? "localhost"}/confirmations/${token}`);
    response.writeHead(302, { location: providerLogout.toString() });
    response.end();
    return;
  }
  return startLogin(response, options, browserAuth, token, request, secure, true);
}

async function renewConfirmation(response: ServerResponse, options: McpHttpOptions, browserAuth: BrowserAuth, token: string, request: IncomingMessage, secure: boolean): Promise<void> {
  const view = await options.service.resolveConfirmationView(token);
  if (!view) return sendHtml(response, 404, confirmationShell("Review link unavailable", "Ask the agent for a new review link."));
  const session = await resolveBrowserSession(response, options, browserAuth, request, view);
  if (session.error) return sendHtml(response, session.error.status, confirmationShell(session.error.title, escapeHtml(session.error.body)));
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin && origin !== "null" && host && origin !== `https://${host}` && origin !== `http://${host}`) {
    return sendHtml(response, 403, confirmationShell("Request rejected", "Open this link from its own page."));
  }
  let form: Record<string, string>;
  try { form = parseForm(await readBody(request, 64 * 1024)); }
  catch { return sendHtml(response, 400, confirmationShell("Request rejected", "The form could not be read.")); }
  const csrf = parseCookies(request.headers.cookie)[CONFIRMATION_CSRF_COOKIE];
  if (!csrf || form.csrf !== csrf) return sendHtml(response, 403, confirmationShell("Request rejected", "Reopen the review link and try again."));
  try {
    const location = await options.service.renewConfirmationLink(token, session.principal!.principalId!);
    response.writeHead(303, { location });
    response.end();
  } catch {
    sendHtml(response, 409, confirmationShell("New review needed", "This saved build can no longer be reviewed. Ask the agent to prepare a new candidate."));
  }
}

async function confirmationPreview(response: ServerResponse, options: McpHttpOptions, browserAuth: BrowserAuth, token: string, rest: string | undefined, request: IncomingMessage): Promise<void> {
  const view = await options.service.resolveConfirmationView(token);
  if (!view) return sendJson(response, 404, { error: "PREVIEW_NOT_FOUND" });
  const session = await resolveBrowserSession(response, options, browserAuth, request, view);
  if (session.error) return sendJson(response, session.error.status, { error: "PREVIEW_NOT_AUTHORIZED" });
  const output = await options.service.resolveConfirmationOutput(token);
  if (!output) return sendJson(response, 410, { error: "PREVIEW_EXPIRED" });
  let path: string;
  try { path = rest ? decodeURIComponent(rest.split("?")[0] ?? "") : pickEntryHtml(output) ?? ""; }
  catch { return sendJson(response, 400, { error: "INVALID_PREVIEW_PATH" }); }
  if (!safeOutputPath(path) || output[path] === undefined) return sendJson(response, 404, { error: "PREVIEW_NOT_FOUND" });
  response.setHeader("cache-control", "private, no-store, max-age=0");
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", REVIEW_PREVIEW_CSP);
  response.setHeader("content-type", outputContentType(path));
  const body = output[path]!;
  response.end(path.endsWith(".html") ? bindCapabilityUrls(body, `/confirmations/${token}/preview`, "html", path)
    : path.endsWith(".css") ? bindCapabilityUrls(body, `/confirmations/${token}/preview`, "css", path) : body);
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
  return value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.includes("\\") &&
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

function appendCookie(response: ServerResponse, value: string): void {
  const previous = response.getHeader("set-cookie");
  response.setHeader("set-cookie", [...(Array.isArray(previous) ? previous : previous ? [String(previous)] : []), value]);
}

function isSecureRequest(request: IncomingMessage): boolean {
  return request.socket instanceof TLSSocket || request.headers["x-forwarded-proto"] === "https";
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
