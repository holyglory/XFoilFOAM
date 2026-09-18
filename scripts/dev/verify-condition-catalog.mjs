import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = process.argv.includes("--production")
  ? "https://airfoils.pro"
  : progressivePreviewOrigin();
const slug = process.argv.includes("--production") ? "joukowsk" : "ag24";
const detailResponse = await fetch(
  `${origin}/api/airfoils/${slug}?view=curves`,
);
assert(detailResponse.ok);
const detail = await detailResponse.json();
assert(detail.progressivePolars.length >= 2);
const selected = detail.progressivePolars[0];
const alternate = detail.progressivePolars.find(
  (series) => series.conditionKey !== selected.conditionKey,
);
assert(alternate);
const query = `condition=${selected.conditionKey}`;
const browser = await chromium.launch({ headless: true });
const receipts = [];
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 688, height: 1118 },
    { width: 390, height: 844 },
  ]) {
    for (const theme of ["dark", "light"]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?${query}`, { waitUntil: "domcontentloaded" });
      const themeButton = page.getByRole("button", {
        name: `Switch to ${theme} theme`,
      });
      if (await themeButton.count()) await themeButton.click();
      const surface = page.getByTestId("browse-surface");
      await expect(surface).toHaveAttribute("data-hydrated", "true");
      await expect(page.getByLabel("Metrics for")).toHaveValue(
        selected.conditionKey,
      );
      const firstRow = page.locator('[data-testid^="airfoil-row-"]').first();
      await expect(firstRow).toBeVisible();
      assert((await firstRow.boundingBox()).y < viewport.height * 0.55);
      const search = page.getByPlaceholder("filter by airfoil name...");
      await search.fill(detail.name);
      const row = page.getByTestId(`airfoil-row-${slug}`);
      await expect(row).toBeVisible();
      const api = await page.request.get(
        `${origin}/api/airfoils?q=${encodeURIComponent(detail.name)}&metricConditionKey=${selected.conditionKey}&includePoints=false`,
      );
      assert(api.ok());
      const summary = (await api.json()).items.find(
        (item) => item.slug === slug,
      );
      assert(summary && Number.isFinite(summary.ldmax));
      await expect(row.locator(".airfoil-col-ldmax")).toHaveText(
        summary.ldmax.toFixed(1),
      );
      await page.getByLabel("Metrics for").selectOption(alternate.conditionKey);
      await expect(row).toBeVisible();
      const next = await page.request.get(
        `${origin}/api/airfoils?q=${encodeURIComponent(detail.name)}&metricConditionKey=${alternate.conditionKey}&includePoints=false`,
      );
      const nextSummary = (await next.json()).items.find(
        (item) => item.slug === slug,
      );
      await expect(row.locator(".airfoil-col-ldmax")).toHaveText(
        nextSummary.ldmax.toFixed(1),
      );
      await row.click();
      await expect(page).toHaveURL(
        new RegExp(`/airfoils/${slug}\\?condition=${alternate.conditionKey}$`),
      );
      await expect(
        page.getByLabel("Polar condition", { exact: true }),
      ).toHaveValue(alternate.targetId);
      await page.goto(
        `${origin}/compare?airfoil=${slug}&condition=${alternate.conditionKey}`,
        { waitUntil: "domcontentloaded" },
      );
      await expect(
        page.getByLabel("Comparison condition", { exact: true }),
      ).toHaveValue(alternate.conditionKey);
      const metric = page.getByTestId(`comparison-ld-${slug}`);
      await expect(metric).not.toHaveText("—");
      await page
        .getByRole("link", { name: "Open profile →", exact: true })
        .click();
      await expect(
        page.getByLabel("Polar condition", { exact: true }),
      ).toHaveValue(alternate.targetId);
      assert.deepEqual(errors, []);
      receipts.push({
        viewport,
        theme,
        slug,
        condition: alternate.conditionKey,
        maxLd: nextSummary.ldmax,
      });
      await page.close();
    }
  }
  console.log(
    JSON.stringify({ kind: "condition-catalog-journey", origin, receipts }),
  );
} finally {
  await browser.close();
}
