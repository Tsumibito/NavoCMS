# Sprint 8.2 live acceptance

Status: in progress; publication, independent owner decision and rollback are not yet accepted.

## Deployment fixes

- The migrator now sets `search_path` on every connection. Otherwise a real 0012 → 0013
  upgrade creates unqualified functions in `public`, although a fresh installation passes.
- Migration transaction stripping now handles leading SQL comments; the migration body and
  registry insertion stay within the migrator's transaction. Released SQL files are unchanged.
- The Neon helper installs 0012, closes that connection, upgrades with the real migrator and
  checks all three capability functions belong to `navocms`. A repeated run applies nothing.
- The browser client uses its own exact token audience; MCP retains its resource audience.
  Signed-token regressions reject substitution in both directions. Browser HTTP/visual tests
  use a separate verifier that cannot authorize browser tokens on MCP.

## Staging preparation

- Compared deployment against current main before updating.
- Registered a confidential WorkOS client with the exact staging callback URL and PKCE.
  Stored and delivered its four settings in the existing encrypted dotenvx file; preserved
  existing deployed role permissions. No plaintext credentials were written or committed.
- Applied unchanged migration 0013 and its checksum in one transaction after checking all
  twelve existing registry rows. Verified all three capability functions are in `navocms`.

## Verification notes

The initial upgrade gate passed, with all 51 PostgreSQL integration tests green. One unrelated
process-timeout fixture failed because Node was killed before writing its PID marker. The fixture
now writes the PID using a shell builtin before `exec sleep`; it still asserts the timed-out
process is dead and no artifact is registered. The final gate is rerun after this correction.

## Final automated gate and deployment

- PR [59](https://github.com/Tsumibito/NavoCMS/pull/59), implementation
  `9d1164ea4d8bc47aab6973fc4a0805e8e696a1a2`.
- Full clean Neon gate: **240/240**, **10/10** browser, **5/5** isolation; upgrade and repeat
  no-op passed. Temporary database removed. Full local `pnpm check` also passed.
- GitHub [34699239996](https://github.com/Tsumibito/NavoCMS/actions/runs/34699239996): success.
- Squash merge `b16ab591691e237eb1a99552f6d240c9a4167327`; verified its tree equals tested head.
- Coolify deployment `vqeerfnxpdxhomj1nul7gk5w` requested for that exact merge commit.
- Previous verified publication: `4a2f7cf1-87f4-433f-912a-58b208697f29`, release
  `5a655287-4585-41fe-bf91-51899a4e29cf`. Its live `/sprint-eight-operational-proof/` page
  returned 200, SHA-256 `12bcd5130a6a3b3ecdce50f4d838d6b864b04f917d5a35d300442aa5195b89cb`.
- Synthetic acceptance revision: `087204d8-586c-4176-ad5b-aa4d447400ab`.

## Live build correction

Deployment `vqeerfnxpdxhomj1nul7gk5w` completed successfully and its container attested the merge
SHA. `/readyz`, R2, provider and builder reported ready; authenticated MCP site discovery passed.
The first live preview (`b7315cdf-5858-4f93-9ef2-119b2080f3fc`) failed with
`REVIEWED_ASTRO_AUTHORITY_DENIED`: the executor used the human request's repository context
with service registration authority. It also inherited the uncommitted request transaction.

The correction commits preview creation before scheduling and uses the runtime service principal
for executor database scope. A PostgreSQL regression runs the full editing-service preview path
with distinct human/service IDs, checks successful artifact registration attributed to the
service, and verifies repeat requests and a restarted runtime reuse the build.

The service-build correction is merged in PR
[60](https://github.com/Tsumibito/NavoCMS/pull/60), merge
`0d445018916d9261007b9a9bae91a493a358dd9a` (tree matches tested
`ad75177c9fcd983f8d0b7cfd1d962a896fd909d8`). Final
[CI 34700427506](https://github.com/Tsumibito/NavoCMS/actions/runs/34700427506) passed the full
check with PostgreSQL, browser and isolation gates. On Neon, the broad run passed the other
240 tests; the new full preview/replay/restart regression passed after its fixture was corrected
(media storage, environment kind/key and route path). Final typecheck and fresh Neon
upgrade/isolation-only gates passed; all temporary databases were removed. A local real-Astro
build timeout passed on isolated rerun and in CI. No production code changed during the fixture
corrections.

## Failed-job retry correction

Deployment `ukextv9ienxticok0owdzl3p` completed at `0d445018916d9261007b9a9bae91a493a358dd9a`.
It remained healthy, with confirmation settings present. Retrying the failed immutable preview
then hit the database's one-build-job-per-release unique index: acquisition ignored the failed
row and attempted another insert. The correction reopens the same row, increments `attempt`
and retains the executor guard through lease cleanup. The PostgreSQL regression now injects a
first-attempt failure and verifies a successful retry with exactly one job, attempt 2.

## Browser login follow-up, 2026-09-12

The owner's callback reached an invalid/expired single-use login state. Starting a fresh
browser flow revealed a separate 403: the returned access token had the configured MCP
resource audience, not the confidential browser client audience. Safe, temporary diagnostics
also established that the selected browser identity had neither the required organization
claim nor an existing membership in this site. No credentials, token values or identity claims
were logged. The temporary container diagnostic was removed and the original runtime restored
before deploying the reviewed fix.

The callback now validates two signed tokens from its confidential PKCE exchange: the API
access token retains the existing organization/site/permission checks; the ID token binds the
browser client and nonce to the same issuer and subject. This fixes the audience assumption
without auto-provisioning the selected account or weakening the publication gate. Rejected
logins emit only a stage and an internal error code, and the page offers a retry link.

The HTTP regression now uses real RS256 signatures and distinct API/client audiences. It also
rejects missing ID tokens, wrong audiences, mismatched or missing nonce, another subject,
incorrect authorized party or access-token hash, expired identity tokens, missing/foreign
organization and delegated agent identities. Browser tests retain the real redirect/code/PKCE
flow with the added nonce-bound ID token.

A valid site member must still complete browser login and record their own decision before
publication/rollback acceptance can continue. This follow-up does not mark Sprint 8.2 accepted.
