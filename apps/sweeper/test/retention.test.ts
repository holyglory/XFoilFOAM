import { URANS_BUDGET_STOP_MARKER } from "@aerodb/core";
import {
  airfoils,
  boundaryProfiles,
  categories,
  createClient,
  flowConditions,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  referenceGeometryProfiles,
  resultClassifications,
  resultAttempts,
  results,
  simCampaignConditions,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligations,
  simulationPresets,
  simUransRequests,
  solverProfiles,
  sweepDefinitions,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import { EngineError, type EngineClient } from "@aerodb/engine-client";
import { eq, inArray, like, sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runOrphanSweep, stripTerminalJobs } from "../src/retention";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-retention-${process.pid}-${Date.now().toString(36)}`;
const CHORD = 0.337;
const SPEED = 22;
const NU = 1.789e-5 / 1.225;
const OLD = new Date("2026-07-10T00:00:00.000Z");
const NOW = new Date("2026-07-10T02:00:00.000Z");

let campaignId = "";
let airfoilId = "";
let categoryId = "";
let mediumId = "";
let revisionId = "";
let bcId = "";
const profileIds = { boundary: "", mesh: "", solver: "", output: "" };
let nextAoa = 1000;

interface StripCall {
  jobId: string;
  keepCaseState: boolean | undefined;
}

// Shared test DB: other suites' terminal sim_jobs are legitimate reaper
// candidates (correct prod behavior), so observations must be scoped to this
// file's fixture jobs; foreign OLD leftovers are pre-stamped in beforeAll and
// fresh concurrent rows are excluded by the 30-min age gate.
const THIRTY_MIN = 30 * 60 * 1000;
function own<T extends { jobId: string } | string>(calls: T[]): T[] {
  return calls.filter((c) =>
    (typeof c === "string" ? c : c.jobId).startsWith(PREFIX),
  );
}

function fakeEngine(
  opts: {
    strip?: (
      jobId: string,
      keepCaseState: boolean | undefined,
    ) => Promise<{
      bytes_freed: number;
      files_removed: number;
      kept_case_state: boolean;
    }>;
    maintenanceJobs?: {
      items: { job_id: string; mtime_epoch: number; bytes: number | null }[];
    };
    disk?: { total_bytes: number; free_bytes: number; used_pct: number };
    deleteBytes?: Record<string, number>;
  } = {},
): EngineClient & { stripCalls: StripCall[]; deleteCalls: string[] } {
  const stripCalls: StripCall[] = [];
  const deleteCalls: string[] = [];
  return {
    stripCalls,
    deleteCalls,
    stripJob: async (
      jobId: string,
      request: { keep_case_state?: boolean } = {},
    ) => {
      stripCalls.push({ jobId, keepCaseState: request.keep_case_state });
      if (opts.strip) return opts.strip(jobId, request.keep_case_state);
      return {
        bytes_freed: request.keep_case_state ? 1024 : 2048,
        files_removed: request.keep_case_state ? 1 : 2,
        kept_case_state: Boolean(request.keep_case_state),
      };
    },
    maintenanceDisk: async () =>
      opts.disk ?? { total_bytes: 1000, free_bytes: 250, used_pct: 75 },
    maintenanceJobs: async () => opts.maintenanceJobs ?? { items: [] },
    deleteJob: async (jobId: string) => {
      deleteCalls.push(jobId);
      return { bytes_freed: opts.deleteBytes?.[jobId] ?? 4096 };
    },
  } as unknown as EngineClient & {
    stripCalls: StripCall[];
    deleteCalls: string[];
  };
}

function aoa(): number {
  nextAoa += 1;
  return nextAoa;
}

async function insertTerminalJob(
  engineJobId: string,
  patch: Partial<typeof simJobs.$inferInsert> = {},
) {
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      referenceChordM: CHORD,
      wave: 2,
      status: "done",
      engineJobId,
      totalCases: 1,
      completedCases: 1,
      ingestedAt: OLD,
      finishedAt: OLD,
      ...patch,
    })
    .returning();
  return job;
}

async function insertClassifiedResult(
  job: typeof simJobs.$inferSelect,
  opts: {
    state: "accepted" | "needs_urans" | "superseded_by_urans" | "rejected";
    fidelity?: string;
    qualityWarnings?: string[];
    engineCaseSlug?: string | null;
    regime?: "rans" | "urans";
  },
) {
  const pointAoa = aoa();
  const regime = opts.regime ?? "urans";
  const [row] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: pointAoa,
      status: "done",
      source: "solved",
      regime,
      fidelity: opts.fidelity ?? "urans_precalc",
      reynolds: Math.round((SPEED * CHORD) / NU),
      speed: SPEED,
      chord: CHORD,
      cl: 0.7,
      cd: 0.06,
      cm: -0.04,
      unsteady: regime === "urans",
      converged: true,
      simJobId: job.id,
      engineJobId: job.engineJobId,
      engineCaseSlug: opts.engineCaseSlug ?? `aoa_${pointAoa}`,
      qualityWarnings: opts.qualityWarnings,
      solvedAt: OLD,
    })
    .returning();
  await db.insert(resultClassifications).values({
    resultId: row.id,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg: pointAoa,
    regime,
    classifierVersion: "retention-test",
    state: opts.state,
    region: "post_stall",
    confidence: 0.9,
    reasons: opts.state === "rejected" ? ["insufficient-periods"] : [],
  });
  return row;
}

async function readJob(id: string) {
  const [row] = await db
    .select()
    .from(simJobs)
    .where(eq(simJobs.id, id))
    .limit(1);
  if (!row) throw new Error(`missing job ${id}`);
  return row;
}

beforeAll(async () => {
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
      slug: `${PREFIX}-foil`,
      name: `${PREFIX} foil`,
      categoryId: cat.id,
      points: [
        { x: 1, y: 0 },
        { x: 0.5, y: 0.08 },
        { x: 0, y: 0 },
        { x: 0.5, y: -0.04 },
        { x: 1, y: 0 },
      ],
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

  const launch = await materializeCampaignLaunch(db, {
    name: `${PREFIX} campaign`,
    priority: 6,
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
      baseSweep: {
        fromDeg: null,
        toDeg: null,
        stepDeg: null,
        listDeg: [0, 1, 2],
      },
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
  const [condition] = await db
    .select()
    .from(simCampaignConditions)
    .where(eq(simCampaignConditions.campaignId, campaignId))
    .limit(1);
  revisionId = condition.simulationPresetRevisionId;
  const [preset] = await db
    .select({
      legacyBoundaryConditionId: simulationPresets.legacyBoundaryConditionId,
    })
    .from(simulationPresets)
    .where(eq(simulationPresets.id, condition.presetId))
    .limit(1);
  bcId = preset!.legacyBoundaryConditionId!;
  // Pre-stamp foreign leftover candidates so LIMIT never fills with rows
  // other suites abandoned (their strip stamps are benign metadata).
  await db.execute(dsql`
    UPDATE sim_jobs SET stripped_at = now()
    WHERE stripped_at IS NULL AND status IN ('done', 'failed', 'cancelled')
      AND engine_job_id IS NOT NULL AND engine_job_id NOT LIKE ${PREFIX + "%"}
  `);
});

afterAll(async () => {
  if (revisionId)
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.revisionId, revisionId));
  await cleanupCampaignFixtures(db, {
    campaignIds: [campaignId],
    presetSlugPrefix: `campaign-${PREFIX.toLowerCase()}`,
  });
  const campaignFlowIds = await db
    .select({ id: flowConditions.id })
    .from(flowConditions)
    .where(like(flowConditions.slug, `${PREFIX}%`));
  if (campaignFlowIds.length)
    await db.delete(flowConditions).where(
      inArray(
        flowConditions.id,
        campaignFlowIds.map((r) => r.id),
      ),
    );
  const campaignGeoIds = await db
    .select({ id: referenceGeometryProfiles.id })
    .from(referenceGeometryProfiles)
    .where(like(referenceGeometryProfiles.slug, `${PREFIX}%`));
  if (campaignGeoIds.length)
    await db.delete(referenceGeometryProfiles).where(
      inArray(
        referenceGeometryProfiles.id,
        campaignGeoIds.map((r) => r.id),
      ),
    );
  await db
    .delete(sweepDefinitions)
    .where(like(sweepDefinitions.slug, `campaign-${PREFIX.toLowerCase()}%`));
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
  await sql.end();
});

describe("retention schema", () => {
  it("pins migration 0039 sim_jobs strip columns", async () => {
    const cols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'sim_jobs' AND column_name IN ('stripped_at', 'strip_report')
    `)) as unknown as { column_name: string }[];
    expect(cols.map((c) => c.column_name).sort()).toEqual([
      "strip_report",
      "stripped_at",
    ]);
  });
});

describe("terminal strip reaper", () => {
  it("strips terminal accepted jobs without keeping case state and persists the report", async () => {
    const job = await insertTerminalJob(`${PREFIX}-accepted-strip`);
    await insertClassifiedResult(job, {
      state: "accepted",
      fidelity: "urans_full",
    });
    const engine = fakeEngine();

    await stripTerminalJobs(db, engine, {
      now: NOW,
      stripMinAgeMs: THIRTY_MIN,
      stripMaxPerTick: 500,
    });

    expect(own(engine.stripCalls)).toEqual([
      { jobId: `${PREFIX}-accepted-strip`, keepCaseState: false },
    ]);
    const after = await readJob(job.id);
    expect(after.strippedAt?.toISOString()).toBe(NOW.toISOString());
    expect(after.stripReport).toMatchObject({
      bytes_freed: 2048,
      files_removed: 2,
      kept_case_state: false,
    });
  });

  it("keeps case state for a budget-stop continuable row, then fully strips after supersession", async () => {
    const job = await insertTerminalJob(`${PREFIX}-continuable-strip`);
    const row = await insertClassifiedResult(job, {
      state: "rejected",
      qualityWarnings: [
        `URANS integration ${URANS_BUDGET_STOP_MARKER}: retained 1.2 periods`,
      ],
    });
    const engine = fakeEngine();

    await stripTerminalJobs(db, engine, {
      now: NOW,
      stripMinAgeMs: THIRTY_MIN,
      stripMaxPerTick: 500,
    });
    expect(own(engine.stripCalls)).toEqual([
      { jobId: `${PREFIX}-continuable-strip`, keepCaseState: true },
    ]);
    let after = await readJob(job.id);
    expect(after.stripReport).toMatchObject({ kept_case_state: true });

    await db
      .update(resultClassifications)
      .set({ state: "superseded_by_urans", supersededByResultId: row.id })
      .where(eq(resultClassifications.resultId, row.id));

    await stripTerminalJobs(db, engine, {
      now: new Date(NOW.getTime() + 60_000),
      stripMinAgeMs: THIRTY_MIN,
      stripMaxPerTick: 500,
    });
    expect(own(engine.stripCalls)).toEqual([
      { jobId: `${PREFIX}-continuable-strip`, keepCaseState: true },
      { jobId: `${PREFIX}-continuable-strip`, keepCaseState: false },
    ]);
    after = await readJob(job.id);
    expect(after.stripReport).toMatchObject({ kept_case_state: false });
  });

  it("fully strips an expired continuable-kept job even while the continuable row remains", async () => {
    const terminalAt = new Date("2026-06-01T00:00:00.000Z");
    const job = await insertTerminalJob(`${PREFIX}-continuable-expired`, {
      finishedAt: terminalAt,
      ingestedAt: terminalAt,
      strippedAt: new Date("2026-06-01T01:00:00.000Z"),
      stripReport: {
        bytes_freed: 123,
        files_removed: 4,
        kept_case_state: true,
      },
    });
    await insertClassifiedResult(job, {
      state: "rejected",
      qualityWarnings: [`${URANS_BUDGET_STOP_MARKER}: continuation candidate`],
    });
    const engine = fakeEngine();

    await stripTerminalJobs(db, engine, {
      now: NOW,
      stripMinAgeMs: THIRTY_MIN,
      retentionContinuableDays: 14,
      stripMaxPerTick: 500,
    });

    expect(own(engine.stripCalls)).toEqual([
      { jobId: `${PREFIX}-continuable-expired`, keepCaseState: false },
    ]);
    const after = await readJob(job.id);
    expect(after.stripReport).toMatchObject({ kept_case_state: false });
  });

  it("keeps case state when a live continuation request points at a result of the job", async () => {
    const job = await insertTerminalJob(`${PREFIX}-live-continuation`);
    const source = await insertClassifiedResult(job, {
      state: "accepted",
      fidelity: "urans_full",
    });
    await db.insert(simUransRequests).values({
      airfoilId,
      revisionId,
      aoaDeg: source.aoaDeg,
      fidelity: "precalc",
      state: "pending",
      continueFromResultId: source.id,
    });
    const engine = fakeEngine();

    await stripTerminalJobs(db, engine, {
      now: NOW,
      stripMinAgeMs: THIRTY_MIN,
      stripMaxPerTick: 500,
    });

    expect(own(engine.stripCalls)).toEqual([
      { jobId: `${PREFIX}-live-continuation`, keepCaseState: true },
    ]);
  });

  it("keeps replace-guard PRECALC case state through the exact live obligation attempt", async () => {
    const canonicalJob = await insertTerminalJob(
      `${PREFIX}-replace-guard-rans`,
    );
    const canonical = await insertClassifiedResult(canonicalJob, {
      state: "accepted",
      fidelity: "rans",
      regime: "rans",
    });
    const precalcJob = await insertTerminalJob(
      `${PREFIX}-replace-guard-precalc`,
      {
        requestPayload: {
          aoas: [canonical.aoaDeg],
          uransFidelity: "precalc",
        },
      },
    );
    const [attempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: canonical.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: canonical.aoaDeg,
        simJobId: precalcJob.id,
        engineJobId: precalcJob.engineJobId,
        engineCaseSlug: `aoa_${canonical.aoaDeg}`,
        status: "done",
        source: "solved",
        regime: "urans",
        validForPolar: false,
        cl: 0.73,
        cd: 0.061,
        cm: -0.041,
        clCd: 11.97,
        converged: true,
        unsteady: true,
        qualityWarnings: [
          `${URANS_BUDGET_STOP_MARKER}: rejected PRECALC attempt retains saved case`,
        ],
        evidencePayload: { fidelity: "urans_precalc" },
        solvedAt: OLD,
      })
      .returning();
    await db.insert(resultClassifications).values({
      resultAttemptId: attempt.id,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: canonical.aoaDeg,
      regime: "urans",
      classifierVersion: "retention-precalc-attempt-v1",
      state: "rejected",
      region: "post_stall",
      confidence: 0.8,
      reasons: ["insufficient-periods"],
    });
    const [obligation] = await db
      .insert(simPrecalcObligations)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: canonical.aoaDeg,
        sourceResultId: canonical.id,
        sourceResultAttemptId: attempt.id,
        state: "pending",
        attemptCount: 1,
        latestSimJobId: precalcJob.id,
        lastOutcome: "rejected",
        lastError: "more same-case integration required",
      })
      .returning();
    await db.insert(simPrecalcObligationAttempts).values({
      obligationId: obligation.id,
      simJobId: precalcJob.id,
      attemptNumber: 1,
      state: "rejected",
      outcome: "rejected",
      resultAttemptId: attempt.id,
      error: "more same-case integration required",
      completedAt: OLD,
    });

    const engine = fakeEngine();
    await stripTerminalJobs(db, engine, {
      now: NOW,
      stripMinAgeMs: THIRTY_MIN,
      stripMaxPerTick: 500,
    });

    expect(own(engine.stripCalls)).toEqual(
      expect.arrayContaining([
        { jobId: `${PREFIX}-replace-guard-rans`, keepCaseState: false },
        { jobId: `${PREFIX}-replace-guard-precalc`, keepCaseState: true },
      ]),
    );
    expect(
      own(engine.stripCalls).find(
        (call) => call.jobId === `${PREFIX}-replace-guard-precalc`,
      ),
    ).toEqual({
      jobId: `${PREFIX}-replace-guard-precalc`,
      keepCaseState: true,
    });
    expect((await readJob(precalcJob.id)).stripReport).toMatchObject({
      kept_case_state: true,
    });
  });

  it("leaves 409 jobs unstamped for retry and stamps 404 jobs as no-op", async () => {
    const conflictJob = await insertTerminalJob(`${PREFIX}-strip-409`);
    await insertClassifiedResult(conflictJob, { state: "accepted" });
    let attempts = 0;
    const conflictEngine = fakeEngine({
      strip: async (_jobId, keepCaseState) => {
        attempts += 1;
        if (attempts === 1) throw new EngineError("running", 409);
        return {
          bytes_freed: 8192,
          files_removed: 3,
          kept_case_state: Boolean(keepCaseState),
        };
      },
    });

    await stripTerminalJobs(db, conflictEngine, {
      now: NOW,
      stripMinAgeMs: THIRTY_MIN,
      stripMaxPerTick: 500,
    });
    expect((await readJob(conflictJob.id)).strippedAt).toBeNull();

    await stripTerminalJobs(db, conflictEngine, {
      now: new Date(NOW.getTime() + 60_000),
      stripMinAgeMs: THIRTY_MIN,
      stripMaxPerTick: 500,
    });
    expect(own(conflictEngine.stripCalls).map((c) => c.jobId)).toEqual([
      `${PREFIX}-strip-409`,
      `${PREFIX}-strip-409`,
    ]);
    expect((await readJob(conflictJob.id)).stripReport).toMatchObject({
      bytes_freed: 8192,
    });

    const missingJob = await insertTerminalJob(`${PREFIX}-strip-404`);
    await insertClassifiedResult(missingJob, { state: "accepted" });
    const missingEngine = fakeEngine({
      strip: async () => {
        throw new EngineError("not found", 404);
      },
    });

    await stripTerminalJobs(db, missingEngine, {
      now: NOW,
      stripMinAgeMs: THIRTY_MIN,
      stripMaxPerTick: 500,
    });
    const missingAfter = await readJob(missingJob.id);
    expect(missingAfter.strippedAt?.toISOString()).toBe(NOW.toISOString());
    expect(missingAfter.stripReport).toMatchObject({
      bytes_freed: 0,
      files_removed: 0,
      kept_case_state: false,
      note: "engine job not found",
    });
  });

  it("never strips running, pending, or too-young jobs", async () => {
    const running = await insertTerminalJob(`${PREFIX}-running-never`, {
      status: "running",
    });
    const pending = await insertTerminalJob(`${PREFIX}-pending-never`, {
      status: "pending",
    });
    const young = await insertTerminalJob(`${PREFIX}-young-never`, {
      finishedAt: new Date(NOW.getTime() - 1_000),
      ingestedAt: new Date(NOW.getTime() - 1_000),
    });
    await insertClassifiedResult(running, { state: "accepted" });
    await insertClassifiedResult(pending, { state: "accepted" });
    await insertClassifiedResult(young, { state: "accepted" });
    const engine = fakeEngine();

    await stripTerminalJobs(db, engine, {
      now: NOW,
      stripMinAgeMs: THIRTY_MIN,
      stripMaxPerTick: 500,
    });

    expect(own(engine.stripCalls)).toEqual([]);
    expect((await readJob(running.id)).strippedAt).toBeNull();
    expect((await readJob(pending.id)).strippedAt).toBeNull();
    expect((await readJob(young.id)).strippedAt).toBeNull();
  });
});

describe("orphan sweep", () => {
  it("deletes old unknown engine dirs, keeps young unknown dirs, and never deletes known sim_jobs dirs", async () => {
    await insertTerminalJob(`${PREFIX}-known-engine-dir`);
    const engine = fakeEngine({
      disk: {
        total_bytes: 100 * 1024 ** 3,
        free_bytes: 15 * 1024 ** 3,
        used_pct: 85,
      },
      maintenanceJobs: {
        items: [
          {
            job_id: `${PREFIX}-old-unknown`,
            mtime_epoch: (NOW.getTime() - 72 * 60 * 60 * 1000) / 1000,
            bytes: 10_000,
          },
          {
            job_id: `${PREFIX}-young-unknown`,
            mtime_epoch: (NOW.getTime() - 60 * 60 * 1000) / 1000,
            bytes: 20_000,
          },
          {
            job_id: `${PREFIX}-known-engine-dir`,
            mtime_epoch: (NOW.getTime() - 72 * 60 * 60 * 1000) / 1000,
            bytes: 30_000,
          },
        ],
      },
      deleteBytes: { [`${PREFIX}-old-unknown`]: 5000 },
    });

    const deleted = await runOrphanSweep(db, engine, {
      now: NOW,
      orphanMinAgeMs: 48 * 60 * 60 * 1000,
    });

    expect(deleted).toBe(1);
    expect(engine.deleteCalls).toEqual([`${PREFIX}-old-unknown`]);
  });
});
