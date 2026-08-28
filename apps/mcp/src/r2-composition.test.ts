import { describe, expect, it } from "vitest";

import { composeR2Runtime } from "./r2-composition.js";
import { createDotenvxR2SecretBroker, r2RuntimeBindingDigest } from "./r2-runtime.js";

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

describe("R2 transport composition seam", () => {
  it("constructs no transport and defers both secret callbacks", async () => {
    let uses = 0;
    const secrets = {
      assertAvailable: () => undefined,
      use: async <T>(_reference: string, operation: (value: string) => Promise<T>) => { uses += 1; return operation("test-only-secret"); }
    };
    const composition = composeR2Runtime({ requested: "r2", runtimeMode: "production", environment: "staging", binding, expected: { tenantId: binding.tenantId, siteId: binding.siteId, bindingDigest: r2RuntimeBindingDigest(binding) }, secrets });
    expect(composition).toMatchObject({ selection: "r2", endpoint: binding.endpoint, bucket: binding.bucket, namespace: "navocms/v1/" });
    expect(uses).toBe(0);
    await expect(composition!.withAccessKey(async (value) => value.length)).resolves.toBeGreaterThan(0);
    await expect(composition!.withSecretKey(async (value) => value.length)).resolves.toBeGreaterThan(0);
    expect(uses).toBe(2);
  });

  it("does not call a transport or resolve secrets when the reviewed binding is stale", () => {
    let uses = 0;
    const secrets = createDotenvxR2SecretBroker({ DOTENVX_SECRET_R2_ACCESS_KEY: "access-key-test-value", DOTENVX_SECRET_R2_SECRET_KEY: "secret-key-test-value" });
    const candidate = { ...binding, bucket: "other-staging-media" };
    expect(() => composeR2Runtime({ requested: "r2", runtimeMode: "production", environment: "staging", binding: candidate, expected: { tenantId: binding.tenantId, siteId: binding.siteId, bindingDigest: r2RuntimeBindingDigest(binding) }, secrets: { assertAvailable: () => { uses += 1; }, use: async <T>(_reference: string, _operation: (value: string) => Promise<T>) => undefined as T } })).toThrow("scope or digest");
    expect(uses).toBe(0);
  });
});
