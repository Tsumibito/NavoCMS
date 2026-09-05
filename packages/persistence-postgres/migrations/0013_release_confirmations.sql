-- Sprint 8.2: independent human confirmation receipts for release candidates.
-- The receipt records a decision made in a separate browser session; the MCP
-- `release_approve` checkpoint copies it and must match its exact inputs.
BEGIN;

CREATE TABLE IF NOT EXISTS navocms.release_confirmations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES navocms.tenants (id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES navocms.sites (id) ON DELETE CASCADE,
  release_id uuid NOT NULL,
  release_hash text NOT NULL CHECK (release_hash ~ '^[0-9a-f]{64}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  policy_version text NOT NULL,
  preview_expires_at timestamptz NOT NULL,
  decision_at timestamptz,
  output_manifest_digest text CHECK (output_manifest_digest IS NULL OR output_manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  receipt_hash text CHECK (receipt_hash IS NULL OR receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  receipt_expires_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT release_confirmations_release_binding
    FOREIGN KEY (tenant_id, site_id, release_id)
    REFERENCES navocms.release_candidates (tenant_id, site_id, id) ON DELETE CASCADE,
  -- A decision row starts pending; once decided it carries the exact inputs
  -- the approval checkpoint must reproduce. Revocation only happens after a
  -- decision and never mutates the recorded decision inputs.
  CONSTRAINT release_confirmations_decision_shape CHECK (
    (decision_at IS NULL AND receipt_hash IS NULL AND receipt_expires_at IS NULL)
    OR (decision_at IS NOT NULL AND receipt_hash IS NOT NULL
        AND receipt_expires_at IS NOT NULL AND output_manifest_digest IS NOT NULL)
  ),
  CONSTRAINT release_confirmations_receipt_expiry CHECK (
    receipt_expires_at IS NULL OR receipt_expires_at > decision_at
  ),
  CONSTRAINT release_confirmations_revocation_shape CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL AND decision_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS release_confirmations_open_idx
  ON navocms.release_confirmations (tenant_id, site_id, release_id, release_hash)
  WHERE decision_at IS NOT NULL AND revoked_at IS NULL;

ALTER TABLE navocms.release_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE navocms.release_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY site_scope ON navocms.release_confirmations TO navocms_app
  USING (tenant_id = navocms.current_tenant_id() AND site_id = navocms.current_site_id())
  WITH CHECK (tenant_id = navocms.current_tenant_id() AND site_id = navocms.current_site_id());

REVOKE ALL ON navocms.release_confirmations FROM PUBLIC, navocms_plugin;
REVOKE UPDATE, DELETE ON navocms.release_confirmations FROM navocms_app;
GRANT SELECT, INSERT, UPDATE ON navocms.release_confirmations TO navocms_app;

-- Capability-gated resolver for the browser confirmation flow. Runs outside
-- any site scope (same pattern as resolve_release_preview) and never exposes
-- tokens, only the hash-bearing summary the confirmation page renders.
CREATE OR REPLACE FUNCTION resolve_release_confirmation(p_token_hash text)
RETURNS TABLE (
  release_id uuid,
  tenant_id uuid,
  site_id uuid,
  release_hash text,
  policy_version text,
  decision_at timestamptz,
  output_manifest_digest text,
  receipt_hash text,
  preview_expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = navocms, pg_catalog
AS $resolve_release_confirmation$
  SELECT k.release_id, k.tenant_id, k.site_id, k.release_hash, k.policy_version,
         k.decision_at, k.output_manifest_digest, k.receipt_hash,
         k.preview_expires_at, k.revoked_at
    FROM release_confirmations k
   WHERE k.token_hash = p_token_hash
     AND k.preview_expires_at > now()
   LIMIT 1
$resolve_release_confirmation$;

REVOKE ALL ON FUNCTION resolve_release_confirmation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_release_confirmation(text) TO navocms_app;

-- Extended preview resolution for the real-output preview surface: the row
-- must carry tenant/site/release identity so the server can load the built
-- artifact inside its exact scope. Replaces the 0004 signature in place.
CREATE OR REPLACE FUNCTION resolve_release_preview(p_token_hash text)
RETURNS TABLE (
  release_id uuid,
  tenant_id uuid,
  site_id uuid,
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
  SELECT c.id, c.tenant_id, c.site_id,
         c.artifact_json->>'mediaType', c.artifact_json->>'body',
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

-- Append-once decision recording. Runs outside any site scope via SECURITY
-- DEFINER; the server derives the output manifest digest from the registered
-- artifact, never from the browser request. Re-delivery of an already
-- recorded decision is a no-op returning the same receipt.
CREATE OR REPLACE FUNCTION record_release_confirmation(
  p_token_hash text,
  p_output_manifest_digest text,
  p_receipt_hash text,
  p_receipt_expires_at timestamptz,
  p_decision_at timestamptz
)
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
  recorded boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = navocms, pg_catalog
AS $record_release_confirmation$
DECLARE
  v_row release_confirmations%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM release_confirmations
   WHERE token_hash = p_token_hash AND preview_expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_row.decision_at IS NOT NULL THEN
    RETURN QUERY SELECT v_row.release_id, v_row.tenant_id, v_row.site_id,
      v_row.release_hash, v_row.policy_version, v_row.decision_at,
      v_row.output_manifest_digest, v_row.receipt_hash, v_row.receipt_expires_at,
      v_row.preview_expires_at, false;
    RETURN;
  END IF;
  UPDATE release_confirmations
     SET decision_at = p_decision_at,
         output_manifest_digest = p_output_manifest_digest,
         receipt_hash = p_receipt_hash,
         receipt_expires_at = p_receipt_expires_at,
         updated_at = now()
   WHERE id = v_row.id;
  RETURN QUERY SELECT v_row.release_id, v_row.tenant_id, v_row.site_id,
    v_row.release_hash, v_row.policy_version, p_decision_at,
    p_output_manifest_digest, p_receipt_hash, p_receipt_expires_at,
    v_row.preview_expires_at, true;
END
$record_release_confirmation$;

REVOKE ALL ON FUNCTION record_release_confirmation(text, text, text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_release_confirmation(text, text, text, timestamptz, timestamptz) TO navocms_app;

COMMIT;
