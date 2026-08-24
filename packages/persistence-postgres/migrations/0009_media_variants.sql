BEGIN;

SET search_path = navocms, pg_catalog;

ALTER TABLE media_variants ADD COLUMN preset_id text NOT NULL
  CHECK (preset_id ~ '^[a-z][a-z0-9-]{0,63}$');
ALTER TABLE media_variants ADD COLUMN byte_size bigint NOT NULL CHECK (byte_size > 0);

CREATE TABLE media_variant_checkpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  original_sha256 text NOT NULL CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
  variant_identity text NOT NULL CHECK (variant_identity ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL,
  output_sha256 text NOT NULL CHECK (output_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  media_type text NOT NULL CHECK (media_type IN ('image/avif', 'image/webp', 'image/jpeg')),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  preset_id text NOT NULL CHECK (preset_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  preset_version text NOT NULL CHECK (char_length(preset_version) BETWEEN 1 AND 64),
  transform_json jsonb NOT NULL CHECK (jsonb_typeof(transform_json) = 'object'),
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 16 AND 200),
  status text NOT NULL CHECK (status IN ('effect_pending', 'completed')),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, id),
  UNIQUE (tenant_id, site_id, variant_identity),
  UNIQUE (tenant_id, site_id, operation_key),
  FOREIGN KEY (tenant_id, site_id, asset_id, original_sha256)
    REFERENCES media_originals(tenant_id, site_id, asset_id, sha256) ON DELETE RESTRICT,
  CHECK (storage_key = concat('tenants/', tenant_id::text, '/sites/', site_id::text, '/variants/', variant_identity)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION media_variants_immutable()
RETURNS trigger LANGUAGE plpgsql AS $media_variants_immutable$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'verified media variants are immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'verified media variants cannot be deleted directly'; END IF;
  RETURN NEW;
END
$media_variants_immutable$;
CREATE TRIGGER media_variants_immutable_trigger
  BEFORE UPDATE OR DELETE ON media_variants FOR EACH ROW EXECUTE FUNCTION media_variants_immutable();

ALTER TABLE media_variant_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_variant_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY site_scope ON media_variant_checkpoints TO navocms_app
  USING (tenant_id = current_tenant_id() AND site_id = current_site_id())
  WITH CHECK (tenant_id = current_tenant_id() AND site_id = current_site_id());
GRANT SELECT, INSERT, UPDATE ON media_variant_checkpoints TO navocms_app;
REVOKE UPDATE, DELETE ON media_variants FROM navocms_app;

COMMIT;
