import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(directory, "..");
const outputDirectory = path.join(appRoot, "dist");
await mkdir(outputDirectory, { recursive: true });

const bundle = await build({
  entryPoints: [path.join(appRoot, "src/widget.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false
});

const script = bundle.outputFiles[0]?.text;
if (!script) throw new Error("Widget bundle was not produced");
const css = await readFile(path.join(appRoot, "src/widget.css"), "utf8");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NavoCMS editorial review</title><style>${css}</style></head><body><div id="app" aria-live="polite"><div class="empty">Waiting for review data…</div></div><script>${script}</script></body></html>`;
await writeFile(path.join(outputDirectory, "widget.html"), html, "utf8");
