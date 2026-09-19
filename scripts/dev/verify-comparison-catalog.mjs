import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = process.argv.includes("--production")
  ? "https://airfoils.pro"
  : progressivePreviewOrigin();
const response = await fetch(`${origin}/api/airfoils/ag24?view=curves`);
assert(response.ok);
const detail = await response.json();
const [first, second] = detail.progressivePolars;
assert(first && second && first.conditionKey !== second.conditionKey);
const browser = await chromium.launch({ headless: true });
const receipts = [];
const screenshots = ".codex-artifacts/comparison-picker";
await mkdir(screenshots, { recursive: true });
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
      let requests = 0;
      let mode = "hold";
      let heldRoute;
      let expectedCondition = first.conditionKey;
      await page.route("**/api/airfoils?*", async (route) => {
        requests += 1;
        const query = new URL(route.request().url()).searchParams;
        assert.equal(query.get("includePoints"), "false");
        assert.equal(query.get("metricConditionKey"), expectedCondition);
        if (mode === "hold") {
          heldRoute = route;
          return;
        }
        if (mode === "fail") {
          mode = "real";
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "isolated verification failure" }),
          });
          return;
        }
        await route.continue();
      });
      await page.goto(
        `${origin}/compare?airfoil=ag24&condition=${first.conditionKey}`,
        { waitUntil: "domcontentloaded" },
      );
      await expect(page.getByTestId("comparison-ld-ag24")).toBeVisible();
      await expect(
        page.getByRole("img", {
          name: "Lift polar for the selected condition",
        }),
      ).toBeVisible();
      const switchTheme = page.getByRole("button", {
        name: `Switch to ${theme} theme`,
      });
      if (await switchTheme.count()) await switchTheme.click();
      assert.equal(requests, 0);
      const add = page.getByRole("button", {
        name: "＋ add airfoil…",
        exact: true,
      });
      await add.click();
      await expect(
        page.getByRole("status").filter({ hasText: "Loading profiles…" }),
      ).toBeVisible();
      await expect.poll(() => requests).toBe(1);
      const search = page.getByPlaceholder("⌕  search airfoils…");
      await expect(search).toBeFocused();
      await search.press("Escape");
      await expect(search).not.toBeVisible();
      await expect(add).toBeFocused();
      await heldRoute.abort();
      mode = "fail";
      await add.click();
      await expect(
        page.getByRole("alert").filter({ hasText: "Could not load profiles." }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await search.fill("ag25");
      await expect(
        page.getByText("AG25 Bubble Dancer", { exact: true }),
      ).toBeVisible();
      const popup = search.locator("..").locator("..");
      const bounds = await popup.boundingBox();
      assert(
        bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width,
      );
      await page.screenshot({
        path: `${screenshots}/${viewport.width}-${theme}.png`,
      });
      await page.getByRole("button", { name: "details", exact: true }).click();
      await page.getByRole("button", { name: "details", exact: true }).click();
      await search.press("Enter");
      await search.press("Escape");
      await expect(add).toBeFocused();
      await expect
        .poll(() => new URL(page.url()).searchParams.getAll("airfoil"))
        .toEqual(["ag24", "ag25"]);
      expectedCondition = second.conditionKey;
      await page
        .getByLabel("Comparison condition", { exact: true })
        .selectOption(second.conditionKey);
      const beforeReload = requests;
      await add.click();
      await expect.poll(() => requests).toBe(beforeReload + 1);
      await expect(
        page.getByRole("status").filter({ hasText: "Loading profiles…" }),
      ).not.toBeVisible();
      await search.press("Escape");
      assert.equal(
        new URL(page.url()).searchParams.get("condition"),
        second.conditionKey,
      );
      assert.deepEqual(errors, []);
      receipts.push({
        viewport,
        theme,
        requests,
        realCatalogReloadedAtCondition: second.conditionKey,
      });
      await page.close();
    }
  }
  console.log(
    JSON.stringify({ kind: "comparison-catalog-on-demand", origin, receipts }),
  );
} finally {
  await browser.close();
}
