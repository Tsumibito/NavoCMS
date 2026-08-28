import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { contracts } from "../packages/contracts/dist/index.js";

const root = process.cwd();
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

async function readJson(relativePath) { return JSON.parse(await readFile(path.join(root, relativePath), "utf8")); }
async function listJsonFiles(directory) {
  let entries;
  try { entries = await readdir(path.join(root, directory), { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listJsonFiles(relative));
    else if (entry.name.endsWith(".json")) files.push(relative);
  }
  return files.sort();
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function unique(values, label) { assert(new Set(values).size === values.length, `${label} must be unique`); }

const astroSchema = ajv.compile(await readJson("schemas/astro-artifact-manifest.schema.json"));
const cloudflareReferenceSchema = ajv.compile(await readJson("schemas/cloudflare-artifact-reference.schema.json"));
function parseAstroManifest(document, file) {
  assert(astroSchema(document), `${file}: invalid Astro manifest`);
  unique(document.files.map((entry) => entry.path), `${file}: artifact paths`);
  for (const entry of document.files) assert(!entry.path.startsWith("/") && !entry.path.split("/").some((part) => part === "." || part === ".."), `${file}: unsafe artifact path`);
  return document;
}
function parseCloudflareReference(document, file) { assert(cloudflareReferenceSchema(document), `${file}: invalid Cloudflare reference`); return document; }

const fixtureKinds = [
  [".cloudflare-staging-binding-v3.json", contracts.cloudflareStagingBinding],
  [".plugin.json", contracts.plugin],
  [".profile.json", contracts.profile],
  [".content-type.json", contracts.contentType],
  [".design-override.json", contracts.designOverride],
  [".design-system.json", contracts.designSystem],
  [".event.json", contracts.event],
  [".media-asset.json", contracts.mediaAsset],
  [".astro-artifact-manifest.json", { parse: parseAstroManifest }],
  [".cloudflare-artifact-reference.json", { parse: parseCloudflareReference }],
  [".cloudflare-staging-binding.json", contracts.cloudflareStagingBinding],
  [".r2-runtime-binding.json", contracts.r2RuntimeBinding]
];

const fixtureFiles = [...await listJsonFiles("examples"), ...await listJsonFiles("plugins")];
let validated = 0;
for (const file of fixtureFiles) {
  const kind = fixtureKinds.find(([suffix]) => file.endsWith(suffix));
  if (!kind) continue;
  kind[1].parse(await readJson(file), file);
  validated += 1;
}

async function assertRejected(files, parser, label) {
  assert(files.length > 0, `Expected adversarial ${label} fixtures`);
  for (const file of files) {
    let rejected = false;
    try { parser.parse(await readJson(file), file); } catch { rejected = true; }
    assert(rejected, `${file}: invalid ${label} fixture was accepted`);
  }
}
await assertRejected(fixtureFiles.filter((file) => file.endsWith(".astro-artifact-manifest.invalid.json")), { parse: parseAstroManifest }, "Astro artifact");
await assertRejected(fixtureFiles.filter((file) => file.endsWith(".cloudflare-artifact-reference.invalid.json")), { parse: parseCloudflareReference }, "Cloudflare reference");
await assertRejected(fixtureFiles.filter((file) => file.endsWith(".cloudflare-staging-binding.invalid.json")), contracts.cloudflareStagingBinding, "Cloudflare staging binding");
await assertRejected(fixtureFiles.filter((file) => file.endsWith(".r2-runtime-binding.invalid.json")), contracts.r2RuntimeBinding, "R2 runtime binding");

const astroCorpus = await readJson("examples/astro/path-and-identifier-corpus.json");
const validAstroManifest = await readJson("examples/astro/valid.astro-artifact-manifest.json");
for (const mutation of astroCorpus) {
  const document = { ...validAstroManifest, ...(mutation.tenantId ? { tenantId: mutation.tenantId } : {}), ...(mutation.siteId ? { siteId: mutation.siteId } : {}), ...(mutation.path ? { files: [{ ...validAstroManifest.files[0], path: mutation.path }] } : {}) };
  let rejected = false;
  try { parseAstroManifest(document, mutation.name); } catch { rejected = true; }
  assert(rejected, `Astro corpus accepted ${mutation.name}`);
}

assert(validated >= 10, `Expected at least ten contract fixtures, validated ${validated}`);
console.log(`Validated ${Object.keys(contracts).length + 2} schemas and ${validated} contract fixtures.`);
