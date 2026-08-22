import { describe, expect, it } from "vitest";

import { environmentInteger } from "./config.js";

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
