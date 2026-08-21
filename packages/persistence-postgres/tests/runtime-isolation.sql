\set ON_ERROR_STOP on

BEGIN;
SET search_path = navocms, pg_catalog;

INSERT INTO tenants (id, slug, name) VALUES
  ('50000000-0000-4000-8000-000000000005', 'runtime-one', 'Runtime Tenant One'),
  ('60000000-0000-4000-8000-000000000006', 'runtime-two', 'Runtime Tenant Two');
INSERT INTO sites (id, tenant_id, slug, name) VALUES
  ('55000000-0000-4000-8000-000000000005', '50000000-0000-4000-8000-000000000005', 'runtime-one', 'Runtime Site One'),
  ('66000000-0000-4000-8000-000000000006', '60000000-0000-4000-8000-000000000006', 'runtime-two', 'Runtime Site Two');
INSERT INTO event_ledger (
  event_id, tenant_id, site_id, correlation_id, event_type, event_json, occurred_at
) VALUES
  ('55100000-0000-4000-8000-000000000005', '50000000-0000-4000-8000-000000000005', '55000000-0000-4000-8000-000000000005', '55200000-0000-4000-8000-000000000005', 'dev.navocms.test', '{}', now()),
  ('66100000-0000-4000-8000-000000000006', '60000000-0000-4000-8000-000000000006', '66000000-0000-4000-8000-000000000006', '66200000-0000-4000-8000-000000000006', 'dev.navocms.test', '{}', now());
INSERT INTO idempotency_records (
  tenant_id, site_id, operation, idempotency_key, input_fingerprint, status
) VALUES
  ('50000000-0000-4000-8000-000000000005', '55000000-0000-4000-8000-000000000005', 'draft_create', 'runtime-one', repeat('a', 64), 'pending'),
  ('60000000-0000-4000-8000-000000000006', '66000000-0000-4000-8000-000000000006', 'draft_create', 'runtime-two', repeat('b', 64), 'pending');

SET ROLE navocms_app;
SELECT set_config('navocms.tenant_id', '50000000-0000-4000-8000-000000000005', true);
SELECT set_config('navocms.site_id', '55000000-0000-4000-8000-000000000005', true);
SELECT set_config('navocms.principal_id', '55300000-0000-4000-8000-000000000005', true);

DO $assertions$
DECLARE visible_events integer;
DECLARE visible_records integer;
BEGIN
  SELECT count(*) INTO visible_events FROM navocms.event_ledger;
  IF visible_events <> 1 THEN RAISE EXCEPTION 'RLS exposed % runtime events instead of 1', visible_events; END IF;

  SELECT count(*) INTO visible_records FROM navocms.idempotency_records;
  IF visible_records <> 1 THEN RAISE EXCEPTION 'RLS exposed % idempotency records instead of 1', visible_records; END IF;

  BEGIN
    INSERT INTO navocms.idempotency_records (
      tenant_id, site_id, operation, idempotency_key, input_fingerprint, status
    ) VALUES (
      '60000000-0000-4000-8000-000000000006',
      '66000000-0000-4000-8000-000000000006',
      'draft_create',
      'foreign-write',
      repeat('c', 64),
      'pending'
    );
    RAISE EXCEPTION 'foreign idempotency write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assertions$;

RESET ROLE;
ROLLBACK;

SELECT 'Runtime isolation checks passed' AS result;
