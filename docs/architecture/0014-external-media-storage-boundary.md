# ADR 0014: External media storage boundary

## Decision

External R2/S3 storage remains an injected, site-bound `MediaStorage` adapter.
Creating the adapter requires an explicit tenant/site scope and transport; no
production profile constructs it implicitly.

Immutable content writes use conditional `If-None-Match: *`. A key outside the
bound tenant/site prefix is rejected before the adapter calls its transport. A
conditional conflict is accepted only after bounded HEAD/GET proves the
already-existing object has the exact SHA-256, size, and MIME; otherwise it is
an immutable-key conflict. HEAD metadata is advisory until a bounded GET
rechecks body length and SHA-256.

`PostgresMediaUploadIntentSigner` loads a still-pending, unexpired intent
whose linked asset is also `pending`, in the caller's PostgreSQL RLS scope,
immediately before issuing a presigned PUT. Low-level signing requires a
module-private capability unavailable to application callers. The URL signs
the exact pending key, `If-None-Match: *`, MIME, expected-size metadata,
checksum metadata, and effective expiry; expected size is bounded by
`MEDIA_LIMITS.maxBytes`. AWS-compatible `x-amz-*` values are hoisted into the
signed query and are not duplicated in browser headers. The canonical request
and `X-Amz-SignedHeaders` include `host`, and its payload value is the S3
constant `UNSIGNED-PAYLOAD` (also emitted as `X-Amz-Content-Sha256`).
Browser-forbidden `Content-Length` is deliberately not returned or signed.
S3-compatible
presigned PUT does not provide a portable server-side maximum-body-size
guarantee: a client may send a body inconsistent with metadata on some
providers. Consequently the existing bounded finalization read, checksum,
MIME, size, and dimensions validation remains the authoritative acceptance
control.

Recovery uses a provider copy with preserved verified SHA-256/MIME metadata
plus a persisted `recoverable-until` metadata value. Restore reads the bounded
recovery object, calls immutable PUT for the original (including exact replay
reconciliation), and only then deletes recovery. This avoids relying on a
destination condition for CopyObject. Reclaim first reads the stored deadline
and fails before that exact time. Provider listing is translated to the
repository's validated lexical key cursor through S3 `start-after`, never an
opaque continuation token.

## Failure model

- a conditional conflict is a successful retry only when bounded revalidation
  proves exact bytes and MIME; otherwise it is immutable-write denial;
- provider errors are normalized without URLs, credentials, response bodies,
  or provider headers in the error;
- a streaming response exceeding its bound is aborted and never returned;
- GET requests include one byte beyond the bound, so a provider that lies in
  HEAD but honours Range cannot hide an oversized object;
- a thrown provider body is aborted and normalized before it crosses this
  boundary;
- an effect that completes before repository persistence is recoverable by the
  existing lifecycle/variant checkpoint retry model;
- a recovery copy that succeeds before delete can be repeated safely with the
  same metadata and deadline;
- list responses are bounded and each listed item is revalidated with HEAD.

## Compatibility evidence

The SigV4 test vector is generated and re-derived by the AWS SDK v3 Smithy
`SignatureV4` implementation with explicit `host` and
`X-Amz-Content-Sha256: UNSIGNED-PAYLOAD`. The R2 compatibility matrix documents
destination conditions for PutObject but CopyObject conditional support only
for `x-amz-copy-source-*`; this is why restore uses bounded read plus immutable
PUT rather than a conditional CopyObject.

## Consequences

R2/Cloudflare credentials, production bindings, Coolify changes, publication,
and remote ingest remain out of scope. Operational gate Sprint 7.1 is still a
precondition for external activation.
