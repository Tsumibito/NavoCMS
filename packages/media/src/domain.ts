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

export interface MediaRepository {
  createUploadIntent(scope: MediaScope, input: CreateUploadIntentInput): Promise<CreateUploadResult>;
  finalizeUpload(scope: MediaScope, input: FinalizeUploadInput): Promise<MediaAssetSummary>;
  getAsset(scope: MediaScope, assetId: string): Promise<MediaAssetSummary | undefined>;
  listAssets(scope: MediaScope, limit: number): Promise<readonly MediaAssetSummary[]>;
  createReference(scope: MediaScope, input: MediaReferenceInput): Promise<{ readonly id: string }>;
  removeReference(scope: MediaScope, referenceId: string, idempotencyKey: string): Promise<void>;
  rejectAsset(scope: MediaScope, input: RejectMediaAssetInput): Promise<MediaAssetSummary>;
}
