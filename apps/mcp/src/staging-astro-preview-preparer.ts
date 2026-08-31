import { astroContentDigest, astroMediaDigest, renderAstroArtifact, type AstroMediaBinding, type AstroRenderInput } from "@navocms/design-astro";
import { contentHash, type ContentRevision } from "@navocms/content";
import { createHash } from "node:crypto";

import { McpEditingError } from "./errors.js";
import type { SiteDescriptor } from "./model.js";

const layoutSource = `---
import '../styles/navocms.css';
const { title, locale } = Astro.props;
---
<!doctype html><html lang={locale}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta data-navocms-consent-bridge="io.navocms.consent-bridge.v1"><meta data-navocms-analytics-bootstrap="io.navocms.analytics-bootstrap.v1"><title>{title}</title><script is:inline src="/cdn-cgi/zaraz/i.js" data-navocms-zaraz-loader="v1"></script></head><body><slot /></body></html>
`;
const registrations = Object.freeze([
  Object.freeze({ id: "signal-button", module: "./components/SignalButton.astro", source: "<button><slot /></button>" }),
  Object.freeze({ id: "story-card", module: "./components/StoryCard.astro", source: "<article><slot /></article>" }),
  Object.freeze({ id: "section-shell", module: "./components/SectionShell.astro", source: "<section><slot /></section>" })
]);
const css = ":root { --navocms-page: #ffffff; --navocms-ink: #12263a; }\nbody { margin: 0; background: var(--navocms-page); color: var(--navocms-ink); }\n";
const designDigest = digest({ schema: "io.navocms.staging-design.v1", css, registrations });
const governanceDigest = digest({ schema: "io.navocms.staging-governance.v1", semanticMarkdown: true, rawHtml: false, directivePolicy: "content-type-declared" });
const deliveryDigest = `sha256:${contentHash(layoutSource)}`;
export const STAGING_ASTRO_POLICY_DIGEST = digest({ schema: "io.navocms.staging-astro-policy.v1", designDigest, deliveryDigest, governanceDigest, registrations, css });

/**
 * Reviewed kernel policy for the first staging site. It accepts only one
 * durable revision and its verified staging media bindings, then emits a
 * deterministic, bounded Astro input before the release hash exists. No
 * request ever provides component, layout, anchor, or media URL source;
 * later releases can replace this policy with a reviewed profile.
 */
export class StagingAstroPreviewPreparer {
  public prepare(site: SiteDescriptor, revision: ContentRevision, media: readonly AstroMediaBinding[] = []): AstroRenderInput {
    if (revision.tenantId !== site.tenantId || revision.siteId !== site.siteId) throw new McpEditingError("STAGING_ASTRO_SCOPE_DENIED", "Staging Astro preview input is outside the authorized site");
    const locale = typeof revision.metadata.locale === "string" && /^[A-Za-z0-9-]{2,20}$/.test(revision.metadata.locale)
      ? revision.metadata.locale : site.primaryLocale;
    const slug = typeof revision.metadata.slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(revision.metadata.slug)
      ? revision.metadata.slug : undefined;
    const title = typeof revision.metadata.title === "string" && revision.metadata.title.length > 0 && revision.metadata.title.length <= 256
      ? revision.metadata.title : "Untitled";
    if (!slug || !site.locales.includes(locale)) throw new McpEditingError("STAGING_ASTRO_REVISION_INVALID", "Staging Astro preview requires a supported locale and canonical slug");
    const route = Object.freeze({ id: revision.documentId, path: slug === "home" ? "/" : `/${slug}`, locale, revisionId: revision.id,
      componentId: "section-shell", title, source: revision.source, sourceHash: revision.sourceHash, directives: [], media: [...media] });
    const render: AstroRenderInput = Object.freeze({ tenantId: site.tenantId, siteId: site.siteId,
      locales: Object.freeze({ default: locale, supported: Object.freeze([locale]) }),
      anchors: Object.freeze({ content: astroContentDigest([route]), design: designDigest, delivery: deliveryDigest, governance: governanceDigest }),
      deliveryLayout: Object.freeze({ schema: "io.navocms.delivery-layout.v1", source: layoutSource, digest: deliveryDigest }),
      expectedMediaDigest: astroMediaDigest([route]),
      design: Object.freeze({ digest: designDigest, css, components: new Map(registrations.map((item) => [item.id, item])), recipes: [] }),
      routes: Object.freeze([route])
    });
    try { renderAstroArtifact(render); } catch { throw new McpEditingError("STAGING_ASTRO_RENDER_INVALID", "Reviewed staging Astro policy could not render this revision"); }
    return render;
  }
}

function digest(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
