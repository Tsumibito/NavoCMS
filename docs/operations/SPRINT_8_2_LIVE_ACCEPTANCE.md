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

Retry correction: PR [61](https://github.com/Tsumibito/NavoCMS/pull/61), tested head
`b120ec4b7c5b763936bdb3228ddb4ef1e702babd`, merge
`d782caafe302d7778a08faf89dedbce823a667ae` (identical tree).
[CI 34700966184](https://github.com/Tsumibito/NavoCMS/actions/runs/34700966184) passed in two
minutes. Full local check passed (189 unit tests, 10 browser tests), and the fresh Neon targeted
suite passed 10/10 plus 5/5 isolation and upgrade/repeat checks. Temporary database removed.

A second live candidate proves successful real building before the retry correction:
release `e601e223-aec4-4aef-af66-cb1cc5646e48`, revision
`b891bdcf-a2df-477d-8d27-c0aaedd0e5f0`, release hash
`282935cd5285bb75403152acbb7951214895054e13fe6f546d16036ce4a5f182`.
Its stored build is one file, 884 bytes, source commit `0d445018916d9261007b9a9bae91a493a358dd9a`,
output manifest `sha256:fb5169d6d02fc611fc02d00eeaf3e226429ab6eafc04018e4bf94662075f52b1`.
The real browser rendered its heading, marker and CSS (`rgb(18, 38, 58)` on white), without
horizontal overflow. Preview HTTP: 200, noindex/nofollow/noarchive, no-referrer and scripts denied
by CSP. The URL-bound preview projection is 937 bytes, SHA-256
`5c862e98f7c532d4674d78cd73a4e485f93e24861146d9a269c6938e73b0f742`.
MCP approval without the owner's browser decision returned `HUMAN_CONFIRMATION_REQUIRED` / none.

## Build handoff before the login follow-up

Build-retry Coolify deployment `gzkmwhqisjmd9egu9tjcmcsn` finished, container
`y7xtftoizsqmitvgfvzfwkbu-150427031774` healthy. `/readyz` reports all dependencies ready.
[Main CI 34701110084](https://github.com/Tsumibito/NavoCMS/actions/runs/34701110084) passed on
`d782caafe302d7778a08faf89dedbce823a667ae`.

The original failed release was resumed through the same MCP preview request and key. It now
reports ready, source commit `d782caafe302d7778a08faf89dedbce823a667ae`, 1 file / 1079 bytes,
manifest `sha256:e65d3122645e9e6b0bd758233b83b8bccbbe7a0c6e05a145cb72fad9d40f5f21`.
There is exactly one build job for it, attempt 2. The second candidate stayed ready after the
container replacement, with the same stored manifest and source commit as before; its job
remains attempt 1. This proves failed-build retry and completed-artifact persistence live.
A running-process crash and lease expiry were exercised in PostgreSQL tests, not injected live.

The owner-confirmation handoff is for the second candidate
`e601e223-aec4-4aef-af66-cb1cc5646e48`, hash
`282935cd5285bb75403152acbb7951214895054e13fe6f546d16036ce4a5f182`.
That handoff reached WorkOS sign-in; the subsequent login result is recorded below.
Its preview/confirmation capability expires at
2026-09-12 15:59:03 UTC. Capability URLs are provided only in the user-facing handoff, not stored
in this report. No receipt has been issued by the agent and no publication was performed.
After the owner's real confirmation, continue with a new approval key (the earlier negative
check key is already used), publish, verify stored-output/public-byte parity and rollback to
publication `4a2f7cf1-87f4-433f-912a-58b208697f29`. Sprint acceptance remains pending until then.

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

The login correction is merged in [PR 62](https://github.com/Tsumibito/NavoCMS/pull/62):
implementation `85f496a7f3ccb343c3bd4b8f89b783cd90cc8c98`, merge
`221edf12d46367d2e778348462f93917a645b4c2`, identical source tree.
[CI 34703107391](https://github.com/Tsumibito/NavoCMS/actions/runs/34703107391) passed in 2m9s,
including all 39 test files, 10 browser checks and PostgreSQL isolation.
Coolify deployment `rqrzknjdrxydtnfesusrt0lr` finished on that merge; container
`y7xtftoizsqmitvgfvzfwkbu-154649834140` is healthy and all `/readyz` dependencies are ready.
A fresh live login passed dedicated ID-token verification and reached access-token validation;
its remaining rejection is `OAUTH_CLAIM_INVALID` for the organizationless selected account.
The owner has been asked which account originally connected the CMS. No membership, permissions,
receipt or publication was changed to work around this rejection.

## Completed live publication and rollback, 2026-09-12

The owner signed in as the existing site member and personally recorded the decision at
16:38:46.649 UTC. Receipt `sha256:9b2f6afb8e83bdc87165734502b92880688a34b0c63b0ba0cc81e033d9b0598e`
covers the unchanged second candidate's manifest. The agent observed the resulting
`Decision recorded` page; it did not press the confirmation button.

- Approval: `s82-live-owner-approved-20260912-b2`, accepted at 16:39:23.704 UTC.
- Publication: `s82-live-publish-20260912-b2`, publication
  `b5191d86-5ebb-426e-bc17-36080809f59a`. The first live probe failed after application;
  the tool correctly returned `LIVE_VERIFICATION_FAILED`, `effectState: applied`.
- Recovery: `s82-live-reconcile-20260912-b2` reached `published` at 16:39:57.422 UTC.
  Public route `/sprint-8-2-live-acceptance-20260912-b/` subsequently returned 200, with and
  without a cache-busting query. Its 884 bytes hashed to
  `568dabdbd87bd6134a56256fa9f286ef84dda26d75eab4a32bf3a83f618a503d`, exactly the stored file
  digest in the provider reference; the acceptance marker was present. No rebuild occurred.
- Rollback: `s82-live-rollback-20260912-b2` reached `rolled_back` at 16:40:34.027 UTC and
  restored baseline publication `4a2f7cf1-87f4-433f-912a-58b208697f29`.
  Live `/sprint-eight-operational-proof/` returned the original 874 bytes, SHA-256
  `12bcd5130a6a3b3ecdce50f4d838d6b864b04f917d5a35d300442aa5195b89cb`.

The core live acceptance cycle has passed. The login/confirmation UX is not accepted as ready
for normal use: the owner explicitly rejected the repeated confusing authentication steps.
Follow-up requirements are recorded in
[confirmation UX correction](../development/CONFIRMATION_UX_CORRECTION.md).

A response-consistency defect also remains: reconcile returned the old nested publication
status `verification_failed` alongside the freshly loaded release status `published`, and
rollback returned the target's pre-restore status `superseded`. The live bytes and durable
release transitions succeeded. Reload these nested projections after the state transition;
add regressions asserting consistent response statuses. Do not hide this defect by declaring
all response semantics accepted.
