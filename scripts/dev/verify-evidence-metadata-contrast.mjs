import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const verifierPath =
  process.env.FORMAL_WEB_UI_VERIFIER ??
  "/home/holyglory/.codex/skills/formal-web-ui-verification/scripts/formal_web_ui_verify.mjs";
const { pageVerifier } = await import(pathToFileURL(verifierPath).href);
const verifierSha256 = createHash("sha256")
  .update(await readFile(verifierPath))
  .digest("hex");
const origin = progressivePreviewOrigin();
const output = fileURLToPath(
  new URL(
    "../../.codex-artifacts/evidence-metadata-contrast/",
    import.meta.url,
  ),
);
try {
  await rename(
    output,
    join(
      dirname(output),
      `evidence-metadata-contrast.previous-${randomUUID()}`,
    ),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(output, { recursive: true });
const response = await fetch(`${origin}/api/airfoils/ag24`, {
  signal: AbortSignal.timeout(15000),
});
assert(response.ok);
const detail = await response.json();
let fixture;
for (const series of detail.progressivePolars) {
  for (const contributor of (series.explanation?.contributors ?? []).slice(
    0,
    8,
  )) {
    if (!contributor.resultId || !contributor.attemptId) continue;
    const query = new URLSearchParams({
      resultId: contributor.resultId,
      resultAttemptId: contributor.attemptId,
    });
    const stored = await fetch(`${origin}/api/airfoils/ag24/sim?${query}`, {
      signal: AbortSignal.timeout(15000),
    });
    assert(stored.ok);
    const sim = await stored.json();
    if (sim.media?.velocity_magnitude && sim.observation) {
      fixture = { series, contributor, media: sim.media.velocity_magnitude };
      break;
    }
  }
  if (fixture) break;
}
assert(fixture, "Requires actual stored evidence and velocity media");
const browser = await chromium.launch({ headless: true });
const outcomes = [];
const mediaUrls = new Set(
  [fixture.media.imageUrl, fixture.media.meanUrl, fixture.media.url]
    .filter(Boolean)
    .map((value) => new URL(value, origin).href),
);
assert(mediaUrls.size > 0);
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 1000 },
  ]) {
    for (const theme of ["dark", "light"]) {
      const page = await browser.newPage({ viewport });
      const name = `${theme}-${viewport.width}`;
      const failures = [];
      const mediaStates = [];
      const pageErrors = [];
      const verify = (assertion) => {
        try {
          assertion();
        } catch (error) {
          failures.push(error.message);
        }
      };
      page.on("pageerror", (error) => pageErrors.push(error.message));
      let mediaMode = "pass";
      let releaseMedia;
      const mediaGate = new Promise((resolve) => {
        releaseMedia = resolve;
      });
      try {
        await page.clock.install();
        await page.route(
          (url) => mediaUrls.has(url.href),
          async (route) => {
            if (mediaMode === "hold") await mediaGate;
            if (mediaMode === "fail") await route.abort("failed");
            else await route.continue();
          },
        );
        let injectScale = false;
        let interceptions = 0;
        await page.route("**/api/airfoils/ag24/sim?*", async (route) => {
          const url = new URL(route.request().url());
          if (
            url.searchParams.get("resultId") !== fixture.contributor.resultId ||
            url.searchParams.get("resultAttemptId") !==
              fixture.contributor.attemptId
          ) {
            await route.continue();
            return;
          }
          const actual = await route.fetch();
          assert(actual.ok());
          const sim = await actual.json();
          if (injectScale) {
            sim.media.velocity_magnitude.scale = {
              mode: "track",
              vmin: -2,
              vmax: 35,
              policy: "isolated-browser-contrast-fixture",
              version: 1,
              status: "active",
            };
            interceptions += 1;
          }
          await route.fulfill({ response: actual, json: sim });
        });
        await page.goto(`${origin}/airfoils/ag24`, {
          waitUntil: "domcontentloaded",
        });
        const viewer = page.getByTestId("progressive-polar-viewer");
        await expect(viewer).toHaveAttribute("aria-busy", "false");
        if (theme === "light")
          await page
            .getByRole("button", { name: "Switch to light theme" })
            .click();
        await viewer
          .getByLabel("Polar condition")
          .selectOption(fixture.series.targetId);
        await viewer
          .locator("summary")
          .filter({ hasText: "Why this curve" })
          .click();
        const trigger = viewer
          .locator(
            `button[data-result-id="${fixture.contributor.resultId}"][data-result-attempt-id="${fixture.contributor.attemptId}"]`,
          )
          .first();
        const dialog = page.getByTestId("sim-modal-dialog");
        await trigger.focus();
        await trigger.click();
        await expect(dialog).toBeVisible();
        await expect(dialog.getByTestId("sim-coefficient-caption")).toHaveCount(
          3,
        );
        await expect(dialog.getByTestId("sim-active-scale")).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
        injectScale = true;
        mediaMode = "hold";
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(viewer).toHaveAttribute("aria-busy", "false");
        await viewer
          .getByLabel("Polar condition")
          .selectOption(fixture.series.targetId);
        await viewer
          .locator("summary")
          .filter({ hasText: "Why this curve" })
          .click();
        await trigger.click();
        await dialog
          .getByRole("button", { name: "velocity |U|", exact: true })
          .click();
        assert.equal(interceptions, 1);
        await expect(dialog.getByTestId("sim-active-scale")).toBeVisible();
        await expect(dialog.getByTestId("sim-active-scale")).toContainText(
          "-2",
        );
        await page.evaluate(
          ({ theme }) => {
            window.__FORMAL_WEB_UI_CONFIG__ = {
              rules: { strictTruncation: false },
              theme,
              journeys: [
                {
                  id: "inspect-evidence",
                  frequencyPercent: 100,
                  risk: "normal",
                },
              ],
              primaryJourney: "inspect-evidence",
              regions: [
                {
                  selector: "[data-testid='sim-modal-dialog']",
                  role: "primary-content",
                  journey: "inspect-evidence",
                },
              ],
            };
          },
          { theme },
        );
        const inspectMediaState = async (state, testId) => {
          const placeholder = dialog.getByTestId(testId);
          await expect(placeholder).toBeVisible();
          await placeholder.evaluate((element) => {
            element.id = "media-status-probe";
          });
          const result = await page.evaluate(pageVerifier);
          const critical = result.findings.filter(
            (finding) => finding.severity === "critical",
          );
          verify(() => assert.deepEqual(critical, []));
          await page.screenshot({
            path: join(output, `${name}-${state}.png`),
            fullPage: true,
          });
          await writeFile(
            join(output, `${name}-${state}.json`),
            JSON.stringify({ theme, viewport, state, inspection: result }),
          );
          mediaStates.push({
            state,
            critical,
            screenshot: `${name}-${state}.png`,
          });
          if (theme === "light" && state === "loading") {
            const original = await placeholder.evaluate((element) => {
              const color = element.style.color;
              element.style.color = "var(--aero-muted)";
              return color;
            });
            const regression = await page.evaluate(pageVerifier);
            verify(() =>
              assert.equal(
                regression.findings.filter(
                  (finding) =>
                    finding.rule === "insufficient-text-contrast" &&
                    finding.selector === "#media-status-probe",
                ).length,
                1,
              ),
            );
            await placeholder.evaluate((element, color) => {
              element.style.color = color;
            }, original);
          }
        };
        await inspectMediaState("loading", "sim-media-loading");
        mediaMode = "fail";
        releaseMedia();
        await inspectMediaState("unavailable", "sim-media-unavailable");
        mediaMode = "pass";
        await page.clock.fastForward(30_001);
        await expect(dialog.getByTestId("sim-frame-image")).toBeVisible();
        await expect(dialog.getByTestId("sim-media-unavailable")).toHaveCount(
          0,
        );
        await expect(dialog.getByTestId("sim-media-loading")).toHaveCount(0);
        await dialog
          .locator(
            "[data-testid='sim-active-scale'],[data-testid='sim-coefficient-caption']",
          )
          .evaluateAll((elements) => {
            elements.forEach((element, index) => {
              element.id = `contrast-probe-${index}`;
            });
          });
        const inspection = await page.evaluate(pageVerifier);
        const metadata = await dialog
          .locator(
            "[data-testid='sim-active-scale'],[data-testid='sim-coefficient-caption']",
          )
          .evaluateAll((elements) =>
            elements.map((element) => {
              const style = getComputedStyle(element);
              const bounds = element.getBoundingClientRect();
              return {
                id: element.dataset.testid,
                color: style.color,
                background: style.backgroundColor,
                visible: bounds.width > 0 && bounds.height > 0,
                x: bounds.x,
                right: bounds.right,
                bottom: bounds.bottom,
              };
            }),
          );
        verify(() => assert.equal(metadata.length, 4));
        verify(() =>
          assert(
            metadata.every(
              (item) =>
                item.visible && item.x >= 0 && item.right <= viewport.width,
            ),
          ),
        );
        const targeted = inspection.findings.filter(
          (finding) =>
            ["insufficient-text-contrast", "invisible-text"].includes(
              finding.rule,
            ) && finding.selector.startsWith("#contrast-probe-"),
        );
        verify(() => assert.deepEqual(targeted, []));
        verify(() =>
          assert.deepEqual(
            inspection.findings.filter(
              (finding) => finding.severity === "critical",
            ),
            [],
          ),
        );
        const chip = dialog.getByTestId("sim-active-scale");
        const chipId = await chip.getAttribute("id");
        const originalColor = await chip.evaluate((element) => {
          const original = element.style.color;
          element.style.color = "var(--aero-dim)";
          return original;
        });
        const regression = await page.evaluate(pageVerifier);
        const mustCatch = regression.findings.filter(
          (finding) =>
            finding.rule === "insufficient-text-contrast" &&
            finding.selector === `#${chipId}`,
        );
        verify(() =>
          assert.equal(
            mustCatch.length,
            1,
            "The detector must catch the original scale-chip defect",
          ),
        );
        await chip.evaluate((element, color) => {
          element.style.color = color;
        }, originalColor);
        await page.screenshot({ path: join(output, `${name}-initial.png`) });
        await page.screenshot({
          path: join(output, `${name}-full.png`),
          fullPage: true,
        });
        await writeFile(
          join(output, `${name}.json`),
          JSON.stringify({
            theme,
            viewport,
            inspection,
            metadata,
            originalDefectDetected: mustCatch,
            mediaStates,
            failures,
          }),
        );
        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
        await expect(trigger).toBeFocused();
        verify(() => assert.deepEqual(pageErrors, []));
        outcomes.push({
          status: failures.length ? "failed" : "passed",
          theme,
          viewport,
          fixtureOnlyScale: true,
          actualEvidenceIdentityPreserved: true,
          metadata,
          mediaStates,
          automaticMediaRetry: "passed",
          failures,
          targetedContrastFindings: targeted.length,
          originalDefectDetected: mustCatch.length === 1,
          allFormalFindings: inspection.findings.length,
          screenshots: [`${name}-initial.png`, `${name}-full.png`],
        });
      } catch (error) {
        failures.push(error.message);
        outcomes.push({
          theme,
          viewport,
          status: "failed",
          failures,
          mediaStates,
        });
        await page
          .screenshot({
            path: join(output, `${name}-failure.png`),
            fullPage: true,
          })
          .catch((captureError) =>
            failures.push(`Screenshot: ${captureError.message}`),
          );
      } finally {
        mediaMode = "pass";
        releaseMedia();
        await page.close();
      }
      await writeFile(join(output, "cells.json"), JSON.stringify(outcomes));
    }
  }
} finally {
  await browser.close();
}
const report = {
  kind: "targeted-evidence-metadata-contrast",
  source: "real-detail-and-evidence-with-isolated-scale-response-fixture",
  noDatabaseWrites: true,
  fullFormalJourneyCertification: false,
  verifierSha256,
  outcomes,
};
await writeFile(join(output, "report.json"), JSON.stringify(report));
console.log(
  JSON.stringify({
    kind: report.kind,
    checkedCells: outcomes.length,
    failedCells: outcomes.filter((outcome) => outcome.status !== "passed")
      .length,
    targetedContrastFindings: outcomes.reduce(
      (total, outcome) => total + (outcome.targetedContrastFindings ?? 0),
      0,
    ),
    fixtureOnlyScale: true,
    fullFormalJourneyCertification: false,
    output,
  }),
);
assert.equal(outcomes.length, 4);
assert.equal(
  outcomes.filter((outcome) => outcome.status !== "passed").length,
  0,
  "Every evidence metadata and media-state cell must pass",
);
