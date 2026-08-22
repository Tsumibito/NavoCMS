import {
  NAVOCMS_PERMISSIONS,
  siteRoleAuthority,
  type AuthorizationContext,
  type Permission,
  type PrincipalKind,
  type SiteRole,
  type VerifiedAccessToken
} from "@navocms/security";

import type { PostgresDatabase } from "./database.js";

interface IdentityRow extends Record<string, unknown> {
  readonly principal_id: string;
  readonly principal_kind: PrincipalKind;
  readonly site_role: SiteRole;
  readonly membership_permissions: string[];
}

export interface DeploymentIdentityScope {
  readonly tenantId: string;
  readonly siteId: string;
}

export class PostgresIdentityResolver {
  readonly #database: PostgresDatabase;
  readonly #scope: DeploymentIdentityScope;

  public constructor(database: PostgresDatabase, scope: DeploymentIdentityScope) {
    this.#database = database;
    this.#scope = Object.freeze({ ...scope });
  }

  public async resolve(token: VerifiedAccessToken): Promise<AuthorizationContext> {
    if (token.tenantId !== this.#scope.tenantId || token.siteId !== this.#scope.siteId) {
      throw new Error("Verified token scope does not match this deployment");
    }
    const row = await this.#database.withScope({
      ...this.#scope,
      principalId: "00000000-0000-4000-8000-000000000000"
    }, async (client) => (await client.query<IdentityRow>(
      `SELECT principal_id, principal_kind, site_role, membership_permissions
         FROM navocms.resolve_site_identity($1, $2, $3, $4)`,
      [token.principal.issuer, token.principal.subject, this.#scope.tenantId, this.#scope.siteId]
    )).rows[0]);
    if (!row) throw new Error("OIDC identity is not a member of this NavoCMS site");
    const tokenPermissions = knownPermissions(token.scopes);
    const membershipPermissions = knownPermissions(row.membership_permissions);
    return Object.freeze({
      ...this.#scope,
      principal: Object.freeze({
        id: row.principal_id,
        kind: row.principal_kind,
        issuer: token.principal.issuer,
        subject: token.principal.subject
      }),
      layers: Object.freeze([
        Object.freeze({ name: "principal" as const, permissions: tokenPermissions }),
        siteRoleAuthority(row.site_role),
        ...(membershipPermissions.length > 0
          ? [Object.freeze({ name: "delegation" as const, permissions: membershipPermissions })]
          : []),
        Object.freeze({ name: "operation" as const, permissions: NAVOCMS_PERMISSIONS })
      ]),
      expiresAt: new Date(token.claims.exp * 1000).toISOString()
    });
  }
}

function knownPermissions(scopes: readonly string[]): readonly Permission[] {
  return Object.freeze(NAVOCMS_PERMISSIONS.filter((permission) => scopes.includes(permission)));
}
