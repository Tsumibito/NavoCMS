# @navocms/kernel

The trusted NavoCMS microkernel currently provides:

- versioned capability definition/provider registry;
- validated plugin graph resolution and cycle detection;
- provider health preflight and dependency-ordered activation;
- reverse-order cleanup after activation failure or shutdown;
- append-only Event Store interface and in-memory reference implementation;
- strict trajectory projection;
- OpenTelemetry span correlation from domain events;
- deterministic release manifests, exact artifact hashing, legal state transitions, and a
  provider-neutral publication/verification/rollback interface.

The kernel intentionally has no HTTP framework, site-specific content semantics, concrete delivery
provider, or production persistence. PostgreSQL and transport adapters remain outside it.
