import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const origin = "https://airfoils.pro";
const slug = "naca-652415";
const response = await fetch(`${origin}/api/airfoils/${slug}`);
assert(response.ok, `Public polar request returned ${response.status}`);
const detail = await response.json();
assert.equal(detail.slug, slug);
assert.equal(detail.progressivePolars.length, 15);
const prediction = detail.progressivePolars.find(
  (series) => series.kind === "prediction",
);
assert(
  prediction,
  "The prediction-only condition fixture is no longer available",
);
const browser = await chromium.launch({ headless: true });
const receipts = [];
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const navigation = await page.goto(`${origin}/airfoils/${slug}`, {
        waitUntil: "load",
      });
      assert.equal(navigation.status(), 200);
      const viewer = page.getByTestId("progressive-polar-viewer");
      await viewer.waitFor({ state: "visible" });
      await page
        .locator('[data-testid="progressive-polar-viewer"][aria-busy="false"]')
        .waitFor();
      assert.equal(await viewer.getByTestId("prediction-sample").count(), 0);
      assert(
        (
          await viewer
            .getByTestId("progressive-polar-curve")
            .first()
            .getAttribute("d")
        ).length > 10,
      );
      const conditions = viewer.getByLabel("Polar condition");
      assert.equal(await conditions.locator("option").count(), 15);
      await conditions.selectOption(prediction.targetId);
      for (const quantity of [
        "Drag",
        "Pitching moment",
        "Lift / drag",
        "Drag polar",
        "Lift",
      ]) {
        const button = viewer.getByRole("button", {
          name: quantity,
          exact: true,
        });
        await button.click();
        assert.equal(await button.getAttribute("aria-pressed"), "true");
      }
      await viewer.getByLabel("Show prediction samples").check();
      assert.equal(await viewer.getByTestId("prediction-sample").count(), 26);
      await viewer.getByLabel("Show prediction samples").uncheck();
      await viewer.locator("summary").click();
      await viewer
        .getByText("It is not a completed OpenFOAM calculation.", {
          exact: false,
        })
        .waitFor({ state: "visible" });
      await viewer.locator("summary").click();
      assert.equal(await viewer.getByLabel("Compare methods").count(), 0);
      await page.reload({ waitUntil: "load" });
      await viewer.waitFor({ state: "visible" });
      assert.equal(await viewer.getByTestId("prediction-sample").count(), 0);
      const bounds = await viewer.locator("svg").boundingBox();
      assert(
        bounds &&
          bounds.x >= 0 &&
          bounds.x + bounds.width <= viewport.width + 1,
      );
      assert.deepEqual(errors, []);
      receipts.push({
        viewport,
        curves: 15,
        samples: 26,
        controls: "passed",
        reload: "passed",
      });
    } finally {
      await context.close();
    }
  }
  console.log(JSON.stringify({ origin, slug, observeOnly: true, receipts }));
} finally {
  await browser.close();
}
