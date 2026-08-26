import { describe, expect, it } from "vitest";

import { assertStagingActivationGuard, createDotenvxSecretBroker, releaseProviderForSelection, selectReleaseProvider, stagingPublishReady } from "./staging-runtime.js";
import { InMemoryEditingRepository } from "./repository.js";
import { McpEditingService } from "./service.js";
import { stagingBindingDigest } from "./staging-profile.js";
import { FetchCloudflarePagesTransport, FetchCoolifyCommitTransport } from "@navocms/delivery-cloudflare";

const binding = Object.freeze({ schema: "io.navocms.cloudflare-staging-binding.v2" as const, tenantId: "11111111-1111-4111-8111-111111111111", siteId: "22222222-2222-4222-8222-222222222222", environment: "staging" as const, cloudflare: { accountId: "account", projectId: "project", productionBranch: "main", previewBranch: "preview", previewHostnameSuffix: ".pages.dev", allowedHostname: "staging.example.test", tokenSecretRef: "secret:delivery/cloudflare-token" }, coolify: { baseUrl: "https://coolify.example.test", applicationUuid: "33333333-3333-4333-8333-333333333333", tokenSecretRef: "secret:delivery/coolify-token" } });
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
      expect(() => selectReleaseProvider({ requested: "cloudflare-staging", environment: "staging", binding, expected, secrets: createDotenvxSecretBroker({ DOTENVX_SECRET_DELIVERY_CLOUDFLARE_TOKEN: value, DOTENVX_SECRET_DELIVERY_COOLIFY_TOKEN: "x".repeat(16) }) })).toThrow("secret reference");
    }
    expect(() => selectReleaseProvider({ requested: "cloudflare-staging", environment: "staging", binding: { ...binding, cloudflare: { ...binding.cloudflare, tokenSecretRef: "secret:a-b" }, coolify: { ...binding.coolify, tokenSecretRef: "secret:a/b" } }, expected: { ...expected, bindingDigest: stagingBindingDigest({ ...binding, cloudflare: { ...binding.cloudflare, tokenSecretRef: "secret:a-b" }, coolify: { ...binding.coolify, tokenSecretRef: "secret:a/b" } }) }, secrets: createDotenvxSecretBroker({ DOTENVX_SECRET_A_B: "x".repeat(16) }) })).toThrow("distinct");
  });
  it("selects only reviewed staging configuration and exposes no values", async () => {
    const broker = createDotenvxSecretBroker({ DOTENVX_SECRET_DELIVERY_CLOUDFLARE_TOKEN: "test-token-012345", DOTENVX_SECRET_DELIVERY_COOLIFY_TOKEN: "test-token-012345" });
    const selected = selectReleaseProvider({ requested: "cloudflare-staging", environment: "staging", binding, expected, secrets: broker });
    expect(selected).toMatchObject({ selection: "cloudflare-staging", readiness: { bindingDigest: expected.bindingDigest } });
    if (selected.selection !== "cloudflare-staging") throw new Error("unexpected selection");
    await expect(selected.secrets.use(binding.cloudflare.tokenSecretRef, async () => "used")).resolves.toBe("used");
    expect(selected).not.toHaveProperty("token");
  });
  it("keeps embedded as the only default and production path", () => {
    expect(selectReleaseProvider({ requested: undefined, environment: "production", binding: {}, expected, secrets: createDotenvxSecretBroker({}) })).toEqual({ selection: "embedded" });
  });
  it("requires a production-grade runtime and remains not-ready without a reviewed resolver", () => {
    expect(() => assertStagingActivationGuard({ runtimeMode: "development", environment: "staging", hasPostgresReadinessScope: false, organizationId: "org" })).toThrow("Cloudflare staging requires");
    expect(() => assertStagingActivationGuard({ runtimeMode: "production", environment: "staging", hasPostgresReadinessScope: true, organizationId: undefined })).toThrow("Cloudflare staging requires");
    expect(stagingPublishReady(false)).toBe(false);
  });
  it("assembles real transports without a network effect before publish", () => {
    let fetchCalls = 0;
    const fetcher: typeof fetch = async () => { fetchCalls += 1; throw new Error("must not fetch"); };
    new FetchCloudflarePagesTransport({ accountId: binding.cloudflare.accountId, projectKey: binding.cloudflare.projectId, productionBranch: binding.cloudflare.productionBranch, previewHostnameSuffix: binding.cloudflare.previewHostnameSuffix, productionHostname: binding.cloudflare.allowedHostname, apiToken: async () => "x".repeat(16), fetcher });
    new FetchCoolifyCommitTransport({ applicationKey: binding.coolify.applicationUuid, baseUrl: binding.coolify.baseUrl, apiToken: async () => "x".repeat(16), fetcher });
    expect(fetchCalls).toBe(0);
  });
  it("wires the selected unavailable provider into the service with no embedded fallback", async () => {
    const provider = releaseProviderForSelection("cloudflare-staging");
    const service = new McpEditingService(new InMemoryEditingRepository(), undefined, undefined, undefined, provider);
    await expect(provider.publish({ releaseId: "release-1", releaseHash: "a".repeat(64), artifact: { mediaType: "text/html; charset=utf-8", body: "x", hash: "b".repeat(64) } })).rejects.toMatchObject({ code: "STAGING_ARTIFACT_RESOLVER_UNAVAILABLE" });
    expect(service.releaseProviderKey()).toBe("navocms.cloudflare-staging.unavailable"); expect(service.releaseProviderKey()).not.toContain("embedded");
  });
});
