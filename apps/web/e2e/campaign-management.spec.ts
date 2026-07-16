// Simulation Campaigns e2e (spec docs/simulation-campaigns-spec.md §11/§13):
// wizard launch end-to-end, edit-conditions dialog mechanics, URL routing
// (hub ↔ campaign ↔ wizard, not-found, dirty guard), and the refinement
// board. Every record carries the pw- stamp and afterAll purges through
// POST /api/admin/test-artifacts/purge (which these tests also verify leaves
// zero campaign residue). The sweeper must be disabled for the whole run —
// nothing here may solve; the spec asserts sweeper state is untouched.
import { expect, test, type APIRequestContext } from "@playwright/test";

const apiURL = process.env.PLAYWRIGHT_API_URL ?? "http://127.0.0.1:4000";

const state = {
  stamp: "",
  categorySlug: "",
  symAirfoil: { id: "", slug: "" },
  camAirfoil: { id: "", slug: "" },
  mediumId: "",
  numerics: { boundaryProfileId: "", meshProfileId: "", solverProfileId: "", outputProfileId: "" },
  sweeperBefore: null as null | { enabled: boolean; cpuSlots: number; maxConcurrentJobs: number },
  wizardCampaignId: "",
  wizardCampaignSlug: "",
};

async function json<T>(request: APIRequestContext, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const res = await request[method](`${apiURL}${path}`, { data });
  expect(res.ok(), `${method.toUpperCase()} ${path} -> ${res.status()} ${await res.text().catch(() => "")}`).toBeTruthy();
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

async function launchCampaign(request: APIRequestContext, name: string, plan: Record<string, unknown>) {
  return json<{ campaign: { id: string; slug: string; status: string }; totals: { requested: number } }>(
    request,
    "post",
    "/api/admin/campaigns",
    {
      name,
      priority: 5,
      idempotencyKey: `${name}-key`,
      airfoilIds: [state.symAirfoil.id, state.camAirfoil.id],
      plan,
    },
  );
}

async function getSummary(request: APIRequestContext, id: string) {
  return json<{
    campaign: { slug: string; status: string; planRevisionNumber: number; plan: { speedsMps: string[] } };
    totals: { requested: number; remaining: number };
    conditions: Array<{ status: string; reynolds: number; counters: { requested: number } }>;
    lanesSummary: Record<string, Record<string, number>>;
  }>(request, "get", `/api/admin/campaigns/${id}`);
}

test.describe.serial("simulation campaigns: wizard, plan edits, routing, refinement board", () => {
  test.beforeAll(async ({ request }) => {
    // HARD GUARD: campaigns must not solve during this spec. The suite never
    // touches sweeper state; it only verifies the precondition.
    state.sweeperBefore = await json(request, "get", "/api/sweeper");
    expect(state.sweeperBefore?.enabled, "sweeper must be disabled before running campaign e2e (nothing may solve)").toBe(false);

    state.stamp = `pw-cm-${Date.now().toString(36)}`;
    const cat = await json<{ slug: string }>(request, "post", "/api/admin/categories", { name: `${state.stamp} cat`, parentId: null });
    state.categorySlug = cat.slug;
    const sym = await json<{ id: string; slug: string }>(request, "post", "/api/airfoils", {
      name: `${state.stamp} sym 0012`,
      categorySlug: cat.slug,
      naca: { t: 0.12, m: 0, p: 0 },
    });
    const cam = await json<{ id: string; slug: string }>(request, "post", "/api/airfoils", {
      name: `${state.stamp} cam 4415`,
      categorySlug: cat.slug,
      naca: { t: 0.15, m: 0.04, p: 0.4 },
    });
    state.symAirfoil = { id: sym.id, slug: sym.slug };
    state.camAirfoil = { id: cam.id, slug: cam.slug };

    const medium = await json<{ id: string }>(request, "post", "/api/admin/mediums", {
      name: `${state.stamp} air`,
      phase: "gas",
      density: 1.225,
      refTemperatureK: 288.15,
      refPressurePa: 101325,
      viscosityModel: "constant",
      constantDynamicViscosity: 1.789e-5,
      speedOfSound: 340.3,
    });
    state.mediumId = medium.id;

    const [boundary, mesh, solver, output] = await Promise.all([
      json<{ id: string }>(request, "post", "/api/admin/boundary-profiles", { name: `${state.stamp} boundary` }),
      json<{ id: string }>(request, "post", "/api/admin/mesh-profiles", { name: `${state.stamp} mesh` }),
      json<{ id: string }>(request, "post", "/api/admin/solver-profiles", { name: `${state.stamp} solver` }),
      json<{ id: string }>(request, "post", "/api/admin/output-profiles", { name: `${state.stamp} output` }),
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
      await json(request, "post", "/api/admin/test-artifacts/purge", { prefix: state.stamp });
      // The purge itself is part of the contract: zero campaign residue.
      const list = await json<{ items: Array<{ name: string }> }>(request, "get", "/api/admin/campaigns?limit=100");
      expect(list.items.filter((c) => c.name.startsWith(state.stamp))).toHaveLength(0);
    }
    // Sweeper state must be exactly as we found it (never touched).
    const after = await json<{ enabled: boolean; cpuSlots: number; maxConcurrentJobs: number }>(request, "get", "/api/sweeper");
    expect(after.enabled).toBe(state.sweeperBefore?.enabled);
    expect(after.cpuSlots).toBe(state.sweeperBefore?.cpuSlots);
    expect(after.maxConcurrentJobs).toBe(state.sweeperBefore?.maxConcurrentJobs);
  });

  test("wizard launches a polar sweep end-to-end with real derived physics", async ({ page, request }) => {
    await page.goto("/admin");
    await expect(page.getByTestId("campaigns-hub")).toBeVisible();
    await page.getByTestId("new-polar-sweep").click();
    await expect(page.getByTestId("campaign-wizard")).toBeVisible();
    await expect(page).toHaveURL(/wizard=polar_sweep/);

    // ---- step 1: manual scope, both pw- airfoils, resolved count ----
    await page.getByTestId("scope-mode-manual").click();
    await page.getByTestId("campaign-airfoil-search").fill(state.stamp);
    await page.getByTestId(`campaign-airfoil-option-${state.symAirfoil.slug}`).click();
    await page.getByTestId(`campaign-airfoil-option-${state.camAirfoil.slug}`).click();
    await expect(page.getByTestId("campaign-airfoil-selected-count")).toContainText("2 selected");
    await expect(page.getByTestId("scope-resolved-count")).toContainText("2 airfoils resolved · 1 symmetric");
    await page.getByTestId("wizard-continue").click();

    // ---- step 2: define flow in place ----
    await expect(page.getByTestId("wizard-conditions")).toBeVisible();
    await page.getByLabel("Medium", { exact: true }).selectOption(state.mediumId);
    // Ambient editor opens by default with the standard (T, P) prefilled —
    // adding it materializes the ambient chip.
    await page.getByTestId("wizard-ambients-add").click();
    await expect(page.getByTestId("wizard-ambients-chip-288.15-101325")).toBeVisible();
    // One speed via the single field, then ONE extra value → 2 speeds.
    await page.getByLabel("Speed", { exact: true }).fill("10");
    await page.getByTestId("wizard-speeds-add-value").click();
    await expect(page.getByTestId("wizard-speeds-chip-10.000")).toBeVisible();
    await page.getByTestId("wizard-speeds-add-input").fill("20");
    await page.getByTestId("wizard-speeds-add-confirm").click();
    await expect(page.getByTestId("wizard-speeds-chip-20.000")).toBeVisible();
    await page.getByLabel("Chord", { exact: true }).fill("0.2");

    // Condition preview: 2 real conditions with derived Re (V·c/ν) and Mach.
    await expect(page.getByText("CONDITION PREVIEW · 2 conditions")).toBeVisible();
    await expect(page.getByTestId("condition-line-0")).toContainText("Re 137k");
    await expect(page.getByTestId("condition-line-0")).toContainText("M 0.029");
    await expect(page.getByTestId("condition-line-1")).toContainText("Re 274k");
    await expect(page.getByTestId("condition-preview-footer")).toContainText("Re 137k – 274k");
    await page.getByTestId("wizard-continue").click();

    // ---- step 3: small base sweep, BOTH objectives off ----
    await expect(page.getByTestId("wizard-angle-plan")).toBeVisible();
    await page.getByLabel("AoA from °", { exact: true }).fill("-2");
    await page.getByLabel("AoA to °", { exact: true }).fill("2");
    await page.getByLabel("AoA step °", { exact: true }).fill("2");
    await expect(page.getByTestId("sweep-angle-count")).toContainText("3 angles");
    await expect(page.getByTestId("objective-toggle-ldMax")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("objective-toggle-clZero")).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("wizard-continue").click();

    // ---- step 4: review shows exact totals; symmetric solver-run savings ----
    await expect(page.getByTestId("wizard-review")).toBeVisible();
    await page.getByLabel("Campaign name", { exact: true }).fill(`${state.stamp} wizard sweep`);

    // Boundary slot: define a NEW pw- profile inline through the quick-create
    // modal (spec §11 — the wizard never dead-ends on the numerics library).
    const qcBoundaryName = `${state.stamp} qc boundary`;
    await page.getByTestId("numerics-chip-boundaryProfileId").click();
    await page.getByTestId("numerics-new-boundaryProfileId").click();
    const numericsModal = page.getByTestId("wizard-numerics-modal");
    await expect(numericsModal).toBeVisible();
    await numericsModal.getByLabel("Name", { exact: true }).fill(qcBoundaryName);
    await numericsModal.getByLabel("Turbulence intensity", { exact: true }).fill("0.002");
    await page.getByTestId("wizard-numerics-modal-save").click();
    await expect(numericsModal).toHaveCount(0);
    // Created row is selected in place: chip resolved, select shows it.
    await expect(page.getByTestId("numerics-chip-boundaryProfileId")).toContainText(qcBoundaryName);
    await expect(page.getByTestId("numerics-chip-boundaryProfileId")).not.toContainText("unresolved");
    await expect(page.getByLabel("Boundary profile", { exact: true }).locator("option:checked")).toHaveText(qcBoundaryName);

    const numericsSlots = [
      ["meshProfileId", "Mesh profile", state.numerics.meshProfileId],
      ["solverProfileId", "Solver profile", state.numerics.solverProfileId],
      ["outputProfileId", "Output profile", state.numerics.outputProfileId],
    ] as const;
    for (const [slot, label, id] of numericsSlots) {
      await page.getByTestId(`numerics-chip-${slot}`).click();
      await page.getByLabel(label, { exact: true }).selectOption(id);
      await expect(page.getByTestId(`numerics-chip-${slot}`)).toContainText(state.stamp);
    }
    const summaryTable = page.getByTestId("review-summary-table");
    // 2 airfoils × 2 conditions × 3 angles = 12 points; symmetric airfoil
    // solves α ≥ 0 only → 10 solver runs, 2 points derived by symmetry.
    await expect(summaryTable.locator("div").filter({ hasText: /^Points12$/ })).toBeVisible();
    await expect(summaryTable).toContainText("10 — 1 symmetric airfoils solve positive angles only; 2 points derived by symmetry");
    await expect(summaryTable.locator("div").filter({ hasText: /^Conditions2 · 1 ambient × 2 speeds × 1 chord$/ })).toBeVisible();

    await expect(page.getByTestId("review-launch")).toContainText("Launch — 10 solver runs");
    await page.getByTestId("review-launch").click();

    // ---- lands on the campaign page ----
    await expect(page.getByTestId("campaign-detail")).toBeVisible();
    await expect(page).toHaveURL(/campaign=[0-9a-f-]{36}/);
    state.wizardCampaignId = new URL(page.url()).searchParams.get("campaign")!;

    // ---- API truth: campaign exists, active, all 12 obligations materialized ----
    await expect
      .poll(async () => (await getSummary(request, state.wizardCampaignId)).campaign.status, { message: "campaign should be active" })
      .toBe("active");
    const summary = await getSummary(request, state.wizardCampaignId);
    state.wizardCampaignSlug = summary.campaign.slug;
    expect(summary.totals.requested).toBe(12);
    expect(summary.totals.remaining).toBe(12); // sweeper disabled — nothing solved
    expect(summary.campaign.planRevisionNumber).toBe(1);
    expect(summary.conditions).toHaveLength(2);
    expect(summary.conditions.map((c) => Math.round(c.reynolds / 1000)).sort((a, b) => a - b)).toEqual([137, 274]);

    // Server-side symmetry arithmetic on the SAME plan: 12 points but only 10
    // solver runs — the 2-point gap is the derived-by-symmetry obligation
    // (point-level derived_by_symmetry rows are asserted at the API test
    // layer in apps/api/test/purge.test.ts and campaigns.test.ts).
    const preview = await json<{ totalPoints: number; totalSolverRuns: number; status: string }>(
      request,
      "post",
      "/api/admin/campaigns/preview",
      {
        airfoilIds: [state.symAirfoil.id, state.camAirfoil.id],
        plan: planBody({ speedsMps: [10, 20] }),
      },
    );
    expect(preview.status).toBe("ok");
    expect(preview.totalPoints).toBe(12);
    expect(preview.totalSolverRuns).toBe(10);
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

  test("edit-conditions dialog previews and applies a real removal diff", async ({ page, request }) => {
    const launched = await launchCampaign(request, `${state.stamp} edit target`, planBody());
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
    await expect(page.getByTestId("plan-edit-banner")).toContainText("solved results are never deleted");

    // Remove the 20 m/s speed value → one whole condition goes away.
    await dialog.getByTestId("wizard-speeds-chip-20.000").getByRole("button", { name: /^Remove/ }).click();
    await expect(dialog.getByTestId("wizard-speeds-chip-20.000")).toHaveCount(0);
    await page.getByTestId("plan-edit-preview").click();

    // Acknowledge dialog: outcome sections with REAL counts. No evidence has
    // landed (sweeper off) → removal cancels pending, nothing kept.
    await expect(page.getByTestId("plan-ack-dialog")).toBeVisible();
    await expect(page.getByTestId("plan-ack-removing")).toContainText("1 condition released (no results anywhere)");
    await expect(page.getByTestId("plan-ack-removing")).toContainText("6 pending points cancelled");
    await expect(page.getByTestId("plan-ack-kept")).toContainText("nothing kept — no removed work has results yet");
    await expect(page.getByTestId("plan-ack-adding")).toContainText("nothing added");
    await expect(page.getByTestId("plan-ack-apply")).toContainText("Apply — add 0 points, cancel 6 pending");
    await page.getByTestId("plan-ack-apply").click();
    await expect(dialog).toHaveCount(0);

    // API truth: released obligations are gone; plan revision 2 recorded
    // (revision kind='edit' is asserted at the API layer — purge.test.ts —
    // since the summary API intentionally exposes only the revision number).
    await expect
      .poll(async () => (await getSummary(request, id)).campaign.planRevisionNumber, { message: "plan revision should advance" })
      .toBe(2);
    const summary = await getSummary(request, id);
    expect(summary.totals.requested).toBe(6);
    expect(summary.conditions.filter((c) => c.status === "active")).toHaveLength(1);
    expect(summary.campaign.plan.speedsMps).toEqual(["10.000"]);
  });

  test("routing: back to hub, unknown campaign, wizard dirty guard + draft survival", async ({ page }) => {
    // hub → campaign → browser Back returns to the hub with the Active segment
    await page.goto("/admin");
    await expect(page.getByTestId("campaigns-hub")).toBeVisible();
    await page.getByTestId(`campaign-open-${state.wizardCampaignSlug}`).click();
    await expect(page.getByTestId("campaign-detail")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("campaigns-hub")).toBeVisible();
    await expect(page.getByTestId("campaigns-segment-active")).toHaveAttribute("aria-pressed", "true");

    // unknown ?campaign= renders the not-found state with a working back link
    await page.goto("/admin?campaign=00000000-0000-4000-8000-000000000000");
    await expect(page.getByTestId("campaign-not-found")).toBeVisible();
    await expect(page.getByTestId("campaign-not-found")).toContainText("does not exist (or was purged)");
    await page.getByRole("button", { name: /back to campaigns/i }).click();
    await expect(page.getByTestId("campaigns-hub")).toBeVisible();

    // wizard dirty guard on nav-away; the draft survives in sessionStorage
    await page.getByTestId("new-polar-sweep").click();
    await expect(page.getByTestId("campaign-wizard")).toBeVisible();
    await page.getByTestId("scope-mode-manual").click();
    await page.getByTestId("campaign-airfoil-search").fill(state.stamp);
    await page.getByTestId(`campaign-airfoil-option-${state.symAirfoil.slug}`).click();
    await expect(page.getByTestId("campaign-airfoil-selected-count")).toContainText("1 selected");

    let confirmMessage = "";
    page.once("dialog", (dialog) => {
      confirmMessage = dialog.message();
      void dialog.accept();
    });
    await page.getByTestId("admin-nav-queue").click();
    await expect(page.getByTestId("openfoam-queue-page")).toBeVisible();
    expect(confirmMessage).toContain("Leave the campaign wizard?");

    const draft = await page.evaluate(() => {
      const latest = sessionStorage.getItem("aerodb.campaign-wizard.latest-draft-id");
      if (!latest) return null;
      return JSON.parse(sessionStorage.getItem(`aerodb.campaign-wizard.draft.${latest}`) ?? "null") as {
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
    await expect(page.getByTestId("campaign-airfoil-selected-count")).toContainText("1 selected");
  });

  test("refinement board renders lanes, states, and objective chips without solving", async ({ page, request }) => {
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
    await expect(page.getByTestId("lane-pill-awaiting_seed")).toContainText("awaiting seed sweep · 3");
    await expect(page.getByTestId("lane-pill-symmetric_definition")).toContainText("α₀ = 0° by definition · 1");

    // Lane rows carry the objective chips and truthful states.
    const symClZeroLane = page.getByTestId(new RegExp(`^lane-row-${state.symAirfoil.slug}-\\d+-cl_zero$`));
    await expect(symClZeroLane).toBeVisible();
    await expect(symClZeroLane).toContainText("α₀ (Cl = 0)");
    await expect(symClZeroLane).toContainText("α₀ = 0° by definition");
    const camLdLane = page.getByTestId(new RegExp(`^lane-row-${state.camAirfoil.slug}-\\d+-ld_max$`));
    await expect(camLdLane).toBeVisible();
    await expect(camLdLane).toContainText("max L/D");
    await expect(camLdLane).toContainText("awaiting seed sweep");
  });
});
