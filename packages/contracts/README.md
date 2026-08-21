# @navocms/contracts

Public `navocms.io/v0alpha1` TypeScript types and AJV validators for plugin manifests, site profiles,
content types, and domain events.

The build copies the canonical repository schemas into `dist/schemas`, so the package does not rely
on repository-relative files after packaging. This package must not import the kernel or a transport.
