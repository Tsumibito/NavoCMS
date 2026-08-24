import { createHash, timingSafeEqual, webcrypto } from "node:crypto";

import { SecurityError } from "./errors.js";
import type { Principal } from "./authorization.js";

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly bearer_methods_supported: readonly ["header"];
  readonly scopes_supported?: readonly string[];
  readonly resource_documentation?: string;
}

export interface OAuthResourceConfig {
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  readonly scopes?: readonly string[];
  readonly documentationUrl?: string;
}

export function protectedResourceMetadata(config: OAuthResourceConfig): ProtectedResourceMetadata {
  const resource = canonicalHttpsUrl(config.resource, "resource");
  const authorizationServers = config.authorizationServers.map((value) => canonicalHttpsUrl(value, "issuer"));
  if (authorizationServers.length === 0) {
    throw new SecurityError("OAUTH_ISSUER_REQUIRED", "At least one authorization server is required");
  }
  return Object.freeze({
    resource,
    authorization_servers: Object.freeze(authorizationServers),
    bearer_methods_supported: ["header"] as const,
    ...(config.scopes ? { scopes_supported: Object.freeze([...config.scopes]) } : {}),
    ...(config.documentationUrl ? { resource_documentation: canonicalHttpsUrl(config.documentationUrl, "documentation") } : {})
  });
}

function canonicalHttpsUrl(input: string, field: string): string {
  const parsed = new URL(input);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new SecurityError("OAUTH_URL_INVALID", `${field} must be a canonical HTTPS URL`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function bearerChallenge(resource: string, metadataUrl: string, scopes: readonly string[]): string {
  canonicalHttpsUrl(resource, "resource");
  canonicalHttpsUrl(metadataUrl, "resource metadata");
  const fields = [
    `resource_metadata="${metadataUrl}"`,
    `resource="${resource}"`,
    ...(scopes.length > 0 ? [`scope="${scopes.join(" ")}"`] : [])
  ];
  return `Bearer ${fields.join(", ")}`;
}

export interface JwtClaims extends Record<string, unknown> {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly nbf?: number;
  readonly scope?: string;
  readonly permissions?: readonly string[];
  readonly tenant_id?: string;
  readonly site_id?: string;
  readonly principal_kind?: "human" | "agent" | "service";
  readonly principal_id?: string;
}

export interface VerifiedAccessToken {
  readonly claims: JwtClaims;
  readonly principal: Principal;
  readonly tenantId: string;
  readonly siteId: string;
  readonly scopes: readonly string[];
}

export interface AccessTokenVerifier {
  verify(token: string, requiredScopes?: readonly string[]): Promise<VerifiedAccessToken>;
}

export interface JsonWebKeySet {
  readonly keys: readonly JsonWebKey[];
}

export interface JsonWebKey {
  readonly kty: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly n?: string;
  readonly e?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly [member: string]: unknown;
}

export interface OidcJwtVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwks: () => Promise<JsonWebKeySet>;
  readonly now?: () => number;
  readonly clockToleranceSeconds?: number;
  readonly deploymentScope?: Readonly<{ readonly tenantId: string; readonly siteId: string }>;
}

interface JwtHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
}

function decodePart<T>(part: string, label: string): T {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
  } catch {
    throw new SecurityError("OAUTH_TOKEN_MALFORMED", `Invalid JWT ${label}`);
  }
}

function includesAudience(audience: string | readonly string[], expected: string): boolean {
  return typeof audience === "string" ? audience === expected : audience.includes(expected);
}

function requireString(claims: Record<string, unknown>, name: string): string {
  const value = claims[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new SecurityError("OAUTH_CLAIM_INVALID", `Access token is missing ${name}`);
  }
  return value;
}

export class OidcJwtVerifier implements AccessTokenVerifier {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #jwks: () => Promise<JsonWebKeySet>;
  readonly #now: () => number;
  readonly #tolerance: number;
  readonly #deploymentScope: Readonly<{ readonly tenantId: string; readonly siteId: string }> | undefined;

  public constructor(options: OidcJwtVerifierOptions) {
    this.#issuer = canonicalHttpsUrl(options.issuer, "issuer");
    this.#audience = canonicalHttpsUrl(options.audience, "audience");
    this.#jwks = options.jwks;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#tolerance = options.clockToleranceSeconds ?? 30;
    this.#deploymentScope = options.deploymentScope;
  }

  public async verify(token: string, requiredScopes: readonly string[] = []): Promise<VerifiedAccessToken> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new SecurityError("OAUTH_TOKEN_MALFORMED", "Access token must be a JWT");
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
    const header = decodePart<JwtHeader>(encodedHeader, "header");
    const rawClaims = decodePart<Record<string, unknown>>(encodedClaims, "claims");
    if (header.alg !== "RS256" || !header.kid) {
      throw new SecurityError("OAUTH_ALGORITHM_REJECTED", "Only keyed RS256 access tokens are accepted");
    }
    const jwks = await this.#jwks();
    const key = jwks.keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
    if (!key) throw new SecurityError("OAUTH_KEY_NOT_FOUND", "No matching signing key was found");
    const cryptoKey = await webcrypto.subtle.importKey(
      "jwk",
      key as webcrypto.JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const verified = await webcrypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      Buffer.from(encodedSignature, "base64url"),
      Buffer.from(`${encodedHeader}.${encodedClaims}`)
    );
    if (!verified) throw new SecurityError("OAUTH_SIGNATURE_INVALID", "Access token signature is invalid");

    const issuer = requireString(rawClaims, "iss");
    const subject = requireString(rawClaims, "sub");
    const claimTenantId = optionalString(rawClaims, "tenant_id");
    const claimSiteId = optionalString(rawClaims, "site_id");
    if (claimTenantId && this.#deploymentScope && claimTenantId !== this.#deploymentScope.tenantId) {
      throw new SecurityError("OAUTH_CLAIM_INVALID", "Access token tenant scope conflicts with this resource");
    }
    if (claimSiteId && this.#deploymentScope && claimSiteId !== this.#deploymentScope.siteId) {
      throw new SecurityError("OAUTH_CLAIM_INVALID", "Access token site scope conflicts with this resource");
    }
    const tenantId = claimTenantId ?? this.#deploymentScope?.tenantId;
    const siteId = claimSiteId ?? this.#deploymentScope?.siteId;
    if (!tenantId || !siteId) {
      throw new SecurityError("OAUTH_CLAIM_INVALID", "Access token or resource configuration must supply tenant and site scope");
    }
    const audience = rawClaims.aud;
    const expiresAt = rawClaims.exp;
    if (issuer !== this.#issuer) throw new SecurityError("OAUTH_ISSUER_INVALID", "Access token issuer is invalid");
    if (!(typeof audience === "string" || (Array.isArray(audience) && audience.every((item) => typeof item === "string")))) {
      throw new SecurityError("OAUTH_AUDIENCE_INVALID", "Access token audience is invalid");
    }
    if (!includesAudience(audience as string | string[], this.#audience)) {
      throw new SecurityError("OAUTH_AUDIENCE_INVALID", "Access token was not issued for this resource");
    }
    if (typeof expiresAt !== "number" || expiresAt <= this.#now() - this.#tolerance) {
      throw new SecurityError("OAUTH_TOKEN_EXPIRED", "Access token has expired");
    }
    if (typeof rawClaims.nbf === "number" && rawClaims.nbf > this.#now() + this.#tolerance) {
      throw new SecurityError("OAUTH_TOKEN_NOT_ACTIVE", "Access token is not active yet");
    }
    const scopes = effectiveScopes(rawClaims);
    const missingScope = requiredScopes.find((scope) => !scopes.includes(scope));
    if (missingScope) throw new SecurityError("OAUTH_SCOPE_INSUFFICIENT", `Access token lacks scope ${missingScope}`);
    const kind = rawClaims.principal_kind;
    const claims = rawClaims as JwtClaims;
    return Object.freeze({
      claims,
      principal: Object.freeze({
        id: typeof rawClaims.principal_id === "string" ? rawClaims.principal_id : `${issuer}|${subject}`,
        kind: kind === "agent" || kind === "service" ? kind : "human",
        issuer,
        subject
      }),
      tenantId,
      siteId,
      scopes: Object.freeze(scopes)
    });
  }
}

function effectiveScopes(claims: Record<string, unknown>): readonly string[] {
  const scopeClaim = claims.scope;
  if (scopeClaim !== undefined && typeof scopeClaim !== "string") {
    throw new SecurityError("OAUTH_CLAIM_INVALID", "Access token has an invalid scope");
  }
  const permissionsClaim = claims.permissions;
  if (
    permissionsClaim !== undefined &&
    (!Array.isArray(permissionsClaim) || permissionsClaim.some((permission) => typeof permission !== "string" || permission.length === 0))
  ) {
    throw new SecurityError("OAUTH_CLAIM_INVALID", "Access token has invalid permissions");
  }
  return Object.freeze([
    ...new Set([
      ...(scopeClaim?.split(/\s+/).filter(Boolean) ?? []),
      ...((permissionsClaim as string[] | undefined) ?? [])
    ])
  ]);
}

function optionalString(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new SecurityError("OAUTH_CLAIM_INVALID", `Access token has an invalid ${name}`);
  }
  return value;
}

export function createRemoteJwksProvider(jwksUrl: string, fetcher: typeof fetch = fetch): () => Promise<JsonWebKeySet> {
  const url = canonicalHttpsUrl(jwksUrl, "JWKS");
  let cached: { value: JsonWebKeySet; expiresAt: number } | undefined;
  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const response = await fetcher(url, { headers: { accept: "application/json" }, redirect: "error" });
    if (!response.ok) throw new SecurityError("OAUTH_JWKS_UNAVAILABLE", "Unable to fetch signing keys");
    const body = (await response.json()) as Partial<JsonWebKeySet>;
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      throw new SecurityError("OAUTH_JWKS_INVALID", "Signing key set is invalid");
    }
    const value = Object.freeze({ keys: Object.freeze([...body.keys]) });
    cached = { value, expiresAt: Date.now() + 300_000 };
    return value;
  };
}

export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function constantTimeTokenMatch(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}
