import { renderAstroArtifact } from "@navocms/design-astro";
import { contentHash } from "@navocms/content";
import { createReleaseManifest } from "@navocms/kernel";
import { NAVOCMS_PERMISSIONS, siteRoleAuthority } from "@navocms/security";
import { describe, expect, it } from "vitest";

import type { McpRequestContext } from "./model.js";
import { reviewedAstroBuildInputAuthority } from "./postgres-reviewed-astro-build-input-store.js";
import { StagingAstroPreviewPreparer } from "./staging-astro-preview-preparer.js";

const site = Object.freeze({ tenantId: "11111111-1111-4111-8111-111111111111", siteId: "22222222-2222-4222-8222-222222222222", name: "Staging", primaryLocale: "en", locales: ["en"] });
const revision = Object.freeze({ id: "33333333-3333-4333-8333-333333333333", tenantId: site.tenantId, siteId: site.siteId, documentId: "44444444-4444-4444-8444-444444444444", variantId: "55555555-5555-4555-8555-555555555555", number: 1, source: "# Home", sourceHash: contentHash("# Home"), ast: { format: "navocms-markdown-ast/v1" as const, parser: "remark-gfm-directive" as const, sourceHash: contentHash("# Home"), nodes: [] }, metadata: { title: "Home", slug: "home", locale: "en" }, provenance: { kind: "human" as const, actorId: "66666666-6666-4666-8666-666666666666" }, createdAt: "2026-01-01T00:00:00.000Z" });

describe("staging Astro preview preparation", () => {
  it("derives a buildable render snapshot and release anchors before preview creation", () => {
    const render = new StagingAstroPreviewPreparer().prepare(site, revision);
    const artifact = renderAstroArtifact(render);
    const release = createReleaseManifest({ tenantId: site.tenantId, siteId: site.siteId, environmentId: "77777777-7777-4777-8777-777777777777", revisionId: revision.id, sourceHash: revision.sourceHash, workflow: "navocms.editorial.standard.v1", anchors: Object.fromEntries(Object.entries(render.anchors).map(([key, digest]) => [key, digest.slice(7)])) });
    expect(artifact.manifest.digests).toMatchObject({ content: render.anchors.content, design: render.anchors.design, delivery: render.anchors.delivery, governance: render.anchors.governance });
    expect(release.manifest.anchors.content).toBe(render.anchors.content.slice(7));
    expect(release.releaseHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed for an unsupported locale or an unaddressable revision", () => {
    const preparer = new StagingAstroPreviewPreparer();
    expect(() => preparer.prepare(site, { ...revision, metadata: { ...revision.metadata, locale: "fr" } })).toThrow("supported locale");
    expect(() => preparer.prepare(site, { ...revision, metadata: { ...revision.metadata, slug: "Bad path" } })).toThrow("canonical slug");
  });

  it("allows an authenticated draft agent to persist preview evidence without granting publish", () => {
    const editor = requestContext("editor", "agent");
    expect(reviewedAstroBuildInputAuthority(editor)).toMatchObject({ principal: { kind: "agent" } });
    expect(() => reviewedAstroBuildInputAuthority(requestContext("viewer", "human"))).toThrow();
  });
});

function requestContext(role: "editor" | "viewer", kind: "human" | "agent"): McpRequestContext {
  return { authorization: {
    tenantId: site.tenantId,
    siteId: site.siteId,
    principal: { id: revision.provenance.actorId, kind, issuer: "urn:navocms:test", subject: `${kind}-${role}` },
    layers: [
      { name: "principal", permissions: NAVOCMS_PERMISSIONS },
      siteRoleAuthority(role),
      { name: "operation", permissions: NAVOCMS_PERMISSIONS }
    ]
  } };
}
