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
