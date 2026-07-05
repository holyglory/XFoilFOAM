// Finished-job-log URL-owned open state (?flog=1) — guardrail for the
// production-reported state-loss defect: the log is a native <details>, so
// navigating to an airfoil detail page and pressing back used to remount the
// Solver page with the section collapsed (scroll restoration could not land
// inside it). URL search params are the admin console's single source of
// truth (spec §11), so the expander state must survive reload/back.
//
// READ-ONLY suite: it only expands/collapses a client-side expander and
// checks the URL — no server state is touched, safe while a campaign solves.

import { expect, test } from "@playwright/test";

test.describe("Solver finished-job log state lives in the URL", () => {
  test("expand → ?flog=1 → reload stays expanded → collapse removes the param", async ({ page }) => {
    await page.goto("/admin?section=queue");
    const log = page.getByTestId("queue-finished-jobs");
    await expect(log).toBeVisible();
    await expect(log).not.toHaveAttribute("open", "");

    await log.locator("summary").click();
    await expect(log).toHaveAttribute("open", "");
    await expect(page).toHaveURL(/[?&]flog=1/);
    // section param is preserved — flog composes with existing routing state.
    await expect(page).toHaveURL(/[?&]section=queue/);

    await page.reload();
    const reloaded = page.getByTestId("queue-finished-jobs");
    await expect(reloaded).toBeVisible();
    await expect(reloaded).toHaveAttribute("open", "");

    await reloaded.locator("summary").click();
    await expect(reloaded).not.toHaveAttribute("open", "");
    await expect(page).not.toHaveURL(/[?&]flog=/);
  });
});
