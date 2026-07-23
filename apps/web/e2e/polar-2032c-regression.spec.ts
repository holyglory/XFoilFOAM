import {
  expect,
  request as pwRequest,
  test,
  type Locator,
  type Page,
} from "@playwright/test";

const API = process.env.PLAYWRIGHT_API_URL ?? "http://127.0.0.1:4000";
const SLUG = "2032c";

async function has2032cPolar(): Promise<boolean> {
  const api = await pwRequest.newContext({ baseURL: API });
  try {
    const response = await api.get(`/api/airfoils/${SLUG}`);
    if (!response.ok()) return false;
    const detail = (await response.json()) as {
      polars?: Array<{ label?: string; points?: unknown[] }>;
    };
    return !!detail.polars?.some(
      (polar) =>
        polar.label?.startsWith("Re 102k") && (polar.points?.length ?? 0) > 0,
    );
  } finally {
    await api.dispose();
  }
}

async function openLdChart(page: Page): Promise<Locator> {
  test.skip(
    !(await has2032cPolar()),
    "20-32C Re 102k production evidence is unavailable",
  );
  await page.setViewportSize({ width: 878, height: 1_290 });
  await page.goto(`/airfoils/${SLUG}`);
  await page.getByRole("tab", { name: "L/D–α" }).click();
  const svg = page.getByTestId("polar-chart-svg");
  await svg.scrollIntoViewIfNeeded();
  await expect(svg.locator("circle").first()).toBeVisible();
  return svg;
}

async function moveToRightmostPoint(page: Page, svg: Locator): Promise<void> {
  const point = await svg.locator("circle").evaluateAll((circles) => {
    const rightmost = [...circles].sort(
      (a, b) => Number(b.getAttribute("cx")) - Number(a.getAttribute("cx")),
    )[0];
    return {
      x: Number(rightmost.getAttribute("cx")),
      y: Number(rightmost.getAttribute("cy")),
    };
  });
  const box = (await svg.boundingBox())!;
  const viewBox = (await svg.getAttribute("viewBox"))!.split(/\s+/).map(Number);
  await page.mouse.move(
    box.x + (point.x / viewBox[2]) * box.width,
    box.y + (point.y / viewBox[3]) * box.height,
  );
}

test.describe("20-32C polar regressions", () => {
  test("the point badge stays fully inside the chart card at the reported narrow viewport", async ({
    page,
  }) => {
    const svg = await openLdChart(page);
    await moveToRightmostPoint(page, svg);
    const badge = page.getByTestId("polar-hover-badge");
    await expect(badge).toBeVisible();

    const [badgeBox, surfaceBox] = await Promise.all([
      badge.boundingBox(),
      page.getByTestId("polar-chart-surface").boundingBox(),
    ]);
    expect(badgeBox).toBeTruthy();
    expect(surfaceBox).toBeTruthy();
    expect(badgeBox!.x).toBeGreaterThanOrEqual(surfaceBox!.x);
    expect(badgeBox!.y).toBeGreaterThanOrEqual(surfaceBox!.y);
    expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(
      surfaceBox!.x + surfaceBox!.width + 0.5,
    );
    expect(badgeBox!.y + badgeBox!.height).toBeLessThanOrEqual(
      surfaceBox!.y + surfaceBox!.height + 0.5,
    );
  });

  test("maximize fills the viewport, locks background scroll, and Escape restores the card", async ({
    page,
  }) => {
    await openLdChart(page);
    const viewer = page.getByTestId("polar-viewer");
    const before = (await viewer.boundingBox())!;

    await page.getByRole("button", { name: "Maximize chart" }).click();
    await expect(viewer).toHaveAttribute("data-maximized", "true");
    await expect
      .poll(() => viewer.evaluate((node) => getComputedStyle(node).position))
      .toBe("fixed");
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).overflow))
      .toBe("hidden");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.body.hasAttribute("data-ui-allow-overlap"),
        ),
      )
      .toBe(true);
    const maximized = (await viewer.boundingBox())!;
    expect(maximized.width).toBeGreaterThan(before.width);
    expect(maximized.width).toBeGreaterThanOrEqual(877);
    expect(maximized.height).toBeGreaterThanOrEqual(1_289);

    await page.keyboard.press("Escape");
    await expect(viewer).toHaveAttribute("data-maximized", "false");
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).overflow))
      .not.toBe("hidden");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.body.hasAttribute("data-ui-allow-overlap"),
        ),
      )
      .toBe(false);
  });

  test("the primary Re 102k series is not reduced to the 14°–15° segment by harmless repeat noise", async () => {
    test.skip(
      !(await has2032cPolar()),
      "20-32C Re 102k production evidence is unavailable",
    );
    const api = await pwRequest.newContext({ baseURL: API });
    try {
      const response = await api.get(`/api/airfoils/${SLUG}`);
      expect(response.ok()).toBe(true);
      const detail = (await response.json()) as {
        polars: Array<{
          label: string;
          points: Array<{
            a: number;
            evidenceRole?: "primary" | "alternate" | "conflict";
          }>;
        }>;
      };
      const series = detail.polars.find(
        (polar) => polar.label === "Re 102k · M 0.09 · condition 1",
      );
      expect(series).toBeTruthy();
      const primaryAngles = new Set(
        series!.points
          .filter((point) => point.evidenceRole === "primary")
          .map((point) => point.a),
      );
      expect(primaryAngles.size).toBeGreaterThanOrEqual(20);
      expect(primaryAngles.has(14)).toBe(true);
      expect(primaryAngles.has(15)).toBe(true);
    } finally {
      await api.dispose();
    }
  });
});
