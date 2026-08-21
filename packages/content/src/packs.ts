import type { ContentPack } from "./model.js";

const sharedDirectives = [
  { name: "callout", kind: "containerDirective", allowedAttributes: ["tone", "title"] },
  { name: "cta", kind: "leafDirective", allowedAttributes: ["label", "href"], requiredAttributes: ["label", "href"] },
  { name: "asset", kind: "leafDirective", allowedAttributes: ["id", "alt"], requiredAttributes: ["id", "alt"] }
] as const;

const permissions = {
  read: ["viewer", "editor", "publisher", "site-admin"],
  draft: ["editor", "publisher", "site-admin"],
  publish: ["publisher", "site-admin"]
} as const;

export const editorialPack: ContentPack = Object.freeze<ContentPack>({
  id: "editorial",
  version: "0.1.0",
  types: [
    {
      apiVersion: "navocms.io/v0alpha1",
      kind: "ContentType",
      metadata: {
        name: "article",
        version: "0.1.0",
        title: "Article",
        description: "Long-form editorial content with portable Markdown prose."
      },
      spec: {
        fields: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          required: ["title", "slug", "body"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 180 },
            slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
            body: { type: "string", contentMediaType: "text/markdown" },
            description: { type: "string", maxLength: 500 },
            author: { type: "string" },
            publishedAt: { type: ["string", "null"], format: "date-time" }
          }
        },
        relations: [
          { name: "author", target: "person", cardinality: "one", onDelete: "restrict" },
          { name: "related", target: "article", cardinality: "many", onDelete: "nullify" }
        ],
        localization: { mode: "document", requiredLocales: [] },
        indexes: [{ name: "article_slug_unique", fields: ["slug", "locale"], unique: true }],
        rendererCapabilities: ["content.markdown", "component.callout", "component.cta", "component.asset"],
        defaultWorkflow: "navocms.editorial.standard.v1",
        permissions,
        retentionClass: "published-history"
      }
    }
  ],
  directives: { article: sharedDirectives }
});

export const marketingPack: ContentPack = Object.freeze<ContentPack>({
  id: "marketing",
  version: "0.1.0",
  types: [
    {
      apiVersion: "navocms.io/v0alpha1",
      kind: "ContentType",
      metadata: {
        name: "landing-page",
        version: "0.1.0",
        title: "Landing page",
        description: "A conversion-oriented page constrained by the active design system."
      },
      spec: {
        fields: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          required: ["title", "slug", "body", "canonicalPath"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 180 },
            slug: { type: "string" },
            body: { type: "string", contentMediaType: "text/markdown" },
            intent: { type: "string" },
            canonicalPath: { type: "string", pattern: "^/" }
          }
        },
        relations: [],
        localization: { mode: "document", requiredLocales: [] },
        indexes: [{ name: "landing_slug_unique", fields: ["slug", "locale"], unique: true }],
        rendererCapabilities: ["content.markdown", "component.callout", "component.cta", "component.asset"],
        defaultWorkflow: "navocms.marketing.standard.v1",
        permissions,
        retentionClass: "published-history"
      }
    }
  ],
  directives: { "landing-page": sharedDirectives }
});

export const businessPack: ContentPack = Object.freeze<ContentPack>({
  id: "business",
  version: "0.1.0",
  types: [
    {
      apiVersion: "navocms.io/v0alpha1",
      kind: "ContentType",
      metadata: {
        name: "organization",
        version: "0.1.0",
        title: "Organization",
        description: "Public organization identity and descriptive content."
      },
      spec: {
        fields: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          required: ["name", "slug", "body"],
          properties: {
            name: { type: "string", minLength: 1 },
            slug: { type: "string" },
            body: { type: "string", contentMediaType: "text/markdown" },
            legalName: { type: "string" },
            contact: { type: "object" }
          }
        },
        relations: [],
        localization: { mode: "document", requiredLocales: [] },
        indexes: [{ name: "organization_slug_unique", fields: ["slug", "locale"], unique: true }],
        rendererCapabilities: ["content.markdown", "component.callout", "component.asset"],
        defaultWorkflow: "navocms.business.standard.v1",
        permissions,
        retentionClass: "permanent"
      }
    },
    {
      apiVersion: "navocms.io/v0alpha1",
      kind: "ContentType",
      metadata: {
        name: "legal-page",
        version: "0.1.0",
        title: "Legal page",
        description: "Versioned legal text with an explicit effective date."
      },
      spec: {
        fields: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          required: ["title", "slug", "body", "effectiveAt"],
          properties: {
            title: { type: "string", minLength: 1 },
            slug: { type: "string" },
            body: { type: "string", contentMediaType: "text/markdown" },
            effectiveAt: { type: "string", format: "date-time" }
          }
        },
        relations: [],
        localization: { mode: "document", requiredLocales: [] },
        indexes: [{ name: "legal_slug_unique", fields: ["slug", "locale"], unique: true }],
        rendererCapabilities: ["content.markdown", "component.callout"],
        defaultWorkflow: "navocms.legal.review.v1",
        permissions,
        retentionClass: "permanent"
      }
    }
  ],
  directives: {
    organization: sharedDirectives,
    "legal-page": [{ name: "callout", kind: "containerDirective", allowedAttributes: ["tone", "title"] }]
  }
});

export const foundationPacks: readonly ContentPack[] = Object.freeze([
  editorialPack,
  marketingPack,
  businessPack
]);
