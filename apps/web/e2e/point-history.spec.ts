// Point History Explorer (Solver ▸ Points tab) — READ-ONLY smoke over the dev
// DB: the fourth Solver tab renders real point rows, the status chips carry
// live counts, a row click opens the in-place story side panel, and Escape
// closes it. No server state is touched (no requeue, no filters persisted
// beyond the URL of this tab), safe while a campaign solves.

import { expect, test } from "@playwright/test";

test.describe("Point History Explorer (read-only)", () => {
  test("Points tab lists rows and the story panel opens/closes in place", async ({ page }) => {
    await page.goto("/admin?section=queue&tab=points");

    // Tab is active and the explorer owns the viewport (no queue sections).
    await expect(page.getByTestId("solver-tab-points")).toHaveAttribute("aria-pressed", "true");
    const panel = page.getByTestId("point-history-panel");
    await expect(panel).toBeVisible();

    // Real rows from the dev DB (results table is non-empty there).
    const rows = page.getByTestId("point-history-row");
    await expect(rows.first()).toBeVisible();

    // Status chips render live counts (the "all" chip always has a number).
    await expect(page.getByTestId("points-chip-all")).toContainText(/all [\d,]+/);

    // Row click opens the story side panel in place — URL keeps the tab.
    await rows.first().click();
    const story = page.getByTestId("point-story-panel");
    await expect(story).toBeVisible();
    await expect(page).toHaveURL(/[?&]tab=points/);
    // The timeline (or the honest derived/source note) renders.
    await expect(story.getByTestId(/timeline-(now|attempt)/).first().or(story.getByTestId("point-open-source"))).toBeVisible();

    // Escape closes the panel back to the table.
    await page.keyboard.press("Escape");
    await expect(story).not.toBeVisible();

    // Status chip click-filter round-trips through the URL (replace semantics).
    await page.getByTestId("points-chip-failed").click();
    await expect(page).toHaveURL(/[?&]pstatus=failed/);
    await page.getByTestId("points-chip-all").click();
    await expect(page).not.toHaveURL(/[?&]pstatus=/);
  });
});
