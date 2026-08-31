import type {
  CreateUploadIntentInput,
  FinalizeUploadInput,
  GenerateMediaVariantInput,
  MediaReferenceInput,
  MediaRepository,
  RejectMediaAssetInput
} from "@navocms/media";
import { assertSafeProjection, requirePermission } from "@navocms/security";

import { McpEditingError } from "./errors.js";
import type { McpRequestContext } from "./model.js";

export class McpMediaService {
  readonly #repository: MediaRepository;
  readonly #storageInjected: boolean;

  public constructor(repository: MediaRepository, options: { readonly storageInjected: boolean }) {
    this.#repository = repository;
    this.#storageInjected = options.storageInjected;
  }

  public get storageInjected(): boolean { return this.#storageInjected; }

  public async list(context: McpRequestContext, limit: number, cursor?: string): Promise<object> {
    const page = await this.#repository.listAssets(this.scope(context, "media:read"), limit, cursor);
    return project({ ...page, count: page.assets.length, limit });
  }

  public async get(context: McpRequestContext, assetId: string, referenceLimit: number): Promise<object> {
    const asset = await this.#repository.getAssetReview(this.scope(context, "media:read"), assetId, referenceLimit);
    if (!asset) throw new McpEditingError("MEDIA_NOT_FOUND", "Media asset was not found in the authorized site");
    return project(asset);
  }

  public async references(context: McpRequestContext, assetId: string, limit: number, cursor?: string): Promise<object> {
    const page = await this.#repository.listReferences(this.scope(context, "media:read"), assetId, limit, cursor);
    return project({ assetId, ...page, count: page.references.length, limit });
  }

  public async prepare(context: McpRequestContext, input: McpCreateUploadIntentInput): Promise<object> {
    const scope = this.writeScope(context);
    const result = await this.#repository.createUploadIntent(scope, {
      ...input,
      provenance: { ...input.provenance, receivedBy: scope.principalId }
    });
    return project(result);
  }

  public async finalize(context: McpRequestContext, input: FinalizeUploadInput): Promise<object> {
    return project(await this.#repository.finalizeUpload(this.writeScope(context), input));
  }

  public async generateVariant(context: McpRequestContext, input: GenerateMediaVariantInput): Promise<object> {
    return project(await this.#repository.generateVariant(this.writeScope(context), input));
  }

  public async reject(context: McpRequestContext, input: RejectMediaAssetInput): Promise<object> {
    return project(await this.#repository.rejectAsset(this.writeScope(context), input));
  }

  public async createReference(context: McpRequestContext, input: MediaReferenceInput): Promise<object> {
    return project(await this.#repository.createReference(this.writeScope(context), input));
  }

  public async removeReference(context: McpRequestContext, referenceId: string, idempotencyKey: string): Promise<object> {
    await this.#repository.removeReference(this.writeScope(context), referenceId, idempotencyKey);
    return project({ referenceId, removed: true });
  }

  private scope(context: McpRequestContext, permission: "media:read" | "media:write") {
    requirePermission(context.authorization, permission);
    return Object.freeze({
      tenantId: context.authorization.tenantId,
      siteId: context.authorization.siteId,
      principalId: context.authorization.principal.id,
      principalKind: context.authorization.principal.kind
    });
  }

  private writeScope(context: McpRequestContext) {
    const scope = this.scope(context, "media:write");
    if (!this.#storageInjected) throw new McpEditingError("MEDIA_STORAGE_UNAVAILABLE", "No media storage capability is injected for this deployment");
    return scope;
  }
}

export type McpCreateUploadIntentInput = Omit<CreateUploadIntentInput, "provenance"> & {
  readonly provenance: {
    readonly kind: "upload" | "remote-ingest" | "import";
    readonly sourceUrl?: string;
    readonly receivedAt: string;
  };
};

function project<T extends object>(value: T): T {
  assertSafeProjection(value);
  return Object.freeze(structuredClone(value));
}
