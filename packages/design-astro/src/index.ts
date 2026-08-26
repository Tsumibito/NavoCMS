import type { CompiledDesignSystem } from "@navocms/design";
import { contentHash, renderSemanticMarkdownHtml, type DirectiveDefinition } from "@navocms/content";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { parse, type DefaultTreeAdapterTypes, type ParserError } from "parse5";

export interface AstroComponentRegistration {
  readonly id: string;
  readonly module: string;
  /** Pinned component source copied into the self-contained Astro artifact. */
  readonly source?: string;
  readonly exportName?: string;
}

export interface AstroDesignAdapter {
  readonly digest: CompiledDesignSystem["digest"];
  readonly css: string;
  readonly components: ReadonlyMap<string, AstroComponentRegistration>;
  readonly recipes: readonly {
    readonly id: string;
    readonly slots: readonly { readonly id: string; readonly componentModule: string }[];
  }[];
  /** Legacy registrations are normalized only for pre-v1 adapter consumers. */
  readonly legacyComponentIds: readonly string[];
}

export const ASTRO_RENDER_LIMITS = Object.freeze({ routes: 100, locales: 16, registrations: 64, mediaPerRoute: 32, files: 256, directives: 16, directiveAttributes: 16, sourceBytes: 64 * 1024, layoutBytes: 64 * 1024, titleBytes: 256, altBytes: 512, bundleBytes: 2 * 1024 * 1024 });
export const ASTRO_BUILT_OUTPUT_LIMITS = Object.freeze({ files: 512, bytes: 8 * 1024 * 1024 });

export class AstroDesignAdapterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AstroDesignAdapterError";
  }
}

export function createAstroDesignAdapter(
  design: CompiledDesignSystem,
  registrations: readonly AstroComponentRegistration[]
): AstroDesignAdapter {
  const duplicate = registrations.find(
    (registration, index) => registrations.findIndex(({ id }) => id === registration.id) !== index
  );
  if (duplicate) throw new AstroDesignAdapterError(`Duplicate Astro component registration: ${duplicate.id}`);

  if (registrations.length > ASTRO_RENDER_LIMITS.registrations || registrations.some((registration) => !/^[a-z0-9-]{1,64}$/.test(registration.id) || byteLength(registration.module) < 1 || byteLength(registration.module) > 512 || (registration.exportName !== undefined && !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(registration.exportName)) || (registration.source !== undefined && (byteLength(registration.source) < 1 || byteLength(registration.source) > ASTRO_RENDER_LIMITS.sourceBytes)))) throw new AstroDesignAdapterError("Astro registration bounds invalid");
  const legacyComponentIds = registrations.filter((registration) => registration.source === undefined).map((registration) => registration.id);
  const components = new Map(registrations.map((registration) => [registration.id, Object.freeze({ ...registration, source: registration.source ?? `<section data-navocms-legacy-registration=${JSON.stringify(registration.module)}><slot /></section>` })]));
  for (const id of design.components.keys()) {
    if (!components.has(id)) throw new AstroDesignAdapterError(`Missing Astro component registration: ${id}`);
  }
  for (const id of components.keys()) {
    if (!design.components.has(id)) throw new AstroDesignAdapterError(`Unknown Astro component registration: ${id}`);
  }

  return {
    digest: design.digest,
    css: design.css,
    components,
    recipes: [...design.recipes.values()].map((recipe) => ({
      id: recipe.id,
      slots: recipe.slots.map((slot) => ({
        id: slot.id,
        componentModule: components.get(slot.component)?.module ?? ""
      }))
    })), legacyComponentIds: Object.freeze(legacyComponentIds.sort())
  };
}

export interface AstroRenderRoute {
  readonly id: string;
  readonly path: string;
  readonly locale: string;
  readonly revisionId: string;
  readonly componentId: string;
  readonly title: string;
  readonly source: string;
  readonly sourceHash: string;
  /** Content-type-declared directives permitted for this immutable revision. */
  readonly directives?: readonly DirectiveDefinition[];
  readonly media: readonly { readonly assetId: string; readonly variantIdentity: string; readonly url: string; readonly alt: string }[];
}

export interface AstroRenderInput {
  readonly tenantId: string;
  readonly siteId: string;
  readonly locales: Readonly<{ default: string; supported: readonly string[] }>;
  readonly anchors: Readonly<{ content: string; design: string; delivery: string; governance: string }>;
  /** A reviewed, versioned shared layout source; its digest is the delivery anchor. */
  readonly deliveryLayout: Readonly<{ schema: "io.navocms.delivery-layout.v1"; source: string; digest: string }>;
  /** Immutable digest of all media bindings expected by the caller. */
  readonly expectedMediaDigest: string;
  readonly design: AstroDesignAdapter;
  readonly routes: readonly AstroRenderRoute[];
}

export interface AstroArtifactManifest {
  readonly schema: "io.navocms.astro-artifact.v1";
  readonly format: "navocms-astro-source-bundle/v1";
  readonly tenantId: string;
  readonly siteId: string;
  readonly digests: Readonly<{ content: string; design: string; delivery: string; governance: string; registrations: string; media: string }>;
  readonly files: readonly Readonly<{ path: string; sha256: string }> [];
}

export interface AstroArtifact {
  readonly format: "navocms-astro-source-bundle/v1";
  readonly files: Readonly<Record<string, string>>;
  readonly manifest: AstroArtifactManifest;
  readonly hash: string;
}

/** Emits a complete, static Astro project; compilation/deployment stay external capabilities. */
export function renderAstroArtifact(input: AstroRenderInput): AstroArtifact {
  assertInput(input);
  if (input.design.legacyComponentIds.length > 0) throw new AstroDesignAdapterError("Astro artifact v1 requires explicit registration source");
  const content = astroContentDigest(input.routes);
  const media = astroMediaDigest(input.routes);
  const registrations = astroRegistrationDigest(input.design.components.values());
  if (input.anchors.content !== content || input.anchors.design !== input.design.digest || input.anchors.delivery !== input.deliveryLayout.digest || input.expectedMediaDigest !== media) throw new AstroDesignAdapterError("Renderer input digest drift");
  const files: Record<string, string> = {
    "package.json": canonical({ private: true, type: "module", packageManager: "pnpm@10.24.0", scripts: { build: "astro build", check: "astro check" }, dependencies: { astro: "7.2.4" }, devDependencies: { "@astrojs/check": "0.9.10", typescript: "5.9.3" } }),
    "astro.config.mjs": "import { defineConfig } from 'astro/config';\nexport default defineConfig({ output: 'static', build: { format: 'directory' }, vite: { cacheDir: '.navocms-cache' } });\n",
    "src/styles/navocms.css": input.design.css,
    "src/layouts/SiteLayout.astro": input.deliveryLayout.source
  };
  for (const registration of [...input.design.components.values()].sort((left, right) => left.id.localeCompare(right.id))) files[`src/components/${registration.id}.astro`] = registration.source ?? "";
  for (const route of [...input.routes].sort((left, right) => left.path.localeCompare(right.path))) {
    files[`src/pages${pagePath(route.path)}.astro`] = page(route, input.design.components.get(route.componentId)!, renderSemanticMarkdownHtml(route.source, route.directives));
  }
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([path, body]) => Object.freeze({ path, sha256: digest(body).slice(7) }));
  const manifest = Object.freeze({ schema: "io.navocms.astro-artifact.v1" as const, format: "navocms-astro-source-bundle/v1" as const, tenantId: input.tenantId, siteId: input.siteId, digests: Object.freeze({ content, design: input.design.digest, delivery: input.anchors.delivery, governance: input.anchors.governance, registrations, media }), files: Object.freeze(entries) });
  const complete = Object.freeze({ ...files, "navocms-artifact-manifest.json": canonical(manifest) });
  if (Object.keys(complete).length > ASTRO_RENDER_LIMITS.files || Object.values(complete).reduce((total, body) => total + byteLength(body), 0) > ASTRO_RENDER_LIMITS.bundleBytes) throw new AstroDesignAdapterError("Astro artifact bundle exceeds bound");
  return Object.freeze({ format: "navocms-astro-source-bundle/v1", files: Object.freeze(complete), manifest, hash: digest(canonical({ manifest, files: complete })) });
}

export function verifyAstroArtifact(artifact: AstroArtifact, expectedHash: string): void {
  if (!artifact || typeof artifact !== "object" || !/^sha256:[a-f0-9]{64}$/.test(expectedHash) || artifact.hash !== expectedHash) throw new AstroDesignAdapterError("Astro artifact expected hash mismatch");
  if (!hasExactKeys(artifact, ["format", "files", "manifest", "hash"]) || artifact.format !== "navocms-astro-source-bundle/v1" || !artifact.manifest || !hasExactKeys(artifact.manifest, ["schema", "format", "tenantId", "siteId", "digests", "files"]) || artifact.manifest.schema !== "io.navocms.astro-artifact.v1" || artifact.manifest.format !== artifact.format || !safeIdentifier(artifact.manifest.tenantId, 128) || !safeIdentifier(artifact.manifest.siteId, 128) || !artifact.manifest.digests || typeof artifact.manifest.digests !== "object" || !validManifestDigests(artifact.manifest.digests) || !Array.isArray(artifact.manifest.files) || artifact.manifest.files.length < 1 || artifact.manifest.files.length > ASTRO_RENDER_LIMITS.files - 1 || !artifact.files || typeof artifact.files !== "object" || Array.isArray(artifact.files)) throw new AstroDesignAdapterError("Astro artifact schema invalid");
  const manifestPaths = new Set<string>();
  for (const entry of artifact.manifest.files) {
    if (!entry || typeof entry !== "object" || !hasExactKeys(entry, ["path", "sha256"]) || !safeArtifactPath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || manifestPaths.has(entry.path)) throw new AstroDesignAdapterError("Astro artifact manifest path invalid");
    manifestPaths.add(entry.path);
    if (digest(artifact.files[entry.path] ?? "").slice(7) !== entry.sha256) throw new AstroDesignAdapterError(`Astro artifact tampered: ${entry.path}`);
  }
  const files = Object.keys(artifact.files);
  if (!Object.prototype.hasOwnProperty.call(artifact.files, "navocms-artifact-manifest.json") || files.length !== manifestPaths.size + 1 || files.some((path) => path !== "navocms-artifact-manifest.json" && !manifestPaths.has(path))) throw new AstroDesignAdapterError("Astro artifact file coverage invalid");
  if (files.some((path) => !safeArtifactPath(path)) || Object.values(artifact.files).some((body) => typeof body !== "string") || Object.values(artifact.files).reduce((total, body) => total + byteLength(body), 0) > ASTRO_RENDER_LIMITS.bundleBytes) throw new AstroDesignAdapterError("Astro artifact bounds invalid");
  if (artifact.files["navocms-artifact-manifest.json"] !== canonical(artifact.manifest) || artifact.hash !== digest(canonical({ manifest: artifact.manifest, files: artifact.files }))) throw new AstroDesignAdapterError("Astro artifact manifest tampered");
}

/** Computes the immutable release binding; consumers must store it outside the artifact. */
export function astroArtifactHash(artifact: Pick<AstroArtifact, "manifest" | "files">): `sha256:${string}` {
  return digest(canonical({ manifest: artifact.manifest, files: artifact.files }));
}

/** Validates the complete built output against the immutable artifact route set before use. */
export function verifyBuiltAstroOutput(output: Readonly<Record<string, string>>, artifact: AstroArtifact, expectedArtifactHash: string): void {
  verifyAstroArtifact(artifact, expectedArtifactHash);
  const entries = Object.entries(output);
  const pages = entries.filter(([path]) => safeBuiltOutputPath(path));
  if (entries.length < 1 || entries.length > ASTRO_BUILT_OUTPUT_LIMITS.files || entries.some(([path, body]) => !safeArtifactPath(path) || typeof body !== "string") || entries.reduce((total, [, body]) => total + byteLength(body), 0) > ASTRO_BUILT_OUTPUT_LIMITS.bytes || pages.length < 1) throw new AstroDesignAdapterError("Built Astro output invalid");
  const expectedRoutes = new Set(artifact.manifest.files.filter((entry) => (entry.path.startsWith("src/pages/") && entry.path.endsWith("/index.astro")) || entry.path === "src/pages/index.astro").map((entry) => builtRoutePath(entry.path)));
  const actualRoutes = new Set(pages.map(([path]) => path));
  if (expectedRoutes.size < 1 || actualRoutes.size !== expectedRoutes.size || [...expectedRoutes].some((path) => !actualRoutes.has(path))) throw new AstroDesignAdapterError("Built Astro route parity invalid");
  for (const [, html] of pages) verifyDeliveryLayoutHtml(html);
}

/** Validates actual built HTML elements with parse5, never text, comments, templates, or raw-text contents. */
function verifyDeliveryLayoutHtml(html: string): void {
  if (typeof html !== "string") throw new AstroDesignAdapterError("Built delivery layout contract invalid");
  const errors: ParserError[] = [];
  const document = parse(html, { onParseError: (error) => errors.push(error) });
  if (errors.some((error) => error.code === "duplicate-attribute")) throw new AstroDesignAdapterError("Built delivery layout duplicate attribute");
  let zaraz = false; let consent = false; let analytics = false;
  const visit = (node: DefaultTreeAdapterTypes.Node, inert = false): void => {
    if (node.nodeName === "#document" || node.nodeName === "#document-fragment") {
      for (const child of node.childNodes) visit(child, inert);
      return;
    }
    if (!("tagName" in node)) return;
    const element = node as DefaultTreeAdapterTypes.Element | DefaultTreeAdapterTypes.Template;
    const insideTemplate = inert || element.tagName === "template";
    if (!insideTemplate && element.tagName === "script" && attribute(element, "src") === "/cdn-cgi/zaraz/i.js" && attribute(element, "data-navocms-zaraz-loader") === "v1" && executableJavaScriptType(attribute(element, "type"))) zaraz = true;
    if (!insideTemplate && element.tagName === "meta" && attribute(element, "data-navocms-consent-bridge") === "io.navocms.consent-bridge.v1") consent = true;
    if (!insideTemplate && element.tagName === "meta" && attribute(element, "data-navocms-analytics-bootstrap") === "io.navocms.analytics-bootstrap.v1") analytics = true;
    for (const child of element.childNodes) visit(child, insideTemplate);
    if (element.tagName === "template") for (const child of (element as DefaultTreeAdapterTypes.Template).content.childNodes) visit(child, true);
  };
  visit(document);
  if (!zaraz || !consent || !analytics) throw new AstroDesignAdapterError("Built delivery layout contract invalid");
}

/** Materializes only a verified immutable bundle; callers may then run pinned Astro offline. */
export async function materializeAstroArtifact(directory: string, artifact: AstroArtifact, expectedHash: string): Promise<void> {
  verifyAstroArtifact(artifact, expectedHash);
  await assertCleanMaterializationDirectory(directory);
  for (const [path, body] of Object.entries(artifact.files)) {
    const target = resolve(directory, path);
    if (!target.startsWith(`${resolve(directory)}/`)) throw new AstroDesignAdapterError("Astro artifact path escapes target");
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, body, "utf8");
  }
}

export function astroContentDigest(routes: readonly AstroRenderRoute[]): `sha256:${string}` { return digest([...routes].map((route) => ({ id: route.id, revisionId: route.revisionId, sourceHash: route.sourceHash, title: route.title, componentId: route.componentId, locale: route.locale, path: route.path, directives: normalizedDirectives(route.directives), media: sortedMedia(route.media) })).sort(routeOrder)); }
export function astroMediaDigest(routes: readonly AstroRenderRoute[]): `sha256:${string}` { return digest(routes.flatMap((route) => route.media.map((item) => ({ ...item, route: route.id, locale: route.locale, path: route.path }))).sort(mediaOrder)); }
export function astroRegistrationDigest(registrations: Iterable<AstroComponentRegistration>): `sha256:${string}` { return digest([...registrations].map(({ id, module, source, exportName }) => ({ id, module, source, exportName })).sort((left, right) => left.id.localeCompare(right.id))); }

function assertInput(input: AstroRenderInput): void {
  const digestPattern = /^sha256:[a-f0-9]{64}$/;
  if (input.routes.length < 1 || input.routes.length > ASTRO_RENDER_LIMITS.routes || input.locales.supported.length < 1 || input.locales.supported.length > ASTRO_RENDER_LIMITS.locales || !/^[A-Za-z0-9_-]{1,128}$/.test(input.tenantId) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.siteId) || !digestPattern.test(input.anchors.content) || !digestPattern.test(input.anchors.design) || !digestPattern.test(input.anchors.delivery) || !digestPattern.test(input.anchors.governance) || !digestPattern.test(input.expectedMediaDigest) || input.locales.supported.some((locale) => !/^[a-z0-9-]{1,32}$/.test(locale)) || new Set(input.locales.supported).size !== input.locales.supported.length || !input.locales.supported.includes(input.locales.default)) throw new AstroDesignAdapterError("Renderer locale or anchor input invalid");
  const layout = input.deliveryLayout;
  if (layout.schema !== "io.navocms.delivery-layout.v1" || byteLength(layout.source) < 1 || byteLength(layout.source) > ASTRO_RENDER_LIMITS.layoutBytes || layout.digest !== digest(layout.source)) throw new AstroDesignAdapterError("Renderer delivery layout invalid");
  const paths = new Set<string>(); const localized = new Map<string, Set<string>>();
  for (const route of input.routes) {
    const outputPath = `src/pages${pagePath(route.path)}.astro`;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(route.id) || !/^[A-Za-z0-9_-]{1,128}$/.test(route.revisionId) || byteLength(route.path) > 512 || byteLength(route.title) < 1 || byteLength(route.title) > ASTRO_RENDER_LIMITS.titleBytes || byteLength(route.source) > ASTRO_RENDER_LIMITS.sourceBytes || route.media.length > ASTRO_RENDER_LIMITS.mediaPerRoute || !/^\/[a-z0-9/_-]*$/.test(route.path) || route.path.includes("//") || paths.has(outputPath) || !input.locales.supported.includes(route.locale) || !input.design.components.has(route.componentId) || route.sourceHash !== contentHash(route.source)) throw new AstroDesignAdapterError("Renderer route input invalid");
    paths.add(outputPath); const seen = localized.get(route.id) ?? new Set<string>(); seen.add(route.locale); localized.set(route.id, seen);
    for (const item of route.media) if (!/^[A-Za-z0-9_-]{1,128}$/.test(item.assetId) || byteLength(item.alt) < 1 || byteLength(item.alt) > ASTRO_RENDER_LIMITS.altBytes || !/^[a-f0-9]{64}$/.test(item.variantIdentity) || byteLength(item.url) > 2048 || !item.url.startsWith("/") || item.url.startsWith("//") || !item.alt) throw new AstroDesignAdapterError("Renderer media input invalid");
    if (!validDirectives(route.directives)) throw new AstroDesignAdapterError("Renderer directive input invalid");
    try { renderSemanticMarkdownHtml(route.source, route.directives); } catch (error) { throw new AstroDesignAdapterError(`Renderer content unsupported: ${error instanceof Error ? error.message : "invalid markdown"}`); }
  }
  for (const locales of localized.values()) if (locales.size !== input.locales.supported.length || input.locales.supported.some((locale) => !locales.has(locale))) throw new AstroDesignAdapterError("Renderer locale missing");
}
function pagePath(path: string): string { return path === "/" ? "/index" : `${path.replace(/\/$/, "")}/index`; }
function builtRoutePath(pagePath: string): string { return pagePath === "src/pages/index.astro" ? "index.html" : `${pagePath.slice("src/pages/".length, -".astro".length)}.html`; }
function page(route: AstroRenderRoute, registration: AstroComponentRegistration, html: string): string { const depth = route.path.split("/").filter(Boolean).length; return `---\nimport SiteLayout from '../${"../".repeat(depth)}layouts/SiteLayout.astro';\nimport RouteComponent from '../${"../".repeat(depth)}components/${registration.id}.astro';\nconst title = ${JSON.stringify(route.title)};\nconst contentHtml = ${JSON.stringify(html)};\nconst media = ${JSON.stringify(route.media)};\n---\n<SiteLayout title={title} locale=${JSON.stringify(route.locale)}><RouteComponent><main data-navocms-revision=${JSON.stringify(route.revisionId)} data-navocms-component=${JSON.stringify(registration.id)}><Fragment set:html={contentHtml} />{media.map((item) => <img src={item.url} alt={item.alt} data-navocms-variant={item.variantIdentity} />)}</main></RouteComponent></SiteLayout>\n`; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`; return JSON.stringify(value); }
function digest(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex")}`; }
function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }
function safeIdentifier(value: unknown, limit: number): value is string { return typeof value === "string" && new RegExp(`^[A-Za-z0-9_-]{1,${limit}}$`).test(value); }
function safeArtifactPath(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.endsWith("/") && !value.includes("//") && !value.includes("\\") && posix.normalize(value) === value && !value.split("/").some((part) => part === "." || part === ".."); }
function hasExactKeys(value: unknown, expected: readonly string[]): boolean { return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).sort().join(",") === [...expected].sort().join(","); }
function validManifestDigests(value: AstroArtifactManifest["digests"]): boolean { return hasExactKeys(value, ["content", "design", "delivery", "governance", "registrations", "media"]) && Object.values(value).every((digestValue) => /^sha256:[a-f0-9]{64}$/.test(digestValue)); }
function sortedMedia(media: AstroRenderRoute["media"]): AstroRenderRoute["media"][number][] { return [...media].sort(mediaOrder); }
function routeOrder(left: unknown, right: unknown): number { return canonical(left).localeCompare(canonical(right)); }
function mediaOrder(left: unknown, right: unknown): number { return canonical(left).localeCompare(canonical(right)); }
function normalizedDirectives(directives: readonly DirectiveDefinition[] | undefined): readonly { readonly name: string; readonly kind: string; readonly allowedAttributes: readonly string[]; readonly requiredAttributes: readonly string[] }[] { return [...(directives ?? [])].map(({ name, kind, allowedAttributes, requiredAttributes }) => ({ name, kind, allowedAttributes: [...(allowedAttributes ?? [])].sort(), requiredAttributes: [...(requiredAttributes ?? [])].sort() })).sort((left, right) => left.name.localeCompare(right.name)); }
function validDirectives(directives: readonly DirectiveDefinition[] | undefined): boolean { if (!directives) return true; if (directives.length > ASTRO_RENDER_LIMITS.directives || new Set(directives.map((directive) => directive.name)).size !== directives.length) return false; return directives.every((directive) => { const allowed = directive.allowedAttributes ?? []; const required = directive.requiredAttributes ?? []; return /^[a-z][a-z0-9-]{0,63}$/.test(directive.name) && ["containerDirective", "leafDirective", "textDirective"].includes(directive.kind) && allowed.length <= ASTRO_RENDER_LIMITS.directiveAttributes && required.length <= ASTRO_RENDER_LIMITS.directiveAttributes && new Set(allowed).size === allowed.length && new Set(required).size === required.length && [...allowed, ...required].every((attribute) => /^[a-z][a-z0-9-]{0,63}$/.test(attribute)) && required.every((attribute) => allowed.includes(attribute)); }); }
function safeBuiltOutputPath(value: string): boolean { return safeArtifactPath(value) && value.endsWith(".html"); }
function attribute(element: DefaultTreeAdapterTypes.Element | DefaultTreeAdapterTypes.Template, name: string): string | undefined { return element.attrs.find((attribute) => attribute.name === name)?.value; }
function executableJavaScriptType(type: string | undefined): boolean { return type === undefined || type === "text/javascript" || type === "application/javascript"; }
async function assertCleanMaterializationDirectory(directory: string): Promise<void> { try { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(directory)).length > 0) throw new AstroDesignAdapterError("Astro artifact target must be an empty non-symlink directory"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") await mkdir(directory, { recursive: true }); else throw error; } }
