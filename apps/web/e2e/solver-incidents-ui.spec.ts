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
        solverIncidentEvents: [
          {
            id: "incident-current",
            stage: "preliminary",
            reason: "continuation-no-progress",
            severity: "critical",
            status: "open",
            operationalState: "system_attention",
            userActionRequired: false,
            solverImplementationId: "solver-2606",
            solverImplementationKey: "openfoam-2606",
            remediationVersion: "urans-recovery-2026-07-16-v1",
            occurrenceKey: "preliminary:current",
            owner: {
              type: "precalc_obligation",
              id: "obligation-current",
            },
            simJobId: "job-current",
            resultAttemptId: "attempt-current",
            campaignIds: ["campaign-current"],
            metadata: {
              lastOutcome: "rejected_exhausted",
              diagnostic: "current-debug",
            },
            occurredAt: "2026-07-16T02:00:00.000Z",
            resolvedAt: null,
            patternOccurrenceCount: 3,
            patternOpenCount: 1,
          },
          {
            id: "incident-history",
            stage: "final",
            reason: "media-repair-exhausted",
            severity: "critical",
            status: "resolved",
            operationalState: "resolved",
            userActionRequired: false,
            solverImplementationId: "solver-2606",
            solverImplementationKey: "openfoam-2606",
            remediationVersion: "urans-recovery-2026-07-16-v1",
            occurrenceKey: "final:history",
            owner: { type: "verify_queue", id: "verify-history" },
            simJobId: "job-history",
            resultAttemptId: "attempt-history",
            campaignIds: ["campaign-current"],
            metadata: { diagnostic: "history-debug" },
            occurredAt: "2026-07-15T04:00:00.000Z",
            resolvedAt: "2026-07-15T05:00:00.000Z",
            patternOccurrenceCount: 4,
            patternOpenCount: 0,
          },
        ],
      },
    });
  });

  await page.goto("/admin?section=health");
  await expect(page.getByTestId("admin-health-page")).toBeVisible();

  const panel = page.getByTestId("solver-incidents-health");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAccessibleName(
    /Solver quality log, 1 unresolved solver event, 1 pattern awaiting solver follow-up, 7 recorded outcomes, no user action/i,
  );
  await expect(panel).toContainText("Solver quality log");
  await expect(panel).toContainText("1 solver follow-up");
  await expect(panel).not.toContainText("System investigation required");

  const current = panel.getByTestId("solver-incident-event-0");
  await expect(current).not.toBeVisible();
  await panel.locator(":scope > summary").click();
  await expect(current).toBeVisible();
  await expect(current).toHaveAttribute("data-stage", "preliminary");
  await expect(current).toHaveAttribute(
    "data-operational-state",
    "system_attention",
  );
  await expect(current).toContainText("FAST URANS");
  await expect(current).toContainText("continuation made no progress");
  await expect(current).toContainText("solver follow-up");
  await expect(current).not.toContainText("current-debug");
  await current.locator(":scope > summary").click();
  await expect(current).toContainText("current-debug");
  await expect(current).toContainText("solver system · no user action");

  const history = panel.getByTestId("solver-incident-event-1");
  await expect(history).toHaveAttribute("data-status", "resolved");
  await expect(history).toContainText("FINAL URANS");
  await expect(history).toContainText("resolved");

  await expect(panel.getByText("agent JSON ↗")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  expect(
    await panel.evaluate((element) => element.scrollWidth),
  ).toBeLessThanOrEqual(await panel.evaluate((element) => element.clientWidth));
});
