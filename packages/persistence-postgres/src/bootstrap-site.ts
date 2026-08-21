import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { requireDatabaseUrl } from "./database.js";

const { Client } = pg;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slug = /^[a-z0-9][a-z0-9-]{1,62}$/;

export interface SiteBootstrapInput {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly tenantName: string;
  readonly siteId: string;
  readonly siteSlug: string;
  readonly siteName: string;
  readonly primaryLocale: string;
  readonly locales: readonly string[];
  readonly environmentId: string;
  readonly environmentKind: "development" | "preview" | "staging" | "production";
  readonly environmentKey: string;
  readonly principal?: {
    readonly id: string;
    readonly issuer: string;
    readonly subject: string;
    readonly kind: "human" | "agent" | "service";
    readonly siteRole: "owner" | "admin" | "publisher" | "editor" | "viewer";
  };
}

export async function bootstrapSite(connectionString: string, input: SiteBootstrapInput): Promise<void> {
  validate(input);
  const client = new Client({
    connectionString: requireDatabaseUrl(connectionString, "NAVOCMS_MIGRATION_DATABASE_URL"),
    application_name: "navocms-site-bootstrap"
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO navocms.tenants (id, slug, name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name`,
      [input.tenantId, input.tenantSlug, input.tenantName]
    );
    await client.query(
      `INSERT INTO navocms.sites (id, tenant_id, slug, name, primary_locale, locales)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name,
         primary_locale = EXCLUDED.primary_locale, locales = EXCLUDED.locales`,
      [input.siteId, input.tenantId, input.siteSlug, input.siteName, input.primaryLocale, [...input.locales]]
    );
    await client.query(
      `INSERT INTO navocms.environments (id, tenant_id, site_id, kind, environment_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (site_id, kind, environment_key) DO UPDATE SET id = EXCLUDED.id`,
      [input.environmentId, input.tenantId, input.siteId, input.environmentKind, input.environmentKey]
    );
    if (input.principal) {
      await client.query(
        `INSERT INTO navocms.identities (id, issuer, subject, kind) VALUES ($1, $2, $3, $4)
         ON CONFLICT (issuer, subject) DO UPDATE SET kind = EXCLUDED.kind`,
        [input.principal.id, input.principal.issuer, input.principal.subject, input.principal.kind]
      );
      await client.query(
        `INSERT INTO navocms.tenant_memberships (tenant_id, principal_id, role) VALUES ($1, $2, 'owner')
         ON CONFLICT (tenant_id, principal_id) DO UPDATE SET role = EXCLUDED.role`,
        [input.tenantId, input.principal.id]
      );
      await client.query(
        `INSERT INTO navocms.site_memberships (tenant_id, site_id, principal_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (site_id, principal_id) DO UPDATE SET role = EXCLUDED.role`,
        [input.tenantId, input.siteId, input.principal.id, input.principal.siteRole]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

function validate(input: SiteBootstrapInput): void {
  for (const [name, value] of [["tenantId", input.tenantId], ["siteId", input.siteId], ["environmentId", input.environmentId]] as const) {
    if (!uuid.test(value)) throw new Error(`${name} must be a UUID`);
  }
  if (input.principal && !uuid.test(input.principal.id)) throw new Error("principal.id must be a UUID");
  if (!slug.test(input.tenantSlug) || !slug.test(input.siteSlug)) throw new Error("Tenant and site slugs are invalid");
  if (input.locales.length === 0 || !input.locales.includes(input.primaryLocale)) {
    throw new Error("Locales must include the primary locale");
  }
  if (!['development', 'preview', 'staging', 'production'].includes(input.environmentKind)) {
    throw new Error("environmentKind is invalid");
  }
  if (!slug.test(input.environmentKey)) throw new Error("environmentKey is invalid");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const principalId = process.env.NAVOCMS_BOOTSTRAP_PRINCIPAL_ID;
  await bootstrapSite(process.env.NAVOCMS_MIGRATION_DATABASE_URL ?? "", {
    tenantId: required("NAVOCMS_BOOTSTRAP_TENANT_ID"),
    tenantSlug: required("NAVOCMS_BOOTSTRAP_TENANT_SLUG"),
    tenantName: required("NAVOCMS_BOOTSTRAP_TENANT_NAME"),
    siteId: required("NAVOCMS_BOOTSTRAP_SITE_ID"),
    siteSlug: required("NAVOCMS_BOOTSTRAP_SITE_SLUG"),
    siteName: required("NAVOCMS_BOOTSTRAP_SITE_NAME"),
    primaryLocale: required("NAVOCMS_BOOTSTRAP_PRIMARY_LOCALE"),
    locales: required("NAVOCMS_BOOTSTRAP_LOCALES").split(",").map((value) => value.trim()),
    environmentId: required("NAVOCMS_BOOTSTRAP_ENVIRONMENT_ID"),
    environmentKind: required("NAVOCMS_BOOTSTRAP_ENVIRONMENT_KIND") as SiteBootstrapInput["environmentKind"],
    environmentKey: process.env.NAVOCMS_BOOTSTRAP_ENVIRONMENT_KEY ?? "default",
    ...(principalId ? { principal: {
      id: principalId,
      issuer: required("NAVOCMS_BOOTSTRAP_PRINCIPAL_ISSUER"),
      subject: required("NAVOCMS_BOOTSTRAP_PRINCIPAL_SUBJECT"),
      kind: (process.env.NAVOCMS_BOOTSTRAP_PRINCIPAL_KIND ?? "human") as "human",
      siteRole: (process.env.NAVOCMS_BOOTSTRAP_SITE_ROLE ?? "owner") as "owner"
    } } : {})
  });
  process.stdout.write("NavoCMS site bootstrap is ready.\n");
}
