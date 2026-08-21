import { SecurityError } from "./errors.js";

const prohibitedKeys = /^(authorization|password|secret|secretvalue|token|accesstoken|refreshtoken|apikey|privatekey)$/i;

export function assertSafeProjection(value: unknown, path = "$"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeProjection(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object") {
    throw new SecurityError("PROJECTION_VALUE_INVALID", `Unsupported projection value at ${path}`);
  }
  for (const [key, nested] of Object.entries(value)) {
    if (prohibitedKeys.test(key.replaceAll("_", ""))) {
      throw new SecurityError("PROJECTION_SENSITIVE_FIELD", `Sensitive field rejected at ${path}.${key}`);
    }
    assertSafeProjection(nested, `${path}.${key}`);
  }
}
