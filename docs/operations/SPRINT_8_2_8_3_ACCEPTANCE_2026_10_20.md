# Sprint 8.2 and 8.3 verification — 2026-10-20

## Status and scope

Implementation and the real immutable release/update/restart/rollback cycle are
verified on the synthetic staging site. The Sites consumer update/restore pilot
also passed. This is not a production Navi migration or a claim that 9.1–9.3 are
accepted. Final owner UX sign-off remains separate from technical verification.

## Sprint 8.2

The owner recorded the Aurora II decision at 2026-10-20T08:57:57.453Z for release
`0251dad4-48d6-4160-ad84-da95ae411d23`, hash
`a17644ecf6d94f39b42b128401f2fcb56ac3ba41dd4a2102ed830b58634f943b` and output
manifest `sha256:0aaff4e730ea116082dd88a1a2d47dd239bc3da8a2502de73108f100d2dd3292`.
Approve succeeded. Publish applied the artifact; reconciliation verified its
live output after propagation. Publication: `5afab2fe-e480-45fe-8d21-c3aa9a80aee2`.

The staging runtime was restarted while that release was published. Health and
readiness returned 200; authenticated reconciliation retained the same verified
publication without another build, provider publication or owner decision.

The final correction returns `publication.status: verified` after successful
verification, including initial publication and recovery of a publishing
checkpoint. It previously returned a stale nested `applied` status. Regressions
cover direct publication, approved-state restart recovery and expired-approval
publishing-checkpoint recovery. No schema or database change is required.

Browser coverage now exercises a read-only account's denied review, provider
logout, callback return, a fresh authorized review with exactly one Publish
button, a mobile-width page and a still-pending publication decision. HTTP
coverage additionally checks real signed identity/access-token pairing, CSRF,
revocation, refresh, fixed 360-day sessions, day-long attempts and automatic
review renewal. These automated provider scenarios use a local test IdP.

A live second-account WorkOS logout/sign-in and its administrative sign-out URI
registration were not independently verified in this run. The real owner login,
remembered return and exact-release decision did occur. The connected browser
inspection tool could not attach because its managed profile was already in
use; another task's browser was not stopped. This limits live visual/account
switch UX acceptance, not the recorded content publication evidence.

## Sprint 8.3

The updated public snapshot preserved all 11 routes, en/fr coverage and both
redirect rules. Exactly `/aurora` and `/fr/aurora` changed revisions and media;
the other nine revisions, semantic HTML and media bindings matched baseline.
All six referenced updated media URLs returned 200. The unrelated draft was
excluded. The approved output remained 12 files / 19044 bytes.

Sites version 2 was saved from source
`6d0ed9d23def5102f358efec1ab495d174f9f970` and deployed privately:
`appgprj_6ac1a5ac25348191b57a5391e9d1d3f7~appgver_b324389cfc048191a4d3c7a2efa832d4`.
Deployment `appgdep_6ad7309630c8819181fbb80e58bb16de` succeeded. Card and category
pages in both locales displayed Aurora II and the new image. Four HTML files
and release.json changed; eleven other authored files were identical.

The saved baseline Sites version was then restored without creating a new
content release:
`appgprj_6ac1a5ac25348191b57a5391e9d1d3f7~appgver_eba62276f9c88191824af498469975e7`.
Restore deployment `appgdep_6ad7310f9de4819188381932ad6efecc` succeeded. Private
HTTP probes verified the authored bytes of 11 HTML pages, stylesheet, favicon
and release.json against local baseline hashes. Sites appends a dynamic script
before the original closing body/html tags; the verifier checked all original
bytes around that insertion rather than claiming raw HTTP responses identical.

CMS rollback restored verified publication
`c967ce93-426c-4c2f-94f1-e1e5c546bc09`, baseline hash
`f0b0ec4ecfa97fa1be705b1e0beac309f3f9630ee1367f63f0eccb8113e13d6b`.
All 12 reviewed output file hashes matched live after rollback, including the
byte-identical redirect proof. Both real 301 destinations matched; all six old
media URLs remained available. The active CMS and Sites content are baseline.
The newer Sites version remains saved; the source branch still points to v2.

## Automated evidence

On runtime/main `a631ed2e3d044cecc75b7f0071313b76170a621f`, the existing encrypted
Neon helper created its own fresh database on agent-tests and passed pnpm check:
252/252 tests, zero skipped, 10 browser checks and all five SQL isolation suites.
Upgrade and migration replay passed; the temporary database was removed.

After the response-status correction and account-switch browser regression,
local pnpm check passed 196 tests (56 PostgreSQL tests skipped without URLs) and
11 browser checks. The PR CI independently runs the complete PostgreSQL suite,
all five isolation scripts and production container build against its exact SHA.
The PR records its resulting CI and merge; deployment and read-only post-release
checks are recorded in the workspace acceptance evidence, without credentials.

The enforced limits are 25 MiB per JPEG/PNG upload, 40 million decoded pixels
and at most 512 output files / 8 MiB delivery bytes. The synthetic updated
artifact used 12 files / 19044 bytes. Approval-to-verified publication took
53.2 seconds in this run, including agent coordination; Sites v2 deployment
returned in about 27.6 seconds and restore in about 19 seconds. These are fixture
measurements, not an application-wide performance SLA.
No storage keys, credentials, bearer values or confirmation capability URLs are
included in this report.
