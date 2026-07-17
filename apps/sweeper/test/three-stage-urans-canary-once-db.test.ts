// Live-DB regression for the one-shot canary's production persistence seam.
// The engine is a local capture stub: this proves advisory lease, exact FULL
// request creation, atomic scoped claim, and request/obligation cardinality
// without touching a real solver gateway.

import "./enabled-engine-pool-fixture";

import {
  OPENCFD_2606_EXECUTION_POOL_ID,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
  airfoils,
  boundaryProfiles,
  categories,
  createClient,
  ensurePrecalcObligations,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  resultAttempts,
  resultClassifications,
  results,
  simCampaignConditions,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligationRequests,
  simPrecalcObligations,
  simUransRequestCampaigns,
  simUransRequests,
  simUransVerifyQueue,
  simUransVerifyQueueRequests,
  simulationPresets,
  solverProfiles,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import {
  type EngineClient,
  type JobStatus,
  type PolarRequest,
} from "@aerodb/engine-client";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  productionThreeStageUransCanaryDependencies,
  threeStageUransCanaryMarker,
  validateThreeStageUransCanarySnapshot,
  type ThreeStageUransCanarySnapshot,
  type ThreeStageUransCanaryTarget,
} from "../src/three-stage-urans-canary-once";

const { db, sql } = createClient({ max: 4 });
const PREFIX = `sw-urans-canary-db-${process.pid}-${Date.now().toString(36)}`;
const AOA = 11;
const SPEED = 23.731;
// Campaign materialization deduplicates reference geometry by physical value.
// Keep this file's chord distinct from every parallel live-DB suite.
const CHORD = 0.271837;
const NU = 1.789e-5 / 1.225;

let campaignId = "";
let conditionId = "";
let revisionId = "";
let airfoilId = "";
let categoryId = "";
let mediumId = "";
let bcId = "";
let parentJobId = "";
let sourceResultId = "";
let sourceResultAttemptId = "";
let obligationId = "";
let target: ThreeStageUransCanaryTarget;

const profileIds = {
  boundary: "",
  mesh: "",
  solver: "",
  output: "",
};

const points = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

beforeAll(async () => {
  const [category] = await db
    .insert(categories)
    .values({
      slug: `${PREFIX}-cat`,
      name: `${PREFIX} category`,
      path: `${PREFIX}-cat`,
      depth: 0,
    })
    .returning();
  categoryId = category.id;

  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-foil`,
      name: `${PREFIX} foil`,
      categoryId,
      points,
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
  profileIds.boundary = boundary.id;
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` })
    .returning();
  profileIds.mesh = mesh.id;
  const [solver] = await db
    .insert(solverProfiles)
    .values({
      slug: `${PREFIX}-solver`,
      name: `${PREFIX} solver`,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    })
    .returning();
  profileIds.solver = solver.id;
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` })
    .returning();
  profileIds.output = output.id;

  const launch = await materializeCampaignLaunch(db, {
    name: `${PREFIX} exact canary`,
    priority: 9,
    idempotencyKey: `${PREFIX}-launch`,
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
        listDeg: [AOA],
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

  const [condition] = await db
    .select()
    .from(simCampaignConditions)
    .where(eq(simCampaignConditions.campaignId, campaignId));
  conditionId = condition.id;
  revisionId = condition.simulationPresetRevisionId;
  const [preset] = await db
    .select({ bcId: simulationPresets.legacyBoundaryConditionId })
    .from(simulationPresets)
    .where(eq(simulationPresets.id, condition.presetId))
    .limit(1);
  if (!preset?.bcId)
    throw new Error("canary fixture has no legacy boundary id");
  bcId = preset.bcId;

  const [parent] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      campaignId,
      methodKey: "openfoam.rans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverExecutionPoolId: OPENCFD_2606_EXECUTION_POOL_ID,
      jobKind: "sweep",
      referenceChordM: CHORD,
      wave: 1,
      status: "done",
      engineJobId: `${PREFIX}-rans-engine`,
      totalCases: 1,
      completedCases: 1,
      requestPayload: { aoas: [AOA] },
      submittedAt: new Date(),
      ingestedAt: new Date(),
      finishedAt: new Date(),
    })
    .returning();
  parentJobId = parent.id;

  const [sourceResult] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: AOA,
      status: "done",
      source: "solved",
      regime: "rans",
      reynolds: Math.round((SPEED * CHORD) / NU),
      speed: SPEED,
      chord: CHORD,
      mach: SPEED / 340.3,
      cl: 0.83,
      cd: 0.061,
      cm: -0.052,
      clCd: 0.83 / 0.061,
      stalled: true,
      converged: false,
      unsteady: false,
      fidelity: "rans",
      simJobId: parentJobId,
      engineJobId: parent.engineJobId,
      engineCaseSlug: `aoa_${AOA}`,
      methodKey: "openfoam.rans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      error: "steady RANS did not converge",
      solvedAt: new Date(),
    })
    .returning();
  sourceResultId = sourceResult.id;

  const [sourceAttempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: sourceResultId,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: AOA,
      simJobId: parentJobId,
      engineJobId: parent.engineJobId,
      engineCaseSlug: `aoa_${AOA}`,
      methodKey: "openfoam.rans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      status: "done",
      source: "solved",
      regime: "rans",
      validForPolar: false,
      cl: 0.83,
      cd: 0.061,
      cm: -0.052,
      clCd: 0.83 / 0.061,
      stalled: true,
      converged: false,
      unsteady: false,
      error: "steady RANS did not converge",
      evidencePayload: { failure_disposition: "hard_solver" },
      solvedAt: new Date(),
    })
    .returning();
  sourceResultAttemptId = sourceAttempt.id;

  await db.insert(resultClassifications).values({
    resultId: sourceResultId,
    resultAttemptId: sourceResultAttemptId,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg: AOA,
    regime: "rans",
    classifierVersion: "three-stage-canary-live-db-v1",
    state: "rejected",
    region: "post_stall",
    confidence: 1,
    reasons: ["not-converged"],
  });
  await db
    .update(results)
    .set({ currentResultAttemptId: sourceResultAttemptId })
    .where(eq(results.id, sourceResultId));

  const [obligation] = await ensurePrecalcObligations(
    db,
    [
      {
        airfoilId,
        revisionId,
        aoaDeg: AOA,
        sourceResultId,
        sourceResultAttemptId,
      },
    ],
    { campaignIds: [campaignId] },
  );
  if (!obligation) throw new Error("canary fixture obligation was not created");
  obligationId = obligation.id;

  target = {
    campaignId,
    conditionId,
    expectedCampaignGeneration: launch.campaign.currentConditionGeneration,
    parentJobId,
    airfoilId,
    revisionId,
    aoaDeg: AOA,
    sourceResultId,
    sourceResultAttemptId,
    precalcObligationId: obligationId,
    expectedEngineBuildId: `${PREFIX}-build`,
    expectedMeshRecoveryVersion: 2,
    expectedUransRecoveryVersion: 2,
  };
}, 120_000);

afterAll(async () => {
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
  await sql.end();
}, 120_000);

describe("three-stage URANS canary production DB seam", () => {
  it("creates, associates, and atomically admits only the exact target", async () => {
    const submittedRequests: PolarRequest[] = [];
    const engine = {
      submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
        submittedRequests.push(request);
        return {
          job_id: `${PREFIX}-precalc-engine`,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;
    const dependencies = productionThreeStageUransCanaryDependencies(
      db,
      engine,
      sql,
    );
    const marker = threeStageUransCanaryMarker(target);

    const loadOwnershipSnapshot =
      async (): Promise<ThreeStageUransCanarySnapshot> => {
        const snapshot = await dependencies.loadSnapshot(target, marker);
        return {
          ...snapshot,
          // These are process-wide production fences. Keep the live-DB test
          // isolated by normalizing them in-memory instead of mutating shared
          // scheduler or execution-pool rows while sibling suites may run.
          sweeperEnabled: false,
          maxConcurrentJobs: 0,
          cpuSlots: 0,
          pool: snapshot.pool
            ? { ...snapshot.pool, enabled: true }
            : {
                id: OPENCFD_2606_EXECUTION_POOL_ID,
                solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
                routingKey: "openfoam-opencfd-2606",
                enabled: true,
              },
          otherEnabledPoolCount: 0,
          matchingRuntimeBuildCount: 0,
          openJobs: [],
        };
      };

    await dependencies.withLease(marker, async () => {
      await expect(
        dependencies.withLease(marker, async () => "unexpected"),
      ).rejects.toThrow("another three-stage canary invocation");

      const pristine = await loadOwnershipSnapshot();
      expect(pristine.sourceAttempt).toMatchObject({
        failureDisposition: "hard_solver",
        isLatestForParentGeneration: true,
      });
      expect(pristine.obligation).toMatchObject({ backgroundOwner: false });
      expect(pristine.obligationRequestIds).toEqual([]);
      expect(() =>
        validateThreeStageUransCanarySnapshot(target, marker, pristine),
      ).not.toThrow();

      await db
        .update(resultAttempts)
        .set({ evidencePayload: { failure_disposition: "deterministic_mesh" } })
        .where(eq(resultAttempts.id, sourceResultAttemptId));
      try {
        const deterministicMesh = await loadOwnershipSnapshot();
        expect(deterministicMesh.sourceAttempt?.failureDisposition).toBe(
          "deterministic_mesh",
        );
        expect(() =>
          validateThreeStageUransCanarySnapshot(
            target,
            marker,
            deterministicMesh,
          ),
        ).toThrow("not eligible RANS handoff evidence");
      } finally {
        await db
          .update(resultAttempts)
          .set({ evidencePayload: { failure_disposition: "hard_solver" } })
          .where(eq(resultAttempts.id, sourceResultAttemptId));
      }

      const [newerSourceAttempt] = await db
        .insert(resultAttempts)
        .values({
          resultId: sourceResultId,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: AOA,
          simJobId: parentJobId,
          engineJobId: `${PREFIX}-rans-engine-newer`,
          engineCaseSlug: `aoa_${AOA}_newer`,
          methodKey: "openfoam.rans",
          solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
          status: "done",
          source: "solved",
          regime: "rans",
          validForPolar: false,
          stalled: true,
          converged: false,
          unsteady: false,
          error: "newer steady RANS did not converge",
          evidencePayload: { failure_disposition: "hard_solver" },
          solvedAt: new Date(),
        })
        .returning();
      try {
        const staleGeneration = await loadOwnershipSnapshot();
        expect(staleGeneration.sourceAttempt?.isLatestForParentGeneration).toBe(
          false,
        );
        expect(() =>
          validateThreeStageUransCanarySnapshot(
            target,
            marker,
            staleGeneration,
          ),
        ).toThrow("not eligible RANS handoff evidence");
      } finally {
        await db
          .delete(resultAttempts)
          .where(eq(resultAttempts.id, newerSourceAttempt.id));
      }

      await db
        .update(simPrecalcObligations)
        .set({ backgroundOwner: true })
        .where(eq(simPrecalcObligations.id, obligationId));
      try {
        const backgroundOwned = await loadOwnershipSnapshot();
        expect(backgroundOwned.obligation?.backgroundOwner).toBe(true);
        expect(() =>
          validateThreeStageUransCanarySnapshot(
            target,
            marker,
            backgroundOwned,
          ),
        ).toThrow("unrelated background owner");
      } finally {
        await db
          .update(simPrecalcObligations)
          .set({ backgroundOwner: false })
          .where(eq(simPrecalcObligations.id, obligationId));
      }

      const [terminalCoverageRequest] = await db
        .insert(simUransRequests)
        .values({
          airfoilId,
          revisionId,
          aoaDeg: AOA,
          fidelity: "full",
          state: "cancelled",
          backgroundOwner: false,
          requestedBy: `${PREFIX}-terminal-coverage`,
        })
        .returning();
      await db.insert(simPrecalcObligationRequests).values({
        obligationId,
        requestId: terminalCoverageRequest.id,
      });
      try {
        const previouslyCovered = await loadOwnershipSnapshot();
        expect(previouslyCovered.obligationRequestIds).toEqual([
          terminalCoverageRequest.id,
        ]);
        expect(() =>
          validateThreeStageUransCanarySnapshot(
            target,
            marker,
            previouslyCovered,
          ),
        ).toThrow("already covered by another FULL request");
      } finally {
        await db
          .delete(simPrecalcObligationRequests)
          .where(
            and(
              eq(simPrecalcObligationRequests.obligationId, obligationId),
              eq(
                simPrecalcObligationRequests.requestId,
                terminalCoverageRequest.id,
              ),
            ),
          );
        await db
          .delete(simUransRequests)
          .where(eq(simUransRequests.id, terminalCoverageRequest.id));
      }

      const [overlap] = await db
        .insert(simUransRequests)
        .values({
          airfoilId,
          revisionId,
          aoaDeg: AOA,
          fidelity: "full",
          state: "pending",
          backgroundOwner: true,
          requestedBy: `${PREFIX}-unrelated-overlap`,
        })
        .returning();
      await expect(
        dependencies.ensureFullRequest(target, marker),
      ).rejects.toThrow("unrelated open FULL work overlaps the exact cell");
      expect(
        await db
          .select({ id: simUransRequests.id })
          .from(simUransRequests)
          .where(eq(simUransRequests.requestedBy, marker)),
      ).toHaveLength(0);
      await db
        .delete(simUransRequests)
        .where(eq(simUransRequests.id, overlap.id));

      const requestIds = await Promise.all([
        dependencies.ensureFullRequest(target, marker),
        dependencies.ensureFullRequest(target, marker),
      ]);
      expect(new Set(requestIds).size).toBe(1);
      const requestId = requestIds[0];

      const markerRequests = await db
        .select()
        .from(simUransRequests)
        .where(eq(simUransRequests.requestedBy, marker));
      expect(markerRequests).toHaveLength(1);
      expect(markerRequests[0]).toMatchObject({
        id: requestId,
        airfoilId,
        revisionId,
        aoaDeg: AOA,
        fidelity: "full",
        state: "pending",
        simJobId: null,
        backgroundOwner: false,
        continueFromResultId: null,
      });
      expect(
        await db
          .select({
            requestId: simUransRequestCampaigns.requestId,
            campaignId: simUransRequestCampaigns.campaignId,
            state: simUransRequestCampaigns.state,
          })
          .from(simUransRequestCampaigns)
          .where(eq(simUransRequestCampaigns.requestId, requestId)),
      ).toEqual([{ requestId, campaignId, state: "active" }]);

      const [acceptedPrecalcAttempt] = await db
        .insert(resultAttempts)
        .values({
          resultId: sourceResultId,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: AOA,
          engineJobId: `${PREFIX}-precalc-evidence`,
          engineCaseSlug: `aoa_${AOA}_precalc`,
          methodKey: "openfoam.urans",
          solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
          status: "done",
          source: "solved",
          regime: "urans",
          validForPolar: true,
          cl: 0.81,
          cd: 0.064,
          cm: -0.05,
          clCd: 0.81 / 0.064,
          stalled: true,
          converged: true,
          unsteady: true,
          evidencePayload: { fidelity: "urans_precalc" },
          solvedAt: new Date(),
        })
        .returning();
      const [acceptedPrecalcClassification] = await db
        .insert(resultClassifications)
        .values({
          resultId: null,
          resultAttemptId: acceptedPrecalcAttempt.id,
          airfoilId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: AOA,
          regime: "urans",
          classifierVersion: "three-stage-canary-live-db-v1",
          state: "accepted",
          region: "post_stall",
          confidence: 1,
          reasons: [],
        })
        .returning();
      const [acceptedObligationAttempt] = await db
        .insert(simPrecalcObligationAttempts)
        .values({
          obligationId,
          attemptNumber: 1,
          solverAttemptNumber: 1,
          consumesSolverAttempt: true,
          meshRecoveryVersion: 2,
          state: "accepted",
          outcome: "accepted",
          resultAttemptId: acceptedPrecalcAttempt.id,
          completedAt: new Date(),
        })
        .returning();
      await db.insert(simPrecalcObligationRequests).values({
        obligationId,
        requestId,
      });
      await db
        .update(simPrecalcObligations)
        .set({
          state: "satisfied",
          attemptCount: 1,
          latestSimJobId: null,
          lastOutcome: "accepted",
          lastError: null,
          nextSubmitAt: null,
          completedAt: new Date(),
        })
        .where(eq(simPrecalcObligations.id, obligationId));
      const [verify] = await db
        .insert(simUransVerifyQueue)
        .values({
          airfoilId,
          revisionId,
          aoaDeg: AOA,
          backgroundOwner: false,
          state: "pending",
          precalcResultId: sourceResultId,
          precalcResultAttemptId: acceptedPrecalcAttempt.id,
        })
        .returning();
      await db.insert(simUransVerifyQueueRequests).values({
        queueId: verify.id,
        requestId,
      });
      try {
        const exactVerify = await loadOwnershipSnapshot();
        expect(exactVerify.verifyRequestIds).toEqual([requestId]);
        expect(exactVerify.verifyPrecalcAttempt).toMatchObject({
          id: acceptedPrecalcAttempt.id,
          fidelity: "urans_precalc",
          classificationState: "accepted",
          precalcObligationId: obligationId,
        });
        expect(() =>
          validateThreeStageUransCanarySnapshot(target, marker, exactVerify),
        ).not.toThrow();

        const [unrelatedVerifyOwner] = await db
          .insert(simUransRequests)
          .values({
            airfoilId,
            revisionId,
            aoaDeg: AOA,
            fidelity: "full",
            state: "cancelled",
            backgroundOwner: false,
            requestedBy: `${PREFIX}-unrelated-verify-owner`,
          })
          .returning();
        await db.insert(simUransVerifyQueueRequests).values({
          queueId: verify.id,
          requestId: unrelatedVerifyOwner.id,
        });
        try {
          const sharedVerify = await loadOwnershipSnapshot();
          expect(sharedVerify.verifyRequestIds).toEqual(
            [requestId, unrelatedVerifyOwner.id].sort(),
          );
          expect(() =>
            validateThreeStageUransCanarySnapshot(target, marker, sharedVerify),
          ).toThrow("shared with a request outside the exact canary chain");
        } finally {
          await db
            .delete(simUransVerifyQueueRequests)
            .where(
              and(
                eq(simUransVerifyQueueRequests.queueId, verify.id),
                eq(
                  simUransVerifyQueueRequests.requestId,
                  unrelatedVerifyOwner.id,
                ),
              ),
            );
          await db
            .delete(simUransRequests)
            .where(eq(simUransRequests.id, unrelatedVerifyOwner.id));
        }

        await db
          .update(resultClassifications)
          .set({ state: "rejected" })
          .where(
            eq(resultClassifications.id, acceptedPrecalcClassification.id),
          );
        try {
          const rejectedPrecalc = await loadOwnershipSnapshot();
          expect(
            rejectedPrecalc.verifyPrecalcAttempt?.classificationState,
          ).toBe("rejected");
          expect(() =>
            validateThreeStageUransCanarySnapshot(
              target,
              marker,
              rejectedPrecalc,
            ),
          ).toThrow("does not pin accepted preliminary evidence");
        } finally {
          await db
            .update(resultClassifications)
            .set({ state: "accepted" })
            .where(
              eq(resultClassifications.id, acceptedPrecalcClassification.id),
            );
        }
      } finally {
        await db
          .delete(simUransVerifyQueue)
          .where(eq(simUransVerifyQueue.id, verify.id));
        await db
          .delete(simPrecalcObligationAttempts)
          .where(
            eq(simPrecalcObligationAttempts.id, acceptedObligationAttempt.id),
          );
        await db
          .delete(resultClassifications)
          .where(
            eq(resultClassifications.id, acceptedPrecalcClassification.id),
          );
        await db
          .delete(resultAttempts)
          .where(eq(resultAttempts.id, acceptedPrecalcAttempt.id));
        await db
          .delete(simPrecalcObligationRequests)
          .where(
            and(
              eq(simPrecalcObligationRequests.obligationId, obligationId),
              eq(simPrecalcObligationRequests.requestId, requestId),
            ),
          );
        await db
          .update(simPrecalcObligations)
          .set({
            state: "pending",
            attemptCount: 0,
            latestSimJobId: null,
            lastOutcome: null,
            lastError: null,
            nextSubmitAt: null,
            completedAt: null,
          })
          .where(eq(simPrecalcObligations.id, obligationId));
      }

      const [unrelated] = await db
        .insert(simUransRequests)
        .values({
          airfoilId,
          revisionId,
          aoaDeg: AOA + 1,
          fidelity: "full",
          state: "pending",
          backgroundOwner: true,
          requestedBy: `${PREFIX}-unrelated-other-cell`,
        })
        .returning();

      const submitted = await Promise.all([
        dependencies.submitExactStep({
          requestId,
          verifyId: null,
          cpuSlots: 0,
          meshRecoveryVersion: 2,
          uransRecoveryVersion: 2,
        }),
        dependencies.submitExactStep({
          requestId,
          verifyId: null,
          cpuSlots: 0,
          meshRecoveryVersion: 2,
          uransRecoveryVersion: 2,
        }),
      ]);
      expect(submitted.filter(Boolean)).toHaveLength(1);
      expect(submittedRequests).toHaveLength(1);
      expect(submittedRequests[0].aoa?.angles).toEqual([AOA]);
      expect(submittedRequests[0].solver?.urans_fidelity).toBe("precalc");

      const [request] = await db
        .select()
        .from(simUransRequests)
        .where(eq(simUransRequests.id, requestId));
      expect(request).toMatchObject({ state: "running" });
      expect(request.simJobId).toBeTruthy();

      const jobs = await db
        .select()
        .from(simJobs)
        .where(
          and(
            eq(simJobs.id, request.simJobId!),
            eq(simJobs.simulationPresetRevisionId, revisionId),
          ),
        );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        campaignId: null,
        parentJobId: null,
        airfoilId,
        methodKey: "openfoam.urans",
        solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        solverExecutionPoolId: OPENCFD_2606_EXECUTION_POOL_ID,
        jobKind: "targeted",
        wave: 2,
        status: "submitted",
        engineJobId: `${PREFIX}-precalc-engine`,
      });
      expect(jobs[0].requestPayload).toMatchObject({
        aoas: [AOA],
        uransFidelity: "precalc",
        uransRequestId: requestId,
        precalcObligationIds: [obligationId],
        meshRecoveryVersion: 2,
      });

      expect(
        await db
          .select({
            obligationId: simPrecalcObligationRequests.obligationId,
            requestId: simPrecalcObligationRequests.requestId,
          })
          .from(simPrecalcObligationRequests)
          .where(eq(simPrecalcObligationRequests.requestId, requestId)),
      ).toEqual([{ obligationId, requestId }]);
      expect(
        await db
          .select({ id: simUransVerifyQueueRequests.queueId })
          .from(simUransVerifyQueueRequests)
          .where(eq(simUransVerifyQueueRequests.requestId, requestId)),
      ).toHaveLength(0);

      const [obligation] = await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligationId));
      expect(obligation).toMatchObject({
        sourceResultId,
        sourceResultAttemptId,
        state: "running",
        attemptCount: 1,
        latestSimJobId: request.simJobId,
      });
      expect(
        await db
          .select({
            obligationId: simPrecalcObligationAttempts.obligationId,
            simJobId: simPrecalcObligationAttempts.simJobId,
            attemptNumber: simPrecalcObligationAttempts.attemptNumber,
            solverAttemptNumber:
              simPrecalcObligationAttempts.solverAttemptNumber,
            state: simPrecalcObligationAttempts.state,
          })
          .from(simPrecalcObligationAttempts)
          .where(eq(simPrecalcObligationAttempts.obligationId, obligationId)),
      ).toEqual([
        {
          obligationId,
          simJobId: request.simJobId,
          attemptNumber: 1,
          solverAttemptNumber: 1,
          state: "submitted",
        },
      ]);

      const [unrelatedAfter] = await db
        .select()
        .from(simUransRequests)
        .where(eq(simUransRequests.id, unrelated.id));
      expect(unrelatedAfter).toMatchObject({
        state: "pending",
        simJobId: null,
      });
    });

    await expect(
      dependencies.withLease(marker, async () => "released"),
    ).resolves.toBe("released");
  }, 180_000);
});
