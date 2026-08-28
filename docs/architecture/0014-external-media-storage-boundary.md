# ADR 0014: External media storage boundary

**Status:** superseded in part by ADR 0024

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

Direct-upload signing was removed because no MCP or HTTP caller consumed it.
Uploads use the existing server-mediated intent/finalize path. Presigning may
return when a real client requires it; bounded finalization remains the
authoritative acceptance control.

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

The R2 compatibility matrix documents
destination conditions for PutObject but CopyObject conditional support only
for `x-amz-copy-source-*`; this is why restore uses bounded read plus immutable
PUT rather than a conditional CopyObject.

## Consequences

The active R2 adapter contains only operations used by media persistence and
reviewed Astro artifact storage.
