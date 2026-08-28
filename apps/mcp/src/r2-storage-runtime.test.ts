import { createHash } from "node:crypto";

import type { S3Transport, S3TransportResponse } from "@navocms/s3-core";
import { describe, expect, it } from "vitest";

import type { R2TransportComposition } from "./r2-composition.js";
import { createR2StorageRuntime } from "./r2-storage-runtime.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const composition = Object.freeze({
  selection: "r2" as const,
  endpoint: "https://account.r2.cloudflarestorage.com",
  bucket: "navi-training",
  namespace: "navocms/v1/" as const,
  readiness: { environment: "staging" as const, tenantId, siteId, bucket: "navi-training", namespace: "navocms/v1/" as const, prefix: "navocms/v1/" as const, bindingDigest: `sha256:${"a".repeat(64)}` },
  withAccessKey: async <T>(operation: (value: string) => Promise<T>) => operation("access-key"),
  withSecretKey: async <T>(operation: (value: string) => Promise<T>) => operation("secret-key")
}) satisfies R2TransportComposition;

describe("activated R2 storage runtime", () => {
  it("proves both exact child namespace markers without writes or deletes", async () => {
    const transport = new MarkerTransport();
    const runtime = createR2StorageRuntime({ composition, tenantId, siteId, transport });
    await expect(runtime.ready()).resolves.toBe(true);
    await expect(runtime.ready()).resolves.toBe(true);
    expect(transport.requests).toHaveLength(6);
    expect(new Set(transport.requests.map(([method, key]) => `${method} ${key}`))).toEqual(new Set([
      "HEAD navocms/v1/_namespace.json", "GET navocms/v1/_namespace.json",
      "HEAD navocms/v1/media/_namespace.json", "GET navocms/v1/media/_namespace.json",
      "HEAD navocms/v1/artifacts/_namespace.json", "GET navocms/v1/artifacts/_namespace.json"
    ]));
    expect(transport.requests.some(([method]) => method === "PUT" || method === "DELETE")).toBe(false);
  });

  it("fails closed on marker drift and scope mismatch", async () => {
    const transport = new MarkerTransport({ artifacts: "drift\n" });
    await expect(createR2StorageRuntime({ composition, tenantId, siteId, transport }).ready()).resolves.toBe(false);
    expect(() => createR2StorageRuntime({ composition, tenantId: "other", siteId, transport })).toThrow("SCOPE_MISMATCH");
  });
});

class MarkerTransport implements S3Transport {
  readonly requests: [string, string][] = [];
  readonly #overrides: Readonly<Record<string, string>>;
  public constructor(overrides: Readonly<Record<string, string>> = {}) { this.#overrides = overrides; }
  public async request(input: Parameters<S3Transport["request"]>[0]): Promise<S3TransportResponse> {
    this.requests.push([input.method, input.key]);
    const kind = input.key === "navocms/v1/_namespace.json" ? "root" : input.key.includes("/media/") ? "media" : "artifacts";
    const body = new TextEncoder().encode(this.#overrides[kind] ?? marker(kind));
    if (input.method === "HEAD") return { status: 200, headers: metadata(body) };
    if (input.method === "GET") return { status: 200, headers: {}, body: stream(body) };
    throw new Error("unexpected provider effect");
  }
}

function marker(kind: "root" | "media" | "artifacts"): string {
  if (kind === "root") return '{"owner":"NavoCMS","retention":"managed-only-within-this-prefix","schema":"io.navocms.r2-namespace.v1","scope":"navocms/v1/","version":1}\n';
  const purpose = kind === "media" ? "content-addressed-media" : "reviewed-astro-artifacts";
  return `{"owner":"NavoCMS","purpose":"${purpose}","schema":"io.navocms.r2-namespace.v1","scope":"navocms/v1/${kind}/","version":1}\n`;
}
function metadata(bytes: Uint8Array): Record<string, string> { return { "content-length": String(bytes.byteLength), "content-type": "application/json", "x-amz-meta-sha256": createHash("sha256").update(bytes).digest("hex"), "x-amz-meta-media-type": "application/json" }; }
async function* stream(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }
