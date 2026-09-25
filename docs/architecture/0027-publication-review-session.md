# ADR 0027 — Publication review session and one-action approval

**Status:** Accepted

**Date:** 2026-09-25

**Owners:** NavoCMS maintainers

## Context

The live Sprint 8.2 test proved exact-build publication and rollback. The owner
rejected the repeated login and the technical `Confirm this build` page. The
browser session lived only in one process and expired with the first access
token, so a runtime restart could interrupt review.

## Decision

The independent OIDC code exchange creates an authenticated browser session
for at most eight hours. Its cookie is encrypted and authenticated with an
AES-GCM key derived for this purpose from the confirmation client's encrypted
secret. It contains a random session ID, the verified identity and scopes, the
provider refresh token when issued, and an absolute expiry. It is HttpOnly and
Secure on HTTPS. The cookie can be read after a runtime restart; no bearer is
accepted as a browser session.

The access token's original expiry is kept. When it expires, the server must
exchange the refresh token with the identity provider and verify the new
access token before serving review or recording a decision. A failed refresh
requires a new sign-in. The tenant, site, issuer, subject and human kind may
not change during refresh. Current site membership and publication permission
are resolved on every review request and decision. If no refresh token was
issued, the browser session expires with the original tokens. The session is
never extended past its eight-hour absolute limit.

An account switch removes the browser cookie, records a hashed session ID in
the site-scoped PostgreSQL revocation table, and uses the configured provider
logout endpoint when the verified provider session ID is available. A rejected
login can carry a short-lived, encrypted logout hint for the same purpose.
If provider logout is unavailable, reauthentication is forced and the page
does not claim to have switched accounts automatically.

The review page embeds the saved output behind the same authenticated browser
session. The output remains immutable; HTML and CSS resource URLs are bound to
the review capability at serve time. The page names the site and signed-in
account and offers one action, `Publish`. Hashes and policy details are in a
disclosure. The action still records a decision for the exact output; the
agent completes publication afterward. Expired review links can be renewed
for the same registered output with a CSRF-protected browser form. A changed
policy, missing output or already approved release requires a new candidate.

## Consequences

- The confirmation client must issue refresh tokens for an eight-hour session.
  Its logout endpoint and allowed sign-out return URI must be configured for
  reliable account switching.
- The browser session revocation migration must be applied before the new
  runtime is deployed. Rotating the confirmation client secret signs out all
  browsers.
- Provider revocation is observed when an expired access token is refreshed;
  site membership removal is observed on every request. The access-token
  lifetime therefore bounds delayed detection of provider-side changes.
- The MCP bearer remains unable to record the independent human decision.

## Validation

Verify restart continuity, token refresh and denial, current membership,
account switching and replay denial, expired-link renewal without a rebuild,
exact preview output, CSRF, and full publication/rollback response statuses.
