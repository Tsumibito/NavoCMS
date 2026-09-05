import { randomUUID } from "node:crypto";

import {
  ContentEngine,
  ContentError,
  applyStructuralPatch,
  compareMarkdown,
  foundationPacks,
  type ContentPack,
  type ContentRevision,
  type ContentTypeDefinition,
  type DirectiveDefinition,
  type RevisionProvenance
} from "@navocms/content";
import { type PostgresDatabase, type SqlClient } from "@navocms/persistence-postgres";

import type { ContentHit, DraftSummary, SiteDescriptor } from "./model.js";
import {
  type CreateDraftInput,
  type EditingRepository,
  type PatchDraftInput,
  type RepositoryContext,
  type RepositoryPage,
  type RepositoryScope,
  inputFingerprint
} from "./repository.js";

interface SiteRow extends Record<string, unknown> {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly primary_locale: string;
  readonly locales: string[];
}

interface HitRow extends Record<string, unknown> {
  readonly document_id: string;
  readonly variant_id: string;
  readonly type_name: string;
  readonly slug: string;
  readonly locale: string;
  readonly revision_id: string;
  readonly revision_number: number;
  readonly source_hash: string;
  readonly source_markdown: string;
  readonly metadata_json: Record<string, unknown>;
  readonly created_at: Date | string;
}

interface RevisionRow extends Record<string, unknown> {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string;
  readonly document_id: string;
  readonly variant_id: string;
  readonly revision_number: number;
  readonly parent_revision_id: string | null;
  readonly source_markdown: string;
  readonly source_hash: string;
  readonly ast_json: ContentRevision["ast"];
  readonly metadata_json: Record<string, unknown>;
  readonly provenance_json: RevisionProvenance;
  readonly created_at: Date | string;
}

interface TypeRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly definition: ContentTypeDefinition;
  readonly directive_definitions: DirectiveDefinition[];
}

interface VariantTypeRow extends Record<string, unknown> {
  readonly type_name: string;
  readonly slug: string;
  readonly locale: string;
  readonly directive_definitions: DirectiveDefinition[];
}

export class PostgresEditingRepository implements EditingRepository {
  readonly #database: PostgresDatabase;

  public constructor(database: PostgresDatabase) {
    this.#database = database;
  }

  public async getSite(scope: RepositoryScope): Promise<SiteDescriptor | undefined> {
    return this.#database.withScope(scope, async (client) => {
      const result = await client.query<SiteRow>(
        `SELECT id, tenant_id, name, primary_locale, locales
           FROM navocms.sites
          WHERE tenant_id = $1 AND id = $2`,
        [scope.tenantId, scope.siteId]
      );
      const row = result.rows[0];
      return row ? Object.freeze({
        tenantId: row.tenant_id,
        siteId: row.id,
        name: row.name,
        primaryLocale: row.primary_locale,
        locales: Object.freeze([...row.locales])
      }) : undefined;
    });
  }

  /**
   * Keyset page ordered by (slug, locale, variant_id). The cursor is the
   * previous page's last variant id and only positions the scan inside the
   * authorized site; tenant/site filters always apply. Slugs and locales are
   * immutable, so concurrent revision patches never reorder rows.
   */
  public async search(context: RepositoryContext, query: string, limit: number, cursor?: string): Promise<RepositoryPage<ContentHit>> {
    assertPageCursor(cursor);
    const rows = await this.#database.withScope(databaseScope(context), async (client) => (
      await client.query<HitRow>(`${hitSelect()}
        WHERE d.tenant_id = $1 AND d.site_id = $2
          AND ($3 = '%%' OR concat_ws(' ', d.slug, t.name,
            r.metadata_json->>'title', r.metadata_json->>'name', r.source_markdown) ILIKE $3)
          AND ($4::uuid IS NULL OR (d.slug, v.locale, v.id) > (
            SELECT cursor_document.slug, cursor_variant.locale, cursor_variant.id
              FROM navocms.content_variants cursor_variant
              JOIN navocms.content_documents cursor_document
                ON cursor_document.tenant_id = cursor_variant.tenant_id
               AND cursor_document.site_id = cursor_variant.site_id
               AND cursor_document.id = cursor_variant.document_id
             WHERE cursor_variant.tenant_id = $1 AND cursor_variant.site_id = $2
               AND cursor_variant.id = $4))
        ORDER BY d.slug, v.locale, v.id
        LIMIT $5`, [context.site.tenantId, context.site.siteId, `%${query.trim()}%`, cursor ?? null, limit + 1])).rows
    );
    return pageOf(rows, limit, (row) => row.variant_id, toHit);
  }

  public async findDocument(context: RepositoryContext, documentId: string): Promise<ContentHit | undefined> {
    if (!isUuid(documentId)) return undefined;
    const rows = await this.#database.withScope(databaseScope(context), async (client) => (
      await client.query<HitRow>(`${hitSelect()}
        WHERE d.tenant_id = $1 AND d.site_id = $2 AND d.id = $3
        ORDER BY v.locale
        LIMIT 1`, [context.site.tenantId, context.site.siteId, documentId])
    ).rows);
    return rows[0] ? toHit(rows[0]) : undefined;
  }

  public async getRevision(context: RepositoryContext, revisionId: string): Promise<ContentRevision> {
    if (!isUuid(revisionId)) throw new ContentError("REVISION_NOT_FOUND", "Revision was not found");
    return this.#database.withScope(databaseScope(context), async (client) => requireRevision(client, context.site, revisionId));
  }

  public async createDraft(input: CreateDraftInput): Promise<DraftSummary> {
    if (!input.site.locales.includes(input.locale)) {
      throw new ContentError("VARIANT_LOCALE_INVALID", "Locale is not enabled for this site");
    }
    const pack = requirePack(input.typeName);
    const engine = new ContentEngine();
    for (const foundation of foundationPacks) engine.registerPack(input.site, foundation);
    const created = engine.createDocument({
      ...input.site,
      typeName: input.typeName,
      slug: input.slug,
      locale: input.locale,
      source: input.source,
      metadata: metadataFor(input.typeName, input.slug, input.title, input.source, input.metadata),
      provenance: { kind: "agent", actorId: input.actorId, note: "Created through MCP" }
    });
    const definition = pack.types.find((candidate) => candidate.metadata.name === input.typeName)!;
    const directives = pack.directives?.[input.typeName] ?? [];
    await this.#database.withScope({ ...input.site, principalId: input.actorId }, async (client) => {
      const typeId = await ensureContentType(client, input.site, definition, directives);
      await client.query(
        `INSERT INTO navocms.content_documents (id, tenant_id, site_id, content_type_id, slug, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [created.document.id, input.site.tenantId, input.site.siteId, typeId, created.document.slug, created.document.createdAt]
      );
      await client.query(
        `INSERT INTO navocms.content_variants
           (id, tenant_id, site_id, document_id, locale, variant_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [created.variant.id, input.site.tenantId, input.site.siteId, created.document.id,
          created.variant.locale, created.variant.key, created.variant.createdAt]
      );
      await insertRevision(client, created.revision, input.actorId);
    });
    return toDraft({
      document_id: created.document.id,
      variant_id: created.variant.id,
      type_name: created.document.typeName,
      slug: created.document.slug,
      locale: created.variant.locale,
      revision_id: created.revision.id,
      revision_number: created.revision.number,
      source_hash: created.revision.sourceHash,
      source_markdown: created.revision.source,
      metadata_json: created.revision.metadata as Record<string, unknown>,
      created_at: created.revision.createdAt
    });
  }

  public async patchDraft(input: PatchDraftInput): Promise<{ readonly draft: DraftSummary; readonly diff: ReturnType<typeof compareMarkdown> }> {
    return this.#database.withScope({ ...input.site, principalId: input.actorId }, async (client) => {
      const base = await requireRevision(client, input.site, input.revisionId);
      const variant = (await client.query<VariantTypeRow>(
        `SELECT t.name AS type_name, d.slug, v.locale, t.directive_definitions
           FROM navocms.content_variants v
           JOIN navocms.content_documents d ON d.tenant_id = v.tenant_id AND d.site_id = v.site_id AND d.id = v.document_id
           JOIN navocms.content_types t ON t.tenant_id = d.tenant_id AND t.site_id = d.site_id AND t.id = d.content_type_id
          WHERE v.tenant_id = $1 AND v.site_id = $2 AND v.id = $3`,
        [input.site.tenantId, input.site.siteId, base.variantId]
      )).rows[0];
      if (!variant) throw new ContentError("VARIANT_NOT_FOUND", "Content variant was not found");
      const patched = applyStructuralPatch({
        source: base.source,
        baseSourceHash: input.baseSourceHash,
        operations: input.operations,
        directives: variant.directive_definitions
      });
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [base.variantId]);
      // The head check must run under the advisory lock together with the
      // insert: two concurrent patches from the same base would otherwise both
      // pass and the loser would silently orphan the winner's revision.
      const head = (await client.query<{ id: string; revision_number: number; source_hash: string }>(
        `SELECT id, revision_number, source_hash
           FROM navocms.content_revisions
          WHERE tenant_id = $1 AND site_id = $2 AND variant_id = $3
          ORDER BY revision_number DESC
          LIMIT 1`,
        [input.site.tenantId, input.site.siteId, base.variantId]
      )).rows[0];
      if (!head || head.id !== base.id) {
        throw new ContentError(
          "REVISION_NOT_CURRENT",
          `Revision ${base.id} is no longer the current head of the variant`,
          {
            baseRevisionId: base.id,
            baseRevisionNumber: base.number,
            currentRevisionId: head?.id,
            ...(head ? { currentRevisionNumber: head.revision_number, currentSourceHash: head.source_hash } : {})
          }
        );
      }
      const nextNumber = head.revision_number + 1;
      const provenance: RevisionProvenance = Object.freeze({
        kind: "agent", actorId: input.actorId, note: "Patched through MCP"
      });
      const metadata = typeof base.metadata.body === "string"
        ? Object.freeze({ ...base.metadata, body: patched.source })
        : base.metadata;
      const revision: ContentRevision = Object.freeze({
        id: randomUUID(), tenantId: input.site.tenantId, siteId: input.site.siteId,
        documentId: base.documentId, variantId: base.variantId, number: nextNumber,
        parentRevisionId: base.id, source: patched.source, sourceHash: patched.sourceHash,
        ast: patched.ast, metadata, provenance,
        createdAt: new Date().toISOString()
      });
      await insertRevision(client, revision, input.actorId);
      return Object.freeze({
        draft: toDraft({
          document_id: base.documentId, variant_id: base.variantId, type_name: variant.type_name,
          slug: variant.slug, locale: variant.locale, revision_id: revision.id,
          revision_number: revision.number, source_hash: revision.sourceHash,
          source_markdown: revision.source,
          metadata_json: revision.metadata as Record<string, unknown>, created_at: revision.createdAt
        }),
        diff: patched.diff
      });
    });
  }

  public async compare(context: RepositoryContext, fromRevisionId: string, toRevisionId: string) {
    const [from, to] = await Promise.all([this.getRevision(context, fromRevisionId), this.getRevision(context, toRevisionId)]);
    if (from.variantId !== to.variantId) throw new ContentError("REVISION_VARIANT_MISMATCH", "Only revisions of the same variant can be compared");
    return compareMarkdown(from.source, to.source);
  }

  /**
   * Keyset page over the draft queue ordered by (latest revision created_at,
   * variant_id) descending. A patch moves a draft's position forward, so an
   * in-flight pass may shift it into a later page or surface it again; a full
   * pass over an unchanged queue yields every draft exactly once.
   */
  public async listDrafts(context: RepositoryContext, limit: number, cursor?: string): Promise<RepositoryPage<DraftSummary>> {
    assertPageCursor(cursor);
    const rows = await this.#database.withScope(databaseScope(context), async (client) => (
      await client.query<HitRow>(`${hitSelect()}
        WHERE d.tenant_id = $1 AND d.site_id = $2
          AND ($3::uuid IS NULL OR (r.created_at, v.id) < (
            SELECT cursor_latest.created_at, cursor_variant.id
              FROM navocms.content_variants cursor_variant
              JOIN LATERAL (
                SELECT cr.created_at FROM navocms.content_revisions cr
                 WHERE cr.tenant_id = cursor_variant.tenant_id AND cr.site_id = cursor_variant.site_id
                   AND cr.variant_id = cursor_variant.id
                 ORDER BY cr.revision_number DESC LIMIT 1
              ) cursor_latest ON true
             WHERE cursor_variant.tenant_id = $1 AND cursor_variant.site_id = $2
               AND cursor_variant.id = $3))
        ORDER BY r.created_at DESC, v.id DESC
        LIMIT $4`, [context.site.tenantId, context.site.siteId, cursor ?? null, limit + 1])).rows
    );
    return pageOf(rows, limit, (row) => row.variant_id, toDraft);
  }

  public async workflowFor(context: RepositoryContext, revisionId: string): Promise<string> {
    const row = await this.#database.withScope(databaseScope(context), async (client) => (
      await client.query<{ workflow: string }>(
        `SELECT t.definition->'spec'->>'defaultWorkflow' AS workflow
           FROM navocms.content_revisions r
           JOIN navocms.content_documents d ON d.tenant_id = r.tenant_id AND d.site_id = r.site_id AND d.id = r.document_id
           JOIN navocms.content_types t ON t.tenant_id = d.tenant_id AND t.site_id = d.site_id AND t.id = d.content_type_id
          WHERE r.tenant_id = $1 AND r.site_id = $2 AND r.id = $3`,
        [context.site.tenantId, context.site.siteId, revisionId]
      )
    ).rows[0]);
    if (!row?.workflow) throw new ContentError("REVISION_NOT_FOUND", "Revision workflow was not found");
    return row.workflow;
  }
}

function databaseScope(context: RepositoryContext) {
  return { tenantId: context.site.tenantId, siteId: context.site.siteId, principalId: context.principalId };
}

function hitSelect(): string {
  return `SELECT d.id AS document_id, t.name AS type_name, d.slug, v.id AS variant_id, v.locale,
      r.id AS revision_id, r.revision_number, r.source_hash, r.source_markdown,
      r.metadata_json, r.created_at
    FROM navocms.content_documents d
    JOIN navocms.content_types t ON t.tenant_id = d.tenant_id AND t.site_id = d.site_id AND t.id = d.content_type_id
    JOIN navocms.content_variants v ON v.tenant_id = d.tenant_id AND v.site_id = d.site_id AND v.document_id = d.id
    JOIN LATERAL (
      SELECT cr.id, cr.revision_number, cr.source_hash, cr.source_markdown, cr.metadata_json, cr.created_at
        FROM navocms.content_revisions cr
       WHERE cr.tenant_id = v.tenant_id AND cr.site_id = v.site_id AND cr.variant_id = v.id
       ORDER BY cr.revision_number DESC LIMIT 1
    ) r ON true`;
}

function pageOf<T extends HitRow, R>(rows: readonly T[], limit: number, cursorOf: (row: T) => string, map: (row: T) => R): RepositoryPage<R> {
  const page = rows.slice(0, limit);
  return Object.freeze({
    items: Object.freeze(page.map(map)),
    ...(rows.length > limit ? { nextCursor: cursorOf(page.at(-1)!) } : {})
  });
}

function assertPageCursor(cursor: string | undefined): void {
  if (cursor !== undefined && !isUuid(cursor)) {
    throw new ContentError("PAGE_CURSOR_INVALID", "The page cursor is not a valid content variant identifier");
  }
}

async function requireRevision(client: SqlClient, site: SiteDescriptor, revisionId: string): Promise<ContentRevision> {
  const row = (await client.query<RevisionRow>(
    `SELECT id, tenant_id, site_id, document_id, variant_id, revision_number,
            parent_revision_id, source_markdown, source_hash, ast_json,
            metadata_json, provenance_json, created_at
       FROM navocms.content_revisions
      WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
    [site.tenantId, site.siteId, revisionId]
  )).rows[0];
  if (!row) throw new ContentError("REVISION_NOT_FOUND", "Revision was not found");
  return Object.freeze({
    id: row.id, tenantId: row.tenant_id, siteId: row.site_id, documentId: row.document_id,
    variantId: row.variant_id, number: row.revision_number,
    ...(row.parent_revision_id ? { parentRevisionId: row.parent_revision_id } : {}),
    source: row.source_markdown, sourceHash: row.source_hash, ast: row.ast_json,
    metadata: Object.freeze(row.metadata_json), provenance: Object.freeze(row.provenance_json),
    createdAt: iso(row.created_at)
  });
}

async function ensureContentType(client: SqlClient, site: SiteDescriptor, definition: ContentTypeDefinition, directives: readonly DirectiveDefinition[]): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO navocms.content_types
       (id, tenant_id, site_id, name, version, definition, directive_definitions)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
     ON CONFLICT (tenant_id, site_id, name) DO NOTHING`,
    [id, site.tenantId, site.siteId, definition.metadata.name, definition.metadata.version,
      JSON.stringify(definition), JSON.stringify(directives)]
  );
  const row = (await client.query<TypeRow>(
    `SELECT id, name, version, definition, directive_definitions FROM navocms.content_types
      WHERE tenant_id = $1 AND site_id = $2 AND name = $3`,
    [site.tenantId, site.siteId, definition.metadata.name]
  )).rows[0];
  if (
    !row || row.version !== definition.metadata.version ||
    inputFingerprint(row.definition) !== inputFingerprint(definition) ||
    inputFingerprint(row.directive_definitions) !== inputFingerprint(directives)
  ) {
    throw new ContentError("CONTENT_TYPE_VERSION_CONFLICT", `Type ${definition.metadata.name} has a conflicting persisted definition`);
  }
  return row.id;
}

async function insertRevision(client: SqlClient, revision: ContentRevision, actorId: string): Promise<void> {
  await client.query(
    `INSERT INTO navocms.content_revisions (
       id, tenant_id, site_id, document_id, variant_id, revision_number,
       parent_revision_id, source_markdown, source_hash, ast_json,
       metadata_json, provenance_json, created_by, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)`,
    [revision.id, revision.tenantId, revision.siteId, revision.documentId, revision.variantId,
      revision.number, revision.parentRevisionId ?? null, revision.source, revision.sourceHash,
      JSON.stringify(revision.ast), JSON.stringify(revision.metadata), JSON.stringify(revision.provenance),
      actorId, revision.createdAt]
  );
}

function requirePack(typeName: string): ContentPack {
  const pack = foundationPacks.find((candidate) => candidate.types.some((type) => type.metadata.name === typeName));
  if (!pack) throw new ContentError("CONTENT_TYPE_NOT_FOUND", `Unknown content type ${typeName}`);
  return pack;
}

function metadataFor(typeName: string, slug: string, title: string, source: string, supplied: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  if (typeName === "landing-page") return { ...supplied, title, slug, body: source, canonicalPath: supplied.canonicalPath ?? `/${slug}` };
  if (typeName === "organization") return { ...supplied, name: title, slug, body: source };
  return { ...supplied, title, slug, body: source };
}

function toHit(row: HitRow): ContentHit {
  const title = typeof row.metadata_json.title === "string" ? row.metadata_json.title
    : typeof row.metadata_json.name === "string" ? row.metadata_json.name : row.slug;
  return Object.freeze({
    id: row.document_id, title, slug: row.slug, typeName: row.type_name, locale: row.locale,
    revisionId: row.revision_id, revisionNumber: row.revision_number,
    sourceHash: row.source_hash, excerpt: excerpt(row.source_markdown)
  });
}

function toDraft(row: HitRow): DraftSummary {
  return Object.freeze({ ...toHit(row), updatedAt: iso(row.created_at) });
}

function excerpt(source: string): string {
  return source.replace(/[#>*_`\[\](){}:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 280);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
