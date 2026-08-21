\set ON_ERROR_STOP on

BEGIN;
SET search_path = navocms, pg_catalog;

INSERT INTO tenants (id, slug, name) VALUES
  ('30000000-0000-4000-8000-000000000003', 'content-one', 'Content Tenant One'),
  ('40000000-0000-4000-8000-000000000004', 'content-two', 'Content Tenant Two');
INSERT INTO sites (id, tenant_id, slug, name) VALUES
  ('33000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'content-one', 'Content Site One'),
  ('44000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000004', 'content-two', 'Content Site Two');
INSERT INTO content_types (id, tenant_id, site_id, name, version, definition) VALUES
  ('33100000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', '33000000-0000-4000-8000-000000000003', 'article', '0.1.0', '{}'),
  ('44100000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000004', '44000000-0000-4000-8000-000000000004', 'article', '0.1.0', '{}');
INSERT INTO content_documents (id, tenant_id, site_id, content_type_id, slug) VALUES
  ('33200000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', '33000000-0000-4000-8000-000000000003', '33100000-0000-4000-8000-000000000003', 'article-one'),
  ('44200000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000004', '44000000-0000-4000-8000-000000000004', '44100000-0000-4000-8000-000000000004', 'article-two');
INSERT INTO content_variants (id, tenant_id, site_id, document_id, locale) VALUES
  ('33300000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', '33000000-0000-4000-8000-000000000003', '33200000-0000-4000-8000-000000000003', 'en'),
  ('44300000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000004', '44000000-0000-4000-8000-000000000004', '44200000-0000-4000-8000-000000000004', 'en');
INSERT INTO content_revisions (
  id, tenant_id, site_id, document_id, variant_id, revision_number, source_markdown,
  source_hash, ast_json, provenance_json
) VALUES
  ('33400000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', '33000000-0000-4000-8000-000000000003', '33200000-0000-4000-8000-000000000003', '33300000-0000-4000-8000-000000000003', 1, '# One', repeat('a', 64), '{}', '{}'),
  ('44400000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000004', '44000000-0000-4000-8000-000000000004', '44200000-0000-4000-8000-000000000004', '44300000-0000-4000-8000-000000000004', 1, '# Two', repeat('b', 64), '{}', '{}');

SET ROLE navocms_app;
SELECT set_config('navocms.tenant_id', '30000000-0000-4000-8000-000000000003', true);
SELECT set_config('navocms.site_id', '33000000-0000-4000-8000-000000000003', true);
SELECT set_config('navocms.principal_id', '', true);

DO $assertions$
DECLARE visible_documents integer;
DECLARE visible_revisions integer;
BEGIN
  SELECT count(*) INTO visible_documents FROM navocms.content_documents;
  IF visible_documents <> 1 THEN RAISE EXCEPTION 'RLS exposed % documents instead of 1', visible_documents; END IF;

  SELECT count(*) INTO visible_revisions FROM navocms.content_revisions;
  IF visible_revisions <> 1 THEN RAISE EXCEPTION 'RLS exposed % revisions instead of 1', visible_revisions; END IF;

  IF EXISTS (
    SELECT 1 FROM navocms.content_revisions
    WHERE id = '44400000-0000-4000-8000-000000000004'
  ) THEN RAISE EXCEPTION 'foreign content revision was addressable'; END IF;

  BEGIN
    UPDATE navocms.content_revisions SET source_markdown = '# Mutated'
    WHERE id = '33400000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'immutable revision update unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO navocms.content_documents (id, tenant_id, site_id, content_type_id, slug) VALUES (
      '44500000-0000-4000-8000-000000000005',
      '40000000-0000-4000-8000-000000000004',
      '44000000-0000-4000-8000-000000000004',
      '44100000-0000-4000-8000-000000000004',
      'foreign-write'
    );
    RAISE EXCEPTION 'foreign content insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assertions$;

RESET ROLE;
ROLLBACK;

SELECT 'Content isolation checks passed' AS result;
