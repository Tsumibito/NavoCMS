# ADR 0030 — Day-long owner review

**Status:** Accepted

**Date:** 2026-10-04

## Context

The owner starts a task and returns several hours later. A ten-minute login
attempt, one-hour preview link, or fifteen-minute decision receipt interrupted
that workflow even though the browser's remembered session was still valid.

## Decision

The pending browser login, account-switch context and review form cookies last
24 hours. Newly issued previews, review links and exact-release decision receipts
also default to 24 hours. Production runtime clamps legacy shorter preview and
approval environment settings to one day. Preview settings may extend to seven
days; approval remains one day. Existing immutable candidates and receipts keep
their recorded expiry until the normal link renewal extends the saved review. An authenticated owner opening
an expired review automatically issues a fresh capability for the same saved build,
without recording a decision, rebuilding or changing the release hash. This
keeps old bookmarks useful. Revocation, policy mismatch and missing artifacts
still reject renewal.

A provider can reject a code earlier. For its terminal invalid_grant response,
clear the pending cookie and return to the fixed saved review path. That path
uses any remembered CMS session, otherwise starts a fresh provider flow. Never
accept an expired code or create a session merely because a review link exists.
Other token failures retain their explicit error instead of automatic retries.

PKCE, state, nonce, provider code single use, live permission checks and browser
publication decisions remain enforced. The fixed 360-day CMS session maximum
from ADR 0028 is unchanged. Browser profiles keep their own cookies; custom DNS
does not merge them or itself extend a provider's session lifetime.

## Validation

Complete login after 23 hours on a replacement server. Review a saved release
six hours later without expired-link or login interruption. Reject an attempt
past 24 hours. A consumed provider code returns to review without issuing a
session. Verify old deployment TTL settings cannot restore the shorter limits.
Retain exact-release approval, revocation, identity and replay tests.
