import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const files = [
  "astro-artifact-manifest.schema.json",
  "content-type.schema.json",
  "design-override.schema.json",
  "design-system.schema.json",
  "event-envelope.schema.json",
  "media-asset.schema.json",
  "plugin-manifest.schema.json",
  "site-profile.schema.json",
  "cloudflare-staging-binding.schema.json", "cloudflare-staging-binding-v2.schema.json", "cloudflare-staging-binding-v3.schema.json"
];
const destination = path.join(process.cwd(), "packages/contracts/dist/schemas");

await mkdir(destination, { recursive: true });
for (const file of files) {
  await copyFile(path.join(process.cwd(), "schemas", file), path.join(destination, file));
}

console.log(`Copied ${files.length} public schemas into @navocms/contracts.`);
