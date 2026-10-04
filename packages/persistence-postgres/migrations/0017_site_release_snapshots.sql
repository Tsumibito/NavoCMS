-- Immutable baseline binding. Published render_json remains the route source of truth.
CREATE TABLE navocms.site_release_snapshots (
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  release_id uuid NOT NULL,
  base_publication_id uuid,
  governance_digest text NOT NULL CHECK (governance_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, release_id),
  FOREIGN KEY (tenant_id, site_id, release_id)
    REFERENCES navocms.release_candidates (tenant_id, site_id, id)
);
ALTER TABLE navocms.site_release_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE navocms.site_release_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY site_scope ON navocms.site_release_snapshots TO navocms_app
  USING (tenant_id = navocms.current_tenant_id() AND site_id = navocms.current_site_id())
  WITH CHECK (tenant_id = navocms.current_tenant_id() AND site_id = navocms.current_site_id());
REVOKE ALL ON navocms.site_release_snapshots FROM PUBLIC, navocms_plugin;
REVOKE UPDATE, DELETE ON navocms.site_release_snapshots FROM navocms_app;
GRANT SELECT, INSERT ON navocms.site_release_snapshots TO navocms_app;
