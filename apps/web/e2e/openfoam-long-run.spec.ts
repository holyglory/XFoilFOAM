import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const apiURL = process.env.PLAYWRIGHT_API_URL ?? "http://127.0.0.1:4000";
const requestedCpu = Number(process.env.OPENFOAM_REQUESTED_CPU_BUDGET ?? "30");
const detectedCpu =
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
const effectiveCpu = Math.min(
  requestedCpu,
  Number(process.env.OPENFOAM_LOCAL_CPU_CAP ?? String(detectedCpu)),
);
const monitorIntervalMs = Number(
  process.env.OPENFOAM_MONITOR_INTERVAL_MS ?? "600000",
);
const smokeTimeoutMs = Number(
  process.env.OPENFOAM_SMOKE_TIMEOUT_MS ?? String(12 * 60 * 60 * 1000),
);
const allTimeoutMs = Number(
  process.env.OPENFOAM_ALL_TIMEOUT_MS ?? String(7 * 24 * 60 * 60 * 1000),
);

interface MediumRow {
  id: string;
  slug: string;
  name: string;
}

interface SetupRecord {
  id: string;
  slug: string;
  name: string;
}

interface SimulationPresetRow extends SetupRecord {
  targetScope: "all" | "airfoils";
  targetAirfoilIds: string[];
  enabled: boolean;
}

interface AirfoilOption {
  id: string;
  slug: string;
  name: string;
}

interface SimulationSetup {
  flowConditions: SetupRecord[];
  referenceGeometryProfiles: SetupRecord[];
  boundaryProfiles: SetupRecord[];
  meshProfiles: SetupRecord[];
  solverProfiles: SetupRecord[];
  schedulingProfiles: SetupRecord[];
  outputProfiles: SetupRecord[];
  sweepDefinitions: SetupRecord[];
  airfoilOptions: AirfoilOption[];
  simulationPresets: SimulationPresetRow[];
}

interface PendingSweep {
  airfoilId: string;
  airfoilSlug: string;
  airfoilName: string;
  reynolds: number;
  aoaCount: number;
  aoaMin: number;
  aoaMax: number;
}

interface QueueJob {
  id: string;
  airfoilSlug: string | null;
  status: string;
  stale: boolean;
}

interface AdminQueue {
  sweeper: { enabled: boolean; maxConcurrentJobs: number };
  pendingSweepsTotal: number;
  pendingPointsTotal: number;
  inFlight: number;
  results: Record<string, number>;
  engineQueue: {
    queue_depth?: number;
    active_count?: number;
    reserved_count?: number;
  } | null;
  engineQueueError: string | null;
  pendingSweeps: PendingSweep[];
  activeJobs: QueueJob[];
  finishedJobs: QueueJob[];
}

interface DetailPayload {
  name: string;
  polars: Array<{ re: number; points: Array<{ resultId?: string | null }> }>;
}

const LONG_RUN_NAME = "OpenFOAM long run · air 20C 30 mps chord 1m AoA -15..20";
const LONG_RUN_SLUG = "openfoam-long-air-20c-30mps-chord1m-aoa-minus15-20";

test.describe.serial("long OpenFOAM sweep verification", () => {
  test.skip(
    process.env.RUN_OPENFOAM_LONG !== "1",
    "Set RUN_OPENFOAM_LONG=1 to launch real OpenFOAM sweeps.",
  );
  test.setTimeout(0);

  let artifactDir = "";

  test.beforeAll(async () => {
    artifactDir = path.resolve(
      process.cwd(),
      ".codex-artifacts",
      "openfoam-long-run",
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
    await fs.mkdir(artifactDir, { recursive: true });
  });

  test("NACA0012 selected-profile smoke sweep", async ({ page, request }) => {
    await preflight(request);
    await assertNoSyntheticAirfoils(request);
    await patchSweeper(request, {
      enabled: false,
      maxConcurrentJobs: effectiveCpu,
    });

    const setup = await ensureLongRunSetup(request);
    await disableOtherPresets(request, setup.preset.id);
    await patchPreset(request, setup.preset.id, {
      targetScope: "airfoils",
      targetAirfoilIds: [setup.naca0012.id],
      enabled: true,
    });

    await verifyPresetScopeInUi(page, LONG_RUN_NAME, "airfoils", "1 selected");
    await capture(page, "naca-scope-ready");

    const pausedQueue = await getQueue(request);
    if (pausedQueue.pendingSweepsTotal > 0) {
      expect(pausedQueue.pendingSweepsTotal).toBe(1);
      const nacaPending = pausedQueue.pendingSweeps.find(
        (row) => row.airfoilSlug === "naca-0012",
      );
      expect(nacaPending?.aoaCount).toBe(36);
      expect(nacaPending?.aoaMin).toBe(-15);
      expect(nacaPending?.aoaMax).toBe(20);
    }

    await openQueue(page);
    await patchSweeper(request, { maxConcurrentJobs: effectiveCpu });
    await resumeSweeper(page, request);
    await capture(page, "naca-sweeper-resumed");

    await monitorQueue(page, request, {
      label: "naca0012-smoke",
      timeoutMs: smokeTimeoutMs,
      done: (queue) =>
        !queue.pendingSweeps.some((row) => row.airfoilSlug === "naca-0012") &&
        !queue.activeJobs.some((job) => job.airfoilSlug === "naca-0012"),
    });

    const detail = await json<DetailPayload>(
      request,
      "get",
      "/api/airfoils/naca-0012",
    );
    const validPoints = detail.polars.reduce(
      (sum, polar) =>
        sum + polar.points.filter((point) => point.resultId).length,
      0,
    );
    expect(
      validPoints,
      "NACA0012 Detail should expose stored valid solver points after the smoke run",
    ).toBeGreaterThan(0);

    await page.goto("/airfoils/naca-0012");
    await expect(
      page.getByRole("heading", { name: /NACA 0012/i }),
    ).toBeVisible();
    await expect(page.getByText(/solved points?/i).first()).toBeVisible();
    await capture(page, "naca-detail-after-sweep");
  });

  test("same sweep over all real profiles", async ({ page, request }) => {
    test.skip(
      process.env.RUN_OPENFOAM_ALL !== "1",
      "Set RUN_OPENFOAM_ALL=1 after the NACA smoke passes to run every profile.",
    );

    await preflight(request);
    await assertNoSyntheticAirfoils(request);
    await patchSweeper(request, {
      enabled: false,
      maxConcurrentJobs: effectiveCpu,
    });

    const setup = await ensureLongRunSetup(request);
    await disableOtherPresets(request, setup.preset.id);
    await patchPreset(request, setup.preset.id, {
      targetScope: "all",
      targetAirfoilIds: [],
      enabled: true,
    });

    await verifyPresetScopeInUi(page, LONG_RUN_NAME, "all");
    await capture(page, "all-profiles-scope-ready");

    const pausedQueue = await getQueue(request);
    await appendProgress("all-profiles-initial", pausedQueue);

    await openQueue(page);
    await patchSweeper(request, { maxConcurrentJobs: effectiveCpu });
    await resumeSweeper(page, request);
    await capture(page, "all-profiles-sweeper-resumed");

    await monitorQueue(page, request, {
      label: "all-profiles",
      timeoutMs: allTimeoutMs,
      done: (queue) => {
        const engineQueued = queue.engineQueue?.queue_depth ?? 0;
        const engineActive = queue.engineQueue?.active_count ?? 0;
        const engineReserved = queue.engineQueue?.reserved_count ?? 0;
        const stale = queue.activeJobs.filter((job) => job.stale).length;
        return (
          queue.pendingSweepsTotal === 0 &&
          queue.activeJobs.length === 0 &&
          engineQueued === 0 &&
          engineActive === 0 &&
          engineReserved === 0 &&
          stale === 0
        );
      },
    });

    await capture(page, "all-profiles-complete");
  });

  async function ensureLongRunSetup(request: APIRequestContext) {
    const [mediums, initialSetup] = await Promise.all([
      json<{ items: MediumRow[] }>(request, "get", "/api/admin/mediums"),
      getSetup(request),
    ]);
    const air = mediums.items.find((medium) => medium.slug === "air");
    expect(
      air?.id,
      "Air medium must be seeded before launching OpenFOAM sweeps",
    ).toBeTruthy();
    const naca0012 = initialSetup.airfoilOptions.find(
      (airfoil) => airfoil.slug === "naca-0012",
    );
    expect(
      naca0012?.id,
      "NACA 0012 must be seeded from real geometry",
    ).toBeTruthy();

    const flow = await ensureRecord<SetupRecord>(
      request,
      "flowConditions",
      "/api/admin/flow-conditions",
      {
        slug: `${LONG_RUN_SLUG}-flow`,
        name: `${LONG_RUN_NAME} flow`,
        mediumId: air!.id,
        temperatureK: 293.15,
        pressurePa: 101325,
        speedMps: 30,
      },
    );
    const reference = await ensureRecord<SetupRecord>(
      request,
      "referenceGeometryProfiles",
      "/api/admin/reference-geometry-profiles",
      {
        slug: `${LONG_RUN_SLUG}-reference`,
        name: `${LONG_RUN_NAME} reference geometry`,
        geometryType: "airfoil_2d",
        referenceLengthKind: "chord",
        referenceLengthM: 1,
        spanM: null,
        referenceAreaM2: null,
      },
    );
    const boundary = await ensureRecord<SetupRecord>(
      request,
      "boundaryProfiles",
      "/api/admin/boundary-profiles",
      {
        slug: `${LONG_RUN_SLUG}-boundary`,
        name: `${LONG_RUN_NAME} boundary`,
        turbulenceIntensity: 0.001,
        viscosityRatio: 10,
        sandGrainHeight: 0,
        roughnessConstant: 0.5,
      },
    );
    const mesh = await ensureRecord<SetupRecord>(
      request,
      "meshProfiles",
      "/api/admin/mesh-profiles",
      {
        slug: `${LONG_RUN_SLUG}-mesh`,
        name: `${LONG_RUN_NAME} mesh`,
        mesher: "blockmesh-cgrid",
        farfieldRadiusChords: 15,
        wakeLengthChords: 12,
        nSurface: 130,
        nRadial: 80,
        nWake: 60,
        targetYPlus: 1,
        spanChords: 0.1,
      },
    );
    const solver = await ensureRecord<SetupRecord>(
      request,
      "solverProfiles",
      "/api/admin/solver-profiles",
      {
        slug: `${LONG_RUN_SLUG}-solver`,
        name: `${LONG_RUN_NAME} solver`,
        turbulenceModel: "kOmegaSST",
        nIterations: 3000,
        convergenceTolerance: 1e-5,
        momentumScheme: "linearUpwind",
        transientCycles: 10,
        transientDiscardFraction: 0.4,
        transientMaxCourant: 15,
      },
    );
    const scheduling = await ensureRecord<SetupRecord>(
      request,
      "schedulingProfiles",
      "/api/admin/scheduling-profiles",
      {
        slug: `${LONG_RUN_SLUG}-scheduling`,
        name: `${LONG_RUN_NAME} scheduling`,
        schedulingPolicy: "auto",
        cpuBudget: null,
        caseConcurrency: null,
        solverProcesses: 1,
      },
    );
    const output = await ensureRecord<SetupRecord>(
      request,
      "outputProfiles",
      "/api/admin/output-profiles",
      {
        slug: `${LONG_RUN_SLUG}-output`,
        name: `${LONG_RUN_NAME} output`,
        writeImages: ["velocity_magnitude", "pressure"],
        imageZoomChords: 2,
      },
    );
    const sweep = await ensureRecord<SetupRecord>(
      request,
      "sweepDefinitions",
      "/api/admin/sweep-definitions",
      {
        slug: `${LONG_RUN_SLUG}-sweep`,
        name: `${LONG_RUN_NAME} sweep`,
        aoaStart: -15,
        aoaStop: 20,
        aoaStep: 1,
        aoaList: null,
      },
    );

    const setup = await getSetup(request);
    const presetBody = {
      slug: LONG_RUN_SLUG,
      name: LONG_RUN_NAME,
      flowConditionId: flow.id,
      referenceGeometryProfileId: reference.id,
      boundaryProfileId: boundary.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      schedulingProfileId: scheduling.id,
      outputProfileId: output.id,
      sweepDefinitionId: sweep.id,
      targetScope: "airfoils",
      targetAirfoilIds: [naca0012!.id],
      enabled: false,
    };
    const existing = setup.simulationPresets.find(
      (row) => row.slug === LONG_RUN_SLUG,
    );
    const preset = existing
      ? await patchPreset(request, existing.id, withoutSlug(presetBody))
      : await json<SimulationPresetRow>(
          request,
          "post",
          "/api/admin/simulation-presets",
          presetBody,
        );

    await fs.writeFile(
      path.join(artifactDir, "setup.json"),
      JSON.stringify(
        {
          requestedCpu,
          detectedCpu,
          effectiveCpu,
          preset,
          naca0012,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    return { preset, naca0012: naca0012! };
  }

  async function ensureRecord<T extends SetupRecord>(
    request: APIRequestContext,
    collection: keyof Pick<
      SimulationSetup,
      | "flowConditions"
      | "referenceGeometryProfiles"
      | "boundaryProfiles"
      | "meshProfiles"
      | "solverProfiles"
      | "schedulingProfiles"
      | "outputProfiles"
      | "sweepDefinitions"
    >,
    endpoint: string,
    body: Record<string, unknown> & { slug: string; name: string },
  ): Promise<T> {
    const setup = await getSetup(request);
    const existing = (setup[collection] as SetupRecord[]).find(
      (row) => row.slug === body.slug,
    );
    if (existing) {
      return json<T>(
        request,
        "patch",
        `${endpoint}/${existing.id}`,
        withoutSlug(body),
      );
    }
    return json<T>(request, "post", endpoint, body);
  }

  async function disableOtherPresets(
    request: APIRequestContext,
    keepPresetId: string,
  ) {
    const setup = await getSetup(request);
    await Promise.all(
      setup.simulationPresets
        .filter((preset) => preset.id !== keepPresetId && preset.enabled)
        .map((preset) => patchPreset(request, preset.id, { enabled: false })),
    );
  }

  async function verifyPresetScopeInUi(
    page: Page,
    presetName: string,
    expectedScope: "all" | "airfoils",
    expectedSelection?: string,
  ) {
    await page.goto("/admin");
    await page.getByRole("button", { name: /Simulation setup/i }).click();
    await page.getByRole("button", { name: /^Presets$/i }).click();
    await page
      .getByRole("button", { name: new RegExp(escapeRegExp(presetName)) })
      .click();
    await expect(wrappedSelect(page, "Run scope")).toHaveValue(expectedScope);
    if (expectedScope === "airfoils") {
      await expect(
        page.getByTestId("preset-airfoil-selected-count"),
      ).toContainText(expectedSelection ?? "1 selected");
      await page.getByTestId("preset-airfoil-search").fill("NACA 0012");
      await expect(
        page.getByTestId("preset-airfoil-option-naca-0012"),
      ).toBeVisible();
    }
  }

  async function openQueue(page: Page) {
    await page.goto("/admin");
    await page.getByRole("button", { name: /^Solver$/i }).click();
    await expect(page.getByTestId("openfoam-queue-page")).toBeVisible();
  }

  async function resumeSweeper(page: Page, request: APIRequestContext) {
    await page.reload();
    const resume = page.getByRole("button", { name: /Resume/i });
    if ((await resume.count()) > 0) await resume.first().click();
    let queue = await getQueue(request);
    if (!queue.sweeper.enabled) {
      await patchSweeper(request, { enabled: true });
    }
    await expect
      .poll(async () => (await getQueue(request)).sweeper.enabled, {
        timeout: 20_000,
      })
      .toBe(true);
    await page.reload();
    // Solver redesign: the old "sweeper running" header chip became the
    // Activity banner state label (deriveSolverState). RUNNING or IDLE both
    // mean the process is alive and enabled.
    await expect(page.getByTestId("sweeper-process-state")).toHaveText(
      /^(RUNNING|IDLE)$/,
      { timeout: 20_000 },
    );
  }

  async function monitorQueue(
    page: Page,
    request: APIRequestContext,
    opts: {
      label: string;
      timeoutMs: number;
      done: (queue: AdminQueue) => boolean;
    },
  ) {
    const startedAt = Date.now();
    let recoveredStale = false;
    for (let iteration = 0; ; iteration++) {
      await openQueue(page);
      const queue = await getQueue(request);
      await appendProgress(`${opts.label}-${iteration}`, queue);
      await capture(
        page,
        `${opts.label}-${String(iteration).padStart(4, "0")}`,
      );

      if (opts.done(queue)) return queue;
      if (queue.engineQueueError)
        throw new Error(`Engine queue unavailable: ${queue.engineQueueError}`);

      const staleCount = queue.activeJobs.filter((job) => job.stale).length;
      if (staleCount > 0) {
        if (recoveredStale) {
          await patchSweeper(request, { enabled: false });
          throw new Error(
            `Stale jobs recurred after recovery during ${opts.label}.`,
          );
        }
        recoveredStale = true;
        const recover = page.getByRole("button", { name: /recover stale/i });
        if ((await recover.count()) > 0) await recover.first().click();
        else
          await json(request, "post", "/api/admin/jobs/recover-stale", {
            olderThanMinutes: 30,
          });
      }

      if (Date.now() - startedAt > opts.timeoutMs) {
        await patchSweeper(request, { enabled: false });
        throw new Error(
          `${opts.label} did not finish within ${opts.timeoutMs}ms.`,
        );
      }
      await page.waitForTimeout(monitorIntervalMs);
    }
  }

  async function preflight(request: APIRequestContext) {
    const health = await request.get(`${apiURL}/health`);
    expect(
      health.ok(),
      `API health should be OK, got ${health.status()}`,
    ).toBeTruthy();
    const queue = await getQueue(request);
    expect(
      queue.engineQueueError,
      "OpenFOAM engine queue should be visible before launching a long run",
    ).toBeNull();
  }

  async function assertNoSyntheticAirfoils(request: APIRequestContext) {
    const catalog = await json<{
      items: Array<{ slug: string; name: string }>;
    }>(request, "get", "/api/airfoils?limit=10000");
    const synthetic = catalog.items.filter(
      (airfoil) =>
        airfoil.slug.startsWith("pw-") || airfoil.name.startsWith("pw-"),
    );
    expect(
      synthetic,
      "Long OpenFOAM runs must not include Playwright synthetic airfoils",
    ).toEqual([]);
  }

  async function getSetup(
    request: APIRequestContext,
  ): Promise<SimulationSetup> {
    return json<SimulationSetup>(request, "get", "/api/admin/simulation-setup");
  }

  async function getQueue(request: APIRequestContext): Promise<AdminQueue> {
    return json<AdminQueue>(request, "get", "/api/admin/queue");
  }

  async function patchSweeper(
    request: APIRequestContext,
    body: Record<string, unknown>,
  ) {
    return json(request, "patch", "/api/admin/sweeper", body);
  }

  async function patchPreset(
    request: APIRequestContext,
    id: string,
    body: Record<string, unknown>,
  ): Promise<SimulationPresetRow> {
    return json<SimulationPresetRow>(
      request,
      "patch",
      `/api/admin/simulation-presets/${id}`,
      body,
    );
  }

  async function appendProgress(labelText: string, queue: AdminQueue) {
    const entry = {
      at: new Date().toISOString(),
      label: labelText,
      pendingSweepsTotal: queue.pendingSweepsTotal,
      pendingPointsTotal: queue.pendingPointsTotal,
      activeJobs: queue.activeJobs.length,
      staleJobs: queue.activeJobs.filter((job) => job.stale).length,
      celeryQueued: queue.engineQueue?.queue_depth ?? null,
      celeryActive: queue.engineQueue?.active_count ?? null,
      celeryReserved: queue.engineQueue?.reserved_count ?? null,
      failedRows: queue.results.failed ?? 0,
      solvedRows: queue.results.solved ?? 0,
      latestFinished: queue.finishedJobs
        .slice(0, 5)
        .map((job) => ({
          id: job.id,
          airfoilSlug: job.airfoilSlug,
          status: job.status,
        })),
    };
    await fs.appendFile(
      path.join(artifactDir, "progress.jsonl"),
      JSON.stringify(entry) + "\n",
    );
    console.log(
      `[openfoam-long] ${entry.label} pending=${entry.pendingSweepsTotal} points=${entry.pendingPointsTotal} active=${entry.activeJobs} celery=${entry.celeryQueued}/${entry.celeryActive}/${entry.celeryReserved} stale=${entry.staleJobs} failed=${entry.failedRows} solved=${entry.solvedRows}`,
    );
  }

  async function capture(page: Page, name: string) {
    await page.screenshot({
      path: path.join(artifactDir, `${name}.png`),
      fullPage: true,
    });
  }
});

async function json<T>(
  request: APIRequestContext,
  method: "get" | "post" | "patch",
  urlPath: string,
  data?: unknown,
): Promise<T> {
  const res = await request[method](
    `${apiURL}${urlPath}`,
    data === undefined ? undefined : { data },
  );
  if (!res.ok()) {
    expect(
      false,
      `${method.toUpperCase()} ${urlPath} -> ${res.status()} ${await res.text().catch(() => "")}`,
    ).toBeTruthy();
  }
  return (await res.json()) as T;
}

function withoutSlug<T extends { slug?: unknown }>(body: T): Omit<T, "slug"> {
  const { slug: _slug, ...rest } = body;
  return rest;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wrappedSelect(page: Page, label: string) {
  return page
    .locator("label")
    .filter({ hasText: label })
    .locator("select")
    .first();
}
