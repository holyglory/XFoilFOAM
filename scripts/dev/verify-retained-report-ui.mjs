import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = progressivePreviewOrigin();
const output = fileURLToPath(
  new URL("../../.codex-artifacts/retained-report-ui/", import.meta.url),
);
await mkdir(output, { recursive: true });
const reportBody = '{"fixture":"retained-unpublished-report","sequence":7}';
const signature = createHash("sha256").update(reportBody).digest("hex");
const executionId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const entry = {
  executionId,
  sequence: 7,
  signature,
  receivedAt: "2026-09-10T12:00:00.000000Z",
  airfoilSlug: "fixture-ag24",
  airfoilName: "AG24 test report",
  campaignId,
  campaignName: "Reference campaign",
  reynolds: 2345678.9,
  mach: 0.729,
  angles: [-2, 0, 4],
  sourceCount: 3,
  receivedSourceCount: 1,
  jobStatus: "cancelled",
  recovery: { queuedAngles: 2, claimedAngles: 1 },
};
const verifierPath =
  process.env.FORMAL_WEB_UI_VERIFIER ??
  "/home/holyglory/.codex/skills/formal-web-ui-verification/scripts/formal_web_ui_verify.mjs";
const { pageVerifier } = await import(pathToFileURL(verifierPath).href);
const browser = await chromium.launch({ headless: true });
const realApi = await browser.newContext();
const realResponse = await realApi.request.get(
  `${origin}/api/admin/retained-reports?limit=1`,
);
assert(
  realResponse.ok(),
  "The actual protected report read model must be reachable from the authorized preview",
);
const realPage = await realResponse.json();
assert(Array.isArray(realPage.items) && realPage.items.length <= 1);
assert(realPage.nextCursor === null || typeof realPage.nextCursor === "string");
await realApi.close();
const outcomes = [];
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 1000 },
  ]) {
    for (const theme of ["dark", "light"]) {
      const page = await browser.newPage({ viewport, acceptDownloads: true });
      const requests = [];
      let downloadMode = "ok";
      let listStatus = 200;
      let finishSlow = null;
      let finishDownload = null;
      await page.route("**/api/admin/retained-reports**", async (route) => {
        const url = new URL(route.request().url());
        requests.push({
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
        });
        if (url.pathname === "/api/admin/retained-reports") {
          if (url.searchParams.get("airfoil") === "slow")
            await new Promise((resolve) => {
              finishSlow = resolve;
            });
          const airfoil = url.searchParams.get("airfoil");
          const body =
            listStatus !== 200
              ? { error: "Fixture report service unavailable" }
              : {
                  items:
                    airfoil === "empty"
                      ? []
                      : [
                          {
                            ...entry,
                            ...(url.searchParams.has("cursor")
                              ? {
                                  sequence: 8,
                                  airfoilName: "Second page report",
                                }
                              : {}),
                          },
                        ],
                  nextCursor:
                    airfoil === "empty" || url.searchParams.has("cursor")
                      ? null
                      : "fixture-next-cursor",
                };
          await route
            .fulfill({
              status: listStatus,
              contentType: "application/json",
              body: JSON.stringify(body),
            })
            .catch(() => {});
          return;
        }
        assert.equal(
          url.pathname,
          `/api/admin/retained-reports/${executionId}/7`,
        );
        assert.equal(url.searchParams.get("signature"), signature);
        if (downloadMode === "slow")
          await new Promise((resolve) => {
            finishDownload = resolve;
          });
        await route
          .fulfill(
            downloadMode === "error"
              ? {
                  status: 409,
                  contentType: "application/json",
                  body: '{"error":"Stored solver report failed integrity verification"}',
                }
              : {
                  status: 200,
                  contentType: "application/json",
                  headers: { "x-content-sha256": signature },
                  body: reportBody,
                },
          )
          .catch(() => {});
      });
      try {
        await page.goto(`${origin}/admin?section=queue`, {
          waitUntil: "domcontentloaded",
        });
        const log = page.getByTestId("queue-finished-jobs");
        await expect(log).toBeVisible();
        assert.equal(
          requests.length,
          0,
          "Closed log must not request retained reports",
        );
        if (theme === "light")
          await page
            .getByRole("button", { name: "Switch to light theme" })
            .click();
        await log.locator(":scope > summary").click();
        const panel = page.getByTestId("retained-reports");
        await expect(panel.getByTestId("retained-report-row")).toHaveCount(1);
        await expect(panel).toContainText("2 of 3 sources awaiting transfer");
        await panel
          .getByRole("button", { name: "Next page", exact: true })
          .click();
        await expect(panel).toContainText("Second page report");
        await page.goBack();
        await expect(panel).toContainText("AG24 test report");
        await panel
          .getByRole("button", { name: "Next page", exact: true })
          .click();
        await panel
          .getByRole("button", { name: "First page", exact: true })
          .click();
        await expect(panel).toContainText("AG24 test report");
        await panel
          .getByRole("button", {
            name: "Filter reports for campaign Reference campaign",
          })
          .click();
        await expect(page).toHaveURL(
          new RegExp(`reportCampaign=${campaignId}`),
        );
        await panel
          .getByRole("button", { name: "All campaigns", exact: true })
          .click();
        const search = panel.getByLabel("Search reports by profile");
        await search.fill("AG24");
        await panel
          .getByRole("button", { name: "Search retained reports", exact: true })
          .click();
        await panel.getByLabel("Include fully received reports").check();
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(log).toHaveAttribute("open", "");
        await expect(search).toHaveValue("AG24");
        await expect(
          panel.getByLabel("Include fully received reports"),
        ).toBeChecked();
        await expect(panel.getByTestId("retained-report-row")).toHaveCount(1);
        await panel.locator("summary").click();
        await expect(panel).toContainText(signature);
        await expect(panel).toContainText(
          "Receiving a report does not make its coefficients accepted CFD",
        );
        const downloadButton = panel.getByRole("button", {
          name: "Download AG24 test report report 7",
          exact: true,
        });
        const downloaded = page.waitForEvent("download");
        await downloadButton.click();
        const file = await downloaded;
        assert.equal(
          file.suggestedFilename(),
          "fixture-ag24-solver-report-7.json",
        );
        assert.equal(
          (await readFile(await file.path())).toString(),
          reportBody,
        );
        downloadMode = "error";
        await downloadButton.click();
        await expect(panel.getByRole("alert")).toContainText(
          "integrity verification",
        );
        downloadMode = "slow";
        await downloadButton.click();
        await expect(
          panel.getByRole("button", { name: "Cancel download", exact: true }),
        ).toBeVisible();
        await expect.poll(() => finishDownload !== null).toBe(true);
        await panel
          .getByRole("button", { name: "Cancel download", exact: true })
          .click();
        finishDownload();
        finishDownload = null;
        await expect(downloadButton).toBeEnabled();
        downloadMode = "ok";
        await search.fill("slow");
        await panel
          .getByRole("button", { name: "Search retained reports", exact: true })
          .click();
        await expect.poll(() => finishSlow !== null).toBe(true);
        await search.fill("empty");
        await panel
          .getByRole("button", { name: "Search retained reports", exact: true })
          .click();
        await expect(panel).toContainText("No retained reports match");
        finishSlow();
        finishSlow = null;
        await expect(panel.getByTestId("retained-report-row")).toHaveCount(0);
        listStatus = 401;
        await panel
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
        await expect(panel.getByRole("alert")).toContainText("Sign in again");
        listStatus = 403;
        await panel
          .getByRole("button", { name: "Retry reports", exact: true })
          .click();
        await expect(panel.getByRole("alert")).toContainText("cannot access");
        listStatus = 503;
        await panel
          .getByRole("button", { name: "Retry reports", exact: true })
          .click();
        await expect(panel.getByRole("alert")).toContainText(
          "Fixture report service unavailable",
        );
        listStatus = 200;
        await panel
          .getByRole("button", { name: "Clear report filters", exact: true })
          .click();
        await expect(panel.getByTestId("retained-report-row")).toHaveCount(1);
        await panel.locator("summary").click();
        if (viewport.width === 1440) {
          const control = panel.getByRole("button", {
            name: "Search retained reports",
            exact: true,
          });
          await control.focus();
          for (const width of [541, 540, 539, 540, 541, 1440]) {
            await page.setViewportSize({ width, height: viewport.height });
            await expect(control).toBeFocused();
            const labelVisible = await control.locator("span").isVisible();
            assert.equal(labelVisible, width > 540);
            const bounds = await panel.boundingBox();
            assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
          }
        }
        await panel.scrollIntoViewIfNeeded();
        await page.evaluate(() => {
          window.__FORMAL_WEB_UI_CONFIG__ = {
            rules: { strictTruncation: false },
          };
        });
        const inspection = await page.evaluate(pageVerifier);
        const panelFindings = await panel.evaluate(
          (element, findings) =>
            findings.filter((finding) => {
              try {
                const target = document.querySelector(finding.selector);
                return target && element.contains(target);
              } catch {
                return false;
              }
            }),
          inspection.findings,
        );
        assert.deepEqual(
          panelFindings.filter((finding) => finding.severity === "critical"),
          [],
        );
        const geometry = await panel.boundingBox();
        assert(
          geometry &&
            geometry.x >= 0 &&
            geometry.x + geometry.width <= viewport.width,
        );
        const name = `${theme}-${viewport.width}`;
        await panel.screenshot({ path: join(output, `${name}-panel.png`) });
        await panel
          .getByRole("heading", { name: "Retained reports", exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, `${name}.png`) });
        await writeFile(
          join(output, `${name}.json`),
          JSON.stringify({ viewport, theme, panelFindings, inspection }),
        );
        await log.locator(":scope > summary").click();
        await expect(panel).toHaveCount(0);
        await expect(page).not.toHaveURL(/flog=/);
        outcomes.push({
          viewport,
          theme,
          inspectedReportBytes: reportBody.length,
          serverMutations: 0,
          panelCriticalFindings: 0,
        });
      } finally {
        finishSlow?.();
        finishDownload?.();
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
await writeFile(
  join(output, "report.json"),
  JSON.stringify({
    kind: "retained-report-ui",
    fixtureScope: "browser-only report API responses",
    fullFormalJourneyCertification: false,
    outcomes,
  }),
);
console.log(
  JSON.stringify({
    kind: "retained-report-ui",
    cells: outcomes.length,
    output,
  }),
);
