import { createHash } from "node:crypto";

import { parseR2RuntimeBinding, type R2RuntimeBinding } from "@navocms/contracts";
import { dotenvxSecretEnvironmentKey, type DotenvxSecretBroker } from "./secret-broker.js";

export const R2_RUNTIME_NAMESPACE = "navocms/v1/" as const;
export const R2_RUNTIME_PREFIX = R2_RUNTIME_NAMESPACE;
const R2_PREFIX = R2_RUNTIME_NAMESPACE;
const MAX_BINDING_BYTES = 8 * 1024;

export type R2RuntimeSelection = "r2";

export interface R2RuntimeReadinessExpectation {
  readonly tenantId: string;
  readonly siteId: string;
  /** Digest of the exact reviewed binding, supplied independently of the binding. */
  readonly bindingDigest: string;
}

export interface R2RuntimeReadiness {
  readonly environment: "staging";
  readonly tenantId: string;
  readonly siteId: string;
  readonly bucket: string;
  readonly namespace: typeof R2_PREFIX;
  readonly prefix: typeof R2_PREFIX;
  readonly bindingDigest: string;
}

export class R2RuntimeError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "R2RuntimeError";
    this.code = code;
  }
}

export interface R2RuntimeSelectionResult {
  readonly selection: R2RuntimeSelection;
  readonly binding: R2RuntimeBinding;
  readonly readiness: R2RuntimeReadiness;
  readonly secrets: DotenvxSecretBroker;
}

/** Selects R2 only after all review, scope, and reference gates pass. No transport is constructed. */
export function selectR2Runtime(input: Readonly<{
  readonly requested: string | undefined;
  readonly runtimeMode: string;
  readonly environment: string;
  readonly binding: unknown;
  readonly expected: R2RuntimeReadinessExpectation;
  readonly secrets: DotenvxSecretBroker;
}>): R2RuntimeSelectionResult | undefined {
  if (input.requested !== "r2") return undefined;
  assertR2RuntimeActivationGuard({ runtimeMode: input.runtimeMode, environment: input.environment });
  const binding = parseR2RuntimeBinding(input.binding);
  const readiness = assertR2RuntimeReadiness(binding, input.expected);
  assertDistinctSecretReferences(binding);
  input.secrets.assertAvailable(binding.accessKeySecretRef);
  input.secrets.assertAvailable(binding.secretKeySecretRef);
  return Object.freeze({ selection: "r2", binding: deepFreeze(structuredClone(binding)), readiness, secrets: input.secrets });
}

export function assertR2RuntimeActivationGuard(input: Readonly<{ runtimeMode: string; environment: string }>): void {
  if (input.runtimeMode !== "production" || input.environment !== "staging") {
    throw new R2RuntimeError("R2_RUNTIME_ACTIVATION_DENIED", "R2 runtime requires production mode in the staging environment");
  }
}

export function assertR2RuntimeReadiness(bindingValue: unknown, expected: R2RuntimeReadinessExpectation): R2RuntimeReadiness {
  const binding = parseR2RuntimeBinding(bindingValue);
  if (!/^sha256:[0-9a-f]{64}$/.test(expected.bindingDigest)) {
    throw new R2RuntimeError("R2_REVIEW_DIGEST_INVALID", "R2 reviewed binding digest is invalid");
  }
  const actualDigest = r2RuntimeBindingDigest(binding);
  if (binding.tenantId !== expected.tenantId || binding.siteId !== expected.siteId || actualDigest !== expected.bindingDigest) {
    throw new R2RuntimeError("R2_READINESS_FAILED", "R2 runtime binding does not match its reviewed scope or digest");
  }
  return Object.freeze({
    environment: "staging",
    tenantId: binding.tenantId,
    siteId: binding.siteId,
    bucket: binding.bucket,
    namespace: R2_PREFIX,
    prefix: R2_PREFIX,
    bindingDigest: actualDigest
  });
}

/** Digest the exact binding envelope, never a secret value. */
export function r2RuntimeBindingDigest(bindingValue: unknown): string {
  const binding = parseR2RuntimeBinding(bindingValue);
  return `sha256:${createHash("sha256").update(canonical(binding)).digest("hex")}`;
}

export function r2RuntimeBindingFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): unknown {
  const raw = environment.NAVOCMS_R2_RUNTIME_BINDING;
  if (!raw || raw.length > MAX_BINDING_BYTES) throw new R2RuntimeError("R2_BINDING_MISSING", "Reviewed R2 runtime binding is required");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new R2RuntimeError("R2_BINDING_INVALID", "Reviewed R2 runtime binding is invalid");
  }
}

export function r2RuntimeExpectationFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): R2RuntimeReadinessExpectation {
  const tenantId = environment.NAVOCMS_TENANT_ID;
  const siteId = environment.NAVOCMS_SITE_ID;
  const bindingDigest = environment.NAVOCMS_R2_RUNTIME_BINDING_DIGEST;
  if (!tenantId || !siteId || !bindingDigest) throw new R2RuntimeError("R2_READINESS_CONFIG_MISSING", "R2 runtime readiness coordinates are required");
  return Object.freeze({ tenantId, siteId, bindingDigest });
}

function assertDistinctSecretReferences(binding: R2RuntimeBinding): void {
  const accessKey = dotenvxSecretEnvironmentKey(binding.accessKeySecretRef);
  const secretKey = dotenvxSecretEnvironmentKey(binding.secretKeySecretRef);
  if (accessKey === secretKey) throw new R2RuntimeError("R2_SECRET_REFERENCE_COLLISION", "R2 secret references must be distinct");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}
