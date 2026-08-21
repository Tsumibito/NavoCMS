# Content engine v0alpha1

The content engine keeps the authoring surface portable and conversational while retaining enough
structure for safe agent edits. Markdown is canonical. An AST descriptor is a reproducible,
non-executable projection used to address nodes; it is not a proprietary editor document.

## Canonical Markdown

- CommonMark/GFM is normalized to UTF-8 text with LF line endings and one trailing newline.
- Raw HTML, MDX, JavaScript, NUL bytes, unknown directives, and undeclared directive attributes are
  rejected.
- A content pack binds allowed typed directives to public content-type definitions.
- Metadata is validated against the content type's JSON Schema with `slug` and Markdown `body`
  supplied by the document/revision boundary.

## AST identity and patches

`navocms-markdown-ast/v1` exposes node type, source offsets, plain text, safe attributes, parent, and
a content-addressed node ID. IDs exclude absolute source position, so an unchanged unique node keeps
its ID when unrelated content is inserted or moved. Identical duplicate nodes receive occurrence
suffixes; callers must still bind every patch to the complete base source hash.

Structural operations are `replaceText`, `replaceNode`, `insertAfter`, and `remove`. The engine
rejects stale hashes, missing nodes, incompatible node types, duplicate targets, overlapping ranges,
and any result that fails Markdown/directive validation. A successful patch creates a new immutable
revision and a line diff; it never mutates its parent.

## Relational model

Documents own locale/key variants. Variants own ordered immutable revisions. Typed relations connect
documents within the same tenant/site. PostgreSQL stores every row with `tenant_id` and `site_id`,
uses forced RLS, and revokes revision update/delete from the runtime role.

## Portability and legacy conversion

A `navocms.io/portable-site/v1` bundle contains public type definitions, directive sets, documents,
variants, relations, revision metadata/provenance, and one Markdown file per revision. Import
recomputes every AST and verifies every source hash before accepting the bundle. Secrets and
secret-shaped metadata are rejected from the ordinary export surface.

The initial strict legacy converter accepts representative Lexical headings, paragraphs, formatted
text, links, lists, quotes, images/uploads, rules, and line breaks. It produces canonical Markdown
plus a hash of the original artifact. Unsafe URLs and unsupported nodes fail closed instead of being
silently dropped.
