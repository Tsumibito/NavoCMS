import { describe, expect, it } from "vitest";

import { FetchCoolifyCommitTransport } from "./index.js";

const commit = "a".repeat(40);
const referenceHash = "b".repeat(64);

describe("Fetch Coolify commit transport", () => {
  it("pins the full immutable commit before asking Coolify to deploy", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const responses = [
      json({ message: "application updated" }),
      json({ deployments: [{ deployment_uuid: "deployment-1" }] })
    ];
    const transport = new FetchCoolifyCommitTransport({
      baseUrl: "https://coolify.example.test/api/v1", applicationKey: "coolify-app", apiToken: async () => "coolify-token-0123456789",
      fetcher: async (url, init = {}) => { calls.push({ url: String(url), init }); return responses.shift()!; }
    });

    const promotion = await transport.promoteCommit({ applicationKey: "coolify-app", sourceCommitSha: commit, referenceHash, operationKey: "promote-0123456789" });

    expect(promotion).toEqual({ id: "deployment-1", applicationKey: "coolify-app", sourceCommitSha: commit, referenceHash, status: "queued" });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/api/v1/applications/coolify-app", "/api/v1/deploy"]);
    expect(calls.map((call) => JSON.parse(String(call.init.body)))).toEqual([{ git_commit_sha: commit }, { uuid: "coolify-app" }]);
    expect(header(calls[0]!, "authorization")).toBe("Bearer coolify-token-0123456789");
  });

  it("never reuses a commit-only historical deployment as an artifact-reference binding", async () => {
    const transport = new FetchCoolifyCommitTransport({
      baseUrl: "https://coolify.example.test/api/v1", applicationKey: "coolify-app", apiToken: async () => "coolify-token-0123456789",
      fetcher: async () => json([{ deployment_uuid: "deployment-1", commit, status: "finished" }])
    });

    await expect(transport.findPromotion({ applicationKey: "coolify-app", sourceCommitSha: commit, referenceHash })).resolves.toBeUndefined();
  });

  it("rejects a foreign application before it can expose the token", async () => {
    const transport = new FetchCoolifyCommitTransport({
      baseUrl: "https://coolify.example.test/api/v1", applicationKey: "coolify-app", apiToken: async () => "coolify-token-0123456789",
      fetcher: async () => { throw new Error("fetch must not run"); }
    });
    await expect(transport.promoteCommit({ applicationKey: "other-app", sourceCommitSha: commit, referenceHash, operationKey: "promote-0123456789" })).rejects.toMatchObject({ code: "COOLIFY_APPLICATION_SCOPE_DENIED" });
  });

  it("returns the new rollback deployment UUID instead of discarding the external effect", async () => {
    const responses = [json({ message: "application updated" }), json({ deployments: [{ deployment_uuid: "rollback-new-1" }] })];
    const transport = new FetchCoolifyCommitTransport({
      baseUrl: "https://coolify.example.test/api/v1", applicationKey: "coolify-app", apiToken: async () => "coolify-token-0123456789",
      fetcher: async () => responses.shift()!
    });
    await expect(transport.rollback({ applicationKey: "coolify-app", currentPromotionId: "current-1", targetPromotionId: "target-1", targetCommitSha: commit, referenceHash, operationKey: "rollback-0123456789" })).resolves.toEqual({ id: "rollback-new-1", applicationKey: "coolify-app", sourceCommitSha: commit, referenceHash, status: "queued" });
  });

  it("aborts a stalled Coolify request within the configured timeout", async () => {
    const transport = new FetchCoolifyCommitTransport({
      baseUrl: "https://coolify.example.test/api/v1", applicationKey: "coolify-app", timeoutMs: 10, apiToken: async () => "coolify-token-0123456789",
      fetcher: async (_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
    });
    await expect(transport.findPromotion({ applicationKey: "coolify-app", sourceCommitSha: commit, referenceHash })).rejects.toMatchObject({ code: "COOLIFY_TIMEOUT" });
  });

  it("keeps the Coolify deadline active after headers until JSON consumption completes", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() { /* headers arrive while JSON never arrives */ }, pull() { return new Promise<void>(() => undefined); } });
    const transport = new FetchCoolifyCommitTransport({
      baseUrl: "https://coolify.example.test/api/v1", applicationKey: "coolify-app", timeoutMs: 10, apiToken: async () => "coolify-token-0123456789",
      fetcher: async () => new Response(stalled, { status: 200, headers: { "content-type": "application/json" } })
    });
    await expect(transport.findPromotion({ applicationKey: "coolify-app", sourceCommitSha: commit, referenceHash })).rejects.toMatchObject({ code: "COOLIFY_TIMEOUT" });
  });
});

function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
function header(call: { init: RequestInit }, name: string): string | undefined {
  const headers = call.init.headers;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name)?.[1];
  return headers && typeof headers === "object" ? (headers as Record<string, string>)[name] : undefined;
}
