# ADR 0029 — Restart-safe browser login

**Status:** Accepted

**Date:** 2026-10-04

## Context

An authorization attempt kept its PKCE verifier, nonce and return URL in one
process's memory. Deploying the CMS while the owner was at the identity provider
made the callback unknown, even if the authorization attempt was still valid.
The ten-minute attempt window is separate from the remembered session duration.

## Decision

Keep the pending authorization context in an authenticated encrypted browser
cookie, using a distinct encryption key purpose from remembered sessions. The
cookie is HttpOnly, SameSite=Lax, Secure on HTTPS and limited to confirmations.
A replacement process with the same client secret can complete the attempt.

Validate the state against the sealed context, preserve the ten-minute deadline,
require PKCE and verify the ID token's nonce and identity. The provider's
single-use authorization code prevents replay across processes. A bounded
process-local cache additionally rejects consumed states before token exchange.
Clear the pending cookie on callback, including a successful login. Only a
fixed local confirmation path can be the return destination.

An expired response never creates a session or a publication receipt. Where the
sealed context is available, the error offers a return link to the saved review.
Existing pre-upgrade authorization attempts must start again once; existing
remembered session cookies retain their original format and expiry.

## Validation

Complete a login on a replacement server using the original server's pending
cookie. Reject cookie tampering, expired attempts, and cross-process code replay.
Retain identity-pair, logout, permission, and independent decision checks.
