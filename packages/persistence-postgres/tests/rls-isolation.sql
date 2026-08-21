\set ON_ERROR_STOP on

BEGIN;
SET search_path = navocms, pg_catalog;

INSERT INTO tenants (id, slug, name) VALUES
  ('10000000-0000-4000-8000-000000000001', 'tenant-one', 'Tenant One'),
  ('20000000-0000-4000-8000-000000000002', 'tenant-two', 'Tenant Two');
INSERT INTO sites (id, tenant_id, slug, name) VALUES
  ('11000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'site-one', 'Site One'),
  ('22000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'site-two', 'Site Two');
INSERT INTO identities (id, issuer, subject, kind) VALUES
  ('11100000-0000-4000-8000-000000000001', 'https://identity.example', 'one', 'human'),
  ('22200000-0000-4000-8000-000000000002', 'https://identity.example', 'two', 'human');
INSERT INTO service_accounts (id, tenant_id, site_id, name, credential_fingerprint) VALUES
  ('11110000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'publisher', 'fingerprint-one'),
  ('22220000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000002', 'publisher', 'fingerprint-two');

SET ROLE navocms_app;
SELECT set_config('navocms.tenant_id', '10000000-0000-4000-8000-000000000001', true);
SELECT set_config('navocms.site_id', '11000000-0000-4000-8000-000000000001', true);
SELECT set_config('navocms.principal_id', '11100000-0000-4000-8000-000000000001', true);

DO $assertions$
DECLARE visible_sites integer;
DECLARE visible_accounts integer;
DECLARE role_bypasses boolean;
BEGIN
  SELECT count(*) INTO visible_sites FROM navocms.sites;
  IF visible_sites <> 1 THEN RAISE EXCEPTION 'RLS exposed % sites instead of 1', visible_sites; END IF;

  SELECT count(*) INTO visible_accounts FROM navocms.service_accounts;
  IF visible_accounts <> 1 THEN RAISE EXCEPTION 'RLS exposed % accounts instead of 1', visible_accounts; END IF;

  IF EXISTS (
    SELECT 1 FROM navocms.sites WHERE id = '22000000-0000-4000-8000-000000000002'
  ) THEN RAISE EXCEPTION 'foreign site was addressable'; END IF;

  SELECT rolbypassrls INTO role_bypasses FROM pg_roles WHERE rolname = current_user;
  IF role_bypasses THEN RAISE EXCEPTION 'application role bypasses RLS'; END IF;

  BEGIN
    INSERT INTO navocms.service_accounts (
      id, tenant_id, site_id, name, credential_fingerprint
    ) VALUES (
      '33330000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000002',
      '22000000-0000-4000-8000-000000000002',
      'intruder',
      'must-not-exist'
    );
    RAISE EXCEPTION 'foreign insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assertions$;

RESET ROLE;
ROLLBACK;

SELECT 'RLS isolation checks passed' AS result;
