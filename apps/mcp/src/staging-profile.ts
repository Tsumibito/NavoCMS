import { createHash } from "node:crypto";

import { immutableReferenceHash, validateReleaseProviderInput, verifyDeployableArtifact, type ImmutableArtifactResolver } from "@navocms/delivery-cloudflare";
import { PluginHost, type PluginRuntime, type ReleaseProviderPublishInput } from "@navocms/kernel";
import { requirePermission } from "@navocms/security";
import { parseCloudflareStagingBinding, type CloudflareStagingBinding, type SiteProfile } from "@navocms/contracts";

import { McpEditingError } from "./errors.js";
import type { McpRequestContext } from "./model.js";

export const CLOUDFLARE_STAGING_BINDING_SCHEMA = "io.navocms.cloudflare-staging-binding.v2" as const;
export const CLOUDFLARE_STAGING_PLUGIN_ID = "navocms.release.cloudflare-staging" as const;

/** Non-secret deployment coordinates. Credential values remain operator-owned. */
export const CLOUDFLARE_STAGING_PROFILE: SiteProfile = deepFreeze({
  apiVersion: "navocms.io/v0alpha1", kind: "SiteProfile",
  metadata: { name: "cloudflare-staging", version: "0.2.0", displayName: "Cloudflare staging delivery" },
  spec: {
    environment: "staging", locales: { default: "en", supported: ["en"] },
    anchors: {
      content: { ref: "@navocms/content", version: "0.1.0", digest: "sha256:89a4d26a8d6818fb749b2e8b1f0ff4e1c138f0e0fd38307db628d200a8901c94" },
      design: { ref: "@navocms/design", version: "0.1.0", digest: "sha256:d0fbafcfcc67780a2a0ecb7952d1b76dbd28029cfbaf3014aa346bd855329268" },
      delivery: { ref: "@navocms/delivery-cloudflare", version: "0.2.0", digest: "sha256:5c68717d47f4238c1cc478688098911655b63b1072350103284612a0f8a2f0b6" },
      governance: { ref: "@navocms/kernel", version: "0.1.0", digest: "sha256:e529c059c90462da5f27c4521c4c68fd05e3d56e4c6a610c4d6180bda3e3020e" }
    },
    plugins: [{ id: CLOUDFLARE_STAGING_PLUGIN_ID, version: "0.2.0", enabled: true, configRef: "staging:cloudflare" }],
    bindings: [{ capability: "release.provider", version: 1, provider: CLOUDFLARE_STAGING_PLUGIN_ID }],
    urlPolicy: { canonicalHost: "staging.invalid", immutablePublicUrls: true }
  }
} as const);
export const CLOUDFLARE_STAGING_PROFILE_DIGEST = "sha256:68e2bcef8db9a19153d1306b47c92b3632279cf74c1a780f8956d68aa0827fe1";

export function assertCloudflareStagingBinding(value: unknown): asserts value is CloudflareStagingBinding {
  parseCloudflareStagingBinding(value);
}

/** A no-effect proof: validates human authority, exact release/artifact binding, and deployment coordinates. */
export async function dryRunCloudflareStaging(input: Readonly<{ context: McpRequestContext; binding: unknown; resolver: ImmutableArtifactResolver; release: ReleaseProviderPublishInput }>): Promise<Readonly<{ referenceHash: string; cloudflareProjectId: string; coolifyApplicationUuid: string }>> {
  requirePermission(input.context.authorization, "content:publish", { tenantId: input.context.authorization.tenantId, siteId: input.context.authorization.siteId });
  if (input.context.authorization.principal.kind !== "human") throw new McpEditingError("STAGING_HUMAN_REQUIRED", "Staging delivery dry run requires an authenticated WorkOS human");
  assertCloudflareStagingBinding(input.binding);
  if (input.binding.tenantId !== input.context.authorization.tenantId || input.binding.siteId !== input.context.authorization.siteId) throw new McpEditingError("STAGING_BINDING_SCOPE_DENIED", "Staging binding does not match the authorized tenant/site");
  validateReleaseProviderInput(input.release);
  const deployable = await input.resolver.resolve({ releaseId: input.release.releaseId, releaseHash: input.release.releaseHash, releaseArtifact: input.release.artifact });
  verifyDeployableArtifact(deployable, input.release);
  return Object.freeze({ referenceHash: immutableReferenceHash(deployable.reference), cloudflareProjectId: input.binding.cloudflare.projectId, coolifyApplicationUuid: input.binding.coolify.applicationUuid });
}

/** The profile pins the external staging capability; transports are composed separately and only in staging. */
export type StagingReadinessExpectation = Readonly<{ tenantId: string; siteId: string; allowedHostname: string; bindingDigest: string }>;
export type StagingReadiness = Readonly<{ profileId: string; profileDigest: string; bindingDigest: string; tenantId: string; siteId: string; allowedHostname: string }>;

/** Fail-closed reviewed-pin check. Deliberately returns only non-secret coordinates. */
export function assertStagingReadiness(bindingValue: unknown, expected: StagingReadinessExpectation): StagingReadiness {
  const binding = parseCloudflareStagingBinding(bindingValue);
  const profile = CLOUDFLARE_STAGING_PROFILE;
  const profileDigest = stagingProfileDigest(profile);
  const actualBindingDigest = stagingBindingDigest(binding);
  if (profileDigest !== CLOUDFLARE_STAGING_PROFILE_DIGEST || actualBindingDigest !== expected.bindingDigest || binding.tenantId !== expected.tenantId || binding.siteId !== expected.siteId || binding.environment !== "staging" || binding.cloudflare.allowedHostname !== expected.allowedHostname) throw new McpEditingError("STAGING_READINESS_FAILED", "Staging profile or binding readiness does not match its reviewed pin");
  return Object.freeze({ profileId: profile.metadata.name, profileDigest, bindingDigest: actualBindingDigest, tenantId: binding.tenantId, siteId: binding.siteId, allowedHostname: binding.cloudflare.allowedHostname });
}

export async function bootCloudflareStagingProfile(binding: unknown, expected: StagingReadinessExpectation): Promise<PluginHost> {
  const readiness = assertStagingReadiness(binding, expected);
  const parsedBinding = deepFreeze(structuredClone(parseCloudflareStagingBinding(binding)));
  const manifest = cloudflareStagingManifest(parsedBinding);
  const runtime: PluginRuntime = {
    pluginId: CLOUDFLARE_STAGING_PLUGIN_ID,
    health: async () => { try { assertStagingReadiness(parsedBinding, expected); return { ok: true, detail: `${readiness.profileId}:${readiness.bindingDigest}` }; } catch { return { ok: false, detail: "staging readiness pin mismatch" }; } },
    activate: async (context) => {
      context.track(context.capabilities.registerDefinition({ name: "release.provider", version: 1, owner: CLOUDFLARE_STAGING_PLUGIN_ID, description: "Reviewed-artifact-gated Cloudflare/Coolify staging delivery provider" }));
      context.track(context.capabilities.registerProvider({ name: "release.provider", version: 1, pluginId: CLOUDFLARE_STAGING_PLUGIN_ID, value: Object.freeze({ mode: "external-staging", resolver: "reviewed-astro-artifact.v1", bindingDigest: stagingBindingDigest(parsedBinding), permissions: manifest.spec.permissions }) }));
    }
  };
  const host = new PluginHost();
  await host.boot(CLOUDFLARE_STAGING_PROFILE, [manifest], [runtime]);
  return host;
}

/** The binding digest is checked before this derived manifest can be booted. */
export function cloudflareStagingManifest(binding: CloudflareStagingBinding) {
  const network = cloudflareStagingNetworkDestinations(binding);
  return deepFreeze({
    apiVersion: "navocms.io/v0alpha1" as const,
    kind: "PluginManifest" as const,
    metadata: {
      id: CLOUDFLARE_STAGING_PLUGIN_ID,
      version: "0.2.0",
      displayName: "Cloudflare staging delivery",
      description: "Reviewed-artifact-gated external Cloudflare Pages and Coolify staging delivery provider"
    },
    spec: {
      runtime: "kernel" as const,
      provides: [{ name: "release.provider", version: 1 }],
      requires: [],
      permissions: {
        data: {
          read: ["environments", "release_candidates", "reviewed_astro_artifacts", "workflow_runs", "workflow_checkpoints"],
          write: ["workflow_runs", "workflow_checkpoints", "event_ledger", "domain_outbox"]
        },
        network,
        scopes: ["content:publish"]
      },
      effects: [{ name: "release.publish", consequence: "G2" as const, idempotent: true }]
    }
  });
}

function cloudflareStagingNetworkDestinations(binding: CloudflareStagingBinding): readonly string[] {
  const coolify = new URL(binding.coolify.baseUrl);
  const coolifyDestination = `${coolify.hostname}${coolify.port ? `:${coolify.port}` : ""}`;
  return Object.freeze([...new Set([
    "api.cloudflare.com",
    `*.${binding.cloudflare.projectId}${binding.cloudflare.previewHostnameSuffix}`,
    binding.cloudflare.allowedHostname,
    coolifyDestination
  ])].sort());
}
export function stagingBindingDigest(binding: CloudflareStagingBinding) { return `sha256:${createHash("sha256").update(canonical(binding)).digest("hex")}`; }
export function stagingProfileDigest(profile: SiteProfile = CLOUDFLARE_STAGING_PROFILE) { return `sha256:${createHash("sha256").update(JSON.stringify(profile)).digest("hex")}`; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as object)) deepFreeze(child); } return value; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
