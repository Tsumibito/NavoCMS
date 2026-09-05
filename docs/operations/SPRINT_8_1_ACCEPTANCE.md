# Sprint 8.1 — independent acceptance

**Status: accepted, 2026-09-05.** Sprint 8.2 may begin under its
[implementation handoff](../development/SPRINT_8_2_HANDOFF.md).
Staging only; no production deployment or content publication was performed.

## Accepted source and checks

- Implementation submission head: `76cb81f5b11fd71a263b328d9e829a68e1489a31`.
- Maintainer correction: `cdd26cf2ff59b6f7fdbe0f6f1fd2eaa71fe4b3d2`.
- PR [#53](https://github.com/Tsumibito/NavoCMS/pull/53) merged as
  `93170922932ca67902d3dac9d2627b7b903f6f2d`, preserving the newer CI changes from PR #54.
- Final PR [CI run 33993197717](https://github.com/Tsumibito/NavoCMS/actions/runs/33993197717):
  **227/227 tests, 39 files, no skips; 6/6 browser checks; 5/5 SQL isolation; container build PASS**.
- Exact merge [CI run 33993317364](https://github.com/Tsumibito/NavoCMS/actions/runs/33993317364): success.
- Maintainer local `pnpm check`: pass. Local PostgreSQL cases were skipped in that invocation;
  hosted CI above supplies the independent complete PostgreSQL gate. The implementer's three
  Neon runs remain separately reported in the [submission](SPRINT_8_1_SUBMISSION.md).

## Additional defect found and fixed during acceptance

The submission implemented `service.readContent({ metadataKey })`, but the MCP tool omitted
that argument from both discovery schema and its handler. A real MCP client therefore received
Markdown instead of omitted metadata. Direct service tests had missed the boundary defect.

The maintainer added a failing MCP Client/InMemoryTransport regression, exposed the argument
in tool discovery, forwarded it to the service, and updated the tool description. The regression
now creates a document through MCP, checks omission in `content_get`, reconstructs Unicode
metadata through windows, and checks the missing-field error.

Independent reproduction of the original 180,000-character metadata fixture now yields a
666-byte initial content projection and an exact reconstruction in ten MCP requests. The largest
serialized MCP window in that reproduction was 20,246 bytes. A publish/verification-failure
reproduction returns `applied`, then `unknown` on identical-key retry, with one provider effect.
These are bounded synthetic test measurements, not a universal UTF-8 byte limit.

## Staging deployment

Coolify application `navocms-staging` was pinned to the accepted merge SHA above, replacing
`af40f55c56eae8aab3534f5f0ed9846c2d72362f`. Deployment
`uuramcshocvz3ghb1iibyl9w` succeeded in 1m13s. No migration files changed in this sprint.
The running container independently reported `NAVOCMS_REVIEWED_SOURCE_COMMIT` equal to
`93170922932ca67902d3dac9d2627b7b903f6f2d`; only this non-secret value was read from its terminal.

`/healthz` returned `ok`; `/readyz` returned `ready` with the existing cloudflare-staging,
reviewed builder/resolver and R2 bindings. The authenticated MCP connection resolved the existing
`navocms.com` staging site `2e0bcd4f-6780-470c-844b-d72abb6737ca`.

## Authenticated live editing trajectory

Synthetic document `224bebd1-c8b3-42fe-9b37-fd84aa8e3df3`, slug
`sprint-8-1-acceptance-20260905`, was created only in staging.

| Revision | ID | Source hash |
| --- | --- | --- |
| r1 | `79382c37-c0bd-4624-832a-933a3b130089` | `1c5ae712ec380309d87feaa3d764fc1508f0a32ec558d3e9948862b26a2b90da` |
| r2 | `0a9cf4a8-072d-49ac-acfe-546c92947b19` | `59aec89d00af42b6a97dee98af5f44eba25335aaf22db1411d409743c9e67403` |
| r3 | `6dc32a62-022b-4af0-9360-d27e560707e4` | `91f4b4ef75a48c55486b8b3971b90bef2c9fd155834b1a5817fbd6065fbefd3f` |

1. Read r1 through MCP. Metadata omitted its Markdown mirror and exposed the new truncation fields.
2. A `replaceText` call targeting a paragraph container was correctly rejected with
   `PATCH_NODE_TYPE_INVALID`; the corrected call targeted its text child with a fresh key.
3. The first text change created r2. A different change based on r1 returned
   `REVISION_NOT_CURRENT`, current revision r2, its number and source hash.
4. Reading r2 and applying the second change with a fresh key created r3 containing both edits.
5. Replaying the successful first patch after r3 returned the original r2 result.
6. `revision_compare` r1 → r3 showed both requested changes.
7. `review_preview_handoff` returned ready/`previewed` and explicitly identified the result
   as a Markdown proof artifact, not final site design.
8. `release_status` confirmed `previewed`, not approved or published.

## Protected proof evidence

- Release: `36c5bbc6-959b-4252-9a91-5c61ab4cad80`.
- Release hash: `1fd9afbe82f3f62e67a4c870c7277a7d8e1a5d22d49990c77d8d26159328921a`.
- Artifact SHA-256: `0f82d742c60529debd8a22d7507367c1b6ea44ed7c43a8827727e8e9e5ad74f2`.
- Protected HTTP response: 200, 911 bytes; independently calculated body hash matches the artifact.
- `Cache-Control: private, no-store, max-age=0`; `X-Robots-Tag: noindex, nofollow, noarchive`.
- Capability URL omitted from this ledger. No approve/publish tool was called.

## Remaining scope

Real Astro preview before approval, independently verifiable human confirmation and durable
pre-review builds belong to Sprint 8.2. Cursor traversal does not promise a snapshot under
concurrent writes. Stored revisions and test evidence are retained; there was no destructive
cleanup of staging data. The current task's connector catalog predates `content_read`; its new
mode was independently tested through a fresh SDK MCP session on the accepted code, not falsely
reported as a live call through the old catalog. The live criterion-8 trajectory uses the actual
authenticated staging connector and is complete.
