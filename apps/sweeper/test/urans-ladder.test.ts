// URANS fidelity-ladder integration (contracts 3–7, migration 0034):
// schema pin, ladder gating (RANS gap present ⇒ no precalc submit), gated
// wave-2 re-attempt at precalc fidelity, idempotent verify-queue enqueue,
// tier ordering (pending admin request ⇒ no verify consume), verify solve +
// disagreement path, request-URANS idempotency, phase derivation and
// completion blocking. Live shared-DB pattern (scoped rows, full cleanup).

import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  campaignHasOpenRansGaps,
  campaignOpenTierCounts,
  campaignSummary,
  categories,
  createClient,
  createUransRequest,
  deriveCampaignPhase,
  enqueuePrecalcVerifications,
  flowConditions,
  hasOpenCampaignLadderWork,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  polarFitSets,
  probeCampaignCompletion,
  referenceGeometryProfiles,
  resultAttempts,
  resultClassifications,
  results,
  simCampaignConditions,
  simCampaignPoints,
  simCampaigns,
  simJobs,
  simulationPresetRevisions,
  simulationPresets,
  simUransRequests,
  simUransVerifyQueue,
  solverProfiles,
  sweepDefinitions,
  sweeperState,
} from "@aerodb/db";
import { type EngineClient, type JobResult, type JobStatus, type PolarPoint, type PolarRequest } from "@aerodb/engine-client";
import { and, eq, inArray, like, sql as dsql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcile, submitUransRetryForJob } from "../src/reconcile";
import { resetUransLadderMemory, uransLadderTick } from "../src/urans-ladder";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-ladder-${process.pid}-${Date.now().toString(36)}`;

const here = dirname(fileURLToPath(import.meta.url));
const frameTrackFixture = (): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(here, "fixtures/frame-track-contract.json"), "utf8"));

const ANGLES = [4, 8];
const SPEED = 20;
const CHORD = 0.25;
const REJECTED_AOA = 8;

let campaignId = "";
let airfoilId = "";
let categoryId = "";
let mediumId = "";
let conditionId = "";
let revisionId = "";
let bcId = "";
let parentJobId = "";
const profileIds = { boundary: "", mesh: "", solver: "", output: "" };
let restoreSweeperEnabled: boolean | null = null;

const points = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

function stubEngine(capture: PolarRequest[], engineJobId: string): EngineClient {
  return {
    submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
      capture.push(request);
      return { job_id: engineJobId, state: "pending", total_cases: request.aoa?.angles?.length ?? 0, completed_cases: 0 };
    },
  } as unknown as EngineClient;
}

beforeAll(async () => {
  resetUransLadderMemory();
  const [state] = await db.select({ enabled: sweeperState.enabled }).from(sweeperState).where(eq(sweeperState.id, 1)).limit(1);
  restoreSweeperEnabled = state?.enabled ?? false;
  await db
    .insert(sweeperState)
    .values({ id: 1, enabled: false })
    .onConflictDoUpdate({ target: sweeperState.id, set: { enabled: false } });

  const [cat] = await db
    .insert(categories)
    .values({ slug: `${PREFIX}-cat`, name: `${PREFIX} cat`, path: `${PREFIX}-cat`, depth: 0 })
    .returning();
  categoryId = cat.id;
  const [airfoil] = await db
    .insert(airfoils)
    .values({ slug: `${PREFIX}-foil`, name: `${PREFIX} foil`, categoryId: cat.id, points, isSymmetric: false })
    .returning();
  airfoilId = airfoil.id;
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
      speedOfSound: 340.3,
    })
    .returning();
  mediumId = medium.id;
  const [boundary] = await db.insert(boundaryProfiles).values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` }).returning();
  const [mesh] = await db.insert(meshProfiles).values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` }).returning();
  const [solver] = await db.insert(solverProfiles).values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` }).returning();
  const [output] = await db.insert(outputProfiles).values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` }).returning();
  profileIds.boundary = boundary.id;
  profileIds.mesh = mesh.id;
  profileIds.solver = solver.id;
  profileIds.output = output.id;

  const launch = await materializeCampaignLaunch(db, {
    name: `${PREFIX} ladder campaign`,
    priority: 7,
    idempotencyKey: `${PREFIX}-idem`,
    airfoilIds: [airfoilId],
    plan: {
      mediumId,
      ambients: [[288.15, 101325]],
      speedsMps: [SPEED],
      chordsM: [CHORD],
      spanM: 1,
      areaMode: "derived",
      excludedConditions: [],
      baseSweep: { fromDeg: null, toDeg: null, stepDeg: null, listDeg: ANGLES },
      objectives: {
        ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
        clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
      },
      numerics: {
        boundaryProfileId: profileIds.boundary,
        meshProfileId: profileIds.mesh,
        solverProfileId: profileIds.solver,
        outputProfileId: profileIds.output,
      },
    },
  });
  campaignId = launch.campaign.id;
  const [condition] = await db.select().from(simCampaignConditions).where(eq(simCampaignConditions.campaignId, campaignId));
  conditionId = condition.id;
  revisionId = condition.simulationPresetRevisionId;
  const [preset] = await db
    .select({ legacyBoundaryConditionId: simulationPresets.legacyBoundaryConditionId })
    .from(simulationPresets)
    .where(eq(simulationPresets.id, condition.presetId))
    .limit(1);
  bcId = preset!.legacyBoundaryConditionId!;
});

afterAll(async () => {
  const campaignPresets = campaignId
    ? await db
        .select({ id: simulationPresets.id, legacyId: simulationPresets.legacyBoundaryConditionId })
        .from(simulationPresets)
        .where(like(simulationPresets.slug, `campaign-${PREFIX.toLowerCase()}%`))
    : [];
  const revisionRows = campaignPresets.length
    ? await db
        .select({ id: simulationPresetRevisions.id })
        .from(simulationPresetRevisions)
        .where(inArray(simulationPresetRevisions.presetId, campaignPresets.map((p) => p.id)))
    : [];
  const revisionIds = revisionRows.map((r) => r.id);
  if (revisionIds.length) {
    await db.delete(simUransVerifyQueue).where(inArray(simUransVerifyQueue.revisionId, revisionIds));
    await db.delete(simUransRequests).where(inArray(simUransRequests.revisionId, revisionIds));
    await db.delete(polarFitSets).where(inArray(polarFitSets.simulationPresetRevisionId, revisionIds));
    await db.delete(resultClassifications).where(inArray(resultClassifications.simulationPresetRevisionId, revisionIds));
    await db.delete(resultAttempts).where(inArray(resultAttempts.simulationPresetRevisionId, revisionIds));
    await db.delete(results).where(inArray(results.simulationPresetRevisionId, revisionIds));
    await db.delete(simJobs).where(inArray(simJobs.simulationPresetRevisionId, revisionIds));
  }
  const campaignFlowIds = campaignId
    ? (await db.select({ id: flowConditions.id }).from(flowConditions).where(eq(flowConditions.createdByCampaignId, campaignId))).map((r) => r.id)
    : [];
  const campaignGeoIds = campaignId
    ? ((await db.execute(dsql`SELECT id FROM reference_geometry_profiles WHERE created_by_campaign_id = ${campaignId}`)) as unknown as { id: string }[]).map((r) => r.id)
    : [];
  if (campaignId) {
    await db.delete(simJobs).where(eq(simJobs.campaignId, campaignId));
    await db.delete(simCampaigns).where(eq(simCampaigns.id, campaignId));
  }
  if (campaignPresets.length) {
    await db.delete(simulationPresets).where(inArray(simulationPresets.id, campaignPresets.map((p) => p.id)));
    const legacyIds = campaignPresets.map((p) => p.legacyId).filter((x): x is string => Boolean(x));
    if (legacyIds.length) await db.delete(boundaryConditions).where(inArray(boundaryConditions.id, legacyIds));
  }
  if (campaignFlowIds.length) {
    await db.execute(
      dsql`DELETE FROM flow_conditions fc WHERE fc.id = ANY(ARRAY[${dsql.join(campaignFlowIds.map((id) => dsql`${id}::uuid`), dsql`, `)}]) AND NOT EXISTS (SELECT 1 FROM simulation_presets sp WHERE sp.flow_condition_id = fc.id)`,
    );
  }
  if (campaignGeoIds.length) {
    await db.execute(
      dsql`DELETE FROM reference_geometry_profiles rgp WHERE rgp.id = ANY(ARRAY[${dsql.join(campaignGeoIds.map((id) => dsql`${id}::uuid`), dsql`, `)}]) AND NOT EXISTS (SELECT 1 FROM simulation_presets sp WHERE sp.reference_geometry_profile_id = rgp.id)`,
    );
  }
  await db.delete(sweepDefinitions).where(like(sweepDefinitions.slug, `campaign-${PREFIX.toLowerCase()}%`));
  if (profileIds.boundary) await db.delete(boundaryProfiles).where(eq(boundaryProfiles.id, profileIds.boundary));
  if (profileIds.mesh) await db.delete(meshProfiles).where(eq(meshProfiles.id, profileIds.mesh));
  if (profileIds.solver) await db.delete(solverProfiles).where(eq(solverProfiles.id, profileIds.solver));
  if (profileIds.output) await db.delete(outputProfiles).where(eq(outputProfiles.id, profileIds.output));
  if (mediumId) await db.delete(mediums).where(eq(mediums.id, mediumId));
  if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
  if (categoryId) await db.delete(categories).where(eq(categories.id, categoryId));
  if (restoreSweeperEnabled !== null) {
    await db
      .insert(sweeperState)
      .values({ id: 1, enabled: restoreSweeperEnabled })
      .onConflictDoUpdate({ target: sweeperState.id, set: { enabled: restoreSweeperEnabled } });
  }
  await sql.end();
});

describe("migration 0034 schema pin", () => {
  it("results carries fidelity + steady_history; ladder tables match the pinned contract columns", async () => {
    const resultCols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'results' AND column_name IN ('fidelity', 'steady_history')
    `)) as unknown as { column_name: string }[];
    expect(resultCols.map((c) => c.column_name).sort()).toEqual(["fidelity", "steady_history"]);

    const verifyCols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'sim_urans_verify_queue'
    `)) as unknown as { column_name: string }[];
    // Contract 4 column set, pinned exactly.
    expect(verifyCols.map((c) => c.column_name).sort()).toEqual(
      [
        "id",
        "airfoil_id",
        "revision_id",
        "aoa_deg",
        "campaign_id",
        "state",
        "precalc_result_id",
        "verify_result_id",
        "delta_cl",
        "delta_cd",
        "delta_cm",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    const requestCols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'sim_urans_requests'
    `)) as unknown as { column_name: string }[];
    expect(requestCols.map((c) => c.column_name)).toContain("fidelity");
    expect(requestCols.map((c) => c.column_name)).toContain("sim_job_id");
  });
});

describe("fidelity ladder end-to-end (gating → precalc retry → verify queue → completion)", () => {
  it("LADDER GATE MUST-CATCH: open RANS gaps block the campaign's precalc URANS retry", async () => {
    // Parent: a done wave-1 campaign job whose only evidence is a REJECTED
    // RANS attempt at REJECTED_AOA (single-revision path).
    const [parent] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        campaignId,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "done",
        engineJobId: `${PREFIX}-parent`,
        totalCases: ANGLES.length,
        completedCases: ANGLES.length,
        ingestedAt: new Date(),
        finishedAt: new Date(),
        requestPayload: { speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach: SPEED / 340.3 }], aoas: ANGLES },
      })
      .returning();
    parentJobId = parent.id;
    await db.insert(resultAttempts).values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: REJECTED_AOA,
      simJobId: parent.id,
      engineJobId: `${PREFIX}-parent`,
      status: "failed",
      source: "queued",
      regime: "rans",
      validForPolar: false,
      converged: false,
      stalled: true,
      unsteady: false,
      error: "RANS did not converge",
      solvedAt: new Date(),
    });

    // Campaign points are all still 'requested' with no results rows — open
    // RANS gaps. The inline retry must DEFER (no wave-2 child).
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(true);
    const requests: PolarRequest[] = [];
    await submitUransRetryForJob(db, stubEngine(requests, `${PREFIX}-should-not-exist`), parent);
    expect(requests.length).toBe(0);
    const children = await db.select().from(simJobs).where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
    expect(children.length).toBe(0);

    const tiers = await campaignOpenTierCounts(db, campaignId);
    expect(tiers.ransOpen).toBe(ANGLES.length);
    expect(deriveCampaignPhase("active", tiers)).toBe("running_rans");
  }, 60000);

  it("gates open ⇒ the ladder tick submits the deferred wave-2 retry at PRECALC fidelity", async () => {
    // Terminal-close every campaign point (the RANS tier is settled).
    await db
      .update(simCampaignPoints)
      .set({ state: "terminal" })
      .where(eq(simCampaignPoints.campaignId, campaignId));
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(false);

    const requests: PolarRequest[] = [];
    const submitted = await uransLadderTick(db, stubEngine(requests, `${PREFIX}-precalc-child`), 0, { campaignIds: [campaignId] });
    expect(submitted).toBe(true);
    expect(requests.length).toBe(1);
    expect(requests[0].solver?.urans_fidelity).toBe("precalc");
    expect(requests[0].solver?.force_transient).toBe(true);
    expect(requests[0].aoa?.angles).toEqual([REJECTED_AOA]);

    const [child] = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parentJobId), eq(simJobs.wave, 2)));
    expect(child).toBeTruthy();
    expect(child.jobKind).toBe("targeted");
    expect((child.requestPayload as { uransFidelity?: string }).uransFidelity).toBe("precalc");
    // Free the in-flight slot for the later verify-tier assertions.
    await db.update(simJobs).set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() }).where(eq(simJobs.id, child.id));
  }, 60000);

  it("enqueues ONE verify item per precalc-accepted point (idempotent partial-unique)", async () => {
    // A done precalc URANS results row + accepted classification (as after a
    // precalc child ingest + refresh).
    const [row] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: REJECTED_AOA,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        reynolds: Math.round((SPEED * CHORD) / (1.789e-5 / 1.225)),
        speed: SPEED,
        chord: CHORD,
        cl: 1.0,
        cd: 0.05,
        cm: -0.06,
        unsteady: true,
        converged: true,
        solvedAt: new Date(),
      })
      .returning();
    await db.insert(resultClassifications).values({
      resultId: row.id,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: REJECTED_AOA,
      regime: "urans",
      classifierVersion: "fidelity-ladder-v4",
      state: "accepted",
      region: "post_stall",
      confidence: 0.9,
      reasons: [],
    });
    // Link the campaign point so completion/tier logic sees the cell.
    await db
      .update(simCampaignPoints)
      .set({ resultId: row.id })
      .where(and(eq(simCampaignPoints.campaignId, campaignId), eq(simCampaignPoints.aoaDeg, REJECTED_AOA)));

    const first = await enqueuePrecalcVerifications(db, { airfoilId, revisionId, campaignId });
    expect(first).toBe(1);
    const second = await enqueuePrecalcVerifications(db, { airfoilId, revisionId, campaignId });
    expect(second).toBe(0);
    const items = await db.select().from(simUransVerifyQueue).where(eq(simUransVerifyQueue.revisionId, revisionId));
    expect(items.length).toBe(1);
    expect(items[0].state).toBe("pending");
    expect(items[0].campaignId).toBe(campaignId);
    expect(items[0].precalcResultId).toBe(row.id);

    // Phase: no RANS gaps, no precalc obligations left, one open verify item.
    const tiers = await campaignOpenTierCounts(db, campaignId);
    expect(tiers.verifyOpen).toBe(1);
    expect(deriveCampaignPhase("active", tiers)).toBe("running_refinement");
    const summary = await campaignSummary(db, campaignId);
    expect(summary.tierCounts.verifyOpen).toBe(1);
    expect(summary.phase).toBe("running_refinement");
  }, 60000);

  it("VERIFY ORDER MUST-CATCH: a pending admin request (precalc rank) consumes BEFORE any verify item", async () => {
    const { request, created } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: REJECTED_AOA,
      fidelity: "full",
      requestedBy: "test@airfoils.pro",
    });
    expect(created).toBe(true);

    const captured: PolarRequest[] = [];
    const submitted = await uransLadderTick(db, stubEngine(captured, `${PREFIX}-request-job`), 0, { campaignIds: [campaignId] });
    expect(submitted).toBe(true);
    expect(captured.length).toBe(1);
    // PAYLOAD-SHAPE PIN (prod job e89be2bb class): ladder-composed admin
    // requests are URANS-by-definition — solver.force_transient MUST ship, or
    // the engine treats the URANS stage as a steady fallback on the FULL mesh
    // at the tier's budget (effective_mesh_params requires force_transient).
    expect(captured[0].solver).toMatchObject({
      force_transient: true,
      transient_fallback: true,
      warm_start: false,
      urans_fidelity: "full",
    });
    const [afterRequest] = await db.select().from(simUransRequests).where(eq(simUransRequests.id, request.id));
    expect(afterRequest.state).toBe("running");
    expect(afterRequest.simJobId).toBeTruthy();
    // The verify item was NOT consumed while precalc-rank work existed.
    const [item] = await db.select().from(simUransVerifyQueue).where(eq(simUransVerifyQueue.revisionId, revisionId));
    expect(item.state).toBe("pending");

    // Settle the request job so the verify tier can open up.
    await db.update(simJobs).set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() }).where(eq(simJobs.id, afterRequest.simJobId!));
    await db.update(simUransRequests).set({ state: "done" }).where(eq(simUransRequests.id, request.id));
  }, 60000);

  it("LADDER PAYLOAD MUST-CATCH: an admin PRECALC request ships force_transient + precalc fidelity (full mesh requested; half-res derivation is engine-side)", async () => {
    const { request, created } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: REJECTED_AOA,
      fidelity: "precalc",
      requestedBy: "test@airfoils.pro",
    });
    expect(created).toBe(true);

    const captured: PolarRequest[] = [];
    const submitted = await uransLadderTick(db, stubEngine(captured, `${PREFIX}-precalc-request-job`), 0, { campaignIds: [campaignId] });
    expect(submitted).toBe(true);
    expect(captured.length).toBe(1);
    // PAYLOAD-SHAPE PIN (prod job e89be2bb, 2026-07-07): a ladder request that
    // ships WITHOUT solver.force_transient runs URANS on the FULL mesh at
    // precalc budgets — the engine's half-mesh derivation
    // (src/airfoilfoam/models.py effective_mesh_params) engages only when
    // force_transient && urans_fidelity == precalc — structurally guaranteeing
    // insufficient-periods (budget) rejections. A regression here must fail
    // loudly on the exact composed payload.
    expect(captured[0].solver).toMatchObject({
      force_transient: true,
      transient_fallback: true,
      warm_start: false,
      urans_fidelity: "precalc",
    });
    expect(captured[0].aoa?.angles).toEqual([REJECTED_AOA]);
    expect(captured[0].speeds).toEqual([SPEED]);
    // The node NEVER downscales the mesh: the composed request carries the
    // revision's FULL-resolution grid and the engine derives the half-res
    // precalc mesh from the flags pinned above.
    const [revision] = await db
      .select()
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, revisionId))
      .limit(1);
    const snapshotMesh = (revision!.snapshot as { mesh: { nSurface: number; nRadial: number; nWake: number } }).mesh;
    expect(captured[0].mesh?.n_surface).toBe(snapshotMesh.nSurface);
    expect(captured[0].mesh?.n_radial).toBe(snapshotMesh.nRadial);
    expect(captured[0].mesh?.n_wake).toBe(snapshotMesh.nWake);

    const [afterRequest] = await db.select().from(simUransRequests).where(eq(simUransRequests.id, request.id));
    expect(afterRequest.state).toBe("running");
    expect(afterRequest.simJobId).toBeTruthy();
    const [job] = await db.select().from(simJobs).where(eq(simJobs.id, afterRequest.simJobId!));
    expect(job.wave).toBe(2);
    expect(job.jobKind).toBe("targeted");
    const payload = job.requestPayload as { uransFidelity?: string; uransRequestId?: string };
    expect(payload.uransFidelity).toBe("precalc");
    expect(payload.uransRequestId).toBe(request.id);

    // Settle so the later verify-tier tests see a quiet machine.
    await db.update(simJobs).set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() }).where(eq(simJobs.id, afterRequest.simJobId!));
    await db.update(simUransRequests).set({ state: "done" }).where(eq(simUransRequests.id, request.id));
  }, 60000);

  it("request-URANS is idempotent per (cell, fidelity), whole-polar included", async () => {
    const a = await createUransRequest(db, { airfoilId, revisionId, aoaDeg: null, fidelity: "precalc" });
    expect(a.created).toBe(true);
    const b = await createUransRequest(db, { airfoilId, revisionId, aoaDeg: null, fidelity: "precalc" });
    expect(b.created).toBe(false);
    expect(b.request.id).toBe(a.request.id);
    // A different fidelity is a DIFFERENT work item.
    const c = await createUransRequest(db, { airfoilId, revisionId, aoaDeg: null, fidelity: "full" });
    expect(c.created).toBe(true);
    expect(c.request.id).not.toBe(a.request.id);
    // Clean these up so they do not feed the verify-order checks below.
    await db.delete(simUransRequests).where(inArray(simUransRequests.id, [a.request.id, c.request.id]));
  }, 60000);

  it("consumes the verify item at FULL fidelity once no campaign RANS/precalc work exists, then records a DISAGREEMENT at ingest", async () => {
    // The verify tier's gate is MACHINE-WIDE by design (contract 5): another
    // suite's live campaign fixture (campaign-batching, worker-restart,
    // sweeper, replace-guard) running concurrently against the shared dev DB
    // legitimately holds it open for as long as that suite's campaign stays
    // active — minutes, not seconds, on the remote DB. Bounded wait for quiet
    // sized past the longest sibling suite — a PERMANENTLY open gate (the
    // real regression this test must catch) still fails below at the deadline.
    const quietDeadline = Date.now() + 180_000;
    while ((await hasOpenCampaignLadderWork(db)) && Date.now() < quietDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const captured: PolarRequest[] = [];
    const submitted = await uransLadderTick(db, stubEngine(captured, `${PREFIX}-verify-job`), 0, { campaignIds: [campaignId] });
    expect(submitted).toBe(true);
    expect(captured.length).toBe(1);
    // PAYLOAD-SHAPE PIN (prod job e89be2bb class): verify items re-solve at
    // FULL fidelity and are URANS-by-definition — force_transient MUST ship
    // or the full-tier budget wraps a steady-fallback solve.
    expect(captured[0].solver).toMatchObject({
      force_transient: true,
      transient_fallback: true,
      warm_start: false,
      urans_fidelity: "full",
    });
    expect(captured[0].aoa?.angles).toEqual([REJECTED_AOA]);

    const [item] = await db.select().from(simUransVerifyQueue).where(eq(simUransVerifyQueue.revisionId, revisionId));
    expect(item.state).toBe("running");
    const [verifyJob] = await db
      .select()
      .from(simJobs)
      .where(dsql`request_payload ->> 'verifyQueueItemId' = ${item.id}`);
    expect(verifyJob).toBeTruthy();
    expect(verifyJob.jobKind).toBe("verify");
    expect((verifyJob.requestPayload as { verifyPrecalc?: { cl?: number } }).verifyPrecalc?.cl).toBe(1.0);

    // Completion blocking (contract 7): every cell terminal, but the open
    // verify item must keep the campaign from flipping completed.
    await probeCampaignCompletion(db, campaignId);
    const [beforeCampaign] = await db.select().from(simCampaigns).where(eq(simCampaigns.id, campaignId));
    expect(beforeCampaign.status).toBe("active");

    // Verified full-fidelity solve disagrees on Cl: 1.2 vs precalc 1.0.
    // Evidence-complete payload, like a real full-tier engine solve: frame
    // track (stationary, 6 retained periods >= the full-tier bar of 5), video
    // and force history shipped — it must pre-classify ACCEPT so the ingest
    // replace guard (gate incident 2026-07-07) lets it supersede the accepted
    // precalc row; a would-REJECT verify solve keeps the precalc evidence and
    // cancels the item instead (covered by the replace-guard suite).
    const verified: JobResult = {
      job_id: `${PREFIX}-verify-job`,
      state: "completed",
      polars: [
        {
          speed: SPEED,
          chord: CHORD,
          reynolds: Math.round((SPEED * CHORD) / (1.789e-5 / 1.225)),
          mach: SPEED / 340.3,
          points: [
            {
              aoa_deg: REJECTED_AOA,
              cl: 1.2,
              cd: 0.055,
              cm: -0.05,
              cl_cd: 1.2 / 0.055,
              unsteady: true,
              converged: true,
              first_order_fallback: false,
              fidelity: "urans_full",
              frame_track: frameTrackFixture() as unknown as PolarPoint["frame_track"],
              images: {},
              video: { velocity_magnitude: `/jobs/${PREFIX}-verify-job/files/cases/a0/images/velocity_magnitude.mp4` },
              force_history: {
                t: [0, 0.1, 0.2, 0.3],
                cl: [1.1, 1.3, 1.15, 1.25],
                cd: [0.05, 0.06, 0.05, 0.06],
                cm: [-0.04, -0.06, -0.05, -0.05],
                shedding_freq_hz: 7.3,
                samples: 240,
              },
            } as PolarPoint,
          ],
        },
      ],
    };
    const verifyEngine = {
      getQueue: async () => {
        throw new Error("queue unavailable in test");
      },
      getJob: async (): Promise<JobStatus> => ({
        job_id: `${PREFIX}-verify-job`,
        state: "completed",
        total_cases: 1,
        completed_cases: 1,
      }),
      getResult: async () => verified,
      fileUrl: (id: string, relPath: string) => `http://engine.test/jobs/${id}/files/${relPath}`,
    } as unknown as EngineClient;
    await reconcile(db, verifyEngine, { jobIds: [verifyJob.id], skipFailedRecovery: true });

    const [settled] = await db.select().from(simUransVerifyQueue).where(eq(simUransVerifyQueue.id, item.id));
    expect(settled.state).toBe("disagreed");
    expect(settled.deltaCl).toBeCloseTo(0.2, 6);
    expect(settled.deltaCd).toBeCloseTo(0.005, 6);
    expect(settled.verifyResultId).toBeTruthy();

    // The classification stays on the VERIFIED row (now the results row at
    // full fidelity) and the disagreement is surfaced as a quality marker —
    // nothing silently swapped.
    const [verifiedRow] = await db
      .select()
      .from(results)
      .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, revisionId), eq(results.aoaDeg, REJECTED_AOA)));
    expect(verifiedRow.fidelity).toBe("urans_full");
    expect(verifiedRow.cl).toBeCloseTo(1.2, 6);
    expect((verifiedRow.qualityWarnings ?? []).some((w) => w.startsWith("urans-verify-disagreement:"))).toBe(true);
    // No re-enqueue: the cell is full-fidelity now, so the enqueue predicate
    // no longer matches.
    const itemsAfter = await db.select().from(simUransVerifyQueue).where(eq(simUransVerifyQueue.revisionId, revisionId));
    expect(itemsAfter.length).toBe(1);

    // All three tiers terminal now → the completion probe may settle the
    // campaign (the verified row classifies at refresh; whatever the verdict,
    // the ladder no longer blocks).
    const tiers = await campaignOpenTierCounts(db, campaignId);
    expect(tiers.verifyOpen).toBe(0);
  }, 300000);
});

describe("tier-2a scan-window starvation MUST-CATCH (adversarial review 2026-07-07)", () => {
  // Production shape: a campaign's batched parents mostly need NO gated retry
  // (their cells all landed accepted), and the parents that DO need a retry
  // finish LAST (the gate stays closed until the final RANS gap closes). The
  // buggy scan fetched a fixed finishedAt-ASC window with no retry-need or
  // settled-parent exclusion in SQL, so >window no-retry parents permanently
  // occupied the window and the needy parent was never fetched → its
  // needs_urans cell never re-solved → phase stuck running_precalc forever.
  it("reaches a needy parent ranked past the first finishedAt window despite 13 earlier no-retry parents", async () => {
    // The verify test above ends with every tier terminal and the aoa-8 cell
    // ACCEPTED at full fidelity, so the completion probe settles the shared
    // fixture campaign to 'completed'. This scenario needs a LIVE mid-ladder
    // campaign (the gate just opened, gated retries still owed) — reactivate.
    await db.update(simCampaigns).set({ status: "active" }).where(eq(simCampaigns.id, campaignId));
    const base = Date.now() - 60 * 60 * 1000;
    // 13 completed, ingested, childless wave-1 parents with EMPTY retry plans
    // (no attempts at all) — one more than the old 12-slot scan window.
    for (let i = 0; i < 13; i++) {
      await db.insert(simJobs).values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        campaignId,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "done",
        engineJobId: `${PREFIX}-starve-filler-${i}`,
        totalCases: 1,
        completedCases: 1,
        ingestedAt: new Date(base + i * 1000),
        finishedAt: new Date(base + i * 1000),
        requestPayload: { speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach: SPEED / 340.3 }], aoas: [4] },
      });
    }
    // The needy parent finishes LAST and carries a failed RANS attempt at
    // aoa 4 (classifies rejected at refresh → non-empty targeted retry plan).
    const [needy] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        campaignId,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "done",
        engineJobId: `${PREFIX}-starve-needy`,
        totalCases: 1,
        completedCases: 1,
        ingestedAt: new Date(base + 999_000),
        finishedAt: new Date(base + 999_000),
        requestPayload: { speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach: SPEED / 340.3 }], aoas: [4] },
      })
      .returning();
    await db.insert(resultAttempts).values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 4,
      simJobId: needy.id,
      engineJobId: `${PREFIX}-starve-needy`,
      status: "failed",
      source: "queued",
      regime: "rans",
      validForPolar: false,
      converged: false,
      stalled: true,
      unsteady: false,
      error: "RANS did not converge",
      solvedAt: new Date(),
    });
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(false);

    // Bounded ticks: the scan MUST slide past the settled no-retry parents
    // and reach the needy parent. The buggy window never advances, so no
    // number of ticks ever creates the child.
    let child: typeof simJobs.$inferSelect | undefined;
    for (let tick = 0; tick < 10 && !child; tick++) {
      const requests: PolarRequest[] = [];
      await uransLadderTick(db, stubEngine(requests, `${PREFIX}-starve-child-${tick}`), 0, { campaignIds: [campaignId] });
      [child] = await db.select().from(simJobs).where(and(eq(simJobs.parentJobId, needy.id), eq(simJobs.wave, 2)));
    }
    expect(child).toBeTruthy();
    expect(child!.jobKind).toBe("targeted");
    expect((child!.requestPayload as { uransFidelity?: string }).uransFidelity).toBe("precalc");
    expect((child!.requestPayload as { aoas?: number[] }).aoas).toEqual([4]);
    // Free the slot so nothing lingers in-flight for other suites.
    await db.update(simJobs).set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() }).where(eq(simJobs.id, child!.id));
  }, 180000);
});
