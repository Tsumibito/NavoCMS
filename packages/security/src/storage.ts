import { SecurityError } from "./errors.js";

export interface ObjectScope {
  readonly tenantId: string;
  readonly siteId: string;
  readonly environmentId: string;
}

const safeSegment = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function segment(value: string, label: string): string {
  if (!safeSegment.test(value) || value === "." || value === "..") {
    throw new SecurityError("OBJECT_KEY_SEGMENT_INVALID", `Invalid ${label} segment`);
  }
  return value;
}

export function objectPrefix(scope: ObjectScope): string {
  return [
    "tenants",
    segment(scope.tenantId, "tenant"),
    "sites",
    segment(scope.siteId, "site"),
    "environments",
    segment(scope.environmentId, "environment")
  ].join("/");
}

export function scopedObjectKey(scope: ObjectScope, relativeKey: string): string {
  if (relativeKey.startsWith("/") || relativeKey.includes("\\") || relativeKey.includes("%")) {
    throw new SecurityError("OBJECT_KEY_INVALID", "Object key must be an unescaped relative path");
  }
  const parts = relativeKey.split("/");
  if (parts.length === 0 || parts.some((part) => !safeSegment.test(part) || part === "." || part === "..")) {
    throw new SecurityError("OBJECT_KEY_INVALID", "Object key contains an unsafe path segment");
  }
  return `${objectPrefix(scope)}/${parts.join("/")}`;
}

export function assertObjectKeyScope(scope: ObjectScope, key: string): void {
  const prefix = `${objectPrefix(scope)}/`;
  if (!key.startsWith(prefix)) throw new SecurityError("OBJECT_SCOPE_MISMATCH", "Object belongs to another scope");
}
