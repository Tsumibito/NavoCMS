# Design system contract v0alpha1

## Purpose

The design contract is the portable, versioned boundary between site content and renderer code. It
describes the choices an agent may make and the quality fixtures a renderer must prove. It does not
contain arbitrary CSS, JavaScript, HTML, Astro components, or framework imports.

The machine-readable contracts are
[`design-system.schema.json`](../../schemas/design-system.schema.json) and
[`design-override.schema.json`](../../schemas/design-override.schema.json).

## Design system

A `DesignSystem` contains:

| Part | Contract |
|---|---|
| Metadata | Stable name, semantic version, title, and purpose |
| Tokens | Nested DTCG groups whose leaves use `$value`, optional `$type`, and description |
| Components | IDs, semantic element, JSON Schema props, slots, variants, states, and accessibility rules |
| Recipes | Ordered semantic slots referencing known component IDs with cardinality limits |
| Override policy | Exact token paths and components that scoped overrides may change |
| Catalogue | Required viewports, locales, and themes for renderer verification |

Token values may reference another token with an exact `{group.token}` string. Compilation resolves
aliases and rejects unknown paths or reference cycles. It emits deterministic `--navo-*` CSS custom
properties for primitive values. Composite token types remain part of the contract but a renderer
must explicitly declare and test how it serializes them.

Component props are data schemas, not executable component implementations. Variant names and
values are finite; every variant declares a valid default. Recipes can only reference component IDs
present in the same design release. A renderer that cannot bind every referenced component fails
before preview or publication.

## Overrides

A `DesignOverride` targets one design-system name and version and declares:

- a `site`, `locale`, `route`, or `content-type` scope;
- its creation timestamp, used to enforce the base policy's maximum lifetime;
- a human-readable reason;
- an optional expiry timestamp;
- token values and component variant selections.

The effective override is the intersection of the document and the base release's override policy.
Unknown tokens, unapproved components, invalid variant values, target mismatch, and expired
documents fail closed. Applying an override produces a new compiled digest; it never mutates the
base design release.

## Catalogue and quality gates

The catalogue is generated from the exact design definition and renderer bindings. It must expose
token groups, typography, component variants and states, recipe composition, and the release digest.
Required gates are:

- schema and semantic validation;
- complete renderer bindings;
- deterministic compilation and CSS output;
- committed desktop and mobile visual baselines;
- no horizontal overflow at declared viewports;
- automated WCAG 2.1 A/AA checks;
- visible keyboard focus and reduced-motion behavior.

Automated accessibility checks are a release floor, not a substitute for later manual review with
keyboard and assistive technology.

## Compatibility note

Sprint 4 adds `DesignSystem` and `DesignOverride` as new `navocms.io/v0alpha1` kinds. It does not
change the validation or meaning of the existing plugin, profile, content-type, event, or content
engine contracts. The site-profile design anchor already pins a reference, version, and digest; a
future release workflow will bind it to the compiled digest defined here.

Within `v0alpha1`, changing token serialization, override authority, component/recipe semantics, or
digest canonicalization is breaking and requires updated schemas, fixtures, tests, specification,
and an explicit migration note.
