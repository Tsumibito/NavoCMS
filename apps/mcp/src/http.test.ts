import type { ReleaseProvider, ReleaseProviderPublication, ReleaseProviderPublishInput } from "@navocms/kernel";
import { InMemoryEventStore } from "@navocms/kernel";
import { NAVOCMS_PERMISSIONS, siteRoleAuthority } from "@navocms/security";
import type { AstroRenderInput } from "@navocms/design-astro";
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
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

describe("real preview namespace and browser-session confirmation", () => {
  it("binds every asset to the token namespace and rejects the same bearer that works on /mcp", async () => {
    const harness = previewHarness();
    const humanToken = "human-session-token-0000000000000001";
    harness.tokens.set(humanToken, { kind: "human", tenantId: previewSite.tenantId, siteId: previewSite.siteId, publish: true });
    harness.tokens.set("browser-login-token", { kind: "human", tenantId: previewSite.tenantId, siteId: previewSite.siteId, publish: true, expiresAt: Math.floor(Date.now() / 1000) + 120 });
    const created = await harness.service.createDraft(harness.context, {
      typeName: "article", slug: "real-preview", locale: "en", title: "Real preview",
      markdown: "# Real preview\n", idempotencyKey: "draft-real-preview-http-01"
    }) as { draft: { revisionId: string } };
    const preview = await harness.service.preparePreview(harness.context, created.draft.revisionId, "preview-real-preview-http-1") as {
      releaseId: string; releaseHash: string; previewUrl: string; confirmationUrl: string;
    };
    harness.operations.setOutput(preview.releaseId, {
      "index.html": '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/_astro/styles.css">' +
        '<link rel="stylesheet" href="/_astro/more.css"></head><body><img src="/image.svg" alt="i" ' +
        'srcset="/a.png 320w, /b.png 640w"><script>window.x = true;</script></body></html>',
      "_astro/styles.css": 'h1 { color: rgb(12, 34, 56); background: url(/font.woff2); }\n',
      "_astro/more.css": "h2 { color: red; }\n",
      "image.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"/>",
      "a.png": "a", "b.png": "b", "font.woff2": "f"
    });
    await new Promise<void>((resolve) => harness.server.listen(0, "127.0.0.1", resolve));
    const address = harness.server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const base = `http://127.0.0.1:${address.port}`;
    const previewToken = preview.previewUrl.split("/previews/")[1]!;
    const confirmationToken = preview.confirmationUrl.split("/confirmations/")[1]!;
    try {
      // The MCP bearer still authorizes MCP.
      const mcp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
      });
      await mcp.text();
      expect(mcp.status).toBe(200);
      // ...but the same bearer can no longer read the confirmation form or
      // record the decision: only a browser session can. Without a configured
      // login client the page states that login is unavailable (503) instead
      // of implying the capability is authoritative.
      const bearerPage = await fetch(`${base}/confirmations/${confirmationToken}`, {
        headers: { authorization: `Bearer ${humanToken}` }
      });
      expect(bearerPage.status).toBe(503);
      const bearerPost = await fetch(`${base}/confirmations/${confirmationToken}`, {
        method: "POST", headers: { authorization: `Bearer ${humanToken}`, "content-type": "application/x-www-form-urlencoded" }, body: "csrf=x"
      });
      expect(bearerPost.status).toBe(401);
      const decisionStatus = await harness.service.releaseConfirmationStatus(harness.context, {
        releaseId: preview.releaseId, releaseHash: preview.releaseHash
      });
      expect(decisionStatus).toMatchObject({ status: "pending" });

      // The entry page binds every root-relative URL to the token namespace.
      const page = await fetch(`${base}/previews/${previewToken}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("set-cookie")).toBeNull();
      const html = await page.text();
      const namespace = `/previews/${previewToken}`;
      expect(html).toContain(`href="${namespace}/_astro/styles.css"`);
      expect(html).toContain(`href="${namespace}/_astro/more.css"`);
      expect(html).toContain(`src="${namespace}/image.svg"`);
      expect(html).toContain(`${namespace}/a.png 320w, ${namespace}/b.png 640w`);
      expect(html).not.toContain('href="/_astro/');
      // CSS files keep their own url() references bound to the namespace.
      const css = await fetch(`${base}/previews/${previewToken}/_astro/styles.css`);
      expect(css.status).toBe(200);
      expect(await css.text()).toContain(`url(${namespace}/font.woff2)`);
      // Nested paths, traversal, and HTML-over-relay are closed.
      expect((await fetch(`${base}/previews/${previewToken}/_astro/more.css`)).status).toBe(200);
      expect((await fetch(`${base}/previews/${previewToken}/../other/preview/_astro/styles.css`)).status).toBe(404);
      expect((await fetch(`${base}/previews/${previewToken}/index.html`)).status).toBe(200);
      const malformed = await fetch(`${base}/previews/${previewToken}/%ZZ`);
      expect(malformed.status).toBe(400);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      harness.operations.setOutput(preview.releaseId, {
        "index.html": '<html><link href="_astro/styles.css"><img src="images/photo.svg" srcset="data:image/svg+xml;base64,AAA= 1x, images/photo.svg 2x"></html>',
        "_astro/styles.css": 'body { background: url(../images/photo.svg); }',
        "nested/index.html": '<html><img src="../images/photo.svg"></html>',
        "images/photo.svg": '<svg></svg>'
      });
      const relative = await (await fetch(`${base}/previews/${previewToken}`)).text();
      expect(relative).toContain(`href="${namespace}/_astro/styles.css"`);
      expect(relative).toContain(`src="${namespace}/images/photo.svg"`);
      expect(relative).toContain(`data:image/svg+xml;base64,AAA= 1x, ${namespace}/images/photo.svg 2x`);
      expect(await (await fetch(`${base}${namespace}/_astro/styles.css`)).text()).toContain(`url(${namespace}/images/photo.svg)`);
      expect(await (await fetch(`${base}${namespace}/nested/index.html`)).text()).toContain(`src="${namespace}/images/photo.svg"`);
      // Unknown tokens never resolve.
      expect((await fetch(`${base}/previews/${"A".repeat(43)}`)).status).toBe(404);

    } finally {
      await new Promise<void>((resolve, reject) => harness.server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("renders the confirmation page and records the decision after a real login exchange", async () => {
    // A fake identity-provider token endpoint: verifies the PKCE verifier it
    // received at authorize time and issues a token the harness verifier maps
    // to the site's human publisher.
    const idpCodes = new Map<string, string>();
    const idp = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const params = new URLSearchParams(body);
        if (params.get("grant_type") !== "authorization_code") {
          response.writeHead(400).end(JSON.stringify({ error: "unsupported_grant_type" }));
          return;
        }
        const verifier = params.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (challenge !== idpCodes.get(params.get("code") ?? "")) {
          response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: "browser-login-token", token_type: "Bearer" }));
      });
    });
    await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
    const idpPort = (idp.address() as { port: number }).port;
    idpCodes.set("idp-code-1", "pkce-challenge-value");
    const harness = previewHarness({
      withLogin: { authorizationEndpoint: `http://127.0.0.1:${idpPort}/authorize`, tokenEndpoint: `http://127.0.0.1:${idpPort}/token` }
    });
    const created = await harness.service.createDraft(harness.context, {
      typeName: "article", slug: "session-preview", locale: "en", title: "Session preview",
      markdown: "# Session preview\n", idempotencyKey: "draft-session-preview-01"
    }) as { draft: { revisionId: string } };
    const preview = await harness.service.preparePreview(harness.context, created.draft.revisionId, "preview-session-preview-01") as {
      releaseId: string; releaseHash: string; confirmationUrl: string;
    };
    const confirmationToken = preview.confirmationUrl.split("/confirmations/")[1]!;
    harness.tokens.set("browser-login-token", { kind: "human", tenantId: previewSite.tenantId, siteId: previewSite.siteId, publish: true, expiresAt: Math.floor(Date.now() / 1000) + 120 });
    await new Promise<void>((resolve) => harness.server.listen(0, "127.0.0.1", resolve));
    const address = harness.server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      // Anonymous navigation redirects to the identity provider with PKCE;
      // the fake IdP records the code's challenge for the token exchange.
      const start = await fetch(`${base}/confirmations/${confirmationToken}`, { redirect: "manual" });
      expect(start.status).toBe(302);
      const loginUrl = new URL(start.headers.get("location")!);
      expect(loginUrl.pathname).toBe("/authorize");
      idpCodes.set("idp-code-1", loginUrl.searchParams.get("code_challenge")!);
      const state = loginUrl.searchParams.get("state")!;
      const stateCookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
      // The identity provider returns the code; the callback exchanges it
      // with the PKCE verifier and creates the server-side session.
      const callback = await fetch(`${base}/confirmations/callback?code=idp-code-1&state=${state}`, {
        redirect: "manual", headers: { cookie: stateCookie }
      });
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(`/confirmations/${confirmationToken}`);
      const sessionCookie = (callback.headers.get("set-cookie") ?? "")
        .split("\n").find((line) => line.includes("navocms_confirmation_session"))!.split(";")[0]!;
      // Replaying the same callback is rejected.
      const replay = await fetch(`${base}/confirmations/callback?code=idp-code-1&state=${state}`, {
        redirect: "manual", headers: { cookie: stateCookie }
      });
      expect(replay.status).toBe(400);
      // The session renders the form with CSRF pairing.
      const page = await fetch(`${base}/confirmations/${confirmationToken}`, { headers: { cookie: sessionCookie } });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Confirm this build");
      const csrfCookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
      // Cross-site origin rejected; missing CSRF rejected.
      const crossSite = await fetch(`${base}/confirmations/${confirmationToken}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie: sessionCookie },
        body: `csrf=${csrf}`
      });
      expect(crossSite.status).toBe(403);
      const missingCsrf = await fetch(`${base}/confirmations/${confirmationToken}`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie }, body: "csrf=wrong"
      });
      expect(missingCsrf.status).toBe(403);
      // The session posts the decision once; re-delivery is safe.
      const decision = await fetch(`${base}/confirmations/${confirmationToken}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${sessionCookie}; ${csrfCookie}` },
        body: `csrf=${csrf}`
      });
      expect(decision.status).toBe(200);
      expect(await decision.text()).toContain("Decision recorded");
      const redelivery = await fetch(`${base}/confirmations/${confirmationToken}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${sessionCookie}; ${csrfCookie}` },
        body: `csrf=${csrf}`
      });
      expect(await redelivery.text()).toContain("already recorded");
      const status = await harness.service.releaseConfirmationStatus(harness.context, {
        releaseId: preview.releaseId, releaseHash: preview.releaseHash
      });
      expect(status).toMatchObject({ status: "confirmed" });
      expect((status as unknown as Record<string, unknown>).decidedByReference).toMatch(/^[a-f0-9]{64}$/);
      const clock = vi.spyOn(Date, "now");
      const now = Date.now();
      try {
        clock.mockReturnValue(now + 121_000);
        const expiredSession = await fetch(`${base}/confirmations/${confirmationToken}`, {
          method: "POST", headers: { cookie: `${sessionCookie}; ${csrfCookie}`, "content-type": "application/x-www-form-urlencoded" }, body: `csrf=${csrf}`
        });
        expect(expiredSession.status).toBe(401);
        clock.mockReturnValue(now);
        const expiredStart = await fetch(`${base}/confirmations/${confirmationToken}`, { redirect: "manual" });
        const expiredState = new URL(expiredStart.headers.get("location")!).searchParams.get("state")!;
        const expiredCookie = expiredStart.headers.get("set-cookie")!.split(";")[0]!;
        clock.mockReturnValue(now + 600_001);
        const expiredCallback = await fetch(`${base}/confirmations/callback?code=idp-code-1&state=${expiredState}`, {
          redirect: "manual", headers: { cookie: expiredCookie }
        });
        expect(expiredCallback.status).toBe(400);
      } finally { clock.mockRestore(); }

    } finally {
      await new Promise<void>((resolve, reject) => harness.server.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve) => idp.close(() => resolve()));
    }
  });
});

interface TestToken {
  readonly kind: "human" | "agent";
  readonly tenantId: string;
  readonly siteId: string;
  readonly publish: boolean;
  readonly expiresAt?: number;
}

function previewHarness(options: {
  readonly withLogin?: { readonly authorizationEndpoint: string; readonly tokenEndpoint: string };
} = {}) {
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
  const tokens = new Map<string, TestToken>();
  const server = createMcpHttpServer({
    service,
    verifier: {
      verify: async (token: string) => {
        const issued = tokens.get(token);
        if (!issued) throw new Error("unknown token");
        const permissions = issued.publish ? [...NAVOCMS_PERMISSIONS] : (["content:read"] as const).slice();
        return {
          claims: { iss: "https://identity.example", sub: `subject:${token}`, aud: "https://cms.example.test/mcp", exp: issued.expiresAt ?? Math.floor(Date.now() / 1000) + 3600 },
          scopes: permissions,
          tenantId: issued.tenantId,
          siteId: issued.siteId,
          principal: { id: `principal:${token}`, kind: issued.kind, issuer: "https://identity.example", subject: `subject:${token}` }
        };
      }
    },
    resource: "https://cms.example.test/mcp",
    authorizationServers: ["https://identity.example.test"],
    ...(options.withLogin ? {
      confirmationLogin: {
        clientId: "confirmation-client",
        clientSecret: "confirmation-secret",
        authorizationEndpoint: options.withLogin.authorizationEndpoint,
        tokenEndpoint: options.withLogin.tokenEndpoint
      }
    } : {})
  });
  return { service, server, context, operations, provider, tokens };
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
  readonly #css = new Map<string, string>();
  public setOutput(releaseId: string, output: Readonly<Record<string, string>>): void {
    this.#outputs.set(releaseId, Object.freeze({ ...output }));
  }
  public async prepare(): Promise<AstroRenderInput> { return { anchors: { content: `sha256:${"a".repeat(64)}`, design: `sha256:${"b".repeat(64)}`, delivery: `sha256:${"c".repeat(64)}`, governance: `sha256:${"d".repeat(64)}` } } as AstroRenderInput; }
  public async persistPreviewInput(): Promise<void> {}
  public async startBuild(_: unknown, release: { id: string }): Promise<PreviewBuildStatus> {
    this.startCount += 1;
    if (!this.#outputs.has(release.id)) {
      this.#outputs.set(release.id, Object.freeze({
        "index.html": "<!doctype html><html lang=\"en\"><head><link rel=\"stylesheet\" href=\"/_astro/styles.css\"></head><body><h1>built-index</h1></body></html>",
        "_astro/styles.css": "body { margin: 0; }\n"
      }));
    }
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
