\set ON_ERROR_STOP on

BEGIN;
SET search_path = navocms, pg_catalog;

INSERT INTO tenants (id, slug, name) VALUES
  ('71000000-0000-4000-8000-000000000001', 'release-one', 'Release Tenant One'),
  ('72000000-0000-4000-8000-000000000002', 'release-two', 'Release Tenant Two');
INSERT INTO sites (id, tenant_id, slug, name) VALUES
  ('71100000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'release-one', 'Release Site One'),
  ('72200000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', 'release-two', 'Release Site Two');
INSERT INTO environments (id, tenant_id, site_id, kind) VALUES
  ('71300000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', 'staging'),
  ('72300000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', 'staging');
INSERT INTO content_types (id, tenant_id, site_id, name, version, definition) VALUES
  ('71400000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', 'article', '0.1.0', '{}'),
  ('72400000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', 'article', '0.1.0', '{}');
INSERT INTO content_documents (id, tenant_id, site_id, content_type_id, slug) VALUES
  ('71500000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', '71400000-0000-4000-8000-000000000001', 'release-one'),
  ('72500000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', '72400000-0000-4000-8000-000000000002', 'release-two');
INSERT INTO content_variants (id, tenant_id, site_id, document_id, locale) VALUES
  ('71600000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', '71500000-0000-4000-8000-000000000001', 'en'),
  ('72600000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', '72500000-0000-4000-8000-000000000002', 'en');
INSERT INTO content_revisions (id, tenant_id, site_id, document_id, variant_id, revision_number, source_markdown, source_hash, ast_json, provenance_json) VALUES
  ('71700000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', '71500000-0000-4000-8000-000000000001', '71600000-0000-4000-8000-000000000001', 1, '# One', repeat('a', 64), '{}', '{}'),
  ('72700000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', '72500000-0000-4000-8000-000000000002', '72600000-0000-4000-8000-000000000002', 1, '# Two', repeat('b', 64), '{}', '{}');
INSERT INTO release_candidates (id, tenant_id, site_id, environment_id, revision_id, workflow_key, release_hash, artifact_hash, correlation_id, manifest_json, artifact_json, status) VALUES
  ('71800000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', '71300000-0000-4000-8000-000000000001', '71700000-0000-4000-8000-000000000001', 'editorial', repeat('a', 64), repeat('b', 64), '71500000-0000-4000-8000-000000000001', '{}', '{}', 'previewed'),
  ('72800000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', '72300000-0000-4000-8000-000000000002', '72700000-0000-4000-8000-000000000002', 'editorial', repeat('c', 64), repeat('d', 64), '72500000-0000-4000-8000-000000000002', '{}', '{}', 'previewed');

SET ROLE navocms_app;
SELECT set_config('navocms.tenant_id', '71000000-0000-4000-8000-000000000001', true);
SELECT set_config('navocms.site_id', '71100000-0000-4000-8000-000000000001', true);
SELECT set_config('navocms.principal_id', '71100000-0000-4000-8000-000000000001', true);

DO $assertions$
DECLARE visible_releases integer;
DECLARE visible_outbox integer;
BEGIN
  SELECT count(*) INTO visible_releases FROM navocms.release_candidates;
  IF visible_releases <> 1 THEN RAISE EXCEPTION 'RLS exposed % release candidates instead of 1', visible_releases; END IF;
  SELECT count(*) INTO visible_outbox FROM navocms.domain_outbox;
  IF visible_outbox <> 0 THEN RAISE EXCEPTION 'unexpected outbox records'; END IF;
  BEGIN
    INSERT INTO navocms.domain_outbox (id, tenant_id, site_id, correlation_id, operation_key, event_type, consequence, idempotency_key, payload_json)
    VALUES ('72900000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', '72910000-0000-4000-8000-000000000002', 'foreign', 'test', 'G1', 'foreign', '{}');
    RAISE EXCEPTION 'foreign outbox write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$assertions$;

RESET ROLE;
ROLLBACK;

SELECT 'Release workflow isolation checks passed' AS result;
