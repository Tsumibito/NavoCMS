import { randomBytes } from "node:crypto";
import { sha256, verifyUpload, inspectMedia, type MediaScope, type MediaStorage, type MediaRepository } from "@navocms/media";
import type { PostgresDatabase } from "@navocms/persistence-postgres";

/** Upload capabilities are database-backed, bounded and scoped; bytes never pass through MCP. */
export class MediaUploadGateway {
  public constructor(private readonly database: PostgresDatabase, private readonly storage: MediaStorage,
    private readonly repository: MediaRepository, private readonly runtimeScope: MediaScope, private readonly origin: string) {}

  public async create(scope: MediaScope, intentId: string, expiresAt: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const expiry = new Date(Math.min(new Date(expiresAt).getTime(), Date.now() + 3_600_000)).toISOString();
    await this.database.withScope(scope, client => client.query(
      `INSERT INTO navocms.media_upload_sessions (token_hash,tenant_id,site_id,intent_id,principal_id,expires_at,principal_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [sha256(token), scope.tenantId, scope.siteId, intentId, scope.principalId, expiry, scope.principalKind]
    ));
    return `${this.origin}/uploads/${token}`;
  }

  public async receive(token: string, bytes: Uint8Array): Promise<object> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("UPLOAD_SESSION_INVALID");
    const row = await this.database.withScope(this.runtimeScope, async client => (await client.query<{
      principal_id: string; principal_kind: MediaScope['principalKind']; intent_id: string; expected_sha256: string; expected_size: number; expected_media_type: string | null; storage_key: string;
    }>(
      `SELECT s.principal_id,s.principal_kind,s.intent_id,i.expected_sha256,i.expected_size,i.expected_media_type,i.storage_key
       FROM navocms.media_upload_sessions s JOIN navocms.media_upload_intents i
       ON i.tenant_id=s.tenant_id AND i.site_id=s.site_id AND i.id=s.intent_id
       WHERE s.tenant_id=$1 AND s.site_id=$2 AND s.token_hash=$3 AND s.expires_at>now() AND i.expires_at>now()`,
      [this.runtimeScope.tenantId, this.runtimeScope.siteId, sha256(token)]
    )).rows[0]);
    if (!row) throw new Error("UPLOAD_SESSION_EXPIRED");
    const mediaType = verifyUpload(bytes, { sha256: row.expected_sha256, byteSize: Number(row.expected_size), ...(row.expected_media_type ? { mediaType: row.expected_media_type } : {}) });
    inspectMedia(bytes, mediaType);
    await this.storage.putImmutable({ key: row.storage_key, bytes, mediaType });
    const scope = { ...this.runtimeScope, principalId: row.principal_id, principalKind: row.principal_kind };
    const asset = await this.repository.finalizeUpload(scope, { intentId: row.intent_id, uploadedStorageKey: row.storage_key, idempotencyKey: `upload-session:${row.intent_id}` });
    for (const [width, format] of [[320,"image/webp"], [640,"image/webp"], [640,"image/jpeg"]] as const) {
      await this.repository.generateVariant(scope, { assetId: asset.id, presetId: "responsive", presetVersion: "v1", width, format, idempotencyKey: `responsive:${asset.id}:${width}:${format}` });
    }
    return { assetId: asset.id, state: asset.state, responsiveVariants: 3 };
  }
}
