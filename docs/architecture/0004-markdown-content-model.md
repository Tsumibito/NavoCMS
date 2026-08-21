# ADR 0004 — Markdown content model

**Status:** Proposed

**Date:** 2026-08-21

## Context

Agent clients work naturally with text. Proprietary rich-text trees such as Lexical are awkward to
review in conversation, reduce portability, and leak editor implementation into the content model.
Plain Markdown alone does not represent every structured page block safely.

## Decision

Store prose as CommonMark/GFM-compatible Markdown plus a restricted set of typed directives.
Persist source Markdown and hash as canonical revision data; store parsed AST and renderer output as
versioned reproducible artifacts. Directives reference design-system components through validated
schemas and stable semantic identifiers.

Documents, variants, relations, revisions, and releases have first-class relational identity.
Custom type fields may use schema-validated JSONB with declared indexes. Lead/customer PII uses an
isolated domain schema and roles rather than generic content JSONB.

Managed content forbids arbitrary MDX, JavaScript, and unsafe HTML.

## Consequences

- Articles are readable and editable in any agent interface.
- Structural patches require stable AST node identity, source hashes, and conflict detection.
- Renderer components remain code and are changed through normal development.
- Legacy imports retain original source artifacts for audit and retry.

## Alternatives considered

- **Lexical/ProseMirror JSON as canonical:** rejected for agent ergonomics and portability.
- **HTML as canonical:** rejected because safe structural editing and semantic validation are weak.
- **MDX:** rejected because managed content must not carry executable authority.

## Validation

Sprint 3 must demonstrate semantic round trips, stale-patch rejection, directive validation, safe
rendering, conflict handling, and deterministic conversion of representative legacy articles/pages.
