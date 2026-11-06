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
// Scenario B (genuine repeated failure): the same batched shape but a REAL
// engine failure must retain the failed evidence and message. After the one
// automatic retry is exhausted it becomes a grouped critical screening
// incident, not a user-terminal failed point or manual-requeue item.
//
// Follows the campaign-batching.test.ts live-DB pattern (scoped rows, full
// cleanup in afterAll).

import "./enabled-engine-pool-fixture";
import { randomUUID } from "node:crypto";

import {
  airfoils,
  boundaryProfiles,
  campaignFailures,
  categories,
  claimProgressiveCfdUnit,
  claimProgressiveWork,
  createClient,
  failProgressiveWork,
  findCampaignGapBatch,
  initializeProgressiveCfdWork,
  materializeCampaignLaunch,
  materializeProgressiveCampaignScope,
  mediums,
  meshProfiles,
  outputProfiles,
  resultAttempts,
  results,
  simCampaignPoints,
  simCampaignProgress,
  simJobs,
  solverIncidentSummary,
  solverProfiles,
  solverCpuReservationSql,
  sweeperState,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import {
  EngineError,
  WORKER_RESTART_ORPHAN_MESSAGE,
  type EngineClient,
  type EngineExecutionStopProof,
  type EngineQueueState,
  type JobRuntimeSummary,
  type JobResult,
  type JobStatus,
  type PolarRequest,
} from "@aerodb/engine-client";
import { and, asc, desc, eq, sql as query } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ConditionMapEntry } from "../src/ingest";
import { submitCampaignBatch } from "../src/loop";
import { reconcile } from "../src/reconcile";
import { composeProgressiveCfdJob } from "../src/progressive-cfd-jobs";
import { claimAoas } from "../src/claim";
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
const progressiveCampaignIds: string[] = [];
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
  const [campaign] = await db.execute(query`SELECT status FROM sim_campaigns
    WHERE id=${campaignId}::uuid`);
  expect(campaign.status).toBe("active");
  const existingJobs = await db
    .select({ id: simJobs.id })
    .from(simJobs)
    .where(eq(simJobs.campaignId, campaignId));
  const existingIds = new Set(existingJobs.map((job) => job.id));
  const batch = (await findCampaignGapBatch(db, {
    limit: 500,
    campaignIds: [campaignId],
  }))!;
  expect(batch).not.toBeNull();
  const submit = vi.fn(
    async (request: PolarRequest): Promise<JobStatus> => ({
      job_id: engineJobId,
      state: "pending",
      total_cases: request.aoa?.angles?.length ?? ANGLES.length,
      completed_cases: 0,
    }),
  );
  const composeEngine = { submitPolar: submit } as unknown as EngineClient;
  const submitted = await submitCampaignBatch(db, composeEngine, batch, 0, 0);
  expect(submitted).toBe(false);
  expect(submit).not.toHaveBeenCalled();
  const composedJobs = await db
    .select()
    .from(simJobs)
    .where(eq(simJobs.campaignId, campaignId));
  const newJobs = composedJobs.filter((job) => !existingIds.has(job.id));
  expect(newJobs).toHaveLength(1);
  const [job] = newJobs;
  expect(job).toMatchObject({
    campaignId,
    status: "cancelled",
    engineState: "cancelled",
    engineJobId: null,
    error: "campaign paused or cancelled before engine submission",
  });
  expect(job.finishedAt).toBeInstanceOf(Date);
  expect(job.requestPayload).not.toHaveProperty("progressive");
  expect(
    await db
      .select({ id: results.id })
      .from(results)
      .where(eq(results.simJobId, job.id)),
  ).toEqual([]);
  const entries = conditionMapOf(job.requestPayload);
  expect(entries.length).toBe(1);
  await db
    .update(simJobs)
    .set({
      status: "running",
      engineJobId,
      engineState: "running",
      finishedAt: null,
    })
    .where(eq(simJobs.id, job.id));
  const claimed = await claimAoas(
    db,
    job.airfoilId,
    entries[0].bcId,
    entries[0].revisionId,
    ANGLES,
    job.id,
  );
  expect(claimed).toEqual(ANGLES);
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
    .values({ id: 1, enabled: true })
    .onConflictDoUpdate({ target: sweeperState.id, set: { enabled: true } });

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
    campaignIds: [
      orphanCampaignId,
      genuineCampaignId,
      ...progressiveCampaignIds,
    ],
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

async function progressiveLostJobFixture(stage: 2 | 3 = 2) {
  const identity = randomUUID();
  const campaignId = await launchCampaign(
    `${PREFIX} progressive ${identity}`,
    21.43 + progressiveCampaignIds.length / 100,
    identity,
  );
  progressiveCampaignIds.push(campaignId);
  await materializeProgressiveCampaignScope(db, campaignId);
  const [target] = await db.execute(query`SELECT scope.*, target.physical
    FROM progressive_generation_targets scope
    JOIN progressive_generations generation ON generation.id=scope.generation_id
    JOIN polar_analysis_targets target ON target.id=scope.target_id
    WHERE generation.campaign_id=${campaignId}::uuid AND generation.status='active'
    ORDER BY generation.created_at DESC LIMIT 1`);
  const baseline = await claimProgressiveWork(db, {
    owner: identity,
    stages: [1],
    leaseSeconds: 120,
    baselineGroup: {
      generationId: String(target.generation_id),
      airfoilId,
      geometry: (target.physical as { geometry: number[][] }).geometry,
      recipe: (target.recipes as Record<string, Record<string, unknown>>)
        .neuralfoil,
      maximumAngles: 32768,
    },
  });
  expect(baseline).not.toBeNull();
  await failProgressiveWork(
    db,
    baseline!,
    "isolated unavailable prediction",
    false,
  );
  await initializeProgressiveCfdWork(db, campaignId);
  if (stage === 3) {
    await db.execute(query`UPDATE progressive_cfd_units unit SET state='gap'
      FROM progressive_work work WHERE unit.work_id=work.id
        AND work.generation_id=${target.generation_id}::uuid AND work.stage=2`);
    await db.execute(query`UPDATE progressive_work SET state='complete'
      WHERE generation_id=${target.generation_id}::uuid AND stage=2`);
    await db.execute(query`UPDATE progressive_generations SET stage=3
      WHERE id=${target.generation_id}::uuid`);
    await db.execute(query`UPDATE progressive_generation_cohorts SET stage=3
      WHERE generation_id=${target.generation_id}::uuid`);
    await initializeProgressiveCfdWork(db, campaignId);
  }
  const [pending] =
    await db.execute(query`SELECT unit.recipe, unit.active_budget_seconds
    FROM progressive_cfd_units unit JOIN progressive_work work ON work.id=unit.work_id
    WHERE work.generation_id=${target.generation_id}::uuid AND work.stage=${stage}
    ORDER BY unit.ordinal LIMIT 1`);
  const lease = await claimProgressiveCfdUnit(db, {
    owner: identity,
    leaseSeconds: 120,
    solverBudgetVersion: 2,
    localTimeStepVersion: 1,
    sameTarget: {
      generationId: String(target.generation_id),
      targetId: String(target.target_id),
      recipe: pending.recipe as Record<string, unknown>,
      remainingActiveSeconds: Number(pending.active_budget_seconds),
    },
  });
  expect(lease).not.toBeNull();
  const composed = await composeProgressiveCfdJob(db, [lease!], {
    cpuSlots: 1,
    meshRecoveryVersion: 1,
    solverBudgetVersion: 2,
    localTimeStepVersion: 1,
  });
  await db
    .update(simJobs)
    .set({
      status: "running",
      engineJobId: composed.jobId,
      engineState: "running",
      submittedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    })
    .where(eq(simJobs.id, composed.jobId));
  const inspect = async () => {
    const [row] =
      await db.execute(query`SELECT unit.state, unit.lease_token, unit.attempts,
      attempt.outcome, ${solverCpuReservationSql("job")} AS cpu_reserved,
      (SELECT count(*)::int FROM progressive_cfd_execution_stops WHERE sim_job_id=job.id) AS stop_count
      FROM progressive_cfd_units unit JOIN progressive_cfd_attempts attempt ON attempt.unit_id=unit.id
      JOIN sim_jobs job ON job.id=attempt.sim_job_id WHERE attempt.token=${lease!.token}::uuid`);
    return row;
  };
  const invariant = () =>
    db.execute(query`SELECT scope.recipes, unit.recipe,
    unit.active_budget_seconds, unit.active_seconds
    FROM progressive_generation_targets scope JOIN progressive_work work
      ON work.generation_id=scope.generation_id AND work.target_id=scope.target_id
    JOIN progressive_cfd_units unit ON unit.work_id=work.id
    WHERE unit.id=${lease!.id}::uuid`);
  const evidence = () =>
    db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.simJobId, composed.jobId))
      .orderBy(asc(resultAttempts.id));
  const [placeholder] = await db
    .select()
    .from(results)
    .where(eq(results.simJobId, composed.jobId));
  return {
    ...composed,
    lease: lease!,
    inspect,
    invariant,
    evidence,
    placeholder,
  };
}

function progressiveLostJobEngine(
  fixtures: Array<Awaited<ReturnType<typeof progressiveLostJobFixture>>>,
) {
  const quiet = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const statuses = new Map<string, JobStatus>(
    fixtures.map((fixture) => [
      fixture.jobId,
      {
        job_id: fixture.jobId,
        state: "running",
        phase: "waiting_cpu",
        total_cases: 1,
        completed_cases: 0,
        started_at: quiet,
        updated_at: quiet,
        last_progress_at: quiet,
      } satisfies JobStatus,
    ]),
  );
  const runtimes = new Map<string, JobRuntimeSummary>(
    fixtures.map((fixture) => [
      fixture.jobId,
      {
        job_id: fixture.jobId,
        exists: true,
        cancelled: false,
        process_count: 0,
        runtime_heartbeat_age_sec: 10800,
        status_readable: true,
        result_readable: false,
        has_result: false,
      } satisfies JobRuntimeSummary,
    ]),
  );
  const queue: EngineQueueState = {
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
    worker_queues: [
      {
        worker: "fixture-worker",
        queues: [fixtures[0].request.expected_execution_pool!],
        execution_pool: fixtures[0].request.expected_execution_pool!,
        engine: {
          ...fixtures[0].request.expected_engine!,
          build_id: "progressive-lost-fixture",
          application_source_sha256: "a".repeat(64),
        },
      },
    ],
    inspection_errors: {},
    inspection_workers: {
      active: ["fixture-worker"],
      reserved: ["fixture-worker"],
      scheduled: ["fixture-worker"],
    },
  };
  const proof = (jobId: string): EngineExecutionStopProof => ({
    version: 1,
    job_id: jobId,
    execution_stopped: true,
    producer_stopped: true,
    namespace_verified: true,
    remaining: [],
    error: null,
    fence: "cancel_marker",
    ownership_basis: "recorded_execution_namespace",
    observed_at: new Date().toISOString(),
  });
  const calls = {
    getQueue: vi.fn(async () => queue),
    getJobRuntimes: vi.fn(async (ids: string[]) => ({
      jobs: ids.flatMap((id) => (runtimes.has(id) ? [runtimes.get(id)!] : [])),
    })),
    getJob: vi.fn(async (id: string) => ({ ...statuses.get(id)! })),
    cancelJob: vi.fn(async (id: string) => {
      statuses.set(id, {
        ...statuses.get(id)!,
        state: "cancelled",
        phase: "cancelled",
      });
      return { job_id: id, cancelled: true, execution_stopped: true };
    }),
    getExecutionStopProof: vi.fn(async (id: string) => proof(id)),
    getResult: vi.fn(async () => {
      throw new EngineError("Result not ready (state=cancelled)", 409);
    }),
    submitPolar: vi.fn(),
  };
  return {
    engine: calls as unknown as EngineClient,
    calls,
    queue,
    statuses,
    runtimes,
    proof,
  };
}

describe("progressive background lost-job liveness", () => {
  it("settles only the lost job after exact stop proof and preserves a live precise job", async () => {
    const lost = await progressiveLostJobFixture();
    const precise = await progressiveLostJobFixture(3);
    const state = progressiveLostJobEngine([lost, precise]);
    state.runtimes.get(precise.jobId)!.process_count = 2;
    state.runtimes.get(precise.jobId)!.runtime_heartbeat_age_sec = 5;
    state.statuses.set(precise.jobId, {
      ...state.statuses.get(precise.jobId)!,
      phase: "solving_urans",
    });
    state.queue.job_ids = [precise.jobId];
    state.queue.active = [
      {
        worker: "fixture-worker",
        task_id: precise.jobId,
        name: "airfoilfoam.run_polar",
        job_id: precise.jobId,
        redelivered: false,
      },
    ];
    state.queue.active_count = 1;
    const retained = await lost.invariant();
    const retainedEvidence = await lost.evidence();
    expect(retainedEvidence).toEqual([]);
    const preciseBefore = await precise.inspect();
    const preciseInvariant = await precise.invariant();
    const preciseEvidence = await precise.evidence();
    const preciseCanonical = await db
      .select()
      .from(results)
      .where(eq(results.id, precise.placeholder.id));
    state.calls.getExecutionStopProof.mockImplementationOnce(async (id) => ({
      ...state.proof(id),
      execution_stopped: false,
      producer_stopped: false,
    }));
    const options = {
      jobIds: [lost.jobId, precise.jobId],
      skipFailedRecovery: true,
    };
    await reconcile(db, state.engine, options);
    expect(await lost.inspect()).toMatchObject({
      state: "leased",
      outcome: "running",
      cpu_reserved: true,
      stop_count: 0,
    });
    expect(state.calls.getResult).not.toHaveBeenCalled();
    await reconcile(db, state.engine, options);
    expect(await lost.inspect()).toMatchObject({
      state: "gap",
      lease_token: null,
      outcome: "failed",
      cpu_reserved: false,
      stop_count: 1,
    });
    expect(state.calls.cancelJob.mock.calls.map(([id]) => id)).toEqual([
      lost.jobId,
    ]);
    expect(
      state.calls.getExecutionStopProof.mock.calls.every(
        ([id]) => id === lost.jobId,
      ),
    ).toBe(true);
    expect(state.calls.submitPolar).not.toHaveBeenCalled();
    expect(await lost.invariant()).toEqual(retained);
    expect(await lost.evidence()).toEqual(retainedEvidence);
    const [released] = await db
      .select()
      .from(results)
      .where(eq(results.id, lost.placeholder.id));
    expect(released).toMatchObject({
      status: "pending",
      simJobId: null,
      cl: null,
      cd: null,
      cm: null,
    });
    expect(await precise.inspect()).toEqual(preciseBefore);
    expect(await precise.invariant()).toEqual(preciseInvariant);
    expect(await precise.evidence()).toEqual(preciseEvidence);
    expect(
      await db
        .select()
        .from(results)
        .where(eq(results.id, precise.placeholder.id)),
    ).toEqual(preciseCanonical);
  }, 120_000);

  it.each([
    "live mesh child",
    "live CPU waiter",
    "active task",
    "reserved task",
    "scheduled task",
    "recent progress",
    "fresh physical progress with stale coarse status",
    "queue unavailable",
    "runtime unavailable",
    "partial worker coverage",
    "inspection error",
    "runtime error",
    "missing heartbeat",
    "missing worker inventory",
    "foreign runtime",
  ])(
    "does not cancel %s",
    async (scenario) => {
      const fixture = await progressiveLostJobFixture();
      const state = progressiveLostJobEngine([fixture]);
      const runtime = state.runtimes.get(fixture.jobId)!;
      if (scenario === "live mesh child") {
        runtime.process_count = 1;
        runtime.active_pids = [1234];
        runtime.processes = [{ pid: 1234, command: "cartesian2DMesh" }];
        state.statuses.set(fixture.jobId, {
          ...state.statuses.get(fixture.jobId)!,
          phase: "meshing",
        });
      }
      if (scenario === "live CPU waiter") runtime.runtime_heartbeat_age_sec = 5;
      if (
        ["active task", "reserved task", "scheduled task"].includes(scenario)
      ) {
        const kind = scenario.split(" ")[0] as
          | "active"
          | "reserved"
          | "scheduled";
        state.queue[kind] = [
          {
            worker: "fixture-worker",
            task_id: fixture.jobId,
            name: "airfoilfoam.run_polar",
            job_id: fixture.jobId,
            redelivered: false,
          },
        ];
        if (kind === "active") state.queue.active_count = 1;
        if (kind === "reserved") state.queue.reserved_count = 1;
        if (kind === "scheduled") state.queue.scheduled_count = 1;
      }
      if (scenario === "recent progress")
        state.statuses.get(fixture.jobId)!.last_progress_at =
          new Date().toISOString();
      if (scenario === "fresh physical progress with stale coarse status")
        Object.assign(runtime, {
          runtime_last_progress_at: new Date().toISOString(),
          active_pids: [],
          processes: [],
        });
      if (scenario === "queue unavailable")
        state.calls.getQueue.mockRejectedValue(new Error("queue unreachable"));
      if (scenario === "runtime unavailable")
        state.calls.getJobRuntimes.mockRejectedValue(
          new Error("runtime unreachable"),
        );
      if (scenario === "partial worker coverage")
        state.queue.inspection_workers!.active = [];
      if (scenario === "inspection error")
        state.queue.inspection_errors = { reserved: "worker timed out" };
      if (scenario === "runtime error")
        Object.assign(runtime, { runtime_error: "unreadable runtime" });
      if (scenario === "missing heartbeat")
        runtime.runtime_heartbeat_age_sec = undefined;
      if (scenario === "missing worker inventory")
        state.queue.worker_queues = null;
      if (scenario === "foreign runtime") runtime.job_id = randomUUID();
      const before = await fixture.inspect();
      const invariant = await fixture.invariant();
      await reconcile(db, state.engine, {
        jobIds: [fixture.jobId],
        skipFailedRecovery: true,
      });
      expect(state.calls.cancelJob).not.toHaveBeenCalled();
      expect(state.calls.getExecutionStopProof).not.toHaveBeenCalled();
      expect(state.calls.submitPolar).not.toHaveBeenCalled();
      expect(await fixture.inspect()).toEqual(before);
      expect(await fixture.invariant()).toEqual(invariant);
    },
    120_000,
  );

  it("keeps a competing live ingest owner ahead of lost-job cancellation", async () => {
    const fixture = await progressiveLostJobFixture();
    const state = progressiveLostJobEngine([fixture]);
    const token = randomUUID();
    state.calls.getJob.mockImplementationOnce(async () => {
      await db
        .update(simJobs)
        .set({
          status: "ingesting",
          ingestLeaseToken: token,
          ingestLeaseClaimedAt: new Date(),
          ingestLeaseExpiresAt: new Date(Date.now() + 60000),
        })
        .where(eq(simJobs.id, fixture.jobId));
      return { ...state.statuses.get(fixture.jobId)! };
    });
    const before = await fixture.inspect();
    await reconcile(db, state.engine, {
      jobIds: [fixture.jobId],
      skipFailedRecovery: true,
    });
    expect(state.calls.cancelJob).not.toHaveBeenCalled();
    expect(await fixture.inspect()).toEqual(before);
    const [job] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, fixture.jobId));
    expect(job.ingestLeaseToken).toBe(token);
  }, 120_000);
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

  it("retains a repeated genuine engine failure as a grouped critical screening incident", async () => {
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
    // RANS execution failure is not a user-terminal aerodynamic result. The
    // points stay visibly critical in the machine-owned blocked bucket.
    expect(progress.failed).toBe(0);
    expect(progress.blocked).toBe(ANGLES.length);

    // The legacy failure/requeue surface remains URANS-only.
    const failures = await campaignFailures(db, genuineCampaignId);
    expect(failures.total).toBe(0);

    // Three same-signature occurrences cross the investigation threshold.
    const incidents = await solverIncidentSummary(db, {
      campaignId: genuineCampaignId,
    });
    expect(incidents.occurrenceCount).toBe(ANGLES.length);
    expect(incidents.openCount).toBe(ANGLES.length);
    expect(incidents.criticalGroupCount).toBe(1);
    expect(incidents.groups).toEqual([
      expect.objectContaining({
        stage: "rans",
        reason: "solver-execution-failed",
        occurrenceCount: ANGLES.length,
        openCount: ANGLES.length,
        openCriticalCount: ANGLES.length,
        requiresInvestigation: true,
      }),
    ]);
  }, 120000);
});
