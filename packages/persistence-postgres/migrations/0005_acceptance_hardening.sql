BEGIN;

SET search_path = navocms, pg_catalog;

ALTER TABLE release_candidates ADD COLUMN IF NOT EXISTS correlation_id uuid;
UPDATE release_candidates candidate
   SET correlation_id = document.id
  FROM content_revisions revision
  JOIN content_documents document
    ON document.tenant_id = revision.tenant_id AND document.site_id = revision.site_id
   AND document.id = revision.document_id
 WHERE candidate.tenant_id = revision.tenant_id AND candidate.site_id = revision.site_id
   AND candidate.revision_id = revision.id AND candidate.correlation_id IS NULL;
ALTER TABLE release_candidates ALTER COLUMN correlation_id SET NOT NULL;

-- Approval is a short-lived, attributable authorization record, never just a
-- mutable release status. Evidence contains hashes/references only.
ALTER TABLE release_approvals
  ADD COLUMN IF NOT EXISTS actor_kind text NOT NULL DEFAULT 'human'
    CHECK (actor_kind = 'human'),
  ADD COLUMN IF NOT EXISTS policy_version text NOT NULL DEFAULT 'navocms.release-approval.v1',
  ADD COLUMN IF NOT EXISTS evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence_json) = 'object'),
  ADD COLUMN IF NOT EXISTS scope_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(scope_json) = 'object'),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS revoked_by uuid REFERENCES identities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revocation_reason text;

UPDATE release_approvals
   SET expires_at = approved_at + interval '15 minutes'
 WHERE expires_at <= approved_at;

ALTER TABLE release_approvals
  DROP CONSTRAINT IF EXISTS release_approvals_approval_integrity;
ALTER TABLE release_approvals
  ADD CONSTRAINT release_approvals_approval_integrity CHECK (
    expires_at > approved_at
    AND (revoked_at IS NULL OR (revoked_by IS NOT NULL AND revocation_reason IS NOT NULL))
  );

CREATE INDEX IF NOT EXISTS release_approvals_current_idx
  ON release_approvals (tenant_id, site_id, release_id, release_hash, expires_at)
  WHERE revoked_at IS NULL;

-- Event idempotency must identify an operation, not merely a human-readable
-- idempotency token shared by two different tools.
ALTER TABLE event_ledger ADD COLUMN IF NOT EXISTS operation_key text;
DROP INDEX IF EXISTS event_ledger_site_idempotency_unique;
CREATE UNIQUE INDEX IF NOT EXISTS event_ledger_operation_idempotency_unique
  ON event_ledger (tenant_id, site_id, operation_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND operation_key IS NOT NULL;

-- A transactional outbox records the event envelope with the state mutation.
-- Delivery is deliberately separate; persistence is not best-effort logging.
CREATE TABLE IF NOT EXISTS domain_outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  operation_key text NOT NULL,
  event_type text NOT NULL,
  consequence text NOT NULL CHECK (consequence IN ('G0', 'G1', 'G2', 'G3')),
  idempotency_key text NOT NULL,
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (tenant_id, site_id, operation_key, idempotency_key),
  UNIQUE (tenant_id, site_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE domain_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_scope ON domain_outbox;
CREATE POLICY site_scope ON domain_outbox TO navocms_app, navocms_plugin
  USING (tenant_id = current_tenant_id() AND site_id = current_site_id())
  WITH CHECK (tenant_id = current_tenant_id() AND site_id = current_site_id());
GRANT SELECT, INSERT, UPDATE ON domain_outbox TO navocms_app;

COMMIT;
