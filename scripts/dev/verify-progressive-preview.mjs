import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = process.argv[2] ?? progressivePreviewOrigin();
if (!origin || !["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("Expected the exact local preview origin");
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const initialContext = await browser.newContext({
      viewport,
      javaScriptEnabled: false,
    });
    try {
      const initialPage = await initialContext.newPage();
      await initialPage.goto(`${origin}/airfoils/ag24`, {
        waitUntil: "load",
      });
      const initialViewer = initialPage.getByTestId("progressive-polar-viewer");
      const initialChart = await initialViewer.locator("svg").boundingBox();
      assert(
        initialChart && initialChart.y < viewport.height * 0.7,
        `Polar layout must not wait for hydration: ${JSON.stringify({ viewport, initialChart })}`,
      );
      assert.equal(
        await initialViewer.getByLabel("Polar condition").isDisabled(),
        true,
      );
      assert.equal(
        await initialViewer.getByLabel("Show prediction samples").isDisabled(),
        true,
      );
    } finally {
      await initialContext.close();
    }
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/airfoils/ag24`, {
      waitUntil: "domcontentloaded",
    });
    const viewer = page.getByTestId("progressive-polar-viewer");
    await viewer.waitFor();
    const chart = viewer.locator("svg");
    const box = await chart.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= viewport.width + 1);
    assert(
      box.y < viewport.height * 0.7,
      `Polar must own the initial viewport: ${JSON.stringify({ viewport, box })}`,
    );
    assert.equal(
      await viewer.getByTestId("progressive-polar-curve").count(),
      1,
    );
    assert.equal(await viewer.getByTestId("prediction-sample").count(), 0);
    await page
      .locator('[data-testid="progressive-polar-viewer"][aria-busy="false"]')
      .waitFor();
    const samples = viewer.getByLabel("Show prediction samples");
    assert.equal(await samples.isEnabled(), true);
    const sampleControl = await samples.boundingBox();
    assert(
      sampleControl &&
        sampleControl.y >= 0 &&
        sampleControl.y + sampleControl.height <= viewport.height,
    );
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    await page.mouse.click(
      sampleControl.x + sampleControl.width / 2,
      sampleControl.y + sampleControl.height / 2,
    );
    assert.equal(await samples.isChecked(), true);
    assert.equal(await viewer.getByTestId("prediction-sample").count(), 26);
    assert.equal(
      await page.evaluate(() => window.scrollY),
      0,
      JSON.stringify({
        viewport,
        initialChart: box,
        chart: await chart.boundingBox(),
        toggle: await viewer
          .getByLabel("Show prediction samples")
          .boundingBox(),
      }),
    );
    await viewer.getByLabel("Show prediction samples").uncheck();
    const conditions = viewer.getByLabel("Polar condition");
    assert((await conditions.locator("option").count()) >= 6);
    const summary = viewer.getByRole("region", { name: "Curve summary" });
    assert.equal(await summary.isVisible(), true);
    const originalSummary = await summary.textContent();
    assert(originalSummary.includes("NeuralFoil"));
    assert(originalSummary.includes("Maximum lift / drag"));
    assert.equal(
      await page.getByText("BEST-FIT POLAR", { exact: true }).count(),
      0,
    );
    const originalCurve = await viewer
      .getByTestId("progressive-polar-curve")
      .getAttribute("d");
    await conditions.selectOption({ index: 5 });
    assert.notEqual(await summary.textContent(), originalSummary);
    assert.notEqual(
      await viewer.getByTestId("progressive-polar-curve").getAttribute("d"),
      originalCurve,
    );
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
      assert(
        (await chart.getAttribute("aria-label")).startsWith(
          `${quantity} polar`,
        ),
      );
    }
    await viewer.getByLabel("Show prediction samples").check();
    assert.equal(await viewer.getByTestId("prediction-sample").count(), 26);
    await viewer.getByLabel("Show prediction samples").uncheck();
    assert.equal(await viewer.getByTestId("prediction-sample").count(), 0);
    await viewer.locator("summary").click();
    assert(
      await viewer
        .getByText("It is not a completed OpenFOAM calculation.", {
          exact: false,
        })
        .isVisible(),
    );
    assert(
      await viewer
        .getByText("not a resolved shock", { exact: false })
        .isVisible(),
    );
    await viewer.locator("summary").click();
    assert.equal(await viewer.locator("details").getAttribute("open"), null);
    assert.equal(await viewer.getByLabel("Compare methods").count(), 0);
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(
      await viewer.getByTestId("progressive-polar-curve").count(),
      1,
    );
    assert.equal(await viewer.getByTestId("prediction-sample").count(), 0);
    assert.deepEqual(errors, []);
    results.push({
      viewport,
      curveVisibleFirst: true,
      beforeHydration: true,
      conditions: 6,
      quantities: 5,
      sampleToggle: true,
      explanation: true,
      conditionSpecificSummary: true,
      reload: true,
    });
    await page.close();
  }
  console.log(
    JSON.stringify({
      purpose: "real-local-NeuralFoil-preview",
      origin,
      results,
    }),
  );
} finally {
  await browser.close();
}
