import { ASTRO_BUILT_OUTPUT_LIMITS, ASTRO_RENDER_LIMITS, verifyAstroArtifact, verifyBuiltAstroOutput, type AstroArtifact } from "@navocms/design-astro";
import { DomainEventFactory, sha256, type EventStore } from "@navocms/kernel";
import { PostgresEventStore, PostgresIdempotencyStore, type PostgresDatabase, type SqlClient } from "@navocms/persistence-postgres";
import { requirePermission } from "@navocms/security";

import { McpEditingError } from "./errors.js";
import type { McpRequestContext } from "./model.js";
import type { RepositoryContext } from "./repository.js";
import type { ReviewedAstroArtifactRecord, ReviewedAstroArtifactStore } from "./reviewed-astro-resolver.js";

const REGISTRATION_OPERATION = "reviewed_astro_artifact.register.v1";
const MAX_IDEMPOTENCY_KEY_BYTES = 128;

export interface ReviewedAstroArtifactAuthority {
  readonly tenantId: string;
  readonly siteId: string;
  readonly principal: Readonly<{ id: string; kind: "human" | "agent" | "service" }>;
}

export type RegisterReviewedAstroArtifactInput = Omit<ReviewedAstroArtifactRecord, "tenantId" | "siteId" | "environment" | "environmentKey"> & Readonly<{
  idempotencyKey: string;
}>;

interface ReleaseBindingRow extends Record<string, unknown> {
  readonly environment_id: string;
  readonly correlation_id: string;
}

interface StoredArtifactRow extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly site_id: string;
  readonly environment_key: string;
  readonly release_id: string;
  readonly release_hash: string;
  readonly artifact_hash: string;
  readonly astro_artifact_hash: string;
  readonly source_commit_sha: string;
  readonly artifact_json: unknown;
  readonly output_json: unknown;
}

/** Derives Ledger authority from a verified request, never from tool input. */
export function reviewedAstroArtifactAuthority(context: McpRequestContext): ReviewedAstroArtifactAuthority {
  requirePermission(context.authorization, "content:publish", {
    tenantId: context.authorization.tenantId,
    siteId: context.authorization.siteId
  });
  return Object.freeze({
    tenantId: context.authorization.tenantId,
    siteId: context.authorization.siteId,
    principal: Object.freeze({ id: context.authorization.principal.id, kind: context.authorization.principal.kind })
  });
}

/** Durable append-only registration and scoped lookup for reviewed Astro bundles. */
export class PostgresReviewedAstroArtifactStore implements ReviewedAstroArtifactStore {
  readonly #database: PostgresDatabase;
  readonly #context: RepositoryContext;
  readonly #environmentKey: string;
  readonly #events: EventStore;
  readonly #idempotency: PostgresIdempotencyStore;

  public constructor(database: PostgresDatabase, context: RepositoryContext, environmentKey: string, options: Readonly<{ events?: EventStore }> = {}) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(environmentKey)) {
      throw new McpEditingError("REVIEWED_ASTRO_ENVIRONMENT_INVALID", "Reviewed Astro environment key is invalid");
    }
    this.#database = database;
    this.#context = context;
    this.#environmentKey = environmentKey;
    this.#events = options.events ?? new PostgresEventStore(database);
    this.#idempotency = new PostgresIdempotencyStore(database);
  }

  /** Schema/RLS/scope readiness deliberately does not require a release record. */
  public async ready(): Promise<boolean> {
    try {
      if (!await this.#database.ready()) return false;
      return await this.#database.withScope(scope(this.#context), async (client) => {
        const table = (await client.query<{
          table_exists: boolean;
          rls: boolean;
          forced: boolean;
          exact_policy: boolean;
          can_select: boolean;
          can_insert: boolean;
          can_update: boolean;
          can_delete: boolean;
        }>(
          `SELECT to_regclass('navocms.reviewed_astro_artifacts') IS NOT NULL AS table_exists,
                  c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                  COALESCE((
                    SELECT count(*) = 1 AND bool_and(
                      p.polname = 'site_scope'
                      AND p.polcmd = '*'
                      AND p.polpermissive
                      AND array_length(p.polroles, 1) = 1
                      AND EXISTS (SELECT 1 FROM pg_roles role WHERE role.oid = p.polroles[1] AND role.rolname = 'navocms_app')
                      AND regexp_replace(pg_get_expr(p.polqual, p.polrelid), '[[:space:]()]', '', 'g') = 'tenant_id=current_tenant_idANDsite_id=current_site_id'
                      AND regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '[[:space:]()]', '', 'g') = 'tenant_id=current_tenant_idANDsite_id=current_site_id'
                    ) FROM pg_policy p WHERE p.polrelid = c.oid
                  ), false) AS exact_policy,
                  has_table_privilege(current_user, 'navocms.reviewed_astro_artifacts', 'SELECT') AS can_select,
                  has_table_privilege(current_user, 'navocms.reviewed_astro_artifacts', 'INSERT') AS can_insert,
                  has_table_privilege(current_user, 'navocms.reviewed_astro_artifacts', 'UPDATE') AS can_update,
                  has_table_privilege(current_user, 'navocms.reviewed_astro_artifacts', 'DELETE') AS can_delete
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'navocms' AND c.relname = 'reviewed_astro_artifacts'`
        )).rows[0];
        if (!table?.table_exists || !table.rls || !table.forced || !table.exact_policy ||
          !table.can_select || !table.can_insert || table.can_update || table.can_delete) return false;
        const environment = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM navocms.environments
              WHERE tenant_id = $1 AND site_id = $2 AND kind = 'staging' AND environment_key = $3
           ) AS exists`,
          [this.#context.site.tenantId, this.#context.site.siteId, this.#environmentKey]
        );
        return environment.rows[0]?.exists === true;
      });
    } catch {
      return false;
    }
  }

  public async register(input: RegisterReviewedAstroArtifactInput, authority: ReviewedAstroArtifactAuthority): Promise<ReviewedAstroArtifactRecord> {
    assertRegistration(input, this.#context.site);
    assertAuthority(authority, this.#context);
    const databaseScope = scope(this.#context);
    const fingerprint = registrationFingerprint(input);
    const eventIdempotencyKey = `${REGISTRATION_OPERATION}:${input.idempotencyKey}`;

    return this.#database.withScope(databaseScope, async (client) => {
      const binding = await requireExactRelease(client, this.#context, this.#environmentKey, input);
      let reservation;
      try {
        reservation = await this.#idempotency.reserve<ReviewedAstroArtifactRecord>(databaseScope, REGISTRATION_OPERATION, input.idempotencyKey, fingerprint);
      } catch (error) {
        if (error instanceof Error && error.message === "IDEMPOTENCY_KEY_REUSED") {
          throw new McpEditingError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with different input");
        }
        throw error;
      }
      if (reservation.status === "completed") {
        const replay = persistedRecord(reservation.value);
        if (replay.tenantId !== this.#context.site.tenantId || replay.siteId !== this.#context.site.siteId || replay.environmentKey !== this.#environmentKey) {
          throw new McpEditingError("REVIEWED_ASTRO_IDEMPOTENCY_CORRUPT", "Reviewed Astro idempotency result is outside its scope");
        }
        return replay;
      }
      if (reservation.status !== "reserved") {
        throw new McpEditingError("REVIEWED_ASTRO_IDEMPOTENCY_PENDING", "Reviewed artifact registration is pending");
      }

      const inserted = await client.query(
        `INSERT INTO navocms.reviewed_astro_artifacts (
           tenant_id, site_id, environment_id, environment_key, release_id, release_hash,
           artifact_hash, astro_artifact_hash, source_commit_sha, artifact_json, output_json
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) ON CONFLICT DO NOTHING`,
        [this.#context.site.tenantId, this.#context.site.siteId, binding.environment_id, this.#environmentKey,
          input.releaseId, input.releaseHash, input.releaseArtifactHash, input.expectedAstroArtifactHash,
          input.sourceCommitSha, JSON.stringify(input.artifact), JSON.stringify(input.output)]
      );
      const record = (inserted.rowCount ?? 0) === 1
        ? freezeRecord({ tenantId: this.#context.site.tenantId, siteId: this.#context.site.siteId,
          environment: "staging", environmentKey: this.#environmentKey, releaseId: input.releaseId,
          releaseHash: input.releaseHash, releaseArtifactHash: input.releaseArtifactHash,
          expectedAstroArtifactHash: input.expectedAstroArtifactHash, sourceCommitSha: input.sourceCommitSha,
          artifact: input.artifact, output: input.output })
        : await requireStoredRecord(client, this.#context, this.#environmentKey, input.releaseId);
      if (!sameRegistration(record, input)) {
        throw new McpEditingError("REVIEWED_ASTRO_ARTIFACT_DRIFT", "A different reviewed Astro artifact already exists for this release");
      }
      if ((inserted.rowCount ?? 0) === 1) {
        const factory = new DomainEventFactory({ source: "urn:navocms:mcp", tenantId: this.#context.site.tenantId,
          siteId: this.#context.site.siteId, correlationId: binding.correlation_id,
          actor: { id: authority.principal.id, type: authority.principal.kind } });
        await this.#events.append(factory.create({
          type: "io.navocms.release.astro-artifact-registered.v1", subject: `release:${input.releaseId}`,
          consequence: "G1", idempotencyKey: eventIdempotencyKey,
          data: Object.freeze({ environment: "staging", environmentKey: this.#environmentKey,
            releaseId: input.releaseId, releaseHash: input.releaseHash,
            releaseArtifactHash: input.releaseArtifactHash, astroArtifactHash: input.expectedAstroArtifactHash })
        }));
      }
      await this.#idempotency.complete(databaseScope, REGISTRATION_OPERATION, input.idempotencyKey, fingerprint, record);
      return record;
    });
  }

  public async get(scopeInput: Readonly<{ tenantId: string; siteId: string; environment: "staging"; environmentKey: string; releaseId: string }>): Promise<ReviewedAstroArtifactRecord | undefined> {
    if (scopeInput.tenantId !== this.#context.site.tenantId || scopeInput.siteId !== this.#context.site.siteId ||
      scopeInput.environment !== "staging" || scopeInput.environmentKey !== this.#environmentKey) {
      throw new McpEditingError("REVIEWED_ASTRO_SCOPE_DENIED", "Reviewed Astro artifact scope is denied");
    }
    return this.#database.withScope(scope(this.#context), async (client) => findStoredRecord(client, this.#context, this.#environmentKey, scopeInput.releaseId));
  }
}

function scope(context: RepositoryContext) {
  return { tenantId: context.site.tenantId, siteId: context.site.siteId, principalId: context.principalId };
}

function assertAuthority(authority: ReviewedAstroArtifactAuthority, context: RepositoryContext): void {
  if (authority.tenantId !== context.site.tenantId || authority.siteId !== context.site.siteId || authority.principal.id !== context.principalId) {
    throw new McpEditingError("REVIEWED_ASTRO_AUTHORITY_DENIED", "Reviewed Astro registration authority does not match its database scope");
  }
}

function assertRegistration(input: RegisterReviewedAstroArtifactInput, site: Readonly<{ tenantId: string; siteId: string }>): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey) || Buffer.byteLength(input.idempotencyKey, "utf8") > MAX_IDEMPOTENCY_KEY_BYTES ||
    !uuid(input.releaseId) || !hash(input.releaseHash) || !hash(input.releaseArtifactHash) || !/^sha256:[a-f0-9]{64}$/.test(input.expectedAstroArtifactHash) || !commit(input.sourceCommitSha)) {
    throw new McpEditingError("REVIEWED_ASTRO_INPUT_INVALID", "Reviewed Astro registration input is invalid");
  }
  try {
    verifyAstroArtifact(input.artifact, input.expectedAstroArtifactHash);
    verifyBuiltAstroOutput(input.output, input.artifact, input.expectedAstroArtifactHash);
    if (input.artifact.manifest.tenantId !== site.tenantId || input.artifact.manifest.siteId !== site.siteId ||
      Object.keys(input.artifact.files).length > ASTRO_RENDER_LIMITS.files ||
      Object.values(input.artifact.files).reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) > ASTRO_RENDER_LIMITS.bundleBytes ||
      Object.keys(input.output).length > ASTRO_BUILT_OUTPUT_LIMITS.files ||
      Object.values(input.output).reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) > ASTRO_BUILT_OUTPUT_LIMITS.bytes) {
      throw new Error("bounds or artifact scope mismatch");
    }
  } catch {
    throw new McpEditingError("REVIEWED_ASTRO_ARTIFACT_INVALID", "Reviewed Astro source or output is invalid");
  }
}

function registrationFingerprint(input: RegisterReviewedAstroArtifactInput): string {
  return sha256(canonical({ operation: REGISTRATION_OPERATION, releaseId: input.releaseId, releaseHash: input.releaseHash,
    releaseArtifactHash: input.releaseArtifactHash, expectedAstroArtifactHash: input.expectedAstroArtifactHash,
    sourceCommitSha: input.sourceCommitSha, artifact: input.artifact, output: input.output }));
}

async function requireExactRelease(client: SqlClient, context: RepositoryContext, environmentKey: string, input: RegisterReviewedAstroArtifactInput): Promise<ReleaseBindingRow> {
  const row = (await client.query<ReleaseBindingRow>(
    `SELECT r.environment_id, r.correlation_id
       FROM navocms.release_candidates r
       JOIN navocms.environments e ON e.tenant_id = r.tenant_id AND e.site_id = r.site_id
        AND e.id = r.environment_id AND e.kind = 'staging'
      WHERE r.tenant_id = $1 AND r.site_id = $2 AND r.id = $3
        AND r.release_hash = $4 AND r.artifact_hash = $5 AND e.environment_key = $6`,
    [context.site.tenantId, context.site.siteId, input.releaseId, input.releaseHash, input.releaseArtifactHash, environmentKey]
  )).rows[0];
  if (!row) throw new McpEditingError("REVIEWED_ASTRO_RELEASE_BINDING_MISMATCH", "Reviewed Astro record does not match an authorized staging release");
  return row;
}

async function findStoredRecord(client: SqlClient, context: RepositoryContext, environmentKey: string, releaseId: string): Promise<ReviewedAstroArtifactRecord | undefined> {
  const row = (await client.query<StoredArtifactRow>(
    `SELECT a.tenant_id, a.site_id, a.environment_key, a.release_id, a.release_hash,
            a.artifact_hash, a.astro_artifact_hash, a.source_commit_sha, a.artifact_json, a.output_json
       FROM navocms.reviewed_astro_artifacts a
       JOIN navocms.environments e ON e.tenant_id = a.tenant_id AND e.site_id = a.site_id
        AND e.id = a.environment_id AND e.environment_key = a.environment_key AND e.kind = 'staging'
       JOIN navocms.release_candidates r ON r.tenant_id = a.tenant_id AND r.site_id = a.site_id
        AND r.id = a.release_id AND r.environment_id = a.environment_id
        AND r.release_hash = a.release_hash AND r.artifact_hash = a.artifact_hash
      WHERE a.tenant_id = $1 AND a.site_id = $2 AND a.environment_key = $3 AND a.release_id = $4`,
    [context.site.tenantId, context.site.siteId, environmentKey, releaseId]
  )).rows[0];
  return row ? rowToRecord(row) : undefined;
}

async function requireStoredRecord(client: SqlClient, context: RepositoryContext, environmentKey: string, releaseId: string): Promise<ReviewedAstroArtifactRecord> {
  const record = await findStoredRecord(client, context, environmentKey, releaseId);
  if (!record) throw new McpEditingError("REVIEWED_ASTRO_ARTIFACT_MISSING", "Reviewed Astro artifact disappeared during registration");
  return record;
}

function rowToRecord(row: StoredArtifactRow): ReviewedAstroArtifactRecord {
  return freezeRecord({ tenantId: row.tenant_id, siteId: row.site_id, environment: "staging",
    environmentKey: row.environment_key, releaseId: row.release_id, releaseHash: row.release_hash,
    releaseArtifactHash: row.artifact_hash, expectedAstroArtifactHash: row.astro_artifact_hash,
    sourceCommitSha: row.source_commit_sha, artifact: row.artifact_json as AstroArtifact,
    output: row.output_json as Readonly<Record<string, string>> });
}

function persistedRecord(value: unknown): ReviewedAstroArtifactRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpEditingError("REVIEWED_ASTRO_IDEMPOTENCY_CORRUPT", "Reviewed Astro idempotency result is invalid");
  }
  const record = value as ReviewedAstroArtifactRecord;
  try {
    assertRegistration({ releaseId: record.releaseId, releaseHash: record.releaseHash,
      releaseArtifactHash: record.releaseArtifactHash, expectedAstroArtifactHash: record.expectedAstroArtifactHash,
      sourceCommitSha: record.sourceCommitSha, artifact: record.artifact, output: record.output,
      idempotencyKey: "persisted-reviewed-astro-record" }, { tenantId: record.tenantId, siteId: record.siteId });
    if (record.environment !== "staging" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(record.environmentKey)) throw new Error("environment invalid");
  } catch {
    throw new McpEditingError("REVIEWED_ASTRO_IDEMPOTENCY_CORRUPT", "Reviewed Astro idempotency result is invalid");
  }
  return freezeRecord(record);
}

function sameRegistration(record: ReviewedAstroArtifactRecord, input: RegisterReviewedAstroArtifactInput): boolean {
  return record.releaseId === input.releaseId && record.releaseHash === input.releaseHash &&
    record.releaseArtifactHash === input.releaseArtifactHash && record.expectedAstroArtifactHash === input.expectedAstroArtifactHash &&
    record.sourceCommitSha === input.sourceCommitSha && canonical(record.artifact) === canonical(input.artifact) &&
    canonical(record.output) === canonical(input.output);
}

function freezeRecord(record: ReviewedAstroArtifactRecord): ReviewedAstroArtifactRecord { return deepFreeze(structuredClone(record)); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as object)) deepFreeze(child); } return value; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
function hash(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function commit(value: string): boolean { return /^([a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
function uuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
