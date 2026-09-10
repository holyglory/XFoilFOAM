import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { projectChart } from "../../packages/core/src/index.ts";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = progressivePreviewOrigin();
const browser = await chromium.launch({ headless: true });
const outcomes = [];
try {
  const discovery = await browser.newContext();
  const worksResponse = await discovery.request.get(
    `${origin}/api/airfoils/ag24/solver-work`,
  );
  assert(worksResponse.ok());
  const works = await worksResponse.json();
  const scopes = [];
  for (const condition of works.conditions.slice(0, 24)) {
    const revision = condition.presetRevisionId;
    const response = await discovery.request.get(
      `${origin}/api/airfoils/ag24?revisionId=${revision}`,
    );
    assert(response.ok());
    const detail = await response.json();
    if (detail.progressivePolars?.length) continue;
    const projection = projectChart({
      chartType: "cla",
      polars: detail.polars,
      visibleSeries: Object.fromEntries(
        detail.polars.map((polar) => [polar.seriesId, true]),
      ),
      hoverKey: null,
    });
    scopes.push({
      revision,
      fit: projection.curves.some((curve) => curve.kind === "fit"),
      evidence: detail.polars.flatMap((polar) => polar.points),
    });
    if (
      scopes.some((scope) => scope.evidence.length) &&
      scopes.some((scope) => !scope.evidence.length)
    )
      break;
  }
  await discovery.close();
  const fitted = scopes.find((scope) => scope.evidence.length);
  const missing = scopes.find((scope) => !scope.evidence.length);
  assert(fitted && missing, "Both real evidence and empty scopes are required");
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const scope of [fitted, missing]) {
      const url = `${origin}/airfoils/ag24?revision=${scope.revision}`;
      await page.goto(url, { waitUntil: "networkidle" });
      const viewer = page.getByTestId("polar-viewer");
      const chart = viewer.getByTestId("polar-chart-svg");
      const toggle = viewer.getByRole("button", { name: /^CFD points/ });
      await expect(viewer).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(chart.locator('circle[role="button"]')).toHaveCount(0);
      if (scope.fit) {
        await expect(chart.locator("polyline").first()).toBeVisible();
        assert(
          await chart
            .locator("polyline")
            .evaluateAll((curves) =>
              curves.every(
                (curve) => curve.getAttribute("stroke-dasharray") === "7 5",
              ),
            ),
        );
        await expect(
          viewer.getByText("No polar curve available yet."),
        ).toHaveCount(0);
      } else {
        await expect(chart.locator("polyline")).toHaveCount(0);
        await expect(
          viewer.getByText("No polar curve available yet."),
        ).toBeVisible();
      }
      const bounds = await viewer.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      if (scope.evidence.length) {
        const point = chart.locator('circle[role="button"]').first();
        await expect(point).toBeVisible();
        const storedResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/airfoils/ag24/sim" &&
            new URL(response.url()).searchParams.has("resultId"),
        );
        await point.focus();
        await point.press("Enter");
        const stored = await storedResponse;
        assert(stored.ok());
        const result = await stored.json();
        assert(
          scope.evidence.some(
            (evidence) => evidence.resultId === result.resultId,
          ),
        );
        await expect(page.getByTestId("sim-modal-dialog")).toBeVisible();
        await page.keyboard.press("Escape");
      }
      await toggle.click();
      await expect(chart.locator('circle[role="button"]')).toHaveCount(0);
      await page.reload({ waitUntil: "networkidle" });
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      outcomes.push({
        width,
        revision: scope.revision,
        cachedCurve: scope.fit,
      });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const page = await noScript.newPage();
  await page.goto(`${origin}/airfoils/ag24?revision=${fitted.revision}`);
  if (fitted.fit)
    await expect(
      page.getByTestId("polar-chart-svg").locator("polyline").first(),
    ).toBeVisible();
  else
    await expect(page.getByText("No polar curve available yet.")).toBeVisible();
  await page
    .getByRole("link", { name: "Show CFD points", exact: true })
    .click();
  await expect(
    page
      .getByTestId("polar-chart-svg")
      .locator('circle[role="button"]')
      .first(),
  ).toBeVisible();
  await noScript.close();
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({
    operation: "real-cfd-only-curve-first",
    observeOnly: true,
    outcomes,
  }),
);
