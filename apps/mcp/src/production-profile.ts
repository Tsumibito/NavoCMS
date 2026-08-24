import { createHash } from "node:crypto";

import { PluginHost, type PluginRuntime } from "@navocms/kernel";

interface SiteProfile {
  readonly apiVersion: "navocms.io/v0alpha1";
  readonly kind: "SiteProfile";
  readonly metadata: { readonly name: string; readonly version: string; readonly displayName: string };
  readonly spec: {
    readonly environment: "development" | "preview" | "production";
    readonly locales: { readonly default: string; readonly supported: readonly string[] };
    readonly anchors: Record<string, { readonly ref: string; readonly version: string; readonly digest: string }>;
    readonly plugins: readonly { readonly id: string; readonly version: string; readonly enabled: boolean }[];
    readonly bindings: readonly { readonly capability: string; readonly version: number; readonly provider: string }[];
    readonly urlPolicy: { readonly canonicalHost: string; readonly immutablePublicUrls: true };
  };
}

interface PluginManifest {
  readonly apiVersion: "navocms.io/v0alpha1";
  readonly kind: "PluginManifest";
  readonly metadata: { readonly id: string; readonly version: string; readonly displayName: string; readonly description: string };
  readonly spec: {
    readonly runtime: "kernel" | "module" | "service" | "ui" | "sandbox";
    readonly provides: readonly { readonly name: string; readonly version: number }[];
    readonly requires: readonly { readonly name: string; readonly version: number; readonly optional?: boolean }[];
    readonly permissions: { readonly data: { readonly read: readonly string[]; readonly write: readonly string[] }; readonly network: readonly string[]; readonly scopes: readonly string[] };
    readonly effects: readonly { readonly name: string; readonly consequence: "G0" | "G1" | "G2" | "G3" | "G4"; readonly idempotent: boolean }[];
  };
}

const EMBEDDED_RELEASE_PLUGIN_ID = "navocms.release.embedded";

/**
 * This is deliberately a checked-in profile, rather than an environment
 * variable. Production must boot the exact reviewed graph that was tested.
 */
export const EMBEDDED_PRODUCTION_PROFILE: SiteProfile = Object.freeze({
  apiVersion: "navocms.io/v0alpha1",
  kind: "SiteProfile",
  metadata: { name: "embedded-release-production", version: "0.1.0", displayName: "Embedded release production" },
  spec: {
    environment: "production",
    locales: { default: "en", supported: ["en"] },
    anchors: {
      content: { ref: "@navocms/content", version: "0.1.0", digest: "sha256:89a4d26a8d6818fb749b2e8b1f0ff4e1c138f0e0fd38307db628d200a8901c94" },
      design: { ref: "@navocms/design", version: "0.1.0", digest: "sha256:d0fbafcfcc67780a2a0ecb7952d1b76dbd28029cfbaf3014aa346bd855329268" },
      delivery: { ref: "@navocms/mcp-embedded-release", version: "0.1.0", digest: "sha256:2a45cc05c44603394a44c9f05a054a1f31f675034e386e9f038692b460156c02" },
      governance: { ref: "@navocms/kernel", version: "0.1.0", digest: "sha256:e529c059c90462da5f27c4521c4c68fd05e3d56e4c6a610c4d6180bda3e3020e" }
    },
    plugins: [{ id: EMBEDDED_RELEASE_PLUGIN_ID, version: "0.1.0", enabled: true }],
    bindings: [{ capability: "release.provider", version: 1, provider: EMBEDDED_RELEASE_PLUGIN_ID }],
    urlPolicy: { canonicalHost: "localhost", immutablePublicUrls: true }
  }
} as const);

export const EMBEDDED_RELEASE_MANIFEST: PluginManifest = Object.freeze({
  apiVersion: "navocms.io/v0alpha1",
  kind: "PluginManifest",
  metadata: {
    id: EMBEDDED_RELEASE_PLUGIN_ID,
    version: "0.1.0",
    displayName: "Embedded release provider",
    description: "The reviewed in-process G2 release provider used by the current production runtime."
  },
  spec: {
    runtime: "kernel",
    provides: [{ name: "release.provider", version: 1 }],
    requires: [],
    permissions: { data: { read: [], write: [] }, network: [], scopes: [] },
    effects: [{ name: "release.publish", consequence: "G2", idempotent: true }]
  }
} as const);

// Updated only in the same review as the profile. It is intentionally not
// derived at runtime, so an accidental profile edit fails production boot.
export const EMBEDDED_PRODUCTION_PROFILE_DIGEST = "sha256:450eecb0747034abba71e0d47bf9dae71caf216405678f9797dae8114e2533d6";

export function profileDigest(profile: SiteProfile): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(profile)).digest("hex")}`;
}

export function assertPinnedProfile(profile: SiteProfile, expectedDigest = EMBEDDED_PRODUCTION_PROFILE_DIGEST): void {
  if (profileDigest(profile) !== expectedDigest) throw new Error("Embedded production profile digest does not match its reviewed pin");
}

export function embeddedReleaseRuntime(healthy: () => Promise<boolean> = async () => true): PluginRuntime {
  return {
    pluginId: EMBEDDED_RELEASE_PLUGIN_ID,
    health: async () => (await healthy() ? { ok: true } : { ok: false, detail: "embedded release provider unavailable" }),
    activate: async (context) => {
      context.track(context.capabilities.registerDefinition({
        name: "release.provider", version: 1, owner: EMBEDDED_RELEASE_PLUGIN_ID,
        description: "Reviewed embedded G2 release provider"
      }));
      context.track(context.capabilities.registerProvider({
        name: "release.provider", version: 1, pluginId: EMBEDDED_RELEASE_PLUGIN_ID, value: { kind: "embedded" }
      }));
    }
  };
}

export async function bootPinnedProductionPluginHost(options: {
  readonly profile?: SiteProfile;
  readonly manifest?: PluginManifest;
  readonly runtimes?: readonly PluginRuntime[];
  readonly expectedDigest?: string;
} = {}): Promise<PluginHost> {
  const profile = options.profile ?? EMBEDDED_PRODUCTION_PROFILE;
  assertPinnedProfile(profile, options.expectedDigest);
  const host = new PluginHost();
  await host.boot(profile, [options.manifest ?? EMBEDDED_RELEASE_MANIFEST], options.runtimes ?? [embeddedReleaseRuntime()]);
  return host;
}
