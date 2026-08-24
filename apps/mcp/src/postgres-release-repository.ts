import { randomUUID } from "node:crypto";

import {
  releaseTransition,
  sha256,
  type ReleaseProviderPublication,
  type ReleaseStatus
} from "@navocms/kernel";
import { type PostgresDatabase, type SqlClient } from "@navocms/persistence-postgres";

import { McpEditingError } from "./errors.js";
import type { RepositoryContext } from "./repository.js";
import type {
  CreateReleaseInput,
  PreviewDocument,
  PublicationRecord,
  ReleaseApprovalInput,
  ReleaseWorkflowRepository,
  StoredRelease
} from "./release-repository.js";

interface ReleaseRow extends Record<string, unknown> {
  readonly id: string;
  readonly environment_id: string;
  readonly revision_id: string;
  readonly workflow_key: string;
  readonly release_hash: string;
  readonly artifact_hash: string;
  readonly correlation_id: string;
  readonly manifest_json: StoredRelease["manifest"];
  readonly artifact_json: StoredRelease["artifact"];
  readonly status: ReleaseStatus;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly approved_at?: Date | string | null;
  readonly published_at?: Date | string | null;
}

interface PublicationRow extends Record<string, unknown> {
  readonly id: string;
  readonly release_id: string;
  readonly environment_id: string;
  readonly artifact_hash: string;
  readonly provider_key: string;
  readonly provider_reference: string;
  readonly previous_publication_id: string | null;
  readonly status: PublicationRecord["status"];
}

interface PreviewRow extends Record<string, unknown> {
  readonly media_type: string;
  readonly body: string;
  readonly release_hash: string;
  readonly artifact_hash: string;
  readonly expires_at: Date | string;
}

export class PostgresReleaseWorkflowRepository implements ReleaseWorkflowRepository {
  readonly #database: PostgresDatabase;

  public constructor(database: PostgresDatabase) {
    this.#database = database;
  }

  public async environmentId(context: RepositoryContext, environmentKey: string): Promise<string> {
    return this.#database.withScope(databaseScope(context), (client) => requireEnvironment(client, context, environmentKey));
  }

  public async createPreview(input: CreateReleaseInput): Promise<StoredRelease> {
    return this.#database.withScope(databaseScope(input.context), async (client) => {
      const environmentId = await requireEnvironment(client, input.context, input.environmentKey);
      if (environmentId !== input.manifest.environmentId) {
        throw new McpEditingError("RELEASE_ENVIRONMENT_MISMATCH", "Release manifest targets another environment");
      }
      const releaseId = randomUUID();
      const now = new Date().toISOString();
      const result = await client.query<ReleaseRow>(
        `INSERT INTO navocms.release_candidates (
           id, tenant_id, site_id, environment_id, revision_id, workflow_key,
           release_hash, artifact_hash, correlation_id, manifest_json, artifact_json, status,
           created_by, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,'previewed',$12,$13,$13)
         ON CONFLICT (tenant_id, site_id, release_hash) DO UPDATE
           SET updated_at = navocms.release_candidates.updated_at
        RETURNING id, environment_id, revision_id, workflow_key, release_hash, correlation_id,
                   artifact_hash, manifest_json, artifact_json, status, created_at, updated_at`,
        [releaseId, input.context.site.tenantId, input.context.site.siteId, environmentId,
          input.revisionId, input.workflow, input.releaseHash, input.artifact.hash, input.correlationId,
          JSON.stringify(input.manifest), JSON.stringify(input.artifact), uuidOrNull(input.context.principalId), now]
      );
      const release = result.rows[0]!;
      await client.query(
        `INSERT INTO navocms.release_previews (
           id, tenant_id, site_id, release_id, token_hash, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), input.context.site.tenantId, input.context.site.siteId,
          release.id, input.previewTokenHash, input.previewExpiresAt]
      );
      if (release.status === "previewed") {
        await writeCompletedPreviewRun(client, input.context, release.id, input.workflow, input.releaseHash, input.artifact.hash);
      }
      return toRelease(release);
    });
  }

  public async resolvePreview(tokenHash: string): Promise<PreviewDocument | undefined> {
    return this.#database.withScope({
      tenantId: "00000000-0000-4000-8000-000000000000",
      siteId: "00000000-0000-4000-8000-000000000000",
      principalId: "00000000-0000-4000-8000-000000000000"
    }, async (client) => {
      const row = (await client.query<PreviewRow>(
        "SELECT media_type, body, release_hash, artifact_hash, expires_at FROM navocms.resolve_release_preview($1)",
        [tokenHash]
      )).rows[0];
      return row ? Object.freeze({
        mediaType: row.media_type,
        body: row.body,
        releaseHash: row.release_hash,
        artifactHash: row.artifact_hash,
        expiresAt: iso(row.expires_at)
      }) : undefined;
    });
  }

  public async getRelease(context: RepositoryContext, releaseId: string): Promise<StoredRelease> {
    return this.#database.withScope(databaseScope(context), async (client) => toRelease(await requireRelease(client, context, releaseId)));
  }

  public async approve(context: RepositoryContext, releaseId: string, releaseHash: string, approval: ReleaseApprovalInput): Promise<StoredRelease> {
    return this.#database.withScope(databaseScope(context), async (client) => {
      const release = await requireExactRelease(client, context, releaseId, releaseHash, true);
      if (approval.actorKind !== "human" || approval.scope.tenantId !== context.site.tenantId ||
        approval.scope.siteId !== context.site.siteId || approval.scope.environmentId !== release.environment_id ||
        new Date(approval.expiresAt).getTime() <= Date.now() || !isUuid(context.principalId)) {
        throw new McpEditingError("RELEASE_APPROVAL_INVALID", "Approval must be current, human, and scoped to this exact release");
      }
      if (release.status !== "approved") {
        releaseTransition(release.status, "approved");
        await client.query(
          `UPDATE navocms.release_candidates SET status = 'approved', updated_at = now()
            WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
          [context.site.tenantId, context.site.siteId, releaseId]
        );
        await client.query(
          `INSERT INTO navocms.release_approvals (
             id, tenant_id, site_id, release_id, release_hash, approved_by,
             actor_kind, policy_version, evidence_json, scope_json, expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6,'human',$7,$8::jsonb,$9::jsonb,$10) ON CONFLICT DO NOTHING`,
          [randomUUID(), context.site.tenantId, context.site.siteId, releaseId, releaseHash,
            uuidOrNull(context.principalId), approval.policyVersion, JSON.stringify(approval.evidence),
            JSON.stringify(approval.scope), approval.expiresAt]
        );
      }
      return toRelease(await requireRelease(client, context, releaseId, false, true));
    });
  }

  public async beginPublication(context: RepositoryContext, releaseId: string, releaseHash: string) {
    return this.#database.withScope(databaseScope(context), async (client) => {
      const release = await requireExactRelease(client, context, releaseId, releaseHash, true);
      await requireCurrentHumanApproval(client, context, release);
      if (release.status !== "publishing") {
        releaseTransition(release.status, "publishing");
        await client.query(
          `UPDATE navocms.release_candidates SET status = 'publishing', updated_at = now()
            WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
          [context.site.tenantId, context.site.siteId, releaseId]
        );
        await writePublishingRun(client, context, release);
      }
      const previous = await activePublication(client, context, release.environment_id);
      return Object.freeze({
        release: toRelease(await requireRelease(client, context, releaseId)),
        ...(previous ? { previous: toPublication(previous) } : {})
      });
    });
  }

  public async completePublication(context: RepositoryContext, releaseId: string, publication: ReleaseProviderPublication): Promise<PublicationRecord> {
    return this.#database.withScope(databaseScope(context), async (client) => {
      const release = await requireRelease(client, context, releaseId, true);
      if (release.status !== "publishing") throw new McpEditingError("RELEASE_NOT_PUBLISHING", "Release is not awaiting provider completion");
      if (publication.artifactHash !== release.artifact_hash) throw new McpEditingError("ARTIFACT_HASH_MISMATCH", "Provider applied an artifact that was not previewed");
      const previous = await activePublication(client, context, release.environment_id);
      if (previous) {
        await client.query(
          `UPDATE navocms.release_publications SET status = 'superseded'
            WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
          [context.site.tenantId, context.site.siteId, previous.id]
        );
      }
      const publicationId = randomUUID();
      const row = (await client.query<PublicationRow>(
        `INSERT INTO navocms.release_publications (
           id, tenant_id, site_id, environment_id, release_id, artifact_hash,
           provider_key, provider_reference, previous_publication_id, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'applied')
         RETURNING id, release_id, environment_id, artifact_hash, provider_key,
                   provider_reference, previous_publication_id, status`,
        [publicationId, context.site.tenantId, context.site.siteId, release.environment_id,
          releaseId, publication.artifactHash, publication.providerKey,
          publication.providerReference, previous?.id ?? null]
      )).rows[0]!;
      await writeCheckpoint(client, context, releaseId, "provider.applied", sha256(publication.providerReference), {
        publicationId, artifactHash: publication.artifactHash, providerKey: publication.providerKey
      });
      return toPublication(row);
    });
  }

  public async markVerificationFailed(context: RepositoryContext, releaseId: string, publicationId: string): Promise<void> {
    await this.#database.withScope(databaseScope(context), async (client) => {
      const release = await requireRelease(client, context, releaseId, true);
      releaseTransition(release.status, "verification_failed");
      await client.query(
        `UPDATE navocms.release_candidates SET status = 'verification_failed', updated_at = now()
          WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
        [context.site.tenantId, context.site.siteId, releaseId]
      );
      await client.query(
        `UPDATE navocms.release_publications SET status = 'verification_failed'
          WHERE tenant_id = $1 AND site_id = $2 AND id = $3 AND release_id = $4`,
        [context.site.tenantId, context.site.siteId, publicationId, releaseId]
      );
      await failRun(client, context, releaseId, "LIVE_VERIFICATION_FAILED");
    });
  }

  public async markVerified(context: RepositoryContext, releaseId: string, publicationId: string): Promise<StoredRelease> {
    return this.#database.withScope(databaseScope(context), async (client) => {
      const release = await requireRelease(client, context, releaseId, true);
      releaseTransition(release.status, "published");
      await client.query(
        `UPDATE navocms.release_candidates SET status = 'published', updated_at = now()
          WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
        [context.site.tenantId, context.site.siteId, releaseId]
      );
      await client.query(
        `UPDATE navocms.release_publications SET status = 'verified', verified_at = now()
          WHERE tenant_id = $1 AND site_id = $2 AND id = $3 AND release_id = $4`,
        [context.site.tenantId, context.site.siteId, publicationId, releaseId]
      );
      await writeCheckpoint(client, context, releaseId, "live.verified", release.artifact_hash, { publicationId });
      await succeedRun(client, context, releaseId);
      return toRelease(await requireRelease(client, context, releaseId, false, true));
    });
  }

  public async reconcile(context: RepositoryContext, releaseId: string) {
    return this.#database.withScope(databaseScope(context), async (client) => {
      const release = await requireRelease(client, context, releaseId);
      const publication = (await client.query<PublicationRow>(
        `${publicationSelect()} WHERE p.tenant_id = $1 AND p.site_id = $2 AND p.release_id = $3
          ORDER BY p.applied_at DESC LIMIT 1`,
        [context.site.tenantId, context.site.siteId, releaseId]
      )).rows[0];
      return Object.freeze({ release: toRelease(release), ...(publication ? { publication: toPublication(publication) } : {}) });
    });
  }

  public async rollback(context: RepositoryContext, releaseId: string, releaseHash: string) {
    return this.#database.withScope(databaseScope(context), async (client) => {
      const release = await requireExactRelease(client, context, releaseId, releaseHash, true);
      if (release.status !== "published" && release.status !== "verification_failed") {
        throw new McpEditingError("ROLLBACK_NOT_AVAILABLE", "Only an applied release can be rolled back");
      }
      const current = (await client.query<PublicationRow>(
        `${publicationSelect()} WHERE p.tenant_id = $1 AND p.site_id = $2 AND p.release_id = $3
          AND p.status IN ('applied','verified','verification_failed') ORDER BY p.applied_at DESC LIMIT 1`,
        [context.site.tenantId, context.site.siteId, releaseId]
      )).rows[0];
      if (!current?.previous_publication_id) throw new McpEditingError("ROLLBACK_TARGET_MISSING", "No previous verified publication is available");
      const target = (await client.query<PublicationRow>(
        `${publicationSelect()} WHERE p.tenant_id = $1 AND p.site_id = $2 AND p.id = $3`,
        [context.site.tenantId, context.site.siteId, current.previous_publication_id]
      )).rows[0];
      if (!target) throw new McpEditingError("ROLLBACK_TARGET_MISSING", "Previous publication no longer exists");
      return Object.freeze({ release: toRelease(release), current: toPublication(current), target: toPublication(target) });
    });
  }

  public async completeRollback(context: RepositoryContext, releaseId: string, currentPublicationId: string, targetPublicationId: string): Promise<StoredRelease> {
    return this.#database.withScope(databaseScope(context), async (client) => {
      const release = await requireRelease(client, context, releaseId, true);
      releaseTransition(release.status, "rolled_back");
      const current = (await client.query<PublicationRow>(
        `${publicationSelect()} WHERE p.tenant_id = $1 AND p.site_id = $2 AND p.id = $3 AND p.release_id = $4 FOR UPDATE`,
        [context.site.tenantId, context.site.siteId, currentPublicationId, releaseId]
      )).rows[0];
      if (!current || current.previous_publication_id !== targetPublicationId) throw new McpEditingError("ROLLBACK_TARGET_MISMATCH", "Rollback target changed");
      await client.query(
        `UPDATE navocms.release_publications SET status = 'rolled_back', rolled_back_at = now()
          WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
        [context.site.tenantId, context.site.siteId, currentPublicationId]
      );
      await client.query(
        `UPDATE navocms.release_publications SET status = 'verified', verified_at = coalesce(verified_at, now())
          WHERE tenant_id = $1 AND site_id = $2 AND id = $3 AND status = 'superseded'`,
        [context.site.tenantId, context.site.siteId, targetPublicationId]
      );
      await client.query(
        `UPDATE navocms.release_candidates SET status = 'rolled_back', updated_at = now()
          WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
        [context.site.tenantId, context.site.siteId, releaseId]
      );
      return toRelease(await requireRelease(client, context, releaseId, false, true));
    });
  }
}

async function requireEnvironment(client: SqlClient, context: RepositoryContext, environmentKey: string): Promise<string> {
  const kind = environmentKey === "production" ? "production" : environmentKey === "staging" ? "staging" : "development";
  const row = (await client.query<{ id: string }>(
    `SELECT id FROM navocms.environments
      WHERE tenant_id = $1 AND site_id = $2 AND kind = $3 AND environment_key = 'default'`,
    [context.site.tenantId, context.site.siteId, kind]
  )).rows[0];
  if (!row) throw new McpEditingError("ENVIRONMENT_NOT_REGISTERED", "Release environment is not registered");
  return row.id;
}

async function requireRelease(client: SqlClient, context: RepositoryContext, releaseId: string, lock = false, withTimes = false): Promise<ReleaseRow> {
  if (!isUuid(releaseId)) throw new McpEditingError("RELEASE_NOT_FOUND", "Release was not found in the authorized site");
  const row = (await client.query<ReleaseRow>(
    `SELECT c.id, c.environment_id, c.revision_id, c.workflow_key, c.release_hash,
            c.artifact_hash, c.correlation_id, c.manifest_json, c.artifact_json, c.status,
            c.created_at, c.updated_at
            ${withTimes ? ", a.approved_at, p.verified_at AS published_at" : ""}
       FROM navocms.release_candidates c
       ${withTimes ? "LEFT JOIN LATERAL (SELECT max(approved_at) AS approved_at FROM navocms.release_approvals WHERE tenant_id=c.tenant_id AND site_id=c.site_id AND release_id=c.id AND revoked_at IS NULL) a ON true LEFT JOIN LATERAL (SELECT max(verified_at) AS verified_at FROM navocms.release_publications WHERE tenant_id=c.tenant_id AND site_id=c.site_id AND release_id=c.id) p ON true" : ""}
      WHERE c.tenant_id = $1 AND c.site_id = $2 AND c.id = $3${lock ? " FOR UPDATE OF c" : ""}`,
    [context.site.tenantId, context.site.siteId, releaseId]
  )).rows[0];
  if (!row) throw new McpEditingError("RELEASE_NOT_FOUND", "Release was not found in the authorized site");
  return row;
}

async function requireExactRelease(client: SqlClient, context: RepositoryContext, releaseId: string, releaseHash: string, lock = false): Promise<ReleaseRow> {
  const release = await requireRelease(client, context, releaseId, lock);
  if (release.release_hash !== releaseHash) throw new McpEditingError("STALE_RELEASE_APPROVAL", "Release hash does not match the previewed candidate");
  return release;
}

async function requireCurrentHumanApproval(client: SqlClient, context: RepositoryContext, release: ReleaseRow): Promise<void> {
  const approval = (await client.query<{ present: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM navocms.release_approvals
        WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND release_hash = $4
          AND actor_kind = 'human' AND revoked_at IS NULL AND expires_at > now()
          AND scope_json->>'environmentId' = $5
     ) AS present`,
    [context.site.tenantId, context.site.siteId, release.id, release.release_hash, release.environment_id]
  )).rows[0];
  if (!approval?.present) {
    throw new McpEditingError("RELEASE_APPROVAL_EXPIRED", "A current human approval is required before publication");
  }
}

async function activePublication(client: SqlClient, context: RepositoryContext, environmentId: string): Promise<PublicationRow | undefined> {
  return (await client.query<PublicationRow>(
    `${publicationSelect()} WHERE p.tenant_id = $1 AND p.site_id = $2 AND p.environment_id = $3
      AND p.status IN ('applied','verified','verification_failed') ORDER BY p.applied_at DESC LIMIT 1`,
    [context.site.tenantId, context.site.siteId, environmentId]
  )).rows[0];
}

function publicationSelect(): string {
  return `SELECT p.id, p.release_id, p.environment_id, p.artifact_hash, p.provider_key,
                 p.provider_reference, p.previous_publication_id, p.status
            FROM navocms.release_publications p`;
}

async function writeCompletedPreviewRun(client: SqlClient, context: RepositoryContext, releaseId: string, workflow: string, releaseHash: string, artifactHash: string): Promise<void> {
  const runId = randomUUID();
  await client.query(
    `INSERT INTO navocms.workflow_runs (
       id, tenant_id, site_id, release_id, workflow_key, status, current_step, completed_at
     ) VALUES ($1,$2,$3,$4,$5,'succeeded','preview.ready',now())`,
    [runId, context.site.tenantId, context.site.siteId, releaseId, workflow]
  );
  await insertCheckpoint(client, context, runId, "manifest.assembled", releaseHash, { releaseHash });
  await insertCheckpoint(client, context, runId, "preview.artifact.created", artifactHash, { artifactHash });
}

async function writePublishingRun(client: SqlClient, context: RepositoryContext, release: ReleaseRow): Promise<void> {
  const runId = randomUUID();
  await client.query(
    `INSERT INTO navocms.workflow_runs (
       id, tenant_id, site_id, release_id, workflow_key, status, current_step
     ) VALUES ($1,$2,$3,$4,$5,'running','provider.publish')`,
    [runId, context.site.tenantId, context.site.siteId, release.id, release.workflow_key]
  );
  await insertCheckpoint(client, context, runId, "approval.validated", release.release_hash, { releaseHash: release.release_hash });
}

async function writeCheckpoint(client: SqlClient, context: RepositoryContext, releaseId: string, step: string, inputHash: string, output: object): Promise<void> {
  let run = (await client.query<{ id: string }>(
    `SELECT id FROM navocms.workflow_runs
      WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND status = 'running'
      ORDER BY started_at DESC LIMIT 1`,
    [context.site.tenantId, context.site.siteId, releaseId]
  )).rows[0];
  if (!run) {
    const release = (await client.query<{ workflow_key: string }>(
      `SELECT workflow_key FROM navocms.release_candidates
        WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
      [context.site.tenantId, context.site.siteId, releaseId]
    )).rows[0];
    if (!release) throw new McpEditingError("WORKFLOW_RUN_MISSING", "Durable publication workflow is missing");
    run = { id: randomUUID() };
    await client.query(
      `INSERT INTO navocms.workflow_runs (
         id, tenant_id, site_id, release_id, workflow_key, status, current_step
       ) VALUES ($1,$2,$3,$4,$5,'running','reconciliation.verify')`,
      [run.id, context.site.tenantId, context.site.siteId, releaseId, release.workflow_key]
    );
  }
  await insertCheckpoint(client, context, run.id, step, inputHash, output);
}

async function insertCheckpoint(client: SqlClient, context: RepositoryContext, runId: string, step: string, inputHash: string, output: object): Promise<void> {
  await client.query(
    `INSERT INTO navocms.workflow_checkpoints (
       id, tenant_id, site_id, run_id, step_key, input_hash, output_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
    [randomUUID(), context.site.tenantId, context.site.siteId, runId, step, inputHash, JSON.stringify(output)]
  );
}

async function succeedRun(client: SqlClient, context: RepositoryContext, releaseId: string): Promise<void> {
  await client.query(
    `UPDATE navocms.workflow_runs SET status = 'succeeded', current_step = 'live.verified', completed_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND status = 'running'`,
    [context.site.tenantId, context.site.siteId, releaseId]
  );
}

async function failRun(client: SqlClient, context: RepositoryContext, releaseId: string, errorCode: string): Promise<void> {
  await client.query(
    `UPDATE navocms.workflow_runs SET status = 'failed', current_step = 'live.verification_failed',
            last_error_code = $4, completed_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND site_id = $2 AND release_id = $3 AND status = 'running'`,
    [context.site.tenantId, context.site.siteId, releaseId, errorCode]
  );
}

function toRelease(row: ReleaseRow): StoredRelease {
  return Object.freeze({
    id: row.id,
    environmentId: row.environment_id,
    revisionId: row.revision_id,
    workflow: row.workflow_key,
    releaseHash: row.release_hash,
    artifactHash: row.artifact_hash,
    correlationId: row.correlation_id,
    status: row.status,
    manifest: Object.freeze(row.manifest_json),
    artifact: Object.freeze(row.artifact_json),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.approved_at ? { approvedAt: iso(row.approved_at) } : {}),
    ...(row.published_at ? { publishedAt: iso(row.published_at) } : {})
  });
}

function toPublication(row: PublicationRow): PublicationRecord {
  return Object.freeze({
    id: row.id,
    releaseId: row.release_id,
    environmentId: row.environment_id,
    artifactHash: row.artifact_hash,
    providerKey: row.provider_key,
    providerReference: row.provider_reference,
    status: row.status,
    ...(row.previous_publication_id ? { previousPublicationId: row.previous_publication_id } : {})
  });
}

function databaseScope(context: RepositoryContext) {
  return { tenantId: context.site.tenantId, siteId: context.site.siteId, principalId: context.principalId };
}

function uuidOrNull(value: string): string | null {
  return isUuid(value) ? value : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
