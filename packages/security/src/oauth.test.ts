import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { OidcJwtVerifier, bearerChallenge, protectedResourceMetadata } from "./oauth.js";

const issuer = "https://identity.example";
const resource = "https://api.navocms.com";

function jwt(
  claims: Record<string, unknown>,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("MCP OAuth resource server", () => {
  it("publishes protected resource metadata and a discoverable challenge", () => {
    const metadata = protectedResourceMetadata({
      resource,
      authorizationServers: [issuer],
      scopes: ["content:read", "content:draft"]
    });
    expect(metadata).toEqual({
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["content:read", "content:draft"]
    });
    expect(bearerChallenge(resource, `${resource}/.well-known/oauth-protected-resource`, ["content:read"])).toContain(
      `resource_metadata="${resource}/.well-known/oauth-protected-resource"`
    );
  });

  it("verifies issuer, audience, expiry, signature, scopes, and immutable scope claims", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: "jwk" });
    const verifier = new OidcJwtVerifier({
      issuer,
      audience: resource,
      jwks: async () => ({ keys: [{ ...publicJwk, kty: "RSA", kid: "test-key", alg: "RS256", use: "sig" }] }),
      now: () => 1_800_000_000,
      clockToleranceSeconds: 0
    });
    const token = jwt(
      {
        iss: issuer,
        sub: "user-1",
        aud: resource,
        exp: 1_800_000_060,
        scope: "content:read content:draft",
        tenant_id: "tenant-1",
        site_id: "site-1",
        principal_id: "principal-1"
      },
      privateKey
    );
    await expect(verifier.verify(token, ["content:draft"])).resolves.toMatchObject({
      tenantId: "tenant-1",
      siteId: "site-1",
      principal: { id: "principal-1", kind: "human" }
    });
    await expect(verifier.verify(token, ["content:publish"])).rejects.toMatchObject({
      code: "OAUTH_SCOPE_INSUFFICIENT"
    });
  });

  it("rejects tokens minted for another resource", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: "jwk" });
    const verifier = new OidcJwtVerifier({
      issuer,
      audience: resource,
      jwks: async () => ({ keys: [{ ...publicJwk, kty: "RSA", kid: "test-key" }] }),
      now: () => 100
    });
    const token = jwt(
      {
        iss: issuer,
        sub: "user-1",
        aud: "https://other.example",
        exp: 200,
        tenant_id: "tenant-1",
        site_id: "site-1"
      },
      privateKey
    );
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: "OAUTH_AUDIENCE_INVALID" });
  });

  it("binds a standard OIDC token to the deployment resource scope", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: "jwk" });
    const verifier = new OidcJwtVerifier({
      issuer,
      audience: resource,
      deploymentScope: { tenantId: "tenant-from-resource", siteId: "site-from-resource" },
      jwks: async () => ({ keys: [{ ...publicJwk, kty: "RSA", kid: "test-key" }] }),
      now: () => 100
    });
    const token = jwt({
      iss: issuer,
      sub: "workos-user-1",
      aud: resource,
      exp: 200,
      scope: "content:read"
    }, privateKey);
    await expect(verifier.verify(token)).resolves.toMatchObject({
      tenantId: "tenant-from-resource",
      siteId: "site-from-resource",
      principal: { id: `${issuer}|workos-user-1`, subject: "workos-user-1" }
    });
  });

  it("accepts permission-array claims alongside the standard scope claim", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: "jwk" });
    const verifier = new OidcJwtVerifier({
      issuer,
      audience: resource,
      deploymentScope: { tenantId: "tenant-from-resource", siteId: "site-from-resource" },
      jwks: async () => ({ keys: [{ ...publicJwk, kty: "RSA", kid: "test-key" }] }),
      now: () => 100
    });
    const token = jwt({
      iss: issuer,
      sub: "provider-user-1",
      aud: resource,
      exp: 200,
      scope: "openid content:read",
      permissions: ["content:draft", "content:publish", "content:read"]
    }, privateKey);

    await expect(verifier.verify(token, ["content:read", "content:publish"])).resolves.toMatchObject({
      scopes: ["openid", "content:read", "content:draft", "content:publish"]
    });
  });

  it("rejects a malformed permission-array claim", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: "jwk" });
    const verifier = new OidcJwtVerifier({
      issuer,
      audience: resource,
      deploymentScope: { tenantId: "tenant-from-resource", siteId: "site-from-resource" },
      jwks: async () => ({ keys: [{ ...publicJwk, kty: "RSA", kid: "test-key" }] }),
      now: () => 100
    });
    const token = jwt({
      iss: issuer,
      sub: "provider-user-1",
      aud: resource,
      exp: 200,
      permissions: ["content:read", 42]
    }, privateKey);

    await expect(verifier.verify(token)).rejects.toMatchObject({ code: "OAUTH_CLAIM_INVALID" });
  });
});
