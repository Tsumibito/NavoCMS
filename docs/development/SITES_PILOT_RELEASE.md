# NavoCMS and Sites release program

Authorized by the owner on 2026-10-04: finish 8.2, implement 8.3 and 9.1, then Sites
Pilot A and B using a separate Sites project. Implementation preparation may continue
while the owner completes browser review. Acceptance order remains sequential.

## Status

- 8.2: real owner decisions, release/restart/rollback verified; final live UX review pending.
- 8.3: full-site update, locale/media preservation and live rollback verified.
- 9.1: core tools implemented; three unfamiliar MCP tasks remain unaccepted.
- Sites A: owner-private baseline deployed and its authored files verified.
- Sites B: changed linked record/image deployed as v2; saved v1 restored and verified.

See [dated acceptance evidence](../operations/SPRINT_8_2_8_3_ACCEPTANCE_2026_10_20.md)
for exact IDs, test counts and live browser/provider limitations. The active CMS
and Sites content are baseline after the restore test; the Sites source branch
remains at the newer saved version.

## Pilot

Five logical pages, English and French, shared navigation/footer, a catalogue category
and related catalogue records, two synthetic JPEG images, and one unrelated draft.
Use only synthetic public test content. No production Navi import or cutover.

## Acceptance

Keep evidence for each criterion in a submission report, with exact implementation SHA,
CI, migration and deployment identifiers. Run all PostgreSQL gates without skips.
Sites bundles pin the CMS snapshot hash and release hash and preserve the exact saved
source SHA. Publish a baseline, change a linked record and an image, review the new
snapshot, then restore the previous complete Site version and verify route/media hashes.
Do not substitute an in-memory demo or a green unit test for live acceptance.
