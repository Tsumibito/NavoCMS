import { sha256 } from "@navocms/kernel";
import { hash as blake3 } from "blake3-wasm";
import { extname } from "node:path";

import {
  CloudflareDeliveryError,
  type CloudflareDeployment,
  type CloudflareLiveProbe,
  type CloudflarePagesTransport,
  type ImmutableArtifactFile,
  type ImmutableArtifactReference
} from "./index.js";

const API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_PAGES = 10;
// Pages deployment listing rejects values above 25 (error 8000024).
const PAGE_SIZE = 25;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchCloudflarePagesTransportOptions {
  readonly accountId: string;
  readonly projectKey: string;
  /** Resolve from an encrypted runtime store; this adapter never logs or persists it. */
  readonly apiToken: () => Promise<string>;
  readonly fetcher?: typeof fetch;
  readonly apiBaseUrl?: string;
  /** A Pages preview must remain on a configured HTTPS hostname suffix. */
  readonly previewHostnameSuffix?: string;
  /** Exact production/staging alias; never inferred from the preview namespace. */
  readonly productionHostname?: string;
  /** The only branch that may create a Pages production deployment. */
  readonly productionBranch: string;
  /** Bound every API request and the complete sequential live-probe operation. */
  readonly timeoutMs?: number;
}

/**
 * Concrete Cloudflare Pages Direct Upload transport. It is inert until a host provides an API
 * token callback and explicitly selects it. Static output is content-addressed before upload.
 */
export class FetchCloudflarePagesTransport implements CloudflarePagesTransport {
  readonly #accountId: string;
  readonly #projectKey: string;
  readonly #apiToken: () => Promise<string>;
  readonly #fetch: typeof fetch;
  readonly #base: URL;
  readonly #previewSuffix: string;
  readonly #productionHostname: string | undefined;
  readonly #productionBranch: string;
  readonly #timeoutMs: number;

  public constructor(options: FetchCloudflarePagesTransportOptions) {
    if (!identifier(options.accountId, 32) || !identifier(options.projectKey, 160) || !identifier(options.productionBranch, 160)) throw new CloudflareDeliveryError("CLOUDFLARE_CONFIG_INVALID", "Cloudflare account or project identifier is invalid");
    this.#base = apiBase(options.apiBaseUrl ?? API_BASE);
    this.#previewSuffix = hostnameSuffix(options.previewHostnameSuffix ?? ".pages.dev");
    this.#productionHostname = options.productionHostname ? exactHostname(options.productionHostname) : undefined;
    this.#accountId = options.accountId;
    this.#projectKey = options.projectKey;
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetcher ?? fetch;
    this.#productionBranch = options.productionBranch;
    this.#timeoutMs = timeoutMs(options.timeoutMs);
  }

  public async findDeployment(input: Parameters<CloudflarePagesTransport["findDeployment"]>[0]): Promise<CloudflareDeployment | undefined> {
    this.#assertProject(input.projectKey);
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await this.#api(`/accounts/${this.#accountId}/pages/projects/${this.#projectKey}/deployments?page=${page}&per_page=${PAGE_SIZE}`);
      const rows = resultArray(requiredResponse(response));
      for (const row of rows) {
        const candidate = recordObject(row);
        if (commitMessage(candidate) === marker(input.referenceHash, input.environment)) {
          const value = deployment(candidate, this.#projectKey, input.referenceHash);
          if (value.environment !== input.environment) throw new CloudflareDeliveryError("CLOUDFLARE_ENVIRONMENT_MISMATCH", "Cloudflare deployment environment does not match its immutable marker");
          return value;
        }
      }
      if (rows.length < PAGE_SIZE) return undefined;
    }
    throw new CloudflareDeliveryError("CLOUDFLARE_PAGINATION_BOUND", "Cloudflare deployment search exceeded the configured page bound");
  }

  public async createPreview(input: Parameters<CloudflarePagesTransport["createPreview"]>[0]): Promise<CloudflareDeployment> {
    if (input.previewBranch === this.#productionBranch) throw new CloudflareDeliveryError("CLOUDFLARE_PRODUCTION_BRANCH_DENIED", "Preview deployment may not use the production branch");
    return this.#create(input, input.previewBranch, "preview");
  }

  public async deployProduction(input: Parameters<CloudflarePagesTransport["deployProduction"]>[0]): Promise<CloudflareDeployment> {
    if (input.productionBranch !== this.#productionBranch) throw new CloudflareDeliveryError("CLOUDFLARE_PRODUCTION_BRANCH_DENIED", "Production deployment must use the configured production branch");
    return this.#create(input, input.productionBranch, "production");
  }

  public async retryDeployment(input: Parameters<CloudflarePagesTransport["retryDeployment"]>[0]): Promise<CloudflareDeployment> {
    this.#assertProject(input.projectKey);
    if (!identifier(input.deploymentId, 160) || !hash(input.referenceHash)) throw new CloudflareDeliveryError("CLOUDFLARE_RETRY_INVALID", "Cloudflare retry binding is invalid");
    const response = await this.#api(`/accounts/${this.#accountId}/pages/projects/${this.#projectKey}/deployments/${encodeURIComponent(input.deploymentId)}/retry`, { method: "POST" });
    const row = resultObject(requiredResponse(response));
    if (input.environment === "preview") previewUrl(row, this.#projectKey, this.#previewSuffix);
    const value = deployment(row, this.#projectKey, input.referenceHash);
    if (value.environment !== input.environment) throw new CloudflareDeliveryError("CLOUDFLARE_ENVIRONMENT_MISMATCH", "Cloudflare retry returned the wrong deployment environment");
    return value;
  }

  async #create(input: Readonly<{ projectKey: string; reference: ImmutableArtifactReference; referenceHash: string; files: Readonly<Record<string, string>> }>, branch: string, environment: "preview" | "production"): Promise<CloudflareDeployment> {
    this.#assertProject(input.projectKey);
    assertImmutableFiles(input.reference, input.files);
    await this.#preflightBranch(branch, environment);
    const fileEntries = Object.entries(input.files).sort(([left], [right]) => left.localeCompare(right));
    const hashes = fileEntries.map(([path, body]) => pagesAssetHash(path, body));
    if (fileEntries.length !== input.reference.fileCount || hashes.length < 1 || hashes.length > 512) throw new CloudflareDeliveryError("CLOUDFLARE_ASSET_BOUNDS", "Cloudflare asset manifest exceeds delivery bounds");

    const uploadToken = await this.#uploadToken();
    const missing = await providerPhase("ASSET_CHECK", () => this.#uploadJson("/pages/assets/check-missing", uploadToken, { hashes }));
    const missingHashes = new Set(resultArray(missing).filter((value): value is string => typeof value === "string"));
    const assets = fileEntries.flatMap(([path, body]) => {
      const key = pagesAssetHash(path, body);
      return missingHashes.has(key) ? [{ key, value: Buffer.from(body).toString("base64"), base64: true, metadata: { contentType: contentType(path) } }] : [];
    });
    if (assets.length > 0) await providerPhase("ASSET_UPLOAD", () => this.#uploadJson("/pages/assets/upload", uploadToken, assets));

    const form = new FormData();
    form.set("branch", branch);
    form.set("commit_dirty", "false");
    form.set("commit_hash", input.reference.sourceCommitSha);
    form.set("commit_message", marker(input.referenceHash, environment));
    // Pages Direct Upload uses URL-rooted manifest keys. The build output
    // directory is a local Wrangler setting and is not part of this multipart
    // API contract.
    form.set("manifest", JSON.stringify(Object.fromEntries(fileEntries.map(([path, body]) => [`/${path}`, pagesAssetHash(path, body)]))));
    // This file is derived solely from the immutable reference and lets a bounded HTTPS probe
    // confirm the deployed output without trusting a mutable preview URL or response body.
    form.set("_headers", new Blob([headersFile(input.reference, input.referenceHash, environment)], { type: "text/plain" }), "_headers");
    const response = await providerPhase("DEPLOY", () => this.#api(`/accounts/${this.#accountId}/pages/projects/${this.#projectKey}/deployments`, {
      method: "POST", body: form
    }));
    const row = resultObject(requiredResponse(response));
    const value = deployment(row, this.#projectKey, input.referenceHash);
    if (value.environment !== environment) throw new CloudflareDeliveryError("CLOUDFLARE_ENVIRONMENT_MISMATCH", "Cloudflare deployment did not return the requested environment");
    if (environment === "preview") previewUrl(row, this.#projectKey, this.#previewSuffix);
    return value;
  }

  public async inspectDeployment(input: Parameters<CloudflarePagesTransport["inspectDeployment"]>[0]): Promise<CloudflareDeployment | undefined> {
    this.#assertProject(input.projectKey);
    const response = await this.#api(`/accounts/${this.#accountId}/pages/projects/${this.#projectKey}/deployments/${encodeURIComponent(input.deploymentId)}`, {}, true);
    if (response === undefined) return undefined;
    const row = resultObject(requiredResponse(response));
    const referenceHash = markerHash(commitMessage(row));
    return referenceHash ? deployment(row, this.#projectKey, referenceHash) : undefined;
  }

  public async verifyLive(input: Parameters<CloudflarePagesTransport["verifyLive"]>[0]): Promise<CloudflareLiveProbe> {
    this.#assertProject(input.projectKey);
    if (input.environment !== "production") throw new CloudflareDeliveryError("CLOUDFLARE_LIVE_ENVIRONMENT_DENIED", "Only authoritative production output may be verified as live");
    const deadline = Date.now() + this.#timeoutMs;
    const project = resultObject(requiredResponse(await this.#api(`/accounts/${this.#accountId}/pages/projects/${this.#projectKey}`, {}, false, deadline)));
    const canonical = canonicalDeployment(project, this.#productionBranch, input.deploymentId);
    const url = canonicalAlias(canonical, this.#previewSuffix, this.#productionHostname);
    const files: ImmutableArtifactFile[] = [];
    let headers: Headers | undefined;
    for (const expected of input.reference.files) {
      const live = await this.#request(new URL(expected.path, url.endsWith("/") ? url : `${url}/`), { method: "GET", redirect: "error", headers: { "accept": "*/*" } }, async (response, signal) => {
        if (!response.ok) return { status: response.status, headers: response.headers };
        return { status: response.status, headers: response.headers, body: await boundedBody(response, expected.byteSize, signal) };
      }, remaining(deadline));
      if (!headers) headers = live.headers;
      if (live.status < 200 || live.status >= 300) return Object.freeze({ status: live.status });
      const body = live.body;
      if (body === undefined) throw new CloudflareDeliveryError("CLOUDFLARE_LIVE_BODY_MISSING", "Cloudflare live response has no body");
      const digest = sha256(body);
      if (digest !== expected.sha256 || Buffer.byteLength(body, "utf8") !== expected.byteSize) throw new CloudflareDeliveryError("CLOUDFLARE_LIVE_BYTES_MISMATCH", "Cloudflare live bytes do not match the immutable artifact reference");
      files.push(Object.freeze({ path: expected.path, sha256: digest, byteSize: expected.byteSize }));
    }
    return Object.freeze({
      status: 200,
      ...(headers?.get("x-navocms-artifact-reference") ? { referenceHash: headers.get("x-navocms-artifact-reference")! } : {}),
      ...(headers?.get("x-navocms-release-hash") ? { releaseHash: headers.get("x-navocms-release-hash")! } : {}),
      ...(headers?.get("x-navocms-output-hash") ? { outputHash: headers.get("x-navocms-output-hash")! } : {}),
      ...(headers?.get("cache-control") ? { cacheControl: headers.get("cache-control")! } : {}),
      files: Object.freeze(files)
    });
  }

  public async rollback(input: Parameters<CloudflarePagesTransport["rollback"]>[0]): Promise<void> {
    this.#assertProject(input.projectKey);
    if (input.currentEnvironment !== "production" || input.targetEnvironment !== "production" || !identifier(input.currentDeploymentId, 160) || !identifier(input.targetDeploymentId, 160) || !operationKey(input.operationKey)) throw new CloudflareDeliveryError("CLOUDFLARE_ROLLBACK_INVALID", "Cloudflare rollback binding is invalid");
    await this.#api(`/accounts/${this.#accountId}/pages/projects/${this.#projectKey}/deployments/${encodeURIComponent(input.targetDeploymentId)}/rollback`, { method: "POST" });
  }

  async #uploadToken(): Promise<string> {
    const response = await this.#api(`/accounts/${this.#accountId}/pages/projects/${this.#projectKey}/upload-token`);
    const token = resultObject(requiredResponse(response)).jwt;
    if (typeof token !== "string" || token.length < 16 || token.length > 16_384) throw new CloudflareDeliveryError("CLOUDFLARE_UPLOAD_TOKEN_INVALID", "Cloudflare direct-upload token response is invalid");
    return token;
  }

  async #uploadJson(path: string, token: string, body: unknown): Promise<Record<string, unknown>> {
    return this.#request(apiUrl(this.#base, path), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    }, (response, signal) => parseResponse(response, signal));
  }

  async #api(path: string, init: RequestInit = {}, allowNotFound = false, deadline?: number): Promise<Record<string, unknown> | undefined> {
    const token = await this.#apiToken();
    if (typeof token !== "string" || token.length < 16 || token.length > 16_384) throw new CloudflareDeliveryError("CLOUDFLARE_TOKEN_INVALID", "Cloudflare API token capability is invalid");
    return this.#request(apiUrl(this.#base, path), {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) }
    }, (response, signal) => {
      if (allowNotFound && response.status === 404) return undefined;
      return parseResponse(response, signal);
    }, deadline === undefined ? this.#timeoutMs : remaining(deadline));
  }

  #assertProject(projectKey: string): void {
    if (projectKey !== this.#projectKey) throw new CloudflareDeliveryError("CLOUDFLARE_PROJECT_SCOPE_DENIED", "Cloudflare project does not match the configured provider binding");
  }

  async #preflightBranch(branch: string, environment: "preview" | "production"): Promise<void> {
    const project = resultObject(requiredResponse(await this.#api(`/accounts/${this.#accountId}/pages/projects/${this.#projectKey}`)));
    const actual = project.production_branch;
    if (typeof actual !== "string" || !identifier(actual, 160) || actual !== this.#productionBranch) throw new CloudflareDeliveryError("CLOUDFLARE_PRODUCTION_BRANCH_MISMATCH", "Cloudflare project production branch does not match the configured binding");
    if ((environment === "preview" && branch === actual) || (environment === "production" && branch !== actual)) throw new CloudflareDeliveryError("CLOUDFLARE_PRODUCTION_BRANCH_DENIED", "Cloudflare deployment branch does not match its allowed environment");
  }

  async #request<T>(url: URL, init: RequestInit, consume: (response: Response, signal: AbortSignal) => Promise<T> | T, budget = this.#timeoutMs): Promise<T> {
    if (!Number.isFinite(budget) || budget <= 0) throw new CloudflareDeliveryError("CLOUDFLARE_TIMEOUT", "Cloudflare request deadline elapsed");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const response = await this.#fetch(url, { ...init, signal: controller.signal });
      return await consume(response, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new CloudflareDeliveryError("CLOUDFLARE_TIMEOUT", "Cloudflare request timed out");
      throw error;
    } finally { clearTimeout(timer); }
  }
}

function apiBase(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new CloudflareDeliveryError("CLOUDFLARE_CONFIG_INVALID", "Cloudflare API URL is invalid"); }
  url.pathname = url.pathname.replace(/\/$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/v4")) throw new CloudflareDeliveryError("CLOUDFLARE_CONFIG_INVALID", "Cloudflare API URL is invalid");
  url.pathname = `${url.pathname}/`;
  return url;
}

function apiUrl(base: URL, path: string): URL { return new URL(path.replace(/^\//, ""), base); }

function hostnameSuffix(value: string): string {
  if (!/^\.[a-z0-9.-]{3,253}$/.test(value) || value.includes("..")) throw new CloudflareDeliveryError("CLOUDFLARE_CONFIG_INVALID", "Cloudflare preview hostname suffix is invalid");
  return value;
}
function exactHostname(value: string): string { if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value) || value.includes("..")) throw new CloudflareDeliveryError("CLOUDFLARE_CONFIG_INVALID", "Cloudflare production hostname is invalid"); return value; }

function previewUrl(row: Record<string, unknown>, projectKey: string, suffix: string): string {
  const url = row.url;
  if (typeof url !== "string") throw new CloudflareDeliveryError("CLOUDFLARE_PREVIEW_INVALID", "Cloudflare deployment has no HTTPS preview URL");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new CloudflareDeliveryError("CLOUDFLARE_PREVIEW_INVALID", "Cloudflare deployment preview URL is invalid"); }
  const projectSuffix = `.${projectKey}${suffix}`;
  const label = parsed.hostname.endsWith(projectSuffix) ? parsed.hostname.slice(0, -projectSuffix.length) : "";
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash || !label || label.includes(".") || !/^[a-z0-9-]{1,63}$/.test(label)) throw new CloudflareDeliveryError("CLOUDFLARE_PREVIEW_INVALID", "Cloudflare deployment preview URL is outside the configured Pages scope");
  return parsed.toString();
}

function canonicalDeployment(project: Record<string, unknown>, productionBranch: string, deploymentId: string): Record<string, unknown> {
  if (project.production_branch !== productionBranch) throw new CloudflareDeliveryError("CLOUDFLARE_PRODUCTION_BRANCH_MISMATCH", "Cloudflare project production branch does not match the configured binding");
  const canonical = project.canonical_deployment;
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) throw new CloudflareDeliveryError("CLOUDFLARE_CANONICAL_DEPLOYMENT_MISSING", "Cloudflare project has no authoritative production deployment");
  const row = canonical as Record<string, unknown>;
  if (row.id !== deploymentId || row.environment !== "production") throw new CloudflareDeliveryError("CLOUDFLARE_CANONICAL_DEPLOYMENT_MISMATCH", "Cloudflare canonical production deployment does not match the recorded release");
  return row;
}

function canonicalAlias(row: Record<string, unknown>, suffix: string, expectedHostname?: string): string {
  const aliases = row.aliases;
  if (aliases !== null && (!Array.isArray(aliases) || aliases.length > 64 || !aliases.every((value) => typeof value === "string"))) throw new CloudflareDeliveryError("CLOUDFLARE_CANONICAL_ALIAS_INVALID", "Cloudflare canonical deployment aliases are invalid");
  const candidates = [...(Array.isArray(aliases) ? aliases : []), row.url];
  for (const alias of candidates) {
    if (typeof alias !== "string") continue;
    try {
      const url = new URL(alias);
      const pagesDeploymentHostname = expectedHostname?.endsWith(suffix)
        ? url.hostname.endsWith(`.${expectedHostname}`) && !url.hostname.slice(0, -(expectedHostname.length + 1)).includes(".")
        : false;
      if (url.protocol === "https:" && !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash && (expectedHostname ? url.hostname === expectedHostname || pagesDeploymentHostname : url.hostname.endsWith(suffix))) return url.toString();
    } catch { /* bounded hostile alias is ignored */ }
  }
  throw new CloudflareDeliveryError("CLOUDFLARE_CANONICAL_ALIAS_INVALID", "Cloudflare canonical deployment has no allowed Pages alias");
}

function deployment(row: Record<string, unknown>, projectKey: string, referenceHash: string): CloudflareDeployment {
  const id = row.id;
  const environment = row.environment;
  if (!identifier(id, 160) || (environment !== "preview" && environment !== "production")) throw new CloudflareDeliveryError("CLOUDFLARE_RESPONSE_INVALID", "Cloudflare deployment response is invalid");
  return Object.freeze({ id, projectKey, referenceHash, environment, status: deploymentStatus(row) });
}

function deploymentStatus(row: Record<string, unknown>): CloudflareDeployment["status"] {
  const status = nested(row, ["latest_stage", "status"]);
  if (status === "success") return "success";
  if (status === "failure") return "failure";
  if (status === "canceled") return "canceled";
  if (status === "active") return "building";
  return "queued";
}

function headersFile(reference: ImmutableArtifactReference, referenceHash: string, environment: "preview" | "production"): string {
  const cacheControl = environment === "preview" ? "private, no-store" : "public, max-age=300, must-revalidate";
  return `/*\n  X-NavoCMS-Artifact-Reference: ${referenceHash}\n  X-NavoCMS-Release-Hash: ${reference.releaseHash}\n  X-NavoCMS-Output-Hash: ${reference.outputHash}\n  Cache-Control: ${cacheControl}\n`;
}

function assertImmutableFiles(reference: ImmutableArtifactReference, files: Readonly<Record<string, string>>): void {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  if (reference.schema !== "io.navocms.cloudflare-artifact-reference.v1" || entries.length !== reference.fileCount || entries.length < 1 || entries.length > 512) throw new CloudflareDeliveryError("CLOUDFLARE_ASSET_BOUNDS", "Cloudflare asset reference is invalid");
  const ordered: Record<string, string> = {};
  let byteSize = 0;
  for (const [path, body] of entries) {
    if (!safeOutputPath(path) || typeof body !== "string") throw new CloudflareDeliveryError("CLOUDFLARE_ASSET_INVALID", "Cloudflare asset path is invalid");
    ordered[path] = body;
    byteSize += Buffer.byteLength(body, "utf8");
  }
  const manifest = Object.entries(ordered).map(([path, body]) => ({ path, sha256: sha256(body), byteSize: Buffer.byteLength(body, "utf8") }));
  if (byteSize !== reference.byteSize || byteSize > 8 * 1024 * 1024 || sha256(canonical(ordered)) !== reference.outputHash || sha256(canonical(Object.keys(ordered).filter((path) => path.endsWith(".html")).sort())) !== reference.routeDigest || canonical(manifest) !== canonical(reference.files)) throw new CloudflareDeliveryError("CLOUDFLARE_ASSET_REFERENCE_MISMATCH", "Cloudflare assets do not match immutable reference");
}

function marker(referenceHash: string, environment: "preview" | "production"): string { return `navocms:${environment}:${referenceHash}`; }
function markerHash(value: string | undefined): string | undefined { return value && /^navocms:(?:preview|production):[a-f0-9]{64}$/.test(value) ? value.slice(value.lastIndexOf(":") + 1) : undefined; }
function commitMessage(row: Record<string, unknown>): string | undefined { const value = nested(row, ["deployment_trigger", "metadata", "commit_message"]); return typeof value === "string" ? value : undefined; }
function resultObject(value: Record<string, unknown>): Record<string, unknown> { const result = value.result; if (!result || typeof result !== "object" || Array.isArray(result)) throw new CloudflareDeliveryError("CLOUDFLARE_RESPONSE_INVALID", "Cloudflare API response is invalid"); return result as Record<string, unknown>; }
function resultArray(value: Record<string, unknown>): unknown[] { const result = value.result; if (!Array.isArray(result)) throw new CloudflareDeliveryError("CLOUDFLARE_RESPONSE_INVALID", "Cloudflare API response is invalid"); return result; }
function requiredResponse(value: Record<string, unknown> | undefined): Record<string, unknown> { if (!value) throw new CloudflareDeliveryError("CLOUDFLARE_RESPONSE_INVALID", "Cloudflare API response is invalid"); return value; }
function recordObject(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new CloudflareDeliveryError("CLOUDFLARE_RESPONSE_INVALID", "Cloudflare API response is invalid"); return value as Record<string, unknown>; }
function nested(value: Record<string, unknown>, keys: readonly string[]): unknown { let current: unknown = value; for (const key of keys) { if (!current || typeof current !== "object" || Array.isArray(current)) return undefined; current = (current as Record<string, unknown>)[key]; } return current; }
function identifier(value: unknown, maximum: number): value is string { return typeof value === "string" && new TextEncoder().encode(value).byteLength <= maximum && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value); }
function operationKey(value: unknown): value is string { return typeof value === "string" && value.length >= 16 && value.length <= 200; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function timeoutMs(value: number | undefined): number { if (value === undefined) return DEFAULT_TIMEOUT_MS; if (!Number.isInteger(value) || value < 10 || value > 60_000) throw new CloudflareDeliveryError("CLOUDFLARE_TIMEOUT_INVALID", "Cloudflare request timeout is invalid"); return value; }
function remaining(deadline: number): number { return Math.max(0, deadline - Date.now()); }

async function boundedBody(response: Response, expectedBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new CloudflareDeliveryError("CLOUDFLARE_LIVE_BODY_MISSING", "Cloudflare live response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await readWithAbort(reader, signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > expectedBytes) {
        await reader.cancel();
        throw new CloudflareDeliveryError("CLOUDFLARE_LIVE_BODY_OVERSIZED", "Cloudflare live response exceeds its immutable file bound");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<any> {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  return Promise.race([
    reader.read(),
    new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }))
  ]);
}
function contentType(path: string): string { return path.endsWith(".html") ? "text/html; charset=utf-8" : path.endsWith(".css") ? "text/css; charset=utf-8" : path.endsWith(".js") ? "application/javascript; charset=utf-8" : path.endsWith(".json") ? "application/json" : "application/octet-stream"; }
/** Cloudflare Pages uses Wrangler's truncated BLAKE3 identity, not the artifact SHA-256. */
function pagesAssetHash(path: string, body: string): string {
  const extension = extname(path).slice(1);
  const identity = `${Buffer.from(body).toString("base64")}${extension}`;
  return blake3(identity).toString("hex").slice(0, 32);
}
function safeOutputPath(value: string): boolean { return /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/$)[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && Buffer.byteLength(value, "utf8") <= 512; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }

async function parseResponse(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.ok) throw new CloudflareDeliveryError(`CLOUDFLARE_HTTP_${response.status}`, "Cloudflare API request failed", response.status);
  let value: unknown;
  try { value = await jsonWithAbort(response, signal); } catch { throw new CloudflareDeliveryError("CLOUDFLARE_RESPONSE_INVALID", "Cloudflare API response is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || ("success" in value && value.success !== true)) throw new CloudflareDeliveryError("CLOUDFLARE_RESPONSE_INVALID", "Cloudflare API response is invalid");
  return value as Record<string, unknown>;
}

async function providerPhase<T>(phase: "ASSET_CHECK" | "ASSET_UPLOAD" | "DEPLOY", action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CloudflareDeliveryError && /^CLOUDFLARE_HTTP_[1-5][0-9]{2}$/.test(error.code)) {
      throw new CloudflareDeliveryError(`CLOUDFLARE_${phase}_HTTP_${error.httpStatus}`, "Cloudflare provider phase failed", error.httpStatus);
    }
    throw error;
  }
}

async function jsonWithAbort(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  return Promise.race([
    response.json() as Promise<unknown>,
    new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }))
  ]);
}
