import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ContractValidationError, contracts } from "./index.js";

async function fixture(relativePath: string): Promise<unknown> {
  const url = new URL(`../../../examples/${relativePath}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}

describe("public contract validators", () => {
  it("accepts the versioned foundation fixtures", async () => {
    expect(contracts.plugin.parse(await fixture("plugins/media-imgproxy.plugin.json"))).toBeTruthy();
    expect(contracts.profile.parse(await fixture("profiles/simple-blog.profile.json"))).toBeTruthy();
    expect(contracts.contentType.parse(await fixture("content-types/article.content-type.json"))).toBeTruthy();
    expect(contracts.event.parse(await fixture("events/revision-created.event.json"))).toBeTruthy();
  });

  it("returns bounded validation issues", () => {
    expect(() => contracts.plugin.parse({ kind: "PluginManifest" })).toThrow(ContractValidationError);
    try {
      contracts.plugin.parse({ kind: "PluginManifest" });
    } catch (error) {
      expect(error).toBeInstanceOf(ContractValidationError);
      expect((error as ContractValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  it("enforces cross-field consequence semantics", async () => {
    const plugin = contracts.plugin.parse(await fixture("plugins/media-imgproxy.plugin.json"));
    const unsafe = {
      ...plugin,
      spec: {
        ...plugin.spec,
        effects: plugin.spec.effects.map((effect) => ({ ...effect, idempotent: false }))
      }
    };

    expect(() => contracts.plugin.parse(unsafe)).toThrowError(/must be idempotent for G1/);
    expect(contracts.plugin.is(unsafe)).toBe(false);
  });
});
