# Machine-readable contracts

These JSON Schemas are the executable `navocms.io/v0alpha1` foundation contracts.

| Schema | Fixtures |
|---|---|
| [`plugin-manifest.schema.json`](plugin-manifest.schema.json) | `examples/plugins/*.json` |
| [`site-profile.schema.json`](site-profile.schema.json) | `examples/profiles/*.json` |
| [`content-type.schema.json`](content-type.schema.json) | `examples/content-types/*.json` |
| [`event-envelope.schema.json`](event-envelope.schema.json) | `examples/events/*.json` |

Run `pnpm check:contracts` to compile all schemas, validate fixtures, and apply cross-field semantic
checks that JSON Schema alone does not express clearly.

`v0alpha1` is intentionally experimental. Breaking changes require an updated specification,
fixtures, tests, and compatibility note in the pull request.
