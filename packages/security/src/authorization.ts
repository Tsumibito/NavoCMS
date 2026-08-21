import { SecurityError } from "./errors.js";

export const NAVOCMS_PERMISSIONS = [
  "content:read",
  "content:draft",
  "content:publish",
  "leads:read",
  "site:admin",
  "plugins:admin",
  "secrets:use"
] as const;

export type Permission = (typeof NAVOCMS_PERMISSIONS)[number];
export type PrincipalKind = "human" | "agent" | "service";
export type SiteRole = "owner" | "admin" | "publisher" | "editor" | "viewer";

export const SITE_ROLE_PERMISSIONS: Readonly<Record<SiteRole, readonly Permission[]>> = Object.freeze({
  owner: NAVOCMS_PERMISSIONS,
  admin: NAVOCMS_PERMISSIONS,
  publisher: ["content:read", "content:draft", "content:publish", "leads:read"],
  editor: ["content:read", "content:draft"],
  viewer: ["content:read"]
});

export function siteRoleAuthority(role: SiteRole): AuthorityLayer {
  return Object.freeze({ name: "site", permissions: SITE_ROLE_PERMISSIONS[role] });
}

export interface Principal {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly issuer: string;
  readonly subject: string;
}

export interface ScopeBoundary {
  readonly tenantId: string;
  readonly siteId: string;
  readonly environmentId?: string;
}

export interface AuthorityLayer {
  readonly name: "principal" | "tenant" | "site" | "delegation" | "plugin" | "operation";
  readonly permissions: readonly Permission[];
}

export interface AuthorizationContext extends ScopeBoundary {
  readonly principal: Principal;
  readonly layers: readonly AuthorityLayer[];
  readonly delegatedBy?: string;
  readonly expiresAt?: string;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly permission: Permission;
  readonly effectivePermissions: readonly Permission[];
  readonly deniedBy?: AuthorityLayer["name"] | "expired";
}

export function effectivePermissions(layers: readonly AuthorityLayer[]): readonly Permission[] {
  if (layers.length === 0) return Object.freeze([]);
  const [first, ...rest] = layers;
  const allowed = new Set(first!.permissions);
  for (const layer of rest) {
    const layerPermissions = new Set(layer.permissions);
    for (const permission of allowed) {
      if (!layerPermissions.has(permission)) allowed.delete(permission);
    }
  }
  return Object.freeze(NAVOCMS_PERMISSIONS.filter((permission) => allowed.has(permission)));
}

export function authorize(
  context: AuthorizationContext,
  permission: Permission,
  now: Date = new Date()
): AuthorizationDecision {
  if (context.expiresAt && new Date(context.expiresAt).getTime() <= now.getTime()) {
    return Object.freeze({ allowed: false, permission, effectivePermissions: [], deniedBy: "expired" });
  }
  const effective = effectivePermissions(context.layers);
  if (effective.includes(permission)) return Object.freeze({ allowed: true, permission, effectivePermissions: effective });
  const deniedBy = context.layers.find((layer) => !layer.permissions.includes(permission))?.name;
  return Object.freeze({
    allowed: false,
    permission,
    effectivePermissions: effective,
    ...(deniedBy ? { deniedBy } : {})
  });
}

export function requirePermission(
  context: AuthorizationContext,
  permission: Permission,
  expectedScope?: Partial<ScopeBoundary>
): void {
  if (expectedScope?.tenantId && context.tenantId !== expectedScope.tenantId) {
    throw new SecurityError("SCOPE_TENANT_MISMATCH", "Principal is not authorized for this tenant");
  }
  if (expectedScope?.siteId && context.siteId !== expectedScope.siteId) {
    throw new SecurityError("SCOPE_SITE_MISMATCH", "Principal is not authorized for this site");
  }
  if (expectedScope?.environmentId && context.environmentId !== expectedScope.environmentId) {
    throw new SecurityError("SCOPE_ENVIRONMENT_MISMATCH", "Principal is not authorized for this environment");
  }
  const decision = authorize(context, permission);
  if (!decision.allowed) {
    throw new SecurityError("PERMISSION_DENIED", `Missing effective permission ${permission}`, {
      permission,
      deniedBy: decision.deniedBy
    });
  }
}
