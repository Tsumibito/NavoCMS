import { describe, expect, it } from "vitest";

import { KernelError, resolvePluginGraph } from "./index.js";
import { manifest, profile } from "./test-fixtures.js";

describe("resolvePluginGraph", () => {
  it("orders providers before consumers", () => {
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

    const graph = resolvePluginGraph(site, [media, storage]);
    expect(graph.activationOrder).toEqual([storage.metadata.id, media.metadata.id]);
    expect(graph.bindings["blob.storage@1"]).toBe(storage.metadata.id);
    expect(Object.isFrozen(graph.profile)).toBe(true);
    expect(Object.isFrozen(graph.bindings)).toBe(true);
  });

  it("fails before boot when a required capability is unbound", () => {
    const media = manifest(
      "navocms.media.test",
      [{ name: "image.transform", version: 1 }],
      [{ name: "blob.storage", version: 1 }]
    );
    const site = profile([media.metadata.id], [
      { capability: "image.transform", version: 1, provider: media.metadata.id }
    ]);

    expect(() => resolvePluginGraph(site, [media])).toThrowError(
      expect.objectContaining<Partial<KernelError>>({ code: "CAPABILITY_BINDING_MISSING" })
    );
  });

  it("rejects dependency cycles", () => {
    const alpha = manifest(
      "navocms.test.alpha",
      [{ name: "test.alpha", version: 1 }],
      [{ name: "test.beta", version: 1 }]
    );
    const beta = manifest(
      "navocms.test.beta",
      [{ name: "test.beta", version: 1 }],
      [{ name: "test.alpha", version: 1 }]
    );
    const site = profile(
      [alpha.metadata.id, beta.metadata.id],
      [
        { capability: "test.alpha", version: 1, provider: alpha.metadata.id },
        { capability: "test.beta", version: 1, provider: beta.metadata.id }
      ]
    );

    expect(() => resolvePluginGraph(site, [alpha, beta])).toThrowError(
      expect.objectContaining<Partial<KernelError>>({ code: "PLUGIN_DEPENDENCY_CYCLE" })
    );
  });
});
