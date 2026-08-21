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

export interface EditingRepository {
  getSite(tenantId: string, siteId: string): SiteDescriptor | undefined;
  search(site: SiteDescriptor, query: string, limit: number): readonly ContentHit[];
  findDocument(site: SiteDescriptor, documentId: string): ContentHit | undefined;
  getRevision(site: SiteDescriptor, revisionId: string): ContentRevision;
  createDraft(input: CreateDraftInput): DraftSummary;
  patchDraft(input: PatchDraftInput): { readonly draft: DraftSummary; readonly diff: RevisionDiff };
  compare(site: SiteDescriptor, fromRevisionId: string, toRevisionId: string): RevisionDiff;
  listDrafts(site: SiteDescriptor, limit: number): readonly DraftSummary[];
  workflowFor(site: SiteDescriptor, revisionId: string): string;
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

  public getSite(tenantId: string, siteId: string): SiteDescriptor | undefined {
    return this.#sites.get(scopeKey(tenantId, siteId));
  }

  public search(site: SiteDescriptor, query: string, limit: number): readonly ContentHit[] {
    const needle = query.trim().toLocaleLowerCase();
    const hits = this.#engine.listDocuments(site).flatMap((document) => {
      const indexed = [...this.#variants.entries()]
        .filter(([key, variant]) => key.startsWith(`${scopeKey(site.tenantId, site.siteId)}:`) && variant.documentId === document.id)
        .map(([, variant]) => variant);
      return indexed.map((variant) => {
        const revisions = this.#engine.listRevisions(site, variant.variantId);
        const latest = revisions.at(-1)!;
        return toHit(variant, latest);
      });
    });
    return Object.freeze(
      hits
        .filter((hit) => {
          if (!needle) return true;
          return `${hit.title} ${hit.slug} ${hit.typeName} ${hit.excerpt}`.toLocaleLowerCase().includes(needle);
        })
        .sort((left, right) => left.slug.localeCompare(right.slug))
        .slice(0, limit)
    );
  }

  public findDocument(site: SiteDescriptor, documentId: string): ContentHit | undefined {
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

  public getRevision(site: SiteDescriptor, revisionId: string): ContentRevision {
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

  public compare(site: SiteDescriptor, fromRevisionId: string, toRevisionId: string): RevisionDiff {
    return this.#engine.compare(site, fromRevisionId, toRevisionId);
  }

  public listDrafts(site: SiteDescriptor, limit: number): readonly DraftSummary[] {
    return Object.freeze(
      [...this.#drafts.entries()]
        .filter(([key]) => key.startsWith(`${scopeKey(site.tenantId, site.siteId)}:`))
        .map(([, revisionId]) => {
          const revision = this.#engine.getRevision(site, revisionId);
          const indexed = this.#variants.get(variantKey(site, revision.variantId));
          if (!indexed) throw new Error("Draft index is inconsistent");
          return toDraft(indexed, revision);
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit)
    );
  }

  public workflowFor(site: SiteDescriptor, revisionId: string): string {
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
