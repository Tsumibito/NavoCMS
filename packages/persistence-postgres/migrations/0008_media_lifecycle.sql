BEGIN;

SET search_path = navocms, pg_catalog;

-- The lifecycle repository also checks this boundary, but the schema prevents
-- a privileged application query from creating an immediately reclaimable row.
ALTER TABLE media_assets ADD CONSTRAINT media_assets_minimum_delete_grace
  CHECK (purge_after IS NULL OR purge_after >= deleted_at + interval '24 hours');

CREATE TABLE media_lifecycle_checkpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid,
  storage_key text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('schedule_delete', 'recoverable_delete', 'restore', 'reclaim', 'reconcile_orphan', 'reconcile_missing')),
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 16 AND 200),
  status text NOT NULL CHECK (status IN ('scheduled', 'effect_pending', 'completed', 'storage_missing')),
  grace_until timestamptz,
  checkpoint_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint_json) = 'object'),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, id),
  UNIQUE (tenant_id, site_id, operation, operation_key),
  FOREIGN KEY (tenant_id, site_id, asset_id) REFERENCES media_assets(tenant_id, site_id, id) ON DELETE RESTRICT,
  CHECK ((operation = 'reconcile_orphan') = (asset_id IS NULL)),
  CHECK ((operation IN ('schedule_delete', 'recoverable_delete', 'restore', 'reclaim')) = (asset_id IS NOT NULL)),
  CHECK ((operation IN ('schedule_delete', 'recoverable_delete', 'restore', 'reclaim', 'reconcile_orphan')) = (grace_until IS NOT NULL)),
  CHECK (operation <> 'reconcile_orphan' OR grace_until >= created_at + interval '24 hours'),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX media_lifecycle_checkpoint_pending_idx
  ON media_lifecycle_checkpoints (tenant_id, site_id, operation, status, created_at)
  WHERE completed_at IS NULL;

ALTER TABLE media_lifecycle_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_lifecycle_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY site_scope ON media_lifecycle_checkpoints TO navocms_app
  USING (tenant_id = current_tenant_id() AND site_id = current_site_id())
  WITH CHECK (tenant_id = current_tenant_id() AND site_id = current_site_id());
GRANT SELECT, INSERT, UPDATE ON media_lifecycle_checkpoints TO navocms_app;
GRANT DELETE ON media_gc_candidates TO navocms_app;

COMMIT;
