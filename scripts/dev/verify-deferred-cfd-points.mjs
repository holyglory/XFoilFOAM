import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = progressivePreviewOrigin();
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  const api = await browser.newContext();
  const fullResponse = await api.request.get(`${origin}/api/airfoils/ag24`);
  const curvesResponse = await api.request.get(
    `${origin}/api/airfoils/ag24?view=curves`,
  );
  assert(fullResponse.ok() && curvesResponse.ok());
  const full = await fullResponse.json();
  const hasCfdPoints = full.polars.some((polar) =>
    polar.points.some((point) => point.source === "solved"),
  );
  const curves = await curvesResponse.json();
  assert.equal(curves.cfdPointsDeferred, true);
  assert.deepEqual(curves.polars, []);
  assert.deepEqual(curves.progressivePolars, full.progressivePolars);
  for (const property of [
    "id",
    "geometry",
    "downloads",
    "hashtags",
    "simulationWorks",
  ])
    assert.deepEqual(curves[property], full[property]);
  const invalid = await api.request.get(
    `${origin}/api/airfoils/ag24?view=invalid`,
  );
  assert.equal(invalid.status(), 400);
  const missing = await api.request.get(
    `${origin}/api/airfoils/definitely-missing-progressive-profile?view=curves`,
  );
  assert.equal(missing.status(), 404);
  const works = await (
    await api.request.get(`${origin}/api/airfoils/ag24/solver-work`)
  ).json();
  const revision = works.conditions[0].presetRevisionId;
  const pinned = await (
    await api.request.get(`${origin}/api/airfoils/ag24?revisionId=${revision}`)
  ).json();
  const pinnedCurves = await (
    await api.request.get(
      `${origin}/api/airfoils/ag24?revisionId=${revision}&view=curves`,
    )
  ).json();
  assert.deepEqual(pinnedCurves, pinned);
  await api.close();
  for (const width of [320, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let requests = 0;
    let behavior = "success";
    let release;
    let aborted;
    await page.route("**/api/airfoils/ag24", async (route) => {
      requests += 1;
      if (behavior === "error")
        return route.fulfill({ status: 503, body: "unavailable" });
      if (behavior === "slow") {
        await new Promise((resolve) => {
          release = resolve;
        });
        await route.abort();
        aborted?.();
        return;
      }
      await route.continue();
    });
    await page.goto(`${origin}/airfoils/ag24`, { waitUntil: "networkidle" });
    const viewer = page.getByTestId("progressive-polar-viewer");
    await expect(viewer).toHaveAttribute("aria-busy", "false");
    assert.equal(
      requests,
      0,
      "Initial browser view must not fetch hidden full CFD data",
    );
    const disclosure = page.locator("#cfd-points");
    const summary = disclosure.locator("summary");
    await expect(summary).toBeVisible();
    behavior = "error";
    await summary.click();
    await expect(disclosure.getByRole("alert")).toContainText(
      "Unable to load CFD points",
    );
    assert.equal(requests, 1);
    behavior = "success";
    await disclosure.getByRole("button", { name: "Retry" }).click();
    const loadedPoints = hasCfdPoints
      ? disclosure.getByTestId("polar-viewer")
      : disclosure.getByText("No CFD points yet.", { exact: true });
    await expect(loadedPoints).toBeVisible();
    await expect(disclosure.getByRole("alert")).toHaveCount(0);
    let storedPoint = disclosure.locator('circle[role="button"]').first();
    if (!hasCfdPoints) {
      const series = full.progressivePolars.find(
        (series) => series.explanation.contributors?.length,
      );
      assert(
        series,
        "Real included CFD evidence must be available for the evidence journey",
      );
      await viewer.getByLabel("Polar condition").selectOption(series.targetId);
      await viewer
        .locator("summary")
        .filter({ hasText: "Why this curve" })
        .click();
      const contributor = series.explanation.contributors[0];
      storedPoint = viewer
        .locator(
          `button[data-result-id="${contributor.resultId}"][data-result-attempt-id="${contributor.attemptId}"]`,
        )
        .first();
    }
    await expect(storedPoint).toBeVisible();
    const storedResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/airfoils/ag24/sim" &&
        Boolean(url.searchParams.get("resultId"))
      );
    });
    await storedPoint.focus();
    await storedPoint.press("Enter");
    const evidence = await storedResponse;
    assert(evidence.ok());
    const payload = await evidence.json();
    assert.equal(
      payload.resultId,
      new URL(evidence.url()).searchParams.get("resultId"),
    );
    await expect(page.getByTestId("sim-modal-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await summary.click();
    await summary.click();
    assert.equal(requests, 2, "Reopening reuses the loaded full detail");
    await page.reload({ waitUntil: "networkidle" });
    await expect(viewer).toHaveAttribute("aria-busy", "false");
    assert.equal(requests, 2);
    behavior = "slow";
    await summary.click();
    await expect(disclosure.getByRole("status")).toContainText("Loading");
    await expect.poll(() => typeof release).toBe("function");
    await summary.click();
    const settled = new Promise((resolve) => {
      aborted = resolve;
    });
    release();
    await settled;
    behavior = "success";
    await summary.click();
    await expect(loadedPoints).toBeVisible();
    assert.equal(requests, 4);
    assert.deepEqual(errors, []);
    results.push({
      width,
      deferredRequests: requests,
      exactEvidence: true,
      failureRecovery: true,
      cancellation: true,
    });
    await page.close();
  }
  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const page = await noScript.newPage();
  await page.goto(`${origin}/airfoils/ag24`);
  await expect(
    page.getByTestId("progressive-polar-curve").first(),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Load CFD points", exact: true })
    .click();
  await expect(page.locator("#cfd-points")).toHaveAttribute("open", "");
  await expect(
    hasCfdPoints
      ? page.getByTestId("polar-viewer")
      : page.getByText("No CFD points yet.", { exact: true }),
  ).toBeVisible();
  await noScript.close();
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({
    operation: "deferred-real-cfd-points",
    results,
    noJavaScriptFallback: true,
  }),
);
