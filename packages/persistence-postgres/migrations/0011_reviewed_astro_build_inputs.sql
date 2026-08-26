BEGIN;

SET search_path = navocms, pg_catalog;

-- The input snapshot is distinct from the built artifact.  It records the
-- reviewed render evidence that a trusted, local builder may consume for one
-- exact staging release.  It is append-only: correcting an input requires a
-- new release, never editing evidence under an existing approval.
CREATE TABLE reviewed_astro_build_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  environment_key text NOT NULL CHECK (environment_key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  release_id uuid NOT NULL,
  release_hash text NOT NULL CHECK (release_hash ~ '^[0-9a-f]{64}$'),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
  binding_digest text NOT NULL CHECK (binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  render_json jsonb NOT NULL
    CHECK (jsonb_typeof(render_json) = 'object')
    CHECK (octet_length(convert_to(render_json::text, 'utf8')) BETWEEN 2 AND 2097152),
  created_by uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, release_id),
  FOREIGN KEY (tenant_id, site_id, environment_id, environment_key)
    REFERENCES environments (tenant_id, site_id, id, environment_key) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, site_id, release_id, environment_id, release_hash, artifact_hash)
    REFERENCES release_candidates (tenant_id, site_id, id, environment_id, release_hash, artifact_hash)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION reviewed_astro_build_inputs_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $reviewed_astro_build_inputs_immutable$
BEGIN
  RAISE EXCEPTION 'reviewed Astro build inputs are append-only';
END
$reviewed_astro_build_inputs_immutable$;

CREATE TRIGGER reviewed_astro_build_inputs_immutable_trigger
  BEFORE UPDATE OR DELETE ON reviewed_astro_build_inputs
  FOR EACH ROW EXECUTE FUNCTION reviewed_astro_build_inputs_immutable();

ALTER TABLE reviewed_astro_build_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviewed_astro_build_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY site_scope ON reviewed_astro_build_inputs TO navocms_app
  USING (tenant_id = current_tenant_id() AND site_id = current_site_id())
  WITH CHECK (tenant_id = current_tenant_id() AND site_id = current_site_id());

REVOKE ALL ON reviewed_astro_build_inputs FROM PUBLIC, navocms_plugin;
REVOKE UPDATE, DELETE ON reviewed_astro_build_inputs FROM navocms_app;
GRANT SELECT, INSERT ON reviewed_astro_build_inputs TO navocms_app;
REVOKE ALL ON FUNCTION reviewed_astro_build_inputs_immutable() FROM PUBLIC;

COMMIT;
