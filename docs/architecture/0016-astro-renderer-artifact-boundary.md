# ADR 0016: Astro renderer artifact boundary

## Decision

`@navocms/design-astro` emits a deterministic static Astro source bundle, not a
preview, deploy, or release workflow. The bundle contains a pinned `package.json`,
`astro.config.mjs`, a versioned shared delivery layout, compiled design CSS,
generated registered components, route pages, and an immutable manifest.

The renderer accepts pinned content revisions, a complete Astro design adapter,
route/locale declarations, media variant URLs, and the content/design/delivery/
governance anchors, an externally expected media digest, and a pinned delivery
layout. It binds route title, component, canonical route path, locale, source hash,
and media to the content digest. Route, registration, and media digests each
normalize input order independently; SHA-256 is recorded for every generated
source file. The final artifact hash binds the manifest itself, so verification requires that
hash from an immutable release binding rather than trusting a hash supplied inside
the artifact. A source bundle is rejected if an anchor drifts, a route collides,
a supported locale is absent for a route, a component is unbound, media is absent
or non-public, or content requires unsupported raw HTML/directives.

The shared delivery layout is an `io.navocms.delivery-layout.v1` source contract.
Its actual built HTML, rather than frontmatter, comments, or text lookalikes, must
contain the Zaraz script with its exact source and marker plus real consent-bridge
and analytics-bootstrap elements. `verifyBuiltAstroOutput` uses a full HTML parser,
rejects template/raw-text lookalikes, duplicate attributes, non-executing scripts,
and route parity drift. It accepts the immutable artifact and external expected hash,
derives expected `.html` paths from generated `src/pages/**/index.astro`, and bounds
the complete output set. Every future build or release capability must call it before
using built output. The
renderer preserves its reviewed source
verbatim and binds its digest to the delivery anchor; it does not invent browser
globals as a substitute. It consumes supplied route URLs as-is and does not rewrite
or invent public URLs.

## Consequences

The public manifest shape is described by the versioned JSON Schema and isolated
valid/adversarial fixtures. Verification rejects invalid format/schema/digest
shape, unsafe or duplicate paths, omitted or extra source files, and bundles over
their aggregate bound. The manifest envelope file is deliberately excluded from
its own file list to avoid a self-hash cycle; it is covered by the external
immutable artifact hash. Materialization accepts only a new or empty non-symlink
directory, so stale files and link traversal cannot enter the rendered project.

Markdown rendering uses the content package's canonical parser and safe semantic
HTML subset: headings, lists, links, and only declared directives become output;
raw HTML and unrecognised directives fail closed. For backward compatibility,
adapter callers may still pass
legacy registrations without `source`; those sources are normalized deterministically
for non-v1 consumers, while v1 rendering fails closed until an explicit pinned
source is supplied. This capability has no credentials, Cloudflare binding,
deployment side effect, release state, or idempotency mechanism. Building and
deploying the exact verified source bundle remain later capabilities.
