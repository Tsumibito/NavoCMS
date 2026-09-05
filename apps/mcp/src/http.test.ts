import type { ReleaseProvider, ReleaseProviderPublication, ReleaseProviderPublishInput } from "@navocms/kernel";
import { InMemoryEventStore } from "@navocms/kernel";
import { NAVOCMS_PERMISSIONS, siteRoleAuthority } from "@navocms/security";
import type { AstroRenderInput } from "@navocms/design-astro";
import { describe, expect, it } from "vitest";
import { createMcpHttpServer } from "./http.js";
import { InMemoryReleaseWorkflowRepository } from "./release-repository.js";
import { InMemoryEditingRepository } from "./repository.js";
import { outputManifestDigest } from "./output-manifest.js";
import { McpEditingService, type StagingAstroOperations } from "./service.js";
import type { PreviewBuildStatus } from "./model.js";

describe("MCP OAuth metadata", () => {
  it("advertises only the scopes enabled for a deployment", async () => {
    const enabledScopes = ["openid"] as const;
    const server = createMcpHttpServer({
      service: {} as McpEditingService,
      verifier: { verify: async () => { throw new Error("not called"); } },
      resource: "https://cms.example.test/mcp",
      authorizationServers: ["https://identity.example.test"],
      scopes: enabledScopes
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/.well-known/oauth-protected-resource/mcp`);
      await expect(response.json()).resolves.toMatchObject({ scopes_supported: enabledScopes });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("real preview and independent confirmation surfaces", () => {
  it("serves the built output, relays absolute assets by cookie, and records the human decision", async () => {
    const harness = previewHarness();
    const created = await harness.service.createDraft(harness.context, {
      typeName: "article", slug: "real-preview", locale: "en", title: "Real preview",
      markdown: "# Real preview\n", idempotencyKey: "draft-real-preview-http-01"
    }) as { draft: { revisionId: string } };
    const preview = await harness.service.preparePreview(harness.context, created.draft.revisionId, "preview-real-preview-http-1") as {
      releaseId: string; releaseHash: string; previewUrl: string; confirmationUrl: string;
    };
    await new Promise<void>((resolve) => harness.server.listen(0, "127.0.0.1", resolve));
    const address = harness.server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const base = `http://127.0.0.1:${address.port}`;
    const previewToken = preview.previewUrl.split("/previews/")[1]!;
    const confirmationToken = preview.confirmationUrl.split("/confirmations/")[1]!;
    try {
      // The built page replaces the proof artifact; a capability cookie is set.
      const page = await fetch(`${base}/previews/${previewToken}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("x-robots-tag")).toContain("noindex");
      expect(page.headers.get("content-security-policy")).toContain("form-action 'none'");
      const setCookie = page.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("navocms_preview_token=");
      const pageBody = await page.text();
      expect(pageBody).toContain("<h1>built-index</h1>");
      expect(pageBody).not.toContain("NavoCMS rejected");

      // Absolute asset URLs resolve through the capability cookie only.
      const cookie = setCookie.split(";")[0]!;
      const asset = await fetch(`${base}/_astro/styles.css`, { headers: { cookie } });
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/css");
      expect(await asset.text()).toContain("margin: 0");
      const withoutCookie = await fetch(`${base}/_astro/styles.css`);
      expect(withoutCookie.status).toBe(404);
      const traversal = await fetch(`${base}/_astro/..%2F..%2Fescape.css`, { headers: { cookie } });
      expect(traversal.status).toBe(404);

      // The confirmation page shows the digest and requires its own session.
      const confirmation = await fetch(`${base}/confirmations/${confirmationToken}`);
      expect(confirmation.status).toBe(200);
      const confirmationHtml = await confirmation.text();
      expect(confirmationHtml).toContain("Confirm this build");
      expect(confirmationHtml).toContain("Output manifest digest");
      const csrfCookie = (confirmation.headers.get("set-cookie") ?? "").split(";")[0]!;
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(confirmationHtml)?.[1];
      expect(csrf).toBeDefined();

      // Before the human acts, the MCP human bearer cannot approve the build.
      await expect(harness.service.approveRelease(harness.context, {
        releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "approve-http-flow-0000"
      })).rejects.toMatchObject({ code: "HUMAN_CONFIRMATION_REQUIRED" });

      // A cross-site origin is rejected before any decision is recorded.
      const crossSite = await fetch(`${base}/confirmations/${confirmationToken}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie: csrfCookie },
        body: `csrf=${csrf}`
      });
      expect(crossSite.status).toBe(403);
      const missingCsrf = await fetch(`${base}/confirmations/${confirmationToken}`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "csrf=wrong"
      });
      expect(missingCsrf.status).toBe(403);

      // The human decision is recorded once and re-delivery is safe.
      const decision = await fetch(`${base}/confirmations/${confirmationToken}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: csrfCookie },
        body: `csrf=${csrf}`
      });
      expect(decision.status).toBe(200);
      expect(await decision.text()).toContain("Decision recorded");
      const redelivery = await fetch(`${base}/confirmations/${confirmationToken}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: csrfCookie },
        body: `csrf=${csrf}`
      });
      expect(await redelivery.text()).toContain("already recorded");

      // The recorded decision unlocks the approval checkpoint.
      await expect(harness.service.approveRelease(harness.context, {
        releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "approve-http-flow-0002"
      })).resolves.toMatchObject({ release: { status: "approved" } });
      await expect(harness.service.publishRelease(harness.context, {
        releaseId: preview.releaseId, releaseHash: preview.releaseHash, idempotencyKey: "publish-http-flow-0001"
      })).resolves.toMatchObject({ release: { status: "published" } });
      expect(harness.operations.startCount).toBe(1);
      expect(harness.provider.publishCount).toBe(1);

      // Unknown and forged capabilities never resolve.
      const forged = await fetch(`${base}/confirmations/${"A".repeat(43)}`);
      expect(forged.status).toBe(404);
      const forgedPreview = await fetch(`${base}/previews/${"A".repeat(43)}`);
      expect(forgedPreview.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => harness.server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

function previewHarness() {
  const provider = new RecordingProvider();
  const operations = new BuiltStagingOperations();
  const repository = new InMemoryEditingRepository();
  repository.registerSite(previewSite);
  const service = new McpEditingService(
    repository, new InMemoryEventStore(), undefined,
    new InMemoryReleaseWorkflowRepository(), provider, {}, undefined, undefined, operations
  );
  const context = {
    authorization: {
      tenantId: previewSite.tenantId,
      siteId: previewSite.siteId,
      principal: { id: "user-publisher", kind: "human" as const, issuer: "https://identity.example", subject: "publisher" },
      layers: [
        { name: "principal" as const, permissions: NAVOCMS_PERMISSIONS },
        siteRoleAuthority("publisher"),
        { name: "operation" as const, permissions: NAVOCMS_PERMISSIONS }
      ]
    }
  };
  const server = createMcpHttpServer({
    service,
    verifier: { verify: async () => { throw new Error("not called"); } },
    resource: "https://cms.example.test/mcp",
    authorizationServers: ["https://identity.example.test"]
  });
  return { service, server, context, operations, provider };
}

const previewSite = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  name: "Preview proving site",
  primaryLocale: "en",
  locales: ["en"]
});

class RecordingProvider implements ReleaseProvider {
  public readonly key = "test.http-recording.v1";
  public publishCount = 0;
  public async publish(input: ReleaseProviderPublishInput): Promise<ReleaseProviderPublication> {
    this.publishCount += 1;
    return { providerKey: this.key, providerReference: `test:${input.releaseHash}`, artifactHash: input.artifact.hash };
  }
  public async verify(): Promise<boolean> { return true; }
  public async rollback(): Promise<void> {}
}

class BuiltStagingOperations implements StagingAstroOperations {
  public startCount = 0;
  readonly #outputs = new Map<string, Readonly<Record<string, string>>>();
  public async prepare(): Promise<AstroRenderInput> { return { anchors: { content: `sha256:${"a".repeat(64)}`, design: `sha256:${"b".repeat(64)}`, delivery: `sha256:${"c".repeat(64)}`, governance: `sha256:${"d".repeat(64)}` } } as AstroRenderInput; }
  public async persistPreviewInput(): Promise<void> {}
  public async startBuild(_: unknown, release: { id: string }): Promise<PreviewBuildStatus> {
    this.startCount += 1;
    this.#outputs.set(release.id, Object.freeze({
      "index.html": "<!doctype html><html lang=\"en\"><head><link rel=\"stylesheet\" href=\"/_astro/styles.css\"></head><body><h1>built-index</h1></body></html>",
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
