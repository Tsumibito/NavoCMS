# Sprint 8B package 1 — Astro renderer boundary

## Status

CI passed / Ready for review. This report does not close the Sprint 8B gate or
authorize deployment.

## Scope

- deterministic Astro source artifact with file-hash manifest;
- content, design, delivery, governance, and media digest binding;
- fail-closed route, locale, component, media, content, and aggregate bundle validation;
- versioned manifest schema plus isolated valid/adversarial fixtures for unsafe,
  duplicate, omitted/extra, and oversized file cases;
- semantic safe Markdown rendering for headings, lists, links, and declared directives;
- materialized pinned Astro `check`/two-clean-build full-`dist` determinism and tamper matrix;
- parser-backed whole-output delivery verification, including inert/raw-text,
  duplicate-attribute, and non-executing-script adversarial cases;
- immutable artifact-derived output route parity and aggregate built-output bounds;
- retained immutable paths plus a digest-bound delivery layout contract for Zaraz,
  consent bridge, and analytics bootstrap.

No Cloudflare deployment, credentials, production activation, or release/
idempotency mechanism is included.

## Required evidence before closure

- GitHub CI with PostgreSQL tests running without skips;
- manifest determinism, drift, tamper, and invalid-input evidence;
- production container build; retained CI URL added here after success.

## Retained CI evidence

- [GitHub Quality checks run 32829843564](https://github.com/Tsumibito/NavoCMS/actions/runs/32829843564)
  passed on commit `3546c83d25f96a81b1bece221ff16ae7c92dbe3c`.
- The run provisioned PostgreSQL, executed the full suite and isolation SQL, and
  built the production container without skipped persistence coverage.

## Local completion evidence

- strict verifier rejects malformed schema/format, unsafe or duplicate paths,
  omitted/extra files, stale directories, and aggregate-bound violations;
- every generated source file is manifest-hashed; the manifest envelope is covered
  by the required external immutable artifact hash rather than an impossible self-hash;
- the verified artifact materializes into a pinned Astro project, passes Astro check,
  and produces byte-identical HTML across two sequential builds;
- layout, configuration, CSS, pages, registrations, and media bindings are all
  independently digest-bound; route, registration, and media collection order is
  normalized before identity calculation;
- all runtime inputs have per-item and aggregate bounds.

Local PostgreSQL skips were limited to the pre-CI handoff; the retained GitHub run
has real PostgreSQL coverage. This report remains **CI passed / Ready for review**
and does not claim a closed operational gate.
