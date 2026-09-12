# Confirmation UX correction

## User requirement

The owner rejected the current repeated login/build-confirmation experience during the live
Sprint 8.2 acceptance on 2026-09-12. The ordinary workflow belongs in the agent conversation.
WorkOS Dashboard and Coolify must never be steps an editor has to visit.

## Required next outcome

1. Draft changes, builds and previews require no human confirmation. Clearly distinguish
   preparing a build from publishing it; the current label `Confirm this build` is misleading.
2. Offer one clear publication review page from the conversation. Show the site, visible
   changes and preview first, with an action labelled `Publish`. Hashes and provider details
   belong in optional technical details. The decision still binds the exact reviewed artifact.
3. Keep the human signed in across ordinary revisits and runtime restarts, within a documented
   session policy. Do not silently extend expired or revoked authority. Reuse the existing
   identity system rather than inventing another account or login database.
4. Provide a visible current account and working `Use another account` action. A rejected
   identity must not loop through automatic login back to the identical error. Switching an
   account must not require an administrator to revoke a session in WorkOS Dashboard.
5. Provide recovery from expired preview/login links without starting the task over. Reissue
   links for the same immutable artifact when appropriate; never turn expiry into authorization.
6. After the human decision, let the agent complete publication and show the result. One human
   publication action must not become several user-facing approval steps. Do not ask the human
   to repeat a decision to recover an already applied effect.
7. Refresh nested publication projections after reconcile and rollback. Responses must agree
   with the durable state and the verified live outcome.

## Acceptance

- A returning owner edits, builds and previews three successive drafts without login or approval
  prompts. Publishing has one clear review action; unchanged builds reuse stored artifacts.
- Restart the CMS between preview and review. The owner can continue under a still-valid session;
  expired/revoked sessions and removed publication membership are rejected.
- Sign in with an account without site membership, then switch to the existing authorized
  account entirely through the product UI. No administrative dashboard and no granted extra
  permissions are needed.
- Expire a login state and a preview link separately. Each page offers a working next step with
  clear wording; an old callback is never replayed as a new login.
- A successful human decision is consumed only for its exact site, artifact and current policy.
  Agent bearer tokens cannot issue a human receipt. Source changes invalidate old decisions.
- Delayed provider propagation can be reconciled without duplicate publication; reconcile and
  rollback return current nested statuses. Verify restored live bytes against the baseline.

## Scope boundary

This is an implementation handoff, not a deployed relaxation of publication policy. Automatic
publication for explicitly designated staging sites may be considered separately; it must not
silently alter production approval policy. The immediate change is removing unnecessary user
steps while retaining the existing exact-artifact publication boundary.
