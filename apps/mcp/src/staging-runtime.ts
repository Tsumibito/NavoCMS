import { parseCloudflareStagingBinding, type CloudflareStagingBinding } from "@navocms/contracts";

import { assertStagingReadiness, stagingBindingDigest, type StagingReadiness, type StagingReadinessExpectation } from "./staging-profile.js";

/** The only allowed external-delivery runtime selection. Production is never a fallback target. */
export type ReleaseProviderSelection = "embedded" | "cloudflare-staging";

export interface DotenvxSecretBroker {
  /** Supplies a value only to the transport callback; it never serializes or logs it. */
  use<T>(reference: string, operation: (value: string) => Promise<T>): Promise<T>;
  assertAvailable(reference: string): void;
}

export function createDotenvxSecretBroker(environment: Readonly<Record<string, string | undefined>> = process.env): DotenvxSecretBroker {
  return Object.freeze({
    assertAvailable(reference: string): void { assertSecret(environment[dotenvxKey(reference)]); },
    async use<T>(reference: string, operation: (value: string) => Promise<T>): Promise<T> {
      const key = dotenvxKey(reference);
      const value = environment[key];
      assertSecret(value);
      try { return await operation(value); } finally { /* value is never returned, stored, or logged */ }
    }
  });
}

export interface CloudflareStagingRuntimeSelection {
  readonly selection: "cloudflare-staging";
  readonly binding: CloudflareStagingBinding;
  readonly readiness: StagingReadiness;
  readonly secrets: DotenvxSecretBroker;
}

export function selectReleaseProvider(input: Readonly<{ requested: string | undefined; environment: string; binding: unknown; expected: StagingReadinessExpectation; secrets: DotenvxSecretBroker }>): Readonly<{ selection: "embedded" }> | CloudflareStagingRuntimeSelection {
  const requested = input.requested ?? "embedded";
  if (requested === "embedded") return Object.freeze({ selection: "embedded" });
  if (requested !== "cloudflare-staging" || input.environment !== "staging") throw new StagingRuntimeError("STAGING_PROFILE_DENIED", "Cloudflare staging provider is allowed only in the staging environment");
  const binding = parseCloudflareStagingBinding(input.binding);
  const readiness = assertStagingReadiness(binding, input.expected);
  // Check references before any transport is constructed, still without touching a provider.
  const cloudflareKey = dotenvxKey(binding.cloudflare.tokenSecretRef); const coolifyKey = dotenvxKey(binding.coolify.tokenSecretRef);
  if (binding.cloudflare.tokenSecretRef === binding.coolify.tokenSecretRef || cloudflareKey === coolifyKey) throw new StagingRuntimeError("STAGING_SECRET_REFERENCE_COLLISION", "Staging secret references must be distinct");
  input.secrets.assertAvailable(binding.cloudflare.tokenSecretRef); input.secrets.assertAvailable(binding.coolify.tokenSecretRef);
  return Object.freeze({ selection: "cloudflare-staging", binding: deepFreeze(structuredClone(binding)), readiness, secrets: input.secrets });
}

export function assertStagingActivationGuard(input: Readonly<{ runtimeMode: string; environment: string; hasPostgresReadinessScope: boolean; organizationId: string | undefined }>): void {
  if (input.runtimeMode !== "production" || input.environment !== "staging" || !input.hasPostgresReadinessScope || !input.organizationId) throw new StagingRuntimeError("STAGING_ACTIVATION_DENIED", "Cloudflare staging requires production runtime, PostgreSQL readiness scope, and WorkOS organization binding");
}

export function stagingBindingFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): unknown {
  const raw = environment.NAVOCMS_STAGING_BINDING;
  if (!raw || raw.length > 8 * 1024) throw new StagingRuntimeError("STAGING_BINDING_MISSING", "Reviewed staging binding is required");
  try { return JSON.parse(raw); } catch { throw new StagingRuntimeError("STAGING_BINDING_INVALID", "Reviewed staging binding is invalid"); }
}

export function stagingExpectationFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): StagingReadinessExpectation {
  const tenantId = environment.NAVOCMS_TENANT_ID; const siteId = environment.NAVOCMS_SITE_ID; const allowedHostname = environment.NAVOCMS_STAGING_HOSTNAME; const bindingDigest = environment.NAVOCMS_STAGING_BINDING_DIGEST;
  if (!tenantId || !siteId || !allowedHostname || !bindingDigest) throw new StagingRuntimeError("STAGING_READINESS_CONFIG_MISSING", "Staging readiness coordinates are required");
  return Object.freeze({ tenantId, siteId, allowedHostname, bindingDigest });
}

export class StagingRuntimeError extends Error { public readonly code: string; public constructor(code: string, message: string) { super(message); this.code = code; } }
function dotenvxKey(reference: string): string { if (!/^secret:[A-Za-z0-9][A-Za-z0-9._/-]{2,159}$/.test(reference)) throw new StagingRuntimeError("STAGING_SECRET_REFERENCE_INVALID", "Staging secret reference is invalid"); return `DOTENVX_SECRET_${reference.slice("secret:".length).replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`; }
function assertSecret(value: string | undefined): asserts value is string { if (!value || value.length < 16 || value.length > 4096) throw new StagingRuntimeError("STAGING_SECRET_REFERENCE_MISSING", "Required staging secret reference is unavailable"); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as object)) deepFreeze(child); } return value; }
export function safeStagingRuntimeIdentifiers(selection: CloudflareStagingRuntimeSelection): Readonly<{ provider: string; profileDigest: string; bindingDigest: string; tenantId: string; siteId: string; hostname: string }> { return Object.freeze({ provider: selection.selection, profileDigest: selection.readiness.profileDigest, bindingDigest: stagingBindingDigest(selection.binding), tenantId: selection.readiness.tenantId, siteId: selection.readiness.siteId, hostname: selection.readiness.allowedHostname }); }
