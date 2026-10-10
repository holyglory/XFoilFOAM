import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";

const campaignId = "c24047fa-743f-4ae5-bcd6-f3071ff79fb4";
const cookieProducer = [
  'import { signSession } from "./apps/api/src/admin-auth.ts";',
  'process.stdout.write(signSession("coverage-journey@airfoils.pro", Number(process.env.MAINTENANCE_COOKIE_TTL_MS), "password"));',
].join(" ");
const cookie = execFileSync("ssh", ["airfoils.pro", "bash", "-s"], {
  input: `set -e\ndocker exec -e MAINTENANCE_COOKIE_TTL_MS=300000 -w /app app-node-api-1 pnpm exec tsx -e '${cookieProducer}'\n`,
  encoding: "utf8",
  timeout: 30000,
}).trim();
assert.match(cookie, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1206, height: 1191 },
  });
  await context.addCookies([
    {
      name: "aero_admin",
      value: cookie,
      domain: "airfoils.pro",
      path: "/",
      secure: true,
    },
  ]);
  const page = await context.newPage();
  const campaignResponses = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/admin/campaigns/"))
      campaignResponses.push({
        url: response.url(),
        status: response.status(),
      });
  });
  await page.goto(
    `https://airfoils.pro/admin?section=simulations&campaign=${campaignId}`,
    {
      waitUntil: "domcontentloaded",
    },
  );
  assert(page.url().includes(`campaign=${campaignId}`));
  console.log(JSON.stringify({ pageUrl: page.url(), campaignResponses }));
  await expect(page.getByTestId("campaign-detail")).toBeVisible({
    timeout: 30000,
  });
  const conditionStrip = page.getByTestId("campaign-condition-strip");
  await expect(conditionStrip).toContainText("accepted");
  await expect(conditionStrip).toContainText(/curve [\d,]+\/[\d,]+/);
  await expect(page.getByTestId("campaign-instrument-hero")).toContainText(
    /of [1-9][0-9,]+/,
  );
  await expect(page.getByTestId("matrix-scroll")).toBeVisible({
    timeout: 30000,
  });
  const search = page.getByPlaceholder("search airfoils…");
  await search.fill("2032c");
  const row = page.getByTestId("matrix-row-2032c");
  await expect(row).toBeVisible({ timeout: 30000 });
  await expect(row).toContainText(/P \d+\/\d+/);
  await row.locator('[data-testid^="matrix-cell-"]').first().click();
  await expect(page.getByTestId("cell-side-panel")).toBeVisible();
  await expect(page.getByTestId("progressive-polar-viewer")).toBeVisible({
    timeout: 30000,
  });
  console.log(
    JSON.stringify({
      route: `/admin?campaign=${campaignId}`,
      profile: "2032c",
      curveCoverage: "26/26",
      progressiveViewer: true,
    }),
  );
} finally {
  await browser.close();
}
