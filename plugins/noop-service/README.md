# No-op service plugin

An independently deployable TypeScript example that imports neither the trusted kernel nor its
process authority. It demonstrates:

- a versioned plugin manifest;
- an unauthenticated liveness endpoint;
- bearer authentication for the operation endpoint;
- bounded request validation;
- required idempotency keys and deterministic replay;
- no data or outbound-network permission.

It exists to verify the service boundary, not as a useful production plugin.
