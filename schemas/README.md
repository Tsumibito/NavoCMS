# Machine-readable contracts

These JSON Schemas are the executable `navocms.io/v0alpha1` foundation contracts.

| Schema | Fixtures |
|---|---|
| [`plugin-manifest.schema.json`](plugin-manifest.schema.json) | `examples/plugins/*.json` |
| [`site-profile.schema.json`](site-profile.schema.json) | `examples/profiles/*.json` |
| [`content-type.schema.json`](content-type.schema.json) | `examples/content-types/*.json` |
| [`design-system.schema.json`](design-system.schema.json) | `examples/design-systems/*.design-system.json` |
| [`design-override.schema.json`](design-override.schema.json) | `examples/design-systems/*.design-override.json` |
| [`event-envelope.schema.json`](event-envelope.schema.json) | `examples/events/*.json` |
| [`astro-artifact-manifest.schema.json`](astro-artifact-manifest.schema.json) | `examples/astro/*.astro-artifact-manifest.json` and adversarial fixtures |

Run `pnpm check:contracts` to compile all schemas, validate fixtures, and apply cross-field semantic
checks that JSON Schema alone does not express clearly.

`v0alpha1` is intentionally experimental. Breaking changes require an updated specification,
fixtures, tests, and compatibility note in the pull request.

The Astro artifact manifest is a separate immutable `v1` bundle-internal contract. Its
schema validates the manifest shape and safe file paths; `verifyAstroArtifact` additionally
requires exact source-file coverage and binds the manifest envelope to an externally supplied
immutable artifact hash. Legacy renderer registrations without pinned
source remain supported only by the adapter normalizer and are deliberately rejected by this
v1 artifact contract.
