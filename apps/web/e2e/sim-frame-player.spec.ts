// Solver-results modal — URANS frame-synced player (task #25).
//
// The dev DB has NO frame-track results yet (the engine side of the recording
// contract, task #23, is not deployed), so this spec exercises the player
// against a FIXTURE sim payload injected at the network boundary: the real
// detail page renders from the real DB, the modal opens from a real solved
// polar point, and only the /sim response + frame PNG bytes are intercepted.
// This is a test-only interception (Playwright route), never product code —
// no fake data touches the DB or the runtime API. Once a frame-track point
// exists in the dev DB the same assertions hold without the route (swap the
// interception for a real point lookup).
//
// Read-only: no records are created; all state lives in the intercepted page.

import { expect, request as pwRequest, test, type Page } from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_URL ?? "http://127.0.0.1:4000";

// 40 frames, t = 3.00 + 0.02k (3.00..3.78), window 3.0..3.8 s, period 0.4 s
// → exactly 2 recorded periods, 20 frames/period, matching the engine cadence.
const FRAME_COUNT = 40;
const FIELDS = ["vorticity", "velocity_magnitude"];
const frames = Array.from({ length: FRAME_COUNT }, (_, k) => ({
  i: k,
  t: Number((3 + 0.02 * k).toFixed(4)),
  cl: Number((0.91 + 0.15 * Math.sin((2 * Math.PI * k) / 20)).toFixed(5)),
  cd: Number((0.042 + 0.006 * Math.sin((2 * Math.PI * k) / 20 + 0.7)).toFixed(6)),
  cm: Number((-0.031 + 0.004 * Math.cos((2 * Math.PI * k) / 20)).toFixed(6)),
  imageUrls: Object.fromEntries(
    FIELDS.map((f) => [f, `/api/media/e2e-frames/${f}/f${String(k).padStart(4, "0")}.png`]),
  ),
}));

const fixtureSim = {
  status: "solved",
  regime: "stalled",
  airfoilName: "fixture",
  alpha: 16,
  re: 200000,
  mach: 0.06,
  cl: 0.91,
  cd: 0.042,
  cm: -0.031,
  ld: 21.7,
  clStd: 0.11,
  cdStd: 0.004,
  strouhal: 0.21,
  media: null,
  availableFields: [],
  evidenceArtifacts: [],
  history: {
    t: Array.from({ length: 200 }, (_, k) => Number((k * 0.02).toFixed(3))),
    cl: Array.from({ length: 200 }, (_, k) => Number((0.9 + 0.15 * Math.sin(k / 3)).toFixed(5))),
    cd: Array.from({ length: 200 }, (_, k) => Number((0.04 + 0.006 * Math.sin(k / 3 + 0.7)).toFixed(6))),
  },
  frameTrack: {
    periodS: 0.4,
    periodsRetained: 6,
    stationary: true,
    driftFrac: 0.012,
    window: { tStart: 3.0, tEnd: 3.8 },
    stats: {
      cl: { mean: 0.912, std: 0.148, min: 0.61, max: 1.19 },
      cd: { mean: 0.0421, std: 0.0063, min: 0.031, max: 0.055 },
      cm: { mean: -0.0318, std: 0.0045, min: -0.041, max: -0.02 },
    },
    fields: FIELDS,
    frames,
  },
  condition: null,
};

// 1×1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function interceptSim(page: Page) {
  await page.route("**/api/airfoils/*/sim*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixtureSim) }),
  );
  await page.route("**/api/media/e2e-frames/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );
}

/** Find any real airfoil with a solved (clickable) polar point in the dev DB. */
async function findSolvedSlug(): Promise<string | null> {
  const api = await pwRequest.newContext({ baseURL: API });
  try {
    const listRes = await api.get("/api/airfoils?limit=40");
    if (!listRes.ok()) return null;
    const { items } = (await listRes.json()) as { items: Array<{ slug: string }> };
    for (const { slug } of items.slice(0, 40)) {
      const detRes = await api.get(`/api/airfoils/${encodeURIComponent(slug)}`);
      if (!detRes.ok()) continue;
      const detail = (await detRes.json()) as { polars?: Array<{ points?: Array<{ source?: string; resultId?: string | null }> }> };
      const solved = detail.polars?.some((p) => p.points?.some((pt) => pt.source === "solved" && pt.resultId));
      if (solved) return slug;
    }
    return null;
  } catch {
    return null;
  } finally {
    await api.dispose();
  }
}

/** Click polar-chart point circles until the sim modal opens (only solved
 *  points open it). Chart points are the only circles rendered with a
 *  pointer-cursor inline style — this keeps the logo/nav SVGs out. */
async function openSimModal(page: Page): Promise<boolean> {
  const circles = page.locator('circle[style*="pointer"]');
  await circles.first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  const n = Math.min(await circles.count(), 60);
  for (let k = 0; k < n; k++) {
    try {
      await circles.nth(k).click({ force: true, timeout: 2_000 });
    } catch {
      continue;
    }
    try {
      await page.getByTestId("sim-frame-player").waitFor({ state: "visible", timeout: 1_200 });
      return true;
    } catch {
      // not a solved point — close a possibly opened non-frames modal and continue
      const close = page.getByRole("button", { name: "✕" });
      if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
    }
  }
  return false;
}

test.describe("URANS frame-synced player (fixture-intercepted sim payload)", () => {
  test("player, scrub/chart/image/readout stay on one frame clock", async ({ page }) => {
    const slug = await findSolvedSlug();
    test.skip(!slug, "No solved polar point (or no API) in the dev DB — the modal cannot be opened from a real chart point.");

    await interceptSim(page);
    await page.goto(`/airfoils/${slug}`);
    const opened = await openSimModal(page);
    expect(opened, "a solved polar point should open the sim modal").toBe(true);

    // Header chips: regime/classification, periods, stationarity, St.
    const chips = page.getByTestId("sim-frame-chips");
    await expect(chips).toContainText("URANS · vortex shedding");
    await expect(chips).toContainText("6 periods retained");
    await expect(page.getByTestId("sim-chip-stationary")).toContainText("stationary ✓");
    await expect(chips).toContainText("St 0.21");

    // Accent stats: time-weighted means ± std, L/D, period + frequency.
    const stats = page.getByTestId("sim-accent-stats");
    await expect(stats).toContainText("0.912");
    await expect(stats).toContainText("± 0.148 std");
    await expect(stats).toContainText("0.0421");
    await expect(stats).toContainText("21.66"); // 0.912 / 0.0421 time-weighted L/D
    await expect(stats).toContainText("0.400 s");
    await expect(stats).toContainText("f 2.50 Hz");

    // No legacy note in frames mode.
    await expect(page.getByTestId("sim-legacy-note")).toHaveCount(0);

    // Pause (modal opens playing), then scrub to frame 10 → every surface follows.
    const play = page.getByTestId("sim-frame-play");
    await play.click();
    await expect(play).toHaveText("▶");
    const scrub = page.getByTestId("sim-frame-scrub");
    await scrub.evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, 10);
    const readout = page.getByTestId("sim-frame-readout");
    await expect(readout).toContainText("t 3.200 s");
    await expect(readout).toContainText("period 1/2");
    await expect(page.getByTestId("sim-frame-image")).toHaveAttribute("src", /\/vorticity\/f0010\.png$/);

    // Chart click near the right edge seeks into the second period. Element
    // click (not page.mouse) so Playwright scrolls the chart into view first —
    // clicking the play button above scrolls the modal and can push the chart
    // off-viewport, where raw mouse coordinates would hit nothing.
    const chart = page.getByTestId("sim-frame-chart");
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.boundingBox())!;
    await chart.click({ position: { x: box.width - 12, y: box.height / 2 } });
    await expect(readout).toContainText("period 2/2");
    const idxAfterChartClick = await scrub.inputValue();
    expect(Number(idxAfterChartClick)).toBeGreaterThan(30);

    // Field selector swaps the frame image source for the SAME frame index.
    await page.getByTestId("sim-frame-field-velocity_magnitude").click();
    await expect(page.getByTestId("sim-frame-image")).toHaveAttribute(
      "src",
      new RegExp(`/velocity_magnitude/f00${idxAfterChartClick.padStart(2, "0")}\\.png$`),
    );

    // Speed toggle 1.0× ↔ 0.5×.
    const speed = page.getByTestId("sim-frame-speed");
    await expect(speed).toHaveText("1.0×");
    await speed.click();
    await expect(speed).toHaveText("0.5×");

    // Resume: the frame clock advances again.
    await play.click();
    await expect(play).toHaveText("❚❚");
    const before = await scrub.inputValue();
    await page.waitForTimeout(400);
    const after = await scrub.inputValue();
    expect(after).not.toBe(before);

    // Secondary surfaces (stored media/evidence) are still present below.
    await expect(page.getByText("STORED FIELD MEDIA & EVIDENCE")).toBeVisible();
  });
});
