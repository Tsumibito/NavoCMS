# Plugin manifest v0alpha1

A plugin manifest declares what a plugin provides, consumes, can access, and can cause. It is not
an authorization grant. Effective authority is always the intersection of actor, tenant, site,
profile, installation, plugin, tool, workflow, and consequence policy.

## Required fields

- `apiVersion`: `navocms.io/v0alpha1`;
- `kind`: `PluginManifest`;
- `metadata`: stable plugin ID, semantic version, display name, and description;
- `spec.runtime`: `kernel`, `module`, `service`, `ui`, or `sandbox`;
- `spec.provides`: capability name/version pairs;
- `spec.requires`: required or optional capability name/version pairs;
- `spec.permissions`: declared data collections, network hosts, and platform scopes;
- `spec.effects`: named operations with consequence, idempotency, and optional compensation;
- `spec.configSchema`: reference to configuration validation when configuration exists.

## Resolution rules

1. Verify the manifest source/signature according to installation policy.
2. Validate schema and supported API version.
3. Resolve required capabilities to an allowed compatible provider.
4. Reject missing, ambiguous, cyclic, incompatible, unhealthy, or over-permissioned graphs.
5. Plan registered migrations without executing them.
6. Require a configuration release before migration and activation.
7. Freeze the resolved graph for every workflow run.

## Runtime classes

| Runtime | Boundary |
|---|---|
| `kernel` | Reviewed first-party code shipped with the trusted kernel |
| `module` | In-process first-party/site module activated only at deploy/profile revision |
| `service` | Independently authenticated process over network/event contracts |
| `ui` | Sandboxed MCP Apps projection calling authorized MCP tools |
| `sandbox` | Future pure transform with deny-by-default WASI host capabilities |

In-process code is not security-isolated. Third-party code defaults to a service boundary until a
sandbox and supply-chain policy are implemented.

## Lifecycle

```text
discover → verify → validate graph → plan migrations → approve configuration
→ install inactive → migrate → healthcheck → activate → observe
→ drain → deactivate → uninstall
```

Registrations and subscriptions must be removable. Irreversible external effects require a higher
consequence policy and cannot falsely declare compensation.
