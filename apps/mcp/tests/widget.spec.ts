import { readFile } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const css = await readFile(new URL("../src/widget.css", import.meta.url), "utf8");

test("revision proof sheet is visually stable and accessible", async ({ page }) => {
  await page.setViewportSize({ width: 840, height: 560 });
  await page.setContent(document(diffMarkup()));
  const sheet = page.locator(".sheet");
  await expect(sheet).toHaveScreenshot("mcp-diff-review.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.03,
    threshold: 0.3
  });
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
});

test("draft queue remains readable without mobile overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.setContent(document(draftsMarkup()));
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth
  }));
  expect(widths.document).toBe(widths.viewport);
  await expect(page.locator(".draft")).toHaveCount(2);
  await expect(page.locator(".revision small").last()).toHaveText("70fd081a4c");
});

function document(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NavoCMS editorial review</title><style>${css}</style></head><body>${body}</body></html>`;
}

function diffMarkup(): string {
  return `<main class="sheet"><aside class="spine"><span>Change set</span><strong>5 lines</strong><code>2fd4e1c67a → 8ac90be712</code></aside><section class="content"><div class="diff"><div class="diff-line context"><span>001</span><b> </b><code># A safer editorial flow</code></div><div class="diff-line context"><span>002</span><b> </b><code></code></div><div class="diff-line remove"><span>003</span><b>−</b><code>Publish first and review later.</code></div><div class="diff-line add"><span>004</span><b>+</b><code>Review the exact immutable revision before publication.</code></div><div class="diff-line context"><span>005</span><b> </b><code></code></div></div><footer>Exact structural patch result</footer></section></main>`;
}

function draftsMarkup(): string {
  return `<main class="sheet"><aside class="spine"><span>Draft queue</span><strong>2</strong><code>site scoped</code></aside><section class="content"><div class="drafts"><article class="draft"><div><span class="type">article</span><h2>A safer editorial flow</h2><p>/safer-editorial-flow · en</p></div><div class="revision">r3<small>8ac90be712</small></div></article><article class="draft"><div><span class="type">landing-page</span><h2>Agent-first content operations</h2><p>/agent-first-content · en</p></div><div class="revision">r1<small>70fd081a4c</small></div></article></div><footer>Only drafts in the authorized site are shown</footer></section></main>`;
}
