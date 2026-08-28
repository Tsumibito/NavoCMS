\set ON_ERROR_STOP on

BEGIN;
SET search_path = navocms, pg_catalog;

INSERT INTO tenants (id, slug, name) VALUES
  ('71000000-0000-4000-8000-000000000001', 'release-one', 'Release Tenant One'),
  ('72000000-0000-4000-8000-000000000002', 'release-two', 'Release Tenant Two');
INSERT INTO sites (id, tenant_id, slug, name) VALUES
  ('71100000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'release-one', 'Release Site One'),
  ('71200000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000001', 'release-one-peer', 'Release Site One Peer'),
  ('72200000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', 'release-two', 'Release Site Two');
INSERT INTO identities (id, issuer, subject, kind) VALUES
  ('71100000-0000-4000-8000-000000000001', 'urn:navocms:test', 'release-one', 'human'),
  ('71200000-0000-4000-8000-000000000002', 'urn:navocms:test', 'release-peer', 'human'),
  ('72200000-0000-4000-8000-000000000002', 'urn:navocms:test', 'release-two', 'human');
INSERT INTO environments (id, tenant_id, site_id, kind) VALUES
  ('71300000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', 'staging'),
  ('71300000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000001', '71200000-0000-4000-8000-000000000002', 'staging'),
  ('72300000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', 'staging');
INSERT INTO content_types (id, tenant_id, site_id, name, version, definition) VALUES
  ('71400000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', 'article', '0.1.0', '{}'),
  ('71400000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000001', '71200000-0000-4000-8000-000000000002', 'article', '0.1.0', '{}'),
  ('72400000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', 'article', '0.1.0', '{}');
INSERT INTO content_documents (id, tenant_id, site_id, content_type_id, slug) VALUES
  ('71500000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', '71400000-0000-4000-8000-000000000001', 'release-one'),
  ('71500000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000001', '71200000-0000-4000-8000-000000000002', '71400000-0000-4000-8000-000000000002', 'release-one-peer'),
  ('72500000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', '72400000-0000-4000-8000-000000000002', 'release-two');
INSERT INTO content_variants (id, tenant_id, site_id, document_id, locale) VALUES
  ('71600000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', '71500000-0000-4000-8000-000000000001', 'en'),
  ('71600000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000001', '71200000-0000-4000-8000-000000000002', '71500000-0000-4000-8000-000000000002', 'en'),
  ('72600000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', '72500000-0000-4000-8000-000000000002', 'en');
INSERT INTO content_revisions (id, tenant_id, site_id, document_id, variant_id, revision_number, source_markdown, source_hash, ast_json, provenance_json) VALUES
  ('71700000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', '71500000-0000-4000-8000-000000000001', '71600000-0000-4000-8000-000000000001', 1, '# One', repeat('a', 64), '{}', '{}'),
  ('71700000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000001', '71200000-0000-4000-8000-000000000002', '71500000-0000-4000-8000-000000000002', '71600000-0000-4000-8000-000000000002', 1, '# One Peer', repeat('e', 64), '{}', '{}'),
  ('72700000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', '72500000-0000-4000-8000-000000000002', '72600000-0000-4000-8000-000000000002', 1, '# Two', repeat('b', 64), '{}', '{}');
INSERT INTO release_candidates (id, tenant_id, site_id, environment_id, revision_id, workflow_key, release_hash, artifact_hash, correlation_id, manifest_json, artifact_json, status) VALUES
  ('71800000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', '71300000-0000-4000-8000-000000000001', '71700000-0000-4000-8000-000000000001', 'editorial', repeat('a', 64), repeat('b', 64), '71500000-0000-4000-8000-000000000001', '{}', '{}', 'previewed'),
  ('71800000-0000-4000-8000-000000000009', '71000000-0000-4000-8000-000000000001', '71100000-0000-4000-8000-000000000001', '71300000-0000-4000-8000-000000000001', '71700000-0000-4000-8000-000000000001', 'editorial', repeat('1', 64), repeat('2', 64), '71500000-0000-4000-8000-000000000009', '{}', '{}', 'previewed'),
  ('71800000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000001', '71200000-0000-4000-8000-000000000002', '71300000-0000-4000-8000-000000000002', '71700000-0000-4000-8000-000000000002', 'editorial', repeat('e', 64), repeat('f', 64), '71500000-0000-4000-8000-000000000002', '{}', '{}', 'previewed'),
  ('72800000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', '72300000-0000-4000-8000-000000000002', '72700000-0000-4000-8000-000000000002', 'editorial', repeat('c', 64), repeat('d', 64), '72500000-0000-4000-8000-000000000002', '{}', '{}', 'previewed');
INSERT INTO reviewed_astro_artifacts (
  id, tenant_id, site_id, environment_id, environment_key, release_id,
  release_hash, artifact_hash, astro_artifact_hash, source_commit_sha,
  artifact_json, output_json
) VALUES (
  '71900000-0000-4000-8000-000000000002',
  '71000000-0000-4000-8000-000000000001',
  '71200000-0000-4000-8000-000000000002',
  '71300000-0000-4000-8000-000000000002', 'default',
  '71800000-0000-4000-8000-000000000002', repeat('e', 64), repeat('f', 64),
  concat('sha256:', repeat('a', 64)), repeat('b', 40), '{}'::jsonb, '{}'::jsonb
), (
  '72900000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000002',
  '72200000-0000-4000-8000-000000000002',
  '72300000-0000-4000-8000-000000000002', 'default',
  '72800000-0000-4000-8000-000000000002', repeat('c', 64), repeat('d', 64),
  concat('sha256:', repeat('e', 64)), repeat('f', 40), '{}'::jsonb, '{}'::jsonb
);
INSERT INTO reviewed_astro_artifact_object_bindings (
  id, tenant_id, site_id, environment_id, environment_key, release_id,
  release_hash, artifact_hash, astro_artifact_hash, source_commit_sha,
  source_object_key, source_object_sha256, source_object_bytes,
  output_object_key, output_object_sha256, output_object_bytes, evidence_hash
) VALUES (
  '73900000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000001',
  '71200000-0000-4000-8000-000000000002',
  '71300000-0000-4000-8000-000000000002', 'default',
  '71800000-0000-4000-8000-000000000002', repeat('e', 64), repeat('f', 64),
  concat('sha256:', repeat('a', 64)), repeat('b', 40),
  concat('tenants/71000000-0000-4000-8000-000000000001/sites/71200000-0000-4000-8000-000000000002/reviewed-astro/source/sha256/', repeat('a', 64), '.json'), repeat('a', 64), 2,
  concat('tenants/71000000-0000-4000-8000-000000000001/sites/71200000-0000-4000-8000-000000000002/reviewed-astro/output/sha256/', repeat('b', 64), '.json'), repeat('b', 64), 2,
  concat('sha256:', repeat('c', 64))
);
INSERT INTO reviewed_astro_build_inputs (
  id, tenant_id, site_id, environment_id, environment_key, release_id,
  release_hash, artifact_hash, binding_digest, render_json, created_by
) VALUES (
  '73000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000001',
  '71200000-0000-4000-8000-000000000002',
  '71300000-0000-4000-8000-000000000002', 'default',
  '71800000-0000-4000-8000-000000000002', repeat('e', 64), repeat('f', 64),
  concat('sha256:', repeat('a', 64)), '{}'::jsonb,
  '71200000-0000-4000-8000-000000000002'
), (
  '73000000-0000-4000-8000-000000000002',
  '72000000-0000-4000-8000-000000000002',
  '72200000-0000-4000-8000-000000000002',
  '72300000-0000-4000-8000-000000000002', 'default',
  '72800000-0000-4000-8000-000000000002', repeat('c', 64), repeat('d', 64),
  concat('sha256:', repeat('e', 64)), '{}'::jsonb,
  '72200000-0000-4000-8000-000000000002'
);

SET ROLE navocms_app;
SELECT set_config('navocms.tenant_id', '71000000-0000-4000-8000-000000000001', true);
SELECT set_config('navocms.site_id', '71100000-0000-4000-8000-000000000001', true);
SELECT set_config('navocms.principal_id', '71100000-0000-4000-8000-000000000001', true);

DO $assertions$
DECLARE visible_releases integer;
DECLARE visible_outbox integer;
DECLARE visible_reviewed_artifacts integer;
DECLARE visible_object_bindings integer;
DECLARE same_tenant_cross_site_artifacts integer;
DECLARE visible_build_inputs integer;
BEGIN
  SELECT count(*) INTO visible_releases FROM navocms.release_candidates;
  IF visible_releases <> 2 THEN RAISE EXCEPTION 'RLS exposed % release candidates instead of 2', visible_releases; END IF;
  SELECT count(*) INTO visible_outbox FROM navocms.domain_outbox;
  IF visible_outbox <> 0 THEN RAISE EXCEPTION 'unexpected outbox records'; END IF;
  INSERT INTO navocms.reviewed_astro_artifacts (
    id, tenant_id, site_id, environment_id, environment_key, release_id,
    release_hash, artifact_hash, astro_artifact_hash, source_commit_sha,
    artifact_json, output_json
  ) VALUES (
    '71900000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000001',
    '71300000-0000-4000-8000-000000000001', 'default',
    '71800000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64),
    concat('sha256:', repeat('c', 64)), repeat('d', 40), '{}'::jsonb, '{}'::jsonb
  );
  SELECT count(*) INTO visible_reviewed_artifacts FROM navocms.reviewed_astro_artifacts;
  IF visible_reviewed_artifacts <> 1 THEN RAISE EXCEPTION 'RLS exposed % reviewed artifacts instead of 1', visible_reviewed_artifacts; END IF;
  SELECT count(*) INTO same_tenant_cross_site_artifacts FROM navocms.reviewed_astro_artifacts
   WHERE site_id = '71200000-0000-4000-8000-000000000002';
  IF same_tenant_cross_site_artifacts <> 0 THEN RAISE EXCEPTION 'RLS exposed % same-tenant cross-site reviewed artifacts', same_tenant_cross_site_artifacts; END IF;
  INSERT INTO navocms.reviewed_astro_artifact_object_bindings (
    id, tenant_id, site_id, environment_id, environment_key, release_id,
    release_hash, artifact_hash, astro_artifact_hash, source_commit_sha,
    source_object_key, source_object_sha256, source_object_bytes,
    output_object_key, output_object_sha256, output_object_bytes, evidence_hash
  ) VALUES (
    '73900000-0000-4000-8000-000000000002',
    '71000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000001',
    '71300000-0000-4000-8000-000000000001', 'default',
    '71800000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64),
    concat('sha256:', repeat('c', 64)), repeat('d', 40),
    concat('tenants/71000000-0000-4000-8000-000000000001/sites/71100000-0000-4000-8000-000000000001/reviewed-astro/source/sha256/', repeat('c', 64), '.json'), repeat('c', 64), 2,
    concat('tenants/71000000-0000-4000-8000-000000000001/sites/71100000-0000-4000-8000-000000000001/reviewed-astro/output/sha256/', repeat('d', 64), '.json'), repeat('d', 64), 2,
    concat('sha256:', repeat('e', 64))
  );
  SELECT count(*) INTO visible_object_bindings FROM navocms.reviewed_astro_artifact_object_bindings;
  IF visible_object_bindings <> 1 THEN RAISE EXCEPTION 'RLS exposed % reviewed Astro object bindings instead of 1', visible_object_bindings; END IF;
  BEGIN
    UPDATE navocms.reviewed_astro_artifact_object_bindings SET state = 'ready'
     WHERE id = '73900000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'reviewed Astro object binding update privilege unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  INSERT INTO navocms.reviewed_astro_build_inputs (
    id, tenant_id, site_id, environment_id, environment_key, release_id,
    release_hash, artifact_hash, binding_digest, render_json, created_by
  ) VALUES (
    '73000000-0000-4000-8000-000000000003',
    '71000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000001',
    '71300000-0000-4000-8000-000000000001', 'default',
    '71800000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64),
    concat('sha256:', repeat('c', 64)), '{}'::jsonb,
    '71100000-0000-4000-8000-000000000001'
  );
  SELECT count(*) INTO visible_build_inputs FROM navocms.reviewed_astro_build_inputs;
  IF visible_build_inputs <> 1 THEN RAISE EXCEPTION 'RLS exposed % reviewed build inputs instead of 1', visible_build_inputs; END IF;
  BEGIN
    INSERT INTO navocms.domain_outbox (id, tenant_id, site_id, correlation_id, operation_key, event_type, consequence, idempotency_key, payload_json)
    VALUES ('72900000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '72200000-0000-4000-8000-000000000002', '72910000-0000-4000-8000-000000000002', 'foreign', 'test', 'G1', 'foreign', '{}');
    RAISE EXCEPTION 'foreign outbox write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO navocms.reviewed_astro_artifacts (
      id, tenant_id, site_id, environment_id, environment_key, release_id,
      release_hash, artifact_hash, astro_artifact_hash, source_commit_sha,
      artifact_json, output_json
    ) VALUES (
      '72900000-0000-4000-8000-000000000003',
      '72000000-0000-4000-8000-000000000002',
      '72200000-0000-4000-8000-000000000002',
      '72300000-0000-4000-8000-000000000002', 'default',
      '72800000-0000-4000-8000-000000000002', repeat('c', 64), repeat('d', 64),
      concat('sha256:', repeat('e', 64)), repeat('f', 40), '{}'::jsonb, '{}'::jsonb
    );
    RAISE EXCEPTION 'foreign reviewed artifact write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO navocms.reviewed_astro_artifacts (
      id, tenant_id, site_id, environment_id, environment_key, release_id,
      release_hash, artifact_hash, astro_artifact_hash, source_commit_sha,
      artifact_json, output_json
    ) VALUES (
      '71900000-0000-4000-8000-000000000004',
      '71000000-0000-4000-8000-000000000001',
      '71200000-0000-4000-8000-000000000002',
      '71300000-0000-4000-8000-000000000002', 'default',
      '71800000-0000-4000-8000-000000000002', repeat('e', 64), repeat('f', 64),
      concat('sha256:', repeat('a', 64)), repeat('b', 40), '{}'::jsonb, '{}'::jsonb
    );
    RAISE EXCEPTION 'same-tenant cross-site reviewed artifact write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE navocms.reviewed_astro_artifacts SET source_commit_sha = repeat('e', 40)
     WHERE id = '71900000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'reviewed artifact update privilege unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM navocms.reviewed_astro_artifacts WHERE id = '71900000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'reviewed artifact delete privilege unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO navocms.reviewed_astro_build_inputs (
      id, tenant_id, site_id, environment_id, environment_key, release_id,
      release_hash, artifact_hash, binding_digest, render_json, created_by
    ) VALUES (
      '73000000-0000-4000-8000-000000000004',
      '72000000-0000-4000-8000-000000000002',
      '72200000-0000-4000-8000-000000000002',
      '72300000-0000-4000-8000-000000000002', 'default',
      '72800000-0000-4000-8000-000000000002', repeat('c', 64), repeat('d', 64),
      concat('sha256:', repeat('e', 64)), '{}'::jsonb,
      '72200000-0000-4000-8000-000000000002'
    );
    RAISE EXCEPTION 'foreign reviewed build input write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE navocms.reviewed_astro_build_inputs SET binding_digest = concat('sha256:', repeat('e', 64))
      WHERE id = '73000000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'reviewed build input update privilege unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$assertions$;

RESET ROLE;

DO $artifact_integrity$
BEGIN
  BEGIN
    INSERT INTO navocms.reviewed_astro_artifacts (
      id, tenant_id, site_id, environment_id, environment_key, release_id,
      release_hash, artifact_hash, astro_artifact_hash, source_commit_sha,
      artifact_json, output_json
    ) VALUES (
      '71900000-0000-4000-8000-000000000003',
      '71000000-0000-4000-8000-000000000001',
      '71100000-0000-4000-8000-000000000001',
      '72300000-0000-4000-8000-000000000002', 'default',
      '71800000-0000-4000-8000-000000000009', repeat('1', 64), repeat('2', 64),
      concat('sha256:', repeat('c', 64)), repeat('d', 40), '{}'::jsonb, '{}'::jsonb
    );
    RAISE EXCEPTION 'wrong reviewed environment foreign key unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO navocms.reviewed_astro_artifacts (
      id, tenant_id, site_id, environment_id, environment_key, release_id,
      release_hash, artifact_hash, astro_artifact_hash, source_commit_sha,
      artifact_json, output_json
    ) VALUES (
      '71900000-0000-4000-8000-000000000008',
      '71000000-0000-4000-8000-000000000001',
      '71100000-0000-4000-8000-000000000001',
      '71300000-0000-4000-8000-000000000001', 'default',
      '72800000-0000-4000-8000-000000000002', repeat('a', 64), repeat('b', 64),
      concat('sha256:', repeat('c', 64)), repeat('d', 40), '{}'::jsonb, '{}'::jsonb
    );
    RAISE EXCEPTION 'wrong reviewed release foreign key unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO navocms.reviewed_astro_artifacts (
      id, tenant_id, site_id, environment_id, environment_key, release_id,
      release_hash, artifact_hash, astro_artifact_hash, source_commit_sha,
      artifact_json, output_json
    ) VALUES (
      '71900000-0000-4000-8000-000000000004',
      '71000000-0000-4000-8000-000000000001',
      '71100000-0000-4000-8000-000000000001',
      '71300000-0000-4000-8000-000000000001', 'default',
      '71800000-0000-4000-8000-000000000009', repeat('e', 64), repeat('2', 64),
      concat('sha256:', repeat('c', 64)), repeat('d', 40), '{}'::jsonb, '{}'::jsonb
    );
    RAISE EXCEPTION 'wrong reviewed release hash foreign key unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO navocms.reviewed_astro_artifacts (
      id, tenant_id, site_id, environment_id, environment_key, release_id,
      release_hash, artifact_hash, astro_artifact_hash, source_commit_sha,
      artifact_json, output_json
    ) VALUES (
      '71900000-0000-4000-8000-000000000005',
      '71000000-0000-4000-8000-000000000001',
      '71100000-0000-4000-8000-000000000001',
      '71300000-0000-4000-8000-000000000001', 'default',
      '71800000-0000-4000-8000-000000000009', repeat('1', 64), repeat('2', 64),
      concat('sha256:', repeat('c', 64)), repeat('d', 41), '{}'::jsonb, '{}'::jsonb
    );
    RAISE EXCEPTION 'non-exact reviewed commit SHA unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO navocms.reviewed_astro_artifacts (
      id, tenant_id, site_id, environment_id, environment_key, release_id,
      release_hash, artifact_hash, astro_artifact_hash, source_commit_sha,
      artifact_json, output_json
    ) VALUES (
      '71900000-0000-4000-8000-000000000006',
      '71000000-0000-4000-8000-000000000001',
      '71100000-0000-4000-8000-000000000001',
      '71300000-0000-4000-8000-000000000001', 'default',
      '71800000-0000-4000-8000-000000000009', repeat('1', 64), repeat('2', 64),
      concat('sha256:', repeat('c', 64)), repeat('d', 40), '[]'::jsonb, '{}'::jsonb
    );
    RAISE EXCEPTION 'non-object reviewed artifact unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO navocms.reviewed_astro_artifacts (
      id, tenant_id, site_id, environment_id, environment_key, release_id,
      release_hash, artifact_hash, astro_artifact_hash, source_commit_sha,
      artifact_json, output_json
    ) VALUES (
      '71900000-0000-4000-8000-000000000007',
      '71000000-0000-4000-8000-000000000001',
      '71100000-0000-4000-8000-000000000001',
      '71300000-0000-4000-8000-000000000001', 'default',
      '71800000-0000-4000-8000-000000000009', repeat('1', 64), repeat('2', 64),
      concat('sha256:', repeat('c', 64)), repeat('d', 40), '{}'::jsonb,
      jsonb_build_object('oversized', repeat('x', 9437185))
    );
    RAISE EXCEPTION 'oversized reviewed output unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE navocms.reviewed_astro_artifacts SET source_commit_sha = repeat('e', 40)
     WHERE id = '71900000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'reviewed artifact trigger allowed update';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  BEGIN
    DELETE FROM navocms.reviewed_astro_artifacts WHERE id = '71900000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'reviewed artifact trigger allowed delete';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END
$artifact_integrity$;

DO $build_input_integrity$
BEGIN
  BEGIN
    INSERT INTO navocms.reviewed_astro_build_inputs (
      id, tenant_id, site_id, environment_id, environment_key, release_id,
      release_hash, artifact_hash, binding_digest, render_json, created_by
    ) VALUES (
      '73000000-0000-4000-8000-000000000005',
      '71000000-0000-4000-8000-000000000001',
      '71100000-0000-4000-8000-000000000001',
      '71300000-0000-4000-8000-000000000001', 'default',
      '72800000-0000-4000-8000-000000000002', repeat('c', 64), repeat('d', 64),
      concat('sha256:', repeat('a', 64)), '{}'::jsonb,
      '71100000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'wrong reviewed build input release foreign key unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE navocms.reviewed_astro_build_inputs SET binding_digest = concat('sha256:', repeat('f', 64))
      WHERE id = '73000000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'reviewed build input trigger allowed update';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  BEGIN
    DELETE FROM navocms.reviewed_astro_build_inputs WHERE id = '73000000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'reviewed build input trigger allowed delete';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
END
$build_input_integrity$;

ROLLBACK;

SELECT 'Release workflow isolation checks passed' AS result;
