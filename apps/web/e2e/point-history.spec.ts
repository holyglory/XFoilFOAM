// Point History Explorer (Solver ▸ Points tab) — READ-ONLY smoke over the dev
// DB: the fourth Solver tab renders real point rows, the status chips carry
// live counts, a row click opens the in-place story side panel, and Escape
// closes it. No server state is touched (no requeue, no filters persisted
// beyond the URL of this tab), safe while a campaign solves.

import { expect, test } from "@playwright/test";

test.describe("Point History Explorer (read-only)", () => {
  test("Points tab lists rows and the story panel owns scroll/focus across nested evidence", async ({
    page,
  }) => {
    await page.goto("/admin?section=queue&tab=points");

    // Tab is active and the explorer owns the viewport (no queue sections).
    await expect(page.getByTestId("solver-tab-points")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const panel = page.getByTestId("point-history-panel");
    await expect(panel).toBeVisible();

    // Real rows from the dev DB (results table is non-empty there).
    const rows = page.getByTestId("point-history-row");
    await expect(rows.first()).toBeVisible();

    // Status chips render live counts (the "all" chip always has a number).
    await expect(page.getByTestId("points-chip-all")).toContainText(
      /all [\d,]+/,
    );

    // Row click opens the story side panel in place — URL keeps the tab.
    const trigger = rows.first();
    await trigger.focus();
    await expect(trigger).toBeFocused();
    const scrollBeforeOpen = await page.evaluate(() => window.scrollY);
    await trigger.click();
    const story = page.getByTestId("point-story-panel");
    await expect(story).toBeVisible();
    await expect(story).toHaveAttribute("role", "dialog");
    await expect(story).toHaveAttribute("aria-modal", "true");
    await expect(
      story.getByRole("button", { name: "Close point story" }),
    ).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.body.style.position))
      .toBe("fixed");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.overflow))
      .toBe("hidden");
    await expect(page).toHaveURL(/[?&]tab=points/);
    // The timeline (or the honest derived/source note) renders.
    await expect(
      story
        .getByTestId(/timeline-(now|attempt)/)
        .first()
        .or(story.getByTestId("point-open-source")),
    ).toBeVisible();

    // The evidence viewer is the top modal: the point story becomes inert,
    // then owns scroll/focus again when the nested dialog closes.
    const resultTrigger = story.getByTestId("point-solver-results");
    await resultTrigger.click();
    await expect(page.getByTestId("sim-modal-dialog")).toBeVisible();
    await expect(story).toHaveAttribute("aria-hidden", "true");
    await expect(story).toHaveAttribute("inert", "");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sim-modal-dialog")).toHaveCount(0);
    await expect(story).not.toHaveAttribute("aria-hidden", "true");
    await expect(story).not.toHaveAttribute("inert", "");
    await expect(resultTrigger).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.body.style.position))
      .toBe("fixed");

    // Escape closes the story back to the table and restores both focus and
    // the exact document-scroll ownership snapshot.
    await page.keyboard.press("Escape");
    await expect(story).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.body.style.position))
      .toBe("");
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBe(scrollBeforeOpen);

    // Status chip click-filter round-trips through the URL (replace semantics).
    await page.getByTestId("points-chip-failed").click();
    await expect(page).toHaveURL(/[?&]pstatus=failed/);
    await page.getByTestId("points-chip-all").click();
    await expect(page).not.toHaveURL(/[?&]pstatus=/);
  });

  test("pointer-null unpublished evidence opens an exact stored run and exposes fresh correction", async ({
    page,
  }) => {
    const resultId = "10000000-0000-4000-8000-000000000001";
    const attemptId = "20000000-0000-4000-8000-000000000002";
    const revisionId = "30000000-0000-4000-8000-000000000003";
    const campaignId = "40000000-0000-4000-8000-000000000004";
    const correctionBodies: Array<Record<string, unknown>> = [];
    await page.route("**/api/admin/point-history*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        url.pathname === `/api/admin/point-history/${resultId}/corrected-run`
      ) {
        correctionBodies.push(
          request.postDataJSON() as Record<string, unknown>,
        );
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            correctionRunId: "50000000-0000-4000-8000-000000000005",
            presetId: "60000000-0000-4000-8000-000000000006",
            revisionId: "70000000-0000-4000-8000-000000000007",
            resultAttemptId: attemptId,
            created: true,
            request: {
              id: "80000000-0000-4000-8000-000000000008",
              state: "pending",
            },
          }),
        });
        return;
      }
      if (url.pathname === `/api/admin/point-history/${resultId}/sim`) {
        expect(url.searchParams.get("resultAttemptId")).toBe(attemptId);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            resultId,
            status: "solved",
            regime: "attached",
            airfoilName: "A18 (original)",
            alpha: -5,
            re: 307041,
            mach: 0.09,
            cl: -0.127,
            cd: 0.031,
            cm: -0.02,
            ld: -4.1,
            media: null,
            availableFields: [],
            history: null,
            fidelity: "urans_precalc",
            steadyHistory: null,
            uransVerify: null,
            condition: null,
          }),
        });
        return;
      }
      if (url.pathname === `/api/admin/point-history/${resultId}/story`) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            point: {
              resultId,
              resultAttemptId: attemptId,
              viewResultAttemptId: attemptId,
              airfoilId: "90000000-0000-4000-8000-000000000009",
              airfoilSlug: "a18",
              airfoilName: "A18 (original)",
              aoaDeg: -5,
              reynolds: 307041,
              mach: 0.09,
              speed: 28,
              regime: "urans",
              status: "failed",
              error: "solver evidence rejected: missing-urans-video",
              qualityWarnings: ["max non-orthogonality 83 deg"],
              classification: {
                state: "rejected",
                reasons: ["not-solved", "missing-coefficients"],
                confidence: 1,
                classifierVersion: "test",
              },
              revisionId,
              campaignId,
              campaignName: "All seeded airfoils",
              conditionId: "a0000000-0000-4000-8000-00000000000a",
              solvedAt: null,
              updatedAt: "2026-08-13T18:00:00.000Z",
              fidelity: "urans_precalc",
              reviewBucket: null,
              workDisposition: "blocked",
              continuable: false,
              hasSelectedGeneration: false,
              continuationResultAttemptId: null,
              correctionSetup: {
                mesh: {
                  mesher: "blockmesh-cgrid",
                  farfieldRadiusChords: 15,
                  wakeLengthChords: 12,
                  nSurface: 130,
                  nRadial: 80,
                  nWake: 60,
                  targetYPlus: 1,
                  spanChords: 0.1,
                },
                solver: {
                  turbulenceModel: "kOmegaSST",
                  nIterations: 3000,
                  convergenceTolerance: 0.00001,
                  momentumScheme: "linearUpwind",
                  transientCycles: 10,
                  transientDiscardFraction: 0.4,
                  transientMaxCourant: 4,
                },
              },
              verify: null,
            },
            attempts: [
              {
                id: attemptId,
                regime: "urans",
                status: "done",
                validForPolar: true,
                converged: true,
                stalled: false,
                unsteady: false,
                firstOrderFallback: false,
                cl: -0.127,
                cd: 0.031,
                clCd: -4.1,
                strouhal: null,
                error: null,
                qualityWarnings: ["max non-orthogonality 83 deg"],
                engineCaseSlug: "c0p05_u90_am5",
                simJob: null,
                classification: {
                  state: "accepted",
                  reasons: [],
                  confidence: 1,
                },
                createdAt: "2026-08-13T17:00:00.000Z",
                solvedAt: "2026-08-13T17:30:00.000Z",
              },
            ],
            interruptions: [],
            corrections: [],
            closure: null,
          }),
        });
        return;
      }
      if (url.pathname === "/api/admin/point-history") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [
              {
                kind: "result",
                rowKey: `r:${resultId}`,
                resultId,
                airfoilId: "90000000-0000-4000-8000-000000000009",
                airfoilSlug: "a18",
                airfoilName: "A18 (original)",
                aoaDeg: -5,
                sourceAoaDeg: null,
                reynolds: 307041,
                regime: "urans",
                status: "failed",
                bucket: "failed",
                classificationState: "rejected",
                errorClass: "physics",
                error: "missing-urans-video",
                attemptCount: 1,
                attemptDigest: [],
                campaignId,
                campaignName: "All seeded airfoils",
                conditionId: "a0000000-0000-4000-8000-00000000000a",
                revisionId,
                lastActivityAt: "2026-08-13T18:00:00.000Z",
                fidelity: "urans_precalc",
                reviewBucket: null,
                workDisposition: "blocked",
                continuable: false,
                verify: null,
              },
            ],
            nextCursor: null,
            counts: {
              unpublished: 1,
              failed: 1,
              rejected: 1,
              awaiting_urans: 0,
              needs_review: 0,
              accepted: 0,
              needs_urans: 0,
              solving: 0,
              all: 1,
            },
            facets: {
              campaigns: [
                {
                  id: campaignId,
                  name: "All seeded airfoils",
                  status: "active",
                },
              ],
              reynolds: [307041],
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/admin?section=queue&tab=points&pstatus=unpublished");
    await page.getByTestId("point-history-row").click();
    const story = page.getByTestId("point-story-panel");
    await expect(
      story.getByTestId("point-continuation-unavailable"),
    ).toContainText("no solver generation is selected");
    await story.getByTestId("point-continuation-requirement").click();
    await expect(
      story.getByTestId("point-continuation-requirement"),
    ).toContainText("not user authentication");
    await expect(
      story.getByTestId("point-fresh-recalculation-guidance"),
    ).toContainText("starts a new OpenFOAM case at time zero");

    const form = story.getByTestId("point-correction-form");
    await expect(form).toBeVisible();
    await expect(form).toContainText("Recalculate from scratch");
    await expect(
      form.getByTestId("point-recalculation-identity"),
    ).toContainText("A18 (original)");
    await expect(
      form.getByTestId("point-recalculation-identity"),
    ).toContainText("Re 307,041");
    await expect(
      story.getByTestId("point-correction-mesh_refinement"),
    ).toContainText("Refine mesh · recommended");
    await expect(form.getByLabel("surface cells")).toHaveValue("195");
    await expect(
      form.getByTestId("point-recalculation-change-count"),
    ).toContainText("5 parameters changed from pinned");
    await expect(form.getByLabel("mesher")).toHaveValue("blockmesh-cgrid");
    await form.getByText("Mesh settings", { exact: true }).click();
    await expect(form.getByLabel("surface cells")).toBeHidden();
    await form.getByText("Mesh settings", { exact: true }).click();
    await expect(form.getByLabel("surface cells")).toBeVisible();

    await form.getByTestId("point-correction-numerical_stability").click();
    await expect(form.getByLabel("max Courant")).toHaveValue("0.5");
    await form.getByTestId("point-correction-longer_sampling").click();
    await expect(form.getByLabel("transient cycles")).toHaveValue("20");
    await form.getByTestId("point-correction-reset").click();
    await expect(form.getByLabel("surface cells")).toHaveValue("130");
    await expect(
      form.getByTestId("point-recalculation-change-count"),
    ).toContainText("using all pinned values");
    await form.getByTestId("point-correction-mesh_refinement").click();
    await form.getByLabel("surface cells").fill("5");
    await expect(
      form.getByTestId("point-recalculation-validation"),
    ).toBeVisible();
    await expect(form.getByTestId("point-correction-submit")).toBeDisabled();
    await form.getByLabel("surface cells").fill("220");
    await expect(
      form.getByTestId("point-recalculation-validation"),
    ).toHaveCount(0);
    await form.getByLabel("URANS tier").selectOption("full");
    await expect(form.getByTestId("point-recalculation-summary")).toContainText(
      "fresh FULL URANS case",
    );

    await story.getByTestId("point-solver-results").click();
    await expect(page.getByTestId("sim-modal-dialog")).toBeVisible();
    await expect(page.getByTestId("sim-modal-dialog")).toContainText(
      "A18 (original)",
    );
    await page.keyboard.press("Escape");

    page.once("dialog", (dialog) => dialog.dismiss());
    await form.getByTestId("point-correction-submit").click();
    expect(correctionBodies).toHaveLength(0);

    page.once("dialog", (dialog) => dialog.accept());
    await form.getByTestId("point-correction-submit").click();
    await expect(story.getByTestId("point-correction-notice")).toContainText(
      "fresh FULL URANS recalculation queued",
    );
    expect(correctionBodies).toHaveLength(1);
    expect(correctionBodies[0]).toMatchObject({
      resultAttemptId: attemptId,
      fidelity: "full",
      mesh: expect.objectContaining({ nSurface: 220 }),
    });
  });
});
