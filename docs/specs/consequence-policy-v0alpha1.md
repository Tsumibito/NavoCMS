# Consequence policy v0alpha1

Consequence describes the effect of an operation, not how technically difficult it is.

| Level | Meaning | Examples | Baseline control |
|---|---|---|---|
| G0 | Read-only | Read content, public state, approved aggregates | Authenticated scope, quota, redaction |
| G1 | Internal reversible | Draft, proposal, preview, media transform | Allowlist, idempotency, bounded artifacts |
| G2 | Public reversible | Publish content/metadata, reversible redirect | Exact preview hash, publisher approval initially |
| G3 | External commitment | Send email, enroll CRM sequence, grant entitlement | Fresh evidence, named policy/approval, suppression |
| G4 | Financial/legal/destructive | Charge, refund, delete, permanent URL change | Dedicated workflow, disabled by default |

## Rules

- The manifest declares the minimum consequence of each effect; site policy may raise it.
- A plugin cannot lower consequence at runtime.
- G1–G4 effects require an idempotency key.
- G2 requires a verified rollback target or an explicit policy exception.
- G3 requires compensation/suppression semantics where possible.
- G4 is unavailable until a dedicated domain plugin, threat model, and approval workflow exist.
- Automatic approval is scoped to a narrow action after production evidence, bounded volume,
  independent evaluation, cooldown, and rollback are demonstrated.

## Approval integrity

An approval records actor, scope, policy version, evidence, expiry, and exact input/release hash.
Changing any approved input invalidates it. Service accounts and plugin workers cannot act as human
approvers.
