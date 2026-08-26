import { sha256 } from "@navocms/kernel";
import { describe, expect, it } from "vitest";

import { CloudflareDeliveryError, FetchCloudflarePagesTransport } from "./index.js";

const reference = Object.freeze({
  schema: "io.navocms.cloudflare-artifact-reference.v1" as const,
  releaseHash: "a".repeat(64),
  releaseArtifactHash: "b".repeat(64),
  astroArtifactHash: `sha256:${"c".repeat(64)}`,
  outputHash: sha256('{"en/index.html":"<html>en</html>"}'),
  routeDigest: sha256('["en/index.html"]'),
  sourceCommitSha: "d".repeat(40),
  fileCount: 1,
  byteSize: 15,
  files: Object.freeze([Object.freeze({ path: "en/index.html", sha256: sha256("<html>en</html>"), byteSize: 15 })])
});
const referenceHash = sha256(JSON.stringify(reference));

describe("Fetch Cloudflare Pages direct upload transport", () => {
  it("uses the official direct-upload sequence with distinct API and upload credentials", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const responses = [
      json({ result: { production_branch: "main" } }),
      json({ result: { jwt: "upload-token-0123456789" } }),
      json({ result: ["d4eb547c199ef336cae19e3248b71bdc"] }),
      json({ result: {} }),
      json({ result: { id: "deployment-1", environment: "preview", url: "https://hash.pages-project.pages.dev", latest_stage: { status: "success" } } })
    ];
    const transport = new FetchCloudflarePagesTransport({
      accountId: "account-1", projectKey: "pages-project", productionBranch: "main", apiToken: async () => "api-token-0123456789",
      fetcher: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return responses.shift()!;
      }
    });

    const deployment = await transport.createPreview({
      projectKey: "pages-project", previewBranch: "preview", reference, referenceHash,
      files: { "en/index.html": "<html>en</html>" }
    });

    expect(deployment).toMatchObject({ id: "deployment-1", projectKey: "pages-project", referenceHash, environment: "preview", status: "success" });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/client/v4/accounts/account-1/pages/projects/pages-project",
      "/client/v4/accounts/account-1/pages/projects/pages-project/upload-token",
      "/client/v4/pages/assets/check-missing",
      "/client/v4/pages/assets/upload",
      "/client/v4/accounts/account-1/pages/projects/pages-project/deployments"
    ]);
    expect(header(calls[0]!, "authorization")).toBe("Bearer api-token-0123456789");
    expect(header(calls[1]!, "authorization")).toBe("Bearer api-token-0123456789");
    expect(header(calls[2]!, "authorization")).toBe("Bearer upload-token-0123456789");
    expect(header(calls[3]!, "authorization")).toBe("Bearer upload-token-0123456789");
    expect(header(calls[4]!, "authorization")).toBe("Bearer api-token-0123456789");
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ hashes: ["d4eb547c199ef336cae19e3248b71bdc"] });
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual([expect.objectContaining({ key: "d4eb547c199ef336cae19e3248b71bdc" })]);
    const form = calls[4]!.init.body as FormData;
    expect(form.get("branch")).toBe("preview");
    expect(form.get("commit_hash")).toBe(reference.sourceCommitSha);
    expect(form.get("commit_message")).toBe(`navocms:preview:${referenceHash}`);
    expect(JSON.parse(String(form.get("manifest")))).toEqual({ "/en/index.html": "d4eb547c199ef336cae19e3248b71bdc" });
    expect(form.get("pages_build_output_dir")).toBeNull();
    await expect((form.get("_headers") as Blob).text()).resolves.toContain(`X-NavoCMS-Artifact-Reference: ${referenceHash}`);
  });

  it("rejects another project before the transport can receive a request", async () => {
    const transport = new FetchCloudflarePagesTransport({
      accountId: "account-1", projectKey: "pages-project", productionBranch: "main", apiToken: async () => "api-token-0123456789",
      fetcher: async () => { throw new Error("fetch must not run"); }
    });
    await expect(transport.findDeployment({ projectKey: "other-project", referenceHash, environment: "preview" })).rejects.toMatchObject({ code: "CLOUDFLARE_PROJECT_SCOPE_DENIED" });
  });

  it("denies the configured production branch from the preview-only operation before any request", async () => {
    const transport = new FetchCloudflarePagesTransport({
      accountId: "account-1", projectKey: "pages-project", productionBranch: "main", apiToken: async () => "api-token-0123456789",
      fetcher: async () => { throw new Error("fetch must not run"); }
    });
    await expect(transport.createPreview({ projectKey: "pages-project", previewBranch: "main", reference, referenceHash, files: { "en/index.html": "<html>en</html>" } })).rejects.toMatchObject({ code: "CLOUDFLARE_PRODUCTION_BRANCH_DENIED" });
  });

  it("fails closed before upload when the project reports that the preview branch is production", async () => {
    let calls = 0;
    const transport = new FetchCloudflarePagesTransport({
      accountId: "account-1", projectKey: "pages-project", productionBranch: "main", apiToken: async () => "api-token-0123456789",
      fetcher: async () => { calls += 1; return json({ result: { production_branch: "preview" } }); }
    });
    await expect(transport.createPreview({ projectKey: "pages-project", previewBranch: "preview", reference, referenceHash, files: { "en/index.html": "<html>en</html>" } })).rejects.toMatchObject({ code: "CLOUDFLARE_PRODUCTION_BRANCH_MISMATCH" });
    expect(calls).toBe(1);
  });

  it("requires the Pages API to explicitly return preview for a preview creation", async () => {
    const responses = [
      json({ result: { production_branch: "main" } }),
      json({ result: { jwt: "upload-token-0123456789" } }),
      json({ result: [] }),
      json({ result: { id: "wrong-environment", environment: "production", latest_stage: { status: "success" } } })
    ];
    const transport = new FetchCloudflarePagesTransport({
      accountId: "account-1", projectKey: "pages-project", productionBranch: "main", apiToken: async () => "api-token-0123456789",
      fetcher: async () => responses.shift()!
    });
    await expect(transport.createPreview({ projectKey: "pages-project", previewBranch: "preview", reference, referenceHash, files: { "en/index.html": "<html>en</html>" } })).rejects.toMatchObject({ code: "CLOUDFLARE_ENVIRONMENT_MISMATCH" });
  });

  it("accepts only a project-scoped Pages preview URL", async () => {
    for (const url of ["https://a.b.pages-project.pages.dev", "https://hash.other-project.pages.dev", "https://hash.pages.dev", "http://hash.pages-project.pages.dev", "https://token@hash.pages-project.pages.dev", "https://hash.pages-project.pages.dev:444", "https://hash.pages-project.pages.dev/path", "https://hash.pages-project.pages.dev?x=1", "https://hash.pages-project.pages.dev#x"]) {
      const responses = [json({ result: { production_branch: "main" } }), json({ result: { jwt: "upload-token-0123456789" } }), json({ result: [] }), json({ result: { id: "preview-url", environment: "preview", url, latest_stage: { status: "success" } } })];
      const transport = new FetchCloudflarePagesTransport({ accountId: "account-1", projectKey: "pages-project", productionBranch: "main", apiToken: async () => "api-token-0123456789", fetcher: async () => responses.shift()! });
      await expect(transport.createPreview({ projectKey: "pages-project", previewBranch: "preview", reference, referenceHash, files: { "en/index.html": "<html>en</html>" } })).rejects.toMatchObject({ code: "CLOUDFLARE_PREVIEW_INVALID" });
    }
  });

  it("rejects a swapped output before requesting either credential", async () => {
    let requested = false;
    const transport = new FetchCloudflarePagesTransport({
      accountId: "account-1", projectKey: "pages-project", productionBranch: "main", apiToken: async () => { requested = true; return "api-token-0123456789"; },
      fetcher: async () => { throw new Error("fetch must not run"); }
    });
    await expect(transport.createPreview({
      projectKey: "pages-project", previewBranch: "preview", reference: { ...reference, outputHash: "0".repeat(64) }, referenceHash,
      files: { "en/index.html": "<html>en</html>" }
    })).rejects.toMatchObject({ code: "CLOUDFLARE_ASSET_REFERENCE_MISMATCH" });
    expect(requested).toBe(false);
  });

  it("normalizes provider failures without exposing an API token", async () => {
    const secret = "api-token-0123456789";
    const transport = new FetchCloudflarePagesTransport({
      accountId: "account-1", projectKey: "pages-project", productionBranch: "main", apiToken: async () => secret,
      fetcher: async () => new Response(JSON.stringify({ success: false, errors: [{ message: secret }] }), { status: 502, headers: { "content-type": "application/json" } })
    });
    await expect(transport.findDeployment({ projectKey: "pages-project", referenceHash, environment: "preview" })).rejects.toEqual(expect.objectContaining({ code: "CLOUDFLARE_HTTP_502", httpStatus: 502 }));
    await transport.findDeployment({ projectKey: "pages-project", referenceHash, environment: "preview" }).catch((error: unknown) => {
      expect(error).toBeInstanceOf(CloudflareDeliveryError);
      expect(String(error)).not.toContain(secret);
    });
  });

  it("rejects a swapped live file even when all immutable headers are correct", async () => {
    const responses = [
      json({ result: { production_branch: "main", canonical_deployment: { id: "production-1", environment: "production", aliases: ["https://production.pages.dev/"] } } }),
      new Response("<html>xx</html>", {
        status: 200,
        headers: {
          "x-navocms-artifact-reference": referenceHash,
          "x-navocms-release-hash": reference.releaseHash,
          "x-navocms-output-hash": reference.outputHash,
          "cache-control": "public, max-age=300, must-revalidate"
        }
      })
    ];
    const transport = new FetchCloudflarePagesTransport({
      accountId: "account-1", projectKey: "pages-project", productionBranch: "main", apiToken: async () => "api-token-0123456789",
      fetcher: async () => responses.shift()!
    });
    await expect(transport.verifyLive({ projectKey: "pages-project", deploymentId: "production-1", referenceHash, environment: "production", reference })).rejects.toMatchObject({ code: "CLOUDFLARE_LIVE_BYTES_MISMATCH" });
  });

  it("uses the project production branch and canonical deployment as the authoritative live binding", async () => {
    const transport = new FetchCloudflarePagesTransport({
      accountId: "account-1", projectKey: "pages-project", productionBranch: "main", apiToken: async () => "api-token-0123456789",
      fetcher: async () => json({ result: { production_branch: "other", canonical_deployment: { id: "production-1", environment: "production", aliases: ["https://production.pages.dev/"] } } })
    });
    await expect(transport.verifyLive({ projectKey: "pages-project", deploymentId: "production-1", referenceHash, environment: "production", reference })).rejects.toMatchObject({ code: "CLOUDFLARE_PRODUCTION_BRANCH_MISMATCH" });
  });

  it("aborts a stalled Cloudflare request within the configured timeout", async () => {
    const transport = new FetchCloudflarePagesTransport({
      accountId: "account-1", projectKey: "pages-project", productionBranch: "main", timeoutMs: 10, apiToken: async () => "api-token-0123456789",
      fetcher: async (_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
    });
    await expect(transport.findDeployment({ projectKey: "pages-project", referenceHash, environment: "preview" })).rejects.toMatchObject({ code: "CLOUDFLARE_TIMEOUT" });
  });

  it("applies one deadline across sequential live GETs and aborts a stalled later file", async () => {
    const twoFiles = { ...reference, fileCount: 2, byteSize: 30, files: [reference.files[0]!, { path: "fr/index.html", sha256: sha256("<html>fr</html>"), byteSize: 15 }] };
    let calls = 0;
    const transport = new FetchCloudflarePagesTransport({
      accountId: "account-1", projectKey: "pages-project", productionBranch: "main", timeoutMs: 10, apiToken: async () => "api-token-0123456789",
      fetcher: async (_url, init) => {
        calls += 1;
        if (calls === 1) return json({ result: { production_branch: "main", canonical_deployment: { id: "production-1", environment: "production", aliases: ["https://production.pages.dev/"] } } });
        if (calls === 2) return new Response("<html>en</html>", { status: 200, headers: { "x-navocms-artifact-reference": referenceHash, "x-navocms-release-hash": reference.releaseHash, "x-navocms-output-hash": reference.outputHash, "cache-control": "public, max-age=300, must-revalidate" } });
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
    });
    await expect(transport.verifyLive({ projectKey: "pages-project", deploymentId: "production-1", referenceHash, environment: "production", reference: twoFiles })).rejects.toMatchObject({ code: "CLOUDFLARE_TIMEOUT" });
  });

  it("keeps the deadline active after live response headers until the body is consumed", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() { /* headers arrive while body never resolves */ }, pull() { return new Promise<void>(() => undefined); } });
    const responses = [
      json({ result: { production_branch: "main", canonical_deployment: { id: "production-1", environment: "production", aliases: ["https://production.pages.dev/"] } } }),
      new Response(stalled, { status: 200, headers: { "x-navocms-artifact-reference": referenceHash, "x-navocms-release-hash": reference.releaseHash, "x-navocms-output-hash": reference.outputHash, "cache-control": "public, max-age=300, must-revalidate" } })
    ];
    const transport = new FetchCloudflarePagesTransport({ accountId: "account-1", projectKey: "pages-project", productionBranch: "main", timeoutMs: 10, apiToken: async () => "api-token-0123456789", fetcher: async () => responses.shift()! });
    await expect(transport.verifyLive({ projectKey: "pages-project", deploymentId: "production-1", referenceHash, environment: "production", reference })).rejects.toMatchObject({ code: "CLOUDFLARE_TIMEOUT" });
  });
});

function json(value: Record<string, unknown>): Response { return new Response(JSON.stringify({ success: true, ...value }), { status: 200, headers: { "content-type": "application/json" } }); }
function header(call: { init: RequestInit }, name: string): string | undefined {
  const headers = call.init.headers;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name)?.[1];
  return headers && typeof headers === "object" ? (headers as Record<string, string>)[name] : undefined;
}
