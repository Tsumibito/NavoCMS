# Sprint 8.2 UX closure

## Owner workflow

Draft edits, builds and previews do not ask the owner to approve anything.
The browser review link shows the saved page, the site and the current account.
`Publish` records one decision for that exact output. The agent then calls
the existing approve/publish tools and reports the result. Reopening the link
does not request another decision.

New review sessions last at most 360 days in the same browser profile, under
[ADR 0028](../architecture/0028-remember-publication-review-login.md). Existing
cookies keep their original deadline. If the identity provider issues
a refresh token, the CMS refreshes and verifies the access token after its
expiry; otherwise the browser must sign in again when the original token
expires. Refresh never extends the 360-day deadline. Browser profiles, including
Chrome and Codex, do not share their remembered login. Restarting the CMS does
not end a still-valid session. An in-progress login also survives process
replacement under [ADR 0029](../architecture/0029-restart-safe-browser-login.md),
within its separate ten-minute authorization window. Removing site
membership, permission, or the current session's revocation record blocks
publication. The account link signs out locally and uses the provider logout
endpoint when configured. A rejected account can switch through the same UI.

An expired review link has a button to issue a new link for the same saved
output. No new build occurs. A changed release policy or unavailable artifact
requires a new candidate. The confirmation capability never authorizes a
decision by itself, and the MCP bearer cannot submit the browser form.

## Deployment configuration

Apply migrations `0014` through `0016` before deploying the new runtime. Keep the
existing confidential OIDC confirmation client. The browser requests `openid`,
`email` and `offline_access` so WorkOS Connect can issue refresh
tokens; a client without them remains valid only until its access token ends.
For reliable account switching, set
`NAVOCMS_CONFIRMATION_LOGOUT_ENDPOINT` to the provider's HTTPS logout
endpoint and register `/confirmations/signed-out` on the CMS origin as an allowed sign-out return
URI. For WorkOS AuthKit, the endpoint is
`https://api.workos.com/user_management/sessions/logout` when that host is
the configured environment. The actual host and sign-out URI must match the
selected WorkOS environment. Store settings and client credentials through
the existing encrypted dotenvx configuration; do not paste them into chat.

The session cookie is encrypted with a purpose-derived key from
`NAVOCMS_CONFIRMATION_CLIENT_SECRET`. Rotating that secret signs out existing
browsers. The signed-in account shown in the page comes from a verified ID
token email when present, otherwise from the subject identifier.

## Acceptance

1. Edit, build and preview three drafts without a browser approval prompt.
2. Sign in once, review a saved page, restart the CMS and continue under the
   same session. An expired/revoked session and removed site membership fail.
3. An unauthorized account can choose `Use another account` without visiting
   WorkOS Dashboard. The previous browser session cannot be replayed.
4. An expired review link issues a fresh link without a rebuild. Expired OIDC
   callback state cannot be replayed.
5. The review displays the exact saved HTML/CSS/media and one `Publish`
   action. MCP bearer alone cannot record the human decision.
6. After the decision, approve, publish, verify, reconcile and rollback
   operate on the unchanged artifact. Responses report current publication
   statuses, and restored live bytes match the baseline.
