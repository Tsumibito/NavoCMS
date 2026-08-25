import { describe, expect, it } from "vitest";

import { principalPermissions } from "./identity.js";

const claims = {
  iss: "https://identity.example.test",
  sub: "user-one",
  aud: "https://cms.example.test/mcp",
  exp: 2_000_000_000
} as const;

describe("issuer role permission mapping", () => {
  it("uses a mapped issuer role when Connect supplies no product scopes", () => {
    expect(principalPermissions({ claims: { ...claims, role: "navocms-owner" }, scopes: ["openid"] }, {
      "navocms-owner": ["content:read", "content:draft", "content:publish"]
    })).toEqual(["content:read", "content:draft", "content:publish"]);
  });

  it("intersects mapped roles with product scopes when both are present", () => {
    expect(principalPermissions({
      claims: { ...claims, roles: ["navocms-owner"] },
      scopes: ["content:read", "content:draft"]
    }, {
      "navocms-owner": ["content:read", "content:draft", "content:publish"]
    })).toEqual(["content:read", "content:draft"]);
  });

  it("fails closed for missing, unknown, or malformed role claims", () => {
    const mapping = { "navocms-owner": ["content:read"] } as const;
    expect(principalPermissions({ claims, scopes: ["openid"] }, mapping)).toEqual([]);
    expect(principalPermissions({ claims: { ...claims, role: "member" }, scopes: ["openid"] }, mapping)).toEqual([]);
    expect(principalPermissions({
      claims: { ...claims, roles: ["navocms-owner", 42] as unknown as readonly string[] },
      scopes: ["openid"]
    }, mapping)).toEqual([]);
  });
});
