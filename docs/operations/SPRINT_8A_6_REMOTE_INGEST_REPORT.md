# Sprint 8A.6 — Safe remote media ingest

## Status

Complete. The Sprint 8A.6 code gate is closed; remote ingest remains absent
from the production profile and MCP discovery.

## Implemented boundary

- HTTPS-only remote fetch rejects credentials, fragments, and non-default ports.
- Every A/AAAA answer is validated as global before TCP connects to a selected,
  already-validated address with retained Host/SNI; every redirect repeats that
  process and the chain is capped at three transitions.
- One abort signal and wall-clock deadline covers DNS, connect, TLS, headers,
  redirects, and body. Body streaming is bounded to `MEDIA_LIMITS.maxBytes + 1`,
  aborts on overflow, rejects unexpected content encoding, and treats
  `Content-Length` only as an early guard.
- Content MIME is sniffed from bytes; declared MIME drift, unsafe dimensions,
  and decode-limit failures occur before the normal upload intent or storage
  path. Accepted content passes the existing intent → pending object → finalize
  trajectory with `remote-ingest` provenance.
- No new transaction, idempotency, Ledger, outbox, migration, MCP mutation
  tool, provider activation, credential, or publication path was added.

## Negative coverage

- private, reserved, multicast, malformed, and IPv4-mapped IPv6 DNS results;
- same-host DNS rebinding after redirect; redirect limit, credentials,
  fragments, and ports;
- timeout, oversized/length-lie body, unexpected compression, and MIME drift;
- idempotent replay and remote-content drift before a second storage write;
- PostgreSQL intent/finalize replay, RLS scope, provenance, Ledger, and outbox
  trajectory.

## Retained CI evidence

- [GitHub run 32767769045](https://github.com/Tsumibito/NavoCMS/actions/runs/32767769045)
  passed on code head `7c6fc5b`: 30/30 test files and 133/133 tests with no
  skipped PostgreSQL scenarios, plus 5/5 visual tests;
- PostgreSQL tenant RLS and media isolation suites passed;
- the production container build passed;
- no external storage or remote-ingest production activation was introduced.

## Local review evidence

- `pnpm check`: 103 passed, 30 PostgreSQL-dependent skipped, 5 visual passed;
- review hardening added an actual end-to-end abort deadline, disabled transport
  pooling, normalized malformed redirect errors, and corrected IANA
  special-purpose/transition address filtering;
- `git diff --check`: passed.
