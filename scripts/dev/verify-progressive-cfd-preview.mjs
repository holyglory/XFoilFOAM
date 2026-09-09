import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

if (
  process.argv.length > 3 ||
  (process.argv[2] && process.argv[2] !== "--production")
)
  throw new Error(
    "Only the declared preview or --production read-only journey is supported",
  );
const production = process.argv[2] === "--production";
const origin = production ? "https://airfoils.pro" : progressivePreviewOrigin();
const slug = production ? "naca-652415" : "ag24";
const browser = await chromium.launch({ headless: true });
const outcomes = [];
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/airfoils/${slug}`, {
      waitUntil: "domcontentloaded",
    });
    const viewer = page.getByTestId("progressive-polar-viewer");
    await expect(viewer).toHaveAttribute("aria-busy", "false");
    const response = await page.request.get(`${origin}/api/airfoils/${slug}`);
    assert(response.ok());
    const detail = await response.json();
    const series = detail.progressivePolars.find(
      (item) =>
        item.curves.some((curve) => curve.method === "composite") &&
        item.explanation.contributors?.some((entry) =>
          Number.isFinite(entry.alpha),
        ),
    );
    assert(
      series,
      "The preview must contain actual included CFD evidence, not just a cached prior",
    );
    await viewer.getByLabel("Polar condition").selectOption(series.targetId);
    await expect(viewer.getByTestId("progressive-polar-curve")).toHaveCount(1);
    await expect(viewer.getByTestId("prediction-sample")).toHaveCount(0);
    await expect(page.getByTestId("polar-viewer")).not.toBeVisible();
    await viewer.getByLabel("Compare methods").check();
    await expect(viewer.getByTestId("progressive-polar-curve")).toHaveCount(
      series.curves.length,
    );
    await viewer.getByLabel("Compare methods").uncheck();
    await viewer.getByLabel("Show curve samples").check();
    assert((await viewer.getByTestId("prediction-sample").count()) > 0);
    await viewer.getByLabel("Show curve samples").uncheck();
    await viewer
      .locator("summary")
      .filter({ hasText: "Why this curve" })
      .click();
    const contributor = series.explanation.contributors.find((entry) =>
      Number.isFinite(entry.alpha),
    );
    const control = viewer
      .locator(`button[data-result-id="${contributor.resultId}"][data-result-attempt-id="${contributor.attemptId}"]`)
      .first();
    await expect(control).toBeVisible();
    const evidenceResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.origin === origin &&
        url.pathname === `/api/airfoils/${slug}/sim` &&
        url.searchParams.get("resultId") === contributor.resultId &&
        url.searchParams.get("resultAttemptId") === contributor.attemptId
      );
    });
    await control.click();
    const stored = await evidenceResponse;
    assert(stored.ok(), `Stored result request failed: ${stored.status()}`);
    const payload = await stored.json();
    assert.equal(payload.resultId, contributor.resultId);
    assert.equal(payload.resultAttemptId, contributor.attemptId);
    assert.equal(payload.status, "evidence");
    const dialog = page.getByTestId("sim-modal-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("sim-attempt-evidence")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    const disclosure = page
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: /^CFD points$/ }) });
    const storedPoints = detail.polars
      .flatMap((polar) => polar.points)
      .filter((point) => point.source === "solved");
    if (storedPoints.length) {
      await disclosure.locator("summary").click();
      await expect(page.getByTestId("polar-viewer")).toBeVisible();
      await disclosure.locator("summary").click();
      await expect(page.getByTestId("polar-viewer")).not.toBeVisible();
    } else {
      await expect(disclosure).toHaveCount(0);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(viewer).toHaveAttribute("aria-busy", "false");
    await expect(page.getByTestId("polar-viewer")).not.toBeVisible();
    const geometry = await viewer.locator("svg").boundingBox();
    assert(
      geometry &&
        geometry.x >= 0 &&
        geometry.x + geometry.width <= viewport.width + 1 &&
        geometry.y < viewport.height * 0.7,
    );
    assert.deepEqual(errors, []);
    outcomes.push({
      viewport,
      targetId: series.targetId,
      resultId: contributor.resultId,
      methods: series.curves.map((curve) => curve.method),
      outcome: "passed",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({
    kind: "real-cfd-journey",
    origin,
    slug,
    observeOnly: true,
    outcomes,
  }),
);
