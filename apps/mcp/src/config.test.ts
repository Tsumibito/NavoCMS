import { describe, expect, it } from "vitest";

import { environmentInteger, environmentRolePermissions } from "./config.js";

describe("MCP runtime numeric configuration", () => {
  it("uses the fallback when the variable is absent", () => {
    expect(environmentInteger("VALUE", 3600, 604_800, {})).toBe(3600);
  });

  it("allows an explicit one-hour preview TTL", () => {
    expect(environmentInteger("NAVOCMS_PREVIEW_TTL_SECONDS", 3600, 604_800, {
      NAVOCMS_PREVIEW_TTL_SECONDS: "3600"
    })).toBe(3600);
  });

  it("keeps database pools bounded independently", () => {
    expect(() => environmentInteger("NAVOCMS_DATABASE_POOL_MAX", 8, 100, {
      NAVOCMS_DATABASE_POOL_MAX: "101"
    })).toThrow(/1 to 100/);
  });
});

describe("MCP issuer role configuration", () => {
  it("parses bounded role permission mappings", () => {
    expect(environmentRolePermissions("ROLE_MAP", {
      ROLE_MAP: JSON.stringify({
        "navocms-owner": ["content:read", "content:draft", "content:publish"]
      })
    })).toEqual({
      "navocms-owner": ["content:read", "content:draft", "content:publish"]
    });
  });

  it("rejects unknown permissions, malformed roles, and empty mappings", () => {
    expect(() => environmentRolePermissions("ROLE_MAP", { ROLE_MAP: "{}" })).toThrow(/1 to 32/);
    expect(() => environmentRolePermissions("ROLE_MAP", {
      ROLE_MAP: JSON.stringify({ "bad role": ["content:read"] })
    })).toThrow(/invalid role/);
    expect(() => environmentRolePermissions("ROLE_MAP", {
      ROLE_MAP: JSON.stringify({ owner: ["content:root"] })
    })).toThrow(/invalid permissions/);
  });
});
