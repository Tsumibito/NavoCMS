import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("desktop catalogue is visually stable and accessible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page).toHaveTitle(/Tidal Signal/);
  await expect(page.locator(".hero")).toHaveScreenshot("catalogue-hero-desktop.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.03,
    threshold: 0.3
  });
  await expect(page.locator("#components")).toHaveScreenshot("catalogue-components-desktop.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.03,
    threshold: 0.3
  });

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
});

test("mobile catalogue has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth
  }));
  expect(widths.document).toBe(widths.viewport);
  await expect(page.locator(".hero")).toHaveScreenshot("catalogue-hero-mobile.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.03,
    threshold: 0.3
  });
});
