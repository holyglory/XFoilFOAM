import { chromium } from "@playwright/test";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = progressivePreviewOrigin();
const browser = await chromium.launch({ headless: true });
try {
  for (const [width, direct] of [[390, false], [390, true], [1440, true]]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
    await page.addInitScript(() => {
      const events = [];
      const selectors = ["h1", '[data-testid="progressive-polar-viewer"] > header', '[data-testid="progressive-polar-viewer"] input', '[data-testid="progressive-polar-viewer"] svg'];
      const snapshot = (reason) => {
        if (events.length >= 60) return;
        events.push({ reason, time: performance.now(), scroll: window.scrollY, fonts: document.fonts.status,
          nodes: selectors.map((selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const bounds = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return { selector, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
              font: style.font, disabled: node.disabled ?? null };
          }),
        });
      };
      window.__polarScrollDiagnosis = { events, snapshot };
      document.fonts.addEventListener("loading", () => snapshot("fonts-loading"));
      document.fonts.addEventListener("loadingdone", () => snapshot("fonts-done"));
      window.addEventListener("scroll", () => snapshot("scroll"));
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (events.length >= 60) break;
          events.push({ reason: "layout-shift", time: entry.startTime, value: entry.value, recentInput: entry.hadRecentInput,
            sources: entry.sources.map((source) => ({ tag: source.node?.tagName,
              previous: source.previousRect.toJSON(), current: source.currentRect.toJSON() })),
          });
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto(`${origin}/airfoils/ag24`, { waitUntil: "domcontentloaded" });
    const viewer = page.getByTestId("progressive-polar-viewer");
    await viewer.waitFor();
    await page.evaluate(() => window.__polarScrollDiagnosis.snapshot("before-check"));
    const samples = viewer.getByLabel("Show prediction samples");
    if (direct) {
      await page.locator('[data-testid="progressive-polar-viewer"][aria-busy="false"]').waitFor();
      const bounds = await samples.boundingBox();
      if (!bounds || !(await samples.isEnabled())) throw new Error("Samples control is not ready");
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    } else {
      await samples.check();
    }
    await page.evaluate(() => window.__polarScrollDiagnosis.snapshot("after-check"));
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.__polarScrollDiagnosis.snapshot("settled");
    });
    console.log(JSON.stringify({ origin, width, direct, checked: await samples.isChecked(), events: await page.evaluate(() => window.__polarScrollDiagnosis.events) }));
    await page.close();
  }
} finally {
  await browser.close();
}
