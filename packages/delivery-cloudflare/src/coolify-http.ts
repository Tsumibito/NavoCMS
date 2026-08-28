import { CloudflareDeliveryError } from "./index.js";

export interface CoolifyPromotion {
  readonly id: string;
  readonly applicationKey: string;
  readonly sourceCommitSha: string;
  readonly referenceHash: string;
  readonly status: "queued" | "running" | "finished" | "failed";
}

export interface CoolifyCommitTransport {
  findPromotion(input: Readonly<{
    applicationKey: string;
    sourceCommitSha: string;
    referenceHash: string;
  }>): Promise<CoolifyPromotion | undefined>;
  promoteCommit(input: Readonly<{
    applicationKey: string;
    sourceCommitSha: string;
    referenceHash: string;
    operationKey: string;
  }>): Promise<CoolifyPromotion>;
  retryPromotion(input: Readonly<{
    applicationKey: string;
    sourceCommitSha: string;
    referenceHash: string;
    operationKey: string;
  }>): Promise<CoolifyPromotion>;
  inspectPromotion(input: Readonly<{ applicationKey: string; promotionId: string; referenceHash: string }>): Promise<CoolifyPromotion | undefined>;
  rollback(input: Readonly<{
    applicationKey: string;
    currentPromotionId: string;
    targetPromotionId: string;
    targetCommitSha: string;
    referenceHash: string;
    operationKey: string;
  }>): Promise<CoolifyPromotion>;
}

export interface FetchCoolifyCommitTransportOptions {
  readonly applicationKey: string;
  /** Resolve from an encrypted runtime store; this transport never logs or stores it. */
  readonly apiToken: () => Promise<string>;
  readonly baseUrl: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Operator/runtime adapter for an exact commit promotion. It is not part of
 * the content ReleaseProvider or a Cloudflare staging binding.
 */
export class FetchCoolifyCommitTransport implements CoolifyCommitTransport {
  readonly #applicationKey: string;
  readonly #apiToken: () => Promise<string>;
  readonly #base: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  public constructor(options: FetchCoolifyCommitTransportOptions) {
    if (!identifier(options.applicationKey)) throw new CloudflareDeliveryError("COOLIFY_CONFIG_INVALID", "Coolify application identifier is invalid");
    this.#applicationKey = options.applicationKey;
    this.#apiToken = options.apiToken;
    this.#base = coolifyBase(options.baseUrl);
    this.#fetch = options.fetcher ?? fetch;
    this.#timeoutMs = timeoutMs(options.timeoutMs);
  }

  public async findPromotion(input: Parameters<CoolifyCommitTransport["findPromotion"]>[0]): Promise<CoolifyPromotion | undefined> {
    this.#assertApplication(input.applicationKey);
    assertCommit(input.sourceCommitSha); assertReferenceHash(input.referenceHash);
    const result = await this.#api(`/deployments/applications/${encodeURIComponent(this.#applicationKey)}?skip=0&take=50`);
    const rows = Array.isArray(result) ? result : [];
    const row = rows.find((candidate) => record(candidate).commit === input.sourceCommitSha);
    // Coolify exposes the commit but not an immutable artifact-reference field. A commit match
    // therefore cannot safely prove a reference match and must never be reused as one.
    void row;
    return undefined;
  }

  public async promoteCommit(input: Parameters<CoolifyCommitTransport["promoteCommit"]>[0]): Promise<CoolifyPromotion> {
    this.#assertApplication(input.applicationKey);
    assertCommit(input.sourceCommitSha); assertReferenceHash(input.referenceHash); assertOperationKey(input.operationKey);
    await this.#api(`/applications/${encodeURIComponent(this.#applicationKey)}`, { method: "PATCH", body: JSON.stringify({ git_commit_sha: input.sourceCommitSha }) });
    const result = await this.#api("/deploy", { method: "POST", body: JSON.stringify({ uuid: this.#applicationKey }) });
    const deployment = deploymentResponse(result);
    return Object.freeze({ id: deployment.id, applicationKey: this.#applicationKey, sourceCommitSha: input.sourceCommitSha, referenceHash: input.referenceHash, status: "queued" });
  }

  public async retryPromotion(input: Parameters<CoolifyCommitTransport["retryPromotion"]>[0]): Promise<CoolifyPromotion> {
    // Coolify has no portable deployment-retry endpoint. Re-applying the same pinned commit is
    // the bounded retry operation; the provider never treats an unbound historical run as reuse.
    return this.promoteCommit(input);
  }

  public async inspectPromotion(input: Parameters<CoolifyCommitTransport["inspectPromotion"]>[0]): Promise<CoolifyPromotion | undefined> {
    this.#assertApplication(input.applicationKey);
    const result = await this.#api(`/deployments/${encodeURIComponent(input.promotionId)}`, {}, true);
    if (!result || Array.isArray(result)) return undefined;
    const current = record(result);
    assertReferenceHash(input.referenceHash);
    // Coolify's API exposes the deployed commit, not arbitrary release metadata. The Cloudflare
    // deployment independently proves the reference hash; this branch preserves it only as the
    // caller's immutable binding while verifying Coolify's exact source commit.
    return Object.freeze({ id: current.id, applicationKey: this.#applicationKey, sourceCommitSha: current.commit, referenceHash: input.referenceHash, status: status(current.status) });
  }

  public async rollback(input: Parameters<CoolifyCommitTransport["rollback"]>[0]): Promise<CoolifyPromotion> {
    this.#assertApplication(input.applicationKey);
    if (!identifier(input.currentPromotionId) || !identifier(input.targetPromotionId)) throw new CloudflareDeliveryError("COOLIFY_ROLLBACK_INVALID", "Coolify rollback deployment identifiers are invalid");
    assertCommit(input.targetCommitSha); assertReferenceHash(input.referenceHash); assertOperationKey(input.operationKey);
    await this.#api(`/applications/${encodeURIComponent(this.#applicationKey)}`, { method: "PATCH", body: JSON.stringify({ git_commit_sha: input.targetCommitSha }) });
    const result = await this.#api("/deploy", { method: "POST", body: JSON.stringify({ uuid: this.#applicationKey }) });
    const deployment = deploymentResponse(result);
    return Object.freeze({ id: deployment.id, applicationKey: this.#applicationKey, sourceCommitSha: input.targetCommitSha, referenceHash: input.referenceHash, status: "queued" });
  }

  async #api(path: string, init: RequestInit = {}, allowNotFound = false): Promise<unknown | undefined> {
    const token = await this.#apiToken();
    if (typeof token !== "string" || token.length < 16 || token.length > 16_384) throw new CloudflareDeliveryError("COOLIFY_TOKEN_INVALID", "Coolify API token capability is invalid");
    return this.#request(new URL(path.replace(/^\//, ""), this.#base), {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) }
    }, async (response, signal) => {
      if (allowNotFound && response.status === 404) return undefined;
      if (!response.ok) throw new CloudflareDeliveryError(`COOLIFY_HTTP_${response.status}`, "Coolify API request failed", response.status);
      try { return await jsonWithAbort(response, signal); } catch { throw new CloudflareDeliveryError("COOLIFY_RESPONSE_INVALID", "Coolify API response is invalid"); }
    });
  }

  #assertApplication(applicationKey: string): void {
    if (applicationKey !== this.#applicationKey) throw new CloudflareDeliveryError("COOLIFY_APPLICATION_SCOPE_DENIED", "Coolify application does not match the configured provider binding");
  }

  async #request<T>(url: URL, init: RequestInit, consume: (response: Response, signal: AbortSignal) => Promise<T> | T): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try { return await consume(await this.#fetch(url, { ...init, signal: controller.signal }), controller.signal); }
    catch (error) {
      if (controller.signal.aborted) throw new CloudflareDeliveryError("COOLIFY_TIMEOUT", "Coolify request timed out");
      throw error;
    } finally { clearTimeout(timer); }
  }
}

function coolifyBase(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new CloudflareDeliveryError("COOLIFY_CONFIG_INVALID", "Coolify API URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new CloudflareDeliveryError("COOLIFY_CONFIG_INVALID", "Coolify API URL is invalid");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  return url;
}

function deploymentResponse(value: unknown): { readonly id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CloudflareDeliveryError("COOLIFY_RESPONSE_INVALID", "Coolify deployment response is invalid");
  const deployments = (value as Record<string, unknown>).deployments;
  if (!Array.isArray(deployments) || deployments.length !== 1 || !deployments[0] || typeof deployments[0] !== "object") throw new CloudflareDeliveryError("COOLIFY_RESPONSE_INVALID", "Coolify deployment response is invalid");
  const id = (deployments[0] as Record<string, unknown>).deployment_uuid;
  if (!identifier(id)) throw new CloudflareDeliveryError("COOLIFY_RESPONSE_INVALID", "Coolify deployment response is invalid");
  return { id };
}

function record(value: unknown): { readonly id: string; readonly commit: string; readonly status: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CloudflareDeliveryError("COOLIFY_RESPONSE_INVALID", "Coolify deployment response is invalid");
  const row = value as Record<string, unknown>;
  const id = typeof row.deployment_uuid === "string" ? row.deployment_uuid : typeof row.uuid === "string" ? row.uuid : undefined;
  const commit = typeof row.commit === "string" ? row.commit : typeof row.git_commit_sha === "string" ? row.git_commit_sha : undefined;
  if (!identifier(id) || !commitSha(commit)) throw new CloudflareDeliveryError("COOLIFY_RESPONSE_INVALID", "Coolify deployment response is invalid");
  return { id, commit, status: typeof row.status === "string" ? row.status : "queued" };
}

function promotion(value: { readonly id: string; readonly commit: string; readonly status: string }, applicationKey: string, referenceHash: string): CoolifyPromotion {
  return Object.freeze({ id: value.id, applicationKey, sourceCommitSha: value.commit, referenceHash, status: status(value.status) });
}

function status(value: string): CoolifyPromotion["status"] { return value === "finished" ? "finished" : value === "failed" || value === "cancelled" || value === "cancelled-by-user" ? "failed" : value === "running" ? "running" : "queued"; }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value); }
function commitSha(value: unknown): value is string { return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
function assertCommit(value: unknown): asserts value is string { if (!commitSha(value)) throw new CloudflareDeliveryError("COOLIFY_COMMIT_INVALID", "Coolify commit must be a full immutable SHA"); }
function assertReferenceHash(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new CloudflareDeliveryError("COOLIFY_REFERENCE_INVALID", "Coolify artifact reference is invalid"); }
function assertOperationKey(value: unknown): asserts value is string { if (typeof value !== "string" || value.length < 16 || value.length > 200) throw new CloudflareDeliveryError("COOLIFY_OPERATION_INVALID", "Coolify operation key is invalid"); }
function timeoutMs(value: number | undefined): number { if (value === undefined) return 10_000; if (!Number.isInteger(value) || value < 10 || value > 60_000) throw new CloudflareDeliveryError("COOLIFY_TIMEOUT_INVALID", "Coolify request timeout is invalid"); return value; }
async function jsonWithAbort(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  return Promise.race([
    response.json() as Promise<unknown>,
    new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }))
  ]);
}
