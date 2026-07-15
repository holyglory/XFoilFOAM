import { setTimeout as delay } from "node:timers/promises";

import {
  DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER,
  DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER,
  type Point,
} from "@aerodb/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildCampaignRemediationSummary,
  campaignSummary,
  listCampaigns,
  materializeCampaignLaunch,
  pauseCampaign,
  recomputeCampaignProgress,
  resumeCampaign,
} from "../src/campaigns";
import { createClient } from "../src/client";
import { databaseUrl } from "../src/env";
import {
  recordPrecalcObligationSubmission,
  requeueDeterministicMeshObligationsForRecoveryVersion,
  settlePrecalcObligationsForJob,
} from "../src/precalc-obligations";
import {
  airfoils,
  boundaryProfiles,
  categories,
  mediums,
  meshProfiles,
  outputProfiles,
  results,
  simCampaignPoints,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligationCampaigns,
  simPrecalcObligations,
  solverProfiles,
  syncSweepPromisePoints,
  syncSweepPromises,
} from "../src/schema";
import { cleanupCampaignFixtures } from "../src/test-cleanup";

const RUN_STAMP = Date.now();
const PREFIX = `remediation-${process.pid}-${RUN_STAMP.toString(36)}`;
const DATABASE_URL = databaseUrl();
const { db, sql: pg } = createClient({ url: DATABASE_URL, max: 10 });

const meshError = `${DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER}; ${DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER}: 83`;
const symmetricPoints: Point[] = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.06 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.06 },
  { x: 1, y: 0 },
];
const camberedPoints: Point[] = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

let categoryId = "";
let mediumId = "";
let asymId = "";
let symId = "";
let remoteId = "";
let boundaryProfileId = "";
let meshProfileId = "";
let solverProfileId = "";
let outputProfileId = "";
let launchOrdinal = 0;
const campaignIds: string[] = [];
const syncPromiseIds: string[] = [];

interface ConditionRow {
  id: string;
  revisionId: string;
  bcId: string;
}

async function launchCampaign(args: {
  label: string;
  airfoilId: string;
  speeds: number[];
  from: number;
  to: number;
  step?: number;
}): Promise<{ campaignId: string; conditions: ConditionRow[] }> {
  launchOrdinal += 1;
  const name = `${PREFIX} ${args.label}`;
  const launched = await materializeCampaignLaunch(db, {
    name,
    notes: "Production-shaped campaign remediation fixture.",
    priority: 1,
    idempotencyKey: `${PREFIX}-${args.label}-${launchOrdinal}`,
    airfoilIds: [args.airfoilId],
    plan: {
      mediumId,
      ambients: [[288.15, 101325]],
      speedsMps: args.speeds,
      chordsM: [0.317 + launchOrdinal / 1000],
      spanM: 1,
      areaMode: "derived",
      excludedConditions: [],
      baseSweep: {
        fromDeg: args.from,
        toDeg: args.to,
        stepDeg: args.step ?? 1,
      },
      objectives: {
        ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
        clZero: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
        clMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
      },
      numerics: {
        boundaryProfileId,
        meshProfileId,
        uransMeshProfileId: meshProfileId,
        uransPrecalcMeshProfileId: meshProfileId,
        solverProfileId,
        outputProfileId,
      },
    },
    markStaleAndResolve: false,
  });
  campaignIds.push(launched.campaign.id);
  const conditions = (await db.execute(sql`
    SELECT
      condition.id,
      condition.simulation_preset_revision_id AS "revisionId",
      preset.legacy_boundary_condition_id AS "bcId"
    FROM sim_campaign_conditions condition
    JOIN simulation_presets preset ON preset.id = condition.preset_id
    WHERE condition.campaign_id = ${launched.campaign.id}
    ORDER BY condition.ord
  `)) as unknown as ConditionRow[];
  return { campaignId: launched.campaign.id, conditions };
}

interface ObligationSpec {
  revisionId: string;
  aoaDeg: number;
  state: "pending" | "running" | "satisfied" | "blocked" | "cancelled";
  attemptCount?: number;
  lastOutcome?: string | null;
  lastError?: string | null;
}

async function insertObligations(
  campaignId: string,
  airfoilId: string,
  specs: ObligationSpec[],
  ownedByCampaign = true,
) {
  const obligations = await db
    .insert(simPrecalcObligations)
    .values(
      specs.map((spec) => ({
        airfoilId,
        revisionId: spec.revisionId,
        aoaDeg: spec.aoaDeg,
        state: spec.state,
        attemptCount: spec.attemptCount ?? 0,
        lastOutcome: spec.lastOutcome ?? null,
        lastError: spec.lastError ?? null,
        completedAt: ["blocked", "satisfied", "cancelled"].includes(spec.state)
          ? new Date()
          : null,
      })),
    )
    .returning();
  if (ownedByCampaign) {
    await db.insert(simPrecalcObligationCampaigns).values(
      obligations.map((obligation) => ({
        obligationId: obligation.id,
        campaignId,
        state: "active",
      })),
    );
  }
  return obligations;
}

async function recompute(campaignId: string): Promise<void> {
  await db.transaction((tx) => recomputeCampaignProgress(tx, campaignId));
}

function expectConserved(summary: Awaited<ReturnType<typeof campaignSummary>>) {
  const terminal = summary.remediation.groups
    .filter((group) => group.state === "blocked")
    .reduce((total, group) => total + group.points, 0);
  expect(terminal).toBe(summary.totals.blocked);
  expect(summary.remediation.blocked).toBe(summary.totals.blocked);
  expect(
    summary.totals.solved +
      summary.totals.derived +
      summary.totals.failed +
      summary.totals.rejected +
      summary.totals.blocked +
      summary.totals.remaining,
  ).toBe(summary.totals.requested);
}

beforeAll(async () => {
  const [category] = await db
    .insert(categories)
    .values({
      slug: `${PREFIX}-category`,
      name: `${PREFIX} category`,
      path: `${PREFIX}-category`,
      depth: 0,
    })
    .returning();
  categoryId = category.id;
  const createdAirfoils = await db
    .insert(airfoils)
    .values([
      {
        slug: `${PREFIX}-asym`,
        name: `${PREFIX} asymmetric`,
        categoryId,
        points: camberedPoints,
        isSymmetric: false,
      },
      {
        slug: `${PREFIX}-sym`,
        name: `${PREFIX} symmetric`,
        categoryId,
        points: symmetricPoints,
        isSymmetric: true,
      },
      {
        slug: `${PREFIX}-remote`,
        name: `${PREFIX} remote`,
        categoryId,
        points: camberedPoints,
        isSymmetric: false,
      },
    ])
    .returning();
  [asymId, symId, remoteId] = createdAirfoils.map((row) => row.id);
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
  boundaryProfileId = boundary.id;
  meshProfileId = mesh.id;
  solverProfileId = solver.id;
  outputProfileId = output.id;
});

afterAll(async () => {
  if (syncPromiseIds.length) {
    await db
      .delete(syncSweepPromises)
      .where(inArray(syncSweepPromises.id, syncPromiseIds));
  }
  await cleanupCampaignFixtures(db, {
    campaignIds,
    presetSlugPrefix: `campaign-${PREFIX.toLowerCase()}`,
  });
  if (boundaryProfileId)
    await db
      .delete(boundaryProfiles)
      .where(eq(boundaryProfiles.id, boundaryProfileId));
  if (meshProfileId)
    await db.delete(meshProfiles).where(eq(meshProfiles.id, meshProfileId));
  if (solverProfileId)
    await db
      .delete(solverProfiles)
      .where(eq(solverProfiles.id, solverProfileId));
  if (outputProfileId)
    await db
      .delete(outputProfiles)
      .where(eq(outputProfiles.id, outputProfileId));
  const ids = [asymId, symId, remoteId].filter(Boolean);
  if (ids.length) await db.delete(airfoils).where(inArray(airfoils.id, ids));
  if (categoryId)
    await db.delete(categories).where(eq(categories.id, categoryId));
  if (mediumId) await db.delete(mediums).where(eq(mediums.id, mediumId));
  await pg.end();
});

describe("campaign remediation summary", () => {
  it("MUST-CATCH + FALSE-POSITIVE GUARD: pause/resume provenance is append-only and never invents an actor or reason", async () => {
    const { campaignId } = await launchCampaign({
      label: "lifecycle-provenance",
      airfoilId: asymId,
      speeds: [16.125],
      from: 0,
      to: 0,
    });

    await pauseCampaign(db, campaignId, {
      actor: "operator@example.test",
      reason: "maintenance containment",
    });
    let listed = await listCampaigns(db, { statuses: ["paused"] });
    let item = listed.items.find((candidate) => candidate.id === campaignId);
    expect(item?.latestLifecycleEvent).toMatchObject({
      action: "pause",
      actor: "operator@example.test",
      reason: "maintenance containment",
    });

    await resumeCampaign(db, campaignId);
    listed = await listCampaigns(db, { statuses: ["active"] });
    item = listed.items.find((candidate) => candidate.id === campaignId);
    expect(item?.latestLifecycleEvent).toMatchObject({
      action: "resume",
      actor: null,
      reason: null,
    });

    const [count] = (await db.execute(sql`
      SELECT count(*)::int AS n
      FROM sim_campaign_lifecycle_events
      WHERE campaign_id = ${campaignId}
    `)) as unknown as Array<{ n: number }>;
    expect(Number(count.n)).toBe(2);
  });

  it("MUST-CATCH: conserves blocked groups and keeps automatic repair separate", () => {
    expect(
      buildCampaignRemediationSummary({
        precalcMeshRepairing: 7,
        blockedMeshQuality: 3,
        blockedPrecalcExhausted: 2,
        blockedEngineSubmit: 1,
        blockedOther: 4,
      }),
    ).toEqual({
      repairing: 7,
      blocked: 10,
      groups: [
        {
          reason: "mesh_quality",
          state: "repairing",
          owner: "system",
          points: 7,
        },
        {
          reason: "mesh_quality",
          state: "blocked",
          owner: "system",
          points: 3,
        },
        {
          reason: "precalc_attempts_exhausted",
          state: "blocked",
          owner: "system",
          points: 2,
        },
        {
          reason: "engine_submit_rejected",
          state: "blocked",
          owner: "system",
          points: 1,
        },
        {
          reason: "other_unavailable",
          state: "blocked",
          owner: "system",
          points: 4,
        },
      ],
    });
  });

  it("MUST-CATCH + FALSE-POSITIVE GUARD: only queued results owned by an active job count as running", async () => {
    const { campaignId, conditions } = await launchCampaign({
      label: "active-job-running-counter",
      airfoilId: asymId,
      speeds: [29.444],
      from: 0,
      to: 0,
    });
    const condition = conditions[0]!;
    const [queued] = await db
      .insert(results)
      .values({
        airfoilId: asymId,
        bcId: condition.bcId,
        simulationPresetRevisionId: condition.revisionId,
        aoaDeg: 0,
        status: "queued",
        source: "queued",
        regime: "rans",
      })
      .returning({ id: results.id });

    // Production incident shape: an abandoned queued row with no sim_job
    // owner is waiting work, not an active solve.
    await recompute(campaignId);
    let summary = await campaignSummary(db, campaignId);
    expect(summary.totals).toMatchObject({
      requested: 1,
      running: 0,
      remaining: 1,
    });

    const [job] = await db
      .insert(simJobs)
      .values({
        engineJobId: `${PREFIX}-active-running-counter`,
        airfoilId: asymId,
        bcIds: [condition.bcId],
        simulationPresetRevisionId: condition.revisionId,
        campaignId,
        jobKind: "targeted",
        referenceChordM: 0.319,
        wave: 1,
        status: "submitted",
        totalCases: 1,
        completedCases: 0,
        submittedAt: new Date(),
      })
      .returning({ id: simJobs.id });
    await db
      .update(results)
      .set({ simJobId: job.id })
      .where(eq(results.id, queued.id));

    // False-positive guard: a queued result with a live submitted owner is
    // genuinely running even before its first point evidence arrives.
    await recompute(campaignId);
    summary = await campaignSummary(db, campaignId);
    expect(summary.totals).toMatchObject({
      requested: 1,
      running: 1,
      remaining: 1,
    });

    // A terminal owner cannot keep the point in the running counter.
    await db
      .update(simJobs)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(simJobs.id, job.id));
    await recompute(campaignId);
    summary = await campaignSummary(db, campaignId);
    expect(summary.totals).toMatchObject({
      requested: 1,
      running: 0,
      remaining: 1,
    });
  });

  it("MUST-CATCH: 3×26 obligations with only six result rows per sweep report all 78 affected and recover blocked → repairing → gone", async () => {
    const { campaignId, conditions } = await launchCampaign({
      label: "production-shape",
      airfoilId: asymId,
      speeds: [31.111, 61.111, 91.111],
      from: -5,
      to: 20,
    });
    expect(conditions).toHaveLength(3);
    const angles = Array.from({ length: 26 }, (_, index) => index - 5);
    const obligations = await insertObligations(
      campaignId,
      asymId,
      conditions.flatMap((condition) =>
        angles.map((aoaDeg) => ({
          revisionId: condition.revisionId,
          aoaDeg,
          state: "blocked" as const,
          attemptCount: 1,
          lastOutcome: "deterministic_failure",
          lastError: meshError,
        })),
      ),
    );
    expect(obligations).toHaveLength(78);

    const failedRows = await db
      .insert(results)
      .values(
        conditions.flatMap((condition) =>
          angles.slice(0, 6).map((aoaDeg) => ({
            airfoilId: asymId,
            bcId: condition.bcId,
            simulationPresetRevisionId: condition.revisionId,
            aoaDeg,
            status: "failed" as const,
            source: "solved" as const,
            regime: "urans" as const,
            fidelity: "urans_precalc",
            error: meshError,
          })),
        ),
      )
      .returning({
        id: results.id,
        revisionId: results.simulationPresetRevisionId,
        aoaDeg: results.aoaDeg,
      });
    expect(failedRows).toHaveLength(18);
    for (const result of failedRows) {
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal", resultId: result.id })
        .where(
          and(
            eq(simCampaignPoints.campaignId, campaignId),
            eq(simCampaignPoints.revisionId, result.revisionId!),
            eq(simCampaignPoints.aoaDeg, result.aoaDeg),
          ),
        );
    }
    await recompute(campaignId);

    let summary = await campaignSummary(db, campaignId);
    expect(summary.totals).toMatchObject({ requested: 78, blocked: 78 });
    expect(summary.remediation).toEqual({
      repairing: 0,
      blocked: 78,
      groups: [
        {
          reason: "mesh_quality",
          state: "blocked",
          owner: "system",
          points: 78,
        },
      ],
    });
    expectConserved(summary);
    const listed = await listCampaigns(db, {
      statuses: ["active", "attention"],
      limit: 100,
    });
    expect(
      listed.items.find((item) => item.id === campaignId)?.remediation,
    ).toEqual(summary.remediation);
    const publicRemediation = JSON.stringify(summary.remediation);
    expect(publicRemediation).not.toContain(obligations[0]!.id);
    expect(publicRemediation).not.toContain(meshError);
    expect(Object.keys(summary.remediation).sort()).toEqual([
      "blocked",
      "groups",
      "repairing",
    ]);
    for (const group of summary.remediation.groups) {
      expect(Object.keys(group).sort()).toEqual([
        "owner",
        "points",
        "reason",
        "state",
      ]);
    }

    const plans = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return {
        recovery: await tx.execute(sql`
            EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, FORMAT JSON)
            SELECT obligation.id
            FROM sim_precalc_obligations obligation
            WHERE obligation.state = 'blocked'
              AND obligation.attempt_count < obligation.max_attempts
              AND obligation.last_outcome = 'deterministic_failure'
            ORDER BY obligation.id
            LIMIT 500
          `),
        poll: await tx.execute(sql`
            EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, FORMAT JSON)
            SELECT
              COALESCE(sum(blocked), 0)::int,
              COALESCE(sum(precalc_mesh_repairing), 0)::int,
              COALESCE(sum(blocked_mesh_quality), 0)::int,
              COALESCE(sum(blocked_precalc_exhausted), 0)::int,
              COALESCE(sum(blocked_engine_submit), 0)::int,
              COALESCE(sum(blocked_other), 0)::int
            FROM sim_campaign_progress
            WHERE campaign_id = ${campaignId}
          `),
      };
    });
    const recoveryPlan = JSON.stringify(plans.recovery);
    expect(recoveryPlan).toContain(
      "sim_precalc_obligations_mesh_recovery_candidate_idx",
    );
    const pollPlan = JSON.stringify(plans.poll);
    expect(pollPlan).toContain("sim_campaign_progress");
    expect(pollPlan).not.toContain("sim_precalc_obligations");
    expect(pollPlan).not.toContain("sim_jobs");
    expect(pollPlan).not.toContain("results");

    await db.insert(simPrecalcObligationAttempts).values(
      obligations.map((obligation) => ({
        obligationId: obligation.id,
        attemptNumber: 1,
        solverAttemptNumber: null,
        consumesSolverAttempt: false,
        state: "failed",
        outcome: "deterministic_failure",
        meshRecoveryVersion: 0,
        error: meshError,
      })),
    );
    await db
      .update(simPrecalcObligations)
      .set({
        state: "pending",
        lastOutcome: "mesh_recovery_upgrade_pending",
        completedAt: null,
      })
      .where(
        inArray(
          simPrecalcObligations.id,
          obligations.map((row) => row.id),
        ),
      );
    await recompute(campaignId);
    summary = await campaignSummary(db, campaignId);
    expect(summary.totals.blocked).toBe(0);
    expect(summary.remediation).toEqual({
      repairing: 78,
      blocked: 0,
      groups: [
        {
          reason: "mesh_quality",
          state: "repairing",
          owner: "system",
          points: 78,
        },
      ],
    });
    expectConserved(summary);

    // Submission clears last_error. Typed immutable attempt evidence must
    // keep the same 78 points in repairing, not make them disappear.
    await db
      .update(simPrecalcObligations)
      .set({ state: "running", lastOutcome: "submitted", lastError: null })
      .where(
        inArray(
          simPrecalcObligations.id,
          obligations.map((row) => row.id),
        ),
      );
    await recompute(campaignId);
    summary = await campaignSummary(db, campaignId);
    expect(summary.remediation.repairing).toBe(78);

    // Accepted settlement with a stale retained marker is neither blocked
    // nor repairing. Reset the synthetic failed links to keep this fixture's
    // final state focused on the remediation contract.
    await db
      .update(simPrecalcObligations)
      .set({
        state: "satisfied",
        lastOutcome: "accepted",
        lastError: meshError,
        completedAt: new Date(),
      })
      .where(
        inArray(
          simPrecalcObligations.id,
          obligations.map((row) => row.id),
        ),
      );
    await db
      .update(simCampaignPoints)
      .set({ state: "requested", resultId: null, resultAttemptId: null })
      .where(eq(simCampaignPoints.campaignId, campaignId));
    await recompute(campaignId);
    summary = await campaignSummary(db, campaignId);
    expect(summary.remediation).toEqual({
      repairing: 0,
      blocked: 0,
      groups: [],
    });
    expectConserved(summary);
  }, 120_000);

  it("MUST-CATCH: one blocked physical source conserves its symmetric mirror", async () => {
    const { campaignId, conditions } = await launchCampaign({
      label: "symmetry",
      airfoilId: symId,
      speeds: [42.222],
      from: -1,
      to: 1,
    });
    const condition = conditions[0]!;
    const [obligation] = await insertObligations(campaignId, symId, [
      {
        revisionId: condition.revisionId,
        aoaDeg: 1,
        state: "blocked",
        attemptCount: 1,
        lastOutcome: "deterministic_failure",
        lastError: meshError,
      },
    ]);
    const [failed] = await db
      .insert(results)
      .values({
        airfoilId: symId,
        bcId: condition.bcId,
        simulationPresetRevisionId: condition.revisionId,
        aoaDeg: 1,
        status: "failed",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        error: meshError,
      })
      .returning({ id: results.id });
    await db
      .update(simCampaignPoints)
      .set({ state: "terminal", resultId: failed.id })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          inArray(simCampaignPoints.aoaDeg, [-1, 1]),
        ),
      );
    await recompute(campaignId);
    let summary = await campaignSummary(db, campaignId);
    expect(summary.totals.blocked).toBe(2);
    expect(summary.remediation.groups).toEqual([
      {
        reason: "mesh_quality",
        state: "blocked",
        owner: "system",
        points: 2,
      },
    ]);
    expectConserved(summary);

    await db
      .update(simCampaignPoints)
      .set({ state: "released" })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, -1),
        ),
      );
    await recompute(campaignId);
    summary = await campaignSummary(db, campaignId);
    expect(summary.totals.blocked).toBe(1);
    expect(summary.remediation.blocked).toBe(1);
    expect(obligation).toBeDefined();
    expectConserved(summary);
  });

  it("MUST-CATCH: mixed terminal reasons conserve exactly and ordinary/infra/stale states do not false-positive as mesh repair", async () => {
    const { campaignId, conditions } = await launchCampaign({
      label: "mixed",
      airfoilId: asymId,
      speeds: [53.333],
      from: 0,
      to: 7,
    });
    const revisionId = conditions[0]!.revisionId;
    await insertObligations(campaignId, asymId, [
      {
        revisionId,
        aoaDeg: 0,
        state: "blocked",
        attemptCount: 1,
        lastOutcome: "deterministic_failure",
        lastError: "typed deterministic evidence",
      },
      {
        revisionId,
        aoaDeg: 1,
        state: "blocked",
        lastOutcome: "submit_blocked",
        lastError: "engine rejected submission",
      },
      {
        revisionId,
        aoaDeg: 2,
        state: "blocked",
        attemptCount: 2,
        lastOutcome: "failed_exhausted",
        lastError: "solver exhausted",
      },
      {
        revisionId,
        aoaDeg: 3,
        state: "blocked",
        lastOutcome: "engine_unreachable",
        lastError: "mesh service connection unavailable",
      },
      {
        revisionId,
        aoaDeg: 4,
        state: "pending",
        lastOutcome: "pending",
        lastError: meshError,
      },
      {
        revisionId,
        aoaDeg: 5,
        state: "pending",
        lastOutcome: "mesh_recovery_upgrade_pending",
        lastError: "mesh service connection unavailable",
      },
      {
        revisionId,
        aoaDeg: 6,
        state: "satisfied",
        lastOutcome: "accepted",
        lastError: meshError,
      },
      {
        revisionId,
        aoaDeg: 7,
        state: "cancelled",
        lastOutcome: "cancelled",
        lastError: meshError,
      },
    ]);
    await recompute(campaignId);
    const summary = await campaignSummary(db, campaignId);
    expect(summary.totals.blocked).toBe(4);
    expect(summary.remediation).toEqual({
      repairing: 0,
      blocked: 4,
      groups: [
        {
          reason: "mesh_quality",
          state: "blocked",
          owner: "system",
          points: 1,
        },
        {
          reason: "precalc_attempts_exhausted",
          state: "blocked",
          owner: "system",
          points: 1,
        },
        {
          reason: "engine_submit_rejected",
          state: "blocked",
          owner: "system",
          points: 1,
        },
        {
          reason: "other_unavailable",
          state: "blocked",
          owner: "system",
          points: 1,
        },
      ],
    });
    expectConserved(summary);

    await expect(
      db.execute(sql`
        UPDATE sim_campaign_progress
        SET blocked_other = blocked_other + 1
        WHERE campaign_id = ${campaignId}
      `),
    ).rejects.toThrow();
    const stillConserved = await campaignSummary(db, campaignId);
    expectConserved(stillConserved);
  });

  it("MUST-CATCH: worker-acknowledged attempt version survives producer-job purge and each version upgrade reopens exactly once", async () => {
    const { campaignId, conditions } = await launchCampaign({
      label: "durable-version",
      airfoilId: asymId,
      speeds: [64.444],
      from: 0,
      to: 2,
    });
    const condition = conditions[0]!;
    const obligations = await insertObligations(campaignId, asymId, [
      { revisionId: condition.revisionId, aoaDeg: 0, state: "pending" },
      { revisionId: condition.revisionId, aoaDeg: 1, state: "pending" },
      { revisionId: condition.revisionId, aoaDeg: 2, state: "pending" },
    ]);
    const jobs = [];
    for (const [index, obligation] of obligations.entries()) {
      const [job] = await db
        .insert(simJobs)
        .values({
          engineJobId: `${PREFIX}-durable-${index}`,
          airfoilId: asymId,
          bcIds: [condition.bcId],
          simulationPresetRevisionId: condition.revisionId,
          campaignId,
          jobKind: "targeted",
          referenceChordM: 0.321,
          wave: 2,
          status: "done",
          totalCases: 1,
          completedCases: 1,
          submittedAt: new Date(),
          finishedAt: new Date(),
          requestPayload: {
            precalcObligationIds: [obligation.id],
            uransFidelity: "precalc",
            meshRecoveryVersion: 9,
            ...(index === 0
              ? { executedMeshRecoveryVersion: 1 }
              : index === 2
                ? { executedMeshRecoveryVersion: 2_147_483_648 }
                : {}),
          },
        })
        .returning();
      jobs.push(job);
      await db
        .update(simPrecalcObligations)
        .set({ latestSimJobId: job.id })
        .where(eq(simPrecalcObligations.id, obligation.id));
      await recordPrecalcObligationSubmission(db, job.id, [obligation.id]);
      await settlePrecalcObligationsForJob(db, job, {
        terminalError: meshError,
      });
    }
    const attemptRows = await db
      .select({
        obligationId: simPrecalcObligationAttempts.obligationId,
        version: simPrecalcObligationAttempts.meshRecoveryVersion,
      })
      .from(simPrecalcObligationAttempts)
      .where(
        inArray(
          simPrecalcObligationAttempts.obligationId,
          obligations.map((row) => row.id),
        ),
      );
    const versions = new Map(
      attemptRows.map((row) => [row.obligationId, row.version]),
    );
    expect(versions.get(obligations[0]!.id)).toBe(1);
    // Desired v9 without a worker acknowledgement remains truthful legacy v0.
    expect(versions.get(obligations[1]!.id)).toBe(0);
    // Malformed/out-of-column-range acknowledgements also fail closed to v0.
    expect(versions.get(obligations[2]!.id)).toBe(0);

    await db.delete(simJobs).where(
      inArray(
        simJobs.id,
        jobs.map((row) => row.id),
      ),
    );
    let reopened = await requeueDeterministicMeshObligationsForRecoveryVersion(
      db,
      1,
      {
        campaignIds: [campaignId],
      },
    );
    expect(reopened.obligationIds).toEqual(
      [obligations[1]!.id, obligations[2]!.id].sort(),
    );
    expect(
      (
        await requeueDeterministicMeshObligationsForRecoveryVersion(db, 1, {
          campaignIds: [campaignId],
        })
      ).obligationIds,
    ).toEqual([]);
    let summary = await campaignSummary(db, campaignId);
    expect(summary.remediation).toMatchObject({ repairing: 2, blocked: 1 });
    expectConserved(summary);

    reopened = await requeueDeterministicMeshObligationsForRecoveryVersion(
      db,
      2,
      { campaignIds: [campaignId] },
    );
    expect(reopened.obligationIds).toEqual([obligations[0]!.id]);
    expect(
      (
        await requeueDeterministicMeshObligationsForRecoveryVersion(db, 2, {
          campaignIds: [campaignId],
        })
      ).obligationIds,
    ).toEqual([]);
    summary = await campaignSummary(db, campaignId);
    expect(summary.remediation).toMatchObject({ repairing: 3, blocked: 0 });
    expectConserved(summary);

    const [index] = await pg<[{ indexdef: string }]>`
        SELECT indexdef
        FROM pg_indexes
        WHERE indexname = 'sim_precalc_obligations_mesh_recovery_candidate_idx'
      `;
    expect(index.indexdef).toContain("attempt_count < max_attempts");
    expect(index.indexdef).toContain("last_outcome = 'deterministic_failure'");
  }, 120_000);

  it("MUST-CATCH: a concurrent remote point fulfillment wins the locked recheck and prevents reopening", async () => {
    const { campaignId, conditions } = await launchCampaign({
      label: "remote-fulfillment",
      airfoilId: remoteId,
      speeds: [75.555],
      from: 0,
      to: 0,
    });
    const revisionId = conditions[0]!.revisionId;
    const [obligation] = await insertObligations(
      campaignId,
      remoteId,
      [
        {
          revisionId,
          aoaDeg: 0,
          state: "blocked",
          attemptCount: 0,
          lastOutcome: "deterministic_failure",
          lastError: meshError,
        },
      ],
      false,
    );
    await db.insert(simPrecalcObligationAttempts).values({
      obligationId: obligation.id,
      attemptNumber: 1,
      solverAttemptNumber: null,
      consumesSolverAttempt: false,
      state: "failed",
      outcome: "deterministic_failure",
      meshRecoveryVersion: 0,
      error: meshError,
    });
    const [promise] = await db
      .insert(syncSweepPromises)
      .values({
        airfoilId: remoteId,
        simulationPresetRevisionId: revisionId,
        aoaCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
        requestPayload: { remoteSolver: true },
      })
      .returning();
    syncPromiseIds.push(promise.id);
    const [point] = await db
      .insert(syncSweepPromisePoints)
      .values({
        promiseId: promise.id,
        airfoilId: remoteId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 0,
      })
      .returning();

    const locker = createClient({ url: DATABASE_URL, max: 1 });
    let staged!: () => void;
    let release!: () => void;
    const stagedPromise = new Promise<void>((resolve) => {
      staged = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fulfillment = locker.db.transaction(async (tx) => {
      await tx
        .select({ id: syncSweepPromises.id })
        .from(syncSweepPromises)
        .where(eq(syncSweepPromises.id, promise.id))
        .for("update");
      await tx
        .select({ id: syncSweepPromisePoints.id })
        .from(syncSweepPromisePoints)
        .where(eq(syncSweepPromisePoints.id, point.id))
        .for("update");
      await tx
        .update(syncSweepPromises)
        .set({ status: "fulfilled", fulfilledAt: new Date() })
        .where(eq(syncSweepPromises.id, promise.id));
      await tx
        .update(syncSweepPromisePoints)
        .set({ status: "fulfilled" })
        .where(eq(syncSweepPromisePoints.id, point.id));
      staged();
      await releasePromise;
    });
    await stagedPromise;

    const requeue = requeueDeterministicMeshObligationsForRecoveryVersion(
      db,
      1,
      { obligationIds: [obligation.id] },
    );
    let observedLockedRecheck = false;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [waiting] = await pg<[{ found: boolean }]>`
            SELECT EXISTS (
              SELECT 1
              FROM pg_stat_activity
              WHERE datname = current_database()
                AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock'
                AND query LIKE '%FOR SHARE OF promise, point%'
            ) AS found
          `;
        if (waiting.found) {
          observedLockedRecheck = true;
          break;
        }
        await delay(20);
      }
    } finally {
      release();
    }
    await fulfillment;
    const outcome = await requeue;
    await locker.sql.end();
    expect(observedLockedRecheck).toBe(true);
    expect(outcome.obligationIds).toEqual([]);
    const [unchanged] = await db
      .select({ state: simPrecalcObligations.state })
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, obligation.id));
    expect(unchanged.state).toBe("blocked");
  }, 120_000);
});
