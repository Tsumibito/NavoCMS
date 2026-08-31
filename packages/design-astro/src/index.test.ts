import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { compileDesignSystem } from "@navocms/design";
import { contentHash } from "@navocms/content";
import { describe, expect, it } from "vitest";

import { AstroDesignAdapterError, astroArtifactHash, astroContentDigest, astroMediaDigest, astroRegistrationDigest, createAstroDesignAdapter, materializeAstroArtifact, renderAstroArtifact, verifyAstroArtifact, verifyBuiltAstroOutput, type AstroMediaBinding } from "./index.js";
const exec = promisify(execFile);

async function design() {
  const input = JSON.parse(
    await readFile(
      new URL("../../../examples/design-systems/tidal-signal.design-system.json", import.meta.url),
      "utf8"
    )
  ) as unknown;
  return compileDesignSystem(input);
}

const registrations = [
  { id: "signal-button", module: "./components/SignalButton.astro", source: "<button><slot /></button>" },
  { id: "story-card", module: "./components/StoryCard.astro", source: "<article><slot /></article>" },
  { id: "section-shell", module: "./components/SectionShell.astro", source: "<section><slot /></section>" }
] as const;
const directives = [
  { name: "callout", kind: "containerDirective", allowedAttributes: ["tone"] },
  { name: "cta", kind: "leafDirective", allowedAttributes: ["label", "href"], requiredAttributes: ["label", "href"] }
] as const;
const semanticMarkdown = "# Home\n\n- One\n- [Two](/two)\n\n:::callout{tone=note}\nSafe note.\n:::\n\n::cta{label=Read href=/read}\n";

const deliveryLayoutSource = `---
import '../styles/navocms.css';
const { title, locale } = Astro.props;
---
<!doctype html><html lang={locale}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta data-navocms-consent-bridge="io.navocms.consent-bridge.v1"><meta data-navocms-analytics-bootstrap="io.navocms.analytics-bootstrap.v1"><title>{title}</title><script is:inline src="/cdn-cgi/zaraz/i.js" data-navocms-zaraz-loader="v1"></script></head><body><slot /></body></html>
`;
const deliveryLayout = { schema: "io.navocms.delivery-layout.v1" as const, source: deliveryLayoutSource, digest: `sha256:${contentHash(deliveryLayoutSource)}` };
function renderInput(adapter: Awaited<ReturnType<typeof createAstroDesignAdapter>>, routes: readonly { readonly id: string; readonly path: string; readonly locale: string; readonly revisionId: string; readonly componentId: string; readonly title: string; readonly source: string; readonly sourceHash: string; readonly directives?: typeof directives; readonly media: readonly AstroMediaBinding[] }[], layout = deliveryLayout) {
  return { tenantId: "tenant", siteId: "site", locales: { default: "en", supported: ["en", "fr"] }, anchors: { content: astroContentDigest(routes), design: adapter.digest, delivery: layout.digest, governance: `sha256:${"e".repeat(64)}` }, deliveryLayout: layout, expectedMediaDigest: astroMediaDigest(routes), design: adapter, routes };
}

async function directorySnapshot(directory: string, relative = ""): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(snapshot, await directorySnapshot(directory, path));
    else if (entry.isFile()) snapshot[path] = await readFile(join(directory, path), "utf8");
  }
  return snapshot;
}

async function materializeAndBuild(directory: string, artifact: ReturnType<typeof renderAstroArtifact>): Promise<Record<string, string>> {
  await materializeAstroArtifact(directory, artifact, artifact.hash);
  const catalogueModules = new URL("../../../" + "apps" + "/design-catalogue/node_modules", import.meta.url);
  await symlink(fileURLToPath(catalogueModules), join(directory, "node_modules"), "dir");
  const cli = fileURLToPath(new URL("../../../" + "apps" + "/design-catalogue/node_modules/astro/bin/astro.mjs", import.meta.url));
  await exec(process.execPath, [cli, "check"], { cwd: directory, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" } });
  await exec(process.execPath, [cli, "build"], { cwd: directory, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" } });
  const output = await directorySnapshot(join(directory, "dist"));
  verifyBuiltAstroOutput(output, artifact, artifact.hash);
  return output;
}

describe("Astro design adapter", () => {
  it("binds the complete design graph", async () => {
    const adapter = createAstroDesignAdapter(await design(), registrations);
    expect(adapter.recipes[0]?.slots).toHaveLength(3);
    expect(adapter.css).toContain(":root");
  });

  it("fails closed when a component has no renderer", async () => {
    const compiled = await design();
    expect(() => createAstroDesignAdapter(compiled, registrations.slice(1))).toThrowError(
      AstroDesignAdapterError
    );
  });

  it("rejects registrations without explicit source", async () => {
    const legacy = registrations.map(({ source: _source, ...registration }) => registration);
    const compiled = await design();
    expect(() => createAstroDesignAdapter(compiled, legacy as never)).toThrow(/bounds invalid/i);
  });

  it("renders a deterministic Astro source artifact with pinned digests and tamper detection", async () => {
    const adapter = createAstroDesignAdapter(await design(), registrations);
    const routes = ["en", "fr"].map((locale) => ({ id: "home", path: `/${locale}`, locale, revisionId: `${locale}-revision`, componentId: "section-shell", title: "Home", source: semanticMarkdown, sourceHash: contentHash(semanticMarkdown), directives, media: [{ assetId: "asset-1", variantIdentity: "c".repeat(64), url: "/media/hero.webp", alt: "Hero" }] }));
    const input = renderInput(adapter, routes);
    const first = renderAstroArtifact(input); const second = renderAstroArtifact(input);
    expect(first).toEqual(second); verifyAstroArtifact(first, first.hash);
    expect(first.files["src/pages/en/index.astro"]).toContain("SiteLayout");
    expect(first.files["src/layouts/SiteLayout.astro"]).toContain("data-navocms-zaraz-loader");
    expect(() => renderAstroArtifact({ ...input, anchors: { ...input.anchors, design: `sha256:${"0".repeat(64)}` } })).toThrow(/digest drift/i);
    expect(() => renderAstroArtifact({ ...input, expectedMediaDigest: `sha256:${"0".repeat(64)}` })).toThrow(/digest drift/i);
    expect(() => renderAstroArtifact({ ...input, deliveryLayout: { ...deliveryLayout, source: "<slot />" } })).toThrow(/delivery layout invalid/i);
    expect(() => renderAstroArtifact({ ...input, routes: routes.filter((route) => route.locale === "en") })).toThrow(/locale missing/i);
    expect(() => renderAstroArtifact({ ...input, routes: [...routes, { ...routes[0]!, locale: "fr" }] })).toThrow(/route input invalid/i);
    expect(() => verifyAstroArtifact({ ...first, files: { ...first.files, "src/pages/en/index.astro": "tampered" } }, first.hash)).toThrow(/tampered/i);
    expect(() => verifyAstroArtifact({ ...first, hash: `sha256:${"0".repeat(64)}` }, first.hash)).toThrow(/expected hash/i);
  });

  it("binds bounded inline responsive media to the immutable Astro source", async () => {
    const adapter = createAstroDesignAdapter(await design(), registrations);
    const media = Object.freeze([Object.freeze({
      assetId: "asset-1", variantIdentity: "c".repeat(64), alt: "Hero",
      url: "data:image/jpeg;base64,AA==",
      sources: Object.freeze([
        Object.freeze({ variantIdentity: "d".repeat(64), url: "data:image/webp;base64,AA==", mediaType: "image/webp" as const, media: "(max-width: 480px)" })
      ])
    })]);
    const routes = ["en", "fr"].map((locale) => ({ id: "home", path: `/${locale}`, locale, revisionId: `${locale}-revision`, componentId: "section-shell", title: "Home", source: "A safe page", sourceHash: contentHash("A safe page"), media }));
    const artifact = renderAstroArtifact(renderInput(adapter, routes));
    const source = artifact.files["src/pages/en/index.astro"]!;
    expect(source).toContain("<picture>");
    expect(source).toContain("data:image/webp;base64,AA==");
    expect(source).toContain("data-navocms-variant");
    const invalidRoutes = routes.map((route) => ({ ...route, media: [{ ...media[0]!, url: "data:text/html;base64,AA==" }] }));
    expect(() => renderAstroArtifact(renderInput(adapter, invalidRoutes))).toThrow(/media input invalid/i);
  });

  it("materializes clean pinned projects and produces byte-identical full dist output", async () => {
    const adapter = createAstroDesignAdapter(await design(), registrations);
    const routes = ["en", "fr"].map((locale) => ({ id: "home", path: `/${locale}`, locale, revisionId: `${locale}-revision`, componentId: "section-shell", title: "Home", source: semanticMarkdown, sourceHash: contentHash(semanticMarkdown), directives, media: [] }));
    const artifact = renderAstroArtifact(renderInput(adapter, routes));
    const firstDirectory = await mkdtemp(join(tmpdir(), "navocms-astro-"));
    const secondDirectory = await mkdtemp(join(tmpdir(), "navocms-astro-"));
    try {
      const first = await materializeAndBuild(firstDirectory, artifact);
      const second = await materializeAndBuild(secondDirectory, artifact);
      expect(second).toEqual(first);
      const html = first["en/index.html"]!;
      expect(html).toContain("<h1>Home</h1>");
      expect(html).toContain("<ul>");
      expect(html).toContain('href="/two"');
      expect(html).toContain('data-navocms-directive="callout"');
      expect(() => verifyBuiltAstroOutput(first, artifact, artifact.hash)).not.toThrow();
    } finally { await rm(firstDirectory, { recursive: true, force: true }); await rm(secondDirectory, { recursive: true, force: true }); }
  }, 120_000);

  it("rejects delivery-layout markers hidden in frontmatter or comments after a real Astro build", async () => {
    const adapter = createAstroDesignAdapter(await design(), registrations);
    const routes = ["en", "fr"].map((locale) => ({ id: "home", path: `/${locale}`, locale, revisionId: `${locale}-revision`, componentId: "section-shell", title: "Home", source: "A safe page", sourceHash: contentHash("A safe page"), media: [] }));
    const source = `---
const fake = '<script src="/cdn-cgi/zaraz/i.js" data-navocms-zaraz-loader="v1"></script><meta data-navocms-consent-bridge="io.navocms.consent-bridge.v1"><meta data-navocms-analytics-bootstrap="io.navocms.analytics-bootstrap.v1">';
---
<!doctype html><html><head><!-- ${"<script src=\"/cdn-cgi/zaraz/i.js\" data-navocms-zaraz-loader=\"v1\"></script><meta data-navocms-consent-bridge=\"io.navocms.consent-bridge.v1\"><meta data-navocms-analytics-bootstrap=\"io.navocms.analytics-bootstrap.v1\">"} --></head><body><slot /></body></html>`;
    const layout = { schema: "io.navocms.delivery-layout.v1" as const, source, digest: `sha256:${contentHash(source)}` };
    const directory = await mkdtemp(join(tmpdir(), "navocms-astro-adversarial-"));
    try {
      await expect(materializeAndBuild(directory, renderAstroArtifact(renderInput(adapter, routes, layout)))).rejects.toThrow(/delivery layout contract invalid/i);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 120_000);

  it("rejects inert, raw-text, duplicate-attribute, and non-executing delivery lookalikes", async () => {
    const required = '<meta data-navocms-consent-bridge="io.navocms.consent-bridge.v1"><meta data-navocms-analytics-bootstrap="io.navocms.analytics-bootstrap.v1">';
    const cases = [
      `<template><script src="/cdn-cgi/zaraz/i.js" data-navocms-zaraz-loader="v1"></script>${required}</template>`,
      `<script>const fake = '${required}' + '<script src="/cdn-cgi/zaraz/i.js" data-navocms-zaraz-loader="v1"></script>';</script>`,
      `<script src="https://attacker.invalid/x.js" src="/cdn-cgi/zaraz/i.js" data-navocms-zaraz-loader="v1"></script>${required}`,
      `<script type="text/plain" src="/cdn-cgi/zaraz/i.js" data-navocms-zaraz-loader="v1"></script>${required}`
    ];
    const adapter = createAstroDesignAdapter(await design(), registrations);
    const routes = ["en", "fr"].map((locale) => ({ id: "home", path: `/${locale}`, locale, revisionId: `${locale}-revision`, componentId: "section-shell", title: "Home", source: "A safe page", sourceHash: contentHash("A safe page"), media: [] }));
    const artifact = renderAstroArtifact(renderInput(adapter, routes));
    for (const html of cases) expect(() => verifyBuiltAstroOutput({ "en/index.html": `<!doctype html><html><head>${html}</head><body></body></html>`, "fr/index.html": `<!doctype html><html><head>${html}</head><body></body></html>` }, artifact, artifact.hash)).toThrow(/delivery layout|duplicate attribute/i);
  });

  it("requires complete bounded route-parity output from the immutable artifact", async () => {
    const adapter = createAstroDesignAdapter(await design(), registrations);
    const routes = ["en", "fr"].map((locale) => ({ id: "home", path: `/${locale}`, locale, revisionId: `${locale}-revision`, componentId: "section-shell", title: "Home", source: "A safe page", sourceHash: contentHash("A safe page"), media: [] }));
    const artifact = renderAstroArtifact(renderInput(adapter, routes));
    const html = '<!doctype html><html><head><meta data-navocms-consent-bridge="io.navocms.consent-bridge.v1"><meta data-navocms-analytics-bootstrap="io.navocms.analytics-bootstrap.v1"><script src="/cdn-cgi/zaraz/i.js" data-navocms-zaraz-loader="v1"></script></head><body></body></html>';
    const complete = { "en/index.html": html, "fr/index.html": html };
    expect(() => verifyBuiltAstroOutput(complete, artifact, artifact.hash)).not.toThrow();
    expect(() => verifyBuiltAstroOutput({}, artifact, artifact.hash)).toThrow(/output invalid/i);
    expect(() => verifyBuiltAstroOutput({ "en/index.html": html }, artifact, artifact.hash)).toThrow(/route parity/i);
    expect(() => verifyBuiltAstroOutput({ ...complete, "admin/index.html": html }, artifact, artifact.hash)).toThrow(/route parity/i);
    expect(() => verifyBuiltAstroOutput({ ...complete, ...Object.fromEntries(Array.from({ length: 511 }, (_, index) => [`assets/${index}.txt`, "x"])) }, artifact, artifact.hash)).toThrow(/output invalid/i);
    expect(() => verifyBuiltAstroOutput({ ...complete, "assets/large.txt": "x".repeat(8 * 1024 * 1024) }, artifact, artifact.hash)).toThrow(/output invalid/i);
  });

  it("rejects tampering for every generated file class and aggregate bounds", async () => {
    const adapter = createAstroDesignAdapter(await design(), registrations);
    const routes = ["en", "fr"].map((locale) => ({ id: "home", path: `/${locale}`, locale, revisionId: `${locale}-revision`, componentId: "section-shell", title: "Home", source: "A safe page", sourceHash: contentHash("A safe page"), media: [] }));
    const input = renderInput(adapter, routes);
    const artifact = renderAstroArtifact(input);
    for (const path of ["package.json", "astro.config.mjs", "src/styles/navocms.css", "src/layouts/SiteLayout.astro", "src/components/section-shell.astro", "src/pages/en/index.astro", "navocms-artifact-manifest.json"]) {
      expect(() => verifyAstroArtifact({ ...artifact, files: { ...artifact.files, [path]: "tampered" } }, artifact.hash)).toThrow();
    }
    const oversized = "x".repeat(64 * 1024 + 1);
    expect(() => renderAstroArtifact({ ...input, routes: input.routes.map((route) => ({ ...route, source: oversized, sourceHash: contentHash(oversized) })) })).toThrow(/route input invalid/i);
    expect(() => verifyAstroArtifact({ ...artifact, files: Object.fromEntries(Object.entries(artifact.files).filter(([path]) => path !== "src/pages/en/index.astro")) }, artifact.hash)).toThrow(/tampered|file coverage/i);
    expect(() => verifyAstroArtifact({ ...artifact, files: { ...artifact.files, "src/extra.astro": "extra" } }, artifact.hash)).toThrow(/file coverage/i);
    expect(() => verifyAstroArtifact({ ...artifact, manifest: { ...artifact.manifest, files: [...artifact.manifest.files, artifact.manifest.files[0]!] } }, artifact.hash)).toThrow(/path invalid/i);
    expect(() => verifyAstroArtifact({ ...artifact, manifest: { ...artifact.manifest, files: [{ ...artifact.manifest.files[0]!, path: "../escape.astro" }] } }, artifact.hash)).toThrow(/path invalid/i);
    const rehashed = <T extends { readonly manifest: typeof artifact.manifest; readonly files: typeof artifact.files }>(candidate: T) => ({ ...candidate, hash: astroArtifactHash(candidate) });
    for (const candidate of [
      { ...artifact, unexpected: true },
      { ...artifact, manifest: { ...artifact.manifest, unexpected: true } },
      { ...artifact, manifest: { ...artifact.manifest, digests: { ...artifact.manifest.digests, unexpected: `sha256:${"a".repeat(64)}` } } },
      { ...artifact, manifest: { ...artifact.manifest, files: [{ ...artifact.manifest.files[0]!, unexpected: true }] } }
    ]) expect(() => verifyAstroArtifact(rehashed(candidate), rehashed(candidate).hash)).toThrow(/schema|path invalid/i);
  });

  it("normalizes route, registration, and media digest order and rejects stale materialization targets", async () => {
    const adapter = createAstroDesignAdapter(await design(), registrations);
    const routes = ["en", "fr"].map((locale) => ({ id: "home", path: `/${locale}`, locale, revisionId: `${locale}-revision`, componentId: "section-shell", title: "Home", source: "A safe page", sourceHash: contentHash("A safe page"), media: [{ assetId: `asset-${locale}`, variantIdentity: "c".repeat(64), url: `/media/${locale}.webp`, alt: "Hero" }] }));
    const reordered = [...routes].reverse().map((route) => ({ ...route, media: [...route.media].reverse() }));
    expect(astroContentDigest(reordered)).toBe(astroContentDigest(routes));
    expect(astroMediaDigest(reordered)).toBe(astroMediaDigest(routes));
    expect(astroRegistrationDigest([...adapter.components.values()].reverse())).toBe(astroRegistrationDigest(adapter.components.values()));
    expect(() => renderAstroArtifact({ ...renderInput(adapter, routes), routes: routes.map((route) => ({ ...route, directives: [{ name: "callout", kind: "containerDirective", allowedAttributes: ["tone"], requiredAttributes: ["missing"] }] })) })).toThrow(/directive input invalid/i);
    const artifact = renderAstroArtifact(renderInput(adapter, routes));
    const corpus = JSON.parse(await readFile(new URL("../../../examples/astro/path-and-identifier-corpus.json", import.meta.url), "utf8")) as readonly { readonly path?: string; readonly tenantId?: string; readonly siteId?: string }[];
    for (const mutation of corpus) {
      const candidate = {
        ...artifact,
        manifest: {
          ...artifact.manifest,
          ...(mutation.tenantId ? { tenantId: mutation.tenantId } : {}),
          ...(mutation.siteId ? { siteId: mutation.siteId } : {}),
          ...(mutation.path ? { files: [{ ...artifact.manifest.files[0]!, path: mutation.path }, ...artifact.manifest.files.slice(1)] } : {})
        }
      };
      const rebound = { ...candidate, hash: astroArtifactHash(candidate) };
      expect(() => verifyAstroArtifact(rebound, rebound.hash)).toThrow(/schema|path invalid/i);
    }
    const directory = await mkdtemp(join(tmpdir(), "navocms-astro-stale-"));
    const linkedDirectory = `${directory}-link`;
    try {
      await writeFile(join(directory, "stale.txt"), "stale", "utf8");
      await expect(materializeAstroArtifact(directory, artifact, artifact.hash)).rejects.toThrow(/empty non-symlink/i);
      await symlink(directory, linkedDirectory, "dir");
      await expect(materializeAstroArtifact(linkedDirectory, artifact, artifact.hash)).rejects.toThrow(/empty non-symlink/i);
    } finally { await unlink(linkedDirectory).catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
  });
});
