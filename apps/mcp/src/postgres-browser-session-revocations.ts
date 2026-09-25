import { createHash } from "node:crypto";

import type { PostgresDatabase } from "@navocms/persistence-postgres";

import type { BrowserSessionRevocations } from "./http.js";

function digest(id: string): string { return createHash("sha256").update(id).digest("hex"); }

export class PostgresBrowserSessionRevocations implements BrowserSessionRevocations {
  readonly #database: PostgresDatabase;

  public constructor(database: PostgresDatabase) { this.#database = database; }

  public async isRevoked(session: { id: string; tenantId: string; siteId: string; principalId: string }): Promise<boolean> {
    return this.#database.withScope(session, async (client) => {
      const result = await client.query<{ revoked: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM navocms.browser_session_revocations
          WHERE tenant_id = $1 AND site_id = $2 AND session_hash = $3 AND expires_at > now()) AS revoked`,
        [session.tenantId, session.siteId, digest(session.id)]
      );
      return result.rows[0]?.revoked === true;
    });
  }

  public async revoke(session: { id: string; tenantId: string; siteId: string; principalId: string; expiresAt: number }): Promise<void> {
    await this.#database.withScope(session, async (client) => {
      await client.query(
        `DELETE FROM navocms.browser_session_revocations
          WHERE tenant_id = $1 AND site_id = $2 AND expires_at <= now()`,
        [session.tenantId, session.siteId]
      );
      await client.query(
        `INSERT INTO navocms.browser_session_revocations (tenant_id, site_id, session_hash, expires_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [session.tenantId, session.siteId, digest(session.id), new Date(session.expiresAt).toISOString()]
      );
    });
  }
}
