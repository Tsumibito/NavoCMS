import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = process.cwd();
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function listJsonFiles(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listJsonFiles(relative)));
    else if (entry.name.endsWith(".json")) files.push(relative);
  }
  return files.sort();
}

const schemaPaths = {
  plugin: "schemas/plugin-manifest.schema.json",
  profile: "schemas/site-profile.schema.json",
  contentType: "schemas/content-type.schema.json",
  designOverride: "schemas/design-override.schema.json",
  designSystem: "schemas/design-system.schema.json",
  event: "schemas/event-envelope.schema.json",
  mediaAsset: "schemas/media-asset.schema.json",
  astroArtifact: "schemas/astro-artifact-manifest.schema.json",
  cloudflareArtifactReference: "schemas/cloudflare-artifact-reference.schema.json",
  cloudflareStagingBinding: "schemas/cloudflare-staging-binding.schema.json"
};

const validators = {};
for (const [name, schemaPath] of Object.entries(schemaPaths)) {
  const schema = await readJson(schemaPath);
  validators[name] = ajv.compile(schema);
}

function formatErrors(errors) {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function unique(values, label) {
  assert(new Set(values).size === values.length, `${label} must be unique`);
}

function semanticProfile(document, file) {
  const { locales, plugins, bindings } = document.spec;
  assert(locales.supported.includes(locales.default), `${file}: default locale must be supported`);
  unique(plugins.map((plugin) => plugin.id), `${file}: plugin IDs`);
  unique(
    bindings.map((binding) => `${binding.capability}@${binding.version}`),
    `${file}: capability bindings`
  );
  const enabled = new Set(plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id));
  for (const binding of bindings) {
    assert(enabled.has(binding.provider), `${file}: provider ${binding.provider} is not enabled`);
  }
}

function semanticPlugin(document, file) {
  unique(
    document.spec.provides.map((capability) => `${capability.name}@${capability.version}`),
    `${file}: provided capabilities`
  );
  unique(document.spec.effects.map((effect) => effect.name), `${file}: effect names`);
  for (const effect of document.spec.effects) {
    if (effect.consequence !== "G0") {
      assert(effect.idempotent, `${file}: ${effect.name} must be idempotent for ${effect.consequence}`);
    }
  }
}

function semanticContentType(document, file) {
  ajv.compile(document.spec.fields);
  unique(document.spec.relations.map((relation) => relation.name), `${file}: relation names`);
  unique(document.spec.indexes.map((index) => index.name), `${file}: index names`);
}

function semanticEvent(document, file) {
  if (document.navoconsequence !== "G0") {
    assert(document.navoidempotencykey, `${file}: effects require navoidempotencykey`);
  }
}

function semanticMediaAsset(document, file) {
  if (["verified", "processing", "ready"].includes(document.spec.state)) {
    assert(document.spec.original, `${file}: verified media requires an original`);
  }
  if (document.spec.state === "rejected") assert(document.spec.rejectionReason, `${file}: rejected media needs a reason`);
}

function semanticAstroArtifact(document, file) {
  unique(document.files.map((entry) => entry.path), `${file}: artifact paths`);
  for (const entry of document.files) {
    assert(!entry.path.startsWith("/") && !entry.path.split("/").some((part) => part === "." || part === ".."), `${file}: unsafe artifact path`);
  }
}

function tokenPaths(group, prefix = "") {
  return Object.entries(group).flatMap(([name, value]) => {
    const tokenPath = prefix ? `${prefix}.${name}` : name;
    return Object.hasOwn(value, "$value") ? [tokenPath] : tokenPaths(value, tokenPath);
  });
}

function semanticDesignSystem(document, file) {
  const componentIds = document.spec.components.map(({ id }) => id);
  const components = new Set(componentIds);
  const tokens = new Set(tokenPaths(document.spec.tokens));
  unique(componentIds, `${file}: component IDs`);
  unique(document.spec.recipes.map(({ id }) => id), `${file}: recipe IDs`);
  for (const component of document.spec.components) {
    unique(component.variants.map(({ name }) => name), `${file}: ${component.id} variants`);
    for (const variant of component.variants) {
      assert(variant.values.includes(variant.default), `${file}: ${variant.name} default is invalid`);
    }
  }
  for (const recipe of document.spec.recipes) {
    for (const slot of recipe.slots) {
      assert(components.has(slot.component), `${file}: unknown component ${slot.component}`);
      assert(slot.minItems <= slot.maxItems, `${file}: ${slot.id} has an invalid item range`);
    }
  }
  for (const path of document.spec.overridePolicy.allowedTokenPaths) {
    assert(tokens.has(path), `${file}: unknown override token ${path}`);
  }
}

function semanticDesignOverride() {}

const fixtureKinds = [
  { suffix: ".plugin.json", validator: "plugin", semantic: semanticPlugin },
  { suffix: ".profile.json", validator: "profile", semantic: semanticProfile },
  { suffix: ".content-type.json", validator: "contentType", semantic: semanticContentType },
  { suffix: ".design-override.json", validator: "designOverride", semantic: semanticDesignOverride },
  { suffix: ".design-system.json", validator: "designSystem", semantic: semanticDesignSystem },
  { suffix: ".event.json", validator: "event", semantic: semanticEvent },
  { suffix: ".media-asset.json", validator: "mediaAsset", semantic: semanticMediaAsset },
  { suffix: ".astro-artifact-manifest.json", validator: "astroArtifact", semantic: semanticAstroArtifact },
  { suffix: ".cloudflare-artifact-reference.json", validator: "cloudflareArtifactReference", semantic: () => {} },
  { suffix: ".cloudflare-staging-binding.json", validator: "cloudflareStagingBinding", semantic: () => {} }
];

let validated = 0;
const fixtureFiles = [...(await listJsonFiles("examples")), ...(await listJsonFiles("plugins"))];
for (const file of fixtureFiles) {
  const fixture = fixtureKinds.find(({ suffix }) => file.endsWith(suffix));
  if (!fixture) continue;
  const document = await readJson(file);
  const validate = validators[fixture.validator];
  assert(validate(document), `${file}: ${formatErrors(validate.errors)}`);
  fixture.semantic(document, file);
  validated += 1;
}

const negativeChecks = [
  ["plugin", { apiVersion: "navocms.io/v0alpha1", kind: "PluginManifest" }],
  ["profile", { apiVersion: "navocms.io/v0alpha1", kind: "SiteProfile" }],
  ["contentType", { apiVersion: "navocms.io/v0alpha1", kind: "ContentType" }],
  ["designOverride", { apiVersion: "navocms.io/v0alpha1", kind: "DesignOverride" }],
  ["designSystem", { apiVersion: "navocms.io/v0alpha1", kind: "DesignSystem" }],
  ["event", { specversion: "1.0" }],
  ["mediaAsset", { apiVersion: "navocms.io/v0alpha1", kind: "MediaAsset" }],
  ["astroArtifact", { schema: "io.navocms.astro-artifact.v1" }],
  ["cloudflareArtifactReference", { schema: "io.navocms.cloudflare-artifact-reference.v1" }],
  ["cloudflareStagingBinding", { schema: "io.navocms.cloudflare-staging-binding.v1" }]
];

for (const [name, invalidDocument] of negativeChecks) {
  assert(!validators[name](invalidDocument), `${name} schema unexpectedly accepted an invalid fixture`);
}

const astroAdversarialFixtures = fixtureFiles.filter((file) => file.endsWith(".astro-artifact-manifest.invalid.json"));
assert(astroAdversarialFixtures.length > 0, "Expected an adversarial Astro artifact fixture");
for (const file of astroAdversarialFixtures) {
  const document = await readJson(file);
  if (!validators.astroArtifact(document)) continue;
  let semanticRejected = false;
  try { semanticAstroArtifact(document, file); } catch { semanticRejected = true; }
  assert(semanticRejected, `${file}: invalid Astro artifact fixture was accepted`);
}

const cloudflareReferenceAdversarialFixtures = fixtureFiles.filter((file) => file.endsWith(".cloudflare-artifact-reference.invalid.json"));
assert(cloudflareReferenceAdversarialFixtures.length > 0, "Expected an adversarial Cloudflare artifact reference fixture");
for (const file of cloudflareReferenceAdversarialFixtures) {
  assert(!validators.cloudflareArtifactReference(await readJson(file)), `${file}: invalid Cloudflare artifact reference fixture was accepted`);
}

const cloudflareStagingAdversarialFixtures = fixtureFiles.filter((file) => file.endsWith(".cloudflare-staging-binding.invalid.json"));
assert(cloudflareStagingAdversarialFixtures.length > 0, "Expected an adversarial Cloudflare staging binding fixture");
for (const file of cloudflareStagingAdversarialFixtures) {
  assert(!validators.cloudflareStagingBinding(await readJson(file)), `${file}: invalid Cloudflare staging binding fixture was accepted`);
}

const astroCorpus = await readJson("examples/astro/path-and-identifier-corpus.json");
const validAstroManifest = await readJson("examples/astro/valid.astro-artifact-manifest.json");
for (const mutation of astroCorpus) {
  const document = {
    ...validAstroManifest,
    ...(mutation.tenantId ? { tenantId: mutation.tenantId } : {}),
    ...(mutation.siteId ? { siteId: mutation.siteId } : {}),
    ...(mutation.path ? { files: [{ ...validAstroManifest.files[0], path: mutation.path }] } : {})
  };
  assert(!validators.astroArtifact(document), `Astro corpus accepted ${mutation.name}`);
}

assert(validated >= 9, `Expected at least nine contract fixtures, validated ${validated}`);
console.log(`Validated ${Object.keys(schemaPaths).length} schemas and ${validated} contract fixtures.`);
