import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = progressivePreviewOrigin();
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.comparisonScrollTrace = [];
      for (const eventName of ["scroll", "focusin", "pointerdown", "click"]) {
        window.addEventListener(
          eventName,
          (event) => {
            if (window.comparisonScrollTrace.length >= 24) return;
            window.comparisonScrollTrace.push({
              event: eventName,
              scrollY: window.scrollY,
              target: event.target?.tagName,
              active: document.activeElement?.outerHTML.slice(0, 240),
              height: document.documentElement.scrollHeight,
              rect:
                event.target instanceof Element
                  ? event.target.getBoundingClientRect().toJSON()
                  : null,
            });
          },
          true,
        );
      }
    });
    for (let navigation = 0; navigation < 6; navigation += 1) {
      await page.goto(`${origin}/compare?airfoil=ag24&airfoil=ag25`, {
        waitUntil: "domcontentloaded",
      });
      const initialViewer = page.getByTestId("progressive-comparison");
      const sampleToggle = initialViewer.getByLabel("Show curve samples");
      await expect(sampleToggle).toBeEnabled();
      if (navigation % 2 === 1) await sampleToggle.scrollIntoViewIfNeeded();
      const beforeInteraction = await page.evaluate(() => ({
        scrollY: window.scrollY,
        height: document.documentElement.scrollHeight,
      }));
      await sampleToggle.check();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await expect(initialViewer.getByTestId("comparison-sample")).toHaveCount(
        52,
      );
      assert.equal(
        await page.evaluate(() => window.scrollY),
        0,
        JSON.stringify({
          viewport,
          navigation,
          beforeInteraction,
          trace: await page.evaluate(() => window.comparisonScrollTrace),
          chart: await initialViewer.locator("svg").boundingBox(),
        }),
      );
      await initialViewer.getByLabel("Show curve samples").uncheck();
    }
    await page.goto(`${origin}/airfoils/ag24`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("link", { name: "Compare", exact: true })
      .last()
      .click();
    await expect(page).toHaveURL(/\/compare\?airfoil=ag24$/);
    const viewer = page.getByTestId("progressive-comparison");
    await expect(viewer.getByTestId("comparison-curve")).toHaveCount(1);
    await expect(viewer.getByTestId("comparison-sample")).toHaveCount(0);
    const add = page.getByRole("button", {
      name: "＋ add airfoil…",
      exact: true,
    });
    await add.click();
    const search = page.getByPlaceholder("⌕  search airfoils…");
    await search.fill("ag25");
    await search.press("Enter");
    await search.press("Escape");
    await expect(viewer.getByTestId("comparison-curve")).toHaveCount(2);
    assert.deepEqual(new URL(page.url()).searchParams.getAll("airfoil"), [
      "ag24",
      "ag25",
    ]);
    assert.deepEqual(
      await viewer
        .getByTestId("comparison-curve")
        .evaluateAll((paths) => paths.map((path) => path.dataset.profile)),
      ["ag24", "ag25"],
    );
    const chart = viewer.locator("svg");
    const box = await chart.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= viewport.width + 1);
    assert(
      box.y < viewport.height * 0.7,
      `Comparison chart displaced: ${JSON.stringify({ viewport, box })}`,
    );
    const conditions = viewer.getByLabel("Comparison condition");
    assert((await conditions.locator("option").count()) >= 6);
    const before = await viewer
      .getByTestId("comparison-curve")
      .first()
      .getAttribute("d");
    await conditions.selectOption({ index: 5 });
    assert.notEqual(
      await viewer.getByTestId("comparison-curve").first().getAttribute("d"),
      before,
    );
    for (const quantity of [
      "Drag",
      "Pitching moment",
      "Lift / drag",
      "Drag polar",
      "Lift",
    ]) {
      const control = viewer.getByRole("button", {
        name: quantity,
        exact: true,
      });
      await control.click();
      await expect(control).toHaveAttribute("aria-pressed", "true");
      await expect(chart).toHaveAttribute(
        "aria-label",
        `${quantity} comparison`,
      );
      await expect(viewer.getByTestId("comparison-curve")).toHaveCount(2);
    }
    await viewer.getByLabel("Show curve samples").check();
    await expect(viewer.getByTestId("comparison-sample")).toHaveCount(52);
    await viewer.getByLabel("Show curve samples").uncheck();
    await expect(viewer.getByTestId("comparison-sample")).toHaveCount(0);
    await viewer.locator("summary").click();
    await expect(viewer.locator("details")).toHaveAttribute("open", "");
    await viewer.locator("summary").click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(viewer.getByTestId("comparison-curve")).toHaveCount(2);
    await page
      .getByRole("button", { name: /^Remove AG25 .* from comparison$/ })
      .click();
    await expect(viewer.getByTestId("comparison-curve")).toHaveCount(1);
    assert.deepEqual(new URL(page.url()).searchParams.getAll("airfoil"), [
      "ag24",
    ]);
    await page
      .getByRole("button", { name: "Clear comparison", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText(
      "Choose profiles to compare their polars.",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("status")).toHaveText(
      "Choose profiles to compare their polars.",
    );
    await expect(viewer).toHaveCount(0);
    await page.goto(
      `${origin}/compare?airfoil=missing-progressive-preview-profile`,
      { waitUntil: "domcontentloaded" },
    );
    const unavailable = page
      .getByRole("alert")
      .filter({ hasText: "missing-progressive-preview-profile:" });
    await expect(unavailable).toContainText("Profile unavailable.");
    const retry = page.waitForResponse((response) =>
      response
        .url()
        .includes("/api/airfoils/missing-progressive-preview-profile"),
    );
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    assert.equal((await retry).status(), 404);
    await expect(unavailable).toContainText("Profile unavailable.");
    await page
      .getByRole("button", {
        name: "Remove missing-progressive-preview-profile from comparison",
        exact: true,
      })
      .click();
    await expect(page.getByRole("status")).toHaveText(
      "Choose profiles to compare their polars.",
    );
    assert.deepEqual(errors, []);
    results.push({
      viewport,
      realProfiles: ["ag24", "ag25"],
      conditions: 6,
      quantities: 5,
      samples: true,
      reload: true,
      remove: true,
      clear: true,
      missingProfileRetry: true,
    });
    await page.close();
  }
  console.log(
    JSON.stringify({ purpose: "real-progressive-comparison", origin, results }),
  );
} finally {
  await browser.close();
}
