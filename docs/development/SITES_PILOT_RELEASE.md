# NavoCMS and Sites release program

Authorized by the owner on 2026-10-04: finish 8.2, implement 8.3 and 9.1, then Sites
Pilot A and B using a separate Sites project. Implementation preparation may continue
while the owner completes browser review. Acceptance order remains sequential.

## Status

- 8.2: live owner decision pending; do not mark accepted.
- 8.3: implementation candidate; upload, site snapshot, locale and media gates pending.
- 9.1: implementation candidate; canonical schemas and field/reference gates pending.
- Sites A: separate owner-private project registered; no deployment accepted yet.
- Sites B: end-to-end human release, change and rollback rehearsal pending.

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
