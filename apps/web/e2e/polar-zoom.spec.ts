// Polar chart α-domain regression + zoom/pan/readout interactions.
//
// REGRESSION under test: the chart used to hard-code the α window to −8..20
// while campaign polars sweep −15..30, so curves drew OUTSIDE the axes (and,
// on compare, outside the svg). projectChart now fits the window to the data
// and clips curves/points to the plot rect; this spec must fail on any
// re-introduction of the fixed window.
//
// Data source: the LIVE route /airfoils/clarky. A hermetic Playwright
// page.route fixture (the sim-frame-player.spec.ts idiom) is NOT possible
// here: app/airfoils/[slug]/page.tsx awaits getAirfoilDetail() in the server
// component, so the polar payload is fetched inside the Next server process
// and embedded in the SSR HTML — browser-level interception never sees it.
// (Verified: the payload's resultIds appear in the raw document response.)
// The dev DB carries a real clarky polar with α −15..30 at Re 3 411 565
// under an enabled preset; when that row is missing (e.g. a fresh CI DB) the
// spec skips with an explicit reason instead of asserting against absent
// data. Read-only: no records are created.

import { expect, request as pwRequest, test, type Locator, type Page } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_URL ?? "http://127.0.0.1:4000";

/** CHART_VIEW plot rect (viewBox units) with float-parse tolerance. */
const RECT = { x0: 57.9, x1: 664.1, y0: 19.9, y1: 344.1 };
const SVG_SEL = '[data-testid="polar-chart-svg"]';
/** viewBox size — the svg renders width:100% inside a max-width 684 wrapper. */
const VBW = 684;
const VBH = 372;
/** Plot-rect center in viewBox units. */
const PLOT_CENTER = { vx: 361, vy: 182 };

// ---------------------------------------------------------------- guards --

let wideSweepCache: boolean | null = null;

/** True when the dev DB serves a clarky polar spanning at least −10..25° —
 *  the surface the fixed-window bug used to break. */
async function hasWideSweepClarky(): Promise<boolean> {
  if (wideSweepCache !== null) return wideSweepCache;
  const api = await pwRequest.newContext({ baseURL: API });
  try {
    const res = await api.get("/api/airfoils/clarky");
    if (!res.ok()) return (wideSweepCache = false);
    const detail = (await res.json()) as { polars?: Array<{ points?: Array<{ a: number }> }> };
    wideSweepCache = !!detail.polars?.some((polar) => {
      const alphas = (polar.points ?? []).map((p) => p.a).filter(Number.isFinite);
      return alphas.length > 0 && Math.min(...alphas) <= -10 && Math.max(...alphas) >= 25;
    });
    return wideSweepCache;
  } catch {
    return (wideSweepCache = false);
  } finally {
    await api.dispose();
  }
}

// --------------------------------------------------------------- helpers --

interface ChartGeometry {
  polylines: [number, number][][];
  circles: [number, number][];
}

/** Parse every polyline vertex and circle center inside the chart svg. */
function readGeometry(page: Page): Promise<ChartGeometry> {
  return page.evaluate((sel) => {
    const svg = document.querySelector(sel)!;
    const polylines = Array.from(svg.querySelectorAll("polyline")).map((pl) =>
      (pl.getAttribute("points") ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((pair) => pair.split(",").map(Number) as [number, number]),
    );
    const circles = Array.from(svg.querySelectorAll("circle")).map(
      (c) => [Number(c.getAttribute("cx")), Number(c.getAttribute("cy"))] as [number, number],
    );
    return { polylines, circles };
  }, SVG_SEL);
}

/** x-axis tick labels — PolarChart renders them (and only them) at y=354. */
function readXTickLabels(page: Page): Promise<string[]> {
  return page.evaluate((sel) => {
    const svg = document.querySelector(sel)!;
    return Array.from(svg.querySelectorAll("text"))
      .filter((t) => t.getAttribute("y") === "354")
      .map((t) => t.textContent ?? "");
  }, SVG_SEL);
}

const labelsJoined = async (page: Page) => (await readXTickLabels(page)).join("|");

/** Every coordinate that escapes the plot rect (empty array = regression-free). */
function rectViolations(geom: ChartGeometry): string[] {
  const out: string[] = [];
  const check = (x: number, y: number, what: string) => {
    if (!(x >= RECT.x0 && x <= RECT.x1 && y >= RECT.y0 && y <= RECT.y1)) out.push(`${what} at (${x}, ${y})`);
  };
  geom.polylines.forEach((poly, i) => poly.forEach(([x, y]) => check(x, y, `polyline[${i}] vertex`)));
  geom.circles.forEach(([x, y], i) => check(x, y, `circle[${i}]`));
  return out;
}

const numericLabels = (labels: string[]) => labels.map(Number).filter(Number.isFinite);

/** Fresh viewBox→client mapping (recomputed per call: toolbar clicks can
 *  auto-scroll the page and shift the svg between interactions). */
async function vbToClient(svg: Locator, vx: number, vy: number): Promise<{ x: number; y: number }> {
  const box = (await svg.boundingBox())!;
  return { x: box.x + (vx * box.width) / VBW, y: box.y + (vy * box.height) / VBH };
}

/**
 * Open /airfoils/clarky and wait until the chart is INTERACTIVE, not just
 * painted: the SSR HTML already contains the svg, but wheel/pointer handlers
 * only exist after hydration. Pointer-moving over the plot until a badge
 * reacts proves the handlers are live (and has no scroll side effects).
 */
async function gotoChart(page: Page): Promise<{ svg: Locator; pageErrors: string[] }> {
  test.skip(
    !(await hasWideSweepClarky()),
    "dev DB lacks a clarky polar spanning α ≤ −10 … ≥ 25 (SSR payload cannot be fixture-intercepted) — regression surface unavailable",
  );
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.goto("/airfoils/clarky");
  const svg = page.locator(SVG_SEL);
  await svg.scrollIntoViewIfNeeded();
  await expect(svg.locator("polyline").first()).toBeVisible();
  await expect
    .poll(
      async () => {
        const jitter = Math.random() * 6 - 3;
        const p = await vbToClient(svg, PLOT_CENTER.vx + jitter, PLOT_CENTER.vy + jitter);
        await page.mouse.move(p.x, p.y);
        return (
          (await page.getByTestId("polar-readout-badge").count()) +
          (await page.getByTestId("polar-hover-badge").count())
        );
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  // park the cursor inside the svg but outside the axes → badges clear
  const off = await vbToClient(svg, 30, 10);
  await page.mouse.move(off.x, off.y);
  await expect(page.getByTestId("polar-readout-badge")).toHaveCount(0);
  await expect(page.getByTestId("polar-hover-badge")).toHaveCount(0);
  return { svg, pageErrors };
}

/** The two most point-distant in-plot spots (left/right half), in viewBox
 *  units — guaranteed outside the 14-unit snap radius so the mouse-following
 *  readout badge (not the point-snap badge) appears there. vx is kept in
 *  90..630 so the cursor α stays inside the measured span (readout rows
 *  interpolate only within it). */
function findSnapFreeSpots(page: Page): Promise<{ vx: number; vy: number; dist: number }[]> {
  return page.evaluate((sel) => {
    const svg = document.querySelector(sel)!;
    const circles = Array.from(svg.querySelectorAll("circle")).map(
      (c) => [Number(c.getAttribute("cx")), Number(c.getAttribute("cy"))] as [number, number],
    );
    const bestIn = (vxLo: number, vxHi: number) => {
      let best = { vx: vxLo, vy: 182, dist: -1 };
      for (let vx = vxLo; vx <= vxHi; vx += 6) {
        for (let vy = 40; vy <= 320; vy += 6) {
          let d = Infinity;
          for (const [cx, cy] of circles) d = Math.min(d, Math.hypot(cx - vx, cy - vy));
          if (d > best.dist) best = { vx, vy, dist: d };
        }
      }
      return best;
    };
    return [bestIn(90, 350), bestIn(370, 630)];
  }, SVG_SEL);
}

// ----------------------------------------------------------------- tests --

test.describe("polar chart: fitted α domain + zoom/pan/readout", () => {
  test("regression: campaign sweep −15..30 renders entirely inside the plot rect with a fitted α axis", async ({ page }) => {
    await gotoChart(page);

    const geom = await readGeometry(page);
    expect(geom.polylines.length, "at least one curve polyline").toBeGreaterThanOrEqual(1);
    expect(geom.circles.length, "at least one measured-point circle").toBeGreaterThanOrEqual(1);
    // The prod bug drew polyline vertices far outside [58,664]×[20,344].
    expect(rectViolations(geom)).toEqual([]);

    // Fitted window shows the FULL sweep: ticks reach ≤ −10 and ≥ 25
    // (impossible with the old fixed −8..20 window / tick list).
    const ticks = numericLabels(await readXTickLabels(page));
    expect(ticks.length).toBeGreaterThan(2);
    expect(Math.min(...ticks)).toBeLessThanOrEqual(-10);
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(25);
  });

  test("wheel zoom narrows the α window; zoom-fit restores it", async ({ page }) => {
    const { svg } = await gotoChart(page);
    const fitLabels = await readXTickLabels(page);
    const fitJoined = fitLabels.join("|");

    const center = await vbToClient(svg, PLOT_CENTER.vx, PLOT_CENTER.vy);
    await page.mouse.move(center.x, center.y);
    // deltaY < 0 = zoom in about the cursor; poll in case an event is dropped.
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, -120);
        return labelsJoined(page);
      })
      .not.toBe(fitJoined);

    const zoomed = numericLabels(await readXTickLabels(page));
    const fitNums = numericLabels(fitLabels);
    // Narrower window, symmetric about the plot-center anchor.
    expect(Math.min(...zoomed)).toBeGreaterThan(Math.min(...fitNums));
    expect(Math.max(...zoomed)).toBeLessThan(Math.max(...fitNums));
    // Everything stays clipped to the plot rect while zoomed.
    expect(rectViolations(await readGeometry(page))).toEqual([]);

    await page.getByTestId("polar-zoom-fit").click();
    await expect.poll(() => labelsJoined(page)).toBe(fitJoined);
  });

  test("toolbar zoom in/out buttons change the ticks and restore them, with no page errors", async ({ page }) => {
    const { pageErrors } = await gotoChart(page);
    const fitJoined = await labelsJoined(page);

    await page.getByTestId("polar-zoom-in").click();
    await expect.poll(() => labelsJoined(page)).not.toBe(fitJoined);
    const zoomedJoined = await labelsJoined(page);
    expect(zoomedJoined).not.toBe(fitJoined);
    expect(rectViolations(await readGeometry(page))).toEqual([]);

    // Zoom-out inverts the same center-anchored step → the fitted ticks return.
    await page.getByTestId("polar-zoom-out").click();
    await expect.poll(() => labelsJoined(page)).toBe(fitJoined);

    expect(pageErrors).toEqual([]);
  });

  test("drag pan shifts the α window, marks the fit button active, and fit restores", async ({ page }) => {
    const { svg } = await gotoChart(page);
    const fitJoined = await labelsJoined(page);
    const fitBtn = page.getByTestId("polar-zoom-fit");
    // zoom-to-fit → the fit button is idle (transparent background)
    expect(await fitBtn.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");

    const start = await vbToClient(svg, PLOT_CENTER.vx, PLOT_CENTER.vy);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 120, start.y, { steps: 8 });
    await page.mouse.up();

    await expect.poll(() => labelsJoined(page)).not.toBe(fitJoined);
    expect(rectViolations(await readGeometry(page))).toEqual([]);
    // Zoomed/panned state renders the fit button with a background.
    expect(await fitBtn.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");

    await fitBtn.click();
    await expect.poll(() => labelsJoined(page)).toBe(fitJoined);
    expect(await fitBtn.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  });

  test("hover: interpolated readout badge away from points, point-snap badge near a point, none outside the axes", async ({ page }) => {
    const { svg } = await gotoChart(page);
    const readout = page.getByTestId("polar-readout-badge");
    const snap = page.getByTestId("polar-hover-badge");

    const [spot] = await findSnapFreeSpots(page);
    expect(spot.dist, "grid scan must find a spot outside the 14-unit snap radius").toBeGreaterThan(16);
    const away = await vbToClient(svg, spot.vx, spot.vy);
    await page.mouse.move(away.x, away.y);
    await expect(readout).toBeVisible();
    await expect(readout).toContainText("α ");
    await expect(readout).toContainText("Cl ");
    await expect(snap).toHaveCount(0);

    // Move onto a measured point (circle center → client px) → snap badge
    // replaces the interpolated readout.
    const [cx, cy] = (await readGeometry(page)).circles[0];
    const onPoint = await vbToClient(svg, cx, cy);
    await page.mouse.move(onPoint.x, onPoint.y);
    await expect(snap).toBeVisible();
    await expect(readout).toHaveCount(0);

    // Outside the axes (left margin of the svg) → both badges gone.
    const outside = await vbToClient(svg, 30, 182);
    await page.mouse.move(outside.x, outside.y);
    await expect(snap).toHaveCount(0);
    await expect(readout).toHaveCount(0);
  });

  test("readout badge follows the mouse between two cursor positions", async ({ page }) => {
    const { svg } = await gotoChart(page);
    const readout = page.getByTestId("polar-readout-badge");

    const [left, right] = await findSnapFreeSpots(page);
    expect(left.dist).toBeGreaterThan(16);
    expect(right.dist).toBeGreaterThan(16);

    const a = await vbToClient(svg, left.vx, left.vy);
    await page.mouse.move(a.x, a.y);
    await expect(readout).toBeVisible();
    const boxA = (await readout.boundingBox())!;

    const b = await vbToClient(svg, right.vx, right.vy);
    await page.mouse.move(b.x, b.y);
    await expect(readout).toBeVisible();
    const boxB = (await readout.boundingBox())!;

    // The spots are ≥ 20 viewBox units apart in x — the badge must move with
    // the cursor (its left tracks px+14, capped at 500).
    expect(Math.abs(boxB.x - boxA.x)).toBeGreaterThan(10);
  });
});
