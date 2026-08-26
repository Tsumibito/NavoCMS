BEGIN;

SET search_path = navocms, pg_catalog;

-- A reviewed record must bind to the exact release candidate, not merely to a
-- release ID or a hash that could be valid elsewhere in the same site.
ALTER TABLE environments
  ADD CONSTRAINT environments_exact_scope_unique
  UNIQUE (tenant_id, site_id, id, environment_key);

ALTER TABLE release_candidates
  ADD CONSTRAINT release_candidates_exact_artifact_binding_unique
  UNIQUE (tenant_id, site_id, id, environment_id, release_hash, artifact_hash);

CREATE TABLE reviewed_astro_artifacts (
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
  artifact_json jsonb NOT NULL
    CHECK (jsonb_typeof(artifact_json) = 'object')
    CHECK (octet_length(convert_to(artifact_json::text, 'utf8')) BETWEEN 2 AND 2097152),
  output_json jsonb NOT NULL
    CHECK (jsonb_typeof(output_json) = 'object')
    -- The independently verified output limit is 8 MiB. The small JSON
    -- envelope allowance keeps valid escaped HTML representable while still
    -- bounding database storage before an application reads it.
    CHECK (octet_length(convert_to(output_json::text, 'utf8')) BETWEEN 2 AND 9437184),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One release can have exactly one immutable reviewed source/output record.
  UNIQUE (tenant_id, site_id, release_id),
  FOREIGN KEY (tenant_id, site_id, environment_id, environment_key)
    REFERENCES environments (tenant_id, site_id, id, environment_key) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, site_id, release_id, environment_id, release_hash, artifact_hash)
    REFERENCES release_candidates (tenant_id, site_id, id, environment_id, release_hash, artifact_hash)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION reviewed_astro_artifacts_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $reviewed_astro_artifacts_immutable$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'reviewed Astro artifacts are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reviewed Astro artifacts cannot be deleted directly';
  END IF;
  RETURN NEW;
END
$reviewed_astro_artifacts_immutable$;

CREATE TRIGGER reviewed_astro_artifacts_immutable_trigger
  BEFORE UPDATE OR DELETE ON reviewed_astro_artifacts
  FOR EACH ROW EXECUTE FUNCTION reviewed_astro_artifacts_immutable();

ALTER TABLE reviewed_astro_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviewed_astro_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY site_scope ON reviewed_astro_artifacts TO navocms_app
  USING (tenant_id = current_tenant_id() AND site_id = current_site_id())
  WITH CHECK (tenant_id = current_tenant_id() AND site_id = current_site_id());

-- Default privileges grant the application role broad table access. This
-- record is append-only by design, so retain only the runtime operations that
-- registration and resolution need.
REVOKE ALL ON reviewed_astro_artifacts FROM PUBLIC, navocms_plugin;
REVOKE UPDATE, DELETE ON reviewed_astro_artifacts FROM navocms_app;
GRANT SELECT, INSERT ON reviewed_astro_artifacts TO navocms_app;
REVOKE ALL ON FUNCTION reviewed_astro_artifacts_immutable() FROM PUBLIC;

COMMIT;
