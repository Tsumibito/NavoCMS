import { createHash } from "node:crypto";

import {
  contracts,
  type DesignComponent,
  type DesignOverrideDefinition,
  type DesignRecipe,
  type DesignSystemDefinition,
  type DesignToken,
  type DesignTokenGroup,
  type DesignTokenValue
} from "@navocms/contracts";

import { DesignContractError } from "./errors.js";

export interface CompiledToken {
  readonly path: string;
  readonly type?: DesignToken["$type"];
  readonly description?: string;
  readonly source: DesignTokenValue;
  readonly value: DesignTokenValue;
  readonly cssVariable: string;
}

export interface CatalogueGroup {
  readonly name: string;
  readonly tokens: readonly CompiledToken[];
}

export interface CompiledDesignSystem {
  readonly definition: DesignSystemDefinition;
  readonly digest: `sha256:${string}`;
  readonly tokens: readonly CompiledToken[];
  readonly css: string;
  readonly components: ReadonlyMap<string, DesignComponent>;
  readonly recipes: ReadonlyMap<string, DesignRecipe>;
  readonly catalogue: {
    readonly groups: readonly CatalogueGroup[];
    readonly componentCount: number;
    readonly recipeCount: number;
  };
}

function isToken(value: DesignToken | DesignTokenGroup): value is DesignToken {
  return "$value" in value;
}

function flattenTokens(group: DesignTokenGroup, prefix = ""): Map<string, DesignToken> {
  const tokens = new Map<string, DesignToken>();
  for (const [name, value] of Object.entries(group)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (isToken(value)) tokens.set(path, value);
    else for (const [childPath, child] of flattenTokens(value, path)) tokens.set(childPath, child);
  }
  return tokens;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function tokenVariable(path: string): string {
  return `--navo-${path.replaceAll(".", "-").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`;
}

function resolveTokens(tokens: ReadonlyMap<string, DesignToken>): CompiledToken[] {
  const resolved = new Map<string, DesignTokenValue>();

  function resolve(path: string, trajectory: readonly string[]): DesignTokenValue {
    const cached = resolved.get(path);
    if (cached !== undefined) return cached;
    if (trajectory.includes(path)) {
      throw new DesignContractError("TOKEN_CYCLE", `Token reference cycle: ${[...trajectory, path].join(" -> ")}`);
    }
    const token = tokens.get(path);
    if (!token) throw new DesignContractError("TOKEN_REFERENCE_MISSING", `Unknown token reference: ${path}`);
    const reference = typeof token.$value === "string" ? /^\{([^}]+)\}$/.exec(token.$value) : null;
    const value = reference ? resolve(reference[1] ?? "", [...trajectory, path]) : token.$value;
    resolved.set(path, value);
    return value;
  }

  return [...tokens.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, token]) => ({
      path,
      ...(token.$type ? { type: token.$type } : {}),
      ...(token.$description ? { description: token.$description } : {}),
      source: token.$value,
      value: resolve(path, []),
      cssVariable: tokenVariable(path)
    }));
}

function cssValue(value: DesignTokenValue): string {
  if (typeof value === "object") return stableJson(value);
  return String(value);
}

function compileParsed(definition: DesignSystemDefinition): CompiledDesignSystem {
  const tokens = resolveTokens(flattenTokens(definition.spec.tokens));
  const groups = new Map<string, CompiledToken[]>();
  for (const token of tokens) {
    const group = token.path.split(".", 1)[0] ?? "other";
    groups.set(group, [...(groups.get(group) ?? []), token]);
  }
  const css = `:root {\n${tokens.map((token) => `  ${token.cssVariable}: ${cssValue(token.value)};`).join("\n")}\n}\n`;
  return {
    definition,
    digest: digest(definition),
    tokens,
    css,
    components: new Map(definition.spec.components.map((component) => [component.id, component])),
    recipes: new Map(definition.spec.recipes.map((recipe) => [recipe.id, recipe])),
    catalogue: {
      groups: [...groups.entries()].map(([name, groupTokens]) => ({ name, tokens: groupTokens })),
      componentCount: definition.spec.components.length,
      recipeCount: definition.spec.recipes.length
    }
  };
}

export function compileDesignSystem(input: unknown): CompiledDesignSystem {
  return compileParsed(contracts.designSystem.parse(input));
}

function setTokenValue(group: DesignTokenGroup, path: string, value: string | number | boolean): void {
  type MutableTokenGroup = { [name: string]: DesignToken | MutableTokenGroup };
  const segments = path.split(".");
  let current = group as MutableTokenGroup;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (!child || isToken(child)) throw new DesignContractError("OVERRIDE_DENIED", `Unknown token ${path}`);
    current = child;
  }
  const leaf = segments.at(-1) ?? "";
  const token = current[leaf];
  if (!token || !isToken(token)) throw new DesignContractError("OVERRIDE_DENIED", `Unknown token ${path}`);
  current[leaf] = { ...token, $value: value };
}

export function applyDesignOverride(
  designInput: unknown,
  overrideInput: unknown,
  now = new Date()
): CompiledDesignSystem {
  const design = contracts.designSystem.parse(designInput);
  const override = contracts.designOverride.parse(overrideInput) as DesignOverrideDefinition;
  if (
    override.spec.designSystem.name !== design.metadata.name ||
    override.spec.designSystem.version !== design.metadata.version
  ) {
    throw new DesignContractError("OVERRIDE_TARGET_MISMATCH", "Override targets a different design release");
  }
  if (override.spec.expiresAt && new Date(override.spec.expiresAt) <= now) {
    throw new DesignContractError("OVERRIDE_EXPIRED", "Design override has expired");
  }
  if (override.spec.expiresAt) {
    const createdAt = new Date(override.metadata.createdAt).getTime();
    const expiresAt = new Date(override.spec.expiresAt).getTime();
    const maximumDays = design.spec.overridePolicy.maxExpiryDays;
    if (expiresAt <= createdAt) {
      throw new DesignContractError("OVERRIDE_DENIED", "Design override expiry must follow its creation time");
    }
    if (maximumDays !== undefined && expiresAt - createdAt > maximumDays * 86_400_000) {
      throw new DesignContractError("OVERRIDE_DENIED", `Design override exceeds the ${maximumDays}-day limit`);
    }
  }

  const allowedTokens = new Set(design.spec.overridePolicy.allowedTokenPaths);
  for (const path of Object.keys(override.spec.tokens)) {
    if (!allowedTokens.has(path)) throw new DesignContractError("OVERRIDE_DENIED", `Token override denied: ${path}`);
  }
  const components = new Map(design.spec.components.map((component) => [component.id, component]));
  const allowedComponents = new Set(design.spec.overridePolicy.allowedComponentVariants);
  for (const [componentId, variants] of Object.entries(override.spec.componentVariants)) {
    const component = components.get(componentId);
    if (!component || !allowedComponents.has(componentId)) {
      throw new DesignContractError("OVERRIDE_DENIED", `Component override denied: ${componentId}`);
    }
    for (const [variantName, selected] of Object.entries(variants)) {
      const variant = component.variants.find(({ name }) => name === variantName);
      if (!variant?.values.includes(selected)) {
        throw new DesignContractError(
          "OVERRIDE_DENIED",
          `Invalid ${componentId}.${variantName} override: ${selected}`
        );
      }
    }
  }

  const clone = structuredClone(design) as DesignSystemDefinition;
  for (const [path, value] of Object.entries(override.spec.tokens)) setTokenValue(clone.spec.tokens, path, value);
  for (const [componentId, selections] of Object.entries(override.spec.componentVariants)) {
    const component = clone.spec.components.find(({ id }) => id === componentId);
    if (!component) continue;
    for (const [variantName, selected] of Object.entries(selections)) {
      const variant = component.variants.find(({ name }) => name === variantName);
      if (variant) (variant as { default: string }).default = selected;
    }
  }
  return compileParsed(clone);
}
