const SECRET_REFERENCE = /^secret:[A-Za-z0-9][A-Za-z0-9._/-]{2,159}$/;

export interface DotenvxSecretBroker {
  readonly assertAvailable: (reference: string) => void;
  readonly use: <T>(reference: string, operation: (value: string) => Promise<T>) => Promise<T>;
}

export function dotenvxSecretEnvironmentKey(reference: string): string {
  if (!SECRET_REFERENCE.test(reference)) throw new Error("Secret reference is invalid");
  return `DOTENVX_SECRET_${reference.slice("secret:".length).replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

export function createDotenvxSecretBroker(environment: Readonly<Record<string, string | undefined>> = process.env): DotenvxSecretBroker {
  const value = (reference: string): string => {
    const secret = environment[dotenvxSecretEnvironmentKey(reference)];
    if (!secret || secret.trim().length < 16 || secret.length > 4096) throw new Error("Required secret reference is unavailable");
    return secret;
  };
  return Object.freeze({
    assertAvailable(reference: string): void { value(reference); },
    async use<T>(reference: string, operation: (secret: string) => Promise<T>): Promise<T> { return operation(value(reference)); }
  });
}
