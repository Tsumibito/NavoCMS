import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { InMemoryEventStore } from "@navocms/kernel";
import { NAVOCMS_PERMISSIONS, siteRoleAuthority } from "@navocms/security";
import type { AstroRenderInput } from "@navocms/design-astro";
import type { ReleaseProvider, ReleaseProviderPublication, ReleaseProviderPublishInput } from "@navocms/kernel";

import { InMemoryEditingRepository } from "../dist/repository.js";
import { InMemoryReleaseWorkflowRepository } from "../dist/release-repository.js";
import { outputManifestDigest } from "../dist/output-manifest.js";
import { McpEditingService, type StagingAstroOperations } from "../dist/service.js";
import { createMcpHttpServer } from "../dist/http.js";
import type { PreviewBuildStatus } from "../dist/model.js";

const site = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  name: "Confirmation proving site",
  primaryLocale: "en",
  locales: ["en"]
});

test("confirmation page is accessible, noindex, and records the human decision once", async ({ page }) => {
  const provider = new SilentProvider();
  const operations = new BuiltOperations();
  const repository = new InMemoryEditingRepository();
  repository.registerSite(site);
  const service = new McpEditingService(
    repository, new InMemoryEventStore(), undefined,
    new InMemoryReleaseWorkflowRepository(), provider, {}, undefined, undefined, operations
  );
  const context = {
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
  const created = await service.createDraft(context, {
    typeName: "article", slug: "browser-confirmation", locale: "en", title: "Browser confirmation",
    markdown: "# Browser confirmation\n", idempotencyKey: "draft-browser-confirmation-1"
  }) as { draft: { revisionId: string } };
  const preview = await service.preparePreview(context, created.draft.revisionId, "preview-browser-confirmation-1") as {
    releaseId: string; releaseHash: string; confirmationUrl: string;
  };
  const token = preview.confirmationUrl.split("/confirmations/")[1]!;
  const server = createMcpHttpServer({
    service,
    verifier: { verify: async () => { throw new Error("not called"); } },
    resource: "https://cms.example.test/mcp",
    authorizationServers: ["https://identity.example.test"]
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await page.setViewportSize({ width: 840, height: 720 });
    await page.goto(`${base}/confirmations/${token}`);
    await expect(page.getByRole("heading", { name: "Confirm publication of this exact build" })).toBeVisible();
    await expect(page.getByText("Output manifest digest")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm this build" })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);

    await page.getByRole("button", { name: "Confirm this build" }).click();
    await expect(page.getByRole("heading", { name: "Decision recorded" })).toBeVisible();
    expect(await page.textContent("main")).toContain("Publication is a separate step");

    // Re-delivery of the same decision renders the safe no-op view.
    await page.goto(`${base}/confirmations/${token}`);
    await expect(page.getByRole("heading", { name: "Decision already recorded" })).toBeVisible();

    const status = await service.releaseConfirmationStatus(context, {
      releaseId: preview.releaseId, releaseHash: preview.releaseHash
    });
    expect(status).toMatchObject({ status: "confirmed" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

// The playwright run always follows a full build; dist carries the same
// interfaces as src. These helpers mirror the in-memory test fakes.
class SilentProvider implements ReleaseProvider {
  public readonly key = "test.browser-confirmation.v1";
  public async publish(input: ReleaseProviderPublishInput): Promise<ReleaseProviderPublication> {
    return { providerKey: this.key, providerReference: `test:${input.releaseHash}`, artifactHash: input.artifact.hash };
  }
  public async verify(): Promise<boolean> { return true; }
  public async rollback(): Promise<void> {}
}

class BuiltOperations implements StagingAstroOperations {
  public startCount = 0;
  readonly #outputs = new Map<string, Readonly<Record<string, string>>>();
  public async prepare(): Promise<AstroRenderInput> {
    return { anchors: { content: `sha256:${"a".repeat(64)}`, design: `sha256:${"b".repeat(64)}`, delivery: `sha256:${"c".repeat(64)}`, governance: `sha256:${"d".repeat(64)}` } } as AstroRenderInput;
  }
  public async persistPreviewInput(): Promise<void> {}
  public async startBuild(_: unknown, release: { id: string }): Promise<PreviewBuildStatus> {
    this.startCount += 1;
    this.#outputs.set(release.id, Object.freeze({
      "index.html": "<!doctype html><html lang=\"en\"><body><h1>built</h1></body></html>",
      "_astro/styles.css": "body { margin: 0; }\n"
    }));
    return { releaseId: release.id, status: "ready" };
  }
  public async buildStatus(_: unknown, releaseId: string): Promise<PreviewBuildStatus> {
    return { releaseId, status: this.#outputs.has(releaseId) ? "ready" : "building" };
  }
  public async artifactSummary(_: unknown, releaseId: string) {
    const output = this.#outputs.get(releaseId);
    return output ? { outputManifestDigest: outputManifestDigest(output), fileCount: 2, totalBytes: 64, sourceCommitSha: "a".repeat(40) } : undefined;
  }
  public async artifactFor(scope: { releaseId: string }) {
    const output = this.#outputs.get(scope.releaseId);
    return output ? Object.freeze({ output, outputManifestDigest: outputManifestDigest(output), fileCount: 2, totalBytes: 64, sourceCommitSha: "a".repeat(40) }) : undefined;
  }
}

