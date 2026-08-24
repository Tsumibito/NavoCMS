import { existsSync, readFileSync } from "node:fs";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

import type {
  ContentTypeDefinition,
  DesignOverrideDefinition,
  DesignSystemDefinition,
  DesignToken,
  DesignTokenGroup,
  DomainEvent,
  MediaAsset,
  PluginManifest,
  SiteProfile
} from "./types.js";

const schemaFiles = {
  contentType: "content-type.schema.json",
  designOverride: "design-override.schema.json",
  designSystem: "design-system.schema.json",
  event: "event-envelope.schema.json",
  mediaAsset: "media-asset.schema.json",
  plugin: "plugin-manifest.schema.json",
  profile: "site-profile.schema.json"
} as const;
const MAX_VALIDATION_ISSUES = 20;

function readSchema(filename: string): object {
  const packagedUrl = new URL(`./schemas/${filename}`, import.meta.url);
  const location = existsSync(packagedUrl) ? packagedUrl : new URL(`../../../schemas/${filename}`, import.meta.url);
  return JSON.parse(readFileSync(location, "utf8")) as object;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? [])
    .slice(0, MAX_VALIDATION_ISSUES)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}

export class ContractValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(contract: string, issues: readonly string[]) {
    super(`Invalid ${contract}: ${issues.join("; ")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export class ContractValidator<T> {
  readonly #name: string;
  readonly #validate: ValidateFunction<T>;
  readonly #semantic: (value: T) => readonly string[];

  public constructor(
    name: string,
    validate: ValidateFunction<T>,
    semantic: (value: T) => readonly string[] = () => []
  ) {
    this.#name = name;
    this.#validate = validate;
    this.#semantic = semantic;
  }

  public is(value: unknown): value is T {
    return this.#validate(value) && this.#semantic(value).length === 0;
  }

  public parse(value: unknown): T {
    if (!this.#validate(value)) {
      throw new ContractValidationError(this.#name, formatErrors(this.#validate.errors));
    }
    const semanticIssues = this.#semantic(value).slice(0, MAX_VALIDATION_ISSUES);
    if (semanticIssues.length > 0) throw new ContractValidationError(this.#name, semanticIssues);
    return value;
  }
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].slice(0, MAX_VALIDATION_ISSUES);
}

function pluginSemantics(manifest: PluginManifest): string[] {
  const issues: string[] = [];
  const capabilityDuplicates = duplicates(
    manifest.spec.provides.map(({ name, version }) => `${name}@${version}`)
  );
  if (capabilityDuplicates.length > 0) {
    issues.push(`provided capabilities must be unique: ${capabilityDuplicates.join(", ")}`);
  }
  const effectDuplicates = duplicates(manifest.spec.effects.map(({ name }) => name));
  if (effectDuplicates.length > 0) issues.push(`effect names must be unique: ${effectDuplicates.join(", ")}`);
  for (const effect of manifest.spec.effects) {
    if (effect.consequence !== "G0" && !effect.idempotent) {
      issues.push(`effect ${effect.name} must be idempotent for ${effect.consequence}`);
    }
  }
  return issues;
}

function profileSemantics(profile: SiteProfile): string[] {
  const issues: string[] = [];
  if (!profile.spec.locales.supported.includes(profile.spec.locales.default)) {
    issues.push("default locale must be included in supported locales");
  }
  const pluginDuplicates = duplicates(profile.spec.plugins.map(({ id }) => id));
  if (pluginDuplicates.length > 0) issues.push(`plugin IDs must be unique: ${pluginDuplicates.join(", ")}`);
  const bindingDuplicates = duplicates(
    profile.spec.bindings.map(({ capability, version }) => `${capability}@${version}`)
  );
  if (bindingDuplicates.length > 0) {
    issues.push(`capability bindings must be unique: ${bindingDuplicates.join(", ")}`);
  }
  const enabled = new Set(profile.spec.plugins.filter(({ enabled: isEnabled }) => isEnabled).map(({ id }) => id));
  for (const binding of profile.spec.bindings) {
    if (!enabled.has(binding.provider)) issues.push(`bound provider ${binding.provider} is not enabled`);
  }
  return issues;
}

function contentTypeSemantics(contentType: ContentTypeDefinition): string[] {
  const issues: string[] = [];
  const relationNames = contentType.spec.relations
    .map((relation) => relation.name)
    .filter((name): name is string => typeof name === "string");
  const indexNames = contentType.spec.indexes
    .map((index) => index.name)
    .filter((name): name is string => typeof name === "string");
  const relationDuplicates = duplicates(relationNames);
  const indexDuplicates = duplicates(indexNames);
  if (relationDuplicates.length > 0) issues.push(`relation names must be unique: ${relationDuplicates.join(", ")}`);
  if (indexDuplicates.length > 0) issues.push(`index names must be unique: ${indexDuplicates.join(", ")}`);
  return issues;
}

function isDesignToken(value: DesignToken | DesignTokenGroup): value is DesignToken {
  return "$value" in value;
}

function designTokenPaths(group: DesignTokenGroup, prefix = ""): string[] {
  return Object.entries(group).flatMap(([name, value]) => {
    const path = prefix ? `${prefix}.${name}` : name;
    return isDesignToken(value) ? [path] : designTokenPaths(value, path);
  });
}

function variantIssues(owner: string, variants: readonly { name: string; values: readonly string[]; default: string }[]) {
  const issues: string[] = [];
  const duplicateNames = duplicates(variants.map(({ name }) => name));
  if (duplicateNames.length > 0) issues.push(`${owner} variant names must be unique: ${duplicateNames.join(", ")}`);
  for (const variant of variants) {
    if (!variant.values.includes(variant.default)) {
      issues.push(`${owner} variant ${variant.name} default must be one of its values`);
    }
  }
  return issues;
}

function designSystemSemantics(design: DesignSystemDefinition): string[] {
  const issues: string[] = [];
  const tokenPaths = new Set(designTokenPaths(design.spec.tokens));
  const componentIds = design.spec.components.map(({ id }) => id);
  const componentDuplicates = duplicates(componentIds);
  const recipeDuplicates = duplicates(design.spec.recipes.map(({ id }) => id));
  if (componentDuplicates.length > 0) issues.push(`component IDs must be unique: ${componentDuplicates.join(", ")}`);
  if (recipeDuplicates.length > 0) issues.push(`recipe IDs must be unique: ${recipeDuplicates.join(", ")}`);

  for (const component of design.spec.components) {
    issues.push(...variantIssues(`component ${component.id}`, component.variants));
    const slotDuplicates = duplicates(component.slots.map(({ name }) => name));
    if (slotDuplicates.length > 0) issues.push(`component ${component.id} slot names must be unique`);
  }

  const knownComponents = new Set(componentIds);
  for (const recipe of design.spec.recipes) {
    issues.push(...variantIssues(`recipe ${recipe.id}`, recipe.variants));
    const slotDuplicates = duplicates(recipe.slots.map(({ id }) => id));
    if (slotDuplicates.length > 0) issues.push(`recipe ${recipe.id} slot IDs must be unique`);
    for (const slot of recipe.slots) {
      if (!knownComponents.has(slot.component)) issues.push(`recipe ${recipe.id} references unknown component ${slot.component}`);
      if (slot.minItems > slot.maxItems) issues.push(`recipe ${recipe.id} slot ${slot.id} minItems exceeds maxItems`);
    }
  }

  for (const path of design.spec.overridePolicy.allowedTokenPaths) {
    if (!tokenPaths.has(path)) issues.push(`override policy references unknown token ${path}`);
  }
  for (const id of design.spec.overridePolicy.allowedComponentVariants) {
    if (!knownComponents.has(id)) issues.push(`override policy references unknown component ${id}`);
  }

  const viewportDuplicates = duplicates(design.spec.catalogue.viewports.map(({ name }) => name));
  if (viewportDuplicates.length > 0) issues.push(`catalogue viewport names must be unique`);
  return issues;
}

function eventSemantics(event: DomainEvent): string[] {
  if (event.navoconsequence !== "G0" && !event.navoidempotencykey) {
    return [`${event.navoconsequence} event requires navoidempotencykey`];
  }
  return [];
}

function mediaAssetSemantics(asset: MediaAsset): string[] {
  const issues: string[] = [];
  if (["verified", "processing", "ready"].includes(asset.spec.state) && !asset.spec.original) {
    issues.push("verified media requires an immutable original");
  }
  if (asset.spec.state === "rejected" && !asset.spec.rejectionReason) issues.push("rejected media requires a rejection reason");
  if (asset.spec.original) {
    const expectedKey = `tenants/${asset.metadata.tenantId}/sites/${asset.metadata.siteId}/originals/${asset.spec.original.sha256}`;
    if (asset.spec.original.storageKey !== expectedKey) issues.push("original key must exactly match tenant, site, and SHA-256");
  }
  return issues;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = (
  "default" in addFormatsModule ? addFormatsModule.default : addFormatsModule
) as unknown as FormatsPlugin;
addFormats(ajv);

export const contracts = {
  contentType: new ContractValidator<ContentTypeDefinition>(
    "content type",
    ajv.compile<ContentTypeDefinition>(readSchema(schemaFiles.contentType)),
    contentTypeSemantics
  ),
  designOverride: new ContractValidator<DesignOverrideDefinition>(
    "design override",
    ajv.compile<DesignOverrideDefinition>(readSchema(schemaFiles.designOverride))
  ),
  designSystem: new ContractValidator<DesignSystemDefinition>(
    "design system",
    ajv.compile<DesignSystemDefinition>(readSchema(schemaFiles.designSystem)),
    designSystemSemantics
  ),
  event: new ContractValidator<DomainEvent>(
    "event envelope",
    ajv.compile<DomainEvent>(readSchema(schemaFiles.event)),
    eventSemantics
  ),
  mediaAsset: new ContractValidator<MediaAsset>(
    "media asset",
    ajv.compile<MediaAsset>(readSchema(schemaFiles.mediaAsset)),
    mediaAssetSemantics
  ),
  plugin: new ContractValidator<PluginManifest>(
    "plugin manifest",
    ajv.compile<PluginManifest>(readSchema(schemaFiles.plugin)),
    pluginSemantics
  ),
  profile: new ContractValidator<SiteProfile>(
    "site profile",
    ajv.compile<SiteProfile>(readSchema(schemaFiles.profile)),
    profileSemantics
  )
} as const;
