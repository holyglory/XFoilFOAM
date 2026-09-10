import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const origin = "https://airfoils.pro";
const profiles = ["b707b", "b707c", "cap21c", "e49"];
const browser = await chromium.launch({ headless: true });
const outcomes = [];
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const profile of profiles) {
      const response = await page.request.get(
        `${origin}/api/airfoils/${profile}?view=curves`,
      );
      assert(response.ok());
      const detail = await response.json();
      assert(detail.progressivePolars.length >= 15);
      assert(
        detail.progressivePolars.every((series) =>
          series.curves.some(
            (curve) =>
              curve.method === "neuralfoil" &&
              curve.samples.length > 2 &&
              curve.samples.every(
                (sample) =>
                  [sample.alpha, sample.cl, sample.cd, sample.cm].every(
                    Number.isFinite,
                  ) && sample.cd > 0,
              ),
          ),
        ),
      );
      await page.goto(`${origin}/airfoils/${profile}`, {
        waitUntil: "domcontentloaded",
      });
      const viewer = page.getByTestId("progressive-polar-viewer");
      await expect(viewer).toHaveAttribute("aria-busy", "false");
      await expect(
        viewer.getByTestId("progressive-polar-curve").first(),
      ).toBeVisible();
      const condition = viewer.getByLabel("Polar condition");
      await expect(condition).toBeEnabled();
      await condition.selectOption(detail.progressivePolars.at(-1).targetId);
      await expect(
        viewer.getByTestId("progressive-polar-curve").first(),
      ).toBeVisible();
      const bounds = await viewer.boundingBox();
      assert(
        bounds &&
          bounds.x >= 0 &&
          bounds.x + bounds.width <= width + 1 &&
          bounds.y < 700,
      );
      outcomes.push({
        profile,
        width,
        curves: detail.progressivePolars.length,
        selectedTarget: await condition.inputValue(),
      });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({
    operation: "repaired-production-prediction-curves",
    observeOnly: true,
    outcomes,
  }),
);
