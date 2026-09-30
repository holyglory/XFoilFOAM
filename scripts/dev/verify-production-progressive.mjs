import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

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
  if (process.argv.includes("--survey-reversals")) {
    assert(sourceGeometry, "The reversal survey requires source-geometry evidence");
    const source = await readFile(
      ".codex-artifacts/sg6051-polar-diagnosis-20260930/report.json",
    );
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    assert.equal(
      sourceSha256,
      "fce6165a32066ee40d7ee13bbea77a30b56cd8c6b6c99179de465306a2226fc9",
      "The original screening population changed",
    );
    const selected = JSON.parse(source).baseline_to_composite_reversals.records;
    const profiles = [...new Set(selected.map((record) => record.slug))];
    const observed = await Promise.all(profiles.map(async (profile) => {
      try {
        const fetched = await fetch(`${origin}/api/airfoils/${profile}?view=curves`, {
          signal: AbortSignal.timeout(30000),
        });
        assert(fetched.ok, `${profile}: HTTP ${fetched.status}`);
        const bytes = await fetched.text();
        await writeFile(`${evidenceDirectory}/${profile}-curves.json`, bytes);
        const current = JSON.parse(bytes);
        assert.equal(current.slug, profile);
        const rows = selected.filter((record) => record.slug === profile).map((record) => {
          const series = current.progressivePolars.find((item) => item.targetId === record.target);
          assert(series, `${profile}: original physical target is unavailable`);
          const curve = series.curves.find((item) => item.method === "composite")
            ?? series.curves.find((item) => item.method === "neuralfoil");
          assert(curve, `${profile}: no real curve is available`);
          const zero = curve.samples.find((sample) => sample.alpha === 0);
          const five = curve.samples.find((sample) => sample.alpha === 5);
          assert(zero && five, `${profile}: requested angle samples are missing`);
          if (record.source_trailing_edge_gap > 0 && series.modelId === record.model) {
            failures.push({ profile, target: record.target, message: "Original incompatible geometry model remains public" });
          }
          return {
            profile, target: record.target, originalModel: record.model,
            currentModel: series.modelId, kind: series.kind,
            sourceTrailingEdgeGap: record.source_trailing_edge_gap,
            beforeDeltaCl: record.composite_delta_cl_0_to_5,
            afterDeltaCl: five.cl - zero.cl,
            stillReversed: five.cl < zero.cl,
          };
        });
        return { profile, rows, responseSha256: createHash("sha256").update(bytes).digest("hex") };
      } catch (error) {
        failures.push({ profile, message: String(error) });
        return { profile, rows: [], error: String(error) };
      }
    }));
    const rows = observed.flatMap((record) => record.rows);
    const survey = {
      kind: "reported-polar-reversal-followup-v1", checkedAt: new Date().toISOString(),
      sourceSha256, originalConditions: selected.length, originalProfiles: profiles.length,
      checkedConditions: rows.length, stillReversed: rows.filter((row) => row.stillReversed).length,
      physicalValidation: false, observations: observed,
    };
    await writeFile(`${evidenceDirectory}/reversal-survey.json`, JSON.stringify(survey, null, 2));
    receipts.push({ survey: "reversal-survey.json", checkedConditions: rows.length, stillReversed: survey.stillReversed });
  }
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
