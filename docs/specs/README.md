# Platform specifications

These documents describe the first public `navocms.io/v0alpha1` contracts. Machine-readable JSON
Schemas live in [`schemas/`](../../schemas/README.md).

| Specification | Purpose |
|---|---|
| [Plugin manifest](plugin-manifest-v0alpha1.md) | Capabilities, dependencies, trust, permissions, effects |
| [Site profile](site-profile-v0alpha1.md) | Four anchors, provider bindings, locales, and installed plugins |
| [Content type](content-type-v0alpha1.md) | Declarative collections, fields, relations, indexes, and policies |
| [Content engine](content-engine-v0alpha1.md) | Markdown, AST identity, revisions, patches, and portable bundles |
| [Design system](design-system-v0alpha1.md) | DTCG tokens, components, recipes, overrides, catalogues, and renderer bindings |
| [MCP editing](mcp-editing-v0alpha1.md) | Scoped discovery, drafts, stable patches, review UI, and preview handoff |
| [Event envelope](event-envelope-v0alpha1.md) | Portable domain audit and integration event metadata |
| [Consequence policy](consequence-policy-v0alpha1.md) | Effect levels, approval, idempotency, and compensation |

## Compatibility

- `v0alpha1` may change before a stable release, but every breaking change needs a compatibility note
  and updated fixtures.
- Consumers reject unknown major API versions.
- Providers declare exact capability versions; boot fails when no compatible provider exists.
- A workflow pins the resolved plugin/profile graph for its full lifetime.
- Schemas use closed objects where silent unknown fields would change authority or semantics.

## Naming

- API versions: `navocms.io/v0alpha1`.
- Plugin IDs: reverse-domain-like lowercase segments, for example `navocms.media.imgproxy`.
- Capabilities: lowercase dotted verbs/nouns, for example `image.transform`.
- Events: reverse-domain type names with version suffix, for example
  `io.navocms.content.revision-created.v1`.
- Site/profile slugs: lowercase ASCII letters, digits, and hyphens.
