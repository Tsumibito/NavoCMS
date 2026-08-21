import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

async function listMarkdown(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listMarkdown(absolute)));
    else if (entry.name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

const errors = [];
const linkPattern = /(?:!?)\[[^\]]*\]\(([^)]+)\)/g;

for (const file of await listMarkdown(root)) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(linkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    if (!rawTarget || rawTarget.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;
    const pathname = decodeURIComponent(rawTarget.split("#", 1)[0]);
    const target = path.resolve(path.dirname(file), pathname);
    try {
      await access(target);
    } catch {
      errors.push(`${path.relative(root, file)} -> ${rawTarget}`);
    }
  }
}

if (errors.length) {
  console.error(`Broken local links:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exit(1);
}

console.log("All local Markdown links resolve.");
