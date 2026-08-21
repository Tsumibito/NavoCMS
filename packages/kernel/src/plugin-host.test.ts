import { describe, expect, it, vi } from "vitest";

import { PluginHost, type PluginRuntime } from "./index.js";
import { manifest, profile } from "./test-fixtures.js";

describe("PluginHost", () => {
  it("healthchecks all plugins, activates in order, and unwinds registrations", async () => {
    const lifecycle: string[] = [];
    const storage = manifest("navocms.storage.memory", [{ name: "blob.storage", version: 1 }]);
    const media = manifest(
      "navocms.media.test",
      [{ name: "image.transform", version: 1 }],
      [{ name: "blob.storage", version: 1 }]
    );
    const site = profile(
      [media.metadata.id, storage.metadata.id],
      [
        { capability: "blob.storage", version: 1, provider: storage.metadata.id },
        { capability: "image.transform", version: 1, provider: media.metadata.id }
      ]
    );
    const storageValue = { kind: "memory" };

    const storageRuntime: PluginRuntime = {
      pluginId: storage.metadata.id,
      health: async () => {
        lifecycle.push("health:storage");
        return { ok: true };
      },
      activate: async (context) => {
        lifecycle.push("activate:storage");
        context.track(
          context.capabilities.registerDefinition({
            name: "blob.storage",
            version: 1,
            owner: storage.metadata.id,
            description: "Test storage"
          })
        );
        context.track(
          context.capabilities.registerProvider({
            name: "blob.storage",
            version: 1,
            pluginId: storage.metadata.id,
            value: storageValue
          })
        );
        return {
          dispose: () => {
            lifecycle.push("dispose:storage");
          }
        };
      }
    };
    const mediaRuntime: PluginRuntime = {
      pluginId: media.metadata.id,
      health: async () => {
        lifecycle.push("health:media");
        return { ok: true };
      },
      activate: async (context) => {
        lifecycle.push("activate:media");
        expect(
          context.capabilities.resolve({ name: "blob.storage", version: 1 }, storage.metadata.id)
        ).toBe(storageValue);
        return {
          dispose: () => {
            lifecycle.push("dispose:media");
          }
        };
      }
    };

    const host = new PluginHost();
    await host.boot(site, [media, storage], [mediaRuntime, storageRuntime]);
    expect(host.state).toBe("healthy");
    expect(lifecycle).toEqual([
      "health:storage",
      "health:media",
      "activate:storage",
      "activate:media"
    ]);

    await host.shutdown();
    expect(lifecycle.slice(-2)).toEqual(["dispose:media", "dispose:storage"]);
    expect(host.capabilities.snapshot()).toEqual({ definitions: [], providers: [] });
    expect(host.state).toBe("stopped");
  });

  it("does not activate anything when preflight health fails", async () => {
    const plugin = manifest("navocms.test.unhealthy", [{ name: "test.health", version: 1 }]);
    const site = profile([plugin.metadata.id], [
      { capability: "test.health", version: 1, provider: plugin.metadata.id }
    ]);
    const activate = vi.fn(async () => undefined);
    const host = new PluginHost();

    await expect(
      host.boot(site, [plugin], [
        { pluginId: plugin.metadata.id, health: async () => ({ ok: false, detail: "offline" }), activate }
      ])
    ).rejects.toMatchObject({ code: "PLUGIN_UNHEALTHY" });
    expect(activate).not.toHaveBeenCalled();
    expect(host.state).toBe("failed");
  });

  it("unwinds current and prior activation scopes after an activation failure", async () => {
    const lifecycle: string[] = [];
    const provider = manifest("navocms.test.provider", [{ name: "test.provider", version: 1 }]);
    const consumer = manifest(
      "navocms.test.consumer",
      [{ name: "test.consumer", version: 1 }],
      [{ name: "test.provider", version: 1 }]
    );
    const site = profile(
      [provider.metadata.id, consumer.metadata.id],
      [
        { capability: "test.provider", version: 1, provider: provider.metadata.id },
        { capability: "test.consumer", version: 1, provider: consumer.metadata.id }
      ]
    );
    const healthy = async () => ({ ok: true as const });
    const host = new PluginHost();

    await expect(
      host.boot(site, [provider, consumer], [
        {
          pluginId: provider.metadata.id,
          health: healthy,
          activate: async () => ({
            dispose: () => {
              lifecycle.push("dispose:provider");
            }
          })
        },
        {
          pluginId: consumer.metadata.id,
          health: healthy,
          activate: async (context) => {
            context.track({
              dispose: () => {
                lifecycle.push("dispose:consumer-partial");
              }
            });
            throw new Error("activation failed");
          }
        }
      ])
    ).rejects.toThrow("activation failed");
    expect(lifecycle).toEqual(["dispose:consumer-partial", "dispose:provider"]);
    expect(host.status()).toMatchObject({ state: "failed", activePlugins: [] });
  });
});
