# Architecture reference map

NavoCMS borrows tested ideas from existing systems and standards while preserving its own product
boundary. A reference is inspiration or interoperability guidance, not automatically a dependency.

## Plugin architecture

- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md):
  capability definitions/providers/consumers, composable profiles, typed events, guarded tools, and
  reversible effects.
- [Fastify plugins](https://fastify.dev/docs/latest/Reference/Plugins/): encapsulated dependency
  graph and scoped registration in TypeScript.
- [Backstage backend plugins](https://backstage.io/docs/backend-system/architecture/plugins/):
  explicit plugin/module extension points and public service boundaries.

## Portable contracts

- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12): machine-readable manifests,
  profiles, content types, tool input/output, and configuration.
- [CloudEvents](https://github.com/cloudevents/spec): interoperable external event envelope.
- [Model Context Protocol](https://modelcontextprotocol.io/): agent tools, resources, and optional
  application UI interoperability.
- [OpenAI MCP server guidance](https://developers.openai.com/plugins/build/mcp-server):
  goal-oriented tools and remote MCP product boundaries.
- [OpenAI MCP Apps UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui): focused
  portable review surfaces whose underlying tools also work without UI.

## Content and design

- [unified](https://github.com/unifiedjs/unified) and [mdast](https://github.com/syntax-tree/mdast):
  Markdown syntax-tree processing and transformations.
- [Design Tokens Community Group format](https://www.designtokens.org/tr/2025.10/): portable design
  token semantics.
- [Schema.org](https://schema.org/) and [Google structured-data policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies):
  semantic entities and visible-content parity.

## Durability, policy, and isolation

- [DBOS](https://docs.dbos.dev/), [Restate](https://docs.restate.dev/tour/workflows), and
  [Temporal event history](https://docs.temporal.io/workflow-execution/event): candidate patterns for
  durable execution, replay, signals, and external effects.
- [PostgreSQL Row Security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): database
  defense-in-depth for tenant/site isolation.
- [Open Policy Agent](https://www.openpolicyagent.org/docs): reference for policy/data separation;
  adoption is not decided.
- [WASI](https://wasi.dev/): possible future boundary for deny-by-default pure transforms.

## Quality and media

- [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci) and
  [axe-core](https://github.com/dequelabs/axe-core): performance and accessibility release gates.
- [imgproxy](https://docs.imgproxy.net/usage/processing) and
  [Sharp](https://sharp.pixelplumbing.com/): candidate responsive image providers with modern format
  support.
