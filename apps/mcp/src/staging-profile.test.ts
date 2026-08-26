import { sha256, type ReleaseArtifact } from "@navocms/kernel";
import { NAVOCMS_PERMISSIONS, siteRoleAuthority } from "@navocms/security";
import { describe, expect, it } from "vitest";

import { assertCloudflareStagingBinding, assertStagingReadiness, bootCloudflareStagingProfile, CLOUDFLARE_STAGING_PROFILE, dryRunCloudflareStaging, stagingBindingDigest } from "./staging-profile.js";
import type { McpRequestContext } from "./model.js";
import { EMBEDDED_PRODUCTION_PROFILE } from "./production-profile.js";

const binding = Object.freeze({
  schema: "io.navocms.cloudflare-staging-binding.v1" as const,
  tenantId: "11111111-1111-4111-8111-111111111111", siteId: "22222222-2222-4222-8222-222222222222", environment: "staging" as const,
  cloudflare: { accountId: "staging-account", projectId: "staging-pages", productionBranch: "staging", previewBranch: "preview", allowedHostname: "staging.example.test", tokenSecretRef: "secret:delivery/cloudflare-token" },
  coolify: { baseUrl: "https://coolify.staging.example.test", applicationUuid: "33333333-3333-4333-8333-333333333333", tokenSecretRef: "secret:delivery/coolify-token" }
});
const releaseHash = "a".repeat(64); const artifact: ReleaseArtifact = Object.freeze({ mediaType: "text/html; charset=utf-8", body: "proof", hash: "b".repeat(64) });

describe("Cloudflare staging activation boundary", () => {
  it("boots only a dry-run staging capability and never alters production", async () => {
    const host = await bootCloudflareStagingProfile(binding, expectation());
    expect(host.status()).toMatchObject({ state: "healthy", activePlugins: ["navocms.release.cloudflare-staging"] });
    expect(host.capabilities.resolve({ name: "release.provider", version: 1 }, "navocms.release.cloudflare-staging")).toMatchObject({ mode: "dry-run" });
    expect(EMBEDDED_PRODUCTION_PROFILE.spec).toMatchObject({ environment: "production", bindings: [{ provider: "navocms.release.embedded" }] });
  });

  it("rejects production bindings and secret values before any resolver call", async () => {
    expect(() => assertCloudflareStagingBinding({ ...binding, environment: "production" })).toThrow("Cloudflare staging binding");
    expect(() => assertCloudflareStagingBinding({ ...binding, cloudflare: { ...binding.cloudflare, tokenSecretRef: "plaintext-token" } })).toThrow("Cloudflare staging binding");
    await expect(dryRunCloudflareStaging({ context: context("agent"), binding, resolver: { resolve: async () => { throw new Error("must not resolve"); } }, release: { releaseId: "release-1", releaseHash, artifact } })).rejects.toMatchObject({ code: "STAGING_HUMAN_REQUIRED" });
  });

  it("uses the contracts parser identically and fails closed for scope, pin, extra fields, and an oversized endpoint", () => {
    for (const invalid of [
      { ...binding, unexpected: "plaintext-token" },
      { ...binding, cloudflare: { ...binding.cloudflare, unexpected: "plaintext-token" } },
      { ...binding, coolify: { ...binding.coolify, unexpected: "plaintext-token" } },
      { ...binding, coolify: { ...binding.coolify, baseUrl: `https://${"a".repeat(510)}.test` } }
    ]) expect(() => assertCloudflareStagingBinding(invalid)).toThrow();
    expect(() => assertStagingReadiness(binding, { ...expectation(), tenantId: "44444444-4444-4444-8444-444444444444" })).toThrow("reviewed pin");
    expect(() => assertStagingReadiness(binding, { ...expectation(), bindingDigest: "sha256:wrong" })).toThrow("reviewed pin");
    expect(Object.isFrozen(CLOUDFLARE_STAGING_PROFILE.spec.urlPolicy)).toBe(true);
    expect(() => assertCloudflareStagingBinding({ ...binding, cloudflare: { ...binding.cloudflare, previewBranch: "staging" } })).toThrow();
    expect(() => assertCloudflareStagingBinding({ ...binding, coolify: { ...binding.coolify, baseUrl: "https://user:pass@coolify.example.test" } })).toThrow();
    expect(stagingBindingDigest(binding)).toBe(stagingBindingDigest({ coolify: binding.coolify, cloudflare: binding.cloudflare, environment: binding.environment, siteId: binding.siteId, tenantId: binding.tenantId, schema: binding.schema }));
  });

  it("proves authorized resolver-to-artifact configuration without a transport effect", async () => {
    let resolves = 0;
    const result = await dryRunCloudflareStaging({ context: context("human"), binding, release: { releaseId: "release-1", releaseHash, artifact }, resolver: { resolve: async () => {
      resolves += 1;
      const files = { "en/index.html": "<html>safe</html>" };
      return { files, reference: { schema: "io.navocms.cloudflare-artifact-reference.v1" as const, releaseHash, releaseArtifactHash: artifact.hash, astroArtifactHash: `sha256:${"c".repeat(64)}`, outputHash: sha256(JSON.stringify(files)), routeDigest: sha256('["en/index.html"]'), sourceCommitSha: "d".repeat(40), fileCount: 1, byteSize: 17, files: [{ path: "en/index.html", sha256: sha256(files["en/index.html"]), byteSize: 17 }] } };
    } } });
    expect(resolves).toBe(1); expect(result).toMatchObject({ cloudflareProjectId: "staging-pages", coolifyApplicationUuid: binding.coolify.applicationUuid });
  });

  it("uses the provider artifact verifier and rejects unsafe file/reference drift", async () => {
    await expect(dryRunCloudflareStaging({ context: context("human"), binding, release: { releaseId: "release-1", releaseHash, artifact }, resolver: { resolve: async () => ({
      files: { "../escape": "tampered" },
      reference: { schema: "io.navocms.cloudflare-artifact-reference.v1", releaseHash, releaseArtifactHash: artifact.hash, astroArtifactHash: `sha256:${"c".repeat(64)}`, outputHash: sha256('{"en/index.html":"<html>safe</html>"}'), routeDigest: sha256('["en/index.html"]'), sourceCommitSha: "d".repeat(40), fileCount: 1, byteSize: 17, files: [{ path: "en/index.html", sha256: sha256("<html>safe</html>"), byteSize: 17 }] }
    }) } })).rejects.toThrow();
  });

  it("uses the provider's full release preflight", async () => {
    let resolverCalls = 0;
    await expect(dryRunCloudflareStaging({ context: context("human"), binding, release: { releaseId: "../unsafe", releaseHash, artifact }, resolver: { resolve: async () => { resolverCalls += 1; throw new Error("must not resolve"); } } })).rejects.toMatchObject({ code: "RELEASE_INPUT_INVALID" });
    expect(resolverCalls).toBe(0);
  });
});

function expectation() { return { tenantId: binding.tenantId, siteId: binding.siteId, allowedHostname: binding.cloudflare.allowedHostname, bindingDigest: stagingBindingDigest(binding) }; }

function context(kind: "human" | "agent"): McpRequestContext { return { authorization: { tenantId: binding.tenantId, siteId: binding.siteId, principal: { id: "publisher", kind, issuer: "https://workos.example", subject: "publisher" }, layers: [{ name: "principal" as const, permissions: NAVOCMS_PERMISSIONS }, siteRoleAuthority("publisher"), { name: "operation" as const, permissions: NAVOCMS_PERMISSIONS }] } }; }
