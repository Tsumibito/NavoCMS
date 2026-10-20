# Sprint 9.3 submission — Independent operation

Implementation status: technical verification and release. This submission is not an acceptance record.
Base: 2d2b51e1267c89985f7f8b96714410289e3c6460 (released Sprint 9.2).
Branch: codex/sprint93-self-operations. Final reviewed SHA/PR/CI/deployment and
release evidence are recorded in the operator audit after verification.

## Behavior and profile

[Self-hosting runbook](SELF_HOSTING.md) documents the supported Docker/WorkOS/
PostgreSQL 18/Cloudflare staging profile, fresh setup, identity, encrypted secret
entry, diagnostics, upgrade, recovery and failure handling. The separate
operations image contains matching pg_dump/pg_restore tools. Runtime credentials
do not gain backup or restore capability. The CLI uses existing application
bootstrap, migrations, RLS and namespace/storage adapters.

A consistent encrypted recovery bundle includes contracts, content revisions,
composition, comments, release state, object references, audit history and live
immutable object bytes. It verifies site scope and every table/object hash,
refuses an existing target schema and stops short of activation/publication.
Operator key material and personal identity handling have a separate procedure.

## Criteria and evidence

| Criterion | Verification | Status/evidence |
| --- | --- | --- |
| Documented clean setup | Registered migrations, repeat bootstrap, first preview on disposable database | Automated rehearsal in operations.integration.test.ts; full external account clean-room run pending owner environment. |
| Explicit dependencies | Self-hosting profile and complete public templates | Documented; no offline claim. |
| Coherent recovery | pg_dump exported snapshot, encrypted bytes, restore/table and object hashes | Integration rehearsal and measured evidence recorded below. |
| Safe upgrade/rollback | Existing migration checksum gate and fail-closed activation | No new migration; binary rollback does not reverse schema changes. |
| Real model clients | Ten goals × two fresh runs × two named clients | Pending; owner-selected Codex + ChatGPT Work, no scripted results substituted. |
| Completion/timing/safety | Strict evidence validator and transcript review | Validator implementation; real 90%/median/safety results pending. |
| Seven-day owner use | Human usage log and independent acceptance | Pending; cannot be satisfied by elapsed test time or automation. |
| Two authorized sites | Separately named OAuth connections/IDs | Endpoint/site pin documented; real receiver rehearsal pending. |

## Contracts and configuration

[ADR 0033](../architecture/0033-operator-recovery-bundles.md) records additive
operator-only recovery. No SQL schema change. Readiness now checks migration
0019's existing page_editor_records RLS. Recovery v1 requires matching registry,
PostgreSQL major and owner role name. Existing MCP/publication contracts remain.
Configuration names and failure/restart/rollback steps are in the runbook and
public templates; no values, decrypted environment or backup keys are submitted.

## Receiving-owner gates

[Pilot/client guide](PILOT_CLIENT_EVALUATION.md) names the goals and evidence to
retain. The owner selected Codex + ChatGPT. The owner confirms the pilot bundle, supplies/authorizes
external accounts and a second site, performs independent model/client and
seven-day usage acceptance, selects the external incident channel and verifies
off-host backup/key custody. Production cutover is not part of this submission.
The implementation agent does not edit the owner's acceptance decision.

## Measured technical rehearsal

On 2026-10-20 the disposable Neon PostgreSQL 18 rehearsal restored 45 tables and
four real image objects. Every table and object hash matched. Restore took
54.357 seconds; the interval from the consistent snapshot to the simulated
failure was 13.476 seconds. The entire recovery rehearsal took 71.894 seconds.
These measurements use synthetic content, exclude account provisioning, key
retrieval and ingress setup, and are not a production RPO/RTO guarantee.

Local verification passed 215 tests with 58 database-dependent tests skipped and
14 browser checks. A separate fresh Neon run passed the recovery integration and
five database isolation suites. CI additionally exercises the complete database
suite and both container targets; its final result is recorded with the release.
Schedules and incident units are supplied as installation templates. No recurring
host timer, external alert destination or off-host key/archive custody is claimed
as activated by this submission.
