BEGIN;

SET search_path = navocms, pg_catalog;

CREATE TABLE IF NOT EXISTS content_types (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{1,63}$'),
  version text NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  directive_definitions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(directive_definitions) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, name),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS content_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  content_type_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{1,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, slug),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id, content_type_id)
    REFERENCES content_types(tenant_id, site_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS content_variants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  document_id uuid NOT NULL,
  locale text NOT NULL,
  variant_key text NOT NULL DEFAULT 'default',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, document_id, locale, variant_key),
  UNIQUE (tenant_id, site_id, document_id, id),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id, document_id)
    REFERENCES content_documents(tenant_id, site_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS content_revisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  document_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  parent_revision_id uuid,
  source_markdown text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  ast_json jsonb NOT NULL CHECK (jsonb_typeof(ast_json) = 'object'),
  metadata_json jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata_json) = 'object'),
  provenance_json jsonb NOT NULL CHECK (jsonb_typeof(provenance_json) = 'object'),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, variant_id, revision_number),
  UNIQUE (tenant_id, site_id, variant_id, id),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id, document_id, variant_id)
    REFERENCES content_variants(tenant_id, site_id, document_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id, variant_id, parent_revision_id)
    REFERENCES content_revisions(tenant_id, site_id, variant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES identities(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS content_relations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  from_document_id uuid NOT NULL,
  to_document_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9-]{1,63}$'),
  metadata_json jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, from_document_id, to_document_id, kind),
  FOREIGN KEY (tenant_id, site_id, from_document_id)
    REFERENCES content_documents(tenant_id, site_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id, to_document_id)
    REFERENCES content_documents(tenant_id, site_id, id) ON DELETE CASCADE
);

DO $content_rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'content_types', 'content_documents', 'content_variants', 'content_revisions', 'content_relations'
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
$content_rls$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  content_types, content_documents, content_variants, content_relations TO navocms_app;
GRANT SELECT, INSERT ON content_revisions TO navocms_app;
REVOKE UPDATE, DELETE ON content_revisions FROM navocms_app;
GRANT SELECT ON
  content_types, content_documents, content_variants, content_revisions, content_relations
  TO navocms_plugin;

COMMIT;
