import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const forbiddenFiles = tracked.filter((file) => {
  const name = path.basename(file);
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
});

const violations = forbiddenFiles.map((file) => `${file}: environment or decryption-key files cannot be tracked`);
const sensitiveName = /(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL|API_KEY|DSN)$/i;

for (const file of tracked.filter((entry) => path.basename(entry) === ".env.example")) {
  for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, name, rawValue] = match;
    const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
    if (sensitiveName.test(name) && value.length > 0) {
      violations.push(`${file}:${index + 1}: ${name} must have an empty example value`);
    }
  }
}

if (violations.length > 0) {
  console.error(`Secret policy violations:\n${violations.map((entry) => `- ${entry}`).join("\n")}`);
  process.exit(1);
}

console.log(`Secret policy passes across ${tracked.length} tracked files.`);
