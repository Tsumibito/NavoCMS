# ADR 0012 — Provider-neutral MCP OAuth and deployment-bound site scope

**Status:** Accepted

**Date:** 2026-08-22

## Context

Remote MCP clients require OAuth 2.1 protected-resource metadata, authorization-code with PKCE,
resource indicators, discovery, and a supported client registration method. A normal social-login
integration is not sufficient. Hosted issuers also use provider-specific access-token claims;
requiring NavoCMS UUID claims would couple the public core to one issuer and invite callers to assert
their own tenant or site.

## Decision

Keep the NavoCMS resource server issuer-neutral. The reference deployment uses WorkOS AuthKit because
it currently implements the MCP authorization profile, while Auth0 and compatible issuers remain
supported adapters. OAuth proves `issuer + subject`, audience, expiry, signature, and scopes.

Each deployed MCP resource is configured with exactly one tenant and site. PostgreSQL resolves the
verified `issuer + subject` to an internal identity and site membership through a narrow
security-definer function. Effective permissions are the intersection of token scopes, the persisted
site role, optional membership restrictions, and the operation policy. Token tenant/site claims are
optional; when present, they must match the deployment binding.

NavoCMS does not implement an authorization server. Provider keys and configuration remain private
deployment state, and the open-source repository contains only the portable verifier and resolver.

## Consequences

- A standard OIDC access token can work without proprietary internal-ID claims.
- Compromise of an access token for another NavoCMS resource fails audience and deployment-scope
  validation.
- A valid issuer user without a persisted site membership receives no NavoCMS access.
- The first administrator must be provisioned or invited with the issuer's stable subject before the
  production MCP connection can succeed.
- Multisite chat access uses separately addressable resources initially; a future tenant router may
  select sites only after authenticated membership discovery.

## Alternatives considered

- **Require custom UUID claims:** rejected as provider-coupled and unnecessary.
- **Trust tenant/site claims from every issuer:** rejected because resource scope belongs to NavoCMS.
- **Build an OAuth server into NavoCMS:** rejected as a high-risk security product outside CMS scope.
- **Use ZITADEL immediately:** deferred because its current DCR resource parameter does not narrow the
  token audience.

## Validation

OAuth tests cover deployment-bound standard tokens and claim conflicts. PostgreSQL integration tests
must prove issuer-subject membership resolution under a `NOBYPASSRLS` runtime role. Staging must
complete one authenticated MCP read before production promotion.
