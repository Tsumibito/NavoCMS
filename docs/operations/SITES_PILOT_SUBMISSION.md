# Sites pilot implementation submission

Status: implementation candidate; operational acceptance remains pending.

## Outcome

A separate owner-private Sites project consumes a pinned verified CMS snapshot.
NavoCMS keeps schemas, immutable revisions, relationships, media and independent
human publication decisions. The frontend source lives in the separate pilot checkout.

Sites project: `appgprj_6ac1a5ac25348191b57a5391e9d1d3f7`.
Slug: `navocms-sites-pilot-20261004`. Registration is complete; live deployment
and saved CMS/Sites version mapping are not yet accepted.

## Implemented boundaries

- Site snapshots preserve published sibling routes and include only selected drafts.
  Their governance anchor records the expected publication baseline. Publication and
  rollback share an environment lock and durable pending-operation checks.
- Shared navigation/footer and permanent catalogue redirects enter the reviewed bundle.
  New locale variants retain their document ID. The renderer preserves complete locale
  coverage by default; the staging profile explicitly allows available translations.
- Browser upload sessions bind hash, size, type, site, actor and expiry. Responsive
  variants are generated through the existing repository. Public media requires a
  historically verified snapshot; previews use their own protected release capability.
- Field/text patches preserve media alt/purpose and immutable old references. Registered
  catalogue schemas expose a category relationship and reject invalid fields/foreign IDs.
- MCP adds site passport, schema discovery, field changes and paginated dependency reads.
  The public export has an executable schema, hash check and adversarial fixture.
- Separate frontend builds ten fixture routes, localized navigation, relationships,
  responsive pictures and redirects; rebuilding the previous snapshot restores its files.

## Automated evidence

Final PostgreSQL-enabled `pnpm check`: **250/250 tests**, **10/10 browser checks** and
**5/5 SQL isolation suites** passed on 2026-10-04. Upgrade through migrations 0017/0018
and repeated no-op passed; the temporary database was removed. The final frontend
`npm test` passed its ten-route/update/restore checks. Documentation and local links pass.

During a transient Neon connection failure, the upstream client diagnostic serialized
a test credential. That test-only credential was rotated in the encrypted test checkouts;
the failed-run database and sensitive diagnostic were removed. The pool now handles idle
connection errors without serializing connection objects. No staging/production credential
was involved, and no secret entered committed source.

## Rollout and remaining acceptance

1. Record exact implementation SHA and successful CI, then merge the reviewed source.
2. Apply only new migrations 0017/0018 with the ordered migrator on the staging branch.
   Verify registry checksums/replay, RLS and append-only privileges.
3. Deploy that exact source to the existing staging container. Check readiness and
   authenticated MCP, historical snapshot/media delivery and the existing publication.
4. Finish the independent owner review for Sprint 8.2 and verify publish/reconcile/rollback.
5. Prepare the five-page/two-locale catalogue with two images and one unrelated draft.
   Review the complete candidate, publish it and verify unaffected routes, cache and media.
6. Save and privately deploy the separate Sites frontend from that exact public snapshot.
   Change a linked record/image, review and publish the next snapshot, then rehearse restore
   using the previous complete Sites version and verify route/media hashes.
7. Record owner acceptance and three unfamiliar MCP tasks for 9.1. Only then close the gates.

The current owner confirmation is still pending. The agent cannot issue that receipt
under [AGENTS.md](../../AGENTS.md) and ADR 0026. Automated checks, application deployment
or a Sites deployment do not substitute for the independent decision.
