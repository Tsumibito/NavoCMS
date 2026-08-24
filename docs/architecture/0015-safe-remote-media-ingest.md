# ADR 0015: Safe remote media ingest

## Decision

Remote ingest is an injected, provider-neutral `RemoteMediaIngestService` in
`@navocms/media`; it is not an MCP tool and no production profile constructs
it. Its only network operation is unauthenticated HTTPS `GET` to a URL without
credentials, fragments, or a non-default port.

For every initial URL and redirect target, the service resolves all A/AAAA
addresses and rejects the request if any result is malformed or non-global,
including IANA special-purpose and transition ranges with a non-global embedded
IPv4 destination.
It connects TCP to one of those just-validated addresses, while retaining the
URL authority as the HTTP `Host` header and TLS SNI. It never delegates the
connection hostname back to a resolver. Redirects are followed manually, are
re-resolved and re-validated, and are limited to three transitions.

One abort signal and wall-clock deadline covers DNS, connect, TLS, response
headers, redirects, and body; the production transport disables connection
pooling so a validated hop cannot reuse another authority's socket. The request advertises `Accept-Encoding: identity`; any non-identity response
encoding is rejected before body processing. The response is streamed into a
bounded buffer of at most `MEDIA_LIMITS.maxBytes + 1`, with abort on overflow
or a single end-to-end deadline. `Content-Length` is an early rejection signal,
not a trust source. A declared MIME is optional but, when present, must equal
the result of existing byte sniffing. Existing header inspection then checks
dimensions, pixels, and frames before the service creates an upload intent.

After inspection, the service creates the existing PostgreSQL upload intent
with `remote-ingest` provenance, writes only to its pending key, and invokes
the existing `finalizeUpload`. The same client idempotency key therefore uses
the existing `media_upload_intent_create` and `media_upload_finalize`
reservations, Event Ledger, and transactional outbox. A replay with changed
remote content changes the intent fingerprint and fails before a second
storage write.

## Failure model

- mixed public/private DNS answers fail before a transport call;
- redirect targets repeat URL, DNS, and IP validation, preventing DNS rebinding;
- timeout, body overflow, unexpected encoding, non-2xx status, and MIME drift
  abort the response before intent or storage effect;
- a lying `Content-Length` cannot bypass the bounded stream limit;
- an interrupted operation can replay the same immutable pending object and
  resume through existing finalization; changed remote bytes fail idempotency
  drift rather than overwrite it;
- transport errors expose only normalized local error codes, never URL
  credentials, response headers, or body.

## Consequences

This package adds no migration, background loop, MCP mutation tool, R2/Cloudflare
binding, credentials, Coolify change, or Astro publication. The Node HTTPS
transport explicitly sets TLS `servername` because Node otherwise suppresses
SNI when the connection target is an IP address; see the
[Node HTTPS documentation](https://nodejs.org/api/https.html). The resolver
uses `dns.lookup(..., { all: true, verbatim: true })` so every returned address
is available for validation before a request is made; see the
[Node DNS documentation](https://nodejs.org/api/dns.html).
