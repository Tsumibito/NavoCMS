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
  event: "schemas/event-envelope.schema.json"
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

const fixtureKinds = [
  { suffix: ".plugin.json", validator: "plugin", semantic: semanticPlugin },
  { suffix: ".profile.json", validator: "profile", semantic: semanticProfile },
  { suffix: ".content-type.json", validator: "contentType", semantic: semanticContentType },
  { suffix: ".event.json", validator: "event", semantic: semanticEvent }
];

let validated = 0;
for (const file of await listJsonFiles("examples")) {
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
  ["event", { specversion: "1.0" }]
];

for (const [name, invalidDocument] of negativeChecks) {
  assert(!validators[name](invalidDocument), `${name} schema unexpectedly accepted an invalid fixture`);
}

assert(validated >= 6, `Expected at least six contract fixtures, validated ${validated}`);
console.log(`Validated ${Object.keys(schemaPaths).length} schemas and ${validated} contract fixtures.`);
