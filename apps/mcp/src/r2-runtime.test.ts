import { describe, expect, it } from "vitest";

import {
  assertR2RuntimeActivationGuard,
  r2RuntimeBindingDigest,
  selectR2Runtime
} from "./r2-runtime.js";
import { createDotenvxSecretBroker } from "./secret-broker.js";

const binding = Object.freeze({
  schema: "io.navocms.r2-runtime-binding.v1" as const,
  tenantId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  environment: "staging" as const,
  endpoint: "https://account.r2.cloudflarestorage.com",
  bucket: "navocms-staging-media",
  namespace: "navocms/v1/" as const,
  accessKeySecretRef: "secret:r2/access-key",
  secretKeySecretRef: "secret:r2/secret-key"
});
const expected = Object.freeze({ tenantId: binding.tenantId, siteId: binding.siteId, bindingDigest: r2RuntimeBindingDigest(binding) });
const environment = Object.freeze({ DOTENVX_SECRET_R2_ACCESS_KEY: "access-key-test-value", DOTENVX_SECRET_R2_SECRET_KEY: "secret-key-test-value" });

describe("independent R2 runtime activation", () => {
  it("requires production mode in staging before any binding or secret seam", () => {
    let assertions = 0;
    expect(() => selectR2Runtime({ requested: "r2", runtimeMode: "development", environment: "staging", binding: {}, expected, secrets: { assertAvailable: () => { assertions += 1; }, use: async <T>(_reference: string, _operation: (value: string) => Promise<T>) => undefined as T } })).toThrow("production mode");
    expect(assertions).toBe(0);
    expect(() => assertR2RuntimeActivationGuard({ runtimeMode: "production", environment: "production" })).toThrow("staging environment");
  });

  it("requires the exact reviewed scope and digest before checking refs", () => {
    let assertions = 0;
    const secrets = { assertAvailable: () => { assertions += 1; }, use: async <T>(_reference: string, _operation: (value: string) => Promise<T>) => undefined as T };
    expect(() => selectR2Runtime({ requested: "r2", runtimeMode: "production", environment: "staging", binding, expected: { ...expected, siteId: "33333333-3333-4333-8333-333333333333" }, secrets })).toThrow("scope or digest");
    expect(assertions).toBe(0);
    expect(() => selectR2Runtime({ requested: "r2", runtimeMode: "production", environment: "staging", binding, expected: { ...expected, bindingDigest: "sha256:" + "f".repeat(64) }, secrets })).toThrow("scope or digest");
    expect(assertions).toBe(0);
  });

  it("fails closed for absent, short, and colliding dotenvx refs", () => {
    expect(() => selectR2Runtime({ requested: "r2", runtimeMode: "production", environment: "staging", binding, expected, secrets: createDotenvxSecretBroker({}) })).toThrow("unavailable");
    expect(() => selectR2Runtime({ requested: "r2", runtimeMode: "production", environment: "staging", binding, expected, secrets: createDotenvxSecretBroker({ ...environment, DOTENVX_SECRET_R2_ACCESS_KEY: "short" }) })).toThrow("unavailable");
    const colliding = { ...binding, secretKeySecretRef: "secret:r2.access_key" };
    expect(() => selectR2Runtime({ requested: "r2", runtimeMode: "production", environment: "staging", binding: colliding, expected: { ...expected, bindingDigest: r2RuntimeBindingDigest(colliding) }, secrets: createDotenvxSecretBroker({ DOTENVX_SECRET_R2_ACCESS_KEY: "access-key-test-value" }) })).toThrow("distinct");
  });

});
