# Event envelope v0alpha1

NavoCMS uses a CloudEvents-compatible envelope for portable domain events. Technical workflow
history may live in a workflow engine, but this envelope is the authoritative human-readable audit
and integration boundary.

## Required context

- CloudEvents `specversion`, `id`, `source`, `type`, `time`, and `datacontenttype`;
- `navotenantid` and `navositeid` for site-owned events;
- `navocorrelationid` and optional `navocausationid`;
- `navoconsequence` from `G0` through `G4`;
- actor type and opaque actor ID;
- schema version and redacted domain `data`.

Effects also carry an idempotency key. Artifact references contain URI, media type, and integrity
digest rather than embedding unbounded content.

## Data policy

Events may record inputs/outputs necessary to explain a decision, but must not contain credentials,
decrypted secret values, hidden model reasoning, unrestricted prompts, or full lead/customer PII.
PII plugins emit opaque record references and approved projections.

## Evolution and delivery

- Event types include a semantic version suffix.
- Consumers are idempotent and tolerate duplicate delivery.
- Ordering is guaranteed only within explicitly documented aggregate streams.
- A producer never reuses an event ID or changes an already emitted event.
- Corrections use a new event referencing the original.
