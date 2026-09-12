import { expect, test } from "@playwright/test";
import { InMemoryEventStore, type ReleaseProvider, type ReleaseProviderPublication, type ReleaseProviderPublishInput } from "@navocms/kernel";
import { NAVOCMS_PERMISSIONS, siteRoleAuthority } from "@navocms/security";
import type { AstroRenderInput } from "@navocms/design-astro";

import { InMemoryEditingRepository } from "../dist/repository.js";
import { InMemoryReleaseWorkflowRepository } from "../dist/release-repository.js";
import { outputManifestDigest } from "../dist/output-manifest.js";
import { McpEditingService, type StagingAstroOperations } from "../dist/service.js";
import { createMcpHttpServer } from "../dist/http.js";
import type { PreviewBuildStatus } from "../dist/model.js";

const site = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  name: "Preview render site",
  primaryLocale: "en",
  locales: ["en"]
});

const humanToken = "preview-render-human-session-000001";

test("the built preview renders its own CSS and images and blocks scripts", async ({ page }) => {
  const harness = await renderHarness();
  const preview = await prepare(harness, "render-check", "render-check-01");
  const server = harness.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  const base = `http://127.0.0.1:${address.port}`;
  const cspViolations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("violates") || message.text().includes("Content-Security-Policy")) {
      cspViolations.push(message.text());
    }
  });
  try {
    const response = await page.goto(`${base}/previews/${preview.previewUrl.split("/previews/")[1]!}`);
    expect(response?.headers()["content-security-policy"]).toContain("style-src 'self'");
    expect(response?.headers()["content-security-policy"]).toContain("img-src 'self' data:");
    // The real design renders: the stylesheet applies and the image loads.
    const appearance = await page.locator("h1").evaluate((element) => getComputedStyle(element).color);
    expect(appearance).toBe("rgb(12, 34, 56)");
    const imageWidth = await page.locator("img").evaluate((element) => (element as HTMLImageElement).naturalWidth);
    expect(imageWidth).toBe(10);
    // The page's own inline script never runs: CSP blocks it and Chromium
    // reports exactly that violation — the only console CSP message.
    const scriptRan = await page.evaluate(() => (window as unknown as { navocmsScriptRan?: boolean }).navocmsScriptRan === true);
    expect(scriptRan).toBe(false);
    expect(cspViolations).toHaveLength(1);
    expect(cspViolations[0]).toContain("inline script");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("two previews open in one browser never borrow each other's assets", async ({ browser }) => {
  const harness = await renderHarness();
  const alpha = await prepare(harness, "alpha-variant", "alpha-02", "rgb(1, 2, 3)");
  const beta = await prepare(harness, "beta-variant", "beta-02", "rgb(4, 5, 6)");
  const server = harness.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    // Same browser profile: the shared cookie ends up pointing at the beta
    // preview, yet each tab renders its own immutable assets.
    const alphaPage = await browser.newPage();
    const betaPage = await browser.newPage();
    await alphaPage.goto(`${base}/previews/${alpha.previewUrl.split("/previews/")[1]!}`);
    await betaPage.goto(`${base}/previews/${beta.previewUrl.split("/previews/")[1]!}`);
    const alphaColor = await alphaPage.locator("h1").evaluate((element) => getComputedStyle(element).color);
    const betaColor = await betaPage.locator("h1").evaluate((element) => getComputedStyle(element).color);
    expect(alphaColor).toBe("rgb(1, 2, 3)");
    expect(betaColor).toBe("rgb(4, 5, 6)");
    await alphaPage.close();
    await betaPage.close();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

interface RenderHarness {
  readonly server: ReturnType<typeof createMcpHttpServer>;
  readonly service: McpEditingService;
  readonly operations: RenderOperations;
  readonly context: { authorization: Awaited<ReturnType<typeof buildContext>>["authorization"] };
}

async function renderHarness(): Promise<RenderHarness> {
  const provider: ReleaseProvider = {
    key: "test.preview-render.v1",
    async publish(input: ReleaseProviderPublishInput): Promise<ReleaseProviderPublication> {
      return { providerKey: "test.preview-render.v1", providerReference: `test:${input.releaseHash}`, artifactHash: input.artifact.hash };
    },
    async verify(): Promise<boolean> { return true; },
    async rollback(): Promise<void> {}
  };
  const operations = new RenderOperations();
  const repository = new InMemoryEditingRepository();
  repository.registerSite(site);
  const service = new McpEditingService(
    repository, new InMemoryEventStore(), undefined,
    new InMemoryReleaseWorkflowRepository(), provider, {}, undefined, undefined, operations
  );
  const context = await buildContext();
  const server = createMcpHttpServer({
    service,
    verifier: {
      verify: async (token: string) => {
        if (token !== humanToken) throw new Error("unknown token");
        return {
          claims: { iss: "https://identity.example", sub: "publisher", aud: "https://cms.example.test/mcp", exp: Math.floor(Date.now() / 1000) + 3600 },
          scopes: [...NAVOCMS_PERMISSIONS],
          tenantId: site.tenantId,
          siteId: site.siteId,
          principal: { id: "principal-render", kind: "human", issuer: "https://identity.example", subject: "publisher" }
        };
      }
    },
    resource: "https://cms.example.test/mcp",
    authorizationServers: ["https://identity.example.test"]
  });
  return { server, service, operations, context };
}

async function buildContext() {
  return {
    authorization: {
      tenantId: site.tenantId,
      siteId: site.siteId,
      principal: { id: "user-publisher", kind: "human" as const, issuer: "https://identity.example", subject: "publisher" },
      layers: [
        { name: "principal" as const, permissions: NAVOCMS_PERMISSIONS },
        siteRoleAuthority("publisher"),
        { name: "operation" as const, permissions: NAVOCMS_PERMISSIONS }
      ]
    }
  };
}

async function prepare(harness: RenderHarness, slug: string, key: string, color = "rgb(12, 34, 56)") {
  harness.operations.setCss(slug, `h1 { color: ${color}; }\n`);
  const created = await harness.service.createDraft(harness.context, {
    typeName: "article", slug, locale: "en", title: `Render ${slug}`,
    markdown: `# Render ${slug}\n`, idempotencyKey: `draft-${key}-render`
  }) as { draft: { revisionId: string } };
  return await harness.service.preparePreview(harness.context, created.draft.revisionId, `preview-${key}-render`) as {
    previewUrl: string; confirmationUrl: string; releaseId: string; releaseHash: string;
  };
}

class RenderOperations implements StagingAstroOperations {
  public startCount = 0;
  readonly #outputs = new Map<string, Readonly<Record<string, string>>>();
  readonly #css = new Map<string, string>();
  public setCss(slug: string, css: string): void { this.#css.set(slug, css); }
  public appendOutput(releaseId: string, extra: Readonly<Record<string, string>>): void {
    const base = this.#outputs.get(releaseId) ?? {};
    this.#outputs.set(releaseId, Object.freeze({ ...base, ...extra }));
  }
  public async prepare(): Promise<AstroRenderInput> {
    return { anchors: { content: `sha256:${"a".repeat(64)}`, design: `sha256:${"b".repeat(64)}`, delivery: `sha256:${"c".repeat(64)}`, governance: `sha256:${"d".repeat(64)}` } } as AstroRenderInput;
  }
  public async persistPreviewInput(): Promise<void> {}
  public async startBuild(_: unknown, release: { id: string }): Promise<PreviewBuildStatus> {
    this.startCount += 1;
    const css = [...this.#css.values()].at(-1) ?? "h1 { color: rgb(12, 34, 56); }\n";
    this.#outputs.set(release.id, Object.freeze({
      "index.html": "<!doctype html><html lang=\"en\"><head><link rel=\"stylesheet\" href=\"/_astro/styles.css\">" +
        "<script>window.navocmsScriptRan = true;</script></head>" +
        "<body><h1>built-index</h1><img src=\"/render.svg\" alt=\"test\"></body></html>",
      "_astro/styles.css": css,
      "render.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><rect width=\"10\" height=\"10\" fill=\"red\"/></svg>"
    }));
    return { releaseId: release.id, status: "ready" };
  }
  public async buildStatus(_: unknown, releaseId: string): Promise<PreviewBuildStatus> {
    return { releaseId, status: this.#outputs.has(releaseId) ? "ready" : "building" };
  }
  public async artifactSummary(_: unknown, releaseId: string) {
    const output = this.#outputs.get(releaseId);
    return output ? { outputManifestDigest: outputManifestDigest(output), fileCount: 3, totalBytes: 128, sourceCommitSha: "a".repeat(40) } : undefined;
  }
  public async artifactFor(scope: { releaseId: string }) {
    const output = this.#outputs.get(scope.releaseId);
    return output ? Object.freeze({ output, outputManifestDigest: outputManifestDigest(output), fileCount: 3, totalBytes: 128, sourceCommitSha: "a".repeat(40) }) : undefined;
  }
}
