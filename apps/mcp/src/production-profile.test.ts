import { describe, expect, it, vi } from "vitest";

import {
  EMBEDDED_PRODUCTION_PROFILE,
  EMBEDDED_PRODUCTION_PROFILE_DIGEST,
  EMBEDDED_RELEASE_MANIFEST,
  bootPinnedProductionPluginHost,
  embeddedReleaseRuntime,
  profileDigest
} from "./production-profile.js";

describe("pinned embedded production profile", () => {
  it("boots the reviewed graph in activation order and disposes it", async () => {
    const dispose = vi.fn();
    const host = await bootPinnedProductionPluginHost({
      runtimes: [{ ...embeddedReleaseRuntime(), activate: async () => ({ dispose }) }]
    });
    expect(host.status()).toMatchObject({ state: "healthy", profile: "embedded-release-production@0.1.0", activePlugins: ["navocms.release.embedded"] });
    await host.shutdown();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("fails closed on pin drift, missing runtime, and unhealthy runtime", async () => {
    expect(profileDigest(EMBEDDED_PRODUCTION_PROFILE)).toBe(EMBEDDED_PRODUCTION_PROFILE_DIGEST);
    await expect(bootPinnedProductionPluginHost({ expectedDigest: "sha256:0".repeat(1) })).rejects.toThrow(/digest/);
    await expect(bootPinnedProductionPluginHost({ runtimes: [] })).rejects.toMatchObject({ code: "PLUGIN_RUNTIME_MISSING" });
    await expect(bootPinnedProductionPluginHost({ runtimes: [embeddedReleaseRuntime(async () => false)] })).rejects.toMatchObject({ code: "PLUGIN_UNHEALTHY" });
  });

  it("fails closed when manifest version differs from its pinned profile", async () => {
    await expect(bootPinnedProductionPluginHost({
      manifest: { ...EMBEDDED_RELEASE_MANIFEST, metadata: { ...EMBEDDED_RELEASE_MANIFEST.metadata, version: "0.1.1" } }
    })).rejects.toMatchObject({ code: "PLUGIN_VERSION_MISMATCH" });
  });
});
