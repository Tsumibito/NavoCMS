import type { R2RuntimeBinding } from "@navocms/contracts";

import {
  selectR2Runtime,
  type R2DotenvxSecretBroker,
  type R2RuntimeReadinessExpectation,
  type R2RuntimeSelectionResult
} from "./r2-runtime.js";

/** Inputs a future R2 transport may consume. This module intentionally contains no transport. */
export interface R2TransportComposition {
  readonly selection: "r2";
  readonly endpoint: string;
  readonly bucket: string;
  readonly namespace: "navocms/v1/";
  readonly readiness: R2RuntimeSelectionResult["readiness"];
  readonly withAccessKey: <T>(operation: (value: string) => Promise<T>) => Promise<T>;
  readonly withSecretKey: <T>(operation: (value: string) => Promise<T>) => Promise<T>;
}

/**
 * Validates and composes the R2 credential seam without creating a client or making network I/O.
 * Secret values stay inside the dotenvx broker callback.
 */
export function composeR2Runtime(input: Readonly<{
  readonly requested: string | undefined;
  readonly runtimeMode: string;
  readonly environment: string;
  readonly binding: unknown;
  readonly expected: R2RuntimeReadinessExpectation;
  readonly secrets: R2DotenvxSecretBroker;
}>): R2TransportComposition | undefined {
  const selected = selectR2Runtime(input);
  if (!selected) return undefined;
  return composeSelectedR2Runtime(selected);
}

export function composeSelectedR2Runtime(selected: R2RuntimeSelectionResult): R2TransportComposition {
  const binding: R2RuntimeBinding = selected.binding;
  return Object.freeze({
    selection: "r2",
    endpoint: binding.endpoint,
    bucket: binding.bucket,
    namespace: binding.namespace,
    readiness: selected.readiness,
    withAccessKey: <T>(operation: (value: string) => Promise<T>) => selected.secrets.use(binding.accessKeySecretRef, operation),
    withSecretKey: <T>(operation: (value: string) => Promise<T>) => selected.secrets.use(binding.secretKeySecretRef, operation)
  });
}
