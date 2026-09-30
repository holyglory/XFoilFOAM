import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const origin = "https://airfoils.pro";
const sourceGeometry = process.argv.includes("--source-geometry");
const slug = sourceGeometry ? "sg6051" : "naca-652415";
const response = await fetch(`${origin}/api/airfoils/${slug}?view=curves`);
assert(response.ok, `Public polar request returned ${response.status}`);
const detail = await response.json();
assert.equal(detail.slug, slug);
assert(
  detail.progressivePolars.length >= 15,
  "Existing polar coverage must remain available",
);
const targetIds = detail.progressivePolars
  .map((series) => series.targetId)
  .sort();
assert.equal(new Set(targetIds).size, targetIds.length);
const prediction = sourceGeometry
  ? detail.progressivePolars.find(
      (series) =>
        series.targetId ===
        "a60be87737f0579927b96872c9074bdd52f116550dda162ddcb6e6d158fd4eb2",
    )
  : (detail.progressivePolars.find((series) => series.kind === "prediction") ??
    detail.progressivePolars.find((series) =>
      series.curves.some((curve) => curve.method === "neuralfoil"),
    ));
assert(prediction, "No NeuralFoil-backed public polar condition is available");
const browser = await chromium.launch({ headless: true });
const receipts = [];
const failures = [];
const evidenceDirectory = sourceGeometry
  ? `.codex-artifacts/source-geometry-public/${randomUUID()}`
  : null;
if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
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
      assert.deepEqual(
        (
          await conditions
            .locator("option")
            .evaluateAll((options) => options.map((option) => option.value))
        ).sort(),
        targetIds,
      );
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
      const sampleLabel = /Show (?:curve|prediction) samples/;
      await viewer.getByLabel(sampleLabel).check();
      assert.equal(await viewer.getByTestId("prediction-sample").count(), 26);
      if (sourceGeometry) {
        const primary =
          prediction.curves.find((curve) => curve.method === "composite") ??
          prediction.curves.find((curve) => curve.method === "neuralfoil");
        const zero = primary.samples.findIndex((sample) => sample.alpha === 0);
        const five = primary.samples.findIndex((sample) => sample.alpha === 5);
        assert(zero >= 0 && five >= 0);
        const liftIncreasing =
          primary.samples[five].cl > primary.samples[zero].cl;
        const markers = viewer.getByTestId("prediction-sample");
        const zeroHeight = Number(await markers.nth(zero).getAttribute("cy"));
        const fiveHeight = Number(await markers.nth(five).getAttribute("cy"));
        if (!liftIncreasing || !(fiveHeight < zeroHeight))
          failures.push({
            viewport,
            message: "Reported low-angle lift reversal is still present",
            cl0: primary.samples[zero].cl,
            cl5: primary.samples[five].cl,
          });
        const listed = await page.request.get(
          `${origin}/api/airfoils?q=${encodeURIComponent(detail.name)}&metricConditionKey=${prediction.conditionKey}&includePoints=false`,
        );
        assert(listed.ok());
        const row = (await listed.json()).items.find(
          (item) => item.slug === slug,
        );
        assert(row);
        assert(
          Math.abs(row.ldmax - primary.metrics.liftToDragMaximum) < 1e-8,
          "Catalog and plotted curve differ",
        );
        await viewer.getByLabel(sampleLabel).uncheck();
        await viewer.screenshot({
          path: `${evidenceDirectory}/${viewport.width}-lift.png`,
        });
        receipts.push({
          viewport,
          condition: prediction.targetId,
          model: prediction.modelId,
          liftIncreasing,
          renderedLiftIncreasing: fiveHeight < zeroHeight,
          ldmax: row.ldmax,
        });
      }
      await viewer.getByLabel(sampleLabel).uncheck();
      await viewer.locator("summary").click();
      await viewer
        .getByText(
          /This curve combines the stored NeuralFoil prediction|It is not a completed OpenFOAM calculation\./,
          { exact: false },
        )
        .waitFor({ state: "visible" });
      await viewer.locator("summary").click();
      const compareMethods = viewer.getByLabel("Compare methods");
      if (prediction.curves.length > 1) {
        assert.equal(await compareMethods.count(), 1);
        await compareMethods.check();
        await compareMethods.uncheck();
      } else {
        assert.equal(await compareMethods.count(), 0);
      }
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
        curves: detail.progressivePolars.length,
        samples: 26,
        controls: "passed",
        reload: "passed",
      });
    } finally {
      await context.close();
    }
  }
  const report = {
    origin,
    slug,
    observeOnly: true,
    receipts,
    failures,
    evidenceDirectory,
  };
  if (evidenceDirectory)
    await writeFile(
      `${evidenceDirectory}/report.json`,
      JSON.stringify(report, null, 2),
    );
  console.log(JSON.stringify(report));
  assert.equal(failures.length, 0, "Source geometry curve verification failed");
} finally {
  await browser.close();
}
