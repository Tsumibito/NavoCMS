import { describe, it, expect } from "vitest";
import { contentHash } from "@navocms/content";
import { composeSiteSnapshot } from "./site-snapshot.js";
import { StagingAstroPreviewPreparer } from "./staging-astro-preview-preparer.js";

const site = { tenantId: "tenant", siteId: "site", name: "Pilot", primaryLocale: "en", locales: ["en", "fr"] };
function input(slug: string, locale = "en", text = slug) {
  return new StagingAstroPreviewPreparer().prepare(site, {
    ...site, id: `${slug}-${locale}-${contentHash(text).slice(0, 8)}`, documentId: slug, variantId: `${slug}-${locale}`,
    number: 1, source: text, sourceHash: contentHash(text),
    ast: { format: "navocms-markdown-ast/v1", parser: "remark-gfm-directive", sourceHash: contentHash(text), nodes: [] },
    metadata: { title: slug, slug, locale }, provenance: { kind: "agent", actorId: "editor" }, createdAt: "2026-10-04T00:00:00Z"
  });
}
describe("immutable site snapshots", () => {
  it("preserves five published pages and both locales when changing one selected page", () => {
    const initial = composeSiteSnapshot(["home", "catalog", "about", "sailing", "aurora"].flatMap(slug => [input(slug), input(slug, "fr")]), [], null);
    const next = composeSiteSnapshot([input("catalog", "en", "Updated")], initial.routes, "publication-one");
    expect(next.routes).toHaveLength(10);
    expect(next.redirects).toEqual([{ from: "/catalogue", to: "/catalog", status: 301 }, { from: "/fr/catalogue", to: "/fr/catalog", status: 301 }]);
    expect(next.routes.find(route => route.path === "/catalog")?.source).toBe("Updated");
    expect(next.routes.filter(route => route.path !== "/catalog")).toEqual(initial.routes.filter(route => route.path !== "/catalog"));
    expect(initial.routes.find(route => route.path === "/catalog")?.source).toBe("catalog");
    expect(next.routes.map(route => route.path)).toContain("/fr/catalog");
  });
  it("binds the publication baseline even when selected content is identical", () => {
    const first = composeSiteSnapshot([input("home")], [], "one");
    const second = composeSiteSnapshot([input("home")], [], "two");
    expect(first.anchors.content).toBe(second.anchors.content);
    expect(first.anchors.governance).not.toBe(second.anchors.governance);
  });
  it("rejects duplicate selected routes, route hijacking and cross-site inputs", () => {
    const home = input("home");
    expect(() => composeSiteSnapshot([home, home], [], null)).toThrow("same route");
    expect(() => composeSiteSnapshot([home], [{ ...home.routes[0]!, id: "other" }], null)).toThrow("already owns");
    expect(() => composeSiteSnapshot([home, { ...input("about"), siteId: "foreign" }], [], null)).toThrow("share site");
  });
});
