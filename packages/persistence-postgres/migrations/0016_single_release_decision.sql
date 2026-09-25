-- Renewed review links may coexist with expired ones. Only one link may
-- record a publication decision for a release, even under concurrent posts.
CREATE UNIQUE INDEX release_confirmations_one_decision_per_release
  ON navocms.release_confirmations (tenant_id, site_id, release_id)
  WHERE decision_at IS NOT NULL;
