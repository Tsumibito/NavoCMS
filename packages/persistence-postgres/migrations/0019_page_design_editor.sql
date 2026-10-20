BEGIN;
SET search_path = navocms, pg_catalog;
ALTER TABLE content_revisions ADD COLUMN composition_json jsonb
  CHECK (composition_json IS NULL OR (jsonb_typeof(composition_json)='object' AND octet_length(composition_json::text)<=16384));
CREATE TABLE page_editor_records (
 id uuid NOT NULL,
 tenant_id uuid NOT NULL,
 site_id uuid NOT NULL,
 variant_id uuid NOT NULL,
 revision_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('change','comment','preview')),
 data_json jsonb NOT NULL CHECK (jsonb_typeof(data_json)='object' AND octet_length(data_json::text)<=65536),
 PRIMARY KEY (id,kind),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id,site_id,revision_id) REFERENCES content_revisions(tenant_id,site_id,id),
 FOREIGN KEY (tenant_id,site_id,variant_id) REFERENCES content_variants(tenant_id,site_id,id)
);
CREATE INDEX page_editor_records_scope ON page_editor_records(tenant_id,site_id,variant_id,kind,id);
ALTER TABLE page_editor_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_editor_records FORCE ROW LEVEL SECURITY;
CREATE POLICY site_scope ON page_editor_records TO navocms_app
 USING (tenant_id=current_tenant_id() AND site_id=current_site_id())
 WITH CHECK (tenant_id=current_tenant_id() AND site_id=current_site_id());
REVOKE ALL ON page_editor_records FROM PUBLIC,navocms_plugin;
GRANT SELECT,INSERT ON page_editor_records TO navocms_app;
COMMIT;
