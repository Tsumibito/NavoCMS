import { describe, expect, it } from "vitest";

import {
  authorize,
  effectivePermissions,
  requirePermission,
  siteRoleAuthority,
  type AuthorizationContext,
  type AuthorityLayer
} from "./authorization.js";

const layers: readonly AuthorityLayer[] = [
  { name: "principal", permissions: ["content:read", "content:draft", "content:publish"] },
  { name: "tenant", permissions: ["content:read", "content:draft", "content:publish"] },
  { name: "site", permissions: ["content:read", "content:draft"] },
  { name: "plugin", permissions: ["content:read", "content:draft", "content:publish"] },
  { name: "operation", permissions: ["content:publish"] }
];

const context: AuthorizationContext = {
  tenantId: "tenant-one",
  siteId: "site-one",
  principal: { id: "person-one", kind: "human", issuer: "https://id.example", subject: "one" },
  layers
};

describe("authorization intersection", () => {
  it("never grants a permission missing from any authority layer", () => {
    expect(effectivePermissions(layers)).toEqual([]);
    expect(authorize(context, "content:publish")).toMatchObject({ allowed: false, deniedBy: "site" });
  });

  it("rejects a foreign site even if permissions otherwise allow the operation", () => {
    const allowed: AuthorizationContext = {
      ...context,
      layers: [{ name: "principal", permissions: ["content:read"] }]
    };
    expect(() => requirePermission(allowed, "content:read", { tenantId: "tenant-one", siteId: "site-two" })).toThrow(
      /not authorized for this site/
    );
  });

  it("rejects expired delegated authority", () => {
    expect(
      authorize({ ...context, expiresAt: "2026-01-01T00:00:00.000Z" }, "content:read", new Date("2026-01-02T00:00:00Z"))
    ).toMatchObject({ allowed: false, deniedBy: "expired" });
  });

  it("maps persisted site roles to bounded permissions", () => {
    expect(siteRoleAuthority("viewer").permissions).toEqual(["content:read", "media:read"]);
    expect(siteRoleAuthority("editor").permissions).not.toContain("content:publish");
    expect(siteRoleAuthority("publisher").permissions).toContain("content:publish");
  });
});
