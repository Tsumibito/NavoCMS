# @navocms/kernel

The trusted NavoCMS microkernel currently provides:

- versioned capability definition/provider registry;
- validated plugin graph resolution and cycle detection;
- provider health preflight and dependency-ordered activation;
- reverse-order cleanup after activation failure or shutdown;
- append-only Event Store interface and in-memory reference implementation;
- strict trajectory projection;
- OpenTelemetry span correlation from domain events.

The kernel intentionally has no HTTP framework, site-specific content semantics, concrete plugins,
or production persistence. PostgreSQL implementations and tenant identity arrive behind these
interfaces in later gated sprints.
