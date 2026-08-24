import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import type { MediaAssetSummary, MediaRepository, MediaScope, RemoteMediaIngestInput, RemoteMediaIngestor } from "./domain.js";
import { sha256, type MediaStorage } from "./storage.js";
import { assertPublicAddress, assertSafeRemoteUrl, inspectMedia, MEDIA_LIMITS, sniffMediaType, type SupportedMediaType } from "./validation.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const REMOTE_INTENT_TTL_MS = 5 * 60 * 1000;

export interface RemoteDnsResolver {
  lookup(hostname: string): Promise<readonly Readonly<{ address: string; family: 4 | 6 }>[]>
}

export interface RemoteResponseBody extends AsyncIterable<Uint8Array> {
  abort(reason?: Error): void;
}

export interface RemoteFetchRequest {
  readonly url: URL;
  /** A DNS result validated immediately before this request. */
  readonly connectIp: string;
  /** Original authority, retained for virtual hosting. */
  readonly hostHeader: string;
  /** Original hostname, retained for TLS SNI. */
  readonly serverName: string;
  readonly timeoutMs: number;
  /** One end-to-end deadline shared by DNS, redirects, headers, and body. */
  readonly signal: AbortSignal;
}

export interface RemoteFetchResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: RemoteResponseBody;
  abort(reason?: Error): void;
}

/** A transport deliberately has no redirect or credential surface. */
export interface RemoteFetchTransport {
  get(request: RemoteFetchRequest): Promise<RemoteFetchResponse>;
}

export interface RemoteMediaIngestOptions {
  readonly resolver?: RemoteDnsResolver;
  readonly transport?: RemoteFetchTransport;
  readonly timeoutMs?: number;
  readonly clock?: () => Date;
}

/**
 * Fetches a remote original only after every address has been validated and
 * connects to the selected, already validated address.  It does not write an
 * object until the existing upload-intent/finalize flow has accepted metadata.
 */
export class RemoteMediaIngestService implements RemoteMediaIngestor {
  readonly #repository: Pick<MediaRepository, "createUploadIntent" | "finalizeUpload">;
  readonly #storage: MediaStorage;
  readonly #resolver: RemoteDnsResolver;
  readonly #transport: RemoteFetchTransport;
  readonly #timeoutMs: number;
  readonly #clock: () => Date;

  public constructor(
    repository: Pick<MediaRepository, "createUploadIntent" | "finalizeUpload">,
    storage: MediaStorage,
    options: RemoteMediaIngestOptions = {}
  ) {
    this.#repository = repository;
    this.#storage = storage;
    this.#resolver = options.resolver ?? new NodeDnsResolver();
    this.#transport = options.transport ?? new NodeHttpsRemoteTransport();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#clock = options.clock ?? (() => new Date());
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) throw new Error("REMOTE_TIMEOUT_INVALID");
  }

  public async ingestRemote(scope: MediaScope, input: RemoteMediaIngestInput): Promise<MediaAssetSummary> {
    const receivedAt = assertRemoteInput(input, this.#clock());
    const sourceUrl = assertSafeRemoteUrl(input.sourceUrl);
    const remote = await this.fetch(sourceUrl);
    const expiresAt = new Date(receivedAt + REMOTE_INTENT_TTL_MS).toISOString();
    const create = await this.#repository.createUploadIntent(scope, {
      idempotencyKey: input.idempotencyKey,
      expectedSha256: sha256(remote.bytes),
      expectedSize: remote.bytes.byteLength,
      expectedMediaType: remote.mediaType,
      expiresAt,
      provenance: Object.freeze({
        kind: "remote-ingest",
        sourceUrl: sourceUrl.toString(),
        receivedAt: new Date(receivedAt).toISOString(),
        receivedBy: scope.principalId
      }),
      rights: input.rights
    });
    if (create.kind === "deduplicated") return create.asset;
    await this.#storage.putImmutable({ key: create.storageKey, bytes: remote.bytes, mediaType: remote.mediaType });
    return this.#repository.finalizeUpload(scope, {
      intentId: create.intentId,
      idempotencyKey: input.idempotencyKey,
      uploadedStorageKey: create.storageKey
    });
  }

  private async fetch(initialUrl: URL): Promise<Readonly<{ bytes: Uint8Array; mediaType: SupportedMediaType }>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("REMOTE_TIMEOUT")), this.#timeoutMs);
    try {
      return await this.fetchWithinDeadline(initialUrl, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchWithinDeadline(initialUrl: URL, signal: AbortSignal): Promise<Readonly<{ bytes: Uint8Array; mediaType: SupportedMediaType }>> {
    let url = initialUrl;
    let redirects = 0;
    for (;;) {
      const hostname = stripIpv6Brackets(url.hostname);
      const addresses = await this.resolve(hostname, signal);
      let response: RemoteFetchResponse;
      try {
        response = await beforeAbort(this.#transport.get({
          url,
          connectIp: addresses[0]!,
          hostHeader: url.host,
          serverName: hostname,
          timeoutMs: this.#timeoutMs,
          signal
        }), signal);
      } catch {
        if (signal.aborted) throw new Error("REMOTE_TIMEOUT");
        throw new Error("REMOTE_FETCH_FAILED");
      }
      if (isRedirect(response.status)) {
        response.abort(new Error("REMOTE_REDIRECT"));
        if (redirects >= MEDIA_LIMITS.maxRedirects) throw new Error("REMOTE_REDIRECT_LIMIT");
        const location = header(response.headers, "location");
        if (!location) throw new Error("REMOTE_REDIRECT_LOCATION_MISSING");
        let target: URL;
        try { target = new URL(location, url); } catch { throw new Error("REMOTE_REDIRECT_URL_INVALID"); }
        url = assertSafeRemoteUrl(target.toString());
        redirects += 1;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        response.abort(new Error("REMOTE_STATUS"));
        throw new Error("REMOTE_STATUS_INVALID");
      }
      const encoding = header(response.headers, "content-encoding");
      if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
        response.abort(new Error("REMOTE_CONTENT_ENCODING"));
        throw new Error("REMOTE_CONTENT_ENCODING_FORBIDDEN");
      }
      let declaredLength: number | undefined;
      try { declaredLength = contentLength(header(response.headers, "content-length")); } catch {
        response.abort(new Error("REMOTE_CONTENT_LENGTH_INVALID"));
        throw new Error("REMOTE_CONTENT_LENGTH_INVALID");
      }
      if (declaredLength !== undefined && declaredLength > MEDIA_LIMITS.maxBytes) {
        response.abort(new Error("REMOTE_BODY_LIMIT"));
        throw new Error("REMOTE_BODY_TOO_LARGE");
      }
      const bytes = await readBounded(response, signal);
      const mediaType = sniffMediaType(bytes);
      const declaredType = normalizeMediaType(header(response.headers, "content-type"));
      if (declaredType !== undefined && declaredType !== mediaType) throw new Error("REMOTE_MIME_MISMATCH");
      inspectMedia(bytes, mediaType);
      return Object.freeze({ bytes, mediaType });
    }
  }

  private async resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]> {
    const directFamily = isIP(hostname);
    let resolved: readonly Readonly<{ address: string; family: 4 | 6 }>[];
    try {
      resolved = directFamily === 0
        ? await beforeAbort(this.#resolver.lookup(hostname), signal)
        : Object.freeze([{ address: hostname, family: directFamily as 4 | 6 }]);
    } catch {
      if (signal.aborted) throw new Error("REMOTE_TIMEOUT");
      throw new Error("REMOTE_DNS_FAILED");
    }
    if (signal.aborted) throw new Error("REMOTE_TIMEOUT");
    if (resolved.length === 0) throw new Error("REMOTE_DNS_EMPTY");
    for (const result of resolved) {
      if ((result.family !== 4 && result.family !== 6) || isIP(result.address) !== result.family) throw new Error("REMOTE_DNS_INVALID");
      assertPublicAddress(result.address);
    }
    return Object.freeze(resolved.map((result) => result.address));
  }
}

export class NodeDnsResolver implements RemoteDnsResolver {
  public async lookup(hostname: string): Promise<readonly Readonly<{ address: string; family: 4 | 6 }>[]> {
    const results = await lookup(hostname, { all: true, order: "verbatim" });
    return Object.freeze(results.map((result) => Object.freeze({ address: result.address, family: result.family as 4 | 6 })));
  }
}

/** Node transport pins TCP to connectIp and retains the URL authority for Host/SNI. */
export class NodeHttpsRemoteTransport implements RemoteFetchTransport {
  public async get(input: RemoteFetchRequest): Promise<RemoteFetchResponse> {
    return new Promise((resolve, reject) => {
      const request = httpsRequest({
        protocol: "https:",
        hostname: input.connectIp,
        port: 443,
        method: "GET",
        path: `${input.url.pathname}${input.url.search}`,
        servername: input.serverName,
        headers: { host: input.hostHeader, accept: "image/jpeg, image/png", "accept-encoding": "identity" },
        timeout: input.timeoutMs,
        signal: input.signal,
        agent: false
      }, (response) => {
        const body = response as unknown as RemoteResponseBody;
        const abort = (reason?: Error) => {
          response.destroy(reason);
          request.destroy(reason);
        };
        resolve(Object.freeze({ status: response.statusCode ?? 0, headers: responseHeaders(response.headers), body, abort }));
      });
      request.once("timeout", () => request.destroy(new Error("REMOTE_TIMEOUT")));
      request.once("error", (error) => reject(new Error(`REMOTE_FETCH_FAILED:${safeErrorCode(error)}`)));
      request.end();
    });
  }
}

async function readBounded(response: RemoteFetchResponse, signal: AbortSignal): Promise<Uint8Array> {
  const iterator = response.body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await beforeAbort(iterator.next(), signal);
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      const remainingBytes = MEDIA_LIMITS.maxBytes + 1 - total;
      const copied = chunk.subarray(0, Math.max(0, remainingBytes));
      total += copied.byteLength;
      if (total > MEDIA_LIMITS.maxBytes || copied.byteLength !== chunk.byteLength) throw new Error("REMOTE_BODY_TOO_LARGE");
      chunks.push(new Uint8Array(copied));
    }
  } catch (error) {
    const safe = signal.aborted ? new Error("REMOTE_TIMEOUT") : error instanceof Error && ["REMOTE_TIMEOUT", "REMOTE_BODY_TOO_LARGE"].includes(error.message)
      ? error : new Error("REMOTE_BODY_FAILED");
    response.abort(safe);
    throw safe;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function beforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("REMOTE_TIMEOUT");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("REMOTE_TIMEOUT"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

function assertRemoteInput(input: RemoteMediaIngestInput, now: Date): number {
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128 ||
    typeof input.sourceUrl !== "string" || input.sourceUrl.length < 1 || input.sourceUrl.length > 2048) throw new Error("REMOTE_INGEST_INPUT_INVALID");
  const receivedAt = Date.parse(input.receivedAt);
  if (!Number.isFinite(receivedAt) || receivedAt < now.getTime() - REMOTE_INTENT_TTL_MS || receivedAt > now.getTime() + 60_000) throw new Error("REMOTE_INGEST_RECEIVED_AT_INVALID");
  assertRights(input.rights);
  return receivedAt;
}

function assertRights(rights: Readonly<Record<string, unknown>>): void {
  if (!rights || Object.getPrototypeOf(rights) !== Object.prototype || Object.keys(rights).length > 16) throw new Error("REMOTE_INGEST_RIGHTS_INVALID");
  let serialized: string | undefined;
  try { serialized = JSON.stringify(rights); } catch { throw new Error("REMOTE_INGEST_RIGHTS_INVALID"); }
  if (serialized === undefined || Buffer.byteLength(serialized) > 8 * 1024 || typeof rights.license !== "string" || !rights.license.trim() || rights.license.length > 200 || typeof rights.restricted !== "boolean" ||
    (rights.holder !== undefined && (typeof rights.holder !== "string" || rights.holder.length > 200)) ||
    (rights.expiresAt !== undefined && (typeof rights.expiresAt !== "string" || !Number.isFinite(Date.parse(rights.expiresAt)))) ||
    Object.keys(rights).some((key) => !["license", "holder", "expiresAt", "restricted"].includes(key))) throw new Error("REMOTE_INGEST_RIGHTS_INVALID");
}

function isRedirect(status: number): boolean { return [301, 302, 303, 307, 308].includes(status); }
function header(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const values = Object.entries(headers).filter(([key, value]) => key.toLowerCase() === name.toLowerCase() && value !== undefined).map(([, value]) => value!);
  return values.length === 0 ? undefined : values.join(",");
}
function stripIpv6Brackets(hostname: string): string { return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname; }
function normalizeMediaType(value: string | undefined): SupportedMediaType | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const type = value.split(";", 1)[0]!.trim().toLowerCase();
  if (type === "image/jpeg" || type === "image/png") return type;
  throw new Error("REMOTE_MIME_UNSUPPORTED");
}
function contentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("REMOTE_CONTENT_LENGTH_INVALID");
  return Number(value);
}
function responseHeaders(headers: Record<string, string | string[] | undefined>): Readonly<Record<string, string | undefined>> {
  return Object.freeze(Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(",") : value])));
}
function safeErrorCode(error: unknown): string { return error instanceof Error && error.message === "REMOTE_TIMEOUT" ? "TIMEOUT" : "TRANSPORT"; }
