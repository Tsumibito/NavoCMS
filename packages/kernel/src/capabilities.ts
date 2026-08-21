import type { CapabilityRef } from "@navocms/contracts";

import { KernelError } from "./errors.js";

export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface CapabilityDefinition extends CapabilityRef {
  readonly owner: string;
  readonly description: string;
}

export interface CapabilityProvider<T = unknown> extends CapabilityRef {
  readonly pluginId: string;
  readonly value: T;
}

export function capabilityKey(capability: CapabilityRef): string {
  return `${capability.name}@${capability.version}`;
}

export class CapabilityRegistry {
  readonly #definitions = new Map<string, CapabilityDefinition>();
  readonly #providers = new Map<string, Map<string, CapabilityProvider>>();

  public registerDefinition(definition: CapabilityDefinition): Disposable {
    const key = capabilityKey(definition);
    if (this.#definitions.has(key)) {
      throw new KernelError("CAPABILITY_DEFINITION_DUPLICATE", `Capability definition ${key} already exists`, {
        capability: key
      });
    }
    this.#definitions.set(key, Object.freeze({ ...definition }));
    return {
      dispose: () => {
        this.#definitions.delete(key);
        this.#providers.delete(key);
      }
    };
  }

  public registerProvider<T>(provider: CapabilityProvider<T>): Disposable {
    const key = capabilityKey(provider);
    if (!this.#definitions.has(key)) {
      throw new KernelError("CAPABILITY_DEFINITION_MISSING", `Capability ${key} has no registered definition`, {
        capability: key,
        provider: provider.pluginId
      });
    }
    const providers = this.#providers.get(key) ?? new Map<string, CapabilityProvider>();
    if (providers.has(provider.pluginId)) {
      throw new KernelError(
        "CAPABILITY_PROVIDER_DUPLICATE",
        `Plugin ${provider.pluginId} already provides ${key}`,
        { capability: key, provider: provider.pluginId }
      );
    }
    providers.set(provider.pluginId, Object.freeze({ ...provider }));
    this.#providers.set(key, providers);
    return {
      dispose: () => {
        providers.delete(provider.pluginId);
        if (providers.size === 0) this.#providers.delete(key);
      }
    };
  }

  public resolve<T>(capability: CapabilityRef, pluginId: string): T {
    const key = capabilityKey(capability);
    const provider = this.#providers.get(key)?.get(pluginId);
    if (!provider) {
      throw new KernelError("CAPABILITY_PROVIDER_MISSING", `Provider ${pluginId} is not active for ${key}`, {
        capability: key,
        provider: pluginId
      });
    }
    return provider.value as T;
  }

  public snapshot(): Readonly<{
    definitions: readonly CapabilityDefinition[];
    providers: readonly Omit<CapabilityProvider, "value">[];
  }> {
    const definitions = [...this.#definitions.values()].map((entry) => Object.freeze({ ...entry }));
    const providers = [...this.#providers.values()]
      .flatMap((entries) => [...entries.values()])
      .map(({ name, version, pluginId }) => Object.freeze({ name, version, pluginId }));
    return Object.freeze({ definitions: Object.freeze(definitions), providers: Object.freeze(providers) });
  }
}
