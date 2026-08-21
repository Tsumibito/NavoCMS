import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createAstroDesignAdapter } from "../packages/design-astro/dist/index.js";
import { compileDesignSystem } from "../packages/design/dist/index.js";

const root = process.cwd();
const source = JSON.parse(
  await readFile(path.join(root, "examples/design-systems/tidal-signal.design-system.json"), "utf8")
);
const design = compileDesignSystem(source);
const adapter = createAstroDesignAdapter(design, [
  { id: "signal-button", module: "../components/SignalButton.astro" },
  { id: "story-card", module: "../components/StoryCard.astro" },
  { id: "section-shell", module: "../components/SectionShell.astro" }
]);
const output = {
  definition: design.definition,
  digest: design.digest,
  tokens: design.tokens,
  css: adapter.css,
  catalogue: design.catalogue,
  bindings: {
    components: [...adapter.components.values()],
    recipes: adapter.recipes
  }
};
const directory = path.join(root, "apps/design-catalogue/src/generated");
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, "catalogue.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(`Generated Astro catalogue model for ${design.definition.metadata.name}@${design.definition.metadata.version}.`);
