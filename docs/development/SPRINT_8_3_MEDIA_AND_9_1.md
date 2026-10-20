# Sprint 8.3 media completion and Sprint 9.1 passport

## Automatic image delivery

The protected JPEG/PNG upload gateway and MCP finalization prepare responsive v2
variants automatically. Deduplicated uploads also prepare the same variants.
Original bytes and provenance remain in the private immutable archive. The public
media handler only resolves variants referenced by a reviewed preview or verified
release; an original hash is never a delivery URL.

Responsive v2 uses AVIF and WebP at 320, 640, 960, 1280, 1600 and 1920 pixels,
limited to the source size (one final bounded candidate covers intermediate source
widths without enlarging pixels). JPEG fallback is at most 1280 pixels. Modern
formats retain transparency; the JPEG compatibility fallback uses a white matte.
The renderer emits width-descriptor srcset groups, sizes and intrinsic dimensions.
Browsers select format and resolution. Legacy v1 selections retain their original
files and remain readable for immutable publication and rollback.

Encoding starts at AVIF quality 50, WebP 75 and JPEG 82, then reduces quality in
steps of six when needed, with respective floors 32, 51 and 58. Each output has a
width-based weight budget, from 24 KiB to at most 192 KiB. Failure to meet the
budget rejects processing; it never substitutes an original. A referenced image
with no variants or an incomplete v2 set blocks preview preparation. Verified
media reads are bounded to 8 MiB per selected revision. Upload limits remain
25 MiB and 40 million decoded pixels.

Re-encoding does not copy source EXIF/XMP metadata. Regression coverage includes
an embedded synthetic AI-generator XMP tag and orientation. The private original
retains its metadata. Visible marks and marks encoded into pixels are not removed;
this is not a promise of removing every vendor's AI provenance signal.

Compatibility: v2 is a new immutable processing policy. Existing presets keep v1
encoder settings. Optional width, height and sizes fields extend media bindings;
legacy bindings without them still render. No database schema change is needed.
Sites consumers must support grouping width descriptors by format; the separate
private catalogue consumer is updated with that behavior.

## Site passport for a new agent

Start with site_passport. It reports the current site's locales, effective
permissions, permitted capabilities, registered types, trusted ownership/rules,
canonical published route inventory, components, integrations and version digests.
Document IDs and localized variant IDs are distinct. Each route identifies its
revision, logical main section, reviewed component, field names and data source.
The contract digest includes schemas and design policy; the snapshot digest also
changes when the published release changes. Editorial prose never supplies rules
or tool authority.

Use content_schema for a discovered type, site_components for canonical component
IDs, slots, field bindings and examples, content_dependencies for current records
referencing a document, and site_dependencies for published pages using a shared
component. site-layout affects every published route. Dependency pages contain at
most 20 items; component cursors bind to the published snapshot and reject drift.
Follow cursors to the end, including pages with no matching entity references.

Reviewed registered types are discovered dynamically, without an MCP type enum.
Creation and metadata patches retain schema validation, relationship validation,
immutable revisions, source-hash conflict checks, authorization and audit. Invalid
relationships return an address such as /category and a safe correction hint.
Runtime schema changes remain outside field patches and require reviewed changes.
The passport is limited to 64 types, 100 routes and 128 KiB; oversized registries
fail explicitly rather than returning a silently incomplete context.

## Verification and acceptance boundary

Automated clean MCP sessions cover model discovery, read-only permissions, a newly
registered reviewed type, related-record creation and field patching, invalid
relationships, editorial prompt injection, multi-page dependencies, cross-site
isolation and stale component cursors. The media tests exercise a PNG larger than
3 MB, all modern screen sizes, metadata stripping, alpha, byte budgets, original
integrity and rejection of incomplete processing.

Record the exact CI, deployment, live media probe and native Sites version in the
workspace release report. A receiving owner still records independent acceptance;
the implementing agent does not invent the receiver's three unfamiliar tasks or
mark them accepted. The synthetic catalogue is the current pilot bundle, not a
claim of production Navi migration or general design import.
