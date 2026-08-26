import { describe, expect, it } from "vitest";

import { ReviewedAstroArtifactResolver, type ReviewedAstroArtifactStore } from "./reviewed-astro-resolver.js";

const scope = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  environment: "staging" as const,
  environmentKey: "default"
});
const release = Object.freeze({
  releaseId: "33333333-3333-4333-8333-333333333333",
  releaseHash: "a".repeat(64),
  releaseArtifact: { mediaType: "text/html; charset=utf-8" as const, body: "preview", hash: "b".repeat(64) }
});

describe("Reviewed Astro artifact resolver", () => {
  it("fails closed before store readiness and does not query a release record", async () => {
    let queries = 0;
    const store: ReviewedAstroArtifactStore = {
      ready: async () => false,
      get: async () => { queries += 1; return undefined; }
    };
    const resolver = new ReviewedAstroArtifactResolver(store, scope);
    await expect(resolver.ready()).resolves.toBe(false);
    await expect(resolver.resolve(release)).rejects.toMatchObject({ code: "REVIEWED_ASTRO_RESOLVER_UNAVAILABLE" });
    expect(queries).toBe(0);
  });

  it("treats a missing concrete release record as a resolve failure, not a capability failure", async () => {
    const store: ReviewedAstroArtifactStore = {
      ready: async () => true,
      get: async () => undefined
    };
    const resolver = new ReviewedAstroArtifactResolver(store, scope);
    await expect(resolver.ready()).resolves.toBe(true);
    await expect(resolver.resolve(release)).rejects.toMatchObject({ code: "REVIEWED_ASTRO_ARTIFACT_MISMATCH" });
  });
});
