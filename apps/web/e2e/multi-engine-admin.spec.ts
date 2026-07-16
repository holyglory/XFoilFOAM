import { expect, test, type Page } from "@playwright/test";

import type {
  AdminQueue,
  AdminSimulationSetup,
  AdminSolverExecutionPool,
} from "../lib/admin";

const OPENCFD_ID = "2f8bc764-09ae-4ff3-8fd2-260600000001";
const FOUNDATION_ID = "2f8bc764-09ae-4ff3-8fd2-001400000001";
const OPENCFD_POOL_ID = "3f8bc764-09ae-4ff3-8fd2-260600000001";
const FOUNDATION_POOL_ID = "3f8bc764-09ae-4ff3-8fd2-001400000001";

function implementation(
  id: string,
  distribution: "opencfd" | "foundation",
  releaseVersion: string,
) {
  return {
    id,
    key: `openfoam:${distribution}:${releaseVersion}:adapter-v1:numerics-v1`,
    family: "openfoam",
    distribution,
    releaseVersion,
    methodFamily: "finite_volume_rans_urans",
    adapterContractVersion: 1,
    numericsRevision: "1",
    capabilities: {
      methodKeys: ["openfoam.rans", "openfoam.urans"],
    },
    upstreamUrl: null,
    licenseSpdx: "GPL-3.0-or-later",
    retiredAt: null,
    createdAt: "2026-07-15T00:00:00.000Z",
  };
}

const openCfd = implementation(OPENCFD_ID, "opencfd", "2606");
const foundation = implementation(FOUNDATION_ID, "foundation", "14");

function pool(
  id: string,
  solverImplementationId: string,
  name: string,
  routingKey: string,
  enabled: boolean,
): AdminSolverExecutionPool {
  return {
    id,
    slug: routingKey,
    name,
    solverImplementationId,
    routingKey,
    capacityKind: "cpu_slots",
    capacityLimit: null,
    enabled,
    metadata: {},
    implementation:
      solverImplementationId === OPENCFD_ID ? openCfd : foundation,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function setup(foundationEnabled: boolean): AdminSimulationSetup {
  return {
    flowConditions: [],
    referenceGeometryProfiles: [],
    boundaryProfiles: [],
    meshProfiles: [],
    solverImplementations: [openCfd, foundation],
    solverExecutionPools: [
      pool(
        OPENCFD_POOL_ID,
        OPENCFD_ID,
        "OpenFOAM OpenCFD 2606",
        "openfoam-opencfd-2606",
        true,
      ),
      pool(
        FOUNDATION_POOL_ID,
        FOUNDATION_ID,
        "OpenFOAM Foundation 14",
        "openfoam-foundation-14",
        foundationEnabled,
      ),
    ],
    solverProfiles: [
      {
        id: "4f8bc764-09ae-4ff3-8fd2-260600000001",
        solverImplementationId: OPENCFD_ID,
        implementation: openCfd,
        slug: "opencfd-default",
        name: "OpenCFD default",
        turbulenceModel: "kOmegaSST",
        nIterations: 3000,
        convergenceTolerance: 1e-5,
        momentumScheme: "linearUpwind",
        transientCycles: 10,
        transientDiscardFraction: 0.4,
        transientMaxCourant: 1,
        isSeeded: true,
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
      {
        id: "4f8bc764-09ae-4ff3-8fd2-001400000001",
        solverImplementationId: FOUNDATION_ID,
        implementation: foundation,
        slug: "foundation-default",
        name: "Foundation default",
        turbulenceModel: "kOmegaSST",
        nIterations: 3000,
        convergenceTolerance: 1e-5,
        momentumScheme: "linearUpwind",
        transientCycles: 10,
        transientDiscardFraction: 0.4,
        transientMaxCourant: 1,
        isSeeded: false,
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    ],
    schedulingProfiles: [],
    outputProfiles: [],
    sweepDefinitions: [],
    airfoilOptions: [],
    simulationPresets: [],
  };
}

function queue(): AdminQueue {
  return {
    scope: "engine",
    mode: "dev",
    engineUrl: "http://solver-gateway:8000",
    sweeper: {
      enabled: true,
      maxConcurrentJobs: 4,
      cpuSlots: 8,
      pollIntervalMs: 10_000,
      submitIntervalMs: 1_000,
      heartbeatAt: new Date().toISOString(),
      engineUnreachableSince: null,
      lastTickStartedAt: new Date().toISOString(),
      lastTickCompletedAt: new Date().toISOString(),
    },
    cpuSlotsAuto: false,
    engineUnreachableSince: null,
    backlogStrip: null,
    backlog: null,
    inFlight: 0,
    results: null,
    solvedToday: null,
    pendingPointsTotal: null,
    pendingSweepsTotal: null,
    pendingSweeps: null,
    externalPromises: null,
    engineQueue: {
      queue_depth: 0,
      active: [],
      reserved: [],
      scheduled: [],
      active_count: 0,
      reserved_count: 0,
      scheduled_count: 0,
      job_ids: [],
      duplicates: {},
      redelivered: [],
    },
    engineQueueError: null,
    engineHealth: { status: "ok", version: "0.1.0", build_id: "test-build" },
    engineHealthError: null,
    engineExpectedBuildId: "test-build",
    engineBuildId: "test-build",
    engineBuildMismatch: false,
    engineCache: {
      meshEntries: 0,
      seedEntries: 0,
      totalBytes: 0,
      capBytes: 1024,
      oldestLastUsedAt: null,
    },
    engineRuntimeAsOf: new Date().toISOString(),
    engineRuntimeError: null,
    activeJobs: [],
    finishedJobs: null,
    jobs: null,
  };
}

async function mockAdmin(page: Page) {
  let foundationEnabled = false;
  let foundationPatchCount = 0;

  await page.route("**/api/admin/me", (route) =>
    route.fulfill({
      json: {
        authed: true,
        mode: "dev",
        email: "admin@example.test",
        provider: "password",
        providers: { google: false, password: true },
      },
    }),
  );
  await page.route("**/api/admin/mediums*", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/api/admin/queue*", (route) =>
    route.fulfill({ json: queue() }),
  );
  await page.route("**/api/admin/simulation-setup", (route) =>
    route.fulfill({ json: setup(foundationEnabled) }),
  );
  await page.route(
    `**/api/admin/solver-execution-pools/${FOUNDATION_POOL_ID}`,
    async (route) => {
      expect(route.request().method()).toBe("PATCH");
      expect(route.request().postDataJSON()).toEqual({ enabled: true });
      foundationEnabled = true;
      foundationPatchCount += 1;
      await route.fulfill({
        json: pool(
          FOUNDATION_POOL_ID,
          FOUNDATION_ID,
          "OpenFOAM Foundation 14",
          "openfoam-foundation-14",
          true,
        ),
      });
    },
  );
  return { foundationPatchCount: () => foundationPatchCount };
}

test.describe("multi-engine admin controls", () => {
  test("solver profiles require an explicit engine family and release", async ({
    page,
  }) => {
    await mockAdmin(page);
    await page.goto("/admin?section=setup&tab=solver");

    await expect(
      page.getByText("SOLVER PROFILES", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/OpenFOAM · Foundation 14/).first(),
    ).toBeVisible();

    await page.getByRole("button", { name: "New" }).first().click();
    const engine = page.getByLabel("Engine implementation", { exact: true });
    await expect(engine).toHaveValue(OPENCFD_ID);
    await engine.selectOption(FOUNDATION_ID);
    await expect(engine).toHaveValue(FOUNDATION_ID);
    await expect(engine.locator(`option[value="${FOUNDATION_ID}"]`)).toHaveText(
      "OpenFOAM · Foundation 14",
    );
  });

  test("Foundation pool activation updates only after the operator action", async ({
    page,
  }) => {
    const mocked = await mockAdmin(page);
    await page.goto("/admin?section=queue&tab=engine");

    const foundationRow = page.getByTestId(
      "solver-implementation-foundation-14",
    );
    await expect(foundationRow).toContainText("disabled");
    await foundationRow
      .getByRole("button", {
        name: "Enable OpenFOAM · Foundation 14 execution pool",
      })
      .click();

    await expect(foundationRow).toContainText("enabled");
    expect(mocked.foundationPatchCount()).toBe(1);
  });
});
