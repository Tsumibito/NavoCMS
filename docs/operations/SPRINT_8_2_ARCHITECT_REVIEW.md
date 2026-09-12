# Sprint 8.2 — maintainer review, 2026-09-12

**Status: implementation corrected; operational acceptance pending.**
Do not begin the next sprint or mark the full staging trajectory accepted yet.

Reviewed implementer head: `89b48e441effb465e6159936ef8516715417b2e4` in
[PR #57](https://github.com/Tsumibito/NavoCMS/pull/57).
The maintainer correction is committed with this report; the PR records its exact head and CI.

## Additional corrections

- The authorization callback now enforces the login state's ten-minute lifetime itself.
- Browser-session expiry is capped by the verified token and resolved authorization. Production
  membership/permissions are re-resolved on confirmation requests. Expired sessions are pruned
  during new logins; identity-provider token exchange has a 15-second timeout.
- The CSRF cookie is Secure behind the configured HTTPS reverse proxy, matching the session cookie.
- Relative resource URLs resolve against their original HTML/CSS file, including nested output.
  Data URLs remain intact. Malformed percent-encoding returns HTTP 400 instead of an uncaught error.
- A second executor guard runs after asynchronous job acquisition, covering simultaneous starts
  in the same runtime instance. The PostgreSQL regression now starts all three calls concurrently.
- Terminal workflow updates validate ownership and unexpired lease under a row lock in the same
  transaction as the update. Reclaim cannot race between the ownership check and that update.

No migration, runtime dependency or released JSON Schema was changed by this correction.
The implementer's new migration remains 0013; staging migration execution is still pending.

## Verification

The maintainer ran the existing encrypted `agent-tests` Neon helper against a fresh database:
full `pnpm check`, **239/239 tests, 39 files, zero skips**, **10/10 browser tests**, and
**5/5 SQL isolation suites**, exit 0. The helper removed its temporary database.

HTTP regressions cover expired browser sessions, expired callback state, malformed preview
paths followed by a healthy request, relative/nested resources, and bearer-only rejection.
The browser tests cover real authorization-code redirects without injected Authorization headers,
one-context concurrent previews, rendered stylesheet/image, and script blocking.
The final small data-URL binding adjustment is also checked by the focused HTTP suite and final CI.

## Remaining operational work

The accessible Coolify browser redirected to its login page during this review. No staging
configuration, deployment or real human confirmation was performed. The last accepted deployment
record remains Sprint 8.1 at `93170922932ca67902d3dac9d2627b7b903f6f2d`; this review did not
independently attest the current container because the deployment console session was unavailable.

After administrative access is restored:

1. Register/configure the confidential confirmation client at the existing identity provider,
   including the exact staging `/confirmations/callback` redirect URI. Check issuer/audience and
   permissions against the deployed verifier/resolver. Use encrypted secrets; never paste keys
   into this report or a chat. The four configuration names are in the
   [submission runbook](SPRINT_8_2_SUBMISSION.md).
2. Apply ordered migrations, pin and deploy the reviewed merged source, verify health/readiness
   and actual source commit. Do not deploy from the previous submission SHA.
3. Prepare a synthetic release, wait for the trusted build, inspect real preview and complete
   the owner's independent browser login/confirmation for the exact manifest.
4. Verify publish promotes stored bytes without rebuilding, then restart/reconcile and rollback
   as specified in the original handoff. Record the evidence before declaring the sprint accepted.

A restarted single container requires browser re-login because transient login/session records
are in memory. The decision receipt is durable in PostgreSQL. Multi-instance browser-session
routing and full production activation are not claimed by this acceptance report.
