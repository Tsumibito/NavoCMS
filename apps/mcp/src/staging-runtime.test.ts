import { describe, expect, it } from "vitest";

import { assertStagingActivationGuard, createDotenvxSecretBroker, selectReleaseProvider } from "./staging-runtime.js";
import { stagingBindingDigest } from "./staging-profile.js";
import { FetchCloudflarePagesTransport } from "@navocms/delivery-cloudflare";

const binding = Object.freeze({ schema: "io.navocms.cloudflare-staging-binding.v3" as const, tenantId: "11111111-1111-4111-8111-111111111111", siteId: "22222222-2222-4222-8222-222222222222", environment: "staging" as const, cloudflare: { accountId: "account", projectId: "project", productionBranch: "main", previewBranch: "preview", previewHostnameSuffix: ".pages.dev", allowedHostname: "staging.example.test", tokenSecretRef: "secret:delivery/cloudflare-token" } });
const expected = Object.freeze({ tenantId: binding.tenantId, siteId: binding.siteId, allowedHostname: binding.cloudflare.allowedHostname, bindingDigest: stagingBindingDigest(binding) });

describe("staging provider selection", () => {
  it("denies staging provider outside staging without any secret or transport use", () => {
    const broker = createDotenvxSecretBroker({});
    expect(() => selectReleaseProvider({ requested: "cloudflare-staging", environment: "production", binding, expected, secrets: broker })).toThrow("Cloudflare staging provider");
  });
  it("fails closed for missing binding digest and secret references", () => {
    const broker = createDotenvxSecretBroker({});
    expect(() => selectReleaseProvider({ requested: "cloudflare-staging", environment: "staging", binding, expected: { ...expected, bindingDigest: "sha256:wrong" }, secrets: broker })).toThrow("reviewed pin");
    expect(() => selectReleaseProvider({ requested: "cloudflare-staging", environment: "staging", binding, expected, secrets: broker })).toThrow("secret reference");
    expect(() => selectReleaseProvider({ requested: "cloudflare-staging", environment: "staging", binding: { ...binding, siteId: "44444444-4444-4444-8444-444444444444" }, expected, secrets: broker })).toThrow("reviewed pin");
    for (const value of [undefined, "", "x".repeat(15)]) {
      expect(() => selectReleaseProvider({ requested: "cloudflare-staging", environment: "staging", binding, expected, secrets: createDotenvxSecretBroker({ DOTENVX_SECRET_DELIVERY_CLOUDFLARE_TOKEN: value }) })).toThrow("secret reference");
    }
  });
  it("selects only reviewed staging configuration and exposes no values", async () => {
    const broker = createDotenvxSecretBroker({ DOTENVX_SECRET_DELIVERY_CLOUDFLARE_TOKEN: "test-token-012345" });
    const selected = selectReleaseProvider({ requested: "cloudflare-staging", environment: "staging", binding, expected, secrets: broker });
    expect(selected).toMatchObject({ selection: "cloudflare-staging", readiness: { bindingDigest: expected.bindingDigest } });
    if (selected.selection !== "cloudflare-staging") throw new Error("unexpected selection");
    await expect(selected.secrets.use(binding.cloudflare.tokenSecretRef, async () => "used")).resolves.toBe("used");
    expect(selected).not.toHaveProperty("token");
  });
  it("rejects staging bindings older than v3", () => {
    const legacy = { ...binding, schema: "io.navocms.cloudflare-staging-binding.v2" as const, coolify: { baseUrl: "https://coolify.example.test", applicationUuid: "legacy-app", tokenSecretRef: "secret:delivery/coolify-token" } };
    expect(() => selectReleaseProvider({ requested: "cloudflare-staging", environment: "staging", binding: legacy, expected, secrets: createDotenvxSecretBroker({}) })).toThrow("Invalid Cloudflare staging binding");
  });
  it("keeps embedded as the only default and production path", () => {
    expect(selectReleaseProvider({ requested: undefined, environment: "production", binding: {}, expected, secrets: createDotenvxSecretBroker({}) })).toEqual({ selection: "embedded" });
  });
  it("requires a production-grade runtime before a reviewed resolver can be composed", () => {
    expect(() => assertStagingActivationGuard({ runtimeMode: "development", environment: "staging", hasPostgresReadinessScope: false, organizationId: "org" })).toThrow("Cloudflare staging requires");
    expect(() => assertStagingActivationGuard({ runtimeMode: "production", environment: "staging", hasPostgresReadinessScope: true, organizationId: undefined })).toThrow("Cloudflare staging requires");
  });
  it("assembles real transports without a network effect before publish", () => {
    let fetchCalls = 0;
    const fetcher: typeof fetch = async () => { fetchCalls += 1; throw new Error("must not fetch"); };
    new FetchCloudflarePagesTransport({ accountId: binding.cloudflare.accountId, projectKey: binding.cloudflare.projectId, productionBranch: binding.cloudflare.productionBranch, previewHostnameSuffix: binding.cloudflare.previewHostnameSuffix, productionHostname: binding.cloudflare.allowedHostname, apiToken: async () => "x".repeat(16), fetcher });
    expect(fetchCalls).toBe(0);
  });
});
