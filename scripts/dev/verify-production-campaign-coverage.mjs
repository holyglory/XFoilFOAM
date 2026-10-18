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
  const listRequestStartedAt = new WeakMap();
  const listResponsePromises = [];
  const campaignListResponses = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      ["/api/admin/bootstrap", "/api/admin/campaigns"].includes(url.pathname)
    ) {
      listRequestStartedAt.set(request, Date.now());
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      response.request().method() === "GET" &&
      ["/api/admin/bootstrap", "/api/admin/campaigns"].includes(url.pathname)
    ) {
      const requestStartedAt = listRequestStartedAt.get(response.request()) ?? null;
      const responseReceivedAt = Date.now();
      listResponsePromises.push(
        (async () => {
          try {
            const body = await response.json();
            const listing = body.campaigns ?? body;
            const item = listing.items?.find((entry) => entry.id === campaignId);
            campaignListResponses.push({
              url: response.url(),
              status: response.status(),
              requestStartedAt,
              responseReceivedAt,
              item: item
                ? {
                    id: item.id,
                    updatedAt: item.updatedAt,
                    activityAt: item.activityAt ?? null,
                  }
                : null,
            });
          } catch (error) {
            campaignListResponses.push({
              url: response.url(),
              status: response.status(),
              requestStartedAt,
              responseReceivedAt,
              bodyError: String(error),
            });
          }
        })(),
      );
    }
  });
  const listRouteStartedAt = Date.now();
  await page.goto(
    "https://airfoils.pro/admin",
    {
      waitUntil: "domcontentloaded",
    },
  );
  assert(!new URL(page.url()).searchParams.has("campaign"));
  await expect(page.getByTestId("campaigns-hub")).toBeVisible({
    timeout: 30000,
  });
  const targetRow = page
    .locator('[data-testid^="campaign-row-"]')
    .filter({ hasText: "All seeded airfoils — standard air sweep (2026-07-12)" });
  const cardWaitStartedAt = Date.now();
  await expect(targetRow).toHaveCount(1, { timeout: 30000 });
  await Promise.all(listResponsePromises);
  const cardRenderedAt = Date.now();
  const renderedTargetCardText = await targetRow.innerText();
  const listResponse = campaignListResponses.find(
    (entry) => entry.status === 200 && entry.item?.id === campaignId,
  );
  console.log(
    JSON.stringify({
      route: "/admin",
      api: listResponse ?? null,
      renderedTargetCardText,
      loadingDurationMs: {
        routeToCard: cardRenderedAt - listRouteStartedAt,
        cardWait: cardRenderedAt - cardWaitStartedAt,
        requestToCard:
          listResponse?.requestStartedAt == null
            ? null
            : cardRenderedAt - listResponse.requestStartedAt,
        requestToResponse:
          listResponse?.requestStartedAt == null
            ? null
            : listResponse.responseReceivedAt - listResponse.requestStartedAt,
        responseToCard:
          listResponse == null
            ? null
            : cardRenderedAt - listResponse.responseReceivedAt,
      },
    }),
  );
  assert(
    cardRenderedAt - cardWaitStartedAt < 1000,
    `Campaign card took ${cardRenderedAt - cardWaitStartedAt} ms after the campaigns surface became visible`,
  );
  assert(
    listResponse?.requestStartedAt != null &&
      listResponse.responseReceivedAt - listResponse.requestStartedAt < 1000,
    "Campaign list API exceeded the 1 second response budget",
  );
  assert(listResponse, "Authenticated campaign list response was not captured");
  assert.equal(listResponse.item?.id, campaignId);
  assert(listResponse.item?.updatedAt, "Campaign list response omitted updatedAt");
  assert(listResponse.item?.activityAt, "Campaign list response omitted activityAt");
  assert.match(
    renderedTargetCardText,
    /last solver activity/,
    "Target card did not render the activity timestamp",
  );

  const targetRowTestId = await targetRow.getAttribute("data-testid");
  assert.match(targetRowTestId ?? "", /^campaign-row-/);
  const targetSlug = targetRowTestId.slice("campaign-row-".length);
  await targetRow.getByTestId(`campaign-open-${targetSlug}`).click();
  await expect(page.getByTestId("campaign-detail")).toBeVisible({
    timeout: 30000,
  });
  assert(page.url().includes(`campaign=${campaignId}`));
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
