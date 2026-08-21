# @navocms/design

The design engine validates versioned design-system and override contracts, resolves DTCG token
references, produces deterministic release digests and CSS variables, and exposes a renderer-neutral
catalogue model.

It does not render site-specific components. Renderer adapters consume the compiled contract and
must fail when a recipe requires a component they cannot provide.
