import { createHash } from "node:crypto";

import {
  ContentEngine,
  foundationPacks,
  type ContentRevision,
  type RevisionDiff,
  type StructuralPatchOperation
} from "@navocms/content";

import type { ContentHit, DraftSummary, SiteDescriptor } from "./model.js";

interface VariantIndex {
  readonly documentId: string;
  readonly variantId: string;
  readonly locale: string;
  readonly typeName: string;
  readonly slug: string;
}

export interface RepositoryScope {
  readonly tenantId: string;
  readonly siteId: string;
  readonly principalId: string;
}

export interface RepositoryContext {
  readonly site: SiteDescriptor;
  readonly principalId: string;
}

type Awaitable<T> = T | Promise<T>;

export interface CreateDraftInput {
  readonly site: SiteDescriptor;
  readonly typeName: string;
  readonly slug: string;
  readonly locale: string;
  readonly title: string;
  readonly source: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly actorId: string;
}

export interface PatchDraftInput {
  readonly site: SiteDescriptor;
  readonly revisionId: string;
  readonly baseSourceHash: string;
  readonly operations: readonly StructuralPatchOperation[];
  readonly actorId: string;
}

/**
 * A keyset page over a site-scoped listing. `nextCursor` is the opaque
 * identifier of the last returned row (the content variant id); a missing
 * `nextCursor` means the enumeration reached the end of the current set.
 */
export interface RepositoryPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface EditingRepository {
  getSite(scope: RepositoryScope): Awaitable<SiteDescriptor | undefined>;
  search(context: RepositoryContext, query: string, limit: number, cursor?: string): Awaitable<RepositoryPage<ContentHit>>;
  findDocument(context: RepositoryContext, documentId: string): Awaitable<ContentHit | undefined>;
  getRevision(context: RepositoryContext, revisionId: string): Awaitable<ContentRevision>;
  createDraft(input: CreateDraftInput): Awaitable<DraftSummary>;
  patchDraft(input: PatchDraftInput): Awaitable<{ readonly draft: DraftSummary; readonly diff: RevisionDiff }>;
  compare(context: RepositoryContext, fromRevisionId: string, toRevisionId: string): Awaitable<RevisionDiff>;
  listDrafts(context: RepositoryContext, limit: number, cursor?: string): Awaitable<RepositoryPage<DraftSummary>>;
  workflowFor(context: RepositoryContext, revisionId: string): Awaitable<string>;
}

export class InMemoryEditingRepository implements EditingRepository {
  readonly #engine: ContentEngine;
  readonly #sites = new Map<string, SiteDescriptor>();
  readonly #variants = new Map<string, VariantIndex>();
  readonly #drafts = new Map<string, string>();

  public constructor(engine = new ContentEngine()) {
    this.#engine = engine;
  }

  public registerSite(site: SiteDescriptor): void {
    const key = scopeKey(site.tenantId, site.siteId);
    if (this.#sites.has(key)) throw new Error(`Site ${site.siteId} is already registered`);
    this.#sites.set(key, Object.freeze({ ...site, locales: Object.freeze([...site.locales]) }));
    for (const pack of foundationPacks) this.#engine.registerPack(site, pack);
  }

  public getSite(scope: RepositoryScope): SiteDescriptor | undefined {
    return this.#sites.get(scopeKey(scope.tenantId, scope.siteId));
  }

  /**
   * Keyset page over document/variant rows ordered by (slug, locale, variantId).
   * The cursor is the previous page's last variant id; an unknown cursor yields
   * an empty page. Slugs and locales are immutable, so concurrent revision
   * patches never reorder rows; documents created mid-enumeration sort ahead of
   * an in-flight cursor and appear on the next pass.
   */
  public search({ site }: RepositoryContext, query: string, limit: number, cursor?: string): RepositoryPage<ContentHit> {
    const needle = query.trim().toLocaleLowerCase();
    const rows = this.#engine.listDocuments(site).flatMap((document) =>
      [...this.#variants.entries()]
        .filter(([key, variant]) => key.startsWith(`${scopeKey(site.tenantId, site.siteId)}:`) && variant.documentId === document.id)
        .map(([, variant]) => {
          const revision = this.#engine.listRevisions(site, variant.variantId).at(-1)!;
          return {
            variant,
            revision,
            hit: toHit(variant, revision),
            key: [variant.slug, variant.locale, variant.variantId] as const
          };
        })
    );
    const cursorRow = cursor === undefined ? undefined : rows.find((row) => row.variant.variantId === cursor);
    if (cursor !== undefined && !cursorRow) return Object.freeze({ items: Object.freeze([]) });
    const ordered = rows
      .filter((row) => !needle || `${row.hit.title} ${row.hit.slug} ${row.hit.typeName} ${row.hit.excerpt}`.toLocaleLowerCase().includes(needle))
      .filter((row) => !cursorRow || compareTuples(row.key, cursorRow.key) > 0)
      .sort((left, right) => compareTuples(left.key, right.key));
    const page = ordered.slice(0, limit);
    return Object.freeze({
      items: Object.freeze(page.map((row) => row.hit)),
      ...(ordered.length > limit ? { nextCursor: page.at(-1)!.variant.variantId } : {})
    });
  }

  public findDocument({ site }: RepositoryContext, documentId: string): ContentHit | undefined {
    const document = this.#engine.listDocuments(site).find((candidate) => candidate.id === documentId);
    if (!document) return undefined;
    const indexed = [...this.#variants.entries()]
      .filter(([key, variant]) => key.startsWith(`${scopeKey(site.tenantId, site.siteId)}:`) && variant.documentId === document.id)
      .map(([, variant]) => variant)
      .sort((left, right) => left.locale.localeCompare(right.locale))[0];
    if (!indexed) return undefined;
    const revision = this.#engine.listRevisions(site, indexed.variantId).at(-1);
    return revision ? toHit(indexed, revision) : undefined;
  }

  public getRevision({ site }: RepositoryContext, revisionId: string): ContentRevision {
    return this.#engine.getRevision(site, revisionId);
  }

  public createDraft(input: CreateDraftInput): DraftSummary {
    const created = this.#engine.createDocument({
      ...input.site,
      typeName: input.typeName,
      slug: input.slug,
      locale: input.locale,
      source: input.source,
      metadata: metadataFor(input.typeName, input.slug, input.title, input.source, input.metadata),
      provenance: { kind: "agent", actorId: input.actorId, note: "Created through MCP" }
    });
    const indexed = Object.freeze({
      documentId: created.document.id,
      variantId: created.variant.id,
      locale: created.variant.locale,
      typeName: created.document.typeName,
      slug: created.document.slug
    });
    this.#variants.set(variantKey(input.site, created.variant.id), indexed);
    this.#drafts.set(draftKey(input.site, created.document.id), created.revision.id);
    return toDraft(indexed, created.revision);
  }

  public patchDraft(input: PatchDraftInput): { readonly draft: DraftSummary; readonly diff: RevisionDiff } {
    const current = this.#engine.getRevision(input.site, input.revisionId);
    const indexed = this.#variants.get(variantKey(input.site, current.variantId));
    if (!indexed) throw new Error("Revision does not belong to an indexed content variant");
    const changed = this.#engine.patchRevision({
      ...input.site,
      revisionId: input.revisionId,
      baseSourceHash: input.baseSourceHash,
      operations: input.operations,
      provenance: { kind: "agent", actorId: input.actorId, note: "Patched through MCP" }
    });
    this.#drafts.set(draftKey(input.site, current.documentId), changed.revision.id);
    return Object.freeze({ draft: toDraft(indexed, changed.revision), diff: changed.diff });
  }

  public compare({ site }: RepositoryContext, fromRevisionId: string, toRevisionId: string): RevisionDiff {
    return this.#engine.compare(site, fromRevisionId, toRevisionId);
  }

  /**
   * Keyset page over the draft queue ordered by (updatedAt, variantId)
   * descending. A patch moves a draft's position forward, so an in-flight pass
   * may shift it into a later page or surface it again; a full pass over an
   * unchanged queue yields every draft exactly once.
   */
  public listDrafts({ site }: RepositoryContext, limit: number, cursor?: string): RepositoryPage<DraftSummary> {
    const rows = [...this.#drafts.entries()]
      .filter(([key]) => key.startsWith(`${scopeKey(site.tenantId, site.siteId)}:`))
      .map(([, revisionId]) => {
        const revision = this.#engine.getRevision(site, revisionId);
        const indexed = this.#variants.get(variantKey(site, revision.variantId));
        if (!indexed) throw new Error("Draft index is inconsistent");
        return { indexed, revision, key: [revision.createdAt, revision.variantId] as const };
      });
    const cursorRow = cursor === undefined ? undefined : rows.find((row) => row.revision.variantId === cursor);
    if (cursor !== undefined && !cursorRow) return Object.freeze({ items: Object.freeze([]) });
    const ordered = rows
      .filter((row) => !cursorRow || compareTuples(row.key, cursorRow.key) < 0)
      .sort((left, right) => compareTuples(right.key, left.key));
    const page = ordered.slice(0, limit);
    return Object.freeze({
      items: Object.freeze(page.map((row) => toDraft(row.indexed, row.revision))),
      ...(ordered.length > limit ? { nextCursor: page.at(-1)!.revision.variantId } : {})
    });
  }

  public workflowFor({ site }: RepositoryContext, revisionId: string): string {
    const revision = this.#engine.getRevision(site, revisionId);
    const indexed = this.#variants.get(variantKey(site, revision.variantId));
    if (!indexed) throw new Error("Revision does not belong to an indexed content variant");
    if (indexed.typeName === "article") return "navocms.editorial.standard.v1";
    if (indexed.typeName === "landing-page") return "navocms.marketing.standard.v1";
    if (indexed.typeName === "legal-page") return "navocms.legal.review.v1";
    return "navocms.business.standard.v1";
  }
}

function metadataFor(
  typeName: string,
  slug: string,
  title: string,
  source: string,
  supplied: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  if (typeName === "landing-page") {
    return { ...supplied, title, slug, body: source, canonicalPath: supplied.canonicalPath ?? `/${slug}` };
  }
  if (typeName === "organization") return { ...supplied, name: title, slug, body: source };
  return { ...supplied, title, slug, body: source };
}

function toHit(indexed: VariantIndex, revision: ContentRevision): ContentHit {
  const title = typeof revision.metadata.title === "string"
    ? revision.metadata.title
    : typeof revision.metadata.name === "string"
      ? revision.metadata.name
      : indexed.slug;
  return Object.freeze({
    id: revision.documentId,
    title,
    slug: indexed.slug,
    typeName: indexed.typeName,
    locale: indexed.locale,
    revisionId: revision.id,
    revisionNumber: revision.number,
    sourceHash: revision.sourceHash,
    excerpt: excerpt(revision.source)
  });
}

function toDraft(indexed: VariantIndex, revision: ContentRevision): DraftSummary {
  return Object.freeze({ ...toHit(indexed, revision), updatedAt: revision.createdAt });
}

function excerpt(source: string): string {
  return source.replace(/[#>*_`\[\](){}:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 280);
}

function scopeKey(tenantId: string, siteId: string): string {
  return `${tenantId}:${siteId}`;
}

function variantKey(site: Pick<SiteDescriptor, "tenantId" | "siteId">, variantId: string): string {
  return `${scopeKey(site.tenantId, site.siteId)}:${variantId}`;
}

function draftKey(site: Pick<SiteDescriptor, "tenantId" | "siteId">, documentId: string): string {
  return `${scopeKey(site.tenantId, site.siteId)}:${documentId}`;
}

export function inputFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function compareTuples(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }
  return left.length - right.length;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized ?? "null";
}
