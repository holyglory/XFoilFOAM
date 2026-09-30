import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { projectChart } from "../../packages/core/src/index.ts";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const sourceGeometry = process.argv.includes("--source-geometry");
const origin = sourceGeometry
  ? "https://airfoils.pro"
  : progressivePreviewOrigin();
const evidenceDirectory = sourceGeometry
  ? `.codex-artifacts/cfd-source-geometry-browser/${randomUUID()}`
  : null;
if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const outcomes = [];
const acceptanceFailures = [];
try {
  const discovery = await browser.newContext();
  const worksResponse = await discovery.request.get(
    `${origin}/api/airfoils/ag24/solver-work`,
  );
  assert(worksResponse.ok());
  const works = await worksResponse.json();
  const scopes = [];
  const conditions = sourceGeometry
    ? [
        {
          slug: "ah21-7",
          presetRevisionId: "7c9de43b-29ab-4a94-ac81-76f16ded2c12",
          expectedResultId: "0b072fbd-03bf-47b5-b25c-4604edf0ce00",
          expectedAvailable: true,
        },
        {
          slug: "naca-16006",
          presetRevisionId: "1ffc088a-5703-4322-96a3-ff3d8cb36d14",
          expectedResultId: "235d9907-9ba5-4c28-9e40-f9aebe442052",
          expectedAvailable: false,
        },
      ]
    : works.conditions
        .slice(0, 24)
        .map((condition) => ({ ...condition, slug: "ag24" }));
  for (const condition of conditions) {
    const revision = condition.presetRevisionId;
    const response = await discovery.request.get(
      `${origin}/api/airfoils/${condition.slug}?revisionId=${revision}`,
    );
    assert(response.ok());
    const detail = await response.json();
    if (sourceGeometry) {
      const pointAvailable = detail.polars
        .flatMap((polar) => polar.points)
        .some((point) => point.resultId === condition.expectedResultId);
      if (pointAvailable !== condition.expectedAvailable)
        acceptanceFailures.push({
          slug: condition.slug,
          surface: "polar",
          expectedAvailable: condition.expectedAvailable,
          actualAvailable: pointAvailable,
        });
      const workResponse = await discovery.request.get(
        `${origin}/api/airfoils/${condition.slug}/solver-work?revisionId=${revision}`,
      );
      assert(workResponse.ok());
      const work = await workResponse.json();
      const workAvailable = work.conditions
        .flatMap((entry) => entry.points)
        .some(
          (point) =>
            point.resultId === condition.expectedResultId &&
            ["verified", "provisional"].includes(point.state),
        );
      if (workAvailable !== condition.expectedAvailable)
        acceptanceFailures.push({
          slug: condition.slug,
          surface: "solver-work",
          expectedAvailable: condition.expectedAvailable,
          actualAvailable: workAvailable,
        });
    }
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
      slug: condition.slug,
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
  const fitted = sourceGeometry
    ? scopes.find((scope) => scope.slug === "ah21-7")
    : scopes.find((scope) => scope.evidence.length);
  const missing = sourceGeometry
    ? scopes.find((scope) => scope.slug === "naca-16006")
    : scopes.find((scope) => !scope.evidence.length);
  assert(fitted && missing, "Both real evidence and empty scopes are required");
  for (const width of [320, 390, 1440]) {
    const page = await browser.newPage({
      viewport: { width, height: 1000 },
      hasTouch: width < 500,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const scope of [fitted, missing]) {
      const url = `${origin}/airfoils/${scope.slug}?revision=${scope.revision}`;
      await page.goto(url, { waitUntil: "networkidle" });
      const viewer = page.getByTestId("polar-viewer");
      const chart = viewer.getByTestId("polar-chart-svg");
      const toggle = viewer.getByRole("button", { name: /^CFD points/ });
      await expect(viewer).toBeVisible();
      const verifyGeometry = async () => {
        const geometry = await chart.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const view = element.viewBox.baseVal;
          const axes = [
            ...element.querySelectorAll("text[data-ui-verify-svg-overlap]"),
          ];
          return {
            width: bounds.width,
            viewWidth: view.width,
            height: bounds.height,
            minimumAxisFont: Math.min(
              ...axes.map(
                (axis) =>
                  (parseFloat(getComputedStyle(axis).fontSize) * bounds.width) /
                  view.width,
              ),
            ),
            labelsInside: [...element.querySelectorAll("text")].every(
              (text) => {
                const label = text.getBoundingClientRect();
                return (
                  label.left >= bounds.left - 1 &&
                  label.right <= bounds.right + 1 &&
                  label.top >= bounds.top - 1 &&
                  label.bottom <= bounds.bottom + 1
                );
              },
            ),
          };
        });
        assert(Math.abs(geometry.width - geometry.viewWidth) < 1);
        assert(geometry.height >= 239);
        assert(geometry.minimumAxisFont >= 9.5);
        assert(geometry.labelsInside);
      };
      await verifyGeometry();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      const unpin = page.getByRole("link", {
        name: "Unpin — view public data",
      });
      const unpinBounds = await unpin.boundingBox();
      assert(
        unpinBounds &&
          unpinBounds.width >= (width < 500 ? 44 : 32) &&
          unpinBounds.height >= (width < 500 ? 44 : 32),
      );
      await expect(chart.locator('circle[role="button"]')).toHaveCount(0);
      if (
        !scope.evidence.length ||
        scope.evidence.some(
          (point) => point.classificationState === "needs_urans",
        )
      )
        await expect(
          page.getByText("BEST-FIT POLAR", { exact: true }),
        ).toHaveCount(0);
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
      if (evidenceDirectory)
        await page.screenshot({
          path: `${evidenceDirectory}/${width}-${scope.slug}-points.png`,
          fullPage: true,
        });
      if (scope.evidence.length) {
        const point = chart.locator('circle[role="button"]').first();
        await expect(point).toBeVisible();
        await expect(chart).toHaveAttribute("role", "group");
        const expectedResultId = await point.getAttribute("data-result-id");
        assert(
          scope.evidence.some((entry) => entry.resultId === expectedResultId),
        );
        const target = await point.boundingBox();
        assert(target && target.width >= 43 && target.height >= 43);
        const storedResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
              `/api/airfoils/${scope.slug}/sim` &&
            new URL(response.url()).searchParams.has("resultId"),
        );
        if (width < 500) await point.tap();
        else {
          await point.focus();
          await point.press("Enter");
        }
        const stored = await storedResponse;
        assert(stored.ok());
        const result = await stored.json();
        assert.equal(result.resultId, expectedResultId);
        assert(
          scope.evidence.some(
            (evidence) => evidence.resultId === result.resultId,
          ),
        );
        await expect(page.getByTestId("sim-modal-dialog")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("sim-modal-dialog")).not.toBeVisible();
        await expect(point).toBeFocused();
        await page.setViewportSize({
          width: width < 500 ? 1440 : 390,
          height: 1000,
        });
        await expect(point).toBeFocused();
        await expect
          .poll(() =>
            chart.evaluate((element) =>
              Math.abs(
                element.getBoundingClientRect().width -
                  element.viewBox.baseVal.width,
              ),
            ),
          )
          .toBeLessThan(1);
        await verifyGeometry();
        await point.press("Enter");
        await expect(page.getByTestId("sim-modal-dialog")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("sim-modal-dialog")).not.toBeVisible();
        await expect(point).toBeFocused();
        await page.setViewportSize({ width, height: 1000 });
        await expect(point).toBeFocused();
      }
      await toggle.click();
      await expect(chart.locator('circle[role="button"]')).toHaveCount(0);
      await page.reload({ waitUntil: "networkidle" });
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      if (evidenceDirectory)
        await page.screenshot({
          path: `${evidenceDirectory}/${width}-${scope.slug}.png`,
          fullPage: true,
        });
      await unpin.click();
      await expect(page.getByTestId("progressive-polar-viewer")).toBeVisible();
      assert.equal(new URL(page.url()).search, "");
      outcomes.push({
        width,
        slug: scope.slug,
        revision: scope.revision,
        cachedCurve: scope.fit,
      });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const page = await noScript.newPage();
  await page.goto(
    `${origin}/airfoils/${fitted.slug}?revision=${fitted.revision}`,
  );
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
  if (evidenceDirectory)
    await writeFile(
      `${evidenceDirectory}/report.json`,
      JSON.stringify(
        {
          origin,
          sourceGeometry,
          observeOnly: true,
          outcomes,
          acceptanceFailures,
        },
        null,
        2,
      ),
    );
}
console.log(
  JSON.stringify({
    operation: "real-cfd-only-curve-first",
    observeOnly: true,
    outcomes,
    acceptanceFailures,
  }),
);
assert.deepEqual(
  acceptanceFailures,
  [],
  "Source-incompatible CFD must not be presented as accepted",
);
