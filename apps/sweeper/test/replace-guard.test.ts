// INGEST REPLACE GUARD (gate incident 2026-07-07, prod ladder-gate campaign,
// naca-0012 alpha=15 @ 25 m/s, 0.1 m): the cell held an ACCEPTED
// oscillating-steady RANS (cl=0.652); an admin-requested precalc URANS
// retained only 1.4 of 3 periods (budget guard), classified REJECTED
// {non-stationary, insufficient-periods} — and its ingest UPSERTED the cell
// row, replacing accepted evidence with a rejected result. Results are
// cell-unique (airfoil, revision, aoa) and classification runs AFTER the
// upsert, so nothing guarded replacement quality.
//
// MUST-CATCH suite, shaped like the incident (real DB rows, real classifier
// refresh, reconcile through the same ingest path prod ran):
//   1. accepted-rans cell + rejected-shaped precalc payload → canonical row
//      UNCHANGED, attempt + evidence ingested, request settled, loud line;
//   2. accepted-rans cell + ACCEPTING precalc payload → replaced (urans_precalc);
//   3. rejected cell + rejected payload → replaced (no guard);
//   4. empty cell → normal ingest;
//   5. false-positive guard: needs_urans existing row is PROTECTED, never
//      treated as rejected.

import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  createClient,
  createUransRequest,
  flowConditions,
  forceHistory,
  mediums,
  meshProfiles,
  outputProfiles,
  polarFitSets,
  referenceGeometryProfiles,
  refreshPolarCacheForRevision,
  resultAttempts,
  resultClassifications,
  resultMedia,
  results,
  schedulingProfiles,
  simJobs,
  simulationPresetAirfoilTargets,
  simulationPresets,
  simUransRequests,
  simUransVerifyQueue,
  solverEvidenceArtifacts,
  solverProfiles,
  sweepDefinitions,
  sweeperState,
} from "@aerodb/db";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import type { EngineClient, JobResult, JobStatus, PolarPoint } from "@aerodb/engine-client";
import { and, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { incomingRejectionReasons, ingestResult, REPLACE_GUARD_MARKER } from "../src/ingest";
import { reconcile } from "../src/reconcile";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-guard-${process.pid}-${Date.now().toString(36)}`;

// Incident flow class: c = 0.1 m, U = 25 m/s.
const CHORD = 0.1;
const SPEED = 25;
const GATE_AOA = 15;

const here = dirname(fileURLToPath(import.meta.url));
const frameTrackFixture = (): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(here, "fixtures/frame-track-contract.json"), "utf8"));
const steadyHistoryFixture = (): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(here, "fixtures/steady-history-contract.json"), "utf8"));

let categoryId = "";
let airfoilId = "";
let bcId = "";
let presetId = "";
let revisionId = "";
let reynolds = 0;
let mach: number | null = null;
const profileIds = { boundary: "", mesh: "", solver: "", scheduling: "", output: "" };
let flowId = "";
let referenceGeometryId = "";
let sweepId = "";
let restoreSweeperEnabled: boolean | null = null;

const contour = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.08 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.08 },
  { x: 1, y: 0 },
];

beforeAll(async () => {
  const [state] = await db.select({ enabled: sweeperState.enabled }).from(sweeperState).where(eq(sweeperState.id, 1)).limit(1);
  restoreSweeperEnabled = state?.enabled ?? false;
  await db
    .insert(sweeperState)
    .values({ id: 1, enabled: false })
    .onConflictDoUpdate({ target: sweeperState.id, set: { enabled: false } });

  const [medium] = await db.select().from(mediums).where(eq(mediums.slug, "air")).limit(1);
  if (!medium) throw new Error("seeded air medium required");
  reynolds = Math.round((SPEED * CHORD) / medium.kinematicViscosity);
  mach = medium.speedOfSound ? SPEED / medium.speedOfSound : null;

  const [cat] = await db
    .insert(categories)
    .values({ slug: `${PREFIX}-cat`, name: `${PREFIX} cat`, path: `${PREFIX}-cat`, depth: 0 })
    .returning();
  categoryId = cat.id;
  const [airfoil] = await db
    .insert(airfoils)
    .values({ slug: `${PREFIX}-foil`, name: `${PREFIX} foil`, categoryId: cat.id, points: contour, isSymmetric: false })
    .returning();
  airfoilId = airfoil.id;

  const [legacy] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${PREFIX}-bc`,
      name: `${PREFIX} bc`,
      mediumId: medium.id,
      reynolds,
      referenceChordM: CHORD,
      temperatureK: medium.refTemperatureK,
      pressurePa: medium.refPressurePa,
      speedMps: SPEED,
      density: medium.density,
      dynamicViscosity: medium.dynamicViscosity,
      kinematicViscosity: medium.kinematicViscosity,
      mach,
      enabled: false,
    })
    .returning();
  bcId = legacy.id;
  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${PREFIX}-flow`,
      name: `${PREFIX} flow`,
      mediumId: medium.id,
      temperatureK: medium.refTemperatureK,
      pressurePa: medium.refPressurePa,
      speedMps: SPEED,
      density: medium.density,
      dynamicViscosity: medium.dynamicViscosity,
      kinematicViscosity: medium.kinematicViscosity,
      mach,
    })
    .returning();
  flowId = flow.id;
  const [referenceGeometry] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${PREFIX}-refgeo`,
      name: `${PREFIX} refgeo`,
      geometryType: "airfoil_2d",
      referenceLengthKind: "chord",
      referenceLengthM: CHORD,
    })
    .returning();
  referenceGeometryId = referenceGeometry.id;
  const [boundary] = await db.insert(boundaryProfiles).values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` }).returning();
  const [mesh] = await db.insert(meshProfiles).values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` }).returning();
  const [solver] = await db.insert(solverProfiles).values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` }).returning();
  const [scheduling] = await db.insert(schedulingProfiles).values({ slug: `${PREFIX}-sched`, name: `${PREFIX} sched` }).returning();
  const [output] = await db.insert(outputProfiles).values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` }).returning();
  profileIds.boundary = boundary.id;
  profileIds.mesh = mesh.id;
  profileIds.solver = solver.id;
  profileIds.scheduling = scheduling.id;
  profileIds.output = output.id;
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({ slug: `${PREFIX}-sweep`, name: `${PREFIX} sweep`, aoaList: [GATE_AOA] })
    .returning();
  sweepId = sweep.id;
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${PREFIX}-preset`,
      name: `${PREFIX} preset`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: referenceGeometry.id,
      boundaryProfileId: boundary.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      schedulingProfileId: scheduling.id,
      outputProfileId: output.id,
      sweepDefinitionId: sweep.id,
      legacyBoundaryConditionId: legacy.id,
      // Disabled on purpose: this fixture's cells must never surface in a
      // concurrently running suite's findGaps scan (shared dev DB).
      enabled: false,
      targetScope: "airfoils",
    })
    .returning();
  presetId = preset.id;
  await db.insert(simulationPresetAirfoilTargets).values({ presetId: preset.id, airfoilId });
  const resolved = await ensureSimulationPresetRevision(db, preset.id);
  if (!resolved) throw new Error("guard fixture revision required");
  revisionId = resolved.revision.id;
});

afterAll(async () => {
  if (revisionId) {
    await db.delete(simUransRequests).where(eq(simUransRequests.revisionId, revisionId));
    await db.delete(polarFitSets).where(eq(polarFitSets.simulationPresetRevisionId, revisionId));
    await db.delete(resultClassifications).where(eq(resultClassifications.simulationPresetRevisionId, revisionId));
    await db.delete(resultAttempts).where(eq(resultAttempts.simulationPresetRevisionId, revisionId));
    await db.delete(results).where(eq(results.simulationPresetRevisionId, revisionId));
    await db.delete(simJobs).where(eq(simJobs.simulationPresetRevisionId, revisionId));
  }
  if (presetId) await db.delete(simulationPresets).where(eq(simulationPresets.id, presetId));
  if (bcId) await db.delete(boundaryConditions).where(eq(boundaryConditions.id, bcId));
  if (flowId) await db.delete(flowConditions).where(eq(flowConditions.id, flowId));
  if (referenceGeometryId) await db.delete(referenceGeometryProfiles).where(eq(referenceGeometryProfiles.id, referenceGeometryId));
  if (profileIds.boundary) await db.delete(boundaryProfiles).where(eq(boundaryProfiles.id, profileIds.boundary));
  if (profileIds.mesh) await db.delete(meshProfiles).where(eq(meshProfiles.id, profileIds.mesh));
  if (profileIds.solver) await db.delete(solverProfiles).where(eq(solverProfiles.id, profileIds.solver));
  if (profileIds.scheduling) await db.delete(schedulingProfiles).where(eq(schedulingProfiles.id, profileIds.scheduling));
  if (profileIds.output) await db.delete(outputProfiles).where(eq(outputProfiles.id, profileIds.output));
  if (sweepId) await db.delete(sweepDefinitions).where(eq(sweepDefinitions.id, sweepId));
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

afterEach(() => {
  vi.restoreAllMocks();
});

/** Engine stub: ingest-capable, scaled-render chain down (the guard paths
 *  never reach it; the replacement paths tolerate the loud extent failure). */
function stubEngine(result?: JobResult): EngineClient {
  return {
    baseUrl: "http://engine.test",
    getQueue: async () => {
      throw new Error("queue unavailable in test");
    },
    getJob: async (): Promise<JobStatus> => ({
      job_id: result?.job_id ?? "guard-job",
      state: "completed",
      total_cases: 1,
      completed_cases: 1,
    }),
    getResult: async () => {
      if (!result) throw new Error("no result stubbed");
      return result;
    },
    computeFieldExtents: async () => {
      throw new Error("render backend down");
    },
    renderDefaultMedia: async () => {
      throw new Error("render backend down");
    },
    fileUrl: (id: string, relPath: string) => `http://engine.test/jobs/${id}/files/${relPath}`,
  } as unknown as EngineClient;
}

async function cleanCell(): Promise<void> {
  await db.delete(resultClassifications).where(eq(resultClassifications.simulationPresetRevisionId, revisionId));
  await db.delete(resultAttempts).where(eq(resultAttempts.simulationPresetRevisionId, revisionId));
  await db.delete(results).where(eq(results.simulationPresetRevisionId, revisionId));
}

/** Seed the incident cell: an oscillating-steady RANS accepted through
 *  steady_history.mean_stable (cl=0.652) — status done, converged=false,
 *  stalled=true, fidelity 'rans'. */
async function seedAcceptedRansCell(): Promise<string> {
  const [row] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: GATE_AOA,
      status: "done",
      source: "solved",
      regime: "rans",
      fidelity: "rans",
      reynolds,
      speed: SPEED,
      chord: CHORD,
      mach,
      cl: 0.652,
      cd: 0.181,
      cm: -0.021,
      clCd: 0.652 / 0.181,
      unsteady: false,
      converged: false,
      stalled: true,
      steadyHistory: steadyHistoryFixture(),
      qualityWarnings: ["steady-oscillating-mean: coefficients are stable window means"],
      solvedAt: new Date(),
    })
    .returning({ id: results.id });
  return row.id;
}

/** Incident-shaped REJECTED precalc URANS point: coefficients fine and media
 *  shipped, but the budget guard kept only 1.4 of 3 periods → the classifier's
 *  frame-track gate rejects {non-stationary, insufficient-periods}. */
function rejectedPrecalcPoint(): PolarPoint {
  return {
    case_slug: "a0",
    aoa_deg: GATE_AOA,
    cl: 0.689,
    cd: 0.212,
    cm: -0.034,
    cl_cd: 0.689 / 0.212,
    cl_std: 0.11,
    cd_std: 0.03,
    unsteady: true,
    converged: true,
    first_order_fallback: false,
    strouhal: 0.118,
    fidelity: "urans_precalc",
    frame_track: {
      ...frameTrackFixture(),
      periods_retained: 1.4,
      stationary: false,
    } as unknown as PolarPoint["frame_track"],
    quality_warnings: [
      "URANS integration stopped by the wall-clock budget guard: retained 1.4 of 3 periods; projected 0.6h continuation exceeds 80% of the 1.0h solver timeout",
    ],
    images: { velocity_magnitude: "/jobs/guard-job/files/cases/a0/images/velocity_magnitude.png" },
    mean_images: { velocity_magnitude: "/jobs/guard-job/files/cases/a0/images/velocity_magnitude_mean.png" },
    video: { velocity_magnitude: "/jobs/guard-job/files/cases/a0/images/velocity_magnitude.mp4" },
    force_history: {
      t: [0, 0.1, 0.2, 0.3],
      cl: [0.62, 0.75, 0.66, 0.71],
      cd: [0.2, 0.23, 0.21, 0.22],
      cm: [-0.03, -0.04, -0.03, -0.03],
      shedding_freq_hz: 29.5,
      samples: 240,
    },
    evidence_artifacts: [
      {
        kind: "manifest",
        path: `/jobs/guard-job/files/evidence/a0/evidence_manifest.json`,
        url: `/jobs/guard-job/files/evidence/a0/evidence_manifest.json`,
        mime_type: "application/json",
        sha256: `sha-${PREFIX}-rejected-manifest`,
        byte_size: 128,
        metadata: { evidenceBase: "/tmp/evidence/a0" },
      },
    ],
  } as PolarPoint;
}

/** ACCEPTING precalc URANS point: stationary frame_track with 6 retained
 *  periods (>= precalc bar of 3), video + force history shipped. */
function acceptingPrecalcPoint(): PolarPoint {
  const p = rejectedPrecalcPoint();
  return {
    ...p,
    cl: 0.71,
    frame_track: frameTrackFixture() as unknown as PolarPoint["frame_track"],
    quality_warnings: [],
    evidence_artifacts: [
      {
        kind: "manifest",
        path: `/jobs/guard-job/files/evidence/a0/evidence_manifest.json`,
        url: `/jobs/guard-job/files/evidence/a0/evidence_manifest.json`,
        mime_type: "application/json",
        sha256: `sha-${PREFIX}-accepting-manifest`,
        byte_size: 128,
        metadata: { evidenceBase: "/tmp/evidence/a0" },
      },
    ],
  };
}

function jobResult(jobId: string, point: PolarPoint): JobResult {
  return {
    job_id: jobId,
    state: "completed",
    polars: [{ speed: SPEED, chord: CHORD, reynolds, mach, points: [point] }],
  };
}

describe("ingest replace guard (gate incident 2026-07-07)", () => {
  it("MUST-CATCH incident shape: a rejected precalc URANS never clobbers the accepted RANS cell; attempt + evidence ingested, request settled, loud line", async () => {
    await cleanCell();
    const keptId = await seedAcceptedRansCell();
    // Real classifier verdict, not a hand stamp: the oscillating-steady RANS
    // row must classify ACCEPTED through the v4 gate before the guard reads it.
    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    const [before] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, keptId));
    expect(before?.state).toBe("accepted");

    // Admin-requested precalc URANS (the incident's trigger), reconciled
    // through the SAME completed-job ingest path prod ran.
    const { request } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: GATE_AOA,
      fidelity: "precalc",
      requestedBy: "test@airfoils.pro",
    });
    const engineJobId = `${PREFIX}-incident-job`;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "submitted",
        engineJobId,
        totalCases: 1,
        requestPayload: {
          speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach }],
          aoas: [GATE_AOA],
          uransFidelity: "precalc",
          uransRequestId: request.id,
        },
      })
      .returning();
    await db.update(simUransRequests).set({ state: "running", simJobId: job.id }).where(eq(simUransRequests.id, request.id));

    const errorSpy = vi.spyOn(console, "error");
    await reconcile(db, stubEngine(jobResult(engineJobId, rejectedPrecalcPoint())), { jobIds: [job.id], skipFailedRecovery: true });

    // 1. Canonical row UNCHANGED: same id, accepted RANS coefficients intact.
    const [row] = await db
      .select()
      .from(results)
      .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, revisionId), eq(results.aoaDeg, GATE_AOA)));
    expect(row.id).toBe(keptId);
    expect(row.cl).toBeCloseTo(0.652, 9);
    expect(row.regime).toBe("rans");
    expect(row.fidelity).toBe("rans");
    expect(row.status).toBe("done");
    expect(row.unsteady).toBe(false);
    // Post-ingest classifier (source of truth) still accepts the kept row.
    const [after] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, keptId));
    expect(after?.state).toBe("accepted");
    // No rejected-attempt media / force history leaked onto the kept row.
    expect(await db.select().from(resultMedia).where(eq(resultMedia.resultId, keptId))).toHaveLength(0);
    expect(await db.select().from(forceHistory).where(eq(forceHistory.resultId, keptId))).toHaveLength(0);

    // 2. Attempt row ingested with the loud quality marker.
    const attempts = await db
      .select()
      .from(resultAttempts)
      .where(and(eq(resultAttempts.simJobId, job.id), eq(resultAttempts.aoaDeg, GATE_AOA)));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].regime).toBe("urans");
    expect(attempts[0].resultId).toBe(keptId);
    const marker = (attempts[0].qualityWarnings ?? []).find((w) => w.startsWith(REPLACE_GUARD_MARKER));
    expect(marker).toBeTruthy();
    expect(marker).toContain("non-stationary");
    expect(marker).toContain("insufficient-periods");
    expect(marker).toContain("kept rans accepted evidence");
    // Engine budget-guard warning persisted verbatim alongside the marker.
    expect((attempts[0].qualityWarnings ?? []).some((w) => w.includes("wall-clock budget guard"))).toBe(true);

    // 3. Evidence artifacts land on the ATTEMPT, never on the kept row (a
    //    rejected manifest on the kept row would poison future re-renders).
    const artifacts = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.resultAttemptId, attempts[0].id));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].resultId).toBeNull();

    // 4. Request + job settle done WITHOUT touching the canonical row.
    const [settledRequest] = await db.select().from(simUransRequests).where(eq(simUransRequests.id, request.id));
    expect(settledRequest.state).toBe("done");
    const [settledJob] = await db.select().from(simJobs).where(eq(simJobs.id, job.id));
    expect(settledJob.status).toBe("done");

    // 5. Loud, never silent.
    const loud = errorSpy.mock.calls.map((c) => c.join(" ")).filter((line) => line.includes("REPLACE GUARD"));
    expect(loud).toHaveLength(1);
    expect(loud[0]).toContain("non-stationary");
    expect(loud[0]).toContain(keptId);
  }, 120000);

  it("accepted-rans cell + ACCEPTING precalc payload → replaced with urans_precalc (normal supersede unchanged)", async () => {
    await cleanCell();
    const keptId = await seedAcceptedRansCell();
    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    const [before] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, keptId));
    expect(before?.state).toBe("accepted");

    const engineJobId = `${PREFIX}-accepting-job`;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "ingesting",
        engineJobId,
        totalCases: 1,
      })
      .returning();
    const r = await ingestResult({
      db,
      engine: stubEngine(),
      engineJobId,
      simJobId: job.id,
      airfoilId,
      speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach }],
      uransFidelity: "precalc",
      result: jobResult(engineJobId, acceptingPrecalcPoint()),
    });
    expect(r.points).toBe(1);

    const [row] = await db
      .select()
      .from(results)
      .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, revisionId), eq(results.aoaDeg, GATE_AOA)));
    expect(row.id).toBe(keptId); // natural-key upsert reuses the cell row
    expect(row.fidelity).toBe("urans_precalc");
    expect(row.regime).toBe("urans");
    expect(row.cl).toBeCloseTo(0.71, 9);
    expect(row.unsteady).toBe(true);
    // Shipped media registered for the replacement (video row present).
    const media = await db.select().from(resultMedia).where(eq(resultMedia.resultId, row.id));
    expect(media.some((m) => m.kind === "video")).toBe(true);
  }, 60000);

  it("rejected cell + rejected payload → replaced (any honest evidence beats none; no guard)", async () => {
    await cleanCell();
    // A REJECTED steady cell: converged=false, no steady_history waiver.
    const [seeded] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: GATE_AOA,
        status: "done",
        source: "solved",
        regime: "rans",
        fidelity: "rans",
        reynolds,
        speed: SPEED,
        chord: CHORD,
        mach,
        cl: 0.31,
        cd: 0.4,
        cm: -0.01,
        unsteady: false,
        converged: false,
        stalled: true,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    const [before] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, seeded.id));
    expect(before?.state).toBe("rejected");

    const engineJobId = `${PREFIX}-rejected-over-rejected`;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "ingesting",
        engineJobId,
        totalCases: 1,
      })
      .returning();
    const r = await ingestResult({
      db,
      engine: stubEngine(),
      engineJobId,
      simJobId: job.id,
      airfoilId,
      speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach }],
      uransFidelity: "precalc",
      result: jobResult(engineJobId, rejectedPrecalcPoint()),
    });
    expect(r.points).toBe(1);

    const [row] = await db
      .select()
      .from(results)
      .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, revisionId), eq(results.aoaDeg, GATE_AOA)));
    expect(row.fidelity).toBe("urans_precalc");
    expect(row.cl).toBeCloseTo(0.689, 9);
    expect(row.frameTrack).toMatchObject({ stationary: false, periods_retained: 1.4 });
  }, 60000);

  it("empty cell → normal ingest (guard never blocks first evidence)", async () => {
    await cleanCell();
    const engineJobId = `${PREFIX}-empty-cell`;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "ingesting",
        engineJobId,
        totalCases: 1,
      })
      .returning();
    const r = await ingestResult({
      db,
      engine: stubEngine(),
      engineJobId,
      simJobId: job.id,
      airfoilId,
      speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach }],
      uransFidelity: "precalc",
      result: jobResult(engineJobId, rejectedPrecalcPoint()),
    });
    expect(r.points).toBe(1);
    const [row] = await db
      .select()
      .from(results)
      .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, revisionId), eq(results.aoaDeg, GATE_AOA)));
    expect(row).toBeTruthy();
    expect(row.fidelity).toBe("urans_precalc");
  }, 60000);

  it("FALSE-POSITIVE GUARD: a needs_urans existing row is protected like accepted, never treated as rejected", async () => {
    await cleanCell();
    const keptId = await seedAcceptedRansCell();
    // needs_urans is a polar-shape verdict; stamp it directly (provisional
    // accepted evidence — it feeds the fit exactly like accepted).
    await db.insert(resultClassifications).values({
      resultId: keptId,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: GATE_AOA,
      regime: "rans",
      classifierVersion: "fidelity-ladder-v4",
      state: "needs_urans",
      region: "post_stall",
      confidence: 0.9,
      reasons: ["lift-slope-collapse", "drag-acceleration"],
    });

    const engineJobId = `${PREFIX}-needs-urans-cell`;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "ingesting",
        engineJobId,
        totalCases: 1,
      })
      .returning();
    const r = await ingestResult({
      db,
      engine: stubEngine(),
      engineJobId,
      simJobId: job.id,
      airfoilId,
      speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach }],
      uransFidelity: "precalc",
      result: jobResult(engineJobId, rejectedPrecalcPoint()),
    });
    expect(r.points).toBe(0);
    expect(r.attempts).toBe(1);

    const [row] = await db
      .select()
      .from(results)
      .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, revisionId), eq(results.aoaDeg, GATE_AOA)));
    expect(row.id).toBe(keptId);
    expect(row.cl).toBeCloseTo(0.652, 9);
    expect(row.fidelity).toBe("rans");
    const attempts = await db
      .select()
      .from(resultAttempts)
      .where(and(eq(resultAttempts.simJobId, job.id), eq(resultAttempts.aoaDeg, GATE_AOA)));
    expect(attempts).toHaveLength(1);
    expect((attempts[0].qualityWarnings ?? []).some((w) => w.startsWith(REPLACE_GUARD_MARKER) && w.includes("kept rans needs_urans evidence"))).toBe(true);
  }, 60000);

  it("MUST-CATCH warm-start duplicate: the attempts[] copy of a guarded point never re-attaches its manifest to the kept row", async () => {
    // The engine's warm-start march ships every point ALSO in
    // polars[].attempts (same evidence_artifacts, same storageKey+sha256 —
    // pinned by test_unsteady.py's honest-points contract). The artifact
    // upsert conflicts on (storageKey, sha256) and its SET rewrites resultId,
    // so without the guardedAoas isolation the attempts-loop registration
    // overwrites the guard's deliberate resultId:null with the KEPT row id —
    // re-poisoning manifestEvidenceBaseForResult for the accepted row.
    await cleanCell();
    const keptId = await seedAcceptedRansCell();
    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    const [before] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, keptId));
    expect(before?.state).toBe("accepted");

    const engineJobId = `${PREFIX}-warmstart-dup`;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "ingesting",
        engineJobId,
        totalCases: 1,
      })
      .returning();
    // Unique artifact identity for THIS test (the suite's other payloads
    // share a storageKey+sha; the upsert would fold them into one row and
    // hide this test's engineJobId) — but IDENTICAL between the point and
    // its warm-start attempt duplicate, which is the conflict under test.
    const dupArtifact = () => [
      {
        kind: "manifest",
        path: `/jobs/${engineJobId}/files/evidence/a0/evidence_manifest.json`,
        url: `/jobs/${engineJobId}/files/evidence/a0/evidence_manifest.json`,
        mime_type: "application/json",
        sha256: `sha-${PREFIX}-warmstart-dup-manifest`,
        byte_size: 128,
        metadata: { evidenceBase: "/tmp/evidence/a0" },
      },
    ];
    const point = { ...rejectedPrecalcPoint(), evidence_artifacts: dupArtifact() } as PolarPoint;
    const duplicate = { ...rejectedPrecalcPoint(), evidence_artifacts: dupArtifact() } as PolarPoint;
    const result: JobResult = {
      job_id: engineJobId,
      state: "completed",
      polars: [
        {
          speed: SPEED,
          chord: CHORD,
          reynolds,
          mach,
          points: [point],
          // Warm-start duplicate: the SAME outcome shipped as attempt evidence.
          attempts: [duplicate],
        },
      ],
    };
    const r = await ingestResult({
      db,
      engine: stubEngine(),
      engineJobId,
      simJobId: job.id,
      airfoilId,
      speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach }],
      uransFidelity: "precalc",
      result,
    });
    expect(r.points).toBe(0);
    expect(r.attempts).toBe(2); // guarded point + its warm-start duplicate

    // Canonical row untouched.
    const [row] = await db
      .select()
      .from(results)
      .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, revisionId), eq(results.aoaDeg, GATE_AOA)));
    expect(row.id).toBe(keptId);
    expect(row.fidelity).toBe("rans");

    // The manifest artifact (single row after the storageKey+sha upsert)
    // must NOT carry the kept row's id — resultId stays NULL, the attempt
    // owns the evidence.
    const artifacts = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.engineJobId, engineJobId));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].resultId).toBeNull();
    expect(artifacts[0].resultAttemptId).not.toBeNull();
  }, 60000);

  it("REJECTED verify solve: guard keeps the accepted precalc row and reconcile cancels the queue item (never silently supersedes)", async () => {
    // Interaction pinned here because no other suite exercises it: a FULL
    // verify solve that would fail the evidence gate must not replace the
    // accepted precalc row (guard), and the verify item must settle
    // terminally via reconcile's verified-row-is-the-judge check (kept row
    // is not urans_full → cancelled loudly, canonical untouched).
    await cleanCell();
    // Accepted PRECALC cell with REAL evidence rows (video + force history)
    // so the v4 classifier accepts it through the urans gate.
    const [precalcRow] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: GATE_AOA,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        reynolds,
        speed: SPEED,
        chord: CHORD,
        mach,
        cl: 0.7,
        cd: 0.2,
        cm: -0.03,
        clCd: 3.5,
        unsteady: true,
        converged: true,
        stalled: true,
        strouhal: 0.118,
        frameTrack: frameTrackFixture(),
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    const keptId = precalcRow.id;
    await db.insert(resultMedia).values({
      resultId: keptId,
      kind: "video",
      field: "velocity_magnitude",
      role: "instantaneous",
      storageKey: `${PREFIX}/verify-cancel/velocity_magnitude.mp4`,
      mimeType: "video/mp4",
    });
    await db.insert(forceHistory).values({
      resultId: keptId,
      t: [0, 0.1, 0.2],
      cl: [0.68, 0.72, 0.7],
      cd: [0.19, 0.21, 0.2],
    });
    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    const [before] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, keptId));
    expect(before?.state).toBe("accepted");

    const [item] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: GATE_AOA,
        state: "running",
        precalcResultId: keptId,
      })
      .returning();
    const engineJobId = `${PREFIX}-verify-cancel`;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "submitted",
        engineJobId,
        totalCases: 1,
        requestPayload: {
          speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach }],
          aoas: [GATE_AOA],
          uransFidelity: "full",
          verifyQueueItemId: item.id,
          verifyPrecalc: { cl: 0.7, cd: 0.2, cm: -0.03 },
        },
      })
      .returning();

    // Guard-rejecting FULL payload: budget guard stopped at 1.4 periods
    // (full bar is 5) — same incident shape, full tier.
    const rejectedFull = { ...rejectedPrecalcPoint(), fidelity: "urans_full" } as PolarPoint;
    const errorSpy = vi.spyOn(console, "error");
    await reconcile(db, stubEngine(jobResult(engineJobId, rejectedFull)), { jobIds: [job.id], skipFailedRecovery: true });

    // Canonical precalc row untouched and still accepted.
    const [row] = await db
      .select()
      .from(results)
      .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, revisionId), eq(results.aoaDeg, GATE_AOA)));
    expect(row.id).toBe(keptId);
    expect(row.fidelity).toBe("urans_precalc");
    expect(row.cl).toBeCloseTo(0.7, 9);
    const [after] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, keptId));
    expect(after?.state).toBe("accepted");

    // Verify item settled terminally: cancelled, pointing at the kept row.
    const [settledItem] = await db.select().from(simUransVerifyQueue).where(eq(simUransVerifyQueue.id, item.id));
    expect(settledItem.state).toBe("cancelled");
    expect(settledItem.verifyResultId).toBe(keptId);
    const [settledJob] = await db.select().from(simJobs).where(eq(simJobs.id, job.id));
    expect(settledJob.status).toBe("done");

    // Loud on both sides: the guard line AND the verify-cancel line.
    const lines = errorSpy.mock.calls.map((c) => c.join(" "));
    expect(lines.some((l) => l.includes("REPLACE GUARD"))).toBe(true);
    expect(lines.some((l) => l.includes("verify solve did not complete"))).toBe(true);
  }, 120000);

  it("DRIFT FAIL-SAFETY: pre-gate ACCEPT with post-time media loss flips the cell honestly via the post-classifier; the guard never resurrects, never engages", async () => {
    // The one pre/post divergence the guard cannot see: the pre-gate judges
    // media on what the payload SHIPS; the post-classifier judges the media
    // ROWS. Within one ingest these agree (registerShippedMedia persists the
    // same shipment), so a pre-ACCEPT payload replaces the cell exactly like
    // before the guard. If the media rows are later lost, the next refresh
    // honestly flips the cell to rejected {missing-urans-video} — the
    // post-classifier stays the source of truth for the canonical row; the
    // guard is advisory at ingest time only and never rewrites history. The
    // superseded RANS evidence survives as attempt history in prod (every
    // ingest inserts a result_attempts row), not on the canonical row.
    await cleanCell();
    await seedAcceptedRansCell();
    await refreshPolarCacheForRevision(db, airfoilId, revisionId);

    const engineJobId = `${PREFIX}-drift-probe`;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "ingesting",
        engineJobId,
        totalCases: 1,
      })
      .returning();
    const errorSpy = vi.spyOn(console, "error");
    const r = await ingestResult({
      db,
      engine: stubEngine(),
      engineJobId,
      simJobId: job.id,
      airfoilId,
      speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach }],
      uransFidelity: "precalc",
      result: jobResult(engineJobId, acceptingPrecalcPoint()),
    });
    expect(r.points).toBe(1); // pre-gate ACCEPT: guard steps aside, normal supersede
    expect(errorSpy.mock.calls.map((c) => c.join(" ")).filter((l) => l.includes("REPLACE GUARD"))).toHaveLength(0);

    const [row] = await db
      .select()
      .from(results)
      .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, revisionId), eq(results.aoaDeg, GATE_AOA)));
    expect(row.fidelity).toBe("urans_precalc");
    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    const [fresh] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, row.id));
    expect(fresh?.state).toBe("accepted"); // within-ingest pre/post parity

    // Post-time media loss (the drift): video row gone at the next refresh.
    await db.delete(resultMedia).where(eq(resultMedia.resultId, row.id));
    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    const [drifted] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, row.id));
    expect(drifted?.state).toBe("rejected");
    expect(drifted?.reasons ?? []).toContain("missing-urans-video");
    // Honest flip, no silent resurrection: the canonical row keeps the
    // superseding evidence; the old RANS values are attempt history only.
    const [rowAfter] = await db.select().from(results).where(eq(results.id, row.id));
    expect(rowAfter.fidelity).toBe("urans_precalc");
    expect(rowAfter.cl).toBeCloseTo(0.71, 9);
  }, 60000);

  it("pre-classification mirrors the classifier's pointwise gate on the incident payload", () => {
    const derivedRejected = {
      fidelity: "urans_precalc" as const,
      frameTrack: rejectedPrecalcPoint().frame_track,
      steadyHistory: null,
      error: null,
    };
    expect(incomingRejectionReasons(rejectedPrecalcPoint(), derivedRejected).sort()).toEqual([
      "insufficient-periods",
      "non-stationary",
    ]);
    const derivedAccepting = { ...derivedRejected, frameTrack: acceptingPrecalcPoint().frame_track };
    expect(incomingRejectionReasons(acceptingPrecalcPoint(), derivedAccepting)).toEqual([]);
    // Media gates evaluate against the SHIPMENT: dropping the video from an
    // otherwise-accepting payload rejects it.
    const noVideo = { ...acceptingPrecalcPoint(), video: {} };
    expect(incomingRejectionReasons(noVideo, derivedAccepting)).toEqual(["missing-urans-video"]);
  });
});
