BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'navocms_migrator') THEN
    CREATE ROLE navocms_migrator NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'navocms_app') THEN
    CREATE ROLE navocms_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'navocms_plugin') THEN
    CREATE ROLE navocms_plugin NOLOGIN NOBYPASSRLS;
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS navocms AUTHORIZATION navocms_migrator;
ALTER SCHEMA navocms OWNER TO navocms_migrator;
SET ROLE navocms_migrator;
SET search_path = navocms, pg_catalog;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sites (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS environments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('development', 'preview', 'production')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, kind),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS identities (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('human', 'agent', 'service')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TABLE IF NOT EXISTS tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id)
);

CREATE TABLE IF NOT EXISTS site_memberships (
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'publisher', 'editor', 'viewer')),
  permissions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, principal_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS service_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  name text NOT NULL,
  credential_fingerprint text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, name),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS secret_references (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  provider text NOT NULL,
  external_reference text NOT NULL,
  label text NOT NULL,
  allowed_plugin_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, provider, external_reference),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  plugin_id text,
  metric text NOT NULL,
  amount numeric(20, 6) NOT NULL CHECK (amount > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quota_limits (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  plugin_id text,
  metric text NOT NULL,
  limit_amount numeric(20, 6) NOT NULL CHECK (limit_amount >= 0),
  period text NOT NULL CHECK (period IN ('hour', 'day', 'month', 'lifetime')),
  UNIQUE (site_id, plugin_id, metric, period),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kill_switches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid,
  plugin_id text,
  reason text NOT NULL,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CHECK (site_id IS NOT NULL OR plugin_id IS NULL),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
RETURN nullif(current_setting('navocms.tenant_id', true), '')::uuid;

CREATE OR REPLACE FUNCTION current_site_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
RETURN nullif(current_setting('navocms.site_id', true), '')::uuid;

CREATE OR REPLACE FUNCTION current_principal_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
RETURN nullif(current_setting('navocms.principal_id', true), '')::uuid;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON tenants;
CREATE POLICY tenant_scope ON tenants TO navocms_app, navocms_plugin
  USING (id = current_tenant_id()) WITH CHECK (id = current_tenant_id());

ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_scope ON sites;
CREATE POLICY site_scope ON sites TO navocms_app, navocms_plugin
  USING (tenant_id = current_tenant_id() AND id = current_site_id())
  WITH CHECK (tenant_id = current_tenant_id() AND id = current_site_id());

ALTER TABLE identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS principal_scope ON identities;
CREATE POLICY principal_scope ON identities TO navocms_app, navocms_plugin
  USING (id = current_principal_id()) WITH CHECK (id = current_principal_id());

ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_membership_scope ON tenant_memberships;
CREATE POLICY tenant_membership_scope ON tenant_memberships TO navocms_app, navocms_plugin
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

DO $site_tables$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'environments', 'site_memberships', 'service_accounts', 'secret_references',
    'usage_events', 'quota_limits'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS site_scope ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY site_scope ON %I TO navocms_app, navocms_plugin '
      'USING (tenant_id = current_tenant_id() AND site_id = current_site_id()) '
      'WITH CHECK (tenant_id = current_tenant_id() AND site_id = current_site_id())',
      table_name
    );
  END LOOP;
END
$site_tables$;

ALTER TABLE kill_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE kill_switches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kill_switch_scope ON kill_switches;
CREATE POLICY kill_switch_scope ON kill_switches TO navocms_app, navocms_plugin
  USING (
    tenant_id = current_tenant_id()
    AND (site_id IS NULL OR site_id = current_site_id())
  )
  WITH CHECK (
    tenant_id = current_tenant_id()
    AND (site_id IS NULL OR site_id = current_site_id())
  );

GRANT USAGE ON SCHEMA navocms TO navocms_app, navocms_plugin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA navocms TO navocms_app;
GRANT SELECT, INSERT, UPDATE ON usage_events TO navocms_plugin;
GRANT SELECT ON sites, environments, secret_references, quota_limits, kill_switches TO navocms_plugin;
ALTER DEFAULT PRIVILEGES FOR ROLE navocms_migrator IN SCHEMA navocms
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO navocms_app;

RESET ROLE;
COMMIT;
