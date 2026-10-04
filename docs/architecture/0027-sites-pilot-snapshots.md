# ADR 0027: site snapshots and the Sites pilot

Status: implementation candidate. Operational acceptance is pending.

## Decision

NavoCMS retains identity, PostgreSQL isolation, immutable revisions, media and human
publication decisions. Sites hosts a separate frontend using a pinned public snapshot.
Sites deployment does not issue or replace a NavoCMS human confirmation receipt.

Preview starts with the previous published route set, then replaces only explicitly
selected revisions. Additional revisions are an explicit bounded MCP input. Unrelated
heads never enter a release. A new locale uses the same document and a separate variant.
The shared renderer keeps complete locale coverage by default; the reviewed staging
profile explicitly selects available coverage for pages without mandatory translations.
This is an additive internal render-input option, not a change to published schemas.

The snapshot governance anchor binds the previous publication ID. An append-only,
site-scoped snapshot table records that binding. Publication locks the environment,
rejects another publishing release, and rejects a stale baseline before provider work.
Existing single-page candidates remain readable; their historical approval semantics
are unchanged. They must not be used to claim the new site-wide gate.

Content schemas are discovered from reviewed registered definitions. MCP no longer
hardcodes the content type enum. Field patches validate against that definition and
retain the current-head check. Slug, locale and body have dedicated workflows. UUID
relation fields validate the target type and site; legacy non-reference prose fields
are not silently reinterpreted as relation IDs. Dependency discovery is paginated.

Browser upload capabilities have durable hashed tokens, site and intent bindings,
expiry, and a 25 MB request bound. Size, signature and checksum are checked before
storage. Finalization and responsive preparation reuse existing idempotent operations.
MCP receives identifiers and summaries, never image bytes. Text and field changes copy
active media references into the new immutable revision, including alternative text.

The delivery API exposes only a release that has a verified publication. Its export
contains exact revisions, fields, semantic HTML, routes and media addresses, plus a
snapshot hash. The immutable media endpoint permits only variants present in previously
verified snapshots. Protected preview capabilities authorize their own media separately.
Old snapshots and images remain available for rollback. Hosted frontend bundles pin
one snapshot; a later CMS change does not mutate an already deployed Site.

## Compatibility and rollout

Apply ordered migrations 0017 and 0018 before the new runtime. Keep existing encrypted
settings and the existing PostgreSQL/R2/Coolify profile. No Sites connector eligibility,
visitor identity or database relocation is assumed. The pilot Site remains owner-private.
Registered catalogue types are a reviewed bundled pack, not runtime schema editing.

## Required evidence

Fresh/upgrade/repeated migrations, PostgreSQL RLS and independent SQL isolation;
MCP discovery and invalid-field/reference tests; scoped upload expiry/hash/type/size;
five routes, two locales, unaffected drafts, stale publication and media retention;
real preview, independent human decision, publication and rollback; exact Sites source,
snapshot, saved version and deployment mappings. None is closed by code completion alone.
