# ADR 0020: Direct validation for embedded and staging runtime selection

**Status:** accepted for Sprint 8R.3

## Decision

The MCP composition root validates the reviewed profile, provider manifest, staging binding,
resolver, and trusted builder directly. The embedded and staging paths no longer create a generic
kernel `PluginHost` merely to register the provider capability, report host status, or dispose an
empty activation scope.

The public profile and plugin-manifest contracts remain unchanged. The generic kernel
`PluginHost`, graph resolver, and capability registry remain available for independently deployed
OSS plugins and future runtime composition.

`/readyz` reports database readiness and the selected provider's real dependencies. For staging,
those dependencies are the reviewed Astro resolver and trusted builder; embedded readiness follows
the pinned provider selection. No decorative host state contributes to readiness.

## Consequences

- Startup still fails closed on profile, provider, binding, digest, version, and capability drift.
- Provider-specific secret, resolver, and builder checks remain at their existing boundaries.
- Historical Sprint 7.1 evidence continues to describe the runtime accepted at that time; this ADR
  records the subsequent simplification.
