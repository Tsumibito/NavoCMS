import { randomUUID } from "node:crypto";

import { contracts } from "@navocms/contracts";
import { assertSafeProjection } from "@navocms/security";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

import { ContentError } from "./errors.js";
import { canonicalMarkdown, parseMarkdown } from "./markdown.js";
import type {
  ContentDocument,
  ContentPack,
  ContentRelation,
  ContentRevision,
  ContentScope,
  ContentTypeDefinition,
  ContentVariant,
  DirectiveDefinition,
  RevisionDiff,
  RevisionProvenance,
  StructuralPatchOperation
} from "./model.js";
import { applyStructuralPatch, compareMarkdown } from "./patches.js";

const identifier = /^[a-z][a-z0-9-]{1,63}$/;
const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/;
const fieldAjv = new Ajv2020({ allErrors: true, strict: false });
const addFormats = (
  "default" in addFormatsModule ? addFormatsModule.default : addFormatsModule
) as unknown as FormatsPlugin;
addFormats(fieldAjv);

export interface CreateDocumentInput extends ContentScope {
  readonly typeName: string;
  readonly slug: string;
  readonly locale: string;
  readonly variantKey?: string;
  readonly source: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly provenance: RevisionProvenance;
}

export interface PatchRevisionInput extends ContentScope {
  readonly revisionId: string;
  readonly baseSourceHash: string;
  readonly operations: readonly StructuralPatchOperation[];
  readonly provenance: RevisionProvenance;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PortableRevisionRecord extends Omit<ContentRevision, "tenantId" | "siteId" | "source" | "ast"> {
  readonly path: string;
}

export interface PortableSiteBundle {
  readonly apiVersion: "navocms.io/portable-site/v1";
  readonly exportedAt: string;
  readonly source: ContentScope;
  readonly types: readonly ContentTypeDefinition[];
  readonly directiveSets: Readonly<Record<string, readonly DirectiveDefinition[]>>;
  readonly documents: readonly Omit<ContentDocument, "tenantId" | "siteId">[];
  readonly variants: readonly Omit<ContentVariant, "tenantId" | "siteId">[];
  readonly revisions: readonly PortableRevisionRecord[];
  readonly relations: readonly Omit<ContentRelation, "tenantId" | "siteId">[];
  readonly files: Readonly<Record<string, string>>;
}

export class ContentEngine {
  readonly #types = new Map<string, ContentTypeDefinition>();
  readonly #directives = new Map<string, readonly DirectiveDefinition[]>();
  readonly #documents = new Map<string, ContentDocument>();
  readonly #variants = new Map<string, ContentVariant>();
  readonly #revisions = new Map<string, ContentRevision>();
  readonly #relations = new Map<string, ContentRelation>();
  readonly #now: () => Date;
  readonly #id: () => string;

  public constructor(options: { now?: () => Date; id?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
  }

  public registerType(
    scope: ContentScope,
    definition: ContentTypeDefinition,
    directives: readonly DirectiveDefinition[] = []
  ): void {
    validateType(definition);
    validateDirectives(directives);
    const key = typeKey(scope, definition.metadata.name);
    const existing = this.#types.get(key);
    const existingDirectives = this.#directives.get(key);
    if (
      existing &&
      (JSON.stringify(existing) !== JSON.stringify(definition) ||
        JSON.stringify(existingDirectives ?? []) !== JSON.stringify(directives))
    ) {
      throw new ContentError(
        "CONTENT_TYPE_VERSION_CONFLICT",
        `Type ${definition.metadata.name} is already registered`
      );
    }
    this.#types.set(key, immutable(definition));
    this.#directives.set(key, immutable(directives));
  }

  public registerPack(scope: ContentScope, pack: ContentPack): void {
    if (!identifier.test(pack.id)) throw new ContentError("CONTENT_PACK_ID_INVALID", "Content pack id is invalid");
    for (const definition of pack.types) {
      this.registerType(scope, definition, pack.directives?.[definition.metadata.name] ?? []);
    }
  }

  public createDocument(input: CreateDocumentInput): {
    readonly document: ContentDocument;
    readonly variant: ContentVariant;
    readonly revision: ContentRevision;
  } {
    const definition = this.requireType(input, input.typeName);
    if (!identifier.test(input.slug)) throw new ContentError("DOCUMENT_SLUG_INVALID", "Document slug is invalid");
    if (!localePattern.test(input.locale)) throw new ContentError("VARIANT_LOCALE_INVALID", "Variant locale is invalid");
    if ([...this.#documents.values()].some((document) => sameScope(document, input) && document.slug === input.slug)) {
      throw new ContentError("DOCUMENT_SLUG_CONFLICT", `Document slug ${input.slug} already exists`);
    }
    const canonical = canonicalMarkdown(input.source, this.directivesFor(input, input.typeName));
    validateMetadata(definition, input.metadata, input.slug, canonical);
    const createdAt = this.#now().toISOString();
    const document = immutable({
      id: this.#id(),
      tenantId: input.tenantId,
      siteId: input.siteId,
      typeName: input.typeName,
      slug: input.slug,
      createdAt
    } satisfies ContentDocument);
    const variant = immutable({
      id: this.#id(),
      tenantId: input.tenantId,
      siteId: input.siteId,
      documentId: document.id,
      locale: input.locale,
      key: input.variantKey ?? "default",
      createdAt
    } satisfies ContentVariant);
    this.#documents.set(document.id, document);
    this.#variants.set(variant.id, variant);
    const revision = this.createRevision({
      ...input,
      documentId: document.id,
      variantId: variant.id,
      source: input.source,
      metadata: input.metadata,
      provenance: input.provenance
    });
    return immutable({ document, variant, revision });
  }

  public createVariant(input: ContentScope & {
    readonly documentId: string;
    readonly locale: string;
    readonly key?: string;
    readonly source: string;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly provenance: RevisionProvenance;
  }): { readonly variant: ContentVariant; readonly revision: ContentRevision } {
    const document = this.requireDocument(input, input.documentId);
    const definition = this.requireType(input, document.typeName);
    if (!localePattern.test(input.locale)) throw new ContentError("VARIANT_LOCALE_INVALID", "Variant locale is invalid");
    const key = input.key ?? "default";
    if ([...this.#variants.values()].some((variant) =>
      sameScope(variant, input) && variant.documentId === document.id && variant.locale === input.locale && variant.key === key
    )) {
      throw new ContentError("VARIANT_CONFLICT", `Variant ${input.locale}/${key} already exists`);
    }
    const canonical = canonicalMarkdown(input.source, this.directivesFor(input, document.typeName));
    validateMetadata(definition, input.metadata, document.slug, canonical);
    const variant = immutable({
      id: this.#id(),
      tenantId: input.tenantId,
      siteId: input.siteId,
      documentId: document.id,
      locale: input.locale,
      key,
      createdAt: this.#now().toISOString()
    } satisfies ContentVariant);
    this.#variants.set(variant.id, variant);
    const revision = this.createRevision({ ...input, variantId: variant.id });
    return immutable({ variant, revision });
  }

  public patchRevision(input: PatchRevisionInput): { readonly revision: ContentRevision; readonly diff: RevisionDiff } {
    const base = this.requireRevision(input, input.revisionId);
    const document = this.requireDocument(input, base.documentId);
    const metadata = input.metadata ?? base.metadata;
    const result = applyStructuralPatch({
      source: base.source,
      baseSourceHash: input.baseSourceHash,
      operations: input.operations,
      directives: this.directivesFor(input, document.typeName)
    });
    const revision = this.createRevision({
      ...input,
      documentId: base.documentId,
      variantId: base.variantId,
      parentRevisionId: base.id,
      source: result.source,
      metadata,
      provenance: input.provenance
    });
    return immutable({ revision, diff: result.diff });
  }

  public compare(scope: ContentScope, fromRevisionId: string, toRevisionId: string): RevisionDiff {
    const from = this.requireRevision(scope, fromRevisionId);
    const to = this.requireRevision(scope, toRevisionId);
    if (from.variantId !== to.variantId) {
      throw new ContentError("REVISION_VARIANT_MISMATCH", "Only revisions of the same variant can be compared");
    }
    return compareMarkdown(from.source, to.source);
  }

  public addRelation(input: ContentScope & {
    readonly fromDocumentId: string;
    readonly toDocumentId: string;
    readonly kind: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): ContentRelation {
    const from = this.requireDocument(input, input.fromDocumentId);
    const to = this.requireDocument(input, input.toDocumentId);
    if (!identifier.test(input.kind)) throw new ContentError("RELATION_KIND_INVALID", "Relation kind is invalid");
    const definition = this.requireType(input, from.typeName);
    const declared = definition.spec.relations.find((relation) => relation.name === input.kind);
    if (!declared) {
      throw new ContentError("RELATION_NOT_DECLARED", `Relation ${input.kind} is not declared by ${from.typeName}`);
    }
    if (declared.target !== to.typeName) {
      throw new ContentError("RELATION_TARGET_INVALID", `Relation ${input.kind} must target ${declared.target}`);
    }
    const metadata = input.metadata ?? {};
    assertSafeProjection(metadata);
    const existing = [...this.#relations.values()].filter((relation) =>
      sameScope(relation, input) && relation.fromDocumentId === from.id && relation.kind === input.kind
    );
    if (existing.some((relation) => relation.toDocumentId === to.id) || (declared.cardinality === "one" && existing.length > 0)) {
      throw new ContentError("RELATION_CONFLICT", `Relation ${input.kind} violates its declared cardinality`);
    }
    const relation = immutable({
      id: this.#id(),
      tenantId: input.tenantId,
      siteId: input.siteId,
      fromDocumentId: input.fromDocumentId,
      toDocumentId: input.toDocumentId,
      kind: input.kind,
      metadata
    } satisfies ContentRelation);
    this.#relations.set(relation.id, relation);
    return relation;
  }

  public getRevision(scope: ContentScope, revisionId: string): ContentRevision {
    return this.requireRevision(scope, revisionId);
  }

  public listDocuments(scope: ContentScope): readonly ContentDocument[] {
    return Object.freeze([...this.#documents.values()].filter((document) => sameScope(document, scope)));
  }

  public listRevisions(scope: ContentScope, variantId: string): readonly ContentRevision[] {
    this.requireVariant(scope, variantId);
    return Object.freeze(
      [...this.#revisions.values()]
        .filter((revision) => sameScope(revision, scope) && revision.variantId === variantId)
        .sort((left, right) => left.number - right.number)
    );
  }

  public exportBundle(scope: ContentScope, exportedAt: Date = this.#now()): PortableSiteBundle {
    const documents = this.listDocuments(scope);
    const documentIds = new Set(documents.map(({ id }) => id));
    const variants = [...this.#variants.values()].filter((variant) => sameScope(variant, scope) && documentIds.has(variant.documentId));
    const variantIds = new Set(variants.map(({ id }) => id));
    const revisions = [...this.#revisions.values()].filter((revision) => sameScope(revision, scope) && variantIds.has(revision.variantId));
    const files: Record<string, string> = {};
    const portableRevisions = revisions.map((revision) => {
      assertSafeProjection(revision.metadata);
      const path = `content/${revision.documentId}/${revision.variantId}/r${revision.number}.md`;
      files[path] = revision.source;
      const { tenantId: _tenantId, siteId: _siteId, source: _source, ast: _ast, ...record } = revision;
      return immutable({ ...record, path });
    });
    const types = [...this.#types.entries()]
      .filter(([key]) => key.startsWith(`${scope.tenantId}:${scope.siteId}:`))
      .map(([, definition]) => definition);
    const directiveSets = Object.fromEntries(
      types.map((definition) => [definition.metadata.name, this.directivesFor(scope, definition.metadata.name)])
    );
    const relations = [...this.#relations.values()].filter((relation) => sameScope(relation, scope));
    return immutable({
      apiVersion: "navocms.io/portable-site/v1",
      exportedAt: exportedAt.toISOString(),
      source: { ...scope },
      types,
      directiveSets,
      documents: documents.map(withoutScope),
      variants: variants.map(withoutScope),
      revisions: portableRevisions,
      relations: relations.map(withoutScope),
      files
    });
  }

  public importBundle(bundle: PortableSiteBundle, target: ContentScope): void {
    const snapshots = {
      types: new Map(this.#types),
      directives: new Map(this.#directives),
      documents: new Map(this.#documents),
      variants: new Map(this.#variants),
      revisions: new Map(this.#revisions),
      relations: new Map(this.#relations)
    };
    try {
      if (bundle.apiVersion !== "navocms.io/portable-site/v1") {
        throw new ContentError("BUNDLE_VERSION_UNSUPPORTED", "Portable bundle version is not supported");
      }
    for (const definition of bundle.types) {
      this.registerType(target, definition, bundle.directiveSets[definition.metadata.name] ?? []);
    }
    for (const record of bundle.documents) {
      if (this.#documents.has(record.id)) throw new ContentError("BUNDLE_ID_CONFLICT", `Document ${record.id} already exists`);
      this.requireType(target, record.typeName);
      this.#documents.set(record.id, immutable({ ...record, ...target }));
    }
    for (const record of bundle.variants) {
      this.requireDocument(target, record.documentId);
      if (this.#variants.has(record.id)) throw new ContentError("BUNDLE_ID_CONFLICT", `Variant ${record.id} already exists`);
      this.#variants.set(record.id, immutable({ ...record, ...target }));
    }
    for (const record of [...bundle.revisions].sort((left, right) => left.number - right.number)) {
      const source = bundle.files[record.path];
      if (source === undefined) throw new ContentError("BUNDLE_FILE_MISSING", `Bundle file ${record.path} is missing`);
      const document = this.requireDocument(target, record.documentId);
      const variant = this.requireVariant(target, record.variantId);
      if (variant.documentId !== document.id) {
        throw new ContentError("BUNDLE_RELATION_INVALID", `Revision ${record.id} has mismatched document and variant`);
      }
      if (record.parentRevisionId) this.requireRevision(target, record.parentRevisionId);
      const definition = this.requireType(target, document.typeName);
      const directives = this.directivesFor(target, document.typeName);
      const canonical = canonicalMarkdown(source, directives);
      const ast = parseMarkdown(canonical, directives);
      if (ast.sourceHash !== record.sourceHash) {
        throw new ContentError("BUNDLE_HASH_MISMATCH", `Bundle file ${record.path} failed integrity validation`);
      }
      validateMetadata(definition, record.metadata, document.slug, canonical);
      if (this.#revisions.has(record.id)) throw new ContentError("BUNDLE_ID_CONFLICT", `Revision ${record.id} already exists`);
      const { path: _path, ...portable } = record;
      this.#revisions.set(record.id, immutable({ ...portable, ...target, source: canonical, ast }));
    }
    for (const record of bundle.relations) {
      const from = this.requireDocument(target, record.fromDocumentId);
      const to = this.requireDocument(target, record.toDocumentId);
      if (!identifier.test(record.kind)) throw new ContentError("RELATION_KIND_INVALID", "Relation kind is invalid");
      const definition = this.requireType(target, from.typeName);
      const declared = definition.spec.relations.find((relation) => relation.name === record.kind);
      if (!declared || declared.target !== to.typeName) {
        throw new ContentError("BUNDLE_RELATION_INVALID", `Relation ${record.id} violates its content type`);
      }
      const existing = [...this.#relations.values()].filter((relation) =>
        sameScope(relation, target) && relation.fromDocumentId === from.id && relation.kind === record.kind
      );
      if (
        existing.some((relation) => relation.toDocumentId === to.id) ||
        (declared.cardinality === "one" && existing.length > 0)
      ) {
        throw new ContentError("RELATION_CONFLICT", `Relation ${record.kind} violates its declared cardinality`);
      }
      assertSafeProjection(record.metadata);
      if (this.#relations.has(record.id)) throw new ContentError("BUNDLE_ID_CONFLICT", `Relation ${record.id} already exists`);
      this.#relations.set(record.id, immutable({ ...record, ...target }));
    }
    } catch (error) {
      restoreMap(this.#types, snapshots.types);
      restoreMap(this.#directives, snapshots.directives);
      restoreMap(this.#documents, snapshots.documents);
      restoreMap(this.#variants, snapshots.variants);
      restoreMap(this.#revisions, snapshots.revisions);
      restoreMap(this.#relations, snapshots.relations);
      throw error;
    }
  }

  private createRevision(input: ContentScope & {
    readonly documentId: string;
    readonly variantId: string;
    readonly parentRevisionId?: string;
    readonly source: string;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly provenance: RevisionProvenance;
  }): ContentRevision {
    const document = this.requireDocument(input, input.documentId);
    const variant = this.requireVariant(input, input.variantId);
    if (variant.documentId !== document.id) throw new ContentError("VARIANT_DOCUMENT_MISMATCH", "Variant belongs to another document");
    if (input.parentRevisionId) {
      const parent = this.requireRevision(input, input.parentRevisionId);
      if (parent.variantId !== variant.id) {
        throw new ContentError("REVISION_PARENT_MISMATCH", "Parent revision belongs to another variant");
      }
    }
    const definition = this.requireType(input, document.typeName);
    const directives = this.directivesFor(input, document.typeName);
    const source = canonicalMarkdown(input.source, directives);
    validateMetadata(definition, input.metadata, document.slug, source);
    const ast = parseMarkdown(source, directives);
    const number = 1 + Math.max(
      0,
      ...[...this.#revisions.values()]
        .filter((revision) => revision.variantId === variant.id)
        .map((revision) => revision.number)
    );
    const revision = immutable({
      id: this.#id(),
      tenantId: input.tenantId,
      siteId: input.siteId,
      documentId: document.id,
      variantId: variant.id,
      number,
      ...(input.parentRevisionId ? { parentRevisionId: input.parentRevisionId } : {}),
      source,
      sourceHash: ast.sourceHash,
      ast,
      metadata: input.metadata,
      provenance: input.provenance,
      createdAt: this.#now().toISOString()
    } satisfies ContentRevision);
    this.#revisions.set(revision.id, revision);
    return revision;
  }

  private requireType(scope: ContentScope, name: string): ContentTypeDefinition {
    const definition = this.#types.get(typeKey(scope, name));
    if (!definition) throw new ContentError("CONTENT_TYPE_NOT_FOUND", `Content type ${name} is not registered`);
    return definition;
  }

  private directivesFor(scope: ContentScope, name: string): readonly DirectiveDefinition[] {
    return this.#directives.get(typeKey(scope, name)) ?? [];
  }

  private requireDocument(scope: ContentScope, id: string): ContentDocument {
    const document = this.#documents.get(id);
    if (!document || !sameScope(document, scope)) throw new ContentError("DOCUMENT_NOT_FOUND", "Document does not exist in this site");
    return document;
  }

  private requireVariant(scope: ContentScope, id: string): ContentVariant {
    const variant = this.#variants.get(id);
    if (!variant || !sameScope(variant, scope)) throw new ContentError("VARIANT_NOT_FOUND", "Variant does not exist in this site");
    return variant;
  }

  private requireRevision(scope: ContentScope, id: string): ContentRevision {
    const revision = this.#revisions.get(id);
    if (!revision || !sameScope(revision, scope)) throw new ContentError("REVISION_NOT_FOUND", "Revision does not exist in this site");
    return revision;
  }
}

function validateType(definition: ContentTypeDefinition): void {
  contracts.contentType.parse(definition);
}

function validateDirectives(directives: readonly DirectiveDefinition[]): void {
  const directiveNames = new Set<string>();
  for (const directive of directives) {
    if (!identifier.test(directive.name) || directiveNames.has(directive.name)) {
      throw new ContentError("CONTENT_DIRECTIVE_INVALID", `Directive ${directive.name} is invalid or duplicated`);
    }
    directiveNames.add(directive.name);
  }
}

function validateMetadata(
  definition: ContentTypeDefinition,
  metadata: Readonly<Record<string, unknown>>,
  slug: string,
  source: string
): void {
  assertSafeProjection(metadata);
  const validate = fieldAjv.compile(definition.spec.fields);
  const fields = { ...metadata, slug, body: source };
  if (!validate(fields)) {
    throw new ContentError("CONTENT_FIELDS_INVALID", `Fields do not satisfy ${definition.metadata.name}`, {
      issues: (validate.errors ?? []).map((error: ErrorObject) => ({
        path: error.instancePath,
        message: error.message
      }))
    });
  }
}

function typeKey(scope: ContentScope, name: string): string {
  return `${scope.tenantId}:${scope.siteId}:${name}`;
}

function sameScope(left: ContentScope, right: ContentScope): boolean {
  return left.tenantId === right.tenantId && left.siteId === right.siteId;
}

function withoutScope<T extends ContentScope>(record: T): Omit<T, "tenantId" | "siteId"> {
  const { tenantId: _tenantId, siteId: _siteId, ...portable } = record;
  return portable;
}

function immutable<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === "object" && !Object.isFrozen(item)) {
      Object.freeze(item);
      for (const nested of Object.values(item)) freeze(nested);
    }
  };
  freeze(clone);
  return clone;
}

function restoreMap<K, V>(target: Map<K, V>, snapshot: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}
