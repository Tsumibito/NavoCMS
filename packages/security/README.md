# `@navocms/security`

Trusted, transport-neutral security primitives for NavoCMS: principal and scope evaluation, OAuth
resource-server metadata and token verification, secret brokering, storage-key isolation, quotas,
kill switches, and projection redaction.

The package is deliberately provider-neutral. An identity provider issues OAuth access tokens; this
package verifies them and maps immutable claims to a NavoCMS principal. Effective token authority is
read from the OAuth `scope` string and, when an issuer supplies it, a validated `permissions` array;
the persistence layer still intersects those values with known NavoCMS permissions and membership.
Secret managers, object
stores, and durable quota meters implement the interfaces defined here.
