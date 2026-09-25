CREATE TABLE navocms.browser_session_revocations (
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  session_hash text NOT NULL CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, site_id, session_hash),
  FOREIGN KEY (tenant_id, site_id) REFERENCES navocms.sites (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE navocms.browser_session_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE navocms.browser_session_revocations FORCE ROW LEVEL SECURITY;
CREATE POLICY site_scope ON navocms.browser_session_revocations TO navocms_app
  USING (tenant_id = navocms.current_tenant_id() AND site_id = navocms.current_site_id())
  WITH CHECK (tenant_id = navocms.current_tenant_id() AND site_id = navocms.current_site_id());

REVOKE ALL ON navocms.browser_session_revocations FROM PUBLIC, navocms_plugin;
GRANT SELECT, INSERT, DELETE ON navocms.browser_session_revocations TO navocms_app;
