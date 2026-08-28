import { describe, expect, it } from "vitest";

import {
  EMBEDDED_PRODUCTION_PROFILE,
  EMBEDDED_PRODUCTION_PROFILE_DIGEST,
  EMBEDDED_RELEASE_MANIFEST,
  assertPinnedProductionProfile,
  profileDigest
} from "./production-profile.js";

describe("pinned embedded production profile", () => {
  it("accepts the reviewed profile and provider selection directly", () => {
    assertPinnedProductionProfile();
  });

  it("fails closed on pin, provider identity, and capability drift", () => {
    expect(profileDigest(EMBEDDED_PRODUCTION_PROFILE)).toBe(EMBEDDED_PRODUCTION_PROFILE_DIGEST);
    expect(() => assertPinnedProductionProfile(EMBEDDED_PRODUCTION_PROFILE, EMBEDDED_RELEASE_MANIFEST, "sha256:0")).toThrow(/digest/);
    expect(() => assertPinnedProductionProfile(EMBEDDED_PRODUCTION_PROFILE, {
      ...EMBEDDED_RELEASE_MANIFEST,
      metadata: { ...EMBEDDED_RELEASE_MANIFEST.metadata, id: "navocms.release.other" }
    })).toThrow(/provider/);
    expect(() => assertPinnedProductionProfile(EMBEDDED_PRODUCTION_PROFILE, {
      ...EMBEDDED_RELEASE_MANIFEST,
      spec: { ...EMBEDDED_RELEASE_MANIFEST.spec, provides: [] }
    })).toThrow(/capability/);
  });

  it("fails closed when manifest version differs from its pinned profile", () => {
    expect(() => assertPinnedProductionProfile(EMBEDDED_PRODUCTION_PROFILE, {
      ...EMBEDDED_RELEASE_MANIFEST,
      metadata: { ...EMBEDDED_RELEASE_MANIFEST.metadata, version: "0.1.1" }
    })).toThrow(/provider/);
  });

  it("does not activate a media storage provider in the pinned production profile", () => {
    expect(EMBEDDED_PRODUCTION_PROFILE.spec.bindings.some(({ capability }) => capability === "media.storage")).toBe(false);
  });
});
