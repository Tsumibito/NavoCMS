import type { IssuerRolePermissions } from "@navocms/persistence-postgres";
import { NAVOCMS_PERMISSIONS, type Permission } from "@navocms/security";

export function environmentInteger(
  name: string,
  fallback: number,
  maximum: number,
  environment: Readonly<Record<string, string | undefined>> = process.env
): number {
  const value = environment[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

export function environmentRolePermissions(
  name: string,
  environment: Readonly<Record<string, string | undefined>> = process.env
): IssuerRolePermissions | undefined {
  const value = environment[name];
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON object`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 32) throw new Error(`${name} must contain 1 to 32 roles`);
  const mapped: Record<string, readonly Permission[]> = {};
  for (const [role, permissions] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(role)) throw new Error(`${name} contains an invalid role`);
    if (!Array.isArray(permissions) || permissions.length === 0 || permissions.length > NAVOCMS_PERMISSIONS.length ||
      permissions.some((permission) => typeof permission !== "string" || !NAVOCMS_PERMISSIONS.includes(permission as Permission))) {
      throw new Error(`${name} contains invalid permissions for ${role}`);
    }
    mapped[role] = Object.freeze([...new Set(permissions as Permission[])]);
  }
  return Object.freeze(mapped);
}
