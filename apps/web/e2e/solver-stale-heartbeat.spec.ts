// Must-catch UI spec for the stale-heartbeat regression (DecisionHistory
// 2026-07-05 "First Real Campaign Run"): sweeper_state.enabled=true with a
// dead process must NEVER render as running, and Pause/Resume/enable-sweeper
// controls must not be offered while no process can honor them.
//
// GATED — DO NOT RUN while a live campaign is solving. Although the payload
// staleness is injected with client-side route interception (no server state
// is mutated), the suite is reserved for an idle solver / scratch DB run
// alongside the sweeper/campaign e2e suites, which fail fast by design while
// solving is live. Enable explicitly with:
//   SOLVER_STALE_E2E=1 npx playwright test apps/web/e2e/solver-stale-heartbeat.spec.ts
//
// The unit-level must-catch layer for the same regression always runs:
// apps/web/test/solver-state.test.ts (deriveSolverState gate precedence).

import { expect, test, type Page } from "@playwright/test";

test.skip(!process.env.SOLVER_STALE_E2E, "gated: requires an idle solver / scratch DB (set SOLVER_STALE_E2E=1)");

const STALE_HEARTBEAT_ISO = new Date(Date.now() - 3 * 86_400_000).toISOString();

/** Rewrites the admin queue payload the way the real incident looked:
 *  enabled=true, heartbeat days stale, no active jobs. Read-only for the
 *  server — only the response seen by this page is modified. */
async function interceptQueueWithStaleHeartbeat(page: Page) {
  // `*` suffix: the Solver page now fetches tab-scoped payloads
  // (?scope=activity|background|engine) — match them all.
  await page.route("**/api/admin/queue*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      sweeper: { enabled: boolean; heartbeatAt: string | null };
      activeJobs: unknown[];
    };
    body.sweeper.enabled = true;
    body.sweeper.heartbeatAt = STALE_HEARTBEAT_ISO;
    body.activeJobs = [];
    await route.fulfill({ response, json: body });
  });
}

async function interceptCampaignsWithStaleHeartbeat(page: Page) {
  await page.route("**/api/admin/campaigns?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      solverState?: { enabled: boolean; heartbeatAt: string | null; activeJobCount: number };
    };
    if (body.solverState) {
      body.solverState.enabled = true;
      body.solverState.heartbeatAt = STALE_HEARTBEAT_ISO;
      body.solverState.activeJobCount = 0;
    }
    await route.fulfill({ response, json: body });
  });
}

test.describe("stale heartbeat renders PROCESS NOT RUNNING, never running", () => {
  test("Solver Activity banner: red process-not-running state, no Resume, guidance instead", async ({ page }) => {
    await interceptQueueWithStaleHeartbeat(page);
    await page.goto("/admin?section=queue");
    await expect(page.getByTestId("openfoam-queue-page")).toBeVisible();

    // The banner derives from deriveSolverState — enabled=true must lose to
    // the dead heartbeat (gate precedence).
    await expect(page.getByTestId("sweeper-process-state")).toHaveText("PROCESS NOT RUNNING");
    await expect(page.getByTestId("solver-banner")).toContainText(/last heartbeat \d+d ago/);
    await expect(page.getByTestId("solver-banner")).toContainText("Pause/Resume has no effect until it is started");

    // Pause/Resume are fake controls in this state and must not render; a
    // Start button must never exist (the web app cannot start OS processes).
    await expect(page.getByRole("button", { name: /^(Pause|Resume)$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Start\b/ })).toHaveCount(0);
    await expect(page.getByTestId("solver-controls-guidance")).toBeVisible();

    // Empty active-jobs state states the real reason, not "resume the sweeper".
    await expect(page.getByTestId("queue-active-jobs")).toContainText("solver process is not running");
  });

  test("hub chip + active campaign rows reflect the dead process", async ({ page }) => {
    await interceptCampaignsWithStaleHeartbeat(page);
    await page.goto("/admin");
    await expect(page.getByTestId("campaigns-hub")).toBeVisible();

    await expect(page.getByTestId("hub-solver-chip")).toHaveText("solver · process not running");

    // Every ACTIVE campaign row must carry the scheduler-dependent suffix —
    // never a bare "Active — N points remaining" while nothing can run.
    const activeRows = page.locator('[data-testid^="campaign-status-line-"]', { hasText: /^Active/ });
    const count = await activeRows.count();
    for (let i = 0; i < count; i++) {
      await expect(activeRows.nth(i)).toContainText("solver process is not running");
    }
  });
});
