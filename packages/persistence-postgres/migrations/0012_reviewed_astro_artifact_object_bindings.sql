BEGIN;

SET search_path = navocms, pg_catalog;

-- Expand only.  0010's JSON bundles remain readable until a separately
-- reviewed, evidence-backed legacy migration and retention decision.
CREATE TABLE reviewed_astro_artifact_object_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  environment_key text NOT NULL CHECK (environment_key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  release_id uuid NOT NULL,
  release_hash text NOT NULL CHECK (release_hash ~ '^[0-9a-f]{64}$'),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
  astro_artifact_hash text NOT NULL CHECK (astro_artifact_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_commit_sha text NOT NULL CHECK (source_commit_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  source_object_key text NOT NULL CHECK (source_object_key ~ '^tenants/[A-Za-z0-9._:-]+/sites/[A-Za-z0-9._:-]+/reviewed-astro/source/sha256/[0-9a-f]{64}\.json$'),
  source_object_sha256 text NOT NULL CHECK (source_object_sha256 ~ '^[0-9a-f]{64}$'),
  source_object_bytes integer NOT NULL CHECK (source_object_bytes BETWEEN 2 AND 4194304),
  output_object_key text NOT NULL CHECK (output_object_key ~ '^tenants/[A-Za-z0-9._:-]+/sites/[A-Za-z0-9._:-]+/reviewed-astro/output/sha256/[0-9a-f]{64}\.json$'),
  output_object_sha256 text NOT NULL CHECK (output_object_sha256 ~ '^[0-9a-f]{64}$'),
  output_object_bytes integer NOT NULL CHECK (output_object_bytes BETWEEN 2 AND 16777216),
  state text NOT NULL DEFAULT 'ready' CHECK (state = 'ready'),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Object keys are content-addressed and intentionally reusable by multiple
  -- exact release bindings in the same site; only a release binding is singleton.
  UNIQUE (tenant_id, site_id, release_id),
  FOREIGN KEY (tenant_id, site_id, environment_id, environment_key)
    REFERENCES environments (tenant_id, site_id, id, environment_key) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, site_id, release_id, environment_id, release_hash, artifact_hash)
    REFERENCES release_candidates (tenant_id, site_id, id, environment_id, release_hash, artifact_hash)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION reviewed_astro_artifact_object_bindings_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $reviewed_astro_artifact_object_bindings_immutable$
BEGIN
  RAISE EXCEPTION 'reviewed Astro object bindings are append-only';
END
$reviewed_astro_artifact_object_bindings_immutable$;

CREATE TRIGGER reviewed_astro_artifact_object_bindings_immutable_trigger
  BEFORE UPDATE OR DELETE ON reviewed_astro_artifact_object_bindings
  FOR EACH ROW EXECUTE FUNCTION reviewed_astro_artifact_object_bindings_immutable();

ALTER TABLE reviewed_astro_artifact_object_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviewed_astro_artifact_object_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY site_scope ON reviewed_astro_artifact_object_bindings TO navocms_app
  USING (tenant_id = current_tenant_id() AND site_id = current_site_id())
  WITH CHECK (tenant_id = current_tenant_id() AND site_id = current_site_id());

REVOKE ALL ON reviewed_astro_artifact_object_bindings FROM PUBLIC, navocms_plugin;
REVOKE UPDATE, DELETE ON reviewed_astro_artifact_object_bindings FROM navocms_app;
GRANT SELECT, INSERT ON reviewed_astro_artifact_object_bindings TO navocms_app;
REVOKE ALL ON FUNCTION reviewed_astro_artifact_object_bindings_immutable() FROM PUBLIC;

COMMIT;
