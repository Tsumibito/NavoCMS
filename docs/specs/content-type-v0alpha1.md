# Content type v0alpha1

Content types define collections declaratively. They are data contracts, not executable packages.
A content pack may distribute several content types plus optional workflows, tools, and renderer
adapters.

## Definition

- stable name, semantic version, title, and description;
- JSON Schema for fields;
- relation definitions with cardinality and delete behavior;
- localization mode and required locales;
- declared indexes for queryable JSONB fields;
- required renderer capabilities;
- default editorial workflow;
- role permissions and retention class.

## Storage boundary

The kernel gives documents, variants, relations, revisions, releases, and release items relational
identity. Type-specific fields may use validated JSONB. Fields containing lead/customer PII do not
belong in general content types; domain plugins use isolated schemas and projections.

## Managed prose

Markdown fields contain CommonMark/GFM plus allowed typed directives. A definition lists permitted
directive capabilities. Unknown directives, properties, executable MDX, JavaScript, and unsafe HTML
fail validation.

## Evolution

Every definition change has a semantic version and migration/compatibility note. A published
revision retains the schema/parser versions required to reproduce its artifacts.
