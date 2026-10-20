# ADR 0031 — Reviewed Cloudflare redirects

**Status:** Accepted

**Date:** 2026-10-20

## Context

The trusted Astro builder includes the public `_redirects` file in its immutable
output. Delivery rejected that legitimate root filename. Pages consumes redirect
configuration rather than serving it as a normal static file.

## Decision

Allow exactly `_redirects` alongside the existing bounded safe output paths.
Send its original bytes as the Pages multipart configuration file. Upload a
byte-identical content-addressed proof asset under `navocms-delivery/` for live
verification, retaining the original reviewed file in the immutable manifest.
Reject collisions with the proof path.

Verify both the proof asset's exact hash and size and every rule's live 301 and
same-origin destination. Support only the renderer's bounded local permanent
redirect syntax, up to 100 rules. Do not follow redirects during probing. Keep
all requests within the existing total verification deadline. Traversal, dotfiles
and executable root configuration remain rejected. No approved output, release
hash, decision receipt or source snapshot is rewritten to make delivery pass.

Cloudflare documents this behavior in its
[Pages redirects documentation](https://developers.cloudflare.com/pages/configuration/redirects/).

## Validation

Cover immutable manifest validation, multipart transfer, proof asset mapping,
correct redirect behavior, swapped proof bytes, incorrect live destinations,
and unsafe output paths. Confirm the real preserved legacy route after release.
