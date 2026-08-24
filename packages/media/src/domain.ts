export type MediaState = "pending" | "quarantined" | "verified" | "processing" | "ready" | "rejected" | "deleted";
export type MediaActorKind = "human" | "agent" | "service";

export interface MediaScope {
  readonly tenantId: string;
  readonly siteId: string;
  readonly principalId: string;
  readonly principalKind: MediaActorKind;
}

export interface MediaAssetSummary {
  readonly id: string;
  readonly state: MediaState;
  readonly sha256?: string;
  readonly mediaType?: "image/jpeg" | "image/png";
  readonly byteSize?: number;
  readonly width?: number;
  readonly height?: number;
  readonly rejectionReason?: string;
  readonly createdAt: string;
}

export interface MediaReferenceSummary {
  readonly id: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly purpose: string;
  readonly createdAt: string;
}

export interface MediaAssetReview extends MediaAssetSummary {
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly rights: Readonly<Record<string, unknown>>;
  readonly references: readonly MediaReferenceSummary[];
  readonly variants: readonly MediaVariantSummary[];
}

export type VariantMediaType = "image/avif" | "image/webp" | "image/jpeg";
export interface MediaVariantSummary {
  readonly id: string;
  readonly variantIdentity: string;
  readonly sha256: string;
  readonly storageKey: string;
  readonly byteSize: number;
  readonly mediaType: VariantMediaType;
  readonly width: number;
  readonly height: number;
  readonly presetId: string;
  readonly presetVersion: string;
  readonly transform: Readonly<Record<string, unknown>>;
}

export interface GenerateMediaVariantInput {
  readonly assetId: string;
  readonly idempotencyKey: string;
  readonly presetId: string;
  readonly presetVersion: string;
  readonly width: number;
  readonly format: VariantMediaType;
  readonly crop?: "center" | "focal";
  readonly focalPoint?: Readonly<{ x: number; y: number }>;
}

export interface MediaAssetPage {
  readonly assets: readonly MediaAssetSummary[];
  readonly nextCursor?: string;
}

export interface MediaReferencePage {
  readonly references: readonly MediaReferenceSummary[];
  readonly nextCursor?: string;
}

export interface CreateUploadIntentInput {
  readonly idempotencyKey: string;
  readonly expectedSha256: string;
  readonly expectedSize: number;
  readonly expectedMediaType?: "image/jpeg" | "image/png";
  readonly expiresAt: string;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly rights: Readonly<Record<string, unknown>>;
}

export interface UploadIntentResult {
  readonly kind: "upload-intent";
  readonly asset: MediaAssetSummary;
  readonly intentId: string;
  readonly storageKey: string;
  readonly expiresAt: string;
}

export interface DeduplicatedUploadResult {
  readonly kind: "deduplicated";
  readonly asset: MediaAssetSummary;
}

export type CreateUploadResult = UploadIntentResult | DeduplicatedUploadResult;

export interface FinalizeUploadInput {
  readonly intentId: string;
  readonly idempotencyKey: string;
  /** The bounded temporary key that this repository reads and verifies. */
  readonly uploadedStorageKey: string;
}

/**
 * Remote ingest never accepts binary payloads from a caller. The fetched
 * resource is re-validated and then routed through upload-intent finalization.
 */
export interface RemoteMediaIngestInput {
  readonly sourceUrl: string;
  readonly idempotencyKey: string;
  readonly receivedAt: string;
  readonly rights: Readonly<Record<string, unknown>>;
}

export interface RemoteMediaIngestor {
  ingestRemote(scope: MediaScope, input: RemoteMediaIngestInput): Promise<MediaAssetSummary>;
}

export interface MediaReferenceInput {
  readonly assetId: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly purpose: string;
  readonly idempotencyKey: string;
}

export interface RejectMediaAssetInput {
  readonly assetId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface ScheduleMediaDeleteInput {
  readonly assetId: string;
  readonly idempotencyKey: string;
}

export interface MediaLifecycleInput {
  readonly assetId: string;
  readonly idempotencyKey: string;
}

export interface ReconcileMediaInput {
  readonly idempotencyKey: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface MediaReconciliationResult {
  readonly inspected: number;
  readonly orphanedStorageObjects: number;
  readonly missingStorageObjects: number;
  readonly nextCursor?: string;
}

export interface MediaRepository {
  createUploadIntent(scope: MediaScope, input: CreateUploadIntentInput): Promise<CreateUploadResult>;
  finalizeUpload(scope: MediaScope, input: FinalizeUploadInput): Promise<MediaAssetSummary>;
  getAsset(scope: MediaScope, assetId: string): Promise<MediaAssetSummary | undefined>;
  getAssetReview(scope: MediaScope, assetId: string, referenceLimit: number): Promise<MediaAssetReview | undefined>;
  listAssets(scope: MediaScope, limit: number, cursor?: string): Promise<MediaAssetPage>;
  listReferences(scope: MediaScope, assetId: string, limit: number, cursor?: string): Promise<MediaReferencePage>;
  createReference(scope: MediaScope, input: MediaReferenceInput): Promise<{ readonly id: string }>;
  removeReference(scope: MediaScope, referenceId: string, idempotencyKey: string): Promise<void>;
  rejectAsset(scope: MediaScope, input: RejectMediaAssetInput): Promise<MediaAssetSummary>;
  scheduleDelete(scope: MediaScope, input: ScheduleMediaDeleteInput): Promise<MediaAssetSummary>;
  recoverableDelete(scope: MediaScope, input: MediaLifecycleInput): Promise<void>;
  restore(scope: MediaScope, input: MediaLifecycleInput): Promise<MediaAssetSummary>;
  reclaim(scope: MediaScope, input: MediaLifecycleInput): Promise<void>;
  reconcile(scope: MediaScope, input: ReconcileMediaInput): Promise<MediaReconciliationResult>;
  generateVariant(scope: MediaScope, input: GenerateMediaVariantInput): Promise<MediaVariantSummary>;
}
