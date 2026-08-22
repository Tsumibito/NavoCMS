import { describe, expect, it } from "vitest";

import {
  createReleaseManifest,
  releaseTransition,
  renderMarkdownProofArtifact
} from "./releases.js";

describe("immutable releases", () => {
  it("creates a deterministic manifest and exact proof artifact", () => {
    const input = {
      tenantId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      environmentId: "33333333-3333-4333-8333-333333333333",
      revisionId: "44444444-4444-4444-8444-444444444444",
      sourceHash: "a".repeat(64),
      workflow: "navocms.editorial.standard.v1"
    } as const;
    const first = createReleaseManifest(input);
    const second = createReleaseManifest(input);
    expect(first).toEqual(second);
    const artifact = renderMarkdownProofArtifact({
      releaseHash: first.releaseHash,
      title: "Safe <preview>",
      locale: "en",
      markdown: "# Hello\n\n<script>alert(1)</script>\n"
    });
    expect(artifact.body).toContain("noindex,nofollow,noarchive");
    expect(artifact.body).toContain("&lt;script&gt;");
    expect(artifact.body).not.toContain("<script>");
  });

  it("fails closed on invalid state transitions", () => {
    expect(releaseTransition("previewed", "approved")).toBe("approved");
    expect(() => releaseTransition("previewed", "published")).toThrow(/cannot move/);
    expect(() => releaseTransition("published", "approved")).toThrow(/cannot move/);
  });
});
