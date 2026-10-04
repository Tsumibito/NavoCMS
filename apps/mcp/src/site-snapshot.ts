import { createHash } from "node:crypto";
import { astroContentDigest, astroMediaDigest, renderAstroArtifact, type AstroRenderInput, type AstroRenderRoute } from "@navocms/design-astro";
import { McpEditingError } from "./errors.js";

/** Published routes are the baseline; only explicitly selected variants replace them. */
export function composeSiteSnapshot(selected: readonly AstroRenderInput[], previous: readonly AstroRenderRoute[], basePublicationId: string | null): AstroRenderInput {
  const first = selected[0];
  if (!first || selected.length > 100) throw new McpEditingError("SITE_SNAPSHOT_BOUNDS", "Select between one and 100 revisions");
  const routes = new Map(previous.map(route => [route.path, route]));
  const selectedPaths = new Set<string>();
  for (const input of selected) {
    if (input.tenantId !== first.tenantId || input.siteId !== first.siteId || input.anchors.design !== first.anchors.design || input.anchors.delivery !== first.anchors.delivery) throw new McpEditingError("SITE_SNAPSHOT_SCOPE", "Selected inputs must share site and design policy");
    for (const route of input.routes) {
      if (selectedPaths.has(route.path)) throw new McpEditingError("SITE_SNAPSHOT_ROUTE_CONFLICT", "Two selected revisions claim the same route");
      selectedPaths.add(route.path);
      const existing = routes.get(route.path);
      if (existing && existing.id !== route.id) throw new McpEditingError("SITE_SNAPSHOT_ROUTE_CONFLICT", "A different content variant already owns this public route");
      routes.set(route.path, route);
    }
  }
  const snapshotRoutes = [...routes.values()].sort((a, b) => a.path.localeCompare(b.path));
  const redirects = snapshotRoutes.filter(route => route.path === "/catalog" || /\/catalog$/.test(route.path)).map(route => ({ from: route.path.replace(/catalog$/, "catalogue"), to: route.path, status: 301 as const }));
  const render: AstroRenderInput = { ...first, routes: snapshotRoutes, redirects,
    anchors: { ...first.anchors, content: astroContentDigest(snapshotRoutes, redirects), governance: snapshotGovernance(first.anchors.governance, basePublicationId) },
    expectedMediaDigest: astroMediaDigest(snapshotRoutes) };
  renderAstroArtifact(render);
  return render;
}

export function snapshotGovernance(policy: string, basePublicationId: string | null): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify({ schema: "io.navocms.site-snapshot.v1", policy, basePublicationId })).digest("hex")}`;
}
