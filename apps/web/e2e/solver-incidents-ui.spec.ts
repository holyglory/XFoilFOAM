import { expect, test } from "@playwright/test";

const SAMPLE_AT = "2026-07-16T12:00:00.000Z";

test("Health ignores internal recovery history and leads with real fleet status", async ({
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
        fleet: {
          local: {
            id: "local",
            instanceName: "Production",
            connectivity: "online",
            status: "running",
            lastHeartbeatAt: SAMPLE_AT,
            activeJobs: 1,
            reservedCpuSlots: 8,
            capacityCpuSlots: 8,
            health: {
              schemaVersion: 1,
              sampledAt: SAMPLE_AT,
              cpu: sample.cpu,
              memory: sample.memory,
              storage: {
                usedPct: sample.storage.usedPct,
                freeBytes: sample.storage.freeBytes,
                requiredFreeBytes: 80 * 1024 ** 3,
                admissionBlocked: false,
                reason: null,
                checkedAt: SAMPLE_AT,
              },
              execution: {
                activeJobs: 1,
                reservedCpuSlots: 8,
                capacityCpuSlots: 8,
                activeAoaCount: 8,
              },
            },
          },
          remotes: [],
        },
        performance: {
          windowDays: 7,
          daily: [],
          totals24h: {
            day: "2026-07-16",
            rans: 0,
            preliminary: 0,
            final: 0,
            total: 0,
          },
          sources: [],
        },
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
  await expect(page.getByTestId("health-compute-fleet")).toBeVisible();
  await expect(page.getByTestId("solver-incidents-health")).toHaveCount(0);
  await expect(page.getByText("Solver recovery", { exact: false })).toHaveCount(
    0,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("health-compute-fleet")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});
