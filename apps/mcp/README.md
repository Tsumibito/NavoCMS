# NavoCMS MCP application

This application is the agent-facing editorial boundary for NavoCMS. It exposes authenticated,
site-scoped tools for discovery, Markdown drafts, stable patches, diffs, and preview preparation,
plus an optional MCP Apps review surface.

It is currently an executable Sprint 5 reference adapter backed by the in-memory content engine. It
does not deploy a site, issue a preview URL, publish content, or provide production persistence.

## Development

Build and test from the repository root:

```bash
pnpm build
pnpm test -- apps/mcp/src/mcp.test.ts
```

The standalone development server refuses to start without OAuth and explicit site configuration:

```bash
NAVOCMS_MCP_RESOURCE=https://cms.example.test/mcp \
NAVOCMS_OIDC_ISSUER=https://identity.example.test \
NAVOCMS_OIDC_JWKS_URL=https://identity.example.test/.well-known/jwks.json \
NAVOCMS_DEVELOPMENT_TENANT_ID=11111111-1111-4111-8111-111111111111 \
NAVOCMS_DEVELOPMENT_SITE_ID=22222222-2222-4222-8222-222222222222 \
pnpm --filter @navocms/mcp dev
```

Use local untracked dotenv files for these values. The public repository never stores tokens,
private keys, decrypted dotenv files, customer content, or production exports.

See the [MCP editing specification](../../docs/specs/mcp-editing-v0alpha1.md) and
[ADR 0010](../../docs/architecture/0010-decoupled-mcp-editing-surface.md).
