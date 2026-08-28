import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

async function sourceFiles(directory) {
  const absolute = path.join(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(relative)));
    else if (entry.name.endsWith(".ts")) files.push(relative);
  }
  return files;
}

const rules = [
  {
    directory: "packages/contracts/src",
    forbidden: ["@navocms/kernel", "fastify"],
    reason: "public contracts cannot depend on the kernel or transport"
  },
  {
    directory: "packages/kernel/src",
    forbidden: ["apps/", "plugins/", "fastify"],
    reason: "the kernel cannot depend on applications, concrete plugins, or HTTP transport"
  },
  {
    directory: "packages/security/src",
    forbidden: ["@navocms/kernel", "apps/", "plugins/", "fastify"],
    reason: "security primitives cannot depend on the kernel, applications, plugins, or transport"
  },
  {
    directory: "packages/persistence-postgres/src",
    forbidden: ["@navocms/kernel", "apps/", "plugins/", "fastify"],
    reason: "the PostgreSQL adapter cannot depend on applications, plugins, or transport"
  },
  {
    directory: "packages/content/src",
    forbidden: ["@navocms/kernel", "apps/", "plugins/", "fastify"],
    reason: "the content engine cannot depend on applications, plugins, the kernel, or HTTP transport"
  },
  {
    directory: "packages/design/src",
    forbidden: ["@navocms/kernel", "apps/", "plugins/", "fastify", "astro"],
    reason: "the design engine cannot depend on applications, plugins, the kernel, transport, or a renderer"
  },
  {
    directory: "packages/design-astro/src",
    forbidden: ["@navocms/kernel", "apps/", "plugins/", "fastify"],
    reason: "the Astro design adapter cannot depend on applications, plugins, the kernel, or transport"
  },
  {
    directory: "packages/delivery-cloudflare/src",
    forbidden: ["apps/", "plugins/", "fastify"],
    allowedWorkspaceImports: ["@navocms/design-astro", "@navocms/kernel"],
    reason: "the Cloudflare delivery adapter may depend only on immutable renderer and release contracts"
  },
  {
    directory: "packages/media/src",
    forbidden: ["apps/", "plugins/", "fastify"],
    allowedWorkspaceImports: ["@navocms/kernel", "@navocms/persistence-postgres", "@navocms/security"],
    reason: "the media boundary may use only kernel events, the PostgreSQL adapter, and security primitives"
  }
];

const violations = [];
for (const rule of rules) {
  for (const file of await sourceFiles(rule.directory)) {
    const source = await readFile(path.join(root, file), "utf8");
    for (const forbidden of rule.forbidden) {
      if (source.includes(forbidden)) violations.push(`${file}: ${rule.reason} (${forbidden})`);
    }
    if (rule.allowedWorkspaceImports) {
      for (const match of source.matchAll(/from\s+["'](@navocms\/[^"']+)["']/g)) {
        if (!rule.allowedWorkspaceImports.includes(match[1])) {
          violations.push(`${file}: ${rule.reason} (${match[1]} is not an allowed workspace dependency)`);
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`Architecture boundary violations:\n${violations.map((entry) => `- ${entry}`).join("\n")}`);
  process.exit(1);
}

console.log(`Architecture boundaries pass across ${rules.length} package rules.`);
