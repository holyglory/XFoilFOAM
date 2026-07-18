// Integration flow for batched campaign jobs (execution-efficiency decision
// 2026-07-04): launch a small multi-speed campaign via materializeCampaignLaunch,
// compose ONE batched job (single mesh chord, all speeds, shared angle list,
// conditionMap), ingest a fake-engine multi-polar result, and verify every
// point lands terminal under the RIGHT pinned revision with correct progress
// counters — plus the per-condition wave-2 targeted child when a point is
// rejected. Follows the sweeper.test.ts live-DB pattern (scoped rows, full
// cleanup in afterAll).

import "./enabled-engine-pool-fixture";

import {
  airfoils,
  boundaryProfiles,
  categories,
  createClient,
  findCampaignGapBatch,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  resultAttempts,
  results,
  simCampaignPoints,
  simCampaignProgress,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligationCampaigns,
  simPrecalcObligations,
  solverEvidenceArtifacts,
  solverProfiles,
  sweeperState,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import {
  type EngineClient,
  type JobResult,
  type JobStatus,
  type PolarRequest,
} from "@aerodb/engine-client";
import { and, asc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConditionMapEntry } from "../src/ingest";
import { submitCampaignBatch } from "../src/loop";
import { reconcile, submitUransRetryForJob } from "../src/reconcile";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-batch-${process.pid}-${Date.now().toString(36)}`;

const ANGLES = [6, 7, 8, 9, 10, 11];
const SPEEDS = [10, 20, 30];
// File-unique physical value: campaign materialization dedupes reference
// geometry by canonical values, so a generic 0.2 m chord can entangle this
// file with another parallel live-DB suite (AGENTS.md F9 guardrail).
const CHORD = 0.2476;
const REJECTED_AOA = 11;
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

let campaignId = "";
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
  profileIds.boundary = boundary.id;
  profileIds.mesh = mesh.id;
  profileIds.solver = solver.id;
  profileIds.output = output.id;
});

afterAll(async () => {
  // Campaign fixture graph cleanup is owned by the shared helper: dependency
  // order, plus guarded deletes for the FIND-OR-CREATE registries
  // (flow_conditions, reference_geometry_profiles are canonical-key deduped,
  // so parallel suites can reference "our" rows — DecisionHistory F6/F9).
  await cleanupCampaignFixtures(db, {
    campaignIds: [campaignId],
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

function conditionMapOf(payload: unknown): ConditionMapEntry[] {
  return ((payload as { conditionMap?: ConditionMapEntry[] })?.conditionMap ??
    []) as ConditionMapEntry[];
}

describe("batched campaign jobs: one mesh per airfoil-chord, all speeds warm-started", () => {
  let jobId = "";
  let entries: ConditionMapEntry[] = [];
  let submittedRequests: PolarRequest[] = [];

  it("launches a multi-speed campaign and finds ONE batched head group", async () => {
    const launch = await materializeCampaignLaunch(db, {
      name: `${PREFIX} batch campaign`,
      priority: 9,
      idempotencyKey: `${PREFIX}-idem-key`,
      airfoilIds: [airfoilId],
      plan: {
        mediumId,
        ambients: [[288.15, 101325]],
        speedsMps: SPEEDS,
        chordsM: [CHORD],
        spanM: 1,
        areaMode: "derived",
        excludedConditions: [],
        baseSweep: {
          fromDeg: null,
          toDeg: null,
          stepDeg: null,
          listDeg: ANGLES,
        },
        objectives: {
          ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
          clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
          clMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
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
    expect(launch.replayed).toBe(false);
    expect(launch.conditionCount).toBe(SPEEDS.length);

    const batch = await findCampaignGapBatch(db, {
      limit: 500,
      campaignIds: [campaignId],
    });
    expect(batch).not.toBeNull();
    expect(batch!.campaignId).toBe(campaignId);
    expect(batch!.airfoilId).toBe(airfoilId);
    expect(batch!.chord).toBe(CHORD);
    expect(batch!.angles).toEqual(ANGLES);
    // All three speeds of the one ambient/chord/angle-set group, reynolds ASC.
    expect(batch!.entries.length).toBe(SPEEDS.length);
    expect(batch!.entries.map((e) => e.speed)).toEqual(SPEEDS);
    expect(batch!.entries[0].reynolds).toBeLessThan(batch!.entries[1].reynolds);
    expect(batch!.entries[1].reynolds).toBeLessThan(batch!.entries[2].reynolds);
    expect(new Set(batch!.entries.map((e) => e.revisionId)).size).toBe(
      SPEEDS.length,
    );
    expect(batch!.reynolds).toBe(batch!.entries[0].reynolds);
    expect(batch!.effectivePriority).toBe(9);
  }, 60000);

  it("composes + claims + submits ONE batched job with a correct conditionMap", async () => {
    const batch = (await findCampaignGapBatch(db, {
      limit: 500,
      campaignIds: [campaignId],
    }))!;
    submittedRequests = [];
    const composeEngine = {
      submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
        submittedRequests.push(request);
        return {
          job_id: `${PREFIX}-engine-parent`,
          state: "pending",
          total_cases: SPEEDS.length * ANGLES.length,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;

    const submitted = await submitCampaignBatch(db, composeEngine, batch, 0, 0);
    expect(submitted).toBe(true);
    expect(submittedRequests.length).toBe(1);
    const request = submittedRequests[0];
    // One mesh (single chord), all speeds, ONE shared angle list, warm-started wave 1.
    expect(request.chord_lengths).toEqual([CHORD]);
    expect(request.speeds).toEqual(SPEEDS);
    expect(request.aoa?.angles).toEqual(ANGLES);
    expect(request.solver?.warm_start).toBe(true);
    expect(request.solver?.force_transient).toBe(false);

    const jobs = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.campaignId, campaignId));
    expect(jobs.length).toBe(1);
    const job = jobs[0];
    jobId = job.id;
    expect(job.jobKind).toBe("sweep");
    expect(job.totalCases).toBe(SPEEDS.length * ANGLES.length);
    entries = conditionMapOf(job.requestPayload);
    expect(entries.length).toBe(SPEEDS.length);
    expect(entries.map((e) => e.speed)).toEqual(SPEEDS);
    expect(new Set(entries.map((e) => e.conditionId)).size).toBe(SPEEDS.length);
    // Compat anchor: job revision = min-Re entry revision.
    expect(job.simulationPresetRevisionId).toBe(entries[0].revisionId);

    // Claims: every entry's angles queued under its OWN revision + bc, with
    // the campaign priority band stamped.
    for (const entry of entries) {
      const claimed = await db
        .select({
          status: results.status,
          simJobId: results.simJobId,
          bcId: results.bcId,
          priority: results.priority,
        })
        .from(results)
        .where(
          and(
            eq(results.airfoilId, airfoilId),
            eq(results.simulationPresetRevisionId, entry.revisionId),
          ),
        );
      expect(claimed.length).toBe(ANGLES.length);
      expect(
        claimed.every(
          (r) =>
            r.status === "queued" &&
            r.simJobId === job.id &&
            r.bcId === entry.bcId,
        ),
      ).toBe(true);
      expect(claimed.every((r) => r.priority === 9)).toBe(true);
    }
  }, 60000);

  it("ingests a multi-polar result: points terminal under the RIGHT revisions, counters correct", async () => {
    const nu = 1.789e-5 / 1.225;
    const result: JobResult = {
      job_id: `${PREFIX}-engine-parent`,
      state: "completed",
      polars: SPEEDS.map((speed) => {
        const solvedAngles =
          speed === 30 ? ANGLES.filter((a) => a !== REJECTED_AOA) : ANGLES;
        return {
          speed,
          chord: CHORD,
          reynolds: Math.round((speed * CHORD) / nu),
          mach: speed / 340.3,
          points: solvedAngles.map((aoa, i) => ({
            case_slug: `u${speed}-a${aoa}`,
            aoa_deg: aoa,
            cl: 0.5 + i * 0.05,
            cd: 0.02 + i * 0.002,
            cm: -0.02,
            cl_cd: (0.5 + i * 0.05) / (0.02 + i * 0.002),
            unsteady: false,
            converged: true,
            first_order_fallback: false,
            images: {},
            evidence_artifacts: [
              {
                kind: "manifest" as const,
                path: `/jobs/${PREFIX}-engine-parent/files/evidence/u${speed}-a${aoa}/evidence_manifest.json`,
                url: `/jobs/${PREFIX}-engine-parent/files/evidence/u${speed}-a${aoa}/evidence_manifest.json`,
                mime_type: "application/json",
                sha256: digest(`${PREFIX}:${speed}:${aoa}:manifest`),
                byte_size: 128,
                role: "evidence",
                metadata: { evidenceBase: `evidence/u${speed}-a${aoa}` },
              },
            ],
          })),
          attempts:
            speed === 30
              ? [
                  {
                    case_slug: `u${speed}-a${REJECTED_AOA}`,
                    aoa_deg: REJECTED_AOA,
                    cl: 0.4,
                    cd: 0.3,
                    cm: -0.1,
                    cl_cd: 1.3,
                    unsteady: false,
                    converged: false,
                    first_order_fallback: false,
                    images: {},
                    failure_disposition: "hard_solver",
                    error: "RANS did not converge",
                    evidence_artifacts: [
                      {
                        kind: "manifest" as const,
                        path: `/jobs/${PREFIX}-engine-parent/files/evidence/u${speed}-a${REJECTED_AOA}/evidence_manifest.json`,
                        url: `/jobs/${PREFIX}-engine-parent/files/evidence/u${speed}-a${REJECTED_AOA}/evidence_manifest.json`,
                        mime_type: "application/json",
                        sha256: digest(
                          `${PREFIX}:${speed}:${REJECTED_AOA}:manifest`,
                        ),
                        byte_size: 128,
                        role: "evidence",
                        metadata: {
                          evidenceBase: `evidence/u${speed}-a${REJECTED_AOA}`,
                        },
                      },
                    ],
                  },
                ]
              : [],
        };
      }),
    };
    const childRequests: PolarRequest[] = [];
    const ingestEngine = {
      getQueue: async () => {
        throw new Error("queue unavailable in test");
      },
      getJob: async (): Promise<JobStatus> => ({
        job_id: `${PREFIX}-engine-parent`,
        state: "completed",
        total_cases: SPEEDS.length * ANGLES.length,
        completed_cases: SPEEDS.length * ANGLES.length,
      }),
      getResult: async () => result,
      submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
        childRequests.push(request);
        return {
          job_id: `${PREFIX}-engine-child`,
          state: "pending",
          total_cases: request.aoa?.angles?.length ?? 0,
          completed_cases: 0,
        };
      },
      fileUrl: (id: string, relPath: string) =>
        `http://engine.test/jobs/${id}/files/${relPath}`,
    } as unknown as EngineClient;

    await reconcile(db, ingestEngine, {
      jobIds: [jobId],
      skipFailedRecovery: true,
    });

    const [job] = await db.select().from(simJobs).where(eq(simJobs.id, jobId));
    expect(job.status).toBe("done");

    // Historical regression (bffc25c): the old local attempt key omitted the
    // result/condition, so the first speed's attempt was silently reused by
    // every later speed at the same AoA/regime. A single batched engine job
    // must now create one exact attempt per result and every artifact must be
    // owned by that same pair.
    const exactOwners = await db
      .select({
        artifactResultId: solverEvidenceArtifacts.resultId,
        artifactAttemptId: solverEvidenceArtifacts.resultAttemptId,
        attemptId: resultAttempts.id,
        attemptResultId: resultAttempts.resultId,
        attemptSimJobId: resultAttempts.simJobId,
        attemptEngineJobId: resultAttempts.engineJobId,
        artifactCaseSlug: solverEvidenceArtifacts.engineCaseSlug,
        attemptCaseSlug: resultAttempts.engineCaseSlug,
      })
      .from(solverEvidenceArtifacts)
      .innerJoin(
        resultAttempts,
        eq(solverEvidenceArtifacts.resultAttemptId, resultAttempts.id),
      )
      .where(eq(resultAttempts.simJobId, jobId));
    expect(exactOwners).toHaveLength(SPEEDS.length * ANGLES.length);
    expect(
      exactOwners.every(
        (owner) =>
          owner.artifactResultId === owner.attemptResultId &&
          owner.artifactAttemptId === owner.attemptId &&
          owner.attemptSimJobId === jobId &&
          owner.attemptEngineJobId === `${PREFIX}-engine-parent` &&
          owner.artifactCaseSlug === owner.attemptCaseSlug,
      ),
    ).toBe(true);
    expect(
      new Set(exactOwners.map((owner) => owner.attemptResultId)).size,
    ).toBe(SPEEDS.length * ANGLES.length);

    // Reconcile classifies the rejected point while the parent still owns its
    // ingest lease, so the campaign-wide RANS gate deliberately defers wave 2
    // until the next ladder pass. Exercise that post-ingest pass explicitly;
    // expecting an inline child here raced the parent's ingesting→done write.
    await submitUransRetryForJob(db, ingestEngine, job);

    // Every solved polar point landed under its OWN pinned revision.
    for (const entry of entries) {
      const solvedAngles =
        entry.speed === 30 ? ANGLES.filter((a) => a !== REJECTED_AOA) : ANGLES;
      const rows = await db
        .select({
          aoaDeg: results.aoaDeg,
          status: results.status,
          speed: results.speed,
          bcId: results.bcId,
          currentAttemptId: results.currentResultAttemptId,
        })
        .from(results)
        .where(
          and(
            eq(results.airfoilId, airfoilId),
            eq(results.simulationPresetRevisionId, entry.revisionId),
            eq(results.status, "done"),
          ),
        )
        .orderBy(asc(results.aoaDeg));
      expect(rows.map((r) => r.aoaDeg)).toEqual(solvedAngles);
      expect(
        rows.every(
          (r) =>
            r.speed === entry.speed &&
            r.bcId === entry.bcId &&
            r.currentAttemptId !== null,
        ),
      ).toBe(true);

      const points = await db
        .select({
          aoaDeg: simCampaignPoints.aoaDeg,
          state: simCampaignPoints.state,
          resultId: simCampaignPoints.resultId,
        })
        .from(simCampaignPoints)
        .where(
          and(
            eq(simCampaignPoints.campaignId, campaignId),
            eq(simCampaignPoints.conditionId, entry.conditionId),
          ),
        )
        .orderBy(asc(simCampaignPoints.aoaDeg));
      expect(points.length).toBe(ANGLES.length);
      for (const point of points) {
        // The RANS pass is terminal even for the rejected point. Its exact
        // preliminary-URANS obligation above owns the remaining fidelity
        // work; reopening this campaign point to requested would expose it to
        // the generic wave-1 gap finder and double-schedule the same cell.
        expect(point.state).toBe("terminal");
        expect(point.resultId).not.toBeNull();
      }

      const [progress] = await db
        .select()
        .from(simCampaignProgress)
        .where(
          and(
            eq(simCampaignProgress.campaignId, campaignId),
            eq(simCampaignProgress.conditionId, entry.conditionId),
            eq(simCampaignProgress.airfoilId, airfoilId),
          ),
        );
      expect(progress).toBeTruthy();
      expect(progress.solved).toBe(solvedAngles.length);
      // requested = total obligation (state <> 'released'), not open-only:
      // none of these points are released, so every angle counts here even
      // after it terminalizes (canonical model, DecisionHistory 2026-07-05).
      expect(progress.requested).toBe(ANGLES.length);
      expect(progress.failed).toBe(0);
      expect(progress.rejected).toBe(0);
      expect(progress.blocked).toBe(0);
    }

    // Wave-2: exactly ONE per-condition single-revision targeted child for the
    // rejected point — never one per healthy condition, never whole-polar.
    const children = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, jobId), eq(simJobs.wave, 2)));
    expect(children.length).toBe(1);
    const child = children[0];
    const rejectedEntry = entries.find((e) => e.speed === 30)!;
    expect(child.simulationPresetRevisionId).toBe(rejectedEntry.revisionId);
    expect(child.jobKind).toBe("targeted");
    // A wave-2 job is one physical solve that may benefit more than one
    // campaign. Campaign ownership therefore lives on the exact obligation,
    // never on the scalar job.campaign_id compatibility column.
    expect(child.campaignId).toBeNull();
    expect(child.totalCases).toBe(1);
    // MUST-CATCH: the post-submit stamp has to reach the freshly composed
    // (pending) child — a child stuck `pending` with no engineJobId would
    // never be polled or ingested.
    expect(child.status).toBe("submitted");
    expect(child.engineJobId).toBe(`${PREFIX}-engine-child`);
    expect((child.requestPayload as { conditionId?: string }).conditionId).toBe(
      rejectedEntry.conditionId,
    );
    expect((child.requestPayload as { retryMode?: string }).retryMode).toBe(
      "invalid-rans-points",
    );
    expect(childRequests.length).toBe(1);
    expect(childRequests[0].speeds).toEqual([30]);
    expect(childRequests[0].aoa?.angles).toEqual([REJECTED_AOA]);
    expect(childRequests[0].solver?.force_transient).toBe(true);

    const obligationIds = (
      child.requestPayload as { precalcObligationIds?: string[] }
    ).precalcObligationIds;
    expect(obligationIds).toHaveLength(1);
    const [obligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, obligationIds![0]));
    expect(obligation).toMatchObject({
      airfoilId,
      revisionId: rejectedEntry.revisionId,
      aoaDeg: REJECTED_AOA,
      state: "running",
      attemptCount: 1,
      latestSimJobId: child.id,
      backgroundOwner: false,
    });
    expect(
      await db
        .select({
          campaignId: simPrecalcObligationCampaigns.campaignId,
          state: simPrecalcObligationCampaigns.state,
        })
        .from(simPrecalcObligationCampaigns)
        .where(eq(simPrecalcObligationCampaigns.obligationId, obligation.id)),
    ).toEqual([{ campaignId, state: "active" }]);
    expect(
      await db
        .select({
          simJobId: simPrecalcObligationAttempts.simJobId,
          attemptNumber: simPrecalcObligationAttempts.attemptNumber,
          state: simPrecalcObligationAttempts.state,
        })
        .from(simPrecalcObligationAttempts)
        .where(eq(simPrecalcObligationAttempts.obligationId, obligation.id)),
    ).toEqual([{ simJobId: child.id, attemptNumber: 1, state: "submitted" }]);

    // The preliminary submission must not rewrite the failed wave-1 evidence
    // into a queue surrogate or child ownership. Its immutable failed attempt
    // remains in the exact-owner audit above, while the exact obligation +
    // accepted-submission ledger owns the remaining machine work until real
    // URANS evidence arrives.
    const [retained] = await db
      .select({
        status: results.status,
        simJobId: results.simJobId,
        autoRetriedAt: results.autoRetriedAt,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, rejectedEntry.revisionId),
          eq(results.aoaDeg, REJECTED_AOA),
        ),
      );
    expect(retained.status).toBe("failed");
    expect(retained.simJobId).toBe(jobId);
    expect(retained.autoRetriedAt).toBeNull();

    // Dedupe per (parent, conditionId): re-running the retry pass creates no
    // second child.
    await submitUransRetryForJob(db, ingestEngine, job);
    const childrenAfter = await db
      .select({ id: simJobs.id })
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, jobId), eq(simJobs.wave, 2)));
    expect(childrenAfter.length).toBe(1);
  }, 120000);
});
