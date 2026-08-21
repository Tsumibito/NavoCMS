# `@navocms/content`

Agent-readable content engine for NavoCMS. Canonical content is portable Markdown, not an editor's
private JSON format. The package provides:

- declarative content types and reusable editorial, marketing, and business packs;
- GFM plus allowlisted typed directives, with raw HTML rejected;
- immutable documents, locale variants, revisions, and typed relations;
- content-addressed AST node identifiers and source-hash structural patches;
- conflict detection, line diffs, portable site export/import, and strict Lexical conversion.

Agents normally read and edit Markdown. AST descriptors are used when a request must address one
specific heading, paragraph, link, or text node without replacing the whole article. An unchanged
unique node keeps its identifier when unrelated content moves around; a revision source hash still
guards every patch against stale edits.

The in-memory engine is an executable reference model. PostgreSQL storage uses the same immutable
and tenant/site-scoped contracts through the ordered migration in
[`@navocms/persistence-postgres`](../persistence-postgres/README.md).
