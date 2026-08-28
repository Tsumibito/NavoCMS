import { renderAstroArtifact, type AstroComponentRegistration, type AstroDesignAdapter, type AstroRenderInput } from "@navocms/design-astro";
import { createReleaseManifest, DomainEventFactory, sha256, type EventStore, type ReleaseManifestV1 } from "@navocms/kernel";
import { PostgresEventStore, PostgresIdempotencyStore, type PostgresDatabase, type SqlClient } from "@navocms/persistence-postgres";
import { requirePermission } from "@navocms/security";

import { McpEditingError } from "./errors.js";
import type { McpRequestContext } from "./model.js";
import type { ReviewedAstroArtifactAuthority } from "./postgres-reviewed-astro-artifact-store.js";
import type { RepositoryContext } from "./repository.js";
import { reviewedAstroBuildBindingDigest, type ReviewedAstroBuildInputStore, type ReviewedAstroBuildInputs } from "./trusted-astro-builder.js";

const OPERATION = "reviewed_astro_build_input.register.v1";
const MAX_IDEMPOTENCY_KEY_BYTES = 128;

/**
 * Internal-only producer envelope. It is intentionally not represented in
 * mcp.ts: render evidence enters this boundary only through reviewed runtime
 * composition, after an authenticated human has selected an exact release.
 */
export interface RegisterReviewedAstroBuildInput {
  readonly idempotencyKey: string;
  readonly releaseId: string;
  readonly releaseHash: string;
  readonly releaseArtifactHash: string;
  readonly render: AstroRenderInput;
}

interface ReleaseRow extends Record<string, unknown> {
  readonly environment_id: string;
  readonly correlation_id: string;
  readonly manifest_json: unknown;
}

interface StoredRow extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly site_id: string;
  readonly environment_key: string;
  readonly release_id: string;
  readonly release_hash: string;
  readonly artifact_hash: string;
  readonly binding_digest: string;
  readonly manifest_json: unknown;
  readonly render_json: unknown;
}

interface StoredRender {
  readonly tenantId: string;
  readonly siteId: string;
  readonly locales: AstroRenderInput["locales"];
  readonly anchors: AstroRenderInput["anchors"];
  readonly deliveryLayout: AstroRenderInput["deliveryLayout"];
  readonly expectedMediaDigest: string;
  readonly design: Readonly<{
    digest: string;
    css: string;
    components: readonly Readonly<{ id: string; module: string; source: string | null; exportName: string | null }>[];
    recipes: AstroDesignAdapter["recipes"];
    legacyComponentIds: readonly string[];
  }>;
  readonly routes: AstroRenderInput["routes"];
}

/** Durable private input registry for the TrustedAstroBuilder. */
export class PostgresReviewedAstroBuildInputStore implements ReviewedAstroBuildInputStore {
  readonly #database: PostgresDatabase;
  readonly #context: RepositoryContext;
  readonly #environmentKey: string;
  readonly #events: EventStore;
  readonly #idempotency: PostgresIdempotencyStore;

  public constructor(database: PostgresDatabase, context: RepositoryContext, environmentKey: string, options: Readonly<{ events?: EventStore }> = {}) {
    if (!environmentKeyValid(environmentKey)) throw new McpEditingError("REVIEWED_ASTRO_ENVIRONMENT_INVALID", "Reviewed Astro environment key is invalid");
    this.#database = database;
    this.#context = context;
    this.#environmentKey = environmentKey;
    this.#events = options.events ?? new PostgresEventStore(database);
    this.#idempotency = new PostgresIdempotencyStore(database);
  }

  /** Ready is schema/scope based, never coupled to a particular release. */
  public async ready(): Promise<boolean> {
    try {
      if (!await this.#database.ready()) return false;
      return this.#database.withScope(scope(this.#context), async (client) => {
        const table = (await client.query<{ table_exists: boolean; rls: boolean; forced: boolean; exact_policy: boolean; can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>(
          `SELECT to_regclass('navocms.reviewed_astro_build_inputs') IS NOT NULL AS table_exists,
                  c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                  COALESCE((SELECT count(*) = 1 AND bool_and(p.polname = 'site_scope' AND p.polcmd = '*' AND p.polpermissive
                    AND array_length(p.polroles, 1) = 1 AND EXISTS (SELECT 1 FROM pg_roles role WHERE role.oid = p.polroles[1] AND role.rolname = 'navocms_app')
                    AND regexp_replace(pg_get_expr(p.polqual, p.polrelid), '[[:space:]()]', '', 'g') = 'tenant_id=navocms.current_tenant_idANDsite_id=navocms.current_site_id'
                    AND regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '[[:space:]()]', '', 'g') = 'tenant_id=navocms.current_tenant_idANDsite_id=navocms.current_site_id')
                    FROM pg_policy p WHERE p.polrelid = c.oid), false) AS exact_policy,
                  has_table_privilege(current_user, 'navocms.reviewed_astro_build_inputs', 'SELECT') AS can_select,
                  has_table_privilege(current_user, 'navocms.reviewed_astro_build_inputs', 'INSERT') AS can_insert,
                  has_table_privilege(current_user, 'navocms.reviewed_astro_build_inputs', 'UPDATE') AS can_update,
                  has_table_privilege(current_user, 'navocms.reviewed_astro_build_inputs', 'DELETE') AS can_delete
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'navocms' AND c.relname = 'reviewed_astro_build_inputs'`
        )).rows[0];
        if (!table?.table_exists || !table.rls || !table.forced || !table.exact_policy || !table.can_select || !table.can_insert || table.can_update || table.can_delete) return false;
        const environment = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM navocms.environments WHERE tenant_id = $1 AND site_id = $2 AND kind = 'staging' AND environment_key = $3) AS exists`,
          [this.#context.site.tenantId, this.#context.site.siteId, this.#environmentKey]
        );
        return environment.rows[0]?.exists === true;
      });
    } catch { return false; }
  }

  /**
   * Private composition API. Never expose this method as an MCP tool: the
   * caller may supply render data, but cannot supply or replace the release
   * manifest, release anchor, correlation ID, or authorization principal.
   */
  public async register(context: McpRequestContext, input: RegisterReviewedAstroBuildInput): Promise<ReviewedAstroBuildInputs> {
    const authority = reviewedAstroBuildInputAuthority(context);
    assertAuthority(authority, this.#context);
    assertInputEnvelope(input);
    const render = normalizedRender(input.render);
    let renderedHash: string;
    try { renderedHash = renderAstroArtifact(render).hash; } catch { throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_INVALID", "Reviewed Astro render input is invalid"); }
    const databaseScope = scope(this.#context);
    const fingerprint = sha256(canonical({ operation: OPERATION, releaseId: input.releaseId, releaseHash: input.releaseHash, releaseArtifactHash: input.releaseArtifactHash, render: storedRender(render) }));
    return this.#database.withScope(databaseScope, async (client) => {
      const release = await exactRelease(client, this.#context, this.#environmentKey, input);
      const manifest = loadedManifest(release.manifest_json, input, this.#context);
      assertRenderAnchors(manifest, render);
      const bindingDigest = reviewedAstroBuildBindingDigest({ releaseManifest: manifest, releaseHash: input.releaseHash, releaseArtifactHash: input.releaseArtifactHash, render });
      const reservation = await reserve(this.#idempotency, databaseScope, input.idempotencyKey, fingerprint);
      if (reservation.status === "completed") return persisted(reservation.value, this.#context, this.#environmentKey);
      if (reservation.status !== "reserved") throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_PENDING", "Reviewed Astro build input registration is pending");
      const inserted = await client.query(
        `INSERT INTO navocms.reviewed_astro_build_inputs (
           tenant_id, site_id, environment_id, environment_key, release_id, release_hash, artifact_hash,
           binding_digest, render_json, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT DO NOTHING`,
        [this.#context.site.tenantId, this.#context.site.siteId, release.environment_id, this.#environmentKey,
          input.releaseId, input.releaseHash, input.releaseArtifactHash, bindingDigest, JSON.stringify(storedRender(render)), authority.principal.id]
      );
      const record = (inserted.rowCount ?? 0) === 1
        ? freeze({ tenantId: this.#context.site.tenantId, siteId: this.#context.site.siteId, environment: "staging" as const, environmentKey: this.#environmentKey,
          releaseId: input.releaseId, releaseHash: input.releaseHash, releaseArtifactHash: input.releaseArtifactHash, releaseManifest: manifest, bindingDigest, render })
        : await requireStored(client, this.#context, this.#environmentKey, input.releaseId);
      if (!same(record, input, manifest, bindingDigest)) throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_DRIFT", "A different reviewed Astro build input already exists for this release");
      if ((inserted.rowCount ?? 0) === 1) {
        const factory = new DomainEventFactory({ source: "urn:navocms:mcp", tenantId: this.#context.site.tenantId, siteId: this.#context.site.siteId,
          correlationId: release.correlation_id, actor: { id: authority.principal.id, type: authority.principal.kind } });
        await this.#events.append(factory.create({ type: "io.navocms.release.astro-build-input-registered.v1", subject: `release:${input.releaseId}`,
          consequence: "G1", idempotencyKey: `${OPERATION}:${input.idempotencyKey}`,
          data: Object.freeze({ environment: "staging", environmentKey: this.#environmentKey, releaseId: input.releaseId,
            releaseHash: input.releaseHash, releaseArtifactHash: input.releaseArtifactHash, astroArtifactHash: renderedHash, bindingDigest }) }));
      }
      await this.#idempotency.complete(databaseScope, OPERATION, input.idempotencyKey, fingerprint, idempotencyValue(record));
      return record;
    });
  }

  public async get(input: Readonly<{ tenantId: string; siteId: string; environment: "staging"; environmentKey: string; releaseId: string }>): Promise<ReviewedAstroBuildInputs | undefined> {
    if (input.tenantId !== this.#context.site.tenantId || input.siteId !== this.#context.site.siteId || input.environment !== "staging" || input.environmentKey !== this.#environmentKey) throw new McpEditingError("REVIEWED_ASTRO_SCOPE_DENIED", "Reviewed Astro build input scope is denied");
    return this.#database.withScope(scope(this.#context), (client) => findStored(client, this.#context, this.#environmentKey, input.releaseId));
  }
}

/** Preview evidence is a draft operation; only the later trusted build/registration is human-publisher gated. */
export function reviewedAstroBuildInputAuthority(context: McpRequestContext): ReviewedAstroArtifactAuthority {
  requirePermission(context.authorization, "content:draft", {
    tenantId: context.authorization.tenantId,
    siteId: context.authorization.siteId
  });
  return Object.freeze({
    tenantId: context.authorization.tenantId,
    siteId: context.authorization.siteId,
    principal: Object.freeze({ id: context.authorization.principal.id, kind: context.authorization.principal.kind })
  });
}

function scope(context: RepositoryContext) { return { tenantId: context.site.tenantId, siteId: context.site.siteId, principalId: context.principalId }; }
function environmentKeyValid(value: string) { return /^[a-z0-9][a-z0-9-]{1,62}$/.test(value); }
function uuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function hash(value: string) { return /^[a-f0-9]{64}$/.test(value); }
function key(value: string) { return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value) && Buffer.byteLength(value, "utf8") <= MAX_IDEMPOTENCY_KEY_BYTES; }
function exactKeys(value: object, expected: readonly string[]) { const keys = Object.keys(value).sort(); return keys.length === expected.length && keys.every((item, index) => item === [...expected].sort()[index]); }
function assertAuthority(authority: ReviewedAstroArtifactAuthority, context: RepositoryContext) {
  if (authority.tenantId !== context.site.tenantId || authority.siteId !== context.site.siteId || authority.principal.id !== context.principalId) throw new McpEditingError("REVIEWED_ASTRO_AUTHORITY_DENIED", "Reviewed Astro build input authority does not match its database scope");
}
function assertInputEnvelope(input: RegisterReviewedAstroBuildInput) {
  if (!input || typeof input !== "object" || !exactKeys(input, ["idempotencyKey", "releaseId", "releaseHash", "releaseArtifactHash", "render"]) || !key(input.idempotencyKey) || !uuid(input.releaseId) || !hash(input.releaseHash) || !hash(input.releaseArtifactHash)) throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_INVALID", "Reviewed Astro build input envelope is invalid");
}
async function reserve(store: PostgresIdempotencyStore, databaseScope: ReturnType<typeof scope>, idempotencyKey: string, fingerprint: string) {
  try { return await store.reserve<ReviewedAstroBuildInputs>(databaseScope, OPERATION, idempotencyKey, fingerprint); }
  catch (error) { if (error instanceof Error && error.message === "IDEMPOTENCY_KEY_REUSED") throw new McpEditingError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with different input"); throw error; }
}
async function exactRelease(client: SqlClient, context: RepositoryContext, environmentKey: string, input: RegisterReviewedAstroBuildInput): Promise<ReleaseRow> {
  const row = (await client.query<ReleaseRow>(
    `SELECT r.environment_id, r.correlation_id, r.manifest_json
       FROM navocms.release_candidates r JOIN navocms.environments e
         ON e.tenant_id = r.tenant_id AND e.site_id = r.site_id AND e.id = r.environment_id AND e.kind = 'staging'
      WHERE r.tenant_id = $1 AND r.site_id = $2 AND r.id = $3 AND r.release_hash = $4 AND r.artifact_hash = $5 AND e.environment_key = $6`,
    [context.site.tenantId, context.site.siteId, input.releaseId, input.releaseHash, input.releaseArtifactHash, environmentKey]
  )).rows[0];
  if (!row) throw new McpEditingError("REVIEWED_ASTRO_RELEASE_BINDING_MISMATCH", "Reviewed Astro input does not match an exact staging release");
  return row;
}
function loadedManifest(value: unknown, input: RegisterReviewedAstroBuildInput, context: RepositoryContext): ReleaseManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["schema", "tenantId", "siteId", "environmentId", "revisionId", "sourceHash", "workflow", "anchors"])) throw new McpEditingError("REVIEWED_ASTRO_RELEASE_MANIFEST_INVALID", "Durable release manifest is invalid");
  const candidate = value as ReleaseManifestV1;
  try {
    const created = createReleaseManifest({ tenantId: candidate.tenantId, siteId: candidate.siteId, environmentId: candidate.environmentId, revisionId: candidate.revisionId, sourceHash: candidate.sourceHash, workflow: candidate.workflow, anchors: candidate.anchors });
    if (candidate.schema !== "io.navocms.release-manifest.v1" || canonical(candidate) !== canonical(created.manifest) || created.releaseHash !== input.releaseHash || candidate.tenantId !== context.site.tenantId || candidate.siteId !== context.site.siteId) throw new Error("manifest mismatch");
    return freeze(created.manifest);
  } catch { throw new McpEditingError("REVIEWED_ASTRO_RELEASE_MANIFEST_INVALID", "Durable release manifest is invalid"); }
}
function assertRenderAnchors(manifest: ReleaseManifestV1, render: AstroRenderInput): void {
  const unprefixed = (value: string) => value.startsWith("sha256:") ? value.slice("sha256:".length) : "";
  if (manifest.anchors.content !== unprefixed(render.anchors.content) || manifest.anchors.design !== unprefixed(render.anchors.design) || manifest.anchors.delivery !== unprefixed(render.anchors.delivery) || manifest.anchors.governance !== unprefixed(render.anchors.governance)) {
    throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_INVALID", "Reviewed Astro render anchors do not match the immutable release manifest");
  }
}
async function findStored(client: SqlClient, context: RepositoryContext, environmentKey: string, releaseId: string): Promise<ReviewedAstroBuildInputs | undefined> {
  const row = (await client.query<StoredRow>(
    `SELECT b.tenant_id, b.site_id, b.environment_key, b.release_id, b.release_hash, b.artifact_hash, b.binding_digest, r.manifest_json, b.render_json
       FROM navocms.reviewed_astro_build_inputs b
       JOIN navocms.release_candidates r ON r.tenant_id = b.tenant_id AND r.site_id = b.site_id AND r.id = b.release_id
        AND r.environment_id = b.environment_id AND r.release_hash = b.release_hash AND r.artifact_hash = b.artifact_hash
       JOIN navocms.environments e ON e.tenant_id = b.tenant_id AND e.site_id = b.site_id AND e.id = b.environment_id
        AND e.environment_key = b.environment_key AND e.kind = 'staging'
      WHERE b.tenant_id = $1 AND b.site_id = $2 AND b.environment_key = $3 AND b.release_id = $4`,
    [context.site.tenantId, context.site.siteId, environmentKey, releaseId]
  )).rows[0];
  return row ? fromRow(row, context) : undefined;
}
async function requireStored(client: SqlClient, context: RepositoryContext, environmentKey: string, releaseId: string): Promise<ReviewedAstroBuildInputs> {
  const result = await findStored(client, context, environmentKey, releaseId);
  if (!result) throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_MISSING", "Reviewed Astro build input disappeared during registration");
  return result;
}
function fromRow(row: StoredRow, context: RepositoryContext): ReviewedAstroBuildInputs {
  const input = { idempotencyKey: "persisted-reviewed-astro-input", releaseId: row.release_id, releaseHash: row.release_hash, releaseArtifactHash: row.artifact_hash, render: readStoredRender(row.render_json) };
  const manifest = loadedManifest(row.manifest_json, input, context);
  const bindingDigest = reviewedAstroBuildBindingDigest({ releaseManifest: manifest, releaseHash: input.releaseHash, releaseArtifactHash: input.releaseArtifactHash, render: input.render });
  if (row.tenant_id !== context.site.tenantId || row.site_id !== context.site.siteId || !environmentKeyValid(row.environment_key) || row.binding_digest !== bindingDigest) throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_CORRUPT", "Reviewed Astro build input is corrupt");
  return freeze({ tenantId: row.tenant_id, siteId: row.site_id, environment: "staging" as const, environmentKey: row.environment_key, releaseId: row.release_id, releaseHash: row.release_hash, releaseArtifactHash: row.artifact_hash, releaseManifest: manifest, bindingDigest, render: input.render });
}
function persisted(value: unknown, context: RepositoryContext, environmentKey: string): ReviewedAstroBuildInputs {
  try {
    const candidate = value as Omit<ReviewedAstroBuildInputs, "render"> & { readonly render: unknown };
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !exactKeys(candidate, ["tenantId", "siteId", "environment", "environmentKey", "releaseId", "releaseHash", "releaseArtifactHash", "releaseManifest", "bindingDigest", "render"]) || candidate.tenantId !== context.site.tenantId || candidate.siteId !== context.site.siteId || candidate.environment !== "staging" || candidate.environmentKey !== environmentKey || !uuid(candidate.releaseId) || !hash(candidate.releaseHash) || !hash(candidate.releaseArtifactHash)) throw new Error("scope");
    const render = readStoredRender(candidate.render);
    const manifest = loadedManifest(candidate.releaseManifest, { idempotencyKey: "persisted-reviewed-astro-input", releaseId: candidate.releaseId, releaseHash: candidate.releaseHash, releaseArtifactHash: candidate.releaseArtifactHash, render }, context);
    assertRenderAnchors(manifest, render);
    const digest = reviewedAstroBuildBindingDigest({ releaseManifest: manifest, releaseHash: candidate.releaseHash, releaseArtifactHash: candidate.releaseArtifactHash, render });
    if (candidate.bindingDigest !== digest) throw new Error("digest");
    return freeze({ ...candidate, releaseManifest: manifest, render });
  } catch { throw new McpEditingError("REVIEWED_ASTRO_IDEMPOTENCY_CORRUPT", "Reviewed Astro build input idempotency result is invalid"); }
}
function idempotencyValue(record: ReviewedAstroBuildInputs): object {
  return freeze({ tenantId: record.tenantId, siteId: record.siteId, environment: record.environment, environmentKey: record.environmentKey,
    releaseId: record.releaseId, releaseHash: record.releaseHash, releaseArtifactHash: record.releaseArtifactHash,
    releaseManifest: structuredClone(record.releaseManifest), bindingDigest: record.bindingDigest, render: storedRender(record.render) });
}
function same(record: ReviewedAstroBuildInputs, input: RegisterReviewedAstroBuildInput, manifest: ReleaseManifestV1, bindingDigest: string): boolean {
  return record.releaseId === input.releaseId && record.releaseHash === input.releaseHash && record.releaseArtifactHash === input.releaseArtifactHash && canonical(record.releaseManifest) === canonical(manifest) && record.bindingDigest === bindingDigest && canonical(storedRender(record.render)) === canonical(storedRender(normalizedRender(input.render)));
}
function normalizedRender(input: AstroRenderInput): AstroRenderInput {
  if (!input || typeof input !== "object") throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_INVALID", "Reviewed Astro render input is invalid");
  const decoded = readStoredRender(storedRender(input));
  try { renderAstroArtifact(decoded); } catch { throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_INVALID", "Reviewed Astro render input is invalid"); }
  return decoded;
}
function storedRender(render: AstroRenderInput): StoredRender {
  return { tenantId: render.tenantId, siteId: render.siteId, locales: structuredClone(render.locales), anchors: structuredClone(render.anchors), deliveryLayout: structuredClone(render.deliveryLayout), expectedMediaDigest: render.expectedMediaDigest,
    design: { digest: render.design.digest, css: render.design.css, components: [...render.design.components.values()].map((item) => ({ id: item.id, module: item.module, source: item.source, exportName: item.exportName ?? null })), recipes: structuredClone(render.design.recipes), legacyComponentIds: [] }, routes: structuredClone(render.routes) };
}
function readStoredRender(value: unknown): AstroRenderInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["tenantId", "siteId", "locales", "anchors", "deliveryLayout", "expectedMediaDigest", "design", "routes"])) throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_CORRUPT", "Reviewed Astro render snapshot is invalid");
  const stored = value as StoredRender;
  if (!stored.design || typeof stored.design !== "object" || !exactKeys(stored.design, ["digest", "css", "components", "recipes", "legacyComponentIds"]) || !Array.isArray(stored.design.components) || !Array.isArray(stored.design.recipes) || !Array.isArray(stored.design.legacyComponentIds) || stored.design.components.length > 64) throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_CORRUPT", "Reviewed Astro render snapshot is invalid");
  const ids = new Set<string>();
  for (const component of stored.design.components) {
    if (!component || typeof component !== "object" || Array.isArray(component) || !exactKeys(component, ["id", "module", "source", "exportName"]) || typeof component.id !== "string" || typeof component.source !== "string" || ids.has(component.id)) throw new McpEditingError("REVIEWED_ASTRO_BUILD_INPUT_CORRUPT", "Reviewed Astro render snapshot is invalid");
    ids.add(component.id);
  }
  return freeze({ tenantId: stored.tenantId, siteId: stored.siteId, locales: structuredClone(stored.locales), anchors: structuredClone(stored.anchors), deliveryLayout: structuredClone(stored.deliveryLayout), expectedMediaDigest: stored.expectedMediaDigest,
    design: { digest: stored.design.digest as `sha256:${string}`, css: stored.design.css, components: new Map(stored.design.components.map((component) => [component.id, freeze({ id: component.id, module: component.module, source: component.source, ...(component.exportName === null ? {} : { exportName: component.exportName }) })])), recipes: structuredClone(stored.design.recipes) }, routes: structuredClone(stored.routes) });
}
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as object)) freeze(child); } return value; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
