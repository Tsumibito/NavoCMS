BEGIN;

SET search_path = navocms, pg_catalog;

CREATE TABLE IF NOT EXISTS quota_limits (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  site_id uuid,
  plugin_id text,
  operation_key text NOT NULL,
  period text NOT NULL CHECK (period IN ('hour', 'day', 'month', 'lifetime')),
  limit_amount bigint NOT NULL CHECK (limit_amount >= 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((site_id IS NULL) OR tenant_id IS NOT NULL),
  CHECK ((plugin_id IS NULL) OR length(plugin_id) > 0),
  UNIQUE NULLS NOT DISTINCT (tenant_id, site_id, plugin_id, operation_key, period)
);

CREATE TABLE IF NOT EXISTS kill_switches (
  id uuid PRIMARY KEY,
  level text NOT NULL CHECK (level IN ('global', 'tenant', 'site', 'plugin')),
  tenant_id uuid,
  site_id uuid,
  plugin_id text,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (level = 'global' AND tenant_id IS NULL AND site_id IS NULL AND plugin_id IS NULL) OR
    (level = 'tenant' AND tenant_id IS NOT NULL AND site_id IS NULL AND plugin_id IS NULL) OR
    (level = 'site' AND tenant_id IS NOT NULL AND site_id IS NOT NULL AND plugin_id IS NULL) OR
    (level = 'plugin' AND tenant_id IS NOT NULL AND site_id IS NOT NULL AND plugin_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  plugin_id text,
  operation_key text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, site_id, operation_key)
);

-- 0001 already introduced site-level metering primitives. Evolve those
-- records in place so no quota evidence is lost on an existing deployment.
ALTER TABLE quota_limits ADD COLUMN IF NOT EXISTS operation_key text;
UPDATE quota_limits SET operation_key = metric WHERE operation_key IS NULL;
ALTER TABLE quota_limits ALTER COLUMN operation_key SET NOT NULL;
ALTER TABLE quota_limits ALTER COLUMN metric DROP NOT NULL;
DO $integer_quota_limits$
BEGIN
  IF EXISTS (SELECT 1 FROM quota_limits WHERE limit_amount <> trunc(limit_amount)) THEN
    RAISE EXCEPTION 'Existing quota limits must be whole numbers before migration 0006';
  END IF;
END
$integer_quota_limits$;
ALTER TABLE quota_limits ALTER COLUMN limit_amount TYPE bigint USING limit_amount::bigint;
ALTER TABLE quota_limits ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE quota_limits ALTER COLUMN site_id DROP NOT NULL;
ALTER TABLE quota_limits ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE quota_limits ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE quota_limits ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE quota_limits DROP CONSTRAINT IF EXISTS quota_limits_site_id_plugin_id_metric_period_key;
ALTER TABLE quota_limits DROP CONSTRAINT IF EXISTS quota_limits_scope_operation_period_key;
ALTER TABLE quota_limits
  ADD CONSTRAINT quota_limits_scope_operation_period_key
  UNIQUE NULLS NOT DISTINCT (tenant_id, site_id, plugin_id, operation_key, period);

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS operation_key text;
UPDATE usage_events
   SET operation_key = concat(coalesce(metric, 'legacy'), ':legacy:', id::text)
 WHERE operation_key IS NULL;
ALTER TABLE usage_events ALTER COLUMN operation_key SET NOT NULL;
ALTER TABLE usage_events ALTER COLUMN metric DROP NOT NULL;
DO $integer_usage_events$
BEGIN
  IF EXISTS (SELECT 1 FROM usage_events WHERE amount <> trunc(amount)) THEN
    RAISE EXCEPTION 'Existing usage amounts must be whole numbers before migration 0006';
  END IF;
END
$integer_usage_events$;
ALTER TABLE usage_events ALTER COLUMN amount TYPE bigint USING amount::bigint;
ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_events_tenant_id_site_id_operation_key_key;
ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_tenant_id_site_id_operation_key_key
  UNIQUE (tenant_id, site_id, operation_key);

ALTER TABLE kill_switches ADD COLUMN IF NOT EXISTS level text;
UPDATE kill_switches
   SET level = CASE WHEN plugin_id IS NOT NULL THEN 'plugin' WHEN site_id IS NOT NULL THEN 'site' ELSE 'tenant' END
 WHERE level IS NULL;
ALTER TABLE kill_switches ALTER COLUMN level SET NOT NULL;
ALTER TABLE kill_switches ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
UPDATE kill_switches SET active = disabled_at IS NULL WHERE active = true;
ALTER TABLE kill_switches ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE kill_switches ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE kill_switches ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE kill_switches DROP CONSTRAINT IF EXISTS kill_switches_check;
ALTER TABLE kill_switches ADD CONSTRAINT kill_switches_scope_integrity CHECK (
  (level = 'global' AND tenant_id IS NULL AND site_id IS NULL AND plugin_id IS NULL) OR
  (level = 'tenant' AND tenant_id IS NOT NULL AND site_id IS NULL AND plugin_id IS NULL) OR
  (level = 'site' AND tenant_id IS NOT NULL AND site_id IS NOT NULL AND plugin_id IS NULL) OR
  (level = 'plugin' AND tenant_id IS NOT NULL AND site_id IS NOT NULL AND plugin_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS usage_events_policy_window_idx
  ON usage_events (tenant_id, site_id, plugin_id, operation_key, occurred_at);
CREATE INDEX IF NOT EXISTS quota_limits_scope_idx
  ON quota_limits (operation_key, enabled, tenant_id, site_id, plugin_id);
CREATE INDEX IF NOT EXISTS kill_switches_active_scope_idx
  ON kill_switches (active, level, tenant_id, site_id, plugin_id);

DO $policy_rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['quota_limits', 'kill_switches', 'usage_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS runtime_policy_scope ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY runtime_policy_scope ON %I TO navocms_app '
      'USING ((tenant_id IS NULL OR tenant_id = current_tenant_id()) '
      'AND (site_id IS NULL OR site_id = current_site_id())) '
      'WITH CHECK (tenant_id = current_tenant_id() AND (site_id IS NULL OR site_id = current_site_id()))',
      table_name
    );
  END LOOP;
END
$policy_rls$;

REVOKE INSERT, UPDATE, DELETE ON quota_limits, kill_switches FROM navocms_app;
REVOKE UPDATE, DELETE ON usage_events FROM navocms_app;
GRANT SELECT ON quota_limits, kill_switches TO navocms_app;
GRANT SELECT, INSERT ON usage_events TO navocms_app;

COMMIT;
