// Admin request-URANS endpoint (fidelity ladder contract 6): requireAdmin,
// validation, IDEMPOTENT creation per (cell, fidelity) — replay returns the
// open item with created=false — and the cell-scope GET the Points tab /
// campaign cell panel reads. Shared-database integration test: rows are
// pw- prefixed and deleted in afterAll (global test-hygiene rule).

import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  flowConditions,
  mediums,
  meshProfiles,
  outputProfiles,
  referenceGeometryProfiles,
  results,
  schedulingProfiles,
  simulationPresetRevisions,
  simulationPresets,
  simUransRequests,
  solverProfiles,
  sweepDefinitions,
} from "@aerodb/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const PREFIX = `pw-uransreq-${Date.now().toString(36)}`;
const ADMIN_EMAIL = "admin@airfoils.pro";
const ADMIN_PASSWORD = "urans-request-test-password";

let app: Awaited<ReturnType<typeof import("../src/server")["buildServer"]>>;
let db: typeof import("../src/db")["db"];
let adminCookie = "";
let categoryId = "";
let airfoilId = "";
let presetId = "";
let revisionId = "";
let mediumId = "";
let bcId = "";
const registryIds: { table: string; id: string }[] = [];

beforeAll(async () => {
  process.env.ADMIN_AUTH_REQUIRED = "true";
  process.env.ADMIN_AUTH_DISABLED = "false";
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.ADMIN_SESSION_SECRET = "urans-request-test-secret";
  delete process.env.ADMIN_GOOGLE_CLIENT_ID;
  delete process.env.ADMIN_GOOGLE_CLIENT_SECRET;

  const [{ buildServer }, dbModule] = await Promise.all([import("../src/server"), import("../src/db")]);
  db = dbModule.db;
  app = await buildServer();

  const login = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers["set-cookie"];
  adminCookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];

  const [category] = await db
    .insert(categories)
    .values({ slug: PREFIX, name: PREFIX, path: PREFIX, depth: 0 })
    .returning({ id: categories.id });
  categoryId = category.id;
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-af`,
      name: `${PREFIX} airfoil`,
      categoryId,
      points: [
        { x: 1, y: 0 },
        { x: 0.5, y: 0.06 },
        { x: 0, y: 0 },
        { x: 0.5, y: -0.06 },
        { x: 1, y: 0 },
      ],
    })
    .returning({ id: airfoils.id });
  airfoilId = airfoil.id;

  // Minimal preset graph so a real revision row exists to pin against.
  const [medium] = await db
    .insert(mediums)
    .values({
      slug: `${PREFIX}-air`,
      name: `${PREFIX} air`,
      phase: "gas",
      density: 1.225,
      viscosityModel: "constant",
      constantDynamicViscosity: 1.789e-5,
      dynamicViscosity: 1.789e-5,
      kinematicViscosity: 1.789e-5 / 1.225,
    })
    .returning({ id: mediums.id });
  mediumId = medium.id;
  registryIds.push({ table: "mediums", id: medium.id });
  // Legacy bc row so continuation source results rows can exist (results.bc_id
  // is NOT NULL).
  const [bc] = await db
    .insert(boundaryConditions)
    .values({ slug: `${PREFIX}-bc`, name: `${PREFIX} bc`, mediumId, reynolds: 300000 })
    .returning({ id: boundaryConditions.id });
  bcId = bc.id;
  const [flow] = await db
    .insert(flowConditions)
    .values({ slug: `${PREFIX}-flow`, name: `${PREFIX} flow`, mediumId: medium.id })
    .returning({ id: flowConditions.id });
  const [geo] = await db
    .insert(referenceGeometryProfiles)
    .values({ slug: `${PREFIX}-geo`, name: `${PREFIX} geo` })
    .returning({ id: referenceGeometryProfiles.id });
  const [boundary] = await db.insert(boundaryProfiles).values({ slug: `${PREFIX}-b`, name: `${PREFIX} b` }).returning({ id: boundaryProfiles.id });
  const [mesh] = await db.insert(meshProfiles).values({ slug: `${PREFIX}-m`, name: `${PREFIX} m` }).returning({ id: meshProfiles.id });
  const [solver] = await db.insert(solverProfiles).values({ slug: `${PREFIX}-s`, name: `${PREFIX} s` }).returning({ id: solverProfiles.id });
  const [sched] = await db.insert(schedulingProfiles).values({ slug: `${PREFIX}-sc`, name: `${PREFIX} sc` }).returning({ id: schedulingProfiles.id });
  const [output] = await db.insert(outputProfiles).values({ slug: `${PREFIX}-o`, name: `${PREFIX} o` }).returning({ id: outputProfiles.id });
  const [sweep] = await db.insert(sweepDefinitions).values({ slug: `${PREFIX}-sw`, name: `${PREFIX} sw` }).returning({ id: sweepDefinitions.id });
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${PREFIX}-preset`,
      name: `${PREFIX} preset`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: geo.id,
      boundaryProfileId: boundary.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      schedulingProfileId: sched.id,
      outputProfileId: output.id,
      sweepDefinitionId: sweep.id,
      enabled: false,
    })
    .returning({ id: simulationPresets.id });
  presetId = preset.id;
  const [revision] = await db
    .insert(simulationPresetRevisions)
    .values({
      presetId: preset.id,
      revisionNumber: 1,
      signatureHash: `${PREFIX}-sig`,
      reynolds: 300000,
      referenceLengthM: 1,
      snapshot: {},
    })
    .returning({ id: simulationPresetRevisions.id });
  revisionId = revision.id;
  registryIds.push(
    { table: "flow_conditions", id: flow.id },
    { table: "reference_geometry_profiles", id: geo.id },
    { table: "boundary_profiles", id: boundary.id },
    { table: "mesh_profiles", id: mesh.id },
    { table: "solver_profiles", id: solver.id },
    { table: "scheduling_profiles", id: sched.id },
    { table: "output_profiles", id: output.id },
    { table: "sweep_definitions", id: sweep.id },
  );
});

afterAll(async () => {
  if (db) {
    await db.delete(simUransRequests).where(eq(simUransRequests.revisionId, revisionId));
    // Continuation fixtures: results rows before the revision/bc they reference.
    await db.delete(results).where(eq(results.simulationPresetRevisionId, revisionId));
    if (bcId) await db.delete(boundaryConditions).where(eq(boundaryConditions.id, bcId));
    if (presetId) {
      await db.delete(simulationPresetRevisions).where(eq(simulationPresetRevisions.presetId, presetId));
      await db.delete(simulationPresets).where(eq(simulationPresets.id, presetId));
    }
    const byTable: Record<string, unknown> = {
      mediums,
      flow_conditions: flowConditions,
      reference_geometry_profiles: referenceGeometryProfiles,
      boundary_profiles: boundaryProfiles,
      mesh_profiles: meshProfiles,
      solver_profiles: solverProfiles,
      scheduling_profiles: schedulingProfiles,
      output_profiles: outputProfiles,
      sweep_definitions: sweepDefinitions,
    };
    // Delete in reverse FK order: preset gone, so registry rows are free;
    // medium last (flow references it).
    for (const entry of [...registryIds].reverse()) {
      const table = byTable[entry.table] as typeof mediums;
      await db.delete(table).where(eq(table.id, entry.id));
    }
    if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
    if (categoryId) await db.delete(categories).where(eq(categories.id, categoryId));
  }
  await app?.close();
  process.env = { ...ORIGINAL_ENV };
});

describe("POST /api/admin/urans-requests (contract 6)", () => {
  it("requires admin auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      payload: { airfoilId, revisionId, aoaDeg: 8, fidelity: "precalc" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("validates payload and 404s unknown airfoil/revision", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, fidelity: "ultra" },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId: "00000000-0000-4000-8000-000000000000", fidelity: "full" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("creates a work item, replays idempotently per (cell, fidelity), and lists it for the cell scope", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, aoaDeg: 8, fidelity: "precalc" },
    });
    expect(first.statusCode).toBe(201);
    const created = first.json() as { created: boolean; request: { id: string; state: string; requestedBy: string | null; aoaDeg: number } };
    expect(created.created).toBe(true);
    expect(created.request.state).toBe("pending");
    expect(created.request.aoaDeg).toBe(8);
    expect(created.request.requestedBy).toBe(ADMIN_EMAIL);

    const replay = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, aoaDeg: 8, fidelity: "precalc" },
    });
    expect(replay.statusCode).toBe(200);
    const replayed = replay.json() as { created: boolean; request: { id: string } };
    expect(replayed.created).toBe(false);
    expect(replayed.request.id).toBe(created.request.id);

    // Whole polar (aoaDeg absent) is a DIFFERENT idempotency cell.
    const wholePolar = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, fidelity: "precalc" },
    });
    expect(wholePolar.statusCode).toBe(201);
    expect((wholePolar.json() as { request: { aoaDeg: number | null } }).request.aoaDeg).toBeNull();

    const list = await app.inject({
      method: "GET",
      url: `/api/admin/urans-requests?airfoilId=${airfoilId}&revisionId=${revisionId}`,
      headers: { cookie: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { requests: { id: string }[]; verifyItems: unknown[] };
    expect(body.requests.length).toBe(2);
    expect(body.verifyItems).toEqual([]);

    // DB truth: exactly the two open rows, isolated to this test's revision.
    const rows = await db.select().from(simUransRequests).where(eq(simUransRequests.revisionId, revisionId));
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.state === "pending")).toBe(true);
  });
});

describe("POST /api/admin/urans-requests continuation mode (amendment C)", () => {
  it("derives cell + fidelity from the source row and persists continue_from_result_id + budget_override_s", async () => {
    const [source] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 9,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_full",
        unsteady: true,
        converged: true,
        cl: 0.9,
        cd: 0.07,
        engineJobId: `${PREFIX}-engine-src`,
        engineCaseSlug: "aoa_9.00",
        qualityWarnings: [
          "URANS integration stopped by the wall-clock budget guard: retained 4.1 of 7 periods (budget); projected 6.4h continuation exceeds 80% of the 12.0h solver timeout",
        ],
        solvedAt: new Date(),
      })
      .returning({ id: results.id });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { continueFromResultId: source.id, budgetOverrideS: 21600 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      created: boolean;
      request: {
        airfoilId: string;
        revisionId: string;
        aoaDeg: number;
        fidelity: string;
        state: string;
        continueFromResultId: string | null;
        budgetOverrideS: number | null;
        requestedBy: string | null;
      };
    };
    expect(body.created).toBe(true);
    expect(body.request.airfoilId).toBe(airfoilId);
    expect(body.request.revisionId).toBe(revisionId);
    expect(body.request.aoaDeg).toBe(9);
    expect(body.request.fidelity).toBe("full"); // derived from urans_full evidence
    expect(body.request.state).toBe("pending");
    expect(body.request.continueFromResultId).toBe(source.id);
    expect(body.request.budgetOverrideS).toBe(21600);
    expect(body.request.requestedBy).toBe(ADMIN_EMAIL);
  });

  it("422s a source without saved case state, 404s unknown sources, 400s a stray budget override", async () => {
    const [noCase] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 10,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        unsteady: true,
        converged: true,
        cl: 0.5,
        cd: 0.06,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    const missingCase = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { continueFromResultId: noCase.id, budgetOverrideS: 7200 },
    });
    expect(missingCase.statusCode).toBe(422);

    const unknown = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { continueFromResultId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(unknown.statusCode).toBe(404);

    const strayBudget = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, aoaDeg: 2, fidelity: "precalc", budgetOverrideS: 7200 },
    });
    expect(strayBudget.statusCode).toBe(400);
  });

  it("400s a budget override above the engine cap (URANS_BUDGET_OVERRIDE_MAX_S = 86400) instead of queuing a doomed request", async () => {
    const [source] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 12,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        unsteady: true,
        converged: true,
        cl: 0.6,
        cd: 0.05,
        engineJobId: `${PREFIX}-engine-cap`,
        engineCaseSlug: "aoa_12.00",
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    // 24h is the engine's le= bound: accepted here, accepted at engine submit.
    const atCap = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { continueFromResultId: source.id, budgetOverrideS: 24 * 3600 },
    });
    expect(atCap.statusCode).toBe(201);
    // 48h passed the old zod bound but the engine 422s it at submit and the
    // request is cancelled — an avoidable dead-end. Reject it up front.
    const aboveCap = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { continueFromResultId: source.id, budgetOverrideS: 48 * 3600 },
    });
    expect(aboveCap.statusCode).toBe(400);
  });

  it("409s a continuation whose cell is covered by an open NON-continuation request (a fresh solve must never be presented as a resume)", async () => {
    const [source] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 13,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        unsteady: true,
        converged: true,
        cl: 0.55,
        cd: 0.052,
        engineJobId: `${PREFIX}-engine-mix`,
        engineCaseSlug: "aoa_13.00",
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    // An admin queues an ordinary fresh-solve request-URANS on the cell first.
    const fresh = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, aoaDeg: 13, fidelity: "precalc" },
    });
    expect(fresh.statusCode).toBe(201);
    // Later, Continue +6h on the same cell: the open item is NOT a
    // continuation — reusing it would silently discard the saved case state.
    const cont = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { continueFromResultId: source.id, budgetOverrideS: 21600 },
    });
    expect(cont.statusCode).toBe(409);
    const body = cont.json() as { error: string; request: { continueFromResultId: string | null } };
    expect(body.error).toContain("NOT a continuation");
    expect(body.request.continueFromResultId).toBeNull();
    // Replaying a MATCHING continuation still reuses idempotently (200).
    const [source14] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 14,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        unsteady: true,
        converged: true,
        cl: 0.5,
        cd: 0.05,
        engineJobId: `${PREFIX}-engine-idem`,
        engineCaseSlug: "aoa_14.00",
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    const first = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { continueFromResultId: source14.id, budgetOverrideS: 7200 },
    });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { continueFromResultId: source14.id, budgetOverrideS: 7200 },
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { created: boolean }).created).toBe(false);
  });
});
