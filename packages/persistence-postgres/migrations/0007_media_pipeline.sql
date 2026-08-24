BEGIN;

SET search_path = navocms, pg_catalog;

CREATE TABLE media_assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'quarantined', 'verified', 'processing', 'ready', 'rejected', 'deleted')),
  provenance_json jsonb NOT NULL CHECK (jsonb_typeof(provenance_json) = 'object'),
  rights_json jsonb NOT NULL CHECK (jsonb_typeof(rights_json) = 'object'),
  rejection_reason text,
  deleted_at timestamptz,
  purge_after timestamptz,
  created_by uuid REFERENCES identities(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  CHECK ((state = 'rejected') = (rejection_reason IS NOT NULL)),
  CHECK ((deleted_at IS NULL) = (purge_after IS NULL)),
  CHECK ((state = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE TABLE media_originals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png')),
  width integer,
  height integer,
  frames integer,
  storage_key text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, id),
  UNIQUE (tenant_id, site_id, sha256),
  UNIQUE (tenant_id, site_id, asset_id, sha256),
  FOREIGN KEY (tenant_id, site_id, asset_id) REFERENCES media_assets(tenant_id, site_id, id) ON DELETE RESTRICT,
  CHECK (storage_key = concat('tenants/', tenant_id::text, '/sites/', site_id::text, '/originals/', sha256)),
  CHECK ((width IS NULL) = (height IS NULL)),
  CHECK (width IS NULL OR (width > 0 AND height > 0)),
  CHECK (frames IS NULL OR frames > 0)
);

CREATE TABLE media_variants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  original_sha256 text NOT NULL CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
  variant_identity text NOT NULL CHECK (variant_identity ~ '^[0-9a-f]{64}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('image/avif', 'image/webp', 'image/jpeg')),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  preset_version text NOT NULL,
  transform_json jsonb NOT NULL CHECK (jsonb_typeof(transform_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, id),
  UNIQUE (tenant_id, site_id, variant_identity),
  FOREIGN KEY (tenant_id, site_id, asset_id, original_sha256)
    REFERENCES media_originals(tenant_id, site_id, asset_id, sha256) ON DELETE RESTRICT,
  CHECK (storage_key = concat('tenants/', tenant_id::text, '/sites/', site_id::text, '/variants/', variant_identity))
);

CREATE TABLE media_references (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  owner_type text NOT NULL CHECK (owner_type ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  owner_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, site_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, site_id, asset_id, owner_type, owner_id, purpose, deleted_at),
  FOREIGN KEY (tenant_id, site_id, asset_id) REFERENCES media_assets(tenant_id, site_id, id) ON DELETE RESTRICT
);

CREATE TABLE media_upload_intents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  operation_key text NOT NULL,
  expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
  expected_size bigint NOT NULL CHECK (expected_size > 0),
  expected_media_type text,
  storage_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, id),
  UNIQUE (tenant_id, site_id, operation_key),
  FOREIGN KEY (tenant_id, site_id, asset_id) REFERENCES media_assets(tenant_id, site_id, id) ON DELETE CASCADE,
  CHECK (storage_key = concat('tenants/', tenant_id::text, '/sites/', site_id::text, '/pending/', id::text)),
  CHECK (expires_at > created_at)
);

CREATE TABLE media_gc_candidates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  recoverable_until timestamptz NOT NULL,
  reclaimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, asset_id),
  FOREIGN KEY (tenant_id, site_id, asset_id) REFERENCES media_assets(tenant_id, site_id, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION media_originals_immutable()
RETURNS trigger LANGUAGE plpgsql AS $media_originals_immutable$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'verified media originals are immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'verified media originals cannot be deleted directly'; END IF;
  RETURN NEW;
END
$media_originals_immutable$;
CREATE TRIGGER media_originals_immutable_trigger
  BEFORE UPDATE OR DELETE ON media_originals FOR EACH ROW EXECUTE FUNCTION media_originals_immutable();

CREATE INDEX media_assets_state_idx ON media_assets (tenant_id, site_id, state, updated_at);
CREATE INDEX media_references_live_idx ON media_references (tenant_id, site_id, asset_id) WHERE deleted_at IS NULL;
CREATE INDEX media_gc_due_idx ON media_gc_candidates (recoverable_until) WHERE reclaimed_at IS NULL;

DO $media_rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['media_assets', 'media_originals', 'media_variants', 'media_references', 'media_upload_intents', 'media_gc_candidates']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY site_scope ON %I TO navocms_app USING (tenant_id = current_tenant_id() AND site_id = current_site_id()) WITH CHECK (tenant_id = current_tenant_id() AND site_id = current_site_id())', table_name);
  END LOOP;
END
$media_rls$;

GRANT SELECT, INSERT, UPDATE ON media_assets, media_variants, media_references, media_upload_intents, media_gc_candidates TO navocms_app;
GRANT SELECT, INSERT ON media_originals TO navocms_app;

COMMIT;
