import type { ContentTypeDefinition as ContractContentTypeDefinition } from "@navocms/contracts";

export interface ContentScope {
  readonly tenantId: string;
  readonly siteId: string;
}

export type DirectiveKind = "containerDirective" | "leafDirective" | "textDirective";

export interface DirectiveDefinition {
  readonly name: string;
  readonly kind: DirectiveKind;
  readonly allowedAttributes?: readonly string[];
  readonly requiredAttributes?: readonly string[];
}

export type ContentTypeDefinition = ContractContentTypeDefinition;

export interface ContentPack {
  readonly id: string;
  readonly version: string;
  readonly types: readonly ContentTypeDefinition[];
  readonly directives?: Readonly<Record<string, readonly DirectiveDefinition[]>>;
}

export interface ContentDocument extends ContentScope {
  readonly id: string;
  readonly typeName: string;
  readonly slug: string;
  readonly createdAt: string;
}

export interface ContentVariant extends ContentScope {
  readonly id: string;
  readonly documentId: string;
  readonly locale: string;
  readonly key: string;
  readonly createdAt: string;
}

export interface AstNodeDescriptor {
  readonly id: string;
  readonly type: string;
  readonly parentId?: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface ContentAst {
  readonly format: "navocms-markdown-ast/v1";
  readonly parser: "remark-gfm-directive";
  readonly sourceHash: string;
  readonly nodes: readonly AstNodeDescriptor[];
}

export interface RevisionProvenance {
  readonly kind: "human" | "agent" | "import" | "workflow";
  readonly actorId: string;
  readonly sourceArtifactHash?: string;
  readonly note?: string;
}

export interface ContentRevision extends ContentScope {
  readonly id: string;
  readonly documentId: string;
  readonly variantId: string;
  readonly number: number;
  readonly parentRevisionId?: string;
  readonly source: string;
  readonly sourceHash: string;
  readonly ast: ContentAst;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly provenance: RevisionProvenance;
  readonly createdAt: string;
}

export interface ContentRelation extends ContentScope {
  readonly id: string;
  readonly fromDocumentId: string;
  readonly toDocumentId: string;
  readonly kind: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type StructuralPatchOperation =
  | { readonly op: "replaceText"; readonly nodeId: string; readonly value: string }
  | { readonly op: "replaceNode"; readonly nodeId: string; readonly markdown: string }
  | { readonly op: "insertAfter"; readonly nodeId: string; readonly markdown: string }
  | { readonly op: "remove"; readonly nodeId: string };

export interface RevisionDiffLine {
  readonly kind: "context" | "add" | "remove";
  readonly line: string;
}

export interface RevisionDiff {
  readonly fromHash: string;
  readonly toHash: string;
  readonly lines: readonly RevisionDiffLine[];
}
