# Security policy

## Supported versions

NavoCMS is not yet production-ready and has no supported release. Security findings in the current
foundation should still be reported privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include affected revision, reproduction steps, impact, and any suggested mitigation.

Do not disclose the issue publicly until a maintainer has acknowledged the report and coordinated a
fix. If private reporting is temporarily unavailable, open a public issue containing no exploit or
sensitive detail and ask a maintainer to establish a private channel.

## Response targets

These are targets, not contractual service levels:

- acknowledgement within 5 business days;
- initial severity assessment within 10 business days;
- coordinated disclosure after a fix or mitigation is available.

## Security scope

High-priority areas include tenant/site isolation, OAuth and MCP authorization, stale approvals,
plugin supply chain, secret handling, event/log leakage, media ingestion, SSRF, preview access,
webhook authenticity, and publication rollback.
