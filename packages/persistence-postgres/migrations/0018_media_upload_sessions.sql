CREATE TABLE navocms.media_upload_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('human','agent','service')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, site_id, intent_id)
    REFERENCES navocms.media_upload_intents (tenant_id, site_id, id)
);
ALTER TABLE navocms.media_upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE navocms.media_upload_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY site_scope ON navocms.media_upload_sessions TO navocms_app
  USING (tenant_id = navocms.current_tenant_id() AND site_id = navocms.current_site_id())
  WITH CHECK (tenant_id = navocms.current_tenant_id() AND site_id = navocms.current_site_id());
REVOKE ALL ON navocms.media_upload_sessions FROM PUBLIC, navocms_plugin;
REVOKE UPDATE, DELETE ON navocms.media_upload_sessions FROM navocms_app;
GRANT SELECT, INSERT ON navocms.media_upload_sessions TO navocms_app;
ALTER TABLE navocms.media_references ADD COLUMN alt text CHECK (alt IS NULL OR length(alt) BETWEEN 1 AND 512);
