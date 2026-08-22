BEGIN;

SET search_path = navocms, pg_catalog;

CREATE TABLE IF NOT EXISTS release_candidates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  workflow_key text NOT NULL,
  release_hash text NOT NULL CHECK (release_hash ~ '^[0-9a-f]{64}$'),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
  manifest_json jsonb NOT NULL CHECK (jsonb_typeof(manifest_json) = 'object'),
  artifact_json jsonb NOT NULL CHECK (jsonb_typeof(artifact_json) = 'object'),
  status text NOT NULL CHECK (status IN (
    'previewed', 'approved', 'publishing', 'published',
    'verification_failed', 'failed', 'rolled_back'
  )),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, release_hash),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id, environment_id)
    REFERENCES environments(tenant_id, site_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, site_id, revision_id)
    REFERENCES content_revisions(tenant_id, site_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES identities(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS release_previews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  release_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id, release_id)
    REFERENCES release_candidates(tenant_id, site_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS release_approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  release_id uuid NOT NULL,
  release_hash text NOT NULL CHECK (release_hash ~ '^[0-9a-f]{64}$'),
  approved_by uuid,
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (tenant_id, site_id, release_id, release_hash),
  FOREIGN KEY (tenant_id, site_id, release_id)
    REFERENCES release_candidates(tenant_id, site_id, id) ON DELETE CASCADE,
  FOREIGN KEY (approved_by) REFERENCES identities(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  release_id uuid NOT NULL,
  workflow_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  current_step text NOT NULL,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  last_error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id, release_id)
    REFERENCES release_candidates(tenant_id, site_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_key text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  output_json jsonb NOT NULL CHECK (jsonb_typeof(output_json) = 'object'),
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, site_id, run_id, step_key),
  FOREIGN KEY (tenant_id, site_id, run_id)
    REFERENCES workflow_runs(tenant_id, site_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS release_publications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  release_id uuid NOT NULL,
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
  provider_key text NOT NULL,
  provider_reference text NOT NULL,
  previous_publication_id uuid,
  status text NOT NULL CHECK (status IN (
    'applied', 'verified', 'verification_failed', 'superseded', 'rolled_back'
  )),
  applied_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  rolled_back_at timestamptz,
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id, environment_id)
    REFERENCES environments(tenant_id, site_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, site_id, release_id)
    REFERENCES release_candidates(tenant_id, site_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, site_id, previous_publication_id)
    REFERENCES release_publications(tenant_id, site_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS release_publications_one_live_per_environment
  ON release_publications (tenant_id, site_id, environment_id)
  WHERE status IN ('applied', 'verified', 'verification_failed');
CREATE INDEX IF NOT EXISTS release_candidates_status_idx
  ON release_candidates (tenant_id, site_id, environment_id, status, updated_at);
CREATE INDEX IF NOT EXISTS release_previews_expiry_idx
  ON release_previews (expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS workflow_runs_recovery_idx
  ON workflow_runs (tenant_id, site_id, status, updated_at) WHERE status = 'running';

CREATE OR REPLACE FUNCTION resolve_release_preview(p_token_hash text)
RETURNS TABLE (
  media_type text,
  body text,
  release_hash text,
  artifact_hash text,
  expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = navocms, pg_catalog
AS $resolve_release_preview$
  SELECT c.artifact_json->>'mediaType', c.artifact_json->>'body',
         c.release_hash, c.artifact_hash, p.expires_at
    FROM release_previews p
    JOIN release_candidates c
      ON c.tenant_id = p.tenant_id AND c.site_id = p.site_id AND c.id = p.release_id
   WHERE p.token_hash = p_token_hash
     AND p.revoked_at IS NULL
     AND p.expires_at > now()
     AND c.status NOT IN ('failed', 'rolled_back')
   LIMIT 1
$resolve_release_preview$;

REVOKE ALL ON FUNCTION resolve_release_preview(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_release_preview(text) TO navocms_app;

CREATE OR REPLACE FUNCTION resolve_site_identity(
  p_issuer text,
  p_subject text,
  p_tenant_id uuid,
  p_site_id uuid
)
RETURNS TABLE (
  principal_id uuid,
  principal_kind text,
  site_role text,
  membership_permissions text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = navocms, pg_catalog
AS $resolve_site_identity$
  SELECT i.id, i.kind, sm.role, sm.permissions
    FROM identities i
    JOIN site_memberships sm ON sm.principal_id = i.id
   WHERE i.issuer = p_issuer
     AND i.subject = p_subject
     AND sm.tenant_id = p_tenant_id
     AND sm.site_id = p_site_id
   LIMIT 1
$resolve_site_identity$;

REVOKE ALL ON FUNCTION resolve_site_identity(text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_site_identity(text, text, uuid, uuid) TO navocms_app;

DO $release_rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'release_candidates', 'release_previews', 'release_approvals',
    'workflow_runs', 'workflow_checkpoints', 'release_publications'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS site_scope ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY site_scope ON %I TO navocms_app, navocms_plugin '
      'USING (tenant_id = current_tenant_id() AND site_id = current_site_id()) '
      'WITH CHECK (tenant_id = current_tenant_id() AND site_id = current_site_id())',
      table_name
    );
  END LOOP;
END
$release_rls$;

GRANT SELECT, INSERT, UPDATE ON
  release_candidates, release_previews, release_approvals,
  workflow_runs, workflow_checkpoints, release_publications TO navocms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA navocms TO navocms_app;

COMMIT;
