\set ON_ERROR_STOP on

BEGIN;
SET search_path = navocms, pg_catalog;

INSERT INTO tenants (id, slug, name) VALUES
  ('81000000-0000-4000-8000-000000000001', 'media-one', 'Media Tenant One'),
  ('82000000-0000-4000-8000-000000000002', 'media-two', 'Media Tenant Two');
INSERT INTO sites (id, tenant_id, slug, name) VALUES
  ('81100000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'media-one', 'Media Site One'),
  ('82200000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000002', 'media-two', 'Media Site Two');
INSERT INTO media_assets (id, tenant_id, site_id, state, provenance_json, rights_json) VALUES
  ('81300000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', 'verified', '{}', '{}'),
  ('81300000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', 'verified', '{}', '{}'),
  ('82300000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000002', '82200000-0000-4000-8000-000000000002', 'verified', '{}', '{}');
INSERT INTO media_originals (id, tenant_id, site_id, asset_id, sha256, byte_size, media_type, storage_key, verified_at) VALUES
  ('81400000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', '81300000-0000-4000-8000-000000000001', repeat('a', 64), 1, 'image/jpeg', concat('tenants/81000000-0000-4000-8000-000000000001/sites/81100000-0000-4000-8000-000000000001/originals/', repeat('a', 64)), now()),
  ('81400000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', '81300000-0000-4000-8000-000000000002', repeat('e', 64), 1, 'image/png', concat('tenants/81000000-0000-4000-8000-000000000001/sites/81100000-0000-4000-8000-000000000001/originals/', repeat('e', 64)), now()),
  ('82400000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000002', '82200000-0000-4000-8000-000000000002', '82300000-0000-4000-8000-000000000002', repeat('b', 64), 1, 'image/jpeg', concat('tenants/82000000-0000-4000-8000-000000000002/sites/82200000-0000-4000-8000-000000000002/originals/', repeat('b', 64)), now());
INSERT INTO media_variants (id, tenant_id, site_id, asset_id, original_sha256, variant_identity, sha256, storage_key, media_type, width, height, preset_version, transform_json) VALUES
  ('81500000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', '81300000-0000-4000-8000-000000000001', repeat('a', 64), repeat('c', 64), repeat('d', 64), concat('tenants/81000000-0000-4000-8000-000000000001/sites/81100000-0000-4000-8000-000000000001/variants/', repeat('c', 64)), 'image/webp', 1, 1, 'v1', '{}');
INSERT INTO media_references (id, tenant_id, site_id, asset_id, owner_type, owner_id, purpose) VALUES ('81600000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', '81300000-0000-4000-8000-000000000001', 'content.document', '81700000-0000-4000-8000-000000000001', 'hero');
INSERT INTO media_upload_intents (id, tenant_id, site_id, asset_id, operation_key, expected_sha256, expected_size, storage_key, expires_at) VALUES ('81800000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', '81300000-0000-4000-8000-000000000001', 'media-upload-one', repeat('a', 64), 1, 'tenants/81000000-0000-4000-8000-000000000001/sites/81100000-0000-4000-8000-000000000001/pending/81800000-0000-4000-8000-000000000001', now() + interval '1 hour');
INSERT INTO media_gc_candidates (id, tenant_id, site_id, asset_id, recoverable_until) VALUES ('81900000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', '81300000-0000-4000-8000-000000000001', now() + interval '1 day');
INSERT INTO media_lifecycle_checkpoints (id, tenant_id, site_id, asset_id, storage_key, operation, operation_key, status, grace_until) VALUES
  ('81900000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', '81300000-0000-4000-8000-000000000001', concat('tenants/81000000-0000-4000-8000-000000000001/sites/81100000-0000-4000-8000-000000000001/originals/', repeat('a', 64)), 'schedule_delete', 'media-isolation-checkpoint-0001', 'scheduled', now() + interval '1 day');

SET ROLE navocms_app;
SELECT set_config('navocms.tenant_id', '81000000-0000-4000-8000-000000000001', true);
SELECT set_config('navocms.site_id', '81100000-0000-4000-8000-000000000001', true);
SELECT set_config('navocms.principal_id', '81000000-0000-4000-8000-000000000001', true);
DO $assertions$
DECLARE table_name text; visible_count integer; expected_count integer;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['media_assets', 'media_originals', 'media_variants', 'media_references', 'media_upload_intents', 'media_gc_candidates', 'media_lifecycle_checkpoints'] LOOP
    EXECUTE format('SELECT count(*) FROM navocms.%I', table_name) INTO visible_count;
    expected_count := CASE WHEN table_name IN ('media_assets', 'media_originals') THEN 2 ELSE 1 END;
    IF visible_count <> expected_count THEN
      RAISE EXCEPTION 'RLS exposed % rows from %, expected %', visible_count, table_name, expected_count;
    END IF;
  END LOOP;
  BEGIN
    INSERT INTO navocms.media_references (id, tenant_id, site_id, asset_id, owner_type, owner_id, purpose)
      VALUES ('82600000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000002', '82200000-0000-4000-8000-000000000002', '82300000-0000-4000-8000-000000000002', 'content.document', '82700000-0000-4000-8000-000000000002', 'hero');
    RAISE EXCEPTION 'foreign media write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO navocms.media_lifecycle_checkpoints (id, tenant_id, site_id, asset_id, storage_key, operation, operation_key, status, grace_until)
      VALUES ('82500000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000002', '82200000-0000-4000-8000-000000000002', '82300000-0000-4000-8000-000000000002', concat('tenants/82000000-0000-4000-8000-000000000002/sites/82200000-0000-4000-8000-000000000002/originals/', repeat('b', 64)), 'schedule_delete', 'media-foreign-checkpoint-0001', 'scheduled', now() + interval '1 day');
    RAISE EXCEPTION 'foreign lifecycle write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END
$assertions$;
RESET ROLE;

DO $integrity$
BEGIN
  BEGIN
    UPDATE media_originals SET media_type = 'image/png' WHERE id = '81400000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'immutable original update unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'verified media originals are immutable' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO media_variants (id, tenant_id, site_id, asset_id, original_sha256, variant_identity, sha256, storage_key, media_type, width, height, preset_version, transform_json)
      VALUES ('82800000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000002', '82200000-0000-4000-8000-000000000002', '81300000-0000-4000-8000-000000000001', repeat('a', 64), repeat('e', 64), repeat('f', 64), concat('tenants/82000000-0000-4000-8000-000000000002/sites/82200000-0000-4000-8000-000000000002/variants/', repeat('e', 64)), 'image/webp', 1, 1, 'v1', '{}');
    RAISE EXCEPTION 'cross-site foreign key unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO media_variants (id, tenant_id, site_id, asset_id, original_sha256, variant_identity, sha256, storage_key, media_type, width, height, preset_version, transform_json)
      VALUES ('82900000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', '81300000-0000-4000-8000-000000000001', repeat('e', 64), repeat('9', 64), repeat('8', 64), concat('tenants/81000000-0000-4000-8000-000000000001/sites/81100000-0000-4000-8000-000000000001/variants/', repeat('9', 64)), 'image/webp', 1, 1, 'v1', '{}');
    RAISE EXCEPTION 'asset A and original B combination unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO media_assets (id, tenant_id, site_id, state, provenance_json, rights_json, deleted_at)
      VALUES ('83000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', 'pending', '{}', '{}', now());
    RAISE EXCEPTION 'deleted_at-only asset unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO media_assets (id, tenant_id, site_id, state, provenance_json, rights_json, purge_after)
      VALUES ('83100000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', 'pending', '{}', '{}', now());
    RAISE EXCEPTION 'purge_after-only asset unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO media_originals (id, tenant_id, site_id, asset_id, sha256, byte_size, media_type, width, storage_key, verified_at)
      VALUES ('83200000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', '81300000-0000-4000-8000-000000000002', repeat('1', 64), 1, 'image/jpeg', 1, concat('tenants/81000000-0000-4000-8000-000000000001/sites/81100000-0000-4000-8000-000000000001/originals/', repeat('1', 64)), now());
    RAISE EXCEPTION 'width-only original unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO media_originals (id, tenant_id, site_id, asset_id, sha256, byte_size, media_type, height, storage_key, verified_at)
      VALUES ('83300000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', '81300000-0000-4000-8000-000000000002', repeat('2', 64), 1, 'image/jpeg', 1, concat('tenants/81000000-0000-4000-8000-000000000001/sites/81100000-0000-4000-8000-000000000001/originals/', repeat('2', 64)), now());
    RAISE EXCEPTION 'height-only original unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO media_lifecycle_checkpoints (id, tenant_id, site_id, asset_id, storage_key, operation, operation_key, status, grace_until)
      VALUES ('83400000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', '82300000-0000-4000-8000-000000000002', concat('tenants/81000000-0000-4000-8000-000000000001/sites/81100000-0000-4000-8000-000000000001/originals/', repeat('b', 64)), 'schedule_delete', 'media-isolation-checkpoint-foreign', 'scheduled', now() + interval '1 day');
    RAISE EXCEPTION 'cross-site lifecycle foreign key unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    INSERT INTO media_assets (id, tenant_id, site_id, state, provenance_json, rights_json, deleted_at, purge_after)
      VALUES ('83500000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', 'deleted', '{}', '{}', now(), now() + interval '23 hours');
    RAISE EXCEPTION 'sub-24-hour deletion grace unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO media_lifecycle_checkpoints (id, tenant_id, site_id, asset_id, storage_key, operation, operation_key, status, grace_until)
      VALUES ('83600000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81100000-0000-4000-8000-000000000001', NULL, concat('tenants/81000000-0000-4000-8000-000000000001/sites/81100000-0000-4000-8000-000000000001/originals/', repeat('7', 64)), 'reconcile_orphan', 'media-orphan-short-grace-0001', 'effect_pending', now() + interval '23 hours');
    RAISE EXCEPTION 'sub-24-hour orphan grace unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL; END;
END
$integrity$;

ROLLBACK;
SELECT 'Media isolation checks passed' AS result;
