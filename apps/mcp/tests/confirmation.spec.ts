import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
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
  name: "Confirmation proving site",
  primaryLocale: "en",
  locales: ["en"]
});

test("anonymous navigation leads to login; a real browser login records the decision once", async ({ page, browser }) => {
  const harness = await confirmationHarness();
  const preview = await prepare(harness);
  const token = preview.confirmationUrl.split("/confirmations/")[1]!;
  const server = harness.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    // Anonymous navigation goes through the identity provider's authorization
    // endpoint (PKCE S256) — the chain only reaches a form after a real login.
    const anonymous = await page.goto(`${base}/confirmations/${token}`);
    expect(anonymous!.status()).toBe(200);
    const chainUrls: string[] = [];
    let hop = anonymous!.request();
    while (true) {
      chainUrls.unshift(hop.url());
      const previous = hop.redirectedFrom();
      if (previous === null) break;
      hop = previous;
    }
    expect(chainUrls.some((url) => new URL(url).pathname === "/authorize")).toBe(true);
    // The fake IdP signs the user in and returns the code to the callback;
    // the CMS exchanged it (PKCE) and created the server-side session, so the
    // final landing page is the confirmation form itself.
    await expect(page.getByRole("heading", { name: "Confirm publication of this exact build" })).toBeVisible();
    await expect(page.getByText("Output manifest digest")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm this build" })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(axe.violations).toEqual([]);

    // The human clicks; the browser form POST carries only session cookies.
    await page.getByRole("button", { name: "Confirm this build" }).click();
    await expect(page.getByRole("heading", { name: "Decision recorded" })).toBeVisible();
    expect(await page.textContent("main")).toContain("Publication is a separate step");

    // Re-delivery of the same decision is the safe no-op view.
    await page.goto(`${base}/confirmations/${token}`);
    await expect(page.getByRole("heading", { name: "Decision already recorded" })).toBeVisible();

    const status = await harness.service.releaseConfirmationStatus(harness.context, {
      releaseId: preview.releaseId, releaseHash: preview.releaseHash
    });
    expect(status).toMatchObject({ status: "confirmed" });
    expect((status as unknown as Record<string, unknown>).decidedByReference).toMatch(/^[a-f0-9]{64}$/);

    // A second browser with no session goes to login, not to the form; it
    // cannot act on the already-recorded decision through its own identity.
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    const secondNavigation = await secondPage.goto(`${base}/confirmations/${token}`);
    // With auto-sign-in the chain completes; walk it from the final request
    // back to the original navigation and assert the login hop targeted the
    // IdP authorize endpoint with PKCE before returning.
    const secondChainUrls: string[] = [];
    let secondHop = secondNavigation!.request();
    while (true) {
      secondChainUrls.unshift(secondHop.url());
      const previous = secondHop.redirectedFrom();
      if (previous === null) break;
      secondHop = previous;
    }
    const loginHop = secondChainUrls.map((url) => new URL(url)).find((url) => url.pathname === "/authorize");
    expect(loginHop).toBeDefined();
    expect(loginHop!.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loginHop!.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loginHop!.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(secondPage.getByRole("heading", { name: "Decision already recorded" })).toBeVisible();
    await second.close();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve) => harness.idp.close(() => resolve()));
  }
});

test("a delegated agent identity cannot sign in for the confirmation", async ({ browser }) => {
  const harness = await confirmationHarness({ agentLogin: true });
  const preview = await prepare(harness);
  const token = preview.confirmationUrl.split("/confirmations/")[1]!;
  const server = harness.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${base}/confirmations/${token}`);
    // The login itself resolves to an agent-kind identity; the callback
    // rejects it before any session exists.
    await expect(page.getByRole("heading", { name: "Sign-in rejected" })).toBeVisible();
    expect(await page.locator("form").count()).toBe(0);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve) => harness.idp.close(() => resolve()));
  }
});

async function prepare(harness: ConfirmationHarness) {
  const created = await harness.service.createDraft(harness.context, {
    typeName: "article", slug: "browser-confirmation", locale: "en", title: "Browser confirmation",
    markdown: "# Browser confirmation\n", idempotencyKey: "draft-browser-confirmation-1"
  }) as { draft: { revisionId: string } };
  return await harness.service.preparePreview(harness.context, created.draft.revisionId, "preview-browser-confirmation-1") as {
    releaseId: string; releaseHash: string; confirmationUrl: string;
  };
}

interface ConfirmationHarness {
  readonly server: ReturnType<typeof createMcpHttpServer>;
  readonly service: McpEditingService;
  readonly idp: ReturnType<typeof createHttpServer>;
  readonly context: { authorization: { tenantId: string; siteId: string; principal: { id: string; kind: "human"; issuer: string; subject: string }; layers: readonly { name: string; permissions: readonly string[] }[] } };
}

async function confirmationHarness(options: { readonly agentLogin?: boolean } = {}): Promise<ConfirmationHarness> {
  // The fake identity provider: /authorize records the code's PKCE challenge,
  // signs the user in server-side, and redirects back; /token verifies the
  // exchange's code_verifier and issues the identity's access token.
  const identity = options.agentLogin === true
    ? { id: "principal-agent", kind: "agent" as const, subject: "delegated-agent" }
    : { id: "principal-human", kind: "human" as const, subject: "publisher" };
  const codes = new Map<string, string>();
  const idp = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/authorize") {
      const code = `code-${randomId()}`;
      codes.set(code, url.searchParams.get("code_challenge") ?? "");
      // A real IdP redirects to the registered redirect_uri of the client.
      const back = new URL(url.searchParams.get("redirect_uri") ?? "http://localhost/confirmations/callback");
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: back.toString() });
      response.end();
      return;
    }
    if (url.pathname === "/token") {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk; });
      request.on("end", () => {
        const params = new URLSearchParams(body);
        const challenge = codes.get(params.get("code") ?? "");
        const computed = createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
        if (challenge === undefined || challenge !== computed) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        codes.delete(params.get("code") ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: `idp-token-for-${identity.subject}`, token_type: "Bearer" }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  const idpPort = (idp.address() as { port: number }).port;

  const provider: ReleaseProvider = {
    key: "test.confirmation.v2",
    async publish(input: ReleaseProviderPublishInput): Promise<ReleaseProviderPublication> {
      return { providerKey: "test.confirmation.v2", providerReference: `test:${input.releaseHash}`, artifactHash: input.artifact.hash };
    },
    async verify(): Promise<boolean> { return true; },
    async rollback(): Promise<void> {}
  };
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
  const server = createMcpHttpServer({
    service,
    verifier: {
      verify: async (token: string) => {
        if (token !== `idp-token-for-${identity.subject}`) throw new Error("unknown token");
        return {
          claims: { iss: "https://identity.example", sub: identity.subject, aud: "https://cms.example.test/mcp", exp: Math.floor(Date.now() / 1000) + 3600 },
          scopes: [...NAVOCMS_PERMISSIONS],
          tenantId: site.tenantId,
          siteId: site.siteId,
          principal: { id: identity.id, kind: identity.kind, issuer: "https://identity.example", subject: identity.subject }
        };
      }
    },
    resource: "https://cms.example.test/mcp",
    authorizationServers: ["https://identity.example.test"],
    confirmationLogin: {
      clientId: "confirmation-client",
      clientSecret: "confirmation-secret",
      authorizationEndpoint: `http://127.0.0.1:${idpPort}/authorize`,
      tokenEndpoint: `http://127.0.0.1:${idpPort}/token`
    }
  });
  return { server, service, idp, context };
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
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
