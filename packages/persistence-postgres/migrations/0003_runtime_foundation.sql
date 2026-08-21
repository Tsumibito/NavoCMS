BEGIN;

SET search_path = navocms, pg_catalog;

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS primary_locale text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS locales text[] NOT NULL DEFAULT ARRAY['en']::text[];

ALTER TABLE environments ADD COLUMN IF NOT EXISTS environment_key text NOT NULL DEFAULT 'default';
ALTER TABLE environments DROP CONSTRAINT IF EXISTS environments_kind_check;
ALTER TABLE environments ADD CONSTRAINT environments_kind_check
  CHECK (kind IN ('development', 'preview', 'staging', 'production'));
ALTER TABLE environments DROP CONSTRAINT IF EXISTS environments_site_id_kind_key;
DO $environment_identity$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'environments_site_kind_key_unique'
  ) THEN
    ALTER TABLE environments ADD CONSTRAINT environments_site_kind_key_unique
      UNIQUE (site_id, kind, environment_key);
  END IF;
END
$environment_identity$;

ALTER TABLE content_documents DROP CONSTRAINT IF EXISTS content_documents_slug_check;
ALTER TABLE content_documents ADD CONSTRAINT content_documents_slug_check
  CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,127}$');

DO $site_locale_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sites_primary_locale_format') THEN
    ALTER TABLE sites ADD CONSTRAINT sites_primary_locale_format
      CHECK (primary_locale ~ '^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sites_locales_nonempty') THEN
    ALTER TABLE sites ADD CONSTRAINT sites_locales_nonempty
      CHECK (cardinality(locales) > 0 AND primary_locale = ANY(locales));
  END IF;
END
$site_locale_constraints$;

CREATE TABLE IF NOT EXISTS event_ledger (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  event_type text NOT NULL,
  idempotency_key text,
  event_json jsonb NOT NULL CHECK (jsonb_typeof(event_json) = 'object'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS event_ledger_site_idempotency_unique
  ON event_ledger (tenant_id, site_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_ledger_correlation_sequence_idx
  ON event_ledger (tenant_id, site_id, correlation_id, sequence);
CREATE INDEX IF NOT EXISTS event_ledger_type_recorded_idx
  ON event_ledger (tenant_id, site_id, event_type, recorded_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  response_json jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, site_id, operation, idempotency_key),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  CHECK ((status = 'completed') = (response_json IS NOT NULL)),
  CHECK (status <> 'failed' OR error_code IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS runtime_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  environment_id uuid,
  job_type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload_json) = 'object'),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  result_json jsonb,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id, environment_id)
    REFERENCES environments(tenant_id, site_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS runtime_jobs_claim_idx
  ON runtime_jobs (tenant_id, site_id, status, available_at, created_at)
  WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS runtime_leases (
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  lease_key text NOT NULL,
  owner_id text NOT NULL,
  fencing_token bigint GENERATED ALWAYS AS IDENTITY,
  expires_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, lease_key),
  UNIQUE (fencing_token),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

DO $runtime_rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'event_ledger', 'idempotency_records', 'runtime_jobs', 'runtime_leases'
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
$runtime_rls$;

GRANT SELECT, INSERT ON event_ledger TO navocms_app;
GRANT SELECT, INSERT, UPDATE ON idempotency_records, runtime_jobs, runtime_leases TO navocms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA navocms TO navocms_app;

COMMIT;
