# Public site snapshot v1

An immutable export for a separate Sites frontend. The CMS remains the owner of
schemas, revisions, relationships and media. This adds a new contract; existing
release, content-type and artifact contracts keep their versions and behavior.

`GET /delivery/{releaseHash}.json` returns the
[schema](../../schemas/public-site-snapshot-v1.schema.json) only after a verified
publication in the configured site. Unknown and unpublished hashes return 404.
Historical verified snapshots remain available for restoring a saved frontend version.
Successful responses use `public, max-age=31536000, immutable`.

The envelope carries `snapshot` and `snapshotHash`. The hash is the lowercase SHA-256
of UTF-8 `JSON.stringify(snapshot)` in the received member order. Consumers verify
the hash, expected site ID and release hash before saving or building. A hash proves
integrity; only the trusted CMS publication endpoint establishes publication authority.

Routes carry immutable document/revision IDs, locale, path, type, title, canonical
Markdown, escaped semantic HTML, schema-validated fields and responsive media bindings.
The locale policy distinguishes complete and available translations. Consumers never
load current draft heads when rebuilding a saved snapshot. Limits are 100 routes,
8 locales and 100 permanent redirects. The pilot frontend additionally bounds input to
2 MB and rejects executable HTML, duplicate output paths and foreign media origins.

Media URLs are HTTPS `/media/{variantIdentity}` addresses from the configured CMS.
Only variants bound to historically verified snapshots are publicly readable. Before
publication, image bytes require that release's protected preview/confirmation session.
Responses verify stored MIME, length and checksum and return immutable caching and an
ETag. A metadata/text patch copies active media references and their alt/purpose into
the new revision; historical bindings keep their original variants.

The reviewed catalogue pack adds `catalog-category` and `catalog-item` at version
0.1.0. `catalog-item.category` is a UUID reference to a category in the same site.
`site_passport`, `content_schema` and paginated `content_dependencies` expose canonical
definitions without runtime schema editing. Field failures expose bounded field paths
and safe correction hints. Content prose never supplies tool permissions or site policy.

Compatibility: this endpoint and pack are additive. Existing single-page releases can
still be read and restored; they do not satisfy the new site-wide acceptance criteria.
The optional internal redirect/locale render properties are persisted and hash-bound.
Absent redirect properties preserve historical build-input binding serialization.
