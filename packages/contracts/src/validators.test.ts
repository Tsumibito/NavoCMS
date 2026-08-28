import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ContractValidationError, contracts, parseCompatibleCloudflareStagingBinding } from "./index.js";

async function fixture(relativePath: string): Promise<unknown> {
  const url = new URL(`../../../examples/${relativePath}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}

describe("public contract validators", () => {
  it("accepts the versioned foundation fixtures", async () => {
    expect(contracts.plugin.parse(await fixture("plugins/media-imgproxy.plugin.json"))).toBeTruthy();
    expect(contracts.profile.parse(await fixture("profiles/simple-blog.profile.json"))).toBeTruthy();
    expect(contracts.contentType.parse(await fixture("content-types/article.content-type.json"))).toBeTruthy();
    expect(
      contracts.designSystem.parse(await fixture("design-systems/tidal-signal.design-system.json"))
    ).toBeTruthy();
    expect(
      contracts.designOverride.parse(await fixture("design-systems/campaign.design-override.json"))
    ).toBeTruthy();
    expect(contracts.event.parse(await fixture("events/revision-created.event.json"))).toBeTruthy();
    expect(contracts.mediaAsset.parse(await fixture("media/verified-image.media-asset.json"))).toBeTruthy();
    expect(contracts.cloudflareStagingBinding.parse(await fixture("staging/valid.cloudflare-staging-binding-v3.json"))).toMatchObject({ schema: "io.navocms.cloudflare-staging-binding.v3" });
    expect(parseCompatibleCloudflareStagingBinding(await fixture("staging/valid.cloudflare-staging-binding-v1.json"))).toMatchObject({ schema: "io.navocms.cloudflare-staging-binding.v1" });
    expect(parseCompatibleCloudflareStagingBinding(await fixture("staging/valid.cloudflare-staging-binding-v2.json"))).toMatchObject({ schema: "io.navocms.cloudflare-staging-binding.v2" });
    expect(contracts.r2RuntimeBinding.parse(await fixture("staging/valid.r2-runtime-binding.json"))).toBeTruthy();
  });

  it("rejects R2 endpoint paths and dotenvx reference collisions", async () => {
    await expect(fixture("staging/path.r2-runtime-binding.invalid.json").then((value) => contracts.r2RuntimeBinding.parse(value))).rejects.toThrow(/R2 endpoint/);
    await expect(fixture("staging/secret-collision.r2-runtime-binding.invalid.json").then((value) => contracts.r2RuntimeBinding.parse(value))).rejects.toThrow(/secret references/);
  });

  it("rejects adversarial media storage keys that point at another site", async () => {
    await expect(fixture("media/adversarial-storage-key.media-asset.invalid.json").then((value) => (
      contracts.mediaAsset.parse(value)
    ))).rejects.toThrow(/exactly match tenant, site, and SHA-256/);
  });

  it("binds variant storage keys to the exact site and variant identity", async () => {
    const media = contracts.mediaAsset.parse(await fixture("media/verified-image.media-asset.json"));
    const invalid = {
      ...media,
      spec: {
        ...media.spec,
        variants: media.spec.variants.map((variant) => ({
          ...variant,
          storageKey: variant.storageKey.replace(media.metadata.siteId, "99999999-9999-4999-8999-999999999999")
        }))
      }
    };
    expect(() => contracts.mediaAsset.parse(invalid)).toThrowError(/variant key must exactly match/);
  });

  it("rejects partially specified original dimensions", async () => {
    const media = contracts.mediaAsset.parse(await fixture("media/verified-image.media-asset.json"));
    const { height: _height, ...widthOnly } = media.spec.original!;
    const invalid = { ...media, spec: { ...media.spec, original: widthOnly } };

    expect(() => contracts.mediaAsset.parse(invalid)).toThrowError(/must have property height/);
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

  it("rejects design recipes that reference unknown components", async () => {
    const design = contracts.designSystem.parse(
      await fixture("design-systems/tidal-signal.design-system.json")
    );
    const invalid = {
      ...design,
      spec: {
        ...design.spec,
        recipes: design.spec.recipes.map((recipe) => ({
          ...recipe,
          slots: recipe.slots.map((slot) => ({ ...slot, component: "missing-component" }))
        }))
      }
    };

    expect(() => contracts.designSystem.parse(invalid)).toThrowError(/unknown component/);
  });
});
