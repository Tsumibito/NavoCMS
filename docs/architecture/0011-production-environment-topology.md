# ADR 0011 — Production environment topology

**Status:** Accepted

**Date:** 2026-08-22

## Context

NavoCMS must dogfood `navocms.com` before the hosted product exists. The control plane needs a stable
integration target while content and schema previews remain cheap and disposable. The first
reference deployment uses an operator-managed Coolify Docker host and Neon Postgres with
scale-to-zero.

## Decision

Maintain separate long-lived `staging` and `production` application environments. Each environment
uses a distinct Neon branch/compute endpoint, OAuth audience, hostname, dotenvx key, and Coolify
application. Both Neon computes keep scale-to-zero enabled.

Protected editorial previews are immutable release artifacts created by the publication workflow;
they do not replace staging. Pull requests that modify persistence may additionally receive a
short-lived Neon `preview/pr-*` branch. Preview environments therefore have a stable environment key
and are not constrained to one preview row per site.

Run the public site as a separately rendered artifact. A sleeping or unavailable control plane may
delay editing and publishing but must not take the published site offline.

Use Neon's pooled endpoint for the long-running application and a direct endpoint for migrations,
logical backup, and restore. The application login is `NOBYPASSRLS`; the Neon branch owner is never
available to the running container.

## Consequences

- Staging has a small permanent operational cost footprint but can still scale to zero.
- Every schema migration is proven on persistent staging before production.
- Content previews remain fast and numerous without duplicating the whole control plane.
- Deployment providers remain replaceable; Coolify and Neon are the first provider configuration,
  not trusted-kernel dependencies.
- Production promotion is a release operation, not a rebuild from an arbitrary branch head.

## Validation

Sprint 6 must prove ordered migrations and forced RLS on Neon, build one Docker image for both
environments, expose liveness/readiness, and document an identical Coolify rollout path. Sprint 7
must prove that protected previews do not require a new staging application.
