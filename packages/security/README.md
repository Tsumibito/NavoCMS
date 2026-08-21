# `@navocms/security`

Trusted, transport-neutral security primitives for NavoCMS: principal and scope evaluation, OAuth
resource-server metadata and token verification, secret brokering, storage-key isolation, quotas,
kill switches, and projection redaction.

The package is deliberately provider-neutral. An identity provider issues OAuth access tokens; this
package verifies them and maps immutable claims to a NavoCMS principal. Secret managers, object
stores, and durable quota meters implement the interfaces defined here.
