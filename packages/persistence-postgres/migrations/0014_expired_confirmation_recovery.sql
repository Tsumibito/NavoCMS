-- Expired links remain resolvable for an authenticated owner to renew the
-- review capability. Decision recording still rejects expired rows.
CREATE OR REPLACE FUNCTION navocms.resolve_release_confirmation(p_token_hash text)
RETURNS TABLE (
  release_id uuid,
  tenant_id uuid,
  site_id uuid,
  release_hash text,
  policy_version text,
  decision_at timestamptz,
  output_manifest_digest text,
  receipt_hash text,
  receipt_expires_at timestamptz,
  preview_expires_at timestamptz,
  decided_by_principal_id uuid,
  decided_by_reference text,
  revoked_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = navocms, pg_catalog
AS $resolve_release_confirmation$
  SELECT k.release_id, k.tenant_id, k.site_id, k.release_hash, k.policy_version,
         k.decision_at, k.output_manifest_digest, k.receipt_hash, k.receipt_expires_at,
         k.preview_expires_at, k.decided_by_principal_id, k.decided_by_reference, k.revoked_at
    FROM release_confirmations k
   WHERE k.token_hash = p_token_hash
   LIMIT 1
$resolve_release_confirmation$;
