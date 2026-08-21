# Site profile v0alpha1

A site profile is the reviewable composition root for one site environment. It pins all four site
anchors and the allowed providers. Profile changes are configuration releases, not ordinary content
edits.

## Four anchors

- `content`: content pack/schema bundle reference, version, and digest;
- `design`: token/component/recipe bundle reference, version, and digest;
- `delivery`: renderer/deployment/routing contract reference, version, and digest;
- `governance`: roles/consequences/approval/retention contract reference, version, and digest.

## Provider composition

`plugins` pins installed plugin IDs and versions. `bindings` maps a requested capability/version to
one provider plugin. Provider fallback or priority must be explicit and deterministic; a workflow
does not silently switch providers after starting.

## Site behavior

The profile declares default and supported locales, URL policy, and environment. Secret values are
never embedded; configuration uses secret references resolved by the kernel's credential broker.

## Release behavior

A release copies profile version and digest plus resolved plugin versions and bindings. Changing
any of them invalidates existing preview approval.
