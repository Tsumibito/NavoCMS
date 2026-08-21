import type { PluginManifest, SiteProfile } from "@navocms/contracts";

import { CapabilityRegistry, type Disposable } from "./capabilities.js";
import { KernelError } from "./errors.js";
import { resolvePluginGraph, type ResolvedPluginGraph } from "./plugin-graph.js";

export interface PluginHealth {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface PluginActivationContext {
  readonly manifest: PluginManifest;
  readonly capabilities: CapabilityRegistry;
  track(disposable: Disposable): void;
}

export interface PluginRuntime {
  readonly pluginId: string;
  health(): Promise<PluginHealth>;
  activate(context: PluginActivationContext): Promise<void | Disposable>;
}

export type PluginHostState = "idle" | "booting" | "healthy" | "failed" | "stopping" | "stopped";

class ActivationScope implements Disposable {
  readonly #disposables: Disposable[] = [];

  public track(disposable: Disposable): void {
    this.#disposables.push(disposable);
  }

  public async dispose(): Promise<void> {
    const errors: unknown[] = [];
    for (const disposable of this.#disposables.reverse()) {
      try {
        await disposable.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#disposables.length = 0;
    if (errors.length > 0) throw new AggregateError(errors, "Plugin activation cleanup failed");
  }
}

export class PluginHost {
  readonly #capabilities = new CapabilityRegistry();
  readonly #active: { pluginId: string; scope: ActivationScope }[] = [];
  #state: PluginHostState = "idle";
  #graph: ResolvedPluginGraph | undefined;
  #failure: Error | undefined;

  public get state(): PluginHostState {
    return this.#state;
  }

  public get capabilities(): CapabilityRegistry {
    return this.#capabilities;
  }

  public status(): Readonly<{
    state: PluginHostState;
    activePlugins: readonly string[];
    profile?: string;
    failure?: string;
  }> {
    return Object.freeze({
      state: this.#state,
      activePlugins: Object.freeze(this.#active.map(({ pluginId }) => pluginId)),
      ...(this.#graph
        ? { profile: `${this.#graph.profile.metadata.name}@${this.#graph.profile.metadata.version}` }
        : {}),
      ...(this.#failure ? { failure: this.#failure.message } : {})
    });
  }

  public async boot(
    profile: SiteProfile | unknown,
    manifests: readonly (PluginManifest | unknown)[],
    runtimes: readonly PluginRuntime[]
  ): Promise<ResolvedPluginGraph> {
    if (!["idle", "stopped"].includes(this.#state)) {
      throw new KernelError("PLUGIN_HOST_STATE", `Cannot boot plugin host from ${this.#state}`);
    }
    this.#state = "booting";
    this.#failure = undefined;
    this.#graph = undefined;

    try {
      const graph = resolvePluginGraph(profile, manifests);
      const runtimeById = new Map(runtimes.map((runtime) => [runtime.pluginId, runtime]));
      if (runtimeById.size !== runtimes.length) {
        throw new KernelError("PLUGIN_RUNTIME_DUPLICATE", "Plugin runtime IDs must be unique");
      }
      for (const pluginId of graph.activationOrder) {
        if (!runtimeById.has(pluginId)) {
          throw new KernelError("PLUGIN_RUNTIME_MISSING", `Plugin ${pluginId} has no runtime`, { pluginId });
        }
      }

      for (const pluginId of graph.activationOrder) {
        const health = await runtimeById.get(pluginId)!.health();
        if (!health.ok) {
          throw new KernelError("PLUGIN_UNHEALTHY", `Plugin ${pluginId} is unhealthy: ${health.detail ?? "unknown"}`, {
            pluginId,
            detail: health.detail ?? "unknown"
          });
        }
      }

      this.#graph = graph;
      for (const pluginId of graph.activationOrder) {
        const runtime = runtimeById.get(pluginId)!;
        const manifest = graph.plugins.find((plugin) => plugin.id === pluginId)!.manifest;
        const scope = new ActivationScope();
        try {
          const disposable = await runtime.activate({
            manifest,
            capabilities: this.#capabilities,
            track: (tracked) => scope.track(tracked)
          });
          if (disposable) scope.track(disposable);
          this.#active.push({ pluginId, scope });
        } catch (error) {
          await scope.dispose();
          throw error;
        }
      }
      this.#state = "healthy";
      return graph;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      try {
        await this.#disposeActive();
      } catch (cleanupError) {
        this.#failure = new AggregateError([failure, cleanupError], "Plugin boot and cleanup failed");
        this.#state = "failed";
        throw this.#failure;
      }
      this.#failure = failure;
      this.#state = "failed";
      throw failure;
    }
  }

  public async shutdown(): Promise<void> {
    if (["idle", "stopped"].includes(this.#state)) return;
    if (this.#state === "booting") {
      throw new KernelError("PLUGIN_HOST_STATE", "Cannot shut down the plugin host while boot is in progress");
    }
    this.#state = "stopping";
    try {
      await this.#disposeActive();
      this.#state = "stopped";
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
      this.#state = "failed";
      throw this.#failure;
    }
  }

  async #disposeActive(): Promise<void> {
    const errors: unknown[] = [];
    for (const active of this.#active.reverse()) {
      try {
        await active.scope.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#active.length = 0;
    if (errors.length > 0) throw new AggregateError(errors, "Plugin shutdown failed");
  }
}
