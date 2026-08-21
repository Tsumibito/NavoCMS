import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { applyDesignOverride, compileDesignSystem, DesignContractError } from "./index.js";

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`../../../examples/design-systems/${name}`, import.meta.url), "utf8")
  ) as unknown;
}

describe("design system compiler", () => {
  it("resolves DTCG references and emits deterministic CSS", async () => {
    const input = await fixture("tidal-signal.design-system.json");
    const first = compileDesignSystem(input);
    const second = compileDesignSystem(structuredClone(input));

    expect(first.digest).toBe(second.digest);
    expect(first.tokens.find(({ path }) => path === "color.action")?.value).toBe("#0057b8");
    expect(first.css).toContain("--navo-color-action: #0057b8");
    expect(first.catalogue.componentCount).toBe(3);
  });

  it("rejects missing and cyclic token references", async () => {
    const input = (await fixture("tidal-signal.design-system.json")) as {
      spec: { tokens: { color: Record<string, { $value: string }> } };
    };
    input.spec.tokens.color.signal!.$value = "{color.action}";
    expect(() => compileDesignSystem(input)).toThrowError(DesignContractError);
    expect(() => compileDesignSystem(input)).toThrowError(/cycle/);
  });

  it("applies only policy-approved, unexpired overrides", async () => {
    const design = await fixture("tidal-signal.design-system.json");
    const override = await fixture("campaign.design-override.json");
    const compiled = applyDesignOverride(design, override, new Date("2026-10-01T00:00:00Z"));
    expect(compiled.tokens.find(({ path }) => path === "color.coral")?.value).toBe("#d94b3d");
    expect(compiled.components.get("story-card")?.variants[0]?.default).toBe("featured");

    const denied = structuredClone(override) as { spec: { tokens: Record<string, string> } };
    denied.spec.tokens["color.ink"] = "#000000";
    expect(() => applyDesignOverride(design, denied, new Date("2026-10-01T00:00:00Z"))).toThrowError(
      /override denied/
    );

    const excessive = structuredClone(override) as { spec: { expiresAt: string } };
    excessive.spec.expiresAt = "2028-01-01T00:00:00Z";
    expect(() => applyDesignOverride(design, excessive, new Date("2026-10-01T00:00:00Z"))).toThrowError(
      /180-day limit/
    );
  });
});
