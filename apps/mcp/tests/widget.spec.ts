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

test("media integrity review is accessible and does not overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.setContent(document(mediaMarkup()));
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth
  }));
  expect(widths.document).toBe(widths.viewport);
  await expect(page.getByText("Asset integrity")).toBeVisible();
  await expect(page.getByText("restricted", { exact: false })).toBeVisible();
  await expect(page.getByText("content.entry", { exact: true })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
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

function mediaMarkup(): string {
  return `<main class="sheet"><aside class="spine"><span>Media review</span><strong>verified</strong><code>af18b62c91</code></aside><section class="content"><section class="proof"><h1>Asset integrity</h1><dl><dt>State</dt><dd>verified</dd><dt>SHA-256</dt><dd>af18b62c917fa5c43f15c4d13c5fa23d8fb4aa976e0fa6fc73456c90c5bea91f</dd><dt>MIME</dt><dd>image/png</dd><dt>Bytes</dt><dd>24000</dd><dt>Dimensions</dt><dd>1200 × 630</dd><dt>Provenance</dt><dd>upload</dd><dt>Source</dt><dd>direct upload</dd><dt>Received</dt><dd>2026-08-24T15:00:00.000Z</dd><dt>Received by</dt><dd>016ef382-bf28-406b-9321-1fc580b6ea00</dd><dt>Rights</dt><dd>licensed</dd><dt>Rights holder</dt><dd>NavoCMS</dd><dt>Restricted</dt><dd>false</dd></dl><h2>References</h2><ul><li><strong>content.entry</strong> · hero<br><code>42d478af-1f10-45d2-a278-95002bb16a02</code> · 2026-08-24T15:01:00.000Z</li></ul></section><footer>Read-only site-scoped media metadata</footer></section></main>`;
}
