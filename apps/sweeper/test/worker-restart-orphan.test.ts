// MUST-CATCH suite for the 2026-07-04 production incident: the engine's
// worker-boot orphan reconciliation (src/airfoilfoam/storage.py) marks jobs
// killed by a worker-container restart as state=failed with the pinned
// message "worker restarted mid-solve; task lost". The sweeper's failed-job
// ingest then terminal-failed 12 campaign points (+3 symmetry mirrors) with
// EMPTY error text — infrastructure interruption presented as fake failure
// evidence ("15 failed", errorClass 'unknown').
//
// Scenario A (orphan): a batched campaign job dies mid-solve with a partial
// result (1 solved case, 2 unsolved). Required behavior: the solved case
// ingests as real done evidence, the unsolved claims are RELEASED back to
// pending (re-claimable next tick), ZERO results rows are failed, the
// campaign failed counter stays 0, and the sim_job terminates 'cancelled'
// with a truthful message.
//
// Scenario B (genuine failure): the same batched shape but a REAL engine
// failure message must still terminal-fail the rows — WITH the message
// stamped into results.error, so the campaign failures endpoint classifies
// it by text instead of 'unknown'.
//
// Follows the campaign-batching.test.ts live-DB pattern (scoped rows, full
// cleanup in afterAll).

import {
  airfoils,
  boundaryProfiles,
  campaignFailures,
  categories,
  createClient,
  findCampaignGapBatch,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  results,
  simCampaignPoints,
  simCampaignProgress,
  simJobs,
  solverProfiles,
  sweeperState,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import {
  WORKER_RESTART_ORPHAN_MESSAGE,
  type EngineClient,
  type JobResult,
  type JobStatus,
  type PolarRequest,
} from "@aerodb/engine-client";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConditionMapEntry } from "../src/ingest";
import { submitCampaignBatch } from "../src/loop";
import { reconcile } from "../src/reconcile";
import { withExactManifestEvidence } from "./exact-result-fixture";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-orphan-${process.pid}-${Date.now().toString(36)}`;

const ANGLES = [6, 7, 8];
// File-unique chord: reference_geometry_profiles dedupe on canonical physical
// keys, so sharing 0.2/1 with campaign-batching.test.ts entangles the two
// parallel files' fixture graphs (the F9 flake). Every campaign-launching
// suite must pick a chord no other suite uses.
const CHORD = 0.19;
const SOLVED_AOA = 6;
const NU = 1.789e-5 / 1.225;

let orphanCampaignId = "";
let genuineCampaignId = "";
let airfoilId = "";
let categoryId = "";
let mediumId = "";
const profileIds = { boundary: "", mesh: "", solver: "", output: "" };
let restoreSweeperEnabled: boolean | null = null;

const camberedPoints = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

function conditionMapOf(payload: unknown): ConditionMapEntry[] {
  return ((payload as { conditionMap?: ConditionMapEntry[] })?.conditionMap ??
    []) as ConditionMapEntry[];
}

async function launchCampaign(
  name: string,
  speed: number,
  idemKey: string,
): Promise<string> {
  const launch = await materializeCampaignLaunch(db, {
    name,
    priority: 8,
    idempotencyKey: idemKey,
    airfoilIds: [airfoilId],
    plan: {
      mediumId,
      ambients: [[288.15, 101325]],
      speedsMps: [speed],
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
  return launch.campaign.id;
}

async function composeAndSubmit(
  campaignId: string,
  engineJobId: string,
): Promise<{ jobId: string; entry: ConditionMapEntry }> {
  const batch = (await findCampaignGapBatch(db, {
    limit: 500,
    campaignIds: [campaignId],
  }))!;
  expect(batch).not.toBeNull();
  const composeEngine = {
    submitPolar: async (request: PolarRequest): Promise<JobStatus> => ({
      job_id: engineJobId,
      state: "pending",
      total_cases: request.aoa?.angles?.length ?? ANGLES.length,
      completed_cases: 0,
    }),
  } as unknown as EngineClient;
  const submitted = await submitCampaignBatch(db, composeEngine, batch, 0, 0);
  expect(submitted).toBe(true);
  const [job] = await db
    .select()
    .from(simJobs)
    .where(
      and(
        eq(simJobs.campaignId, campaignId),
        eq(simJobs.engineJobId, engineJobId),
      ),
    );
  expect(job).toBeTruthy();
  const entries = conditionMapOf(job.requestPayload);
  expect(entries.length).toBe(1);
  return { jobId: job.id, entry: entries[0] };
}

beforeAll(async () => {
  const [state] = await db
    .select({ enabled: sweeperState.enabled })
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .limit(1);
  restoreSweeperEnabled = state?.enabled ?? false;
  await db
    .insert(sweeperState)
    .values({ id: 1, enabled: false })
    .onConflictDoUpdate({ target: sweeperState.id, set: { enabled: false } });

  const [cat] = await db
    .insert(categories)
    .values({
      slug: `${PREFIX}-cat`,
      name: `${PREFIX} cat`,
      path: `${PREFIX}-cat`,
      depth: 0,
    })
    .returning();
  categoryId = cat.id;
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-cambered`,
      name: `${PREFIX} cambered`,
      categoryId: cat.id,
      points: camberedPoints,
      isSymmetric: false,
    })
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
      kinematicViscosity: NU,
      speedOfSound: 340.3,
    })
    .returning();
  mediumId = medium.id;
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` })
    .returning();
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` })
    .returning();
  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` })
    .returning();
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` })
    .returning();
  profileIds.boundary = boundary.id;
  profileIds.mesh = mesh.id;
  profileIds.solver = solver.id;
  profileIds.output = output.id;
});

afterAll(async () => {
  // Campaign fixture graph (evidence → jobs → campaigns → presets → guarded
  // find-or-create registry rows → sweeps) is owned by the shared helper —
  // registry rows are canonical-key deduped and can be referenced by parallel
  // suites, so hand-rolled unconditional deletes flake (DecisionHistory F9).
  await cleanupCampaignFixtures(db, {
    campaignIds: [orphanCampaignId, genuineCampaignId],
    presetSlugPrefix: `campaign-${PREFIX.toLowerCase()}`,
  });
  if (profileIds.boundary)
    await db
      .delete(boundaryProfiles)
      .where(eq(boundaryProfiles.id, profileIds.boundary));
  if (profileIds.mesh)
    await db.delete(meshProfiles).where(eq(meshProfiles.id, profileIds.mesh));
  if (profileIds.solver)
    await db
      .delete(solverProfiles)
      .where(eq(solverProfiles.id, profileIds.solver));
  if (profileIds.output)
    await db
      .delete(outputProfiles)
      .where(eq(outputProfiles.id, profileIds.output));
  if (mediumId) await db.delete(mediums).where(eq(mediums.id, mediumId));
  if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
  if (categoryId)
    await db.delete(categories).where(eq(categories.id, categoryId));
  if (restoreSweeperEnabled !== null) {
    await db
      .insert(sweeperState)
      .values({ id: 1, enabled: restoreSweeperEnabled })
      .onConflictDoUpdate({
        target: sweeperState.id,
        set: { enabled: restoreSweeperEnabled },
      });
  }
  await sql.end();
});

describe("worker-restart orphan: interrupted campaign points release, never fail", () => {
  it("ingests solved partial evidence, releases the rest, fails NOTHING, campaign failed counter stays 0", async () => {
    orphanCampaignId = await launchCampaign(
      `${PREFIX} orphan campaign`,
      10,
      `${PREFIX}-orphan-key`,
    );
    const { jobId, entry } = await composeAndSubmit(
      orphanCampaignId,
      `${PREFIX}-orphan-engine-job`,
    );

    // The engine's worker-boot reconciliation shape: status AND result both
    // state=failed with the pinned orphan message; the partial result keeps
    // the one case solved before the restart (jobs.py writes points only for
    // reached cases — the two unsolved angles simply are not in the file).
    const partial: JobResult = {
      job_id: `${PREFIX}-orphan-engine-job`,
      state: "failed",
      message: WORKER_RESTART_ORPHAN_MESSAGE,
      polars: [
        {
          speed: 10,
          chord: CHORD,
          reynolds: Math.round((10 * CHORD) / NU),
          mach: 10 / 340.3,
          points: [
            {
              aoa_deg: SOLVED_AOA,
              cl: 0.5,
              cd: 0.02,
              cm: -0.02,
              cl_cd: 25,
              unsteady: false,
              converged: true,
              first_order_fallback: false,
              images: {},
            },
          ],
        },
      ],
    };
    const orphanEngine = {
      getQueue: async () => {
        throw new Error("queue unavailable in test");
      },
      getJob: async (): Promise<JobStatus> => ({
        job_id: `${PREFIX}-orphan-engine-job`,
        state: "failed",
        total_cases: ANGLES.length,
        completed_cases: 1,
        message: WORKER_RESTART_ORPHAN_MESSAGE,
      }),
      getResult: async () => withExactManifestEvidence(partial),
    } as unknown as EngineClient;

    await reconcile(db, orphanEngine, {
      jobIds: [jobId],
      skipFailedRecovery: true,
    });

    // Solved case: real evidence, kept.
    const rows = await db
      .select({
        aoaDeg: results.aoaDeg,
        status: results.status,
        simJobId: results.simJobId,
        engineJobId: results.engineJobId,
        cl: results.cl,
        error: results.error,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, entry.revisionId),
        ),
      )
      .orderBy(asc(results.aoaDeg));
    expect(rows.map((r) => r.aoaDeg)).toEqual(ANGLES);
    const solved = rows[0];
    expect(solved.status).toBe("done");
    expect(solved.cl).toBeCloseTo(0.5, 8);
    // Unsolved claims: RELEASED (pending, refs nulled) — re-claimable, not failed.
    for (const released of rows.slice(1)) {
      expect(released.status).toBe("pending");
      expect(released.simJobId).toBeNull();
      expect(released.engineJobId).toBeNull();
      expect(released.cl).toBeNull();
    }
    // The incident invariant: ZERO failed evidence rows from a worker restart.
    expect(rows.filter((r) => r.status === "failed").length).toBe(0);

    // The sim_job terminates truthfully: cancelled with the release message,
    // never 'failed' — infrastructure interruption is not failure evidence.
    const [job] = await db
      .select({
        status: simJobs.status,
        engineState: simJobs.engineState,
        error: simJobs.error,
        finishedAt: simJobs.finishedAt,
      })
      .from(simJobs)
      .where(eq(simJobs.id, jobId));
    expect(job.status).toBe("cancelled");
    expect(job.engineState).toBe("cancelled");
    expect(job.error).toBe(
      "worker restarted mid-solve; points released for re-solve",
    );
    expect(job.finishedAt).not.toBeNull();

    // Campaign points: solved angle terminal-linked, interrupted angles stay
    // 'requested' (the "15 failed" incident showed them terminal-failed).
    const points = await db
      .select({
        aoaDeg: simCampaignPoints.aoaDeg,
        state: simCampaignPoints.state,
        resultId: simCampaignPoints.resultId,
      })
      .from(simCampaignPoints)
      .where(eq(simCampaignPoints.campaignId, orphanCampaignId))
      .orderBy(asc(simCampaignPoints.aoaDeg));
    expect(points.length).toBe(ANGLES.length);
    expect(points[0].state).toBe("terminal");
    expect(points[0].resultId).not.toBeNull();
    for (const point of points.slice(1)) {
      expect(point.state).toBe("requested");
    }

    // Campaign counters: failed MUST be 0 (it read 15 in prod), solved 1.
    const [progress] = await db
      .select()
      .from(simCampaignProgress)
      .where(
        and(
          eq(simCampaignProgress.campaignId, orphanCampaignId),
          eq(simCampaignProgress.airfoilId, airfoilId),
        ),
      );
    expect(progress).toBeTruthy();
    expect(progress.failed).toBe(0);
    expect(progress.solved).toBe(1);
    expect(progress.requested).toBe(ANGLES.length);

    // And the failures endpoint agrees: nothing failed for this campaign.
    const failures = await campaignFailures(db, orphanCampaignId);
    expect(failures.total).toBe(0);

    // Recall check: the released points are re-claimable on the next tick.
    const rebatch = await findCampaignGapBatch(db, {
      limit: 500,
      campaignIds: [orphanCampaignId],
    });
    expect(rebatch).not.toBeNull();
    expect(rebatch!.angles).toEqual(ANGLES.slice(1));
  }, 120000);

  it("still terminal-fails a GENUINE engine failure — with the message stamped, classing by text (not 'unknown')", async () => {
    const MSG = "MeshError: snappyHexMesh exited 1 during layer addition";
    genuineCampaignId = await launchCampaign(
      `${PREFIX} genuine campaign`,
      20,
      `${PREFIX}-genuine-key`,
    );
    const { jobId, entry } = await composeAndSubmit(
      genuineCampaignId,
      `${PREFIX}-genuine-engine-job`,
    );

    const genuineEngine = (engineJobId: string): EngineClient =>
      ({
        getQueue: async () => {
          throw new Error("queue unavailable in test");
        },
        getJob: async (): Promise<JobStatus> => ({
          job_id: engineJobId,
          state: "failed",
          total_cases: ANGLES.length,
          completed_cases: 0,
          message: MSG,
        }),
        // tasks.py exception path: failed result with a message and no polars.
        getResult: async (): Promise<JobResult> => ({
          job_id: engineJobId,
          state: "failed",
          message: MSG,
          polars: [],
        }),
      }) as unknown as EngineClient;

    await reconcile(db, genuineEngine(`${PREFIX}-genuine-engine-job`), {
      jobIds: [jobId],
      skipFailedRecovery: true,
    });

    // Amendment B (auto-retry-once): the FIRST genuine crash requeues the
    // cells — pending with the marker and the engine message kept as evidence.
    const firstRows = await db
      .select({
        status: results.status,
        error: results.error,
        autoRetriedAt: results.autoRetriedAt,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, entry.revisionId),
        ),
      );
    expect(firstRows.length).toBe(ANGLES.length);
    for (const row of firstRows) {
      expect(row.status).toBe("pending");
      expect(row.autoRetriedAt).not.toBeNull();
      expect(row.error).toBe(MSG);
    }

    // The SECOND crash exhausts the automatic retry: rows terminal-fail WITH
    // the engine message — never empty.
    const { jobId: secondJobId } = await composeAndSubmit(
      genuineCampaignId,
      `${PREFIX}-genuine-engine-job-2`,
    );
    await reconcile(db, genuineEngine(`${PREFIX}-genuine-engine-job-2`), {
      jobIds: [secondJobId],
      skipFailedRecovery: true,
    });

    const rows = await db
      .select({ status: results.status, error: results.error })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, entry.revisionId),
        ),
      );
    expect(rows.length).toBe(ANGLES.length);
    for (const row of rows) {
      expect(row.status).toBe("failed");
      expect(row.error).toBe(MSG);
    }

    const [progress] = await db
      .select()
      .from(simCampaignProgress)
      .where(
        and(
          eq(simCampaignProgress.campaignId, genuineCampaignId),
          eq(simCampaignProgress.airfoilId, airfoilId),
        ),
      );
    expect(progress.failed).toBe(ANGLES.length);

    // Failures endpoint: classified by the stamped text ('mesh'), NOT 'unknown'.
    const failures = await campaignFailures(db, genuineCampaignId);
    expect(failures.total).toBe(ANGLES.length);
    expect(failures.groups.length).toBe(1);
    expect(failures.groups[0].errorClass).toBe("mesh");
    expect(failures.groups[0].errorClass).not.toBe("unknown");
    for (const sample of failures.groups[0].samples) {
      expect((sample.error ?? "").trim().length).toBeGreaterThan(0);
    }
  }, 120000);
});
