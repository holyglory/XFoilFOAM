import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = progressivePreviewOrigin();
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const target of [
    {
      path: "/airfoils/ag24",
      viewer: "progressive-polar-viewer",
      group: "Polar quantities",
      curve: "progressive-polar-curve",
    },
    {
      path: "/compare?airfoil=ag24&airfoil=ag25",
      viewer: "progressive-comparison",
      group: "Comparison quantities",
      curve: "comparison-curve",
    },
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + target.path, { waitUntil: "domcontentloaded" });
    const viewer = page.getByTestId(target.viewer);
    const group = viewer.getByRole("group", { name: target.group });
    const buttons = group.getByRole("button");
    const moment = group.getByRole("button", {
      name: "Pitching moment",
      exact: true,
    });
    await expect(buttons.first()).toBeEnabled();
    for (const theme of ["dark", "light"]) {
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page
          .getByRole("button", { name: `Switch to ${theme} theme` })
          .click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await moment.click();
      for (const width of [
        1440, 800, 650, 560, 480, 390, 360, 320, 390, 480, 650, 800, 1440,
      ]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        await expect(moment).toBeFocused();
        await expect(moment).toHaveAttribute("aria-pressed", "true");
        const geometry = await group.evaluate((row) => ({
          row: row.getBoundingClientRect().toJSON(),
          buttons: [...row.querySelectorAll("button")].map((button) =>
            button.getBoundingClientRect().toJSON(),
          ),
          compact: row.dataset.compact,
          documentOverflow:
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        }));
        assert.equal(
          geometry.documentOverflow,
          false,
          JSON.stringify({ target, theme, width, geometry }),
        );
        assert.equal(geometry.buttons.length, 5);
        for (const button of geometry.buttons) {
          assert(
            Math.abs(button.y - geometry.buttons[0].y) <= 1,
            JSON.stringify({ target, theme, width, geometry }),
          );
          assert(
            button.x >= geometry.row.x - 1 &&
              button.right <= geometry.row.right + 1,
          );
          assert(
            button.width >= 44 &&
              button.height >= (geometry.compact === "true" ? 44 : 32),
          );
        }
        if (width === 1440) assert.equal(geometry.compact, "false");
        if (width <= 390) assert.equal(geometry.compact, "true");
      }
      await group.locator("[data-expanded-label]").evaluateAll((labels) => {
        for (const label of labels) {
          label.dataset.original = label.textContent;
          label.textContent = label.textContent.repeat(5);
        }
      });
      await page.setViewportSize({ width: 650, height: 1000 });
      await expect(group).toHaveAttribute("data-compact", "true");
      await group.locator("[data-expanded-label]").evaluateAll((labels) => {
        for (const label of labels) label.textContent = label.dataset.original;
      });
      await page.setViewportSize({ width: 390, height: 1000 });
      await group.evaluate((row) => {
        row.style.fontSize = "26px";
      });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const zoomed = await group.evaluate((row) => ({
        right: row.getBoundingClientRect().right,
        buttons: [...row.querySelectorAll("button")].map((button) =>
          button.getBoundingClientRect().toJSON(),
        ),
      }));
      assert(
        zoomed.buttons.every((button) => button.right <= zoomed.right + 1),
      );
      await group.evaluate((row) => {
        row.style.fontSize = "";
      });
      for (const name of [
        "Lift",
        "Drag",
        "Pitching moment",
        "Lift / drag",
        "Drag polar",
      ]) {
        const before = await viewer
          .getByTestId(target.curve)
          .first()
          .getAttribute("d");
        const button = group.getByRole("button", { name, exact: true });
        await button.click();
        await expect(button).toHaveAttribute("aria-pressed", "true");
        await expect(
          viewer.getByTestId(target.curve).first(),
        ).not.toHaveAttribute("d", before);
      }
      results.push({
        path: target.path,
        theme,
        widths: 13,
        extendedLabels: true,
        textZoom: "200%",
        actions: 5,
      });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ kind: "polar-control-sizing", results }));
