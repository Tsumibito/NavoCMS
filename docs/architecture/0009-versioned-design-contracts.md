# ADR 0009 — Versioned design contracts and renderer adapters

**Status:** Accepted

**Date:** 2026-08-21

## Context

An agent-first CMS must let an operator change content and compose approved pages without allowing
routine content work to become arbitrary frontend development. A design system that exists only as
CSS or renderer-specific components cannot be inspected by an agent, pinned in a release, validated
before publication, or moved to another renderer.

At the same time, component implementations are necessarily framework-specific. Treating Astro,
Next.js, or another renderer as part of the design contract would make a site less portable and
would let renderer details leak into content.

## Decision

Represent a site design as a versioned `DesignSystem` contract with five bounded parts:

- DTCG-compatible primitive and semantic tokens, including explicit token references;
- component props, slots, variants, states, and accessibility requirements;
- page recipes that reference known components and constrain section cardinality;
- an override policy naming exactly which tokens and component variants may change by scope;
- catalogue viewports, locales, and themes that every renderer must exercise.

Compilation resolves token references, rejects missing references and cycles, emits stable CSS
variables, and calculates a deterministic SHA-256 digest. Design overrides are separate versioned
documents with target release, scope, reason, values, and optional expiry. An override outside the
base release policy fails closed.

Renderer adapters bind every declared component ID to an explicit implementation. The initial Astro
adapter rejects missing, duplicate, or unknown bindings before build. The generated Astro catalogue
is a review and verification surface, not a general CMS administration application.

## Consequences

- A release can pin an exact, inspectable design digest independently from its renderer.
- Agents select declared recipes and variants but cannot introduce arbitrary CSS, JavaScript, or
  components through routine content tools.
- A renderer swap requires a complete adapter binding and catalogue gates; it does not rewrite the
  portable design contract.
- Overrides remain exceptional, scoped, reviewable, and removable rather than accumulating as
  hidden CSS patches.
- Browser dependencies enter CI for responsive visual regression and accessibility checks.

## Alternatives considered

- **CSS and component repository as the contract:** rejected because the semantics are not portable
  or safely editable by agents.
- **Arbitrary JSON page builder:** rejected because unconstrained structure undermines consistency
  and accessibility.
- **Framework components inside content:** rejected because it couples content to one renderer and
  recreates executable MDX.
- **Pixel-perfect catalogue only:** rejected because screenshots cannot express component authority,
  allowed variants, or override policy.

## Validation

Contract fixtures must validate against public JSON Schemas and semantic relationship checks. Unit
tests must cover digest stability, token references, cycles, override policy, and complete Astro
bindings. The generated catalogue must build from the fixture, have no horizontal overflow at its
declared mobile viewport, pass WCAG 2.1 AA automated checks, and match committed desktop and mobile
visual baselines.
