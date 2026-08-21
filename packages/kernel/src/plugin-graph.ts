import { contracts, type PluginManifest, type SiteProfile } from "@navocms/contracts";

import { capabilityKey } from "./capabilities.js";
import { KernelError } from "./errors.js";

export interface ResolvedPlugin {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly dependencies: readonly string[];
}

export interface ResolvedPluginGraph {
  readonly profile: SiteProfile;
  readonly plugins: readonly ResolvedPlugin[];
  readonly activationOrder: readonly string[];
  readonly bindings: Readonly<Record<string, string>>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string, code: string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (result.has(key)) throw new KernelError(code, `Duplicate ${label}: ${key}`, { [label]: key });
    result.set(key, item);
  }
  return result;
}

function topologicalOrder(dependencies: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const order: string[] = [];

  function visit(pluginId: string, path: readonly string[]): void {
    if (permanent.has(pluginId)) return;
    if (temporary.has(pluginId)) {
      const cycleStart = path.indexOf(pluginId);
      const cycle = [...path.slice(cycleStart), pluginId];
      throw new KernelError("PLUGIN_DEPENDENCY_CYCLE", `Plugin dependency cycle: ${cycle.join(" -> ")}`, {
        cycle
      });
    }
    temporary.add(pluginId);
    for (const dependency of dependencies.get(pluginId) ?? []) visit(dependency, [...path, pluginId]);
    temporary.delete(pluginId);
    permanent.add(pluginId);
    order.push(pluginId);
  }

  for (const pluginId of dependencies.keys()) visit(pluginId, []);
  return order;
}

export function resolvePluginGraph(profileInput: unknown, manifestInputs: readonly unknown[]): ResolvedPluginGraph {
  const profile = deepFreeze(contracts.profile.parse(structuredClone(profileInput)));
  const manifests = manifestInputs.map((manifest) =>
    deepFreeze(contracts.plugin.parse(structuredClone(manifest)))
  );
  const manifestsById = uniqueBy(
    manifests,
    (manifest) => manifest.metadata.id,
    "PLUGIN_MANIFEST_DUPLICATE",
    "plugin"
  );
  const profilePlugins = uniqueBy(
    profile.spec.plugins,
    (plugin) => plugin.id,
    "PROFILE_PLUGIN_DUPLICATE",
    "profilePlugin"
  );
  const enabledPlugins = new Map([...profilePlugins].filter(([, plugin]) => plugin.enabled));

  for (const [pluginId, installation] of enabledPlugins) {
    const manifest = manifestsById.get(pluginId);
    if (!manifest) {
      throw new KernelError("PLUGIN_MANIFEST_MISSING", `Enabled plugin ${pluginId} has no manifest`, { pluginId });
    }
    if (manifest.metadata.version !== installation.version) {
      throw new KernelError(
        "PLUGIN_VERSION_MISMATCH",
        `Profile pins ${pluginId}@${installation.version}, manifest is ${manifest.metadata.version}`,
        { pluginId, profileVersion: installation.version, manifestVersion: manifest.metadata.version }
      );
    }
  }

  const bindings = uniqueBy(
    profile.spec.bindings,
    (binding) => capabilityKey({ name: binding.capability, version: binding.version }),
    "CAPABILITY_BINDING_DUPLICATE",
    "binding"
  );

  for (const [key, binding] of bindings) {
    const installation = enabledPlugins.get(binding.provider);
    const manifest = manifestsById.get(binding.provider);
    if (!installation || !manifest) {
      throw new KernelError("CAPABILITY_PROVIDER_DISABLED", `Bound provider ${binding.provider} is not enabled`, {
        capability: key,
        provider: binding.provider
      });
    }
    const provides = manifest.spec.provides.some(
      (capability) => capability.name === binding.capability && capability.version === binding.version
    );
    if (!provides) {
      throw new KernelError(
        "CAPABILITY_PROVIDER_INCOMPATIBLE",
        `Plugin ${binding.provider} does not provide ${key}`,
        { capability: key, provider: binding.provider }
      );
    }
  }

  const dependencyMap = new Map<string, Set<string>>();
  for (const [pluginId] of enabledPlugins) dependencyMap.set(pluginId, new Set());

  for (const [pluginId] of enabledPlugins) {
    const manifest = manifestsById.get(pluginId)!;
    for (const requirement of manifest.spec.requires) {
      const key = capabilityKey(requirement);
      const binding = bindings.get(key);
      if (!binding) {
        if (requirement.optional === true) continue;
        throw new KernelError("CAPABILITY_BINDING_MISSING", `Plugin ${pluginId} requires unbound ${key}`, {
          pluginId,
          capability: key
        });
      }
      if (binding.provider !== pluginId) dependencyMap.get(pluginId)!.add(binding.provider);
    }
  }

  const activationOrder = topologicalOrder(dependencyMap);
  const plugins = activationOrder.map((id) =>
    Object.freeze({
      id,
      manifest: manifestsById.get(id)!,
      dependencies: Object.freeze([...dependencyMap.get(id)!])
    })
  );
  const bindingSnapshot = Object.freeze(
    Object.fromEntries([...bindings].map(([key, binding]) => [key, binding.provider]))
  );

  return Object.freeze({
    profile,
    plugins: Object.freeze(plugins),
    activationOrder: Object.freeze(activationOrder),
    bindings: bindingSnapshot
  });
}
