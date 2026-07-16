import { expect, test } from "@playwright/test";

const SAMPLE_AT = "2026-07-16T12:00:00.000Z";

test("Health prioritizes open solver incidents and keeps resolved recurrence as history", async ({
  page,
}) => {
  const sample = {
    at: SAMPLE_AT,
    cpu: {
      load1: 3.1,
      load5: 3,
      load15: 2.8,
      availableCpus: 8,
      loadPct: 38.75,
    },
    memory: {
      totalBytes: 32 * 1024 ** 3,
      freeBytes: 12 * 1024 ** 3,
      usedBytes: 20 * 1024 ** 3,
      usedPct: 62.5,
    },
    storage: {
      path: "/",
      totalBytes: 500 * 1024 ** 3,
      freeBytes: 110 * 1024 ** 3,
      usedBytes: 390 * 1024 ** 3,
      usedPct: 78,
    },
    storageError: null,
  };
  await page.route("**/api/admin/health", async (route) => {
    await route.fulfill({
      json: {
        asOf: SAMPLE_AT,
        sampleIntervalSeconds: 60,
        windowHours: 24,
        current: sample,
        averages24h: {
          sampleCount: 120,
          coverageSeconds: 7_200,
          firstSampleAt: "2026-07-16T10:00:00.000Z",
          cpuLoad1: 2.9,
          cpuLoadPct: 36.25,
          memoryUsedPct: 61.2,
        },
        history: [sample],
        solverIncidents: {
          threshold: 3,
          occurrenceCount: 7,
          openCount: 1,
          criticalGroupCount: 2,
          // Resolved history deliberately arrives first. The UI must still
          // make the current incident the first operational row.
          groups: [
            {
              stage: "final",
              reason: "media-repair-exhausted",
              solverImplementationId: "solver-2606",
              solverImplementationKey: "openfoam-2606",
              remediationVersion: "urans-recovery-2026-07-16-v1",
              occurrenceCount: 4,
              openCount: 0,
              openCriticalCount: 0,
              firstOccurredAt: "2026-07-15T00:00:00.000Z",
              lastOccurredAt: "2026-07-15T04:00:00.000Z",
              requiresInvestigation: true,
              effectiveSeverity: "critical",
            },
            {
              stage: "preliminary",
              reason: "continuation-no-progress",
              solverImplementationId: "solver-2606",
              solverImplementationKey: "openfoam-2606",
              remediationVersion: "urans-recovery-2026-07-16-v1",
              occurrenceCount: 3,
              openCount: 1,
              openCriticalCount: 1,
              firstOccurredAt: "2026-07-16T00:00:00.000Z",
              lastOccurredAt: "2026-07-16T02:00:00.000Z",
              requiresInvestigation: true,
              effectiveSeverity: "critical",
            },
          ],
        },
      },
    });
  });

  await page.goto("/admin?section=health");
  await expect(page.getByTestId("admin-health-page")).toBeVisible();

  const panel = page.getByTestId("solver-incidents-health");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAccessibleName(
    /Solver reliability, 1 active recovery event, 1 critical system-owned pattern, 7 occurrences/i,
  );
  await expect(panel).toContainText("System investigation required");
  await expect(panel).toContainText("3+ same cause → critical");

  const current = panel.getByTestId("solver-incident-group-0");
  await expect(current).toHaveAttribute("data-stage", "preliminary");
  await expect(current).toHaveAttribute("data-status", "critical");
  await expect(current).toContainText("FAST URANS");
  await expect(current).toContainText("continuation made no progress");
  await expect(current).toContainText("CRITICAL");
  await expect(current).toContainText("SYSTEM OWNED");

  const history = panel.getByTestId("solver-incident-group-1");
  await expect(history).toHaveAttribute("data-stage", "final");
  await expect(history).toHaveAttribute("data-status", "resolved");
  await expect(history).toContainText("FINAL URANS");
  await expect(history).toContainText("RESOLVED");
  await expect(history).toContainText("HISTORY");
  await expect(panel).not.toContainText("urans-recovery-2026-07-16-v1");
  await expect(panel).not.toContainText("openfoam-2606");
  await expect(panel).not.toContainText("INVESTIGATE");
  await expect(panel).not.toContainText("solver evidence rejected");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  expect(
    await panel.evaluate((element) => element.scrollWidth),
  ).toBeLessThanOrEqual(await panel.evaluate((element) => element.clientWidth));
});
