import { ASTRO_BUILT_OUTPUT_LIMITS, ASTRO_RENDER_LIMITS, verifyAstroArtifact, verifyBuiltAstroOutput, type AstroArtifact } from "@navocms/design-astro";
import { DomainEventFactory, sha256, type EventStore } from "@navocms/kernel";
import { PostgresEventStore, PostgresIdempotencyStore, type PostgresDatabase, type SqlClient } from "@navocms/persistence-postgres";
import { requirePermission } from "@navocms/security";

import { McpEditingError } from "./errors.js";
import type { McpRequestContext } from "./model.js";
import type { RepositoryContext } from "./repository.js";
import type { ReviewedAstroArtifactRecord, ReviewedAstroArtifactStore } from "./reviewed-astro-resolver.js";
import { assertReviewedAstroObjectKey, reviewedAstroObjectDigest, reviewedAstroObjectKey, type ReviewedAstroObjectStorage } from "./reviewed-astro-object-storage.js";

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

interface StoredObjectBindingRow extends Record<string, unknown> {
  readonly tenant_id: string; readonly site_id: string; readonly environment_key: string;
  readonly release_id: string; readonly release_hash: string; readonly artifact_hash: string;
  readonly astro_artifact_hash: string; readonly source_commit_sha: string;
  readonly source_object_key: string; readonly source_object_sha256: string; readonly source_object_bytes: number;
  readonly output_object_key: string; readonly output_object_sha256: string; readonly output_object_bytes: number;
  readonly state: "ready"; readonly evidence_hash: string;
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
  readonly #storage: ReviewedAstroObjectStorage | undefined;

  public constructor(database: PostgresDatabase, context: RepositoryContext, environmentKey: string, options: Readonly<{ events?: EventStore; storage?: ReviewedAstroObjectStorage }> = {}) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(environmentKey)) {
      throw new McpEditingError("REVIEWED_ASTRO_ENVIRONMENT_INVALID", "Reviewed Astro environment key is invalid");
    }
    this.#database = database;
    this.#context = context;
    this.#environmentKey = environmentKey;
    this.#events = options.events ?? new PostgresEventStore(database);
    this.#idempotency = new PostgresIdempotencyStore(database);
    this.#storage = options.storage;
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
          `SELECT to_regclass('navocms.reviewed_astro_artifact_object_bindings') IS NOT NULL AS table_exists,
                  c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                  COALESCE((
                    SELECT count(*) = 1 AND bool_and(
                      p.polname = 'site_scope'
                      AND p.polcmd = '*'
                      AND p.polpermissive
                      AND array_length(p.polroles, 1) = 1
                      AND EXISTS (SELECT 1 FROM pg_roles role WHERE role.oid = p.polroles[1] AND role.rolname = 'navocms_app')
                      AND regexp_replace(pg_get_expr(p.polqual, p.polrelid), '[[:space:]()]', '', 'g') = 'tenant_id=navocms.current_tenant_idANDsite_id=navocms.current_site_id'
                      AND regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '[[:space:]()]', '', 'g') = 'tenant_id=navocms.current_tenant_idANDsite_id=navocms.current_site_id'
                    ) FROM pg_policy p WHERE p.polrelid = c.oid
                  ), false) AS exact_policy,
                  has_table_privilege(current_user, 'navocms.reviewed_astro_artifact_object_bindings', 'SELECT') AS can_select,
                  has_table_privilege(current_user, 'navocms.reviewed_astro_artifact_object_bindings', 'INSERT') AS can_insert,
                  has_table_privilege(current_user, 'navocms.reviewed_astro_artifact_object_bindings', 'UPDATE') AS can_update,
                  has_table_privilege(current_user, 'navocms.reviewed_astro_artifact_object_bindings', 'DELETE') AS can_delete
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'navocms' AND c.relname = 'reviewed_astro_artifact_object_bindings'`
        )).rows[0];
        if (!this.#storage || !table?.table_exists || !table.rls || !table.forced || !table.exact_policy ||
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
    if (!this.#storage) throw new McpEditingError("REVIEWED_ASTRO_OBJECT_STORAGE_UNAVAILABLE", "Reviewed Astro object storage is not configured");
    const objects = storedObjects(input, this.#context.site);
    // PUT intentionally precedes the SQL transaction.  Keys are immutable and
    // content-addressed; a crash before commit leaves a bounded, scoped orphan
    // for reconciliation rather than an unprovable half-bound database row.
    try {
      await this.#storage.putImmutable(objects.source);
      await this.#storage.putImmutable(objects.output);
    } catch {
      throw new McpEditingError("REVIEWED_ASTRO_OBJECT_STORAGE_WRITE_FAILED", "Reviewed Astro object storage rejected the immutable bundle");
    }
    const databaseScope = scope(this.#context);
    const fingerprint = registrationFingerprint(input);
    const eventIdempotencyKey = `${REGISTRATION_OPERATION}:${input.idempotencyKey}`;

    const binding = await this.#database.withScope(databaseScope, async (client) => {
      const binding = await requireExactRelease(client, this.#context, this.#environmentKey, input);
      let reservation;
      try {
        reservation = await this.#idempotency.reserve<object>(databaseScope, REGISTRATION_OPERATION, input.idempotencyKey, fingerprint);
      } catch (error) {
        if (error instanceof Error && error.message === "IDEMPOTENCY_KEY_REUSED") {
          throw new McpEditingError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with different input");
        }
        throw error;
      }
      if (reservation.status === "completed") {
        const replay = persistedBinding(reservation.value, this.#context, this.#environmentKey);
        if (!sameBinding(replay, input, objects)) throw new McpEditingError("REVIEWED_ASTRO_IDEMPOTENCY_CORRUPT", "Reviewed Astro idempotency result is outside its scope");
        return replay;
      }
      if (reservation.status !== "reserved") {
        throw new McpEditingError("REVIEWED_ASTRO_IDEMPOTENCY_PENDING", "Reviewed artifact registration is pending");
      }

      const candidate = objectBinding(input, this.#context.site, this.#environmentKey, objects);
      const inserted = await client.query(
        `INSERT INTO navocms.reviewed_astro_artifact_object_bindings (
           tenant_id, site_id, environment_id, environment_key, release_id, release_hash,
           artifact_hash, astro_artifact_hash, source_commit_sha, source_object_key, source_object_sha256,
           source_object_bytes, output_object_key, output_object_sha256, output_object_bytes, state, evidence_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING`,
        [this.#context.site.tenantId, this.#context.site.siteId, binding.environment_id, this.#environmentKey,
          input.releaseId, input.releaseHash, input.releaseArtifactHash, input.expectedAstroArtifactHash,
          input.sourceCommitSha, candidate.sourceObjectKey, candidate.sourceObjectSha256, candidate.sourceObjectBytes,
          candidate.outputObjectKey, candidate.outputObjectSha256, candidate.outputObjectBytes, "ready", candidate.evidenceHash]
      );
      const stored = (inserted.rowCount ?? 0) === 1 ? candidate : await requireObjectBinding(client, this.#context, this.#environmentKey, input.releaseId);
      if (!sameBinding(stored, input, objects)) {
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
      await this.#idempotency.complete(databaseScope, REGISTRATION_OPERATION, input.idempotencyKey, fingerprint, idempotencyBinding(stored));
      return stored;
    });
    return this.loadObjectRecord(binding);
  }

  public async get(scopeInput: Readonly<{ tenantId: string; siteId: string; environment: "staging"; environmentKey: string; releaseId: string }>): Promise<ReviewedAstroArtifactRecord | undefined> {
    if (scopeInput.tenantId !== this.#context.site.tenantId || scopeInput.siteId !== this.#context.site.siteId ||
      scopeInput.environment !== "staging" || scopeInput.environmentKey !== this.#environmentKey) {
      throw new McpEditingError("REVIEWED_ASTRO_SCOPE_DENIED", "Reviewed Astro artifact scope is denied");
    }
    const result = await this.#database.withScope(scope(this.#context), async (client) => {
      const binding = await findObjectBinding(client, this.#context, this.#environmentKey, scopeInput.releaseId);
      return binding ? { binding } : { legacy: await findStoredRecord(client, this.#context, this.#environmentKey, scopeInput.releaseId) };
    });
    return result.binding ? this.loadObjectRecord(result.binding) : result.legacy;
  }

  private async loadObjectRecord(binding: ObjectBinding): Promise<ReviewedAstroArtifactRecord> {
    if (!this.#storage) throw new McpEditingError("REVIEWED_ASTRO_OBJECT_STORAGE_UNAVAILABLE", "Reviewed Astro object storage is not configured");
    try {
      assertBindingScope(binding, this.#context.site, this.#environmentKey);
      const [source, output] = await Promise.all([
        this.#storage.read(binding.sourceObjectKey, binding.sourceObjectBytes), this.#storage.read(binding.outputObjectKey, binding.outputObjectBytes)
      ]);
      if (!source || !output || source.mediaType !== "application/vnd.navocms.astro-source-bundle+json" || output.mediaType !== "application/vnd.navocms.astro-output-bundle+json" ||
        reviewedAstroObjectDigest(source.bytes) !== binding.sourceObjectSha256 || reviewedAstroObjectDigest(output.bytes) !== binding.outputObjectSha256 ||
        source.bytes.byteLength !== binding.sourceObjectBytes || output.bytes.byteLength !== binding.outputObjectBytes) throw new Error("object mismatch");
      const artifact = JSON.parse(new TextDecoder().decode(source.bytes)) as AstroArtifact;
      const built = JSON.parse(new TextDecoder().decode(output.bytes)) as Readonly<Record<string, string>>;
      verifyAstroArtifact(artifact, binding.expectedAstroArtifactHash);
      verifyBuiltAstroOutput(built, artifact, binding.expectedAstroArtifactHash);
      if (artifact.manifest.tenantId !== binding.tenantId || artifact.manifest.siteId !== binding.siteId) throw new Error("scope mismatch");
      return freezeRecord({ tenantId: binding.tenantId, siteId: binding.siteId, environment: "staging", environmentKey: binding.environmentKey,
        releaseId: binding.releaseId, releaseHash: binding.releaseHash, releaseArtifactHash: binding.releaseArtifactHash,
        expectedAstroArtifactHash: binding.expectedAstroArtifactHash, sourceCommitSha: binding.sourceCommitSha, artifact, output: built });
    } catch {
      throw new McpEditingError("REVIEWED_ASTRO_ARTIFACT_INVALID", "Reviewed Astro object bundle verification failed");
    }
  }
}

function scope(context: RepositoryContext) {
  return { tenantId: context.site.tenantId, siteId: context.site.siteId, principalId: context.principalId };
}

interface ObjectBinding {
  readonly tenantId: string; readonly siteId: string; readonly environmentKey: string;
  readonly releaseId: string; readonly releaseHash: string; readonly releaseArtifactHash: string;
  readonly expectedAstroArtifactHash: string; readonly sourceCommitSha: string;
  readonly sourceObjectKey: string; readonly sourceObjectSha256: string; readonly sourceObjectBytes: number;
  readonly outputObjectKey: string; readonly outputObjectSha256: string; readonly outputObjectBytes: number;
  readonly evidenceHash: string;
}

function storedObjects(input: RegisterReviewedAstroArtifactInput, site: Readonly<{ tenantId: string; siteId: string }>) {
  const sourceBytes = new TextEncoder().encode(canonical(input.artifact));
  const outputBytes = new TextEncoder().encode(canonical(input.output));
  const sourceDigest = reviewedAstroObjectDigest(sourceBytes); const outputDigest = reviewedAstroObjectDigest(outputBytes);
  return Object.freeze({
    source: Object.freeze({ key: reviewedAstroObjectKey(site, "source", sourceDigest), bytes: sourceBytes, mediaType: "application/vnd.navocms.astro-source-bundle+json" as const }),
    output: Object.freeze({ key: reviewedAstroObjectKey(site, "output", outputDigest), bytes: outputBytes, mediaType: "application/vnd.navocms.astro-output-bundle+json" as const })
  });
}

function objectBinding(input: RegisterReviewedAstroArtifactInput, site: Readonly<{ tenantId: string; siteId: string }>, environmentKey: string, objects: ReturnType<typeof storedObjects>): ObjectBinding {
  const binding = { tenantId: site.tenantId, siteId: site.siteId, environmentKey, releaseId: input.releaseId,
    releaseHash: input.releaseHash, releaseArtifactHash: input.releaseArtifactHash, expectedAstroArtifactHash: input.expectedAstroArtifactHash,
    sourceCommitSha: input.sourceCommitSha, sourceObjectKey: objects.source.key, sourceObjectSha256: reviewedAstroObjectDigest(objects.source.bytes), sourceObjectBytes: objects.source.bytes.byteLength,
    outputObjectKey: objects.output.key, outputObjectSha256: reviewedAstroObjectDigest(objects.output.bytes), outputObjectBytes: objects.output.bytes.byteLength };
  return Object.freeze({ ...binding, evidenceHash: bindingEvidence(binding) });
}

function bindingEvidence(binding: Omit<ObjectBinding, "evidenceHash">): string {
  return `sha256:${sha256(canonical({ tenantId: binding.tenantId, siteId: binding.siteId, environmentKey: binding.environmentKey,
    releaseId: binding.releaseId, releaseHash: binding.releaseHash, releaseArtifactHash: binding.releaseArtifactHash,
    astroArtifactHash: binding.expectedAstroArtifactHash, sourceCommitSha: binding.sourceCommitSha,
    sourceObjectKey: binding.sourceObjectKey, sourceObjectSha256: binding.sourceObjectSha256, sourceObjectBytes: binding.sourceObjectBytes,
    outputObjectKey: binding.outputObjectKey, outputObjectSha256: binding.outputObjectSha256, outputObjectBytes: binding.outputObjectBytes }))}`;
}

function idempotencyBinding(binding: ObjectBinding): object {
  return { version: 1, tenantId: binding.tenantId, siteId: binding.siteId, environmentKey: binding.environmentKey, releaseId: binding.releaseId,
    releaseHash: binding.releaseHash, releaseArtifactHash: binding.releaseArtifactHash, expectedAstroArtifactHash: binding.expectedAstroArtifactHash,
    sourceCommitSha: binding.sourceCommitSha, sourceObjectKey: binding.sourceObjectKey, sourceObjectSha256: binding.sourceObjectSha256, sourceObjectBytes: binding.sourceObjectBytes,
    outputObjectKey: binding.outputObjectKey, outputObjectSha256: binding.outputObjectSha256, outputObjectBytes: binding.outputObjectBytes, evidenceHash: binding.evidenceHash };
}

function persistedBinding(value: unknown, context: RepositoryContext, environmentKey: string): ObjectBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpEditingError("REVIEWED_ASTRO_IDEMPOTENCY_CORRUPT", "Reviewed Astro idempotency result is invalid");
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || Object.keys(row).length !== 16 || Object.keys(row).some((key) => !["version", "tenantId", "siteId", "environmentKey", "releaseId", "releaseHash", "releaseArtifactHash", "expectedAstroArtifactHash", "sourceCommitSha", "sourceObjectKey", "sourceObjectSha256", "sourceObjectBytes", "outputObjectKey", "outputObjectSha256", "outputObjectBytes", "evidenceHash"].includes(key))) throw new McpEditingError("REVIEWED_ASTRO_IDEMPOTENCY_CORRUPT", "Reviewed Astro idempotency result is invalid");
  const binding = Object.freeze({ ...row, tenantId: String(row.tenantId), siteId: String(row.siteId), environmentKey: String(row.environmentKey), releaseId: String(row.releaseId), releaseHash: String(row.releaseHash), releaseArtifactHash: String(row.releaseArtifactHash), expectedAstroArtifactHash: String(row.expectedAstroArtifactHash), sourceCommitSha: String(row.sourceCommitSha), sourceObjectKey: String(row.sourceObjectKey), sourceObjectSha256: String(row.sourceObjectSha256), sourceObjectBytes: Number(row.sourceObjectBytes), outputObjectKey: String(row.outputObjectKey), outputObjectSha256: String(row.outputObjectSha256), outputObjectBytes: Number(row.outputObjectBytes), evidenceHash: String(row.evidenceHash) }) as ObjectBinding;
  try { assertBindingScope(binding, context.site, environmentKey); } catch { throw new McpEditingError("REVIEWED_ASTRO_IDEMPOTENCY_CORRUPT", "Reviewed Astro idempotency result is invalid"); }
  return binding;
}

function sameBinding(binding: ObjectBinding, input: RegisterReviewedAstroArtifactInput, objects: ReturnType<typeof storedObjects>): boolean {
  return binding.releaseId === input.releaseId && binding.releaseHash === input.releaseHash && binding.releaseArtifactHash === input.releaseArtifactHash && binding.expectedAstroArtifactHash === input.expectedAstroArtifactHash && binding.sourceCommitSha === input.sourceCommitSha && binding.sourceObjectKey === objects.source.key && binding.sourceObjectSha256 === reviewedAstroObjectDigest(objects.source.bytes) && binding.sourceObjectBytes === objects.source.bytes.byteLength && binding.outputObjectKey === objects.output.key && binding.outputObjectSha256 === reviewedAstroObjectDigest(objects.output.bytes) && binding.outputObjectBytes === objects.output.bytes.byteLength;
}

function assertBindingScope(binding: ObjectBinding, site: Readonly<{ tenantId: string; siteId: string }>, environmentKey: string): void {
  if (binding.tenantId !== site.tenantId || binding.siteId !== site.siteId || binding.environmentKey !== environmentKey || !uuid(binding.releaseId) || !hash(binding.releaseHash) || !hash(binding.releaseArtifactHash) || !/^sha256:[a-f0-9]{64}$/.test(binding.expectedAstroArtifactHash) || !commit(binding.sourceCommitSha) || !hash(binding.sourceObjectSha256) || !hash(binding.outputObjectSha256) || !Number.isSafeInteger(binding.sourceObjectBytes) || binding.sourceObjectBytes < 2 || binding.sourceObjectBytes > 4 * 1024 * 1024 || !Number.isSafeInteger(binding.outputObjectBytes) || binding.outputObjectBytes < 2 || binding.outputObjectBytes > 16 * 1024 * 1024 || !/^sha256:[a-f0-9]{64}$/.test(binding.evidenceHash)) throw new Error("binding invalid");
  if (binding.evidenceHash !== bindingEvidence(binding)) throw new Error("binding evidence invalid");
  assertReviewedAstroObjectKey(site, "source", binding.sourceObjectKey, binding.sourceObjectSha256);
  assertReviewedAstroObjectKey(site, "output", binding.outputObjectKey, binding.outputObjectSha256);
}

function assertAuthority(authority: ReviewedAstroArtifactAuthority, context: RepositoryContext): void {
  if (authority.principal.kind !== "human" || authority.tenantId !== context.site.tenantId || authority.siteId !== context.site.siteId || authority.principal.id !== context.principalId) {
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

async function findObjectBinding(client: SqlClient, context: RepositoryContext, environmentKey: string, releaseId: string): Promise<ObjectBinding | undefined> {
  const row = (await client.query<StoredObjectBindingRow>(
    `SELECT a.tenant_id, a.site_id, a.environment_key, a.release_id, a.release_hash, a.artifact_hash,
            a.astro_artifact_hash, a.source_commit_sha, a.source_object_key, a.source_object_sha256,
            a.source_object_bytes, a.output_object_key, a.output_object_sha256, a.output_object_bytes,
            a.state, a.evidence_hash
       FROM navocms.reviewed_astro_artifact_object_bindings a
       JOIN navocms.environments e ON e.tenant_id = a.tenant_id AND e.site_id = a.site_id
        AND e.id = a.environment_id AND e.environment_key = a.environment_key AND e.kind = 'staging'
       JOIN navocms.release_candidates r ON r.tenant_id = a.tenant_id AND r.site_id = a.site_id
        AND r.id = a.release_id AND r.environment_id = a.environment_id
        AND r.release_hash = a.release_hash AND r.artifact_hash = a.artifact_hash
      WHERE a.tenant_id = $1 AND a.site_id = $2 AND a.environment_key = $3 AND a.release_id = $4 AND a.state = 'ready'`,
    [context.site.tenantId, context.site.siteId, environmentKey, releaseId]
  )).rows[0];
  if (!row) return undefined;
  const binding: ObjectBinding = Object.freeze({ tenantId: row.tenant_id, siteId: row.site_id, environmentKey: row.environment_key,
    releaseId: row.release_id, releaseHash: row.release_hash, releaseArtifactHash: row.artifact_hash, expectedAstroArtifactHash: row.astro_artifact_hash,
    sourceCommitSha: row.source_commit_sha, sourceObjectKey: row.source_object_key, sourceObjectSha256: row.source_object_sha256, sourceObjectBytes: Number(row.source_object_bytes),
    outputObjectKey: row.output_object_key, outputObjectSha256: row.output_object_sha256, outputObjectBytes: Number(row.output_object_bytes), evidenceHash: row.evidence_hash });
  try { assertBindingScope(binding, context.site, environmentKey); } catch { throw new McpEditingError("REVIEWED_ASTRO_ARTIFACT_INVALID", "Reviewed Astro object binding is invalid"); }
  return binding;
}

async function requireObjectBinding(client: SqlClient, context: RepositoryContext, environmentKey: string, releaseId: string): Promise<ObjectBinding> {
  const binding = await findObjectBinding(client, context, environmentKey, releaseId);
  if (!binding) throw new McpEditingError("REVIEWED_ASTRO_ARTIFACT_MISSING", "Reviewed Astro object binding disappeared during registration");
  return binding;
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

function rowToRecord(row: StoredArtifactRow): ReviewedAstroArtifactRecord {
  return freezeRecord({ tenantId: row.tenant_id, siteId: row.site_id, environment: "staging",
    environmentKey: row.environment_key, releaseId: row.release_id, releaseHash: row.release_hash,
    releaseArtifactHash: row.artifact_hash, expectedAstroArtifactHash: row.astro_artifact_hash,
    sourceCommitSha: row.source_commit_sha, artifact: row.artifact_json as AstroArtifact,
    output: row.output_json as Readonly<Record<string, string>> });
}

function freezeRecord(record: ReviewedAstroArtifactRecord): ReviewedAstroArtifactRecord { return deepFreeze(structuredClone(record)); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as object)) deepFreeze(child); } return value; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
function hash(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function commit(value: string): boolean { return /^([a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
function uuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
