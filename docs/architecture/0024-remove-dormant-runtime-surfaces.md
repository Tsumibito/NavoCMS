# ADR 0024 — Remove dormant runtime surfaces

**Status:** Accepted

## Decision

Production packages expose only code used by the current MCP, R2, Astro, and
Pages composition. The unused generic PluginHost, checkout-based Astro runner,
remote media ingest, direct-upload signer, Coolify client, and unused telemetry
implementations are removed. Applied migrations and compatible stored records
remain unchanged.

Future sprints add a capability only with its first real runtime caller and a
focused test. Coolify deployment stays an operator action; the trusted Astro
builder continues to use the image-attested runner.

## Consequences

- no active staging or production behavior is removed;
- the shared R2 namespaces and Pages recovery path remain unchanged;
- remote ingest and browser direct upload are deferred until a real client
  requires them.
