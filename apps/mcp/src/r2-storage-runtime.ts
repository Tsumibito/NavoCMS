import { S3CompatibleMediaStorage } from "@navocms/media";
import {
  createFetchS3Transport,
  sha256,
  type S3Transport
} from "@navocms/s3-core";

import { S3ReviewedAstroObjectStorage } from "./reviewed-astro-object-storage.js";
import type { R2RuntimeSelectionResult } from "./r2-runtime.js";

const MARKER_KEY = "_namespace.json";
const ROOT_MARKER_KEY = "navocms/v1/_namespace.json";
const MAX_MARKER_BYTES = 512;
const MARKERS = Object.freeze({
  root: '{"owner":"NavoCMS","retention":"managed-only-within-this-prefix","schema":"io.navocms.r2-namespace.v1","scope":"navocms/v1/","version":1}\n',
  media: '{"owner":"NavoCMS","purpose":"content-addressed-media","schema":"io.navocms.r2-namespace.v1","scope":"navocms/v1/media/","version":1}\n',
  artifacts: '{"owner":"NavoCMS","purpose":"reviewed-astro-artifacts","schema":"io.navocms.r2-namespace.v1","scope":"navocms/v1/artifacts/","version":1}\n'
});

export interface ActivatedR2StorageRuntime {
  readonly media: S3CompatibleMediaStorage;
  readonly artifacts: S3ReviewedAstroObjectStorage;
  /** Bounded, read-only proof of both reviewed child namespaces. */
  readonly ready: () => Promise<boolean>;
}

/**
 * Creates the only production R2 composition. Application keys stay logical;
 * the shared core adds the reviewed media/artifacts physical namespaces.
 */
export function createR2StorageRuntime(input: Readonly<{
  selection: R2RuntimeSelectionResult;
  tenantId: string;
  siteId: string;
  transport?: S3Transport;
  fetcher?: typeof fetch;
}>): ActivatedR2StorageRuntime {
  if (input.tenantId !== input.selection.readiness.tenantId || input.siteId !== input.selection.readiness.siteId) {
    throw new Error("R2_STORAGE_SCOPE_MISMATCH");
  }
  const transport = input.transport ?? createFetchS3Transport({
    endpoint: () => input.selection.binding.endpoint,
    bucket: () => input.selection.binding.bucket,
    credentials: () => input.selection.secrets.use(input.selection.binding.accessKeySecretRef, (accessKeyId) =>
      input.selection.secrets.use(input.selection.binding.secretKeySecretRef, async (secretAccessKey) => ({ accessKeyId, secretAccessKey }))
    ),
    ...(input.fetcher ? { fetch: input.fetcher } : {})
  });
  let readiness: Promise<boolean> | undefined;
  return Object.freeze({
    media: new S3CompatibleMediaStorage({ tenantId: input.tenantId, siteId: input.siteId, bucket: input.selection.binding.bucket, transport }),
    artifacts: new S3ReviewedAstroObjectStorage({ bucket: input.selection.binding.bucket, transport }),
    ready: () => readiness ??= verifyMarkers(transport)
  });
}

async function verifyMarkers(transport: S3Transport): Promise<boolean> {
  try {
    const [rootMarker, mediaMarker, artifactMarker] = await Promise.all([
      readPhysicalMarker(transport, ROOT_MARKER_KEY, MARKERS.root),
      readPhysicalMarker(transport, `navocms/v1/media/${MARKER_KEY}`, MARKERS.media),
      readPhysicalMarker(transport, `navocms/v1/artifacts/${MARKER_KEY}`, MARKERS.artifacts)
    ]);
    return rootMarker && mediaMarker && artifactMarker;
  } catch {
    return false;
  }
}

async function readPhysicalMarker(transport: S3Transport, key: string, expectedText: string): Promise<boolean> {
  const expected = new TextEncoder().encode(expectedText);
  const head = await transport.request({ method: "HEAD", key });
  if (head.status === 404) return false;
  if (head.status < 200 || head.status >= 300) throw new Error("R2_NAMESPACE_MARKER_UNAVAILABLE");
  const headers = Object.fromEntries(Object.entries(head.headers).map(([name, value]) => [name.toLowerCase(), value]));
  const advertisedSize = headers["x-amz-meta-byte-size"] ?? headers["content-length"];
  if ((advertisedSize !== undefined && Number(advertisedSize) !== expected.byteLength) || headers["content-type"] !== "application/json" || headers["x-amz-meta-sha256"] !== sha256(expected)) return false;
  const response = await transport.request({ method: "GET", key, headers: { range: `bytes=0-${MAX_MARKER_BYTES}` } });
  if (response.status < 200 || response.status >= 300) throw new Error("R2_NAMESPACE_MARKER_UNAVAILABLE");
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_MARKER_BYTES) { await response.abort?.(); throw new Error("R2_NAMESPACE_MARKER_LIMIT_EXCEEDED"); }
    chunks.push(new Uint8Array(chunk));
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes) === expectedText;
}
