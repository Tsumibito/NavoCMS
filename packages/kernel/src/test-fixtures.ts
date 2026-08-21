import type { PluginManifest, SiteProfile } from "@navocms/contracts";

const digest = `sha256:${"a".repeat(64)}`;

export function manifest(
  id: string,
  provides: PluginManifest["spec"]["provides"],
  requires: PluginManifest["spec"]["requires"] = []
): PluginManifest {
  return {
    apiVersion: "navocms.io/v0alpha1",
    kind: "PluginManifest",
    metadata: { id, version: "0.1.0", displayName: id, description: `Fixture for ${id}` },
    spec: {
      runtime: "module",
      provides,
      requires,
      permissions: { data: { read: [], write: [] }, network: [], scopes: [] },
      effects: []
    }
  };
}

export function profile(
  pluginIds: readonly string[],
  bindings: SiteProfile["spec"]["bindings"]
): SiteProfile {
  return {
    apiVersion: "navocms.io/v0alpha1",
    kind: "SiteProfile",
    metadata: { name: "graph-test", version: "0.1.0", displayName: "Graph test" },
    spec: {
      environment: "development",
      locales: { default: "en", supported: ["en"] },
      anchors: {
        content: { ref: "content/test", version: "0.1.0", digest },
        design: { ref: "design/test", version: "0.1.0", digest },
        delivery: { ref: "delivery/test", version: "0.1.0", digest },
        governance: { ref: "governance/test", version: "0.1.0", digest }
      },
      plugins: pluginIds.map((id) => ({ id, version: "0.1.0", enabled: true })),
      bindings,
      urlPolicy: { canonicalHost: "test.example.com", immutablePublicUrls: true }
    }
  };
}
