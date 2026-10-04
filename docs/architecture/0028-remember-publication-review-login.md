# ADR 0028 — Remember publication review login

**Status:** Accepted

**Date:** 2026-10-04

## Context

The owner requests remembered browser login rather than repeated authentication
when reviewing releases. ADR 0027 capped the persistent session at eight hours,
so even a valid provider refresh token could not preserve login overnight.

## Decision

New confirmation browser sessions with a provider refresh token have a fixed
360-day maximum lifetime in the same browser profile. Refresh does not extend
this absolute deadline. Existing cookies retain their original deadline. A
session without a refresh token remains bounded by the original token expiry.

Every expired access token still requires successful provider refresh and
verification. Membership, publication permission, site scope and durable local
revocation remain checked on every review and decision. Logout and account
switch revoke the session. Provider revocation can require earlier sign-in.

Initial and refreshed cookies retain only the same bounded identity claims;
unrelated provider metadata cannot inflate refreshed cookies past browser limits.
Cookies remain encrypted, HttpOnly and Secure on HTTPS. Browser profiles do not
share cookies. Rotating the confidential client secret still ends old sessions.

This supersedes only the eight-hour duration in ADR 0027. Each immutable release
still requires an independent human publication decision. Remembered login
never records a receipt or authorizes a different release automatically.

## Validation

Verify login survives 359 days, refresh cookies remain small, the 360-day
deadline does not slide and expiry returns to login. Retain tests for restart,
refresh denial, membership removal, logout/replay and pending exact-release
decisions. The live owner session remains part of operational acceptance.
