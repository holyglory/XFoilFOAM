// Simulation Campaigns e2e (spec docs/simulation-campaigns-spec.md §11/§13):
// wizard launch end-to-end, edit-conditions dialog mechanics, URL routing
// (hub ↔ campaign ↔ wizard, not-found, dirty guard), and the refinement
// board. Every record carries the pw- stamp and afterAll purges through
// POST /api/admin/test-artifacts/purge (which these tests also verify leaves
// zero campaign residue). The sweeper must be disabled for the whole run —
// nothing here may solve; the spec asserts sweeper state is untouched.
import {
  makePath,
  profilePaths,
  type AirfoilDetailPayload,
} from "@aerodb/core";
import { expect, test, type APIRequestContext } from "@playwright/test";

const apiURL = process.env.PLAYWRIGHT_API_URL ?? "http://127.0.0.1:4000";

const state = {
  stamp: "",
  categorySlug: "",
  symAirfoil: { id: "", slug: "" },
  camAirfoil: { id: "", slug: "" },
  mediumId: "",
  numerics: {
    boundaryProfileId: "",
    meshProfileId: "",
    solverProfileId: "",
    outputProfileId: "",
  },
  sweeperBefore: null as null | {
    enabled: boolean;
    cpuSlots: number;
    maxConcurrentJobs: number;
  },
  wizardCampaignId: "",
  wizardCampaignSlug: "",
};

async function json<T>(
  request: APIRequestContext,
  method: "get" | "post",
  path: string,
  data?: unknown,
): Promise<T> {
  const res = await request[method](`${apiURL}${path}`, { data });
  expect(
    res.ok(),
    `${method.toUpperCase()} ${path} -> ${res.status()} ${await res.text().catch(() => "")}`,
  ).toBeTruthy();
  return (await res.json()) as T;
}

/** Base plan used by API-launched campaigns (objectives off unless overridden). */
function planBody(overrides: Record<string, unknown> = {}) {
  return {
    mediumId: state.mediumId,
    ambients: [[288.15, 101325]],
    speedsMps: [10, 20],
    chordsM: [0.2],
    spanM: 1,
    areaMode: "derived",
    excludedConditions: [],
    baseSweep: { fromDeg: -2, toDeg: 2, stepDeg: 2, listDeg: null },
    objectives: {
      ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 8 },
      clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 6 },
    },
    numerics: state.numerics,
    ...overrides,
  };
}

async function launchCampaign(
  request: APIRequestContext,
  name: string,
  plan: Record<string, unknown>,
) {
  return json<{
    campaign: { id: string; slug: string; status: string };
    totals: { requested: number };
  }>(request, "post", "/api/admin/campaigns", {
    name,
    priority: 5,
    idempotencyKey: `${name}-key`,
    airfoilIds: [state.symAirfoil.id, state.camAirfoil.id],
    plan,
  });
}

async function getSummary(request: APIRequestContext, id: string) {
  return json<{
    campaign: {
      slug: string;
      status: string;
      planRevisionNumber: number;
      plan: { speedsMps: string[] };
    };
    totals: { requested: number; remaining: number };
    conditions: Array<{
      status: string;
      reynolds: number;
      counters: { requested: number };
    }>;
    lanesSummary: Record<string, Record<string, number>>;
  }>(request, "get", `/api/admin/campaigns/${id}`);
}

test.describe
  .serial("simulation campaigns: wizard, plan edits, routing, refinement board", () => {
  test.beforeAll(async ({ request }) => {
    // HARD GUARD: campaigns must not solve during this spec. The suite never
    // touches sweeper state; it only verifies the precondition.
    state.sweeperBefore = await json(request, "get", "/api/sweeper");
    expect(
      state.sweeperBefore?.enabled,
      "sweeper must be disabled before running campaign e2e (nothing may solve)",
    ).toBe(false);

    state.stamp = `pw-cm-${Date.now().toString(36)}`;
    const cat = await json<{ slug: string }>(
      request,
      "post",
      "/api/admin/categories",
      { name: `${state.stamp} cat`, parentId: null },
    );
    state.categorySlug = cat.slug;
    const sym = await json<{ id: string; slug: string }>(
      request,
      "post",
      "/api/airfoils",
      {
        name: `${state.stamp} sym 0012`,
        categorySlug: cat.slug,
        naca: { t: 0.12, m: 0, p: 0 },
      },
    );
    const cam = await json<{ id: string; slug: string }>(
      request,
      "post",
      "/api/airfoils",
      {
        name: `${state.stamp} cam 4415`,
        categorySlug: cat.slug,
        naca: { t: 0.15, m: 0.04, p: 0.4 },
      },
    );
    state.symAirfoil = { id: sym.id, slug: sym.slug };
    state.camAirfoil = { id: cam.id, slug: cam.slug };

    const medium = await json<{ id: string }>(
      request,
      "post",
      "/api/admin/mediums",
      {
        name: `${state.stamp} air`,
        phase: "gas",
        density: 1.225,
        refTemperatureK: 288.15,
        refPressurePa: 101325,
        viscosityModel: "constant",
        constantDynamicViscosity: 1.789e-5,
        speedOfSound: 340.3,
      },
    );
    state.mediumId = medium.id;

    const [boundary, mesh, solver, output] = await Promise.all([
      json<{ id: string }>(request, "post", "/api/admin/boundary-profiles", {
        name: `${state.stamp} boundary`,
      }),
      json<{ id: string }>(request, "post", "/api/admin/mesh-profiles", {
        name: `${state.stamp} mesh`,
      }),
      json<{ id: string }>(request, "post", "/api/admin/solver-profiles", {
        name: `${state.stamp} solver`,
      }),
      json<{ id: string }>(request, "post", "/api/admin/output-profiles", {
        name: `${state.stamp} output`,
      }),
    ]);
    state.numerics = {
      boundaryProfileId: boundary.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      outputProfileId: output.id,
    };
  });

  test.afterAll(async ({ request }) => {
    if (state.stamp?.startsWith("pw-")) {
      await json(request, "post", "/api/admin/test-artifacts/purge", {
        prefix: state.stamp,
      });
      // The purge itself is part of the contract: zero campaign residue.
      const list = await json<{ items: Array<{ name: string }> }>(
        request,
        "get",
        "/api/admin/campaigns?limit=100",
      );
      expect(
        list.items.filter((c) => c.name.startsWith(state.stamp)),
      ).toHaveLength(0);
    }
    // Sweeper state must be exactly as we found it (never touched).
    const after = await json<{
      enabled: boolean;
      cpuSlots: number;
      maxConcurrentJobs: number;
    }>(request, "get", "/api/sweeper");
    expect(after.enabled).toBe(state.sweeperBefore?.enabled);
    expect(after.cpuSlots).toBe(state.sweeperBefore?.cpuSlots);
    expect(after.maxConcurrentJobs).toBe(
      state.sweeperBefore?.maxConcurrentJobs,
    );
  });

  test("wizard launches a polar sweep end-to-end with real derived physics", async ({
    page,
    request,
  }) => {
    await page.goto("/admin");
    await expect(page.getByTestId("campaigns-hub")).toBeVisible();
    await page.getByTestId("new-polar-sweep").click();
    await expect(page.getByTestId("campaign-wizard")).toBeVisible();
    await expect(page).toHaveURL(/wizard=polar_sweep/);

    // ---- step 1: manual scope, both pw- airfoils, resolved count ----
    await page.getByTestId("scope-mode-manual").click();
    await page.getByTestId("campaign-airfoil-search").fill(state.stamp);
    await page
      .getByTestId(`campaign-airfoil-option-${state.symAirfoil.slug}`)
      .click();
    await page
      .getByTestId(`campaign-airfoil-option-${state.camAirfoil.slug}`)
      .click();
    await expect(
      page.getByTestId("campaign-airfoil-selected-count"),
    ).toContainText("2 selected");
    await expect(page.getByTestId("scope-resolved-count")).toContainText(
      "2 airfoils resolved · 1 symmetric",
    );
    await page.getByTestId("wizard-continue").click();

    // ---- step 2: define flow in place ----
    await expect(page.getByTestId("wizard-conditions")).toBeVisible();
    await page
      .getByLabel("Medium", { exact: true })
      .selectOption(state.mediumId);
    // Ambient editor opens by default with the standard (T, P) prefilled —
    // adding it materializes the ambient chip.
    await page.getByTestId("wizard-ambients-add").click();
    await expect(
      page.getByTestId("wizard-ambients-chip-288.15-101325"),
    ).toBeVisible();
    // One speed via the single field, then ONE extra value → 2 speeds.
    await page.getByLabel("Speed", { exact: true }).fill("10");
    await page.getByTestId("wizard-speeds-add-value").click();
    await expect(page.getByTestId("wizard-speeds-chip-10.000")).toBeVisible();
    await page.getByTestId("wizard-speeds-add-input").fill("20");
    await page.getByTestId("wizard-speeds-add-confirm").click();
    await expect(page.getByTestId("wizard-speeds-chip-20.000")).toBeVisible();
    await page.getByLabel("Chord", { exact: true }).fill("0.2");

    // Condition preview: 2 real conditions with derived Re (V·c/ν) and Mach.
    await expect(
      page.getByText("CONDITION PREVIEW · 2 conditions"),
    ).toBeVisible();
    await expect(page.getByTestId("condition-line-0")).toContainText("Re 137k");
    await expect(page.getByTestId("condition-line-0")).toContainText("M 0.029");
    await expect(page.getByTestId("condition-line-1")).toContainText("Re 274k");
    await expect(page.getByTestId("condition-preview-footer")).toContainText(
      "Re 137k – 274k",
    );
    await page.getByTestId("wizard-continue").click();

    // ---- step 3: small base sweep, BOTH objectives off ----
    await expect(page.getByTestId("wizard-angle-plan")).toBeVisible();
    await page.getByLabel("AoA from °", { exact: true }).fill("-2");
    await page.getByLabel("AoA to °", { exact: true }).fill("2");
    await page.getByLabel("AoA step °", { exact: true }).fill("2");
    await expect(page.getByTestId("sweep-angle-count")).toContainText(
      "3 angles",
    );
    await expect(page.getByTestId("objective-toggle-ldMax")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.getByTestId("objective-toggle-clZero")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await page.getByTestId("wizard-continue").click();

    // ---- step 4: review shows exact totals; symmetric solver-run savings ----
    await expect(page.getByTestId("wizard-review")).toBeVisible();
    await page
      .getByLabel("Campaign name", { exact: true })
      .fill(`${state.stamp} wizard sweep`);

    // Boundary slot: define a NEW pw- profile inline through the quick-create
    // modal (spec §11 — the wizard never dead-ends on the numerics library).
    const qcBoundaryName = `${state.stamp} qc boundary`;
    await page.getByTestId("numerics-chip-boundaryProfileId").click();
    await page.getByTestId("numerics-new-boundaryProfileId").click();
    const numericsModal = page.getByTestId("wizard-numerics-modal");
    await expect(numericsModal).toBeVisible();
    await numericsModal
      .getByLabel("Name", { exact: true })
      .fill(qcBoundaryName);
    await numericsModal
      .getByLabel("Turbulence intensity", { exact: true })
      .fill("0.002");
    await page.getByTestId("wizard-numerics-modal-save").click();
    await expect(numericsModal).toHaveCount(0);
    // Created row is selected in place: chip resolved, select shows it.
    await expect(
      page.getByTestId("numerics-chip-boundaryProfileId"),
    ).toContainText(qcBoundaryName);
    await expect(
      page.getByTestId("numerics-chip-boundaryProfileId"),
    ).not.toContainText("unresolved");
    await expect(
      page
        .getByLabel("Boundary profile", { exact: true })
        .locator("option:checked"),
    ).toHaveText(qcBoundaryName);

    const numericsSlots = [
      ["meshProfileId", "Mesh profile", state.numerics.meshProfileId],
      ["solverProfileId", "Solver profile", state.numerics.solverProfileId],
      ["outputProfileId", "Output profile", state.numerics.outputProfileId],
    ] as const;
    for (const [slot, label, id] of numericsSlots) {
      await page.getByTestId(`numerics-chip-${slot}`).click();
      await page.getByLabel(label, { exact: true }).selectOption(id);
      await expect(page.getByTestId(`numerics-chip-${slot}`)).toContainText(
        state.stamp,
      );
    }
    const summaryTable = page.getByTestId("review-summary-table");
    // 2 airfoils × 2 conditions × 3 angles = 12 points; symmetric airfoil
    // solves α ≥ 0 only → 10 solver runs, 2 points derived by symmetry.
    await expect(
      summaryTable.locator("div").filter({ hasText: /^Points12$/ }),
    ).toBeVisible();
    await expect(summaryTable).toContainText(
      "10 — 1 symmetric airfoils solve positive angles only; 2 points derived by symmetry",
    );
    await expect(
      summaryTable
        .locator("div")
        .filter({ hasText: /^Conditions2 · 1 ambient × 2 speeds × 1 chord$/ }),
    ).toBeVisible();

    await expect(page.getByTestId("review-launch")).toContainText(
      "Launch — 10 solver runs",
    );
    await page.getByTestId("review-launch").click();

    // ---- lands on the campaign page ----
    await expect(page.getByTestId("campaign-detail")).toBeVisible();
    await expect(page).toHaveURL(/campaign=[0-9a-f-]{36}/);
    state.wizardCampaignId = new URL(page.url()).searchParams.get("campaign")!;

    // ---- API truth: campaign exists, active, all 12 obligations materialized ----
    await expect
      .poll(
        async () =>
          (await getSummary(request, state.wizardCampaignId)).campaign.status,
        { message: "campaign should be active" },
      )
      .toBe("active");
    const summary = await getSummary(request, state.wizardCampaignId);
    state.wizardCampaignSlug = summary.campaign.slug;
    expect(summary.totals.requested).toBe(12);
    expect(summary.totals.remaining).toBe(12); // sweeper disabled — nothing solved
    expect(summary.campaign.planRevisionNumber).toBe(1);
    expect(summary.conditions).toHaveLength(2);
    expect(
      summary.conditions
        .map((c) => Math.round(c.reynolds / 1000))
        .sort((a, b) => a - b),
    ).toEqual([137, 274]);

    // Server-side symmetry arithmetic on the SAME plan: 12 points but only 10
    // solver runs — the 2-point gap is the derived-by-symmetry obligation
    // (point-level derived_by_symmetry rows are asserted at the API test
    // layer in apps/api/test/purge.test.ts and campaigns.test.ts).
    const preview = await json<{
      totalPoints: number;
      totalSolverRuns: number;
      status: string;
    }>(request, "post", "/api/admin/campaigns/preview", {
      airfoilIds: [state.symAirfoil.id, state.camAirfoil.id],
      plan: planBody({ speedsMps: [10, 20] }),
    });
    expect(preview.status).toBe("ok");
    expect(preview.totalPoints).toBe(12);
    expect(preview.totalSolverRuns).toBe(10);
  });

  test("campaign cell modal locks the page and exposes the real airfoil profile", async ({
    page,
    request,
  }) => {
    const launched = await launchCampaign(
      request,
      `${state.stamp} cell modal contract`,
      planBody({
        speedsMps: [10],
        baseSweep: { fromDeg: 0, toDeg: 0, stepDeg: 1, listDeg: null },
      }),
    );
    const summary = await json<{
      conditions: Array<{
        id: string;
        ord: number;
        revisionId: string;
        reynolds: number;
        mach: number | null;
      }>;
    }>(request, "get", `/api/admin/campaigns/${launched.campaign.id}`);
    const condition = summary.conditions[0]!;
    const pinnedDetail = await json<AirfoilDetailPayload>(
      request,
      "get",
      `/api/airfoils/${state.camAirfoil.slug}?revisionId=${encodeURIComponent(condition.revisionId)}`,
    );
    const expectedProfile = profilePaths(pinnedDetail.geometry);
    const expectedThumbnail = makePath(
      pinnedDetail.geometry.contour,
      5,
      Math.round(24 * 0.56),
      46,
      true,
    );
    const detailWithEvidence: AirfoilDetailPayload = {
      ...pinnedDetail,
      polars: [
        {
          seriesId: `${state.stamp}-modal-series`,
          label: `Re ${Math.round(condition.reynolds)}`,
          re: condition.reynolds,
          mach: condition.mach ?? undefined,
          color: "#22d3ee",
          source: "solved",
          points: [
            {
              a: 0,
              cl: 0.12,
              cd: 0.01,
              cm: -0.01,
              ld: 12,
              stalled: false,
              source: "solved",
              resultId: `${state.stamp}-modal-result`,
              classificationState: "accepted",
            },
          ],
        },
      ],
    };
    await page.route(
      `**/api/airfoils/${state.camAirfoil.slug}?revisionId=*`,
      async (route) => {
        await route.fulfill({ json: detailWithEvidence });
      },
    );
    let solverFlowPhase:
      | "preflight-critical"
      | "rans-critical"
      | "queued"
      | "running"
      | "fast-critical"
      | "final-critical"
      | "accepted"
      | "accepted-after-fast-critical"
      | "accepted-disagreed"
      | "accepted-with-running-rerun"
      | "accepted-with-critical-rerun" = "preflight-critical";
    let solverFlowRequestCount = 0;
    let activeSolverFlowRequests = 0;
    let maxConcurrentSolverFlowRequests = 0;
    await page.route(
      `**/api/admin/campaigns/${launched.campaign.id}/preliminary-outcomes?*`,
      async (route) => {
        solverFlowRequestCount += 1;
        activeSolverFlowRequests += 1;
        maxConcurrentSolverFlowRequests = Math.max(
          maxConcurrentSolverFlowRequests,
          activeSolverFlowRequests,
        );
        const preflightCritical = solverFlowPhase === "preflight-critical";
        const ransCritical = solverFlowPhase === "rans-critical";
        const queued = solverFlowPhase === "queued";
        const running = solverFlowPhase === "running";
        const finalCritical = solverFlowPhase === "final-critical";
        const accepted =
          solverFlowPhase === "accepted" ||
          solverFlowPhase === "accepted-after-fast-critical" ||
          solverFlowPhase === "accepted-disagreed" ||
          solverFlowPhase === "accepted-with-running-rerun" ||
          solverFlowPhase === "accepted-with-critical-rerun";
        const disagreed = solverFlowPhase === "accepted-disagreed";
        const runningRerun = solverFlowPhase === "accepted-with-running-rerun";
        const criticalRerun =
          solverFlowPhase === "accepted-with-critical-rerun";
        const fastCritical =
          solverFlowPhase === "fast-critical" ||
          solverFlowPhase === "accepted-after-fast-critical";
        const fastAccepted = (accepted && !fastCritical) || finalCritical;
        try {
          // Longer than the poll interval: a setInterval implementation would
          // overlap this request, while the serial poller must not.
          if (running)
            await new Promise((resolve) => setTimeout(resolve, 2_200));
          await route.fulfill({
            json: {
              total: 1,
              // Evidence/result facets intentionally overlap. The per-point UI
              // derives live availability, activity, and incident facets from
              // the item instead of treating these aggregates as a partition.
              recovering: running || queued ? 1 : 0,
              critical:
                preflightCritical ||
                ransCritical ||
                fastCritical ||
                finalCritical ||
                criticalRerun
                  ? 1
                  : 0,
              unavailable:
                preflightCritical ||
                ransCritical ||
                fastCritical ||
                finalCritical
                  ? 1
                  : 0,
              verified: accepted ? 1 : 0,
              items: [
                {
                  aoaDeg: 0,
                  sourceAoaDeg: 0,
                  derivedBySymmetry: false,
                  affectedAoaDegs: [0],
                  affectedPointCount: 1,
                  state:
                    preflightCritical || ransCritical || fastCritical
                      ? "blocked"
                      : finalCritical
                        ? "satisfied"
                        : queued
                          ? "pending"
                          : running
                            ? "running"
                            : "satisfied",
                  outcome:
                    preflightCritical || ransCritical
                      ? "recovery_unavailable"
                      : fastCritical
                        ? "evidence_unavailable"
                        : finalCritical
                          ? "accepted"
                          : queued || running
                            ? "recovering"
                            : "accepted",
                  ransStage: preflightCritical
                    ? "not_started"
                    : ransCritical
                      ? "attempted"
                      : "screened",
                  fastState:
                    preflightCritical || ransCritical
                      ? "not_started"
                      : fastCritical
                        ? "critical"
                        : queued
                          ? "queued"
                          : running
                            ? "running"
                            : "accepted",
                  finalState: finalCritical
                    ? "critical"
                    : accepted
                      ? "accepted"
                      : "not_started",
                  finalActivityState: criticalRerun
                    ? "critical"
                    : runningRerun
                      ? "running"
                      : null,
                  finalComparison: disagreed
                    ? "disagreed"
                    : accepted
                      ? "within_tolerance"
                      : null,
                  finalDeltaCl: disagreed ? 0.061 : accepted ? 0.004 : null,
                  finalDeltaCd: disagreed ? -0.012 : accepted ? 0.0002 : null,
                  finalDeltaCm: null,
                  finalSource: accepted || finalCritical ? "verify" : null,
                  criticalStage: preflightCritical
                    ? "preflight"
                    : ransCritical
                      ? "rans"
                      : fastCritical
                        ? "fast"
                        : finalCritical
                          ? "final"
                          : null,
                  fastResultId: fastAccepted
                    ? `${state.stamp}-fast-result`
                    : null,
                  fastResultAttemptId: fastAccepted
                    ? `${state.stamp}-fast-attempt`
                    : null,
                  finalResultId: accepted
                    ? `${state.stamp}-final-result`
                    : null,
                  finalResultAttemptId: accepted
                    ? `${state.stamp}-final-attempt`
                    : null,
                  finalEvidenceReasons:
                    criticalRerun || finalCritical ? ["non-stationary"] : [],
                  finalSubmitError:
                    criticalRerun || finalCritical
                      ? "final run exhausted automatic recovery"
                      : null,
                  finalSubmitHttpStatus:
                    criticalRerun || finalCritical ? 422 : null,
                  physicalAttemptsUsed:
                    queued || preflightCritical || ransCritical
                      ? 0
                      : fastCritical
                        ? 2
                        : 1,
                  physicalAttemptsMax: 2,
                  recoverySubmissions: queued ? 0 : 1,
                  nonPhysicalSubmissions: 0,
                  interruptedPhysicalRuns: 0,
                  ransEvidenceRuns: preflightCritical
                    ? 0
                    : ransCritical
                      ? 1
                      : 2,
                  preliminaryEvidenceRuns: fastCritical
                    ? 2
                    : fastAccepted || running
                      ? 1
                      : 0,
                  fullUransEvidenceRuns: accepted || finalCritical ? 1 : 0,
                  legacyUransEvidenceRuns: 0,
                  evidenceReasons: preflightCritical
                    ? ["mesh-quality-failure"]
                    : ransCritical
                      ? ["solver-execution-failed"]
                      : fastCritical
                        ? ["non-stationary"]
                        : [],
                  updatedAt: "2026-07-16T00:00:00.000Z",
                },
              ],
            },
          });
        } finally {
          activeSolverFlowRequests -= 1;
        }
      },
    );
    await page.route(
      new RegExp(`/api/admin/campaigns/${launched.campaign.id}(?:\\?.*)?$`),
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({
          response,
          json: {
            ...body,
            solverIncidents: {
              threshold: 3,
              occurrenceCount: 7,
              openCount: 2,
              criticalGroupCount: 2,
              groups: [
                {
                  stage: "preliminary",
                  reason: "continuation-no-progress",
                  solverImplementationId: `${state.stamp}-solver`,
                  solverImplementationKey: "openfoam-2606",
                  remediationVersion: "urans-recovery-2026-07-16-v1",
                  occurrenceCount: 3,
                  openCount: 2,
                  openCriticalCount: 1,
                  firstOccurredAt: "2026-07-16T00:00:00.000Z",
                  lastOccurredAt: "2026-07-16T02:00:00.000Z",
                  requiresInvestigation: true,
                  effectiveSeverity: "critical",
                },
                {
                  stage: "final",
                  reason: "media-repair-exhausted",
                  solverImplementationId: `${state.stamp}-solver`,
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
              ],
            },
          },
        });
      },
    );

    await page.setViewportSize({ width: 1200, height: 360 });
    await page.goto(`/admin?campaign=${launched.campaign.id}`);
    await expect(page.getByTestId("campaign-detail")).toBeVisible();
    const incidentRail = page.getByTestId("solver-incidents-campaign");
    await expect(incidentRail).toBeVisible();
    await expect(incidentRail).toContainText("FAST URANS");
    await expect(incidentRail).toContainText("continuation made no progress");
    await expect(incidentRail).toContainText("×3 · 2 active");
    await expect(incidentRail).toContainText("CRITICAL");
    await expect(incidentRail).toContainText("SYSTEM OWNED");
    await expect(incidentRail).toContainText("System investigation required");
    await expect(incidentRail).not.toContainText(
      "urans-recovery-2026-07-16-v1",
    );
    await expect(incidentRail).not.toContainText("FINAL URANS");
    await expect(incidentRail).not.toContainText("media recovery exhausted");
    await expect(
      incidentRail.getByTestId("solver-incident-group-0"),
    ).toHaveAttribute("data-status", "critical");

    const trigger = page.getByTestId(
      `matrix-cell-${state.camAirfoil.slug}-${condition.ord}`,
    );
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    await expect(trigger).toBeFocused();
    const originalScrollY = await page.evaluate(() => {
      window.scrollTo(0, Math.max(1, document.documentElement.scrollHeight));
      return window.scrollY;
    });
    expect(originalScrollY).toBeGreaterThan(0);
    await page.keyboard.press("Enter");

    const panel = page.getByTestId("cell-side-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("role", "dialog");
    await expect(panel).toHaveAttribute("aria-modal", "true");
    await expect(panel).toHaveAccessibleName(
      new RegExp(
        `${state.stamp} cam 4415 at Re ${Math.round(condition.reynolds / 1000)}k`,
        "i",
      ),
    );
    await expect
      .poll(() => page.evaluate(() => document.body.style.position))
      .toBe("fixed");
    await expect
      .poll(() =>
        panel.evaluate(
          (element) => getComputedStyle(element).overscrollBehaviorY,
        ),
      )
      .toBe("contain");
    await expect
      .poll(() =>
        panel.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);

    const thumbnail = page.getByTestId("cell-airfoil-thumbnail");
    await expect(thumbnail.locator("svg path")).toHaveAttribute(
      "d",
      expectedThumbnail,
    );
    const preliminary = panel.getByTestId("cell-preliminary-outcomes");
    const handoffRail = preliminary.getByTestId(
      "cell-preliminary-handoff-rail",
    );
    await expect(handoffRail).toHaveAccessibleName(
      "RANS screen, normal handoff to fast preliminary URANS, then final verified URANS",
    );
    await expect(handoffRail.locator('[data-flow-stage="rans"]')).toHaveCount(
      1,
    );
    await expect(handoffRail.locator('[data-flow-stage="fast"]')).toHaveCount(
      1,
    );
    await expect(handoffRail.locator('[data-flow-stage="final"]')).toHaveCount(
      1,
    );
    await expect(handoffRail).toContainText("normal handoff");
    const pointTrack = preliminary.getByTestId("cell-preliminary-track-0");
    const pointRow = preliminary.getByTestId("cell-preliminary-outcome-0");
    const finalStage = preliminary.getByTestId("cell-preliminary-final-0");
    const currentCounts = preliminary.getByTestId(
      "cell-preliminary-current-counts",
    );

    // A non-aerodynamic screening recovery incident stays in this same row.
    // It is not relabeled as normal RANS handoff and does not invent a fast run.
    await expect(pointRow).toHaveAttribute("data-rans-stage", "not_started");
    await expect(pointRow).toHaveAttribute("data-critical-stage", "preflight");
    await expect(
      preliminary.getByTestId("cell-preliminary-rans-0"),
    ).toHaveClass(/critical/);
    await expect(
      preliminary.getByTestId("cell-preliminary-rans-0"),
    ).toHaveAttribute(
      "title",
      "RANS: not started; automatic mesh/runtime repair is critical",
    );
    await expect(
      preliminary.getByTestId("cell-preliminary-rans-0"),
    ).toHaveAttribute("aria-current", "step");
    await expect(
      preliminary.getByTestId("cell-preliminary-fast-0"),
    ).toHaveClass(/not_started/);
    await expect(preliminary).toContainText(
      "CRITICAL · SOLVER COULD NOT START",
    );
    await expect(currentCounts).toHaveAccessibleName(
      "Result and incident facets: 0 active, 0 RANS accepted, 0 fast ready, 0 verified, 1 critical",
    );
    await expect(
      preliminary.getByTestId("cell-preliminary-incident-0"),
    ).toContainText("SYSTEM");

    // A later attempted-RANS incident is distinct: it has one retained RANS
    // evidence record, but still no fast-URANS physical run.
    solverFlowPhase = "rans-critical";
    await expect(pointRow).toHaveAttribute("data-rans-stage", "attempted", {
      timeout: 8_000,
    });
    await expect(pointRow).toHaveAttribute("data-critical-stage", "rans");
    await expect(
      preliminary.getByTestId("cell-preliminary-rans-0"),
    ).toHaveAttribute(
      "title",
      "RANS: attempt recorded; automatic recovery exhausted before fast URANS",
    );
    await expect(
      preliminary.getByTestId("cell-preliminary-fast-0"),
    ).toHaveClass(/not_started/);
    await expect(preliminary).toContainText(
      "CRITICAL · SCREENING RECOVERY EXHAUSTED",
    );

    // The open dialog revalidates this point without page interaction. Each
    // snapshot owns exactly one current stage.
    solverFlowPhase = "queued";
    await expect(
      preliminary.getByTestId("cell-preliminary-fast-0"),
    ).toHaveClass(/queued/, { timeout: 8_000 });
    await expect(pointTrack.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(
      preliminary.getByTestId("cell-preliminary-fast-0"),
    ).toHaveAttribute("aria-current", "step");
    await expect(currentCounts).toHaveAccessibleName(
      "Result and incident facets: 1 active, 0 RANS accepted, 0 fast ready, 0 verified, 0 critical",
    );

    solverFlowPhase = "running";
    await expect(
      preliminary.getByTestId("cell-preliminary-fast-0"),
    ).toHaveClass(/running/, { timeout: 8_000 });
    await expect(preliminary).toContainText("URANS fast · running");
    await expect(pointTrack.locator('[aria-current="step"]')).toHaveCount(1);

    solverFlowPhase = "fast-critical";
    await expect(
      preliminary.getByTestId("cell-preliminary-fast-0"),
    ).toHaveClass(/critical/, { timeout: 8_000 });
    await expect(preliminary).toContainText("CRITICAL · FAST URANS EXHAUSTED");
    await expect(
      preliminary.getByTestId("cell-preliminary-rans-0"),
    ).toHaveClass(/screened/);
    await expect(pointTrack).toHaveAccessibleName(/RANS screened/i);
    await expect(preliminary).not.toContainText("RANS failure");
    await expect(pointTrack.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(currentCounts).toHaveAccessibleName(
      "Result and incident facets: 0 active, 0 RANS accepted, 0 fast ready, 0 verified, 1 critical",
    );

    solverFlowPhase = "accepted-after-fast-critical";
    await expect(
      preliminary.getByTestId("cell-preliminary-final-0"),
    ).toContainText("Verified", { timeout: 8_000 });
    await expect(preliminary).toContainText("URANS final · verified");
    await expect(pointRow).toHaveClass(/is-critical/);
    await expect(
      preliminary.getByTestId("cell-preliminary-fast-0"),
    ).toHaveClass(/critical/);
    await expect(
      preliminary.getByTestId("cell-preliminary-incident-0"),
    ).toHaveAttribute(
      "title",
      "FAST URANS EXHAUSTED; system-owned incident; engineering investigation required",
    );
    await expect(currentCounts).toHaveAccessibleName(
      "Result and incident facets: 0 active, 0 RANS accepted, 0 fast ready, 1 verified, 1 critical",
    );

    solverFlowPhase = "accepted";
    await expect(
      preliminary.getByTestId("cell-preliminary-final-0"),
    ).toContainText("Verified", { timeout: 8_000 });
    await expect(preliminary).toContainText("URANS final · verified");
    await expect(pointTrack.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(
      preliminary.getByTestId("cell-preliminary-final-0"),
    ).toHaveAttribute("aria-current", "step");
    const finalStageHitBox = await preliminary
      .getByTestId("cell-preliminary-final-0")
      .boundingBox();
    expect(finalStageHitBox).not.toBeNull();
    expect(finalStageHitBox!.width).toBeGreaterThanOrEqual(44);
    expect(finalStageHitBox!.height).toBeGreaterThanOrEqual(44);
    await expect(currentCounts).toHaveAccessibleName(
      "Result and incident facets: 0 active, 0 RANS accepted, 0 fast ready, 1 verified, 0 critical",
    );
    await expect(
      preliminary.getByTestId("cell-preliminary-incident-0"),
    ).toHaveCount(0);

    const exactFinalResultRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname.endsWith(`/api/airfoils/${state.camAirfoil.slug}/sim`) &&
        url.searchParams.get("resultId") === `${state.stamp}-final-result`
      );
    });
    await preliminary.getByTestId("cell-preliminary-final-0").click();
    const finalResultRequest = new URL((await exactFinalResultRequest).url());
    expect(finalResultRequest.searchParams.get("aoa")).toBe("0");
    await expect(page.getByTestId("sim-modal-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sim-modal-dialog")).toHaveCount(0);
    await expect(
      preliminary.getByTestId("cell-preliminary-final-0"),
    ).toBeFocused();

    solverFlowPhase = "accepted-disagreed";
    await expect(finalStage).toHaveClass(/comparison-warning/, {
      timeout: 8_000,
    });
    await expect(finalStage.locator(".accepted-mark")).toBeVisible();
    await expect(finalStage.locator(".activity-mark.warning")).toBeVisible();
    await expect(preliminary).toContainText("VERIFIED · DIFFERS FROM FAST");
    await expect(pointRow).toHaveClass(/is-verified/);
    await expect(pointRow).not.toHaveClass(/is-critical/);
    await expect(currentCounts).toHaveAccessibleName(
      "Result and incident facets: 0 active, 0 RANS accepted, 0 fast ready, 1 verified, 0 critical",
    );

    solverFlowPhase = "final-critical";
    await expect(
      preliminary.getByTestId("cell-preliminary-final-0"),
    ).toHaveClass(/critical/, { timeout: 8_000 });
    await expect(preliminary).toContainText("CRITICAL · FINAL URANS EXHAUSTED");
    await expect(
      preliminary.getByTestId("cell-preliminary-fast-0"),
    ).toHaveClass(/accepted/);
    await expect(pointTrack.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(currentCounts).toHaveAccessibleName(
      "Result and incident facets: 0 active, 0 RANS accepted, 1 fast ready, 0 verified, 1 critical",
    );

    solverFlowPhase = "accepted";
    await expect(
      preliminary.getByTestId("cell-preliminary-final-0"),
    ).toHaveClass(/accepted/, { timeout: 8_000 });

    solverFlowPhase = "accepted-with-running-rerun";
    await expect(finalStage.locator(".activity-mark.running")).toBeVisible({
      timeout: 8_000,
    });
    await expect(finalStage.locator(".accepted-mark")).toBeVisible();
    await expect(preliminary).toContainText("URANS final · update running");
    await expect(pointRow).toHaveClass(/is-active/);
    await expect(pointTrack.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(currentCounts).toHaveAccessibleName(
      "Result and incident facets: 1 active, 0 RANS accepted, 0 fast ready, 1 verified, 0 critical",
    );

    solverFlowPhase = "accepted-with-critical-rerun";
    await expect(finalStage).toHaveClass(/update-warning/, { timeout: 8_000 });
    await expect(preliminary).toContainText("URANS final · verified");
    await expect(finalStage.locator(".accepted-mark")).toBeVisible();
    await expect(finalStage.locator(".activity-mark.warning")).toBeVisible();
    await expect(pointRow).toHaveClass(/is-critical/);
    await expect(
      preliminary.getByTestId("cell-preliminary-incident-0"),
    ).toHaveAttribute(
      "title",
      "FINAL URANS UPDATE EXHAUSTED; system-owned incident; engineering investigation required",
    );
    await expect(pointTrack.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(currentCounts).toHaveAccessibleName(
      "Result and incident facets: 0 active, 0 RANS accepted, 0 fast ready, 1 verified, 1 critical",
    );
    expect(maxConcurrentSolverFlowRequests).toBe(1);

    await expect(
      preliminary.getByTestId("cell-preliminary-rans-0"),
    ).toHaveClass(/screened/);
    await expect(pointTrack).toHaveAccessibleName(/RANS screened/i);
    await expect(pointTrack.locator(".connector").first()).toHaveClass(
      /complete/,
    );
    await expect(preliminary).not.toContainText("RANS failure");
    await expect(preliminary).not.toContainText("no action required");
    await expect(preliminary).not.toContainText("solver evidence rejected");
    await expect(panel.locator(".cell-fidelity-ladder")).toHaveCount(0);
    await expect(panel.getByText("Whole-polar request")).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Fast URANS" }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Final URANS" }),
    ).toBeVisible();
    await expect(panel.getByText("FAILED POINTS", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      panel.getByText("RANS INTERRUPTIONS", { exact: true }),
    ).toHaveCount(0);
    const diagnostics = preliminary.getByTestId(
      "cell-preliminary-diagnostics-0",
    );
    await expect(diagnostics).not.toHaveAttribute("open", "");
    const diagnosticsSummary = diagnostics.getByLabel(
      "Stage evidence for α 0.0°",
    );
    const summaryBeforeOpen = await diagnosticsSummary.boundingBox();
    await diagnosticsSummary.click();
    await expect(diagnostics).toHaveAttribute("open", "");
    const summaryAfterOpen = await diagnosticsSummary.boundingBox();
    expect(summaryBeforeOpen).not.toBeNull();
    expect(summaryAfterOpen).not.toBeNull();
    expect(
      Math.abs(summaryAfterOpen!.x - summaryBeforeOpen!.x),
    ).toBeLessThanOrEqual(1);
    await expect(
      diagnostics.locator('[data-detail-stage="rans"]'),
    ).toContainText("2 evidence records");
    await expect(
      diagnostics.locator('[data-detail-stage="fast"]'),
    ).toContainText("1/2 physical attempts");
    await expect(
      diagnostics.locator('[data-detail-stage="final"]'),
    ).toContainText("1 evidence record");
    await expect(diagnostics).toContainText(
      "non-convergence hands off normally",
    );
    await expect(diagnostics).toContainText("Evidence · 2 RANS");
    await expect(diagnostics).toContainText("1 fast URANS evidence record");
    await expect(diagnostics).toContainText("1 final URANS evidence record");
    await expect(diagnostics).toContainText(
      "Fast URANS · 1/2 physical attempts",
    );
    await expect(diagnostics).toContainText(
      "Verified result retained; the latest update exhausted recovery",
    );

    const lockedScrollY = await page.evaluate(() => window.scrollY);
    await expect
      .poll(() =>
        panel.evaluate(
          (element) => element.scrollHeight - element.clientHeight,
        ),
      )
      .toBeGreaterThan(0);
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    await page.mouse.move(panelBox!.x + panelBox!.width - 10, panelBox!.y + 80);
    await page.mouse.wheel(0, 500);
    await expect
      .poll(() => panel.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBe(lockedScrollY);

    await panel.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.mouse.wheel(0, -500);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBe(lockedScrollY);

    await panel.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.mouse.wheel(0, 500);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBe(lockedScrollY);

    await page.mouse.move(20, 180);
    await page.mouse.wheel(0, 500);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBe(lockedScrollY);

    const panelFocusable = panel.locator(
      'a[href]:visible, button:not([disabled]):visible, input:not([disabled]):visible, select:not([disabled]):visible, textarea:not([disabled]):visible, [tabindex]:not([tabindex="-1"]):visible',
    );
    const firstPanelControl = panelFocusable.first();
    const lastPanelControl = panelFocusable.last();
    await lastPanelControl.focus();
    await page.keyboard.press("Tab");
    await expect(firstPanelControl).toBeFocused();
    await firstPanelControl.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(lastPanelControl).toBeFocused();

    await panel.evaluate((element) => {
      element.scrollTop = 0;
    });
    const clCdTab = panel.getByRole("tab", { name: "Cl–Cd" });
    await clCdTab.click();
    await expect(clCdTab).toHaveAttribute("aria-selected", "true");
    await panel.getByTestId("polar-zoom-in").click();
    await expect(panel.getByTestId("polar-chart-panel")).toHaveAttribute(
      "data-domain-active",
      "true",
    );
    const airfoilTab = panel.getByRole("tab", { name: "Airfoil" });
    await airfoilTab.click();
    await expect(airfoilTab).toHaveAttribute("aria-selected", "true");
    const profile = panel.getByTestId("polar-profile-panel");
    await expect(profile).toBeVisible();
    await expect(
      profile.getByRole("img", {
        name: new RegExp(`${state.stamp} cam 4415 airfoil profile`, "i"),
      }),
    ).toBeVisible();
    await expect(
      profile.getByTestId("airfoil-profile-surface"),
    ).toHaveAttribute("d", expectedProfile.profilePath);
    await expect(profile.getByTestId("airfoil-profile-camber")).toHaveAttribute(
      "d",
      expectedProfile.camberPath,
    );
    await clCdTab.click();
    await expect(clCdTab).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByTestId("polar-chart-panel")).toHaveAttribute(
      "data-domain-active",
      "true",
    );

    const evidencePoint = panel
      .getByTestId("polar-chart-svg")
      .locator('circle[role="button"]')
      .first();
    await evidencePoint.focus();
    await evidencePoint.click();
    const simDialog = page.getByTestId("sim-modal-dialog");
    await expect(simDialog).toBeVisible();
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    await expect(panel).toHaveAttribute("inert", "");
    await expect
      .poll(() =>
        simDialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      )
      .toBe(true);
    expect(await page.evaluate(() => document.body.style.position)).toBe(
      "fixed",
    );

    const simFocusable = simDialog.locator(
      'a[href]:visible, button:not([disabled]):visible, input:not([disabled]):visible, select:not([disabled]):visible, textarea:not([disabled]):visible, [tabindex]:not([tabindex="-1"]):visible',
    );
    const firstSimControl = simFocusable.first();
    const lastSimControl = simFocusable.last();
    await lastSimControl.focus();
    await page.keyboard.press("Tab");
    await expect(firstSimControl).toBeFocused();
    await firstSimControl.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(lastSimControl).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(simDialog).toHaveCount(0);
    await expect(panel).not.toHaveAttribute("aria-hidden", "true");
    await expect
      .poll(() =>
        panel.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
    expect(await page.evaluate(() => document.body.style.position)).toBe(
      "fixed",
    );

    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBe(originalScrollY);
    expect(await page.evaluate(() => document.body.style.position)).toBe("");
    await page.waitForTimeout(100);
    const requestsAfterClose = solverFlowRequestCount;
    await page.waitForTimeout(2_300);
    expect(solverFlowRequestCount).toBe(requestsAfterClose);

    await page.setViewportSize({ width: 390, height: 844 });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    const narrowOriginalScrollY = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();
    await panel.getByRole("tab", { name: "Cm–α" }).scrollIntoViewIfNeeded();
    await panel.getByRole("tab", { name: "Airfoil" }).click();
    await expect(profile).toBeVisible();
    await expect(
      profile.getByTestId("airfoil-profile-surface"),
    ).toHaveAttribute("d", expectedProfile.profilePath);
    const narrowTrack = preliminary.getByTestId("cell-preliminary-track-0");
    await expect(narrowTrack).toBeVisible();
    await expect(handoffRail.getByText("normal handoff")).toBeVisible();
    await expect(narrowTrack).toHaveAccessibleName(/RANS screened/i);
    const narrowConnectors = narrowTrack.locator(".connector");
    await expect(narrowConnectors).toHaveCount(2);
    await expect(narrowConnectors.nth(0)).toBeVisible();
    await expect(narrowConnectors.nth(1)).toBeVisible();
    expect(
      await narrowTrack.evaluate((element) => element.scrollWidth),
    ).toBeLessThanOrEqual(
      await narrowTrack.evaluate((element) => element.clientWidth),
    );

    const overflow = await page.evaluate(() => {
      const panelElement = document.querySelector<HTMLElement>(
        '[data-testid="cell-side-panel"]',
      );
      const profileElement = document.querySelector<HTMLElement>(
        '[data-testid="airfoil-profile-plot"]',
      );
      return {
        document: document.documentElement.scrollWidth - window.innerWidth,
        panel: panelElement
          ? panelElement.scrollWidth - panelElement.clientWidth
          : Number.POSITIVE_INFINITY,
        profile: profileElement
          ? profileElement.scrollWidth - profileElement.clientWidth
          : Number.POSITIVE_INFINITY,
      };
    });
    expect(overflow.document).toBeLessThanOrEqual(0);
    expect(overflow.panel).toBeLessThanOrEqual(0);
    expect(overflow.profile).toBeLessThanOrEqual(0);

    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBe(narrowOriginalScrollY);
  });

  test("campaign instrument matches the approved option-3 geometry contract", async ({
    page,
    request,
  }) => {
    const launched = await launchCampaign(
      request,
      `${state.stamp} instrument contract`,
      planBody({ speedsMps: [10] }),
    );
    const renderedProgress = {
      solved: 1_010,
      requested: 631_410,
      remaining: 630_400,
    };
    await page.route(
      `**/api/admin/campaigns/${launched.campaign.id}`,
      async (route) => {
        const response = await route.fetch();
        const payload = (await response.json()) as {
          totals: Record<string, number>;
        };
        await route.fulfill({
          response,
          json: {
            ...payload,
            totals: { ...payload.totals, ...renderedProgress },
          },
        });
      },
    );
    await page.setViewportSize({ width: 1297, height: 1212 });
    await page.goto(`/admin?campaign=${launched.campaign.id}`);
    await expect(page.getByTestId("campaign-detail")).toBeVisible();

    const hero = page.getByTestId("campaign-instrument-hero");
    const gauge = page.getByTestId("campaign-progress-gauge");
    const rail = page.getByTestId("campaign-stage-rail");
    const metrics = page.getByTestId("campaign-counts-line");
    await expect(hero).toBeVisible();
    await expect(gauge).toBeVisible();
    await expect(
      hero.getByRole("progressbar", { name: "Campaign completion" }),
    ).toBeVisible();
    const detailsToggle = page.getByTestId("campaign-details-toggle");
    const detailsPanel = page.getByTestId("campaign-details");
    await expect(detailsToggle).toHaveAttribute(
      "aria-controls",
      "campaign-instrument-details",
    );
    await expect(detailsPanel).toBeHidden();
    await detailsToggle.click();
    await expect(detailsPanel).toBeVisible();
    await detailsToggle.click();
    await expect(detailsPanel).toBeHidden();
    await expect(gauge).toHaveAttribute("role", "progressbar");
    await expect(gauge).toHaveAttribute("aria-valuemin", "0");
    await expect(gauge).toHaveAttribute(
      "aria-valuenow",
      String(renderedProgress.solved),
    );
    await expect(gauge).toHaveAttribute(
      "aria-valuemax",
      String(renderedProgress.requested),
    );
    await expect(gauge).toHaveAttribute(
      "aria-valuetext",
      "1,010 of 631,410, 0.16% complete",
    );

    // The approved artifact is a live semicircle without a speedometer needle
    // or a second visible completion bar.
    const dialCanvas = gauge.getByTestId("campaign-progress-dial-canvas");
    await expect(dialCanvas).toBeVisible();
    const countPaintedProgressPixels = () =>
      dialCanvas.evaluate((node) => {
        const canvas = node as HTMLCanvasElement;
        const context = canvas.getContext("2d");
        if (!context) return 0;
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        let cyanCorePixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const red = pixels[index] ?? 0;
          const green = pixels[index + 1] ?? 0;
          const blue = pixels[index + 2] ?? 0;
          const alpha = pixels[index + 3] ?? 0;
          if (
            green > 150 &&
            blue > 140 &&
            green - red > 70 &&
            blue - red > 60 &&
            alpha > 180
          ) {
            cyanCorePixels += 1;
          }
        }
        return cyanCorePixels / Math.max(1, window.devicePixelRatio ** 2);
      });
    await expect.poll(countPaintedProgressPixels).toBeGreaterThan(2);
    expect(await countPaintedProgressPixels()).toBeLessThan(250);
    await expect(gauge.getByTestId("campaign-progress-needle")).toHaveCount(0);
    await expect(page.getByTestId("campaign-progress-bar")).toHaveCount(0);

    // One continuous numbered rail, followed by the three unboxed operational
    // readouts, all belong to the same primary instrument.
    await expect(rail.getByTestId("campaign-stage-node-steady")).toHaveText(
      "1",
    );
    await expect(rail.getByTestId("campaign-stage-node-unsteady")).toHaveText(
      "2",
    );
    await expect(rail.getByTestId("campaign-stage-node-verify")).toHaveText(
      "3",
    );
    await expect(rail.getByTestId("campaign-stage-steady")).toContainText(
      "RANS",
    );
    await expect(rail.getByTestId("campaign-stage-unsteady")).toContainText(
      "FAST URANS",
    );
    await expect(rail.getByTestId("campaign-stage-verify")).toContainText(
      "FINAL URANS",
    );
    await expect(rail.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(rail.getByTestId("campaign-stage-connector")).toBeVisible();
    await expect(hero.getByTestId("campaign-counts-line")).toBeVisible();
    await expect(metrics.locator(":scope > *")).toHaveCount(3);
    await expect(
      metrics.getByTestId("campaign-metric-processing"),
    ).toBeVisible();
    await expect(
      metrics.getByTestId("campaign-metric-auto-repair"),
    ).toBeVisible();
    await expect(
      metrics.getByTestId("campaign-metric-throughput"),
    ).toBeVisible();

    const nodes = [
      rail.getByTestId("campaign-stage-node-steady"),
      rail.getByTestId("campaign-stage-node-unsteady"),
      rail.getByTestId("campaign-stage-node-verify"),
    ];
    const [gaugeBox, railBox, connectorBox, metricsBox, ...nodeBoxes] =
      await Promise.all([
        gauge.boundingBox(),
        rail.boundingBox(),
        rail.getByTestId("campaign-stage-connector").boundingBox(),
        metrics.boundingBox(),
        ...nodes.map((node) => node.boundingBox()),
      ]);
    expect(gaugeBox).not.toBeNull();
    expect(railBox).not.toBeNull();
    expect(connectorBox).not.toBeNull();
    expect(metricsBox).not.toBeNull();
    expect(nodeBoxes.every(Boolean)).toBe(true);
    expect(gaugeBox!.width / gaugeBox!.height).toBeGreaterThan(1.65);
    expect(gaugeBox!.width / gaugeBox!.height).toBeLessThan(2.05);
    expect(gaugeBox!.width).toBeGreaterThan(440);
    expect(railBox!.width).toBeGreaterThan(gaugeBox!.width * 1.15);
    expect(railBox!.y).toBeGreaterThan(gaugeBox!.y + gaugeBox!.height - 20);
    expect(railBox!.y).toBeLessThan(gaugeBox!.y + gaugeBox!.height + 110);
    expect(metricsBox!.y).toBeGreaterThan(railBox!.y + 90);
    expect(metricsBox!.y).toBeLessThan(railBox!.y + 200);
    expect(connectorBox!.height).toBeLessThanOrEqual(3);
    const nodeCenters = nodeBoxes.map((box) => ({
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height / 2,
    }));
    expect(
      Math.max(...nodeCenters.map((node) => node.y)) -
        Math.min(...nodeCenters.map((node) => node.y)),
    ).toBeLessThan(1);
    expect(Math.abs(connectorBox!.x - nodeCenters[0]!.x)).toBeLessThan(2);
    expect(
      Math.abs(connectorBox!.x + connectorBox!.width - nodeCenters[2]!.x),
    ).toBeLessThan(2);

    // The artifact stays one horizontal instrument on narrow screens: no
    // rail collapse, vertical status-list substitution or page overflow.
    await page.setViewportSize({ width: 390, height: 844 });
    const [narrowGauge, narrowHero, ...narrowBoxes] = await Promise.all([
      gauge.boundingBox(),
      hero.boundingBox(),
      ...nodes.map((node) => node.boundingBox()),
      ...[
        metrics.getByTestId("campaign-metric-processing"),
        metrics.getByTestId("campaign-metric-auto-repair"),
        metrics.getByTestId("campaign-metric-throughput"),
      ].map((metric) => metric.boundingBox()),
    ]);
    expect(narrowGauge).not.toBeNull();
    expect(narrowHero).not.toBeNull();
    expect(narrowGauge!.width / narrowGauge!.height).toBeGreaterThan(1.8);
    const narrowNodeBoxes = narrowBoxes.slice(0, 3);
    const narrowMetricBoxes = narrowBoxes.slice(3);
    expect(narrowNodeBoxes.every(Boolean)).toBe(true);
    expect(narrowMetricBoxes.every(Boolean)).toBe(true);
    expect(
      Math.max(...narrowNodeBoxes.map((box) => box!.y)) -
        Math.min(...narrowNodeBoxes.map((box) => box!.y)),
    ).toBeLessThan(1);
    expect(
      Math.max(...narrowMetricBoxes.map((box) => box!.y)) -
        Math.min(...narrowMetricBoxes.map((box) => box!.y)),
    ).toBeLessThan(1);
    const overflow = await page.evaluate(() => ({
      document:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      hero: (() => {
        const element = document.querySelector<HTMLElement>(
          '[data-testid="campaign-instrument-hero"]',
        );
        return element ? element.scrollWidth - element.clientWidth : 1;
      })(),
    }));
    expect(overflow.document).toBeLessThanOrEqual(0);
    expect(overflow.hero).toBeLessThanOrEqual(0);
  });

  test("edit-conditions dialog previews and applies a real removal diff", async ({
    page,
    request,
  }) => {
    const launched = await launchCampaign(
      request,
      `${state.stamp} edit target`,
      planBody(),
    );
    expect(launched.totals.requested).toBe(12);
    const id = launched.campaign.id;

    await page.goto(`/admin?campaign=${id}`);
    await expect(page.getByTestId("campaign-detail")).toBeVisible();
    // Plan-edit verbs live in the "⋯" overflow (approved design D: one
    // visible primary lifecycle action, everything else behind the overflow).
    await page.getByTestId("campaign-actions-overflow").click();
    await page.getByTestId("campaign-action-edit-conditions").click();
    const dialog = page.getByTestId("plan-edit-dialog-conditions");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("plan-edit-banner")).toContainText(
      "solved results are never deleted",
    );

    // Remove the 20 m/s speed value → one whole condition goes away.
    await dialog
      .getByTestId("wizard-speeds-chip-20.000")
      .getByRole("button", { name: /^Remove/ })
      .click();
    await expect(dialog.getByTestId("wizard-speeds-chip-20.000")).toHaveCount(
      0,
    );
    await page.getByTestId("plan-edit-preview").click();

    // Acknowledge dialog: outcome sections with REAL counts. No evidence has
    // landed (sweeper off) → removal cancels pending, nothing kept.
    await expect(page.getByTestId("plan-ack-dialog")).toBeVisible();
    await expect(page.getByTestId("plan-ack-removing")).toContainText(
      "1 condition released (no results anywhere)",
    );
    await expect(page.getByTestId("plan-ack-removing")).toContainText(
      "6 pending points cancelled",
    );
    await expect(page.getByTestId("plan-ack-kept")).toContainText(
      "nothing kept — no removed work has results yet",
    );
    await expect(page.getByTestId("plan-ack-adding")).toContainText(
      "nothing added",
    );
    await expect(page.getByTestId("plan-ack-apply")).toContainText(
      "Apply — add 0 points, cancel 6 pending",
    );
    await page.getByTestId("plan-ack-apply").click();
    await expect(dialog).toHaveCount(0);

    // API truth: released obligations are gone; plan revision 2 recorded
    // (revision kind='edit' is asserted at the API layer — purge.test.ts —
    // since the summary API intentionally exposes only the revision number).
    await expect
      .poll(
        async () => (await getSummary(request, id)).campaign.planRevisionNumber,
        { message: "plan revision should advance" },
      )
      .toBe(2);
    const summary = await getSummary(request, id);
    expect(summary.totals.requested).toBe(6);
    expect(
      summary.conditions.filter((c) => c.status === "active"),
    ).toHaveLength(1);
    expect(summary.campaign.plan.speedsMps).toEqual(["10.000"]);
  });

  test("routing: back to hub, unknown campaign, wizard dirty guard + draft survival", async ({
    page,
  }) => {
    // hub → campaign → browser Back returns to the hub with the Active segment
    await page.goto("/admin");
    await expect(page.getByTestId("campaigns-hub")).toBeVisible();
    await page.getByTestId(`campaign-open-${state.wizardCampaignSlug}`).click();
    await expect(page.getByTestId("campaign-detail")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("campaigns-hub")).toBeVisible();
    await expect(page.getByTestId("campaigns-segment-active")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // unknown ?campaign= renders the not-found state with a working back link
    await page.goto("/admin?campaign=00000000-0000-4000-8000-000000000000");
    await expect(page.getByTestId("campaign-not-found")).toBeVisible();
    await expect(page.getByTestId("campaign-not-found")).toContainText(
      "does not exist (or was purged)",
    );
    await page.getByRole("button", { name: /back to campaigns/i }).click();
    await expect(page.getByTestId("campaigns-hub")).toBeVisible();

    // wizard dirty guard on nav-away; the draft survives in sessionStorage
    await page.getByTestId("new-polar-sweep").click();
    await expect(page.getByTestId("campaign-wizard")).toBeVisible();
    await page.getByTestId("scope-mode-manual").click();
    await page.getByTestId("campaign-airfoil-search").fill(state.stamp);
    await page
      .getByTestId(`campaign-airfoil-option-${state.symAirfoil.slug}`)
      .click();
    await expect(
      page.getByTestId("campaign-airfoil-selected-count"),
    ).toContainText("1 selected");

    let confirmMessage = "";
    page.once("dialog", (dialog) => {
      confirmMessage = dialog.message();
      void dialog.accept();
    });
    await page.getByTestId("admin-nav-queue").click();
    await expect(page.getByTestId("openfoam-queue-page")).toBeVisible();
    expect(confirmMessage).toContain("Leave the campaign wizard?");

    const draft = await page.evaluate(() => {
      const latest = sessionStorage.getItem(
        "aerodb.campaign-wizard.latest-draft-id",
      );
      if (!latest) return null;
      return JSON.parse(
        sessionStorage.getItem(`aerodb.campaign-wizard.draft.${latest}`) ??
          "null",
      ) as {
        kind: string;
        scopeMode: string;
        manualAirfoilIds: string[];
      } | null;
    });
    expect(draft?.kind).toBe("polar_sweep");
    expect(draft?.scopeMode).toBe("manual");
    expect(draft?.manualAirfoilIds).toContain(state.symAirfoil.id);

    // Re-entering the same wizard kind restores the surviving draft.
    await page.getByTestId("admin-nav-simulations").click();
    await page.getByTestId("new-polar-sweep").click();
    await expect(
      page.getByTestId("campaign-airfoil-selected-count"),
    ).toContainText("1 selected");
  });

  test("refinement board renders lanes, states, and objective chips without solving", async ({
    page,
    request,
  }) => {
    const launched = await launchCampaign(
      request,
      `${state.stamp} ld refine`,
      planBody({
        speedsMps: [10],
        objectives: {
          ldMax: { enabled: true, toleranceDeg: 0.1, maxRounds: 8 },
          clZero: { enabled: true, toleranceDeg: 0.05, maxRounds: 6 },
        },
      }),
    );
    const id = launched.campaign.id;
    // Lanes exist immediately: 2 airfoils × 1 condition × 2 objectives.
    const summary = await getSummary(request, id);
    expect(summary.lanesSummary.ld_max?.awaiting_seed).toBe(2);
    expect(summary.lanesSummary.cl_zero?.awaiting_seed).toBe(1);
    expect(summary.lanesSummary.cl_zero?.symmetric_definition).toBe(1);

    await page.goto(`/admin?campaign=${id}`);
    await expect(page.getByTestId("campaign-detail")).toBeVisible();
    // Objective chips are technical plan detail — behind the details
    // disclosure since the pipeline-hero redesign (approved design c19fd74a).
    await page.getByTestId("campaign-details-toggle").click();
    // The disclosure is URL-owned (?cdetails=1, same contract as ?flog=1):
    // reload must land with the details still open.
    await expect(page).toHaveURL(/[?&]cdetails=1/);
    await expect(page.getByText(/max L\/D ±0\.10?°/)).toBeVisible(); // objective chip in plan details
    await page.reload();
    await expect(page.getByTestId("campaign-details")).toBeVisible();

    const board = page.getByTestId("refinement-board");
    await expect(board).toBeVisible();
    await expect(board).toContainText("4 lanes");
    await expect(page.getByTestId("lane-pill-awaiting_seed")).toContainText(
      "awaiting seed sweep · 3",
    );
    await expect(
      page.getByTestId("lane-pill-symmetric_definition"),
    ).toContainText("α₀ = 0° by definition · 1");

    // Lane rows carry the objective chips and truthful states.
    const symClZeroLane = page.getByTestId(
      new RegExp(`^lane-row-${state.symAirfoil.slug}-\\d+-cl_zero$`),
    );
    await expect(symClZeroLane).toBeVisible();
    await expect(symClZeroLane).toContainText("α₀ (Cl = 0)");
    await expect(symClZeroLane).toContainText("α₀ = 0° by definition");
    const camLdLane = page.getByTestId(
      new RegExp(`^lane-row-${state.camAirfoil.slug}-\\d+-ld_max$`),
    );
    await expect(camLdLane).toBeVisible();
    await expect(camLdLane).toContainText("max L/D");
    await expect(camLdLane).toContainText("awaiting seed sweep");
  });
});
