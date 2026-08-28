# Sprint 8R.5A — R2 runtime binding runbook

**Status:** Active on staging

## Scope

The versioned `io.navocms.r2-runtime-binding.v1` contract activates one shared
R2 transport with isolated `navocms/v1/media/` and
`navocms/v1/artifacts/` stores. It does not alter the Pages binding or production.

The binding is scoped to one tenant/site and the fixed `navocms/v1/` prefix. Existing objects in
other prefixes remain outside this runtime capability.

## Private deployment overlay

Set the following names only in the encrypted dotenvx deployment overlay. Keep values empty in
public examples and never print decrypted values:

- `NAVOCMS_R2_RUNTIME=r2`
- `NAVOCMS_R2_RUNTIME_BINDING` — reviewed JSON binding
- `NAVOCMS_R2_RUNTIME_BINDING_DIGEST` — canonical `sha256:` digest of that binding
- the two `DOTENVX_SECRET_*` names projected from the binding's secret references

The binding itself must contain only its endpoint origin, bucket, `navocms/v1/`, tenant/site,
staging environment, and secret-reference names. Do not add account IDs, endpoint paths, tokens,
access keys, secret keys, dotenvx decryption keys, or encrypted files.

## Preflight

1. Validate the binding schema and adversarial fixtures.
2. Confirm production runtime mode plus staging environment.
3. Confirm exact deployment tenant/site and independently reviewed digest.
4. Confirm the two references are distinct after dotenvx name normalization and are available
   without logging or returning their values.
5. Check `/readyz`; it may show only safe identifiers, bucket,
   `navocms/v1/`, and digest. Readiness verifies the three reviewed namespace
   markers using bounded reads. Stop if credential material appears.

## Stop and rollback

Stop before transport construction for any missing/empty/short reference, reference collision,
scope mismatch, stale digest, non-staging environment, non-production mode, malformed endpoint,
or namespace drift. Roll back by disabling `NAVOCMS_R2_RUNTIME`; do not delete retained bucket
objects or alter unrelated prefixes.
