import { CloudflarePagesReleaseProvider, InMemoryDeliveryPhaseStore } from "@navocms/delivery-cloudflare";
import { describe, expect, it } from "vitest";

import { ReviewedAstroArtifactResolver, type ReviewedAstroArtifactRecord, type ReviewedAstroArtifactStore } from "./reviewed-astro-resolver.js";
import type { DotenvxSecretBroker } from "./secret-broker.js";
import { composeCloudflareStagingReleaseProvider } from "./staging-composition.js";
import { createDotenvxSecretBroker, selectReleaseProvider } from "./staging-runtime.js";
import { stagingBindingDigest } from "./staging-profile.js";

const binding = Object.freeze({
  schema: "io.navocms.cloudflare-staging-binding.v3" as const,
  tenantId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  environment: "staging" as const,
  cloudflare: {
    accountId: "account", projectId: "project", productionBranch: "staging", previewBranch: "preview",
    previewHostnameSuffix: ".pages.dev", allowedHostname: "staging.example.test", tokenSecretRef: "secret:delivery/cloudflare-token"
  }
});
const expected = Object.freeze({ tenantId: binding.tenantId, siteId: binding.siteId, allowedHostname: binding.cloudflare.allowedHostname, bindingDigest: stagingBindingDigest(binding) });
const release = Object.freeze({
  releaseId: "44444444-4444-4444-8444-444444444444",
  releaseHash: "a".repeat(64),
  artifact: { mediaType: "text/html; charset=utf-8" as const, body: "release", hash: "b".repeat(64) }
});

describe("cloudflare-staging composition", () => {
  it("uses the real provider and reviewed resolver, with missing or invalid records failing before secrets or transports", async () => {
    const selected = selectReleaseProvider({
      requested: "cloudflare-staging", environment: "staging", binding, expected,
      secrets: createDotenvxSecretBroker({
        DOTENVX_SECRET_DELIVERY_CLOUDFLARE_TOKEN: "x".repeat(16)
      })
    });
    if (selected.selection !== "cloudflare-staging") throw new Error("cloudflare staging was not selected");

    for (const record of [undefined, invalidRecord()]) {
      let secretUses = 0;
      let transportCalls = 0;
      const secrets: DotenvxSecretBroker = Object.freeze({
        assertAvailable: () => undefined,
        use: async <T>(_reference: string, _operation: (value: string) => Promise<T>) => {
          secretUses += 1;
          throw new Error("secret callback must not run");
        }
      });
      const store: ReviewedAstroArtifactStore = {
        ready: async () => true,
        get: async () => record
      };
      const composition = composeCloudflareStagingReleaseProvider({
        binding: selected.binding,
        environmentKey: "default",
        store,
        phases: new InMemoryDeliveryPhaseStore(),
        secrets,
        fetcher: async () => { transportCalls += 1; throw new Error("transport must not run"); }
      });

      expect(composition.provider).toBeInstanceOf(CloudflarePagesReleaseProvider);
      expect(composition.resolver).toBeInstanceOf(ReviewedAstroArtifactResolver);
      await expect(composition.provider.publish(release)).rejects.toMatchObject({
        code: record ? "REVIEWED_ASTRO_ARTIFACT_INVALID" : "REVIEWED_ASTRO_ARTIFACT_MISMATCH"
      });
      expect(secretUses).toBe(0);
      expect(transportCalls).toBe(0);
    }
  });
});

function invalidRecord(): ReviewedAstroArtifactRecord {
  return {
    tenantId: binding.tenantId,
    siteId: binding.siteId,
    environment: "staging",
    environmentKey: "default",
    releaseId: release.releaseId,
    releaseHash: release.releaseHash,
    releaseArtifactHash: release.artifact.hash,
    expectedAstroArtifactHash: `sha256:${"c".repeat(64)}`,
    sourceCommitSha: "d".repeat(40),
    artifact: {} as ReviewedAstroArtifactRecord["artifact"],
    output: {}
  };
}
