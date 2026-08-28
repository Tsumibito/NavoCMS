# R2 runtime binding v1

**Contract:** `io.navocms.r2-runtime-binding.v1`  
**Schema:** [`r2-runtime-binding-v1.schema.json`](../../schemas/r2-runtime-binding-v1.schema.json)  
**Status:** review required

## Purpose

This is the transport-neutral runtime contract for the staging R2 capability. It is deliberately
separate from the Cloudflare Pages staging binding. It identifies one exact tenant/site and stores
only an HTTPS endpoint origin, a bucket identifier, the fixed `navocms/v1/` namespace, and two
dotenvx secret references. It never stores account identifiers, endpoint paths, access-key values,
secret-key values, tokens, dotenvx keys, or encrypted environment material.

The endpoint is an origin (`https://host` with no credentials, path, query, or fragment). The
bucket is a bounded lowercase provider identifier. The namespace is closed to exactly
`navocms/v1/`, so retained objects in other prefixes cannot become part of this capability.

## Activation contract

The binding is accepted only when all of the following hold, in order:

1. runtime mode is `production`;
2. deployment environment is `staging`;
3. binding tenant and site equal the deployment tenant and site;
4. the independently supplied reviewed digest equals the canonical binding digest;
5. both secret references are structurally valid, map to distinct dotenvx names, and resolve to
   non-empty values of at least 16 characters.

Failure at any gate is closed before a future R2 transport is constructed or invoked. This sprint
does not implement that transport or perform an R2 call.

## Readiness and compatibility

Once a future transport integration has completed its bounded readiness probe, `/readyz` may
expose only `provider`, tenant/site identifiers, bucket identifier, fixed `prefix` or `namespace`,
and the reviewed binding digest. This Phase A contract does not declare R2 ready by itself. The
endpoint, secret references, dotenvx variable names, and secret values must never be exposed.
`NAVOCMS_R2_RUNTIME_BINDING_DIGEST` is the review pin; changing any binding field requires a new
reviewed digest. This v1 contract is additive and independent of the existing Cloudflare Pages
binding versions; those versions are not widened or repurposed.
