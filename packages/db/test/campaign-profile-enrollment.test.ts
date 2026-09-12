import { randomUUID } from "node:crypto";
import { loadDiskAdmissionExposure } from "../../../apps/sweeper/src/disk-admission";
import {
  localPredictionRepairEngines,
  trustedRepairGeometry,
} from "./prediction-repair-live-fixture";
import { repairMissingPredictions } from "../../../apps/sweeper/src/repair-missing-predictions";
import {
  claimMissingPredictionRepair,
  failPredictionRepair,
  storeRepairedPrediction,
} from "../src/progressive-prediction-repair";
import { acknowledgeLatestProgressiveRemoteStop } from "../../../apps/sweeper/src/progressive-remote-stop-receipt";
import { adoptProgressiveWallPolicy } from "../src/progressive-recipe-adoption";
import { progressiveRemoteActivePromiseCount } from "../src/progressive-remote-dispatch";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  deriveFlowConditionState,
  evaluateGasState,
  materialPhysicsValues,
  parseCoordinates,
} from "@aerodb/core";
import { sourceAirModel } from "../../core/test/fixtures/source-air-model";
import { progressivePredictionFixture as predictionFixture } from "../test-support/progressive-prediction";
import { buildPolarRequest } from "../../../apps/sweeper/src/build-request";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { EngineClient, EngineError } from "../../engine-client/src/client";
import type { EngineExecutionStopProof } from "../../engine-client/src/types";
import {
  acknowledgeProgressiveCfdExecutionStop,
  settleProgressiveCfdExecution,
} from "../src/progressive-cfd-settlement";
import {
  progressiveUnsteadyRecipe,
  recordProgressiveCfdRecoveryPlans,
  supersedeProgressivePriorEvidence,
  progressiveParentRevisionIds,
} from "../src/progressive-cfd-numerical-recovery";
import type {
  ProgressivePolarFitRequest,
  ProgressivePolarFitResponse,
  ProgressiveCoefficientVector,
} from "../../engine-client/src/progressive-polar";
import {
  claimProgressivePolarFit,
  failProgressivePolarFit,
  storeProgressivePolarFit,
  invalidateProgressiveFitPolicy,
  type ProgressiveFitLease,
} from "../src/progressive-polar-cache";
import { runProgressiveBaselineBatch } from "../../../apps/sweeper/src/progressive-baselines";
import { runProgressiveBaselineService } from "../../../apps/sweeper/src/progressive-service";
import { composeProgressiveCfdJob } from "../../../apps/sweeper/src/progressive-cfd-jobs";
import { verifyProgressiveClaimDeferral } from "./progressive-claim-deferral-fixture";
import { admitProgressiveCfdBatch } from "../../../apps/sweeper/src/progressive-admission";
import { reconcileProgressiveExecutions } from "../../../apps/sweeper/src/progressive-execution";
import {
  reconcileProgressiveCfdJob,
  reconcile,
  resetOrphans,
} from "../../../apps/sweeper/src/reconcile";
import { recoverProgressiveSubmissions } from "../../../apps/sweeper/src/progressive-submission";
import {
  prepareProgressiveRemoteDispatch,
  prepareProgressiveRemoteFleet,
} from "../../../apps/sweeper/src/progressive-remote-admission";
import { applyProgressiveRemoteProgress } from "../../../apps/sweeper/src/progressive-remote-progress";
import { storeProgressiveRemoteReport } from "../src/progressive-remote-reports";
import { verifyProgressiveWorkerReportDelivery } from "./progressive-worker-report-fixture";
import { verifyProgressiveAcceptedArchiveReplay } from "./progressive-accepted-archive-fixture";
import { verifyProgressiveRemoteReportInventory } from "./progressive-remote-inventory-fixture";
import { verifyProgressiveRemoteStart } from "./progressive-remote-start-fixture";
import { verifyProgressiveWorkerJobMirror } from "./progressive-worker-job-fixture";
import {
  progressiveRemoteEvidenceResult,
  verifyProgressiveRemoteEvidenceSource,
} from "./progressive-remote-evidence-fixture";
import type { ProgressiveRemoteReport } from "../src/progressive-remote-report";
import {
  sealProgressiveRemoteExecution,
  type ProgressiveRemoteExecutionEnvelope,
} from "../src/progressive-remote-execution";
import { advanceProgressiveCfdStages } from "../src/progressive-cfd-stages";
import { recoverUnboundProgressiveCfdLeases } from "../src/progressive-cfd-recovery";
import {
  buildProgressiveFitRequest,
  PROGRESSIVE_FIT_POLICY_ID,
  runProgressiveFitBatch,
} from "../../../apps/sweeper/src/progressive-fitting";
import { claimAoas } from "../../../apps/sweeper/src/claim";
import {
  submitPendingJobWithLifecycleGuard,
  solverQueuePressure,
} from "../../../apps/sweeper/src/submit-lifecycle";
import {
  solverCpuReservationSql,
  solverCpuReservedJobIdsSql,
} from "../src/solver-reservations";
import { claimJobForIngest } from "../../../apps/sweeper/src/ingest-lease";
import { materializeProgressiveCfdExecution } from "../src/progressive-cfd-execution";
import {
  assertProgressiveCfdEvidenceJob,
  recordProgressiveCfdEvidence,
  recordProgressiveCfdRuntimeProgress,
} from "../src/progressive-cfd-evidence";
import {
  materializeProgressiveCampaignScope,
  reconcileProgressiveGenerationRequest,
} from "../src/progressive-materialization";
import { publicProgressivePolars } from "../src/progressive-public";
import {
  initializeProgressiveCfdWork,
  claimProgressiveCfdUnit,
  claimProgressiveCfdBatch,
  heartbeatProgressiveCfdUnit,
} from "../src/progressive-cfd";

import { createClient, type DB } from "../src/client";
import { databaseUrl } from "../src/env";
import {
  materializeCampaignLaunch,
  reconcileCampaignProfileEnrollment,
} from "../src/campaigns";
import { cleanupCampaignFixtures } from "../src/test-cleanup";
import { simCampaignConditions } from "../src/schema";
import {
  bindProgressiveRemoteDispatch,
  progressiveRemoteReservedSlots,
} from "../src/progressive-remote-dispatch";
import {
  createAnalysisTarget,
  analysisContentHash,
  progressiveComparisonConditionKey,
} from "../src/analysis-target";
import {
  ensureSimulationPresetRevision,
  physicsHashForSnapshot,
  methodCompatibilityHashForSnapshot,
  simulationSetupSignature,
  type SimulationSetupSnapshot,
} from "../src/simulation-setup";
import {
  claimProgressiveWork,
  failProgressiveWork,
  rotateCalculationEpoch,
  sealProgressiveGeneration,
  storeNeuralFoilPrediction,
  type ProgressiveLease,
  type SealedPolarTarget,
} from "../src/progressive-campaigns";
import {
  airfoils,
  boundaryProfiles,
  campaignProfileExpansions,
  categories,
  mediums,
  meshProfiles,
  outputProfiles,
  simCampaignAirfoils,
  simCampaignPoints,
  simCampaigns,
  simJobs,
  solverProfiles,
  solverExecutionPools,
  sweeperState,
  syncSweepPromises,
  results,
  resultAttempts,
} from "../src/schema";

const workerMedia = await vi.hoisted(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const previous = process.env.MEDIA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "progressive-worker-media-"));
  process.env.MEDIA_DIR = directory;
  return { directory, previous };
});

const PREFIX = `enrollment-${process.pid}-${Date.now().toString(36)}`;
const DATABASE = `enrollment_${randomUUID().replaceAll("-", "")}`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const maintenanceUrl = new URL(databaseUrl());
maintenanceUrl.pathname = "/postgres";
const targetUrl = new URL(databaseUrl());
targetUrl.pathname = `/${DATABASE}`;
const admin = postgres(maintenanceUrl.toString(), { max: 1 });
let client: ReturnType<typeof createClient>;
let db: DB;
let created = false;
let categoryId: string;
let originalId: string;
let excludedId: string;
let mediumId: string;
let numerics: {
  boundaryProfileId: string;
  meshProfileId: string;
  solverProfileId: string;
  outputProfileId: string;
};
const campaignIds: string[] = [];
const addedProfileIds: string[] = [];
let sequence = 0;
const points = [
  { x: 1, y: 0 },
  { x: 0.75, y: 0.05 },
  { x: 0.5, y: 0.08 },
  { x: 0.25, y: 0.06 },
  { x: 0, y: 0 },
  { x: 0.25, y: -0.02 },
  { x: 0.5, y: -0.03 },
  { x: 0.75, y: -0.02 },
  { x: 1, y: 0 },
];

describe("durable progressive scope requests", () => {
  it("freezes explicit gas material in campaign revisions and preserves prior physical targets after edits", async () => {
    const [originalMedium] = await db
      .select()
      .from(mediums)
      .where(eq(mediums.id, mediumId));
    const gas = sourceAirModel();
    try {
      await db
        .update(mediums)
        .set({ gasThermodynamics: gas })
        .where(eq(mediums.id, mediumId));
      const id = await campaign("active", [137.376]);
      const [row] = await db.execute(sql`
        SELECT revision.id, revision.preset_id, revision.snapshot
        FROM sim_campaign_conditions condition JOIN simulation_preset_revisions revision
          ON revision.id = condition.simulation_preset_revision_id
        WHERE condition.campaign_id = ${id} LIMIT 1
      `);
      const snapshot = row.snapshot as SimulationSetupSnapshot;
      const originalSnapshotJson = JSON.stringify(snapshot);
      expect(snapshot.material?.gasThermodynamics).toEqual(gas);
      const state = evaluateGasState(
        gas,
        snapshot.flowState.temperatureK,
        snapshot.flowState.pressurePa,
      );
      expect(snapshot.flowState).toMatchObject({
        density: state.density,
        dynamicViscosity: state.dynamicViscosity,
        kinematicViscosity: state.kinematicViscosity,
        mach: snapshot.flowState.speedMps / state.speedOfSound,
      });
      expect(snapshot.derived.reynolds).toBe(
        Math.round(
          (snapshot.flowState.speedMps *
            snapshot.referenceGeometry.referenceLengthM) /
            state.kinematicViscosity,
        ),
      );
      const target = (source: SimulationSetupSnapshot) =>
        createAnalysisTarget({
          airfoilId: originalId,
          points,
          snapshot: source,
          material: {
            ...source.material!,
            speedOfSound: source.material!.speedOfSound ?? null,
          },
          transition: {
            model: "fully_turbulent",
            nCrit: 9,
            upper: 0,
            lower: 0,
          },
          branch: "increasing",
        });
      const originalTarget = target(snapshot);
      expect(originalTarget.physical.material.gasThermodynamics).toEqual(
        materialPhysicsValues(snapshot.material!).gasThermodynamics,
      );
      const metadataOnly = structuredClone(snapshot);
      const attributed = sourceAirModel();
      attributed.provenance = "Updated source attribution";
      attributed.nasa7.provenance = "Updated caloric attribution";
      attributed.polynomial_transport.provenance =
        "Updated transport attribution";
      metadataOnly.material!.gasThermodynamics = attributed;
      metadataOnly.material!.density *= 1.01;
      metadataOnly.material!.refTemperatureK = 300;
      metadataOnly.material!.refPressurePa = 100000;
      metadataOnly.flowState.mediumId = randomUUID();
      metadataOnly.flowState.mediumSlug = "equivalent-air-model";
      expect(target(metadataOnly).signature).toBe(originalTarget.signature);
      expect(physicsHashForSnapshot(metadataOnly)).toBe(
        physicsHashForSnapshot(snapshot),
      );
      expect(methodCompatibilityHashForSnapshot(metadataOnly)).toBe(
        methodCompatibilityHashForSnapshot(snapshot),
      );
      expect(simulationSetupSignature(metadataOnly)).not.toBe(
        simulationSetupSignature(snapshot),
      );
      const [profileRow] = await db
        .select()
        .from(airfoils)
        .where(eq(airfoils.id, originalId));
      const executionSnapshot = structuredClone(snapshot);
      executionSnapshot.solver.flowSolverFamily = "rhoSimpleFoam";
      executionSnapshot.solver.turbulentPrandtl = 0.85;
      const request = buildPolarRequest({
        airfoil: profileRow,
        setup: executionSnapshot,
        aoaList: [0, 2],
        wave: 1,
      }).request;
      expect(request.fluid?.gas).toEqual(gas);
      expect(request.fluid?.density).toBe(state.density);
      expect(request.fluid?.kinematic_viscosity).toBe(state.kinematicViscosity);
      const changed = { ...gas, gas_constant: gas.gas_constant * 1.0001 };
      await db
        .update(mediums)
        .set({ gasThermodynamics: changed })
        .where(eq(mediums.id, mediumId));
      const successor = await ensureSimulationPresetRevision(
        db,
        String(row.preset_id),
      );
      expect(successor?.revision.id).not.toBe(row.id);
      expect(successor?.snapshot.material?.gasThermodynamics).toEqual(changed);
      expect(target(successor!.snapshot).signature).not.toBe(
        originalTarget.signature,
      );
      const [retained] = await db.execute(
        sql`SELECT snapshot FROM simulation_preset_revisions WHERE id = ${row.id}`,
      );
      expect(retained.snapshot).toEqual(JSON.parse(originalSnapshotJson));
      expect(
        buildPolarRequest({
          airfoil: profileRow,
          setup: executionSnapshot,
          aoaList: [0],
          wave: 1,
        }).request.fluid?.gas,
      ).toEqual(gas);
      await expect(
        db
          .update(mediums)
          .set({ phase: "liquid" })
          .where(eq(mediums.id, mediumId)),
      ).rejects.toThrow();
    } finally {
      await db
        .update(mediums)
        .set({ gasThermodynamics: originalMedium.gasThermodynamics })
        .where(eq(mediums.id, mediumId));
    }
  });

  it("cancels live ownership on explicit stop and creates fresh work only after reactivation", async () => {
    const id = await campaign();
    const original = await reconcileProgressiveGenerationRequest(db);
    const lease = (await claim([1]))!;
    await db
      .update(simCampaigns)
      .set({ status: "archived" })
      .where(eq(simCampaigns.id, id));
    await expect(
      storeNeuralFoilPrediction(db, lease, predictionFixture(lease)),
    ).rejects.toThrow("no longer accepts");
    expect(await claim([1])).toBeNull();
    await reconcileProgressiveGenerationRequest(db);
    const [attempt] = await db.execute(
      sql`SELECT outcome FROM progressive_work_attempts WHERE token = ${lease.token}`,
    );
    expect(attempt.outcome).toBe("cancelled");
    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, id));
    const resumed = await reconcileProgressiveGenerationRequest(db);
    expect(resumed?.generationId).toBeTruthy();
    expect(resumed?.generationId).not.toBe(original?.generationId);
    expect((await claim([1]))?.generationId).toBe(resumed?.generationId);
    await expect(
      storeNeuralFoilPrediction(db, lease, predictionFixture(lease)),
    ).rejects.toThrow("obsolete");
  });

  it("fences old plans before reconciliation and preserves their immutable history", async () => {
    const id = await campaign();
    const original = await reconcileProgressiveGenerationRequest(db);
    const scope = await progressiveScope(id);
    const lease = (await claim([1]))!;
    const [replacement] = await db.execute(sql`
      INSERT INTO sim_campaign_plan_revisions (campaign_id, revision_number, kind, plan, summary)
      SELECT campaign_id, revision_number + 1, 'edit', plan, summary
      FROM sim_campaign_plan_revisions WHERE id = ${scope.planRevisionId} RETURNING id
    `);
    await db.execute(
      sql`UPDATE sim_campaigns SET current_plan_revision_id = ${replacement.id} WHERE id = ${id}`,
    );
    expect(await claim([1, 2, 3])).toBeNull();
    await expect(
      storeNeuralFoilPrediction(db, lease, predictionFixture(lease)),
    ).rejects.toThrow("obsolete");
    await expect(sealProgressiveGeneration(db, scope)).rejects.toThrow(
      "no longer current",
    );
    const current = await reconcileProgressiveGenerationRequest(db);
    expect(current?.generationId).not.toBe(original?.generationId);
    expect((await claim([1]))?.generationId).toBe(current?.generationId);
    const [history] = await db.execute(sql`
      SELECT generation.status, attempt.outcome FROM progressive_generations generation
      JOIN progressive_work work ON work.generation_id = generation.id
      JOIN progressive_work_attempts attempt ON attempt.work_id = work.id
      WHERE generation.id = ${original!.generationId} AND attempt.token = ${lease.token}
    `);
    expect(history).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
    });
  });

  it("seals a campaign once and preserves separate finite expansion generations", async () => {
    const id = await campaign();
    const initial = await reconcileProgressiveGenerationRequest(db);
    expect(initial).toMatchObject({ campaignId: id, profiles: 1, error: null });
    expect(initial?.generationId).toBeTruthy();
    expect(await reconcileProgressiveGenerationRequest(db)).toBeNull();
    await db.execute(
      sql`UPDATE progressive_generations SET status = 'complete' WHERE id = ${initial!.generationId}`,
    );
    await db
      .update(simCampaigns)
      .set({ status: "completed" })
      .where(eq(simCampaigns.id, id));
    const added = await newProfile();
    await reconcileCampaignProfileEnrollment(db);
    const expansion = await reconcileProgressiveGenerationRequest(db);
    expect(expansion).toMatchObject({
      campaignId: id,
      profiles: 1,
      error: null,
    });
    expect(expansion?.generationId).not.toBe(initial?.generationId);
    const targets = await db.execute(sql`
      SELECT target.airfoil_id FROM progressive_generation_targets scope
      JOIN polar_analysis_targets target ON target.id = scope.target_id WHERE generation_id = ${expansion!.generationId}
    `);
    expect(targets.map((target) => target.airfoil_id)).toEqual([added]);
    expect(await reconcileProgressiveGenerationRequest(db)).toBeNull();
  });

  it("seals guarded fast recipes for new profiles without rewriting a completed cohort", async () => {
    const id = await campaign();
    const initial = (await reconcileProgressiveGenerationRequest(db))!;
    const before = await db.execute(
      sql`SELECT target_id, recipes FROM progressive_generation_targets WHERE generation_id = ${initial.generationId} ORDER BY target_id`,
    );
    const [plan] = await db.execute(
      sql`SELECT current_plan_revision_id FROM sim_campaigns WHERE id = ${id}`,
    );
    await db.execute(
      sql`UPDATE progressive_generations SET status='complete' WHERE id=${initial.generationId}`,
    );
    await db
      .update(simCampaigns)
      .set({ status: "completed" })
      .where(eq(simCampaigns.id, id));
    const normal = await newProfile({
      points: parseCoordinates(
        readFileSync(
          resolve(ROOT, "packages/db/seed/selig-database/ag24.dat"),
          "utf8",
        ),
      ).points,
    });
    const concave = await newProfile({
      points: parseCoordinates(
        readFileSync(
          resolve(ROOT, "packages/db/seed/selig-database/s1223.dat"),
          "utf8",
        ),
      ).points,
    });
    await reconcileCampaignProfileEnrollment(db);
    const expanded = (await reconcileProgressiveGenerationRequest(db))!;
    expect(expanded).toMatchObject({ profiles: 2, error: null });
    const targets = await db.execute(sql`
      SELECT target.airfoil_id, scope.recipes FROM progressive_generation_targets scope
      JOIN polar_analysis_targets target ON target.id=scope.target_id
      WHERE scope.generation_id=${expanded.generationId}
    `);
    expect(
      targets.find((row) => row.airfoil_id === normal)?.recipes,
    ).toMatchObject({
      fast: {
        mesh: { targetYPlus: 40 },
        wallSpacing: { selection: "wall_function" },
      },
      precise: { mesh: { targetYPlus: 1 } },
    });
    expect(
      targets.find((row) => row.airfoil_id === concave)?.recipes,
    ).toMatchObject({
      fast: {
        mesh: { targetYPlus: 1 },
        wallSpacing: { selection: "requested" },
      },
      precise: { mesh: { targetYPlus: 1 } },
    });
    expect(
      await db.execute(
        sql`SELECT target_id, recipes FROM progressive_generation_targets WHERE generation_id = ${initial.generationId} ORDER BY target_id`,
      ),
    ).toEqual(before);
    const [after] = await db.execute(
      sql`SELECT current_plan_revision_id,status FROM sim_campaigns WHERE id=${id}`,
    );
    expect(after).toMatchObject({ ...plan, status: "active" });
    expect(await reconcileProgressiveGenerationRequest(db)).toBeNull();
  }, 30_000);

  it("adopts an old preliminary recipe transactionally without changing sealed truth", async () => {
    const id = await campaign();
    const original = (await reconcileProgressiveGenerationRequest(db))!;
    const [scope] = await db.execute(sql`
      SELECT scope.*,target.physical,target.airfoil_id FROM progressive_generation_targets scope
      JOIN polar_analysis_targets target ON target.id=scope.target_id WHERE generation_id=${original.generationId}
    `);
    const [plan] = await db.execute(
      sql`SELECT current_plan_revision_id FROM sim_campaigns WHERE id=${id}`,
    );
    await db.execute(
      sql`UPDATE progressive_generations SET status='cancelled' WHERE id=${original.generationId}`,
    );
    const recipes = structuredClone(
      scope.recipes,
    ) as SealedPolarTarget["recipes"];
    delete recipes.fast.wallSpacing;
    recipes.fast.recipe_id = "openfoam-fast-v1";
    const legacy = await sealProgressiveGeneration(db, {
      campaignId: id,
      planRevisionId: String(plan.current_plan_revision_id),
      scopeKey: "isolated-old-wall-policy",
      targets: [
        {
          airfoilId: String(scope.airfoil_id),
          targetId: String(scope.target_id),
          physical: scope.physical as SealedPolarTarget["physical"],
          revisionId: String(scope.revision_id),
          angles: scope.angles as number[],
          recipes,
        },
      ],
    });
    await db.execute(sql`UPDATE sweeper_state SET enabled=true WHERE id=1`);
    await expect(adoptProgressiveWallPolicy(db, id)).rejects.toThrow(
      "Pause new solver admissions",
    );
    await db.execute(sql`UPDATE sweeper_state SET enabled=false WHERE id=1`);
    for (const status of ["paused", "completed", "cancelled", "archived"]) {
      await db
        .update(simCampaigns)
        .set({ status })
        .where(eq(simCampaigns.id, id));
      await expect(adoptProgressiveWallPolicy(db, id)).rejects.toThrow(
        "active preliminary",
      );
    }
    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, id));
    await db.execute(
      sql`UPDATE progressive_generations SET stage=3 WHERE id=${legacy.id}`,
    );
    await expect(adoptProgressiveWallPolicy(db, id)).rejects.toThrow(
      "precise generation",
    );
    await db.execute(
      sql`UPDATE progressive_generations SET stage=1 WHERE id=${legacy.id}`,
    );
    const [work] = await db.execute(
      sql`SELECT id FROM progressive_work WHERE generation_id=${legacy.id} AND stage=1`,
    );
    await db.execute(
      sql`UPDATE progressive_work SET state='leased',lease_token=${randomUUID()}::uuid,lease_owner='isolated-live-prediction',lease_until=clock_timestamp()+interval '1 minute' WHERE id=${work.id}`,
    );
    await expect(adoptProgressiveWallPolicy(db, id)).rejects.toThrow(
      "physically stopped and settled",
    );
    await db.execute(
      sql`UPDATE progressive_work SET state='pending',lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE id=${work.id}`,
    );
    const baseline = (await claim([1]))!;
    expect(baseline.generationId).toBe(legacy.id);
    const predictionId = await storeNeuralFoilPrediction(
      db,
      baseline,
      predictionFixture(baseline),
    );
    await initializeProgressiveCfdWork(db);
    const cfd = (await claimCfd())!;
    const jobId = randomUUID();
    await db.insert(simJobs).values({
      id: jobId,
      engineJobId: jobId,
      airfoilId: originalId,
      bcIds: [],
      referenceChordM: 0.76319,
      campaignId: id,
      status: "done",
    });
    await db.execute(
      sql`UPDATE progressive_cfd_attempts SET sim_job_id=${jobId},outcome='failed',finished_at=clock_timestamp() WHERE token=${cfd.token}`,
    );
    await expect(adoptProgressiveWallPolicy(db, id)).rejects.toThrow(
      "physically stopped and settled",
    );
    const foreign = randomUUID();
    const proof = executionStopProof(jobId);
    await db.execute(sql`INSERT INTO progressive_cfd_execution_stops(sim_job_id,engine_job_id,epoch_id,proof,proof_signature,observed_at)
      VALUES(${jobId},${foreign},${legacy.epochId},${JSON.stringify(proof)}::jsonb,${analysisContentHash(proof)},clock_timestamp())`);
    await expect(adoptProgressiveWallPolicy(db, id)).rejects.toThrow(
      "physically stopped and settled",
    );
    await db.execute(
      sql`DELETE FROM progressive_cfd_execution_stops WHERE sim_job_id=${jobId}`,
    );
    await db.execute(sql`INSERT INTO progressive_cfd_execution_stops(sim_job_id,engine_job_id,epoch_id,proof,proof_signature,observed_at)
      VALUES(${jobId},${jobId},${legacy.epochId},${JSON.stringify(proof)}::jsonb,${analysisContentHash(proof)},clock_timestamp())`);
    const retainedPrediction = await db.execute(
      sql`SELECT id,payload FROM neuralfoil_predictions WHERE id=${predictionId}`,
    );
    const rollback = new Error("isolated-adoption-dry-run");
    await expect(
      db.transaction(async (transaction) => {
        expect(
          (await adoptProgressiveWallPolicy(transaction as unknown as DB, id))
            .kind,
        ).toBe("adopted");
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const [stillActive] = await db.execute(
      sql`SELECT status FROM progressive_generations WHERE id=${legacy.id}`,
    );
    expect(stillActive.status).toBe("active");
    for (const cacheCase of ["missing", "wrong-angles", "wrong-content-hash"]) {
      await expect(
        db.transaction(async (transaction) => {
          const connection = transaction as unknown as DB;
          await connection.execute(
            sql`DELETE FROM progressive_prediction_links WHERE work_id=${baseline.id}`,
          );
          if (cacheCase !== "missing") {
            const payload = predictionFixture(baseline);
            if (cacheCase === "wrong-angles") payload.alpha = [99];
            const identity =
              cacheCase === "wrong-content-hash"
                ? "c".repeat(64)
                : analysisContentHash({ epochId: legacy.epochId, payload });
            await connection.execute(
              sql`INSERT INTO neuralfoil_predictions(id,epoch_id,target_id,payload) VALUES(${identity},${legacy.epochId},${baseline.targetId},${JSON.stringify(payload)}::jsonb)`,
            );
            await connection.execute(
              sql`INSERT INTO progressive_prediction_links(work_id,prediction_id) VALUES(${baseline.id},${identity})`,
            );
          }
          const result = await adoptProgressiveWallPolicy(connection, id);
          if (result.kind !== "adopted")
            throw new Error("Expected isolated adoption");
          const [generation] = await connection.execute(
            sql`SELECT stage FROM progressive_generations WHERE id=${result.generation_id}`,
          );
          expect(generation.stage).toBe(1);
          const [count] = await connection.execute(
            sql`SELECT count(*)::int AS count FROM progressive_work work JOIN progressive_prediction_links link ON link.work_id=work.id WHERE work.generation_id=${result.generation_id}`,
          );
          expect(count.count).toBe(0);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
    const adopted = await adoptProgressiveWallPolicy(db, id);
    expect(adopted.kind).toBe("adopted");
    expect(await adoptProgressiveWallPolicy(db, id)).toMatchObject({
      ...adopted,
      kind: "replayed",
    });
    expect(
      await db.execute(
        sql`SELECT recipes FROM progressive_generation_targets WHERE generation_id=${legacy.id}`,
      ),
    ).toEqual([{ recipes }]);
    const [unchangedPlan] = await db.execute(
      sql`SELECT current_plan_revision_id FROM sim_campaigns WHERE id=${id}`,
    );
    expect(unchangedPlan).toEqual(plan);
    const [receipt] = await db.execute(
      sql`SELECT generation_id FROM progressive_recipe_adoptions WHERE campaign_id=${id}`,
    );
    const [successor] = await db.execute(
      sql`SELECT stage,status FROM progressive_generations WHERE id=${receipt.generation_id}`,
    );
    expect(successor).toMatchObject({ stage: 2, status: "active" });
    const links = await db.execute(
      sql`SELECT link.prediction_id FROM progressive_work work JOIN progressive_prediction_links link ON link.work_id=work.id WHERE generation_id=${receipt.generation_id}`,
    );
    expect(links).toEqual([{ prediction_id: predictionId }]);
    const [newAttempts] = await db.execute(
      sql`SELECT count(*)::int AS count FROM progressive_work_attempts attempt JOIN progressive_work work ON work.id=attempt.work_id WHERE work.generation_id=${receipt.generation_id}`,
    );
    expect(newAttempts.count).toBe(0);
    expect(
      await db.execute(
        sql`SELECT id,payload FROM neuralfoil_predictions WHERE id=${predictionId}`,
      ),
    ).toEqual(retainedPrediction);
    const [cancelled] = await db.execute(
      sql`SELECT state FROM progressive_cfd_units WHERE id=${cfd.id}`,
    );
    expect(cancelled.state).toBe("cancelled");
  }, 30_000);

  it("coalesces concurrent requests without duplicate generations", async () => {
    const id = await campaign();
    const receipts = await Promise.all([
      reconcileProgressiveGenerationRequest(db),
      reconcileProgressiveGenerationRequest(db),
    ]);
    expect(receipts.filter(Boolean)).toHaveLength(1);
    const [count] = await db.execute(
      sql`SELECT count(*)::int AS count FROM progressive_generations WHERE campaign_id = ${id}`,
    );
    expect(count.count).toBe(1);
  });

  it("keeps paused work sealed but dormant and inactive campaigns dormant until reactivation", async () => {
    const id = await campaign("paused");
    expect(await reconcileProgressiveGenerationRequest(db)).toMatchObject({
      campaignId: id,
      profiles: 1,
      error: null,
    });
    expect(
      await claimProgressiveWork(db, {
        owner: "paused",
        stages: [1],
        leaseSeconds: 60,
      }),
    ).toBeNull();
    const inactive = await campaign("cancelled");
    expect(await reconcileProgressiveGenerationRequest(db)).toMatchObject({
      campaignId: inactive,
      generationId: null,
      profiles: 0,
    });
    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, inactive));
    expect(await reconcileProgressiveGenerationRequest(db)).toMatchObject({
      campaignId: inactive,
      profiles: 1,
      error: null,
    });
  });

  it("re-seals preserved campaign scope in a fresh reset epoch", async () => {
    const id = await campaign();
    const initial = await reconcileProgressiveGenerationRequest(db);
    await rotateCalculationEpoch(db, "scope reset regression");
    const reset = await reconcileProgressiveGenerationRequest(db);
    expect(reset).toMatchObject({ campaignId: id, profiles: 1, error: null });
    expect(reset?.generationId).not.toBe(initial?.generationId);
  });

  it("records unsupported scope honestly without spinning or blocking another campaign", async () => {
    const unsupported = await campaign("active", [1200]);
    const supported = await campaign();
    const first = await reconcileProgressiveGenerationRequest(db);
    expect(first?.campaignId).toBe(unsupported);
    expect(first?.error).toBeTruthy();
    expect(first?.generationId).toBeNull();
    expect(await reconcileProgressiveGenerationRequest(db)).toMatchObject({
      campaignId: supported,
      error: null,
    });
    expect(await reconcileProgressiveGenerationRequest(db)).toBeNull();
    const [request] = await db.execute(
      sql`SELECT error, requested_version = processed_version AS handled FROM progressive_scope_requests WHERE campaign_id = ${unsupported}`,
    );
    expect(request.handled).toBe(true);
    expect(request.error).toBeTruthy();
  });
});

async function profile(
  label: string,
  values: Partial<typeof airfoils.$inferInsert> = {},
) {
  const [row] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-${label}-${sequence++}`,
      name: label,
      categoryId,
      points,
      isSymmetric: false,
      ...values,
    })
    .returning();
  return row.id;
}

async function newProfile(values: Partial<typeof airfoils.$inferInsert> = {}) {
  const id = await profile("new", values);
  addedProfileIds.push(id);
  return id;
}

async function campaign(
  status = "active",
  speeds = [32.173],
  angles = [-2, 0, 2],
) {
  const launch = await materializeCampaignLaunch(db, {
    name: `${PREFIX}-${sequence++}`,
    priority: 5,
    idempotencyKey: randomUUID(),
    airfoilIds: [originalId],
    plan: {
      mediumId,
      ambients: [[288.15, 101325]],
      speedsMps: speeds,
      chordsM: [0.76319],
      spanM: 1,
      areaMode: "derived",
      excludedConditions: [],
      baseSweep: {
        fromDeg: null,
        toDeg: null,
        stepDeg: null,
        listDeg: angles,
      },
      objectives: {
        ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
        clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
        clMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
      },
      numerics,
    },
  });
  const id = launch.campaign.id;
  campaignIds.push(id);
  if (status !== "active")
    await db
      .update(simCampaigns)
      .set({ status })
      .where(eq(simCampaigns.id, id));
  return id;
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${DATABASE}"`);
  created = true;
  client = createClient({ url: targetUrl.toString(), max: 4 });
  db = client.db;
  await migrate(db, {
    migrationsFolder: resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../migrations",
    ),
  });
  const [category] = await db
    .insert(categories)
    .values({ slug: PREFIX, name: PREFIX, path: PREFIX, depth: 0 })
    .returning();
  categoryId = category.id;
  originalId = await profile("original");
  excludedId = await profile("intentionally-excluded");
  const [medium] = await db
    .insert(mediums)
    .values({
      slug: PREFIX,
      name: PREFIX,
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
    .values({ slug: PREFIX, name: PREFIX })
    .returning();
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: PREFIX, name: PREFIX })
    .returning();
  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: PREFIX, name: PREFIX })
    .returning();
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: PREFIX, name: PREFIX })
    .returning();
  numerics = {
    boundaryProfileId: boundary.id,
    meshProfileId: mesh.id,
    solverProfileId: solver.id,
    outputProfileId: output.id,
  };
}, 120_000);

afterEach(async () => {
  if (campaignIds.length)
    await cleanupCampaignFixtures(db, {
      campaignIds: campaignIds.splice(0),
      presetSlugPrefix: `campaign-${PREFIX}`,
    });
  if (addedProfileIds.length)
    await db
      .delete(airfoils)
      .where(inArray(airfoils.id, addedProfileIds.splice(0)));
});

async function progressiveScope(
  campaignId: string,
  scopeKey = "initial",
  profileIds = [originalId],
) {
  const [source] = await client.sql<
    {
      revision_id: string;
      snapshot: SimulationSetupSnapshot;
      plan_revision_id: string;
    }[]
  >`
    SELECT condition.simulation_preset_revision_id AS revision_id, revision.snapshot,
      campaign.current_plan_revision_id AS plan_revision_id
    FROM sim_campaign_conditions condition
    JOIN simulation_preset_revisions revision ON revision.id = condition.simulation_preset_revision_id
    JOIN sim_campaigns campaign ON campaign.id = condition.campaign_id
    WHERE campaign.id = ${campaignId} LIMIT 1
  `;
  const targets: SealedPolarTarget[] = profileIds.map((airfoilId) => {
    const target = createAnalysisTarget({
      airfoilId,
      points,
      snapshot: source.snapshot,
      material: {
        phase: "gas",
        density: 1.225,
        refTemperatureK: 288.15,
        refPressurePa: 101325,
        speedOfSound: 340.3,
        viscosity: { model: "constant", mu: 1.789e-5 },
      },
      transition: { model: "fully_turbulent", nCrit: 9, upper: 0, lower: 0 },
      branch: "increasing",
    });
    return {
      airfoilId,
      targetId: target.signature,
      physical: target.physical,
      revisionId: source.revision_id,
      angles: [-2, 0, 2],
      recipes: {
        neuralfoil: {
          recipe_id: "test-neuralfoil",
          model_size: "large",
          maximum_geometry_rms: 0.003,
          maximum_geometry_error: 0.012,
        },
        fast: { recipe_id: "test-fast" },
        precise: { recipe_id: "test-precise" },
      },
    };
  });
  return {
    campaignId,
    planRevisionId: source.plan_revision_id,
    scopeKey,
    targets,
  };
}

const claim = (stages: (1 | 2 | 3)[] = [1, 2, 3]) =>
  claimProgressiveWork(db, {
    owner: "isolated-test",
    stages,
    leaseSeconds: 120,
  });

const claimCfd = () =>
  claimProgressiveCfdUnit(db, { owner: "isolated-cfd", leaseSeconds: 120 });

async function fastCfdGeneration(twoProfiles = false) {
  const id = await campaign();
  const profiles = [originalId];
  if (twoProfiles) {
    profiles.push(await newProfile());
    await reconcileCampaignProfileEnrollment(db);
  }
  const generation = await sealProgressiveGeneration(
    db,
    await progressiveScope(id, "cfd-test", profiles),
  );
  for (const _profile of profiles) {
    const baseline = (await claim([1]))!;
    await storeNeuralFoilPrediction(db, baseline, predictionFixture(baseline));
  }
  return { campaignId: id, generationId: generation.id };
}

async function cfdEvidenceFixture(
  speed = 32.173,
  stage: 2 | 3 = 2,
  extraSpeeds: number[] = [],
  angles = [-2, 0, 2],
  retryWithAllocations = false,
) {
  const campaignId = await campaign("active", [speed, ...extraSpeeds], angles);
  await materializeProgressiveCampaignScope(db, campaignId);
  const baseline = (await claim([1]))!;
  await storeNeuralFoilPrediction(db, baseline, predictionFixture(baseline));
  for (let remaining = extraSpeeds.length; remaining > 0; remaining -= 1) {
    const nextBaseline = (await claim([1]))!;
    await storeNeuralFoilPrediction(
      db,
      nextBaseline,
      predictionFixture(nextBaseline),
    );
  }
  if (stage === 3) {
    await db.execute(sql`UPDATE progressive_work SET state = 'complete', completed_at = clock_timestamp()
      WHERE generation_id = ${baseline.generationId} AND stage = 2`);
    await db.execute(
      sql`UPDATE progressive_generations SET stage = 3 WHERE id = ${baseline.generationId}`,
    );
  }
  await initializeProgressiveCfdWork(db);
  let retriedUnitId: string | undefined;
  if (retryWithAllocations) {
    const previous = (await claimCfd())!;
    retriedUnitId = previous.id;
    await heartbeatProgressiveCfdUnit(db, previous, {
      attemptActiveSeconds: 120,
      leaseSeconds: 60,
    });
    await db.execute(sql`UPDATE progressive_cfd_attempts SET outcome = 'failed', finished_at = clock_timestamp()
      WHERE token = ${previous.token}`);
    await db.execute(sql`UPDATE progressive_cfd_units SET state = 'pending', lease_token = NULL,
      lease_owner = NULL, lease_until = NULL WHERE id = ${previous.id}`);
  }
  const leases = await claimProgressiveCfdBatch(db, {
    owner: "evidence-fixture",
    leaseSeconds: 120,
    solverBudgetVersion: 2,
  });
  const execution = await materializeProgressiveCfdExecution(db, leases[0]);
  const [pool] = await db
    .select()
    .from(solverExecutionPools)
    .where(
      eq(
        solverExecutionPools.solverImplementationId,
        execution.revision.solverImplementationId,
      ),
    )
    .limit(1);
  await db
    .insert(sweeperState)
    .values({ id: 1, enabled: true })
    .onConflictDoUpdate({ target: sweeperState.id, set: { enabled: true } });
  await db
    .update(solverExecutionPools)
    .set({ enabled: true })
    .where(eq(solverExecutionPools.id, pool.id));
  let composed: Awaited<ReturnType<typeof composeProgressiveCfdJob>>;
  try {
    composed = await composeProgressiveCfdJob(db, leases, {
      cpuSlots: 1,
      meshRecoveryVersion: 1,
      solverBudgetVersion: 2,
    });
  } finally {
    await db
      .update(solverExecutionPools)
      .set({ enabled: pool.enabled })
      .where(eq(solverExecutionPools.id, pool.id));
    await db
      .update(sweeperState)
      .set({ enabled: false })
      .where(eq(sweeperState.id, 1));
  }
  const engineJobId = composed.request.execution_id!;
  await db
    .update(simJobs)
    .set({ engineJobId, status: "running" })
    .where(eq(simJobs.id, composed.jobId));
  const cells = await db
    .select()
    .from(results)
    .where(eq(results.simJobId, composed.jobId));
  const save = async (
    seconds: unknown,
    regime: "rans" | "urans" = "rans",
    alpha = leases[0].alpha,
    extraPayload: Record<string, unknown> = {},
  ) => {
    const [attempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: (cells.find((cell) => cell.aoaDeg === alpha) ??
          cells.find((cell) => cell.aoaDeg === leases[0].alpha))!.id,
        airfoilId: originalId,
        bcId: execution.snapshot.preset.legacyBoundaryConditionId!,
        simulationPresetRevisionId: execution.revision.id,
        simJobId: composed.jobId,
        engineJobId,
        aoaDeg: alpha,
        regime,
        status: "failed",
        source: "queued",
        validForPolar: false,
        evidencePayload: {
          ...extraPayload,
          solver_active_seconds: seconds,
          error: "isolated rejected-attempt fixture",
        },
      })
      .returning();
    return attempt.id;
  };
  const record = (ids: string[]) =>
    recordProgressiveCfdEvidence(db, {
      simJobId: composed.jobId,
      engineJobId,
      resultAttemptIds: ids,
    });
  return {
    campaignId,
    leases,
    composed,
    engineJobId,
    execution,
    save,
    record,
    retriedUnitId,
  };
}

async function fitFixture(
  stage: 2 | 3 = 2,
  extraCondition = false,
  angles = [-2, 0, 2],
) {
  const fixture = await cfdEvidenceFixture(
    32.173 + (sequence + 1) / 100,
    stage,
    extraCondition ? [42.173 + (sequence + 1) / 100] : [],
    angles,
  );
  const [prediction] = await db.execute(sql`
    SELECT id FROM neuralfoil_predictions WHERE target_id = ${fixture.leases[0].targetId}
      AND epoch_id = ${fixture.leases[0].epochId} ORDER BY created_at DESC, id LIMIT 1
  `);
  const acquire = () =>
    claimProgressivePolarFit(db, {
      predictionId: String(prediction.id),
      owner: "isolated-fit",
      leaseSeconds: 120,
    });
  return { ...fixture, predictionId: String(prediction.id), acquire };
}

function fittingRequest(
  lease: ProgressiveFitLease,
): ProgressivePolarFitRequest {
  const { source } = lease;
  return {
    epoch_id: source.epochId,
    lease_token: lease.token,
    prior: {
      prediction_id: source.predictionId,
      target_signature: source.targetId,
      branch: source.physical.branch,
      alpha: source.prediction.alpha as number[],
      coefficients: source.prediction
        .coefficients as ProgressiveCoefficientVector[],
      standard_deviation: (source.prediction.alpha as number[]).map(() => [
        0.3, 0.02, 0.1,
      ]),
      provenance: {
        model: source.prediction.model,
        geometry_fit: source.prediction.geometry_fit,
        geometry_provenance: source.prediction.geometry_provenance,
      },
    },
    observations: source.evidence.map((row) => ({
      observation_id: row.resultAttemptId,
      result_id: row.resultId,
      attempt_id: row.resultAttemptId,
      lineage_id: row.lineageId,
      target_signature: source.targetId,
      branch: source.physical.branch,
      method: row.stage === 2 ? "openfoam_fast" : "openfoam_precise",
      alpha: row.alpha,
      coefficients: row.payload.converged
        ? [
            Number(row.payload.cl),
            Number(row.payload.cd),
            Number(row.payload.cm),
          ]
        : null,
      standard_error: row.payload.converged ? [0.02, 0.002, 0.003] : null,
      eligible: row.payload.converged === true,
      numerical_convergence: row.payload.converged
        ? "converged"
        : "unconverged",
      statistical_certification: row.payload.converged
        ? "steady"
        : "insufficient_evidence",
      exclusion_reason: row.payload.converged ? null : "insufficient_evidence",
    })),
    histories: [],
    history_policy: null,
    policy: {
      policy_id: "isolated-fit-policy",
      fast_discrepancy_std: [0.4, 0.4, 0.1],
      precise_discrepancy_std: [0.15, 0.15, 0.03],
      slope_std: [0.5, 0.3, 0.1],
      local_std: [0.15, 0.2, 0.03],
      fast_noise_floor: [0.03, 0.03, 0.005],
      precise_noise_floor: [0.01, 0.01, 0.001],
      correlation_length_deg: 2,
      lineage_correlation: 0.8,
      calibration_status: "unvalidated",
    },
  };
}

function fitUsingPython(
  request: ProgressivePolarFitRequest,
): Promise<ProgressivePolarFitResponse> {
  return new Promise((resolveResponse, reject) => {
    const child = spawn(
      resolve(ROOT, ".venv/bin/python"),
      [resolve(ROOT, "tests/progressive_fit_gateway_fixture.py")],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      errors = (errors + chunk.toString()).slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      if (code !== 0)
        reject(new Error(`Progressive fit gateway failed: ${errors}`));
      else {
        try {
          resolveResponse(JSON.parse(output));
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function executionStopProof(engineJobId: string): EngineExecutionStopProof {
  return {
    version: 1,
    job_id: engineJobId,
    execution_stopped: true,
    producer_stopped: true,
    namespace_verified: true,
    remaining: [],
    observed_at: new Date().toISOString(),
    error: null,
    fence: "terminal_result",
  };
}

describe("progressive durable stage transitions", () => {
  it.skipIf(process.env.PROGRESSIVE_PREDICTION_REPAIR_LIVE !== "1")(
    "repairs real old-engine geometry gaps through the new prediction engine without CFD replay",
    async () => {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
      const engines = localPredictionRepairEngines(root);
      expect(
        (await engines.original.healthDetails())
          .neuralfoil_geometry_fit_version,
      ).not.toBe(2);
      expect(
        (await engines.repaired.healthDetails())
          .neuralfoil_geometry_fit_version,
      ).toBe(2);
      const [state] = await db.execute(
        sql`SELECT enabled FROM sweeper_state WHERE id = 1`,
      );
      await db.execute(
        sql`UPDATE sweeper_state SET enabled = true WHERE id = 1`,
      );
      try {
        for (const profile of ["b707b", "b707c", "cap21c", "e49"]) {
          const geometry = trustedRepairGeometry(root, profile);
          await db
            .update(airfoils)
            .set({ points: geometry.points })
            .where(eq(airfoils.id, originalId));
          const campaignId = await campaign();
          const generation = await materializeProgressiveCampaignScope(
            db,
            campaignId,
          );
          const original = await runProgressiveBaselineBatch(
            db,
            engines.original,
            `real-old-fit-${profile}`,
            { requireSweeperEnabled: true },
          );
          expect(original).toMatchObject({ claimed: 1, stored: 0 });
          expect(original.errors.join(" ")).toContain(
            "not represented accurately enough",
          );
          const before =
            await db.execute(sql`SELECT work.id, work.state, work.error, work.stage, generation.stage AS campaign_stage
          FROM progressive_work work JOIN progressive_generations generation ON generation.id = work.generation_id
          WHERE generation.id = ${generation!.id}::uuid ORDER BY work.stage`);
          expect(before[0]).toMatchObject({ state: "gap", campaign_stage: 2 });
          const receipt = await repairMissingPredictions(
            db,
            engines.repaired,
            campaignId,
            1,
          );
          expect(receipt).toEqual({
            claimed: 1,
            stored: 1,
            gaps: 0,
            errors: [],
          });
          expect(
            await db.execute(sql`SELECT work.id, work.state, work.error, work.stage, generation.stage AS campaign_stage
          FROM progressive_work work JOIN progressive_generations generation ON generation.id = work.generation_id
          WHERE generation.id = ${generation!.id}::uuid ORDER BY work.stage`),
          ).toEqual(before);
          const [stored] =
            await db.execute(sql`SELECT prediction.id, prediction.payload, scope.revision_id
          FROM progressive_prediction_repairs repair JOIN neuralfoil_predictions prediction ON prediction.id = repair.prediction_id
          JOIN progressive_work work ON work.id = repair.work_id
          JOIN progressive_generation_targets scope ON scope.generation_id = work.generation_id AND scope.target_id = work.target_id
          WHERE work.generation_id = ${generation!.id}::uuid`);
          const payload = stored.payload as {
            coefficients: number[][];
            geometry_fit: { method: string };
            cfd_evidence: boolean;
          };
          expect(payload.geometry_fit.method).toBe(
            "retained-polyline-segment-sampling-v1",
          );
          expect(payload.cfd_evidence).toBe(false);
          expect(
            payload.coefficients.every(
              (row) => row.every(Number.isFinite) && row[1] > 0,
            ),
          ).toBe(true);
          expect(
            (
              await publicProgressivePolars(
                db,
                originalId,
                String(stored.revision_id),
              )
            ).some((series) => series.modelId === stored.id),
          ).toBe(true);
          expect(
            (
              await db.execute(
                sql`SELECT count(*)::integer AS jobs FROM sim_jobs WHERE campaign_id = ${campaignId}::uuid`,
              )
            )[0].jobs,
          ).toBe(0);
          console.log(
            JSON.stringify({
              operation: "real-missing-prediction-repair",
              profile,
              geometrySha256: geometry.sha256,
              predictionId: stored.id,
              rows: payload.coefficients.length,
              originalGapPreserved: true,
              campaignStage: 2,
              cfdJobs: 0,
            }),
          );
        }
      } finally {
        await db
          .update(airfoils)
          .set({ points })
          .where(eq(airfoils.id, originalId));
        await db.execute(
          sql`UPDATE sweeper_state SET enabled = ${state.enabled} WHERE id = 1`,
        );
      }
    },
    120000,
  );

  it("supplemental prediction repair preserves advanced stages, gap history and existing CFD ownership", async () => {
    const campaignId = await campaign("active", [32.1741]);
    await materializeProgressiveCampaignScope(db, campaignId);
    const baseline = (await claim([1]))!;
    await failProgressiveWork(
      db,
      baseline,
      "original geometry fit unavailable",
      false,
    );
    await initializeProgressiveCfdWork(db);
    const [state] = await db.execute(
      sql`SELECT enabled FROM sweeper_state WHERE id = 1`,
    );
    await db.execute(sql`UPDATE sweeper_state SET enabled = true WHERE id = 1`);
    try {
      const before =
        await db.execute(sql`SELECT generation.stage, work.id, work.state, work.attempts
        FROM progressive_generations generation JOIN progressive_work work ON work.generation_id = generation.id
        WHERE generation.id = ${baseline.generationId}::uuid ORDER BY work.stage`);
      const unitsBefore =
        await db.execute(sql`SELECT unit.* FROM progressive_cfd_units unit JOIN progressive_work work ON work.id = unit.work_id
        WHERE work.generation_id = ${baseline.generationId}::uuid ORDER BY unit.id`);
      expect(before[0].stage).toBe(2);
      const leases = await Promise.all([
        claimMissingPredictionRepair(db, campaignId, "repair-first"),
        claimMissingPredictionRepair(db, campaignId, "repair-second"),
      ]);
      expect(leases.filter(Boolean)).toHaveLength(1);
      const lease = leases.find(Boolean)!;
      const payload = predictionFixture(lease);
      const rollback = new Error("isolated repair lifecycle rollback");
      await expect(
        db.transaction(async (transaction) => {
          const connection = transaction as unknown as DB;
          await connection.execute(
            sql`UPDATE sim_campaigns SET status = 'cancelled' WHERE id = ${campaignId}::uuid`,
          );
          await expect(
            storeRepairedPrediction(connection, lease, payload),
          ).rejects.toThrow("obsolete or expired");
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      await expect(
        storeRepairedPrediction(db, { ...lease, token: randomUUID() }, payload),
      ).rejects.toThrow("obsolete or expired");
      await expect(
        storeRepairedPrediction(db, lease, {
          ...payload,
          target_signature: "other",
        }),
      ).rejects.toThrow("sealed target");
      await expect(
        storeRepairedPrediction(db, lease, {
          ...payload,
          geometry_fit: { rms_chord: 1, maximum_chord: 2 },
        }),
      ).rejects.toThrow("provenance");
      const predictionId = await storeRepairedPrediction(db, lease, payload);
      expect(await storeRepairedPrediction(db, lease, payload)).toBe(
        predictionId,
      );
      await expect(
        storeRepairedPrediction(db, lease, {
          ...payload,
          prediction_id: "b".repeat(64),
        }),
      ).rejects.toThrow("changed content");
      expect(
        await claimMissingPredictionRepair(db, campaignId, "after-success"),
      ).toBeNull();
      expect(
        await db.execute(sql`SELECT generation.stage, work.id, work.state, work.attempts
        FROM progressive_generations generation JOIN progressive_work work ON work.generation_id = generation.id
        WHERE generation.id = ${baseline.generationId}::uuid ORDER BY work.stage`),
      ).toEqual(before);
      expect(
        await db.execute(sql`SELECT unit.* FROM progressive_cfd_units unit JOIN progressive_work work ON work.id = unit.work_id
        WHERE work.generation_id = ${baseline.generationId}::uuid ORDER BY unit.id`),
      ).toEqual(unitsBefore);
      const [history] = await db.execute(
        sql`SELECT outcome, error FROM progressive_work_attempts WHERE token = ${baseline.token}::uuid`,
      );
      expect(history).toEqual({
        outcome: "failed",
        error: "original geometry fit unavailable",
      });
      const [fit] = await db.execute(
        sql`SELECT state FROM progressive_polar_fit_work WHERE prediction_id = ${predictionId}`,
      );
      expect(fit.state).toBe("pending");
      expect(
        (
          await publicProgressivePolars(
            db,
            baseline.physical.airfoilId,
            baseline.revisionId,
          )
        ).some((series) => series.targetId === baseline.targetId),
      ).toBe(true);
    } finally {
      await db.execute(
        sql`UPDATE sweeper_state SET enabled = ${state.enabled} WHERE id = 1`,
      );
    }
  });

  it("supplemental prediction repair respects pause, obsolete ownership and bounded retry history", async () => {
    const campaignId = await campaign("active", [36.174]);
    await materializeProgressiveCampaignScope(db, campaignId);
    const baseline = (await claim([1]))!;
    const [state] = await db.execute(
      sql`SELECT enabled FROM sweeper_state WHERE id = 1`,
    );
    await db.execute(sql`UPDATE sweeper_state SET enabled = true WHERE id = 1`);
    try {
      expect(
        await claimMissingPredictionRepair(db, campaignId, "not-a-gap"),
      ).toBeNull();
      await failProgressiveWork(db, baseline, "geometry unavailable", false);
      await db.execute(
        sql`UPDATE sim_campaigns SET status = 'paused' WHERE id = ${campaignId}::uuid`,
      );
      expect(
        await claimMissingPredictionRepair(db, campaignId, "paused"),
      ).toBeNull();
      await db.execute(
        sql`UPDATE sim_campaigns SET status = 'active' WHERE id = ${campaignId}::uuid`,
      );
      const first = (await claimMissingPredictionRepair(
        db,
        campaignId,
        "first",
      ))!;
      await db.execute(
        sql`UPDATE progressive_prediction_repairs SET lease_until = clock_timestamp() - interval '1 second' WHERE work_id = ${first.workId}::uuid`,
      );
      const second = (await claimMissingPredictionRepair(
        db,
        campaignId,
        "second",
      ))!;
      expect(second.token).not.toBe(first.token);
      await expect(
        storeRepairedPrediction(db, first, predictionFixture(first)),
      ).rejects.toThrow("obsolete or expired");
      await failPredictionRepair(db, second, "second transport failure", true);
      expect(
        await claimMissingPredictionRepair(db, campaignId, "third"),
      ).toBeNull();
      const attempts = await db.execute(
        sql`SELECT outcome FROM progressive_prediction_repair_attempts WHERE work_id = ${first.workId}::uuid ORDER BY created_at`,
      );
      expect(attempts.map((attempt) => attempt.outcome)).toEqual([
        "expired",
        "failed",
      ]);
      expect(
        (
          await db.execute(
            sql`SELECT stage FROM progressive_generations WHERE id = ${baseline.generationId}::uuid`,
          )
        )[0].stage,
      ).toBe(2);
    } finally {
      await db.execute(
        sql`UPDATE sweeper_state SET enabled = ${state.enabled} WHERE id = 1`,
      );
    }
  });

  it("supplemental prediction repair exhausts an expired final retry without leaving a live lease", async () => {
    const campaignId = await campaign("active", [38.174]);
    await materializeProgressiveCampaignScope(db, campaignId);
    const baseline = (await claim([1]))!;
    await failProgressiveWork(db, baseline, "geometry unavailable", false);
    const [state] = await db.execute(
      sql`SELECT enabled FROM sweeper_state WHERE id = 1`,
    );
    await db.execute(sql`UPDATE sweeper_state SET enabled = true WHERE id = 1`);
    try {
      const first = (await claimMissingPredictionRepair(
        db,
        campaignId,
        "first",
      ))!;
      await failPredictionRepair(
        db,
        first,
        "temporary transport failure",
        true,
      );
      const second = (await claimMissingPredictionRepair(
        db,
        campaignId,
        "second",
      ))!;
      await db.execute(
        sql`UPDATE progressive_prediction_repairs SET lease_until = clock_timestamp() - interval '1 second' WHERE work_id = ${second.workId}::uuid`,
      );
      expect(
        await claimMissingPredictionRepair(db, campaignId, "third"),
      ).toBeNull();
      const [repair] = await db.execute(
        sql`SELECT state, lease_token, attempts FROM progressive_prediction_repairs WHERE work_id = ${second.workId}::uuid`,
      );
      expect(repair).toEqual({ state: "gap", lease_token: null, attempts: 2 });
      expect(
        (
          await db.execute(
            sql`SELECT outcome FROM progressive_prediction_repair_attempts WHERE work_id = ${second.workId}::uuid ORDER BY created_at`,
          )
        ).map((attempt) => attempt.outcome),
      ).toEqual(["failed", "expired"]);
    } finally {
      await db.execute(
        sql`UPDATE sweeper_state SET enabled = ${state.enabled} WHERE id = 1`,
      );
    }
  });

  it("recovers only expired unbound claims, bounds retries, and advances an evidence-free fast gap", async () => {
    const campaignId = await campaign();
    await materializeProgressiveCampaignScope(db, campaignId);
    const baseline = (await claim([1]))!;
    await storeNeuralFoilPrediction(db, baseline, predictionFixture(baseline));
    const count = await initializeProgressiveCfdWork(db);
    const leases = await claimProgressiveCfdBatch(db, {
      owner: "unbound-before-submit",
      leaseSeconds: 120,
    });
    expect(leases).toHaveLength(count);
    expect(await recoverUnboundProgressiveCfdLeases(db)).toEqual({
      retried: 0,
      gaps: 0,
    });
    const expire = () =>
      db.execute(
        sql`UPDATE progressive_cfd_units SET lease_until = clock_timestamp() - interval '1 second' WHERE work_id = ${leases[0].workId}`,
      );
    await expire();
    const receipts = await Promise.all([
      recoverUnboundProgressiveCfdLeases(db),
      recoverUnboundProgressiveCfdLeases(db),
    ]);
    expect(
      receipts.reduce((total, receipt) => total + receipt.retried, 0),
    ).toBe(count);
    const retried = await claimProgressiveCfdBatch(db, {
      owner: "unbound-retry",
      leaseSeconds: 120,
    });
    expect(retried).toHaveLength(count);
    expect(
      retried.every(
        (lease) => !leases.some((previous) => previous.token === lease.token),
      ),
    ).toBe(true);
    await expire();
    expect(await recoverUnboundProgressiveCfdLeases(db)).toEqual({
      retried: 0,
      gaps: count,
    });
    expect(
      await claimProgressiveCfdBatch(db, {
        owner: "unbound-exhausted",
        leaseSeconds: 120,
      }),
    ).toHaveLength(0);
    const attempts = await db.execute(
      sql`SELECT outcome, sim_job_id, active_seconds FROM progressive_cfd_attempts WHERE unit_id = ANY(${sql`ARRAY[${sql.join(
        leases.map((lease) => sql`${lease.id}::uuid`),
        sql`, `,
      )}]`})`,
    );
    expect(attempts).toHaveLength(count * 2);
    expect(
      attempts.every(
        (attempt) =>
          attempt.outcome === "expired" &&
          attempt.sim_job_id === null &&
          Number(attempt.active_seconds) === 0,
      ),
    ).toBe(true);
    expect(await advanceProgressiveCfdStages(db)).toMatchObject({
      admitted: 0,
      closed: 1,
    });
    const [generation] = await db.execute(
      sql`SELECT stage FROM progressive_generations WHERE id = ${baseline.generationId}`,
    );
    expect(generation.stage).toBe(3);
    expect(await db.select().from(resultAttempts)).toHaveLength(0);
  });

  it("never treats a bound job as safe to retry just because its work lease expired", async () => {
    const fixture = await cfdEvidenceFixture();
    await db.execute(
      sql`UPDATE progressive_cfd_units SET lease_until = clock_timestamp() - interval '1 second' WHERE work_id = ${fixture.leases[0].workId}`,
    );
    expect(await recoverUnboundProgressiveCfdLeases(db)).toEqual({
      retried: 0,
      gaps: 0,
    });
    const units = await db.execute(
      sql`SELECT state, lease_token FROM progressive_cfd_units WHERE work_id = ${fixture.leases[0].workId}`,
    );
    expect(
      units.every(
        (unit) =>
          unit.state === "leased" &&
          fixture.leases.some((lease) => lease.token === unit.lease_token),
      ),
    ).toBe(true);
    expect(
      await claimProgressiveCfdBatch(db, {
        owner: "no-duplicate-bound-work",
        leaseSeconds: 120,
      }),
    ).toHaveLength(0);
  });

  it.each(["paused", "cancelled"])(
    "recovers unbound bookkeeping without reactivating a %s campaign",
    async (status) => {
      const campaignId = await campaign();
      await materializeProgressiveCampaignScope(db, campaignId);
      const baseline = (await claim([1]))!;
      await storeNeuralFoilPrediction(
        db,
        baseline,
        predictionFixture(baseline),
      );
      await initializeProgressiveCfdWork(db);
      const leases = await claimProgressiveCfdBatch(db, {
        owner: "unbound-lifecycle",
        leaseSeconds: 120,
      });
      await db
        .update(simCampaigns)
        .set({ status })
        .where(eq(simCampaigns.id, campaignId));
      await db.execute(
        sql`UPDATE progressive_cfd_units SET lease_until = clock_timestamp() - interval '1 second' WHERE work_id = ${leases[0].workId}`,
      );
      expect(await recoverUnboundProgressiveCfdLeases(db)).toEqual({
        retried: status === "paused" ? leases.length : 0,
        gaps: 0,
      });
      expect(
        await claimProgressiveCfdBatch(db, {
          owner: "stopped-cannot-reclaim",
          leaseSeconds: 120,
        }),
      ).toHaveLength(0);
      const [stored] = await db
        .select()
        .from(simCampaigns)
        .where(eq(simCampaigns.id, campaignId));
      expect(stored.status).toBe(status);
    },
  );

  async function finishedFixture(
    stage: 2 | 3 = 2,
    extraCondition = false,
    angles = [-2, 0, 2],
  ) {
    const fixture = await fitFixture(stage, extraCondition, angles);
    expect(await reconcileProgressiveGenerationRequest(db)).toMatchObject({
      campaignId: fixture.campaignId,
      error: null,
    });
    const evidenceIds: string[] = [];
    for (const lease of fixture.leases) {
      for (const seconds of [30, 90]) {
        const evidenceId = await fixture.save(
          seconds,
          seconds === 30 ? "urans" : "rans",
          lease.alpha,
        );
        if (seconds === 30) {
          await fixture.record([evidenceId]);
          evidenceIds.push(evidenceId);
          continue;
        }
        await db
          .update(resultAttempts)
          .set({
            status: "done",
            validForPolar: true,
            evidencePayload: {
              solver_active_seconds: seconds,
              converged: true,
              cl: lease.alpha * 0.1 + 0.2,
              cd: 0.02,
              cm: -0.03,
            },
          })
          .where(eq(resultAttempts.id, evidenceId));
        await db.execute(sql`
          INSERT INTO result_classifications(result_attempt_id, airfoil_id, simulation_preset_revision_id, aoa_deg, classifier_version, state)
          SELECT id, airfoil_id, simulation_preset_revision_id, aoa_deg, 'isolated-stage-transition', 'accepted'::result_classification_state
          FROM result_attempts WHERE id = ${evidenceId}
        `);
        await fixture.record([evidenceId]);
        evidenceIds.push(evidenceId);
      }
    }
    const lease = (await fixture.acquire())!;
    const request = buildProgressiveFitRequest(lease);
    const response = await fitUsingPython(request);
    await storeProgressivePolarFit(db, lease, request, response);
    await acknowledgeProgressiveCfdExecutionStop(db, {
      simJobId: fixture.composed.jobId,
      proof: executionStopProof(fixture.engineJobId),
    });
    await db
      .update(simJobs)
      .set({ status: "done", ingestedAt: new Date() })
      .where(eq(simJobs.id, fixture.composed.jobId));
    expect(
      await settleProgressiveCfdExecution(db, fixture.composed.jobId),
    ).toMatchObject({ complete: fixture.leases.length, waiting: 0 });
    return { ...fixture, evidenceIds };
  }

  it("admits one adaptive point from the current whole-curve model and one cumulative cost per execution", async () => {
    const fixture = await finishedFixture();
    const receipts = await Promise.all([
      advanceProgressiveCfdStages(db),
      advanceProgressiveCfdStages(db),
    ]);
    expect(
      receipts.reduce((total, receipt) => total + receipt.admitted, 0),
    ).toBe(1);
    const decisions = await db.execute(
      sql`SELECT * FROM progressive_cfd_stage_decisions WHERE work_id = ${fixture.leases[0].workId}`,
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      kind: "adaptive",
      summary: {
        expectedActiveSeconds: 90,
        costPolicy: "observed_upper_median_same_target",
      },
    });
    expect(fixture.evidenceIds).toContain(decisions[0].cost_evidence_id);
    expect(decisions[0].model_id).toBeTruthy();
    const [unit] = await db.execute(
      sql`SELECT * FROM progressive_cfd_units WHERE work_id = ${fixture.leases[0].workId} AND purpose = 'adaptive'`,
    );
    expect(unit).toMatchObject({
      aoa_deg: decisions[0].candidate_alpha,
      active_budget_seconds: 900,
    });
    await expect(
      db.execute(
        sql`UPDATE progressive_cfd_stage_decisions SET reason = 'changed' WHERE work_id = ${fixture.leases[0].workId}`,
      ),
    ).rejects.toThrow("immutable");
    expect(await advanceProgressiveCfdStages(db)).toMatchObject({
      admitted: 0,
      closed: 0,
    });
  }, 120_000);

  it("waits for all initial profiles and conditions before spending adaptive compute", async () => {
    await finishedFixture(2, true);
    expect(await advanceProgressiveCfdStages(db)).toMatchObject({
      admitted: 0,
      closed: 0,
      waiting: 0,
    });
  }, 120_000);

  it("opens the precise grid only after bounded fast work closes and preserves its immutable recipe", async () => {
    const fixture = await finishedFixture(2, false, [-2, 2]);
    expect(
      await claimProgressiveCfdBatch(db, {
        owner: "too-early-precise",
        leaseSeconds: 120,
      }),
    ).toHaveLength(0);
    expect(await advanceProgressiveCfdStages(db)).toMatchObject({
      admitted: 0,
      closed: 1,
      campaignsCompleted: 0,
    });
    const [generation] = await db.execute(
      sql`SELECT stage, status FROM progressive_generations WHERE id = ${fixture.leases[0].generationId}`,
    );
    expect(generation).toMatchObject({ stage: 3, status: "active" });
    expect(await initializeProgressiveCfdWork(db)).toBe(2);
    const precise = await claimProgressiveCfdBatch(db, {
      owner: "precise-after-fast",
      leaseSeconds: 120,
    });
    expect(
      precise.map((lease) => lease.alpha).sort((left, right) => left - right),
    ).toEqual([-2, 2]);
    expect(
      precise.every(
        (lease) =>
          lease.stage === 3 &&
          lease.generationId === fixture.leases[0].generationId,
      ),
    ).toBe(true);
    const [decision] = await db.execute(
      sql`SELECT * FROM progressive_cfd_stage_decisions WHERE work_id = ${fixture.leases[0].workId}`,
    );
    expect(decision).toMatchObject({
      kind: "close_fast",
      reason: "angle_budget",
      candidate_alpha: null,
    });
  }, 120_000);

  it("waits for a refreshed fit without starving a different ready campaign, and advances past a terminal fitting gap", async () => {
    const waiting = await finishedFixture();
    await db.execute(
      sql`UPDATE progressive_polar_fit_work SET state = 'pending', model_id = NULL WHERE prediction_id = ${waiting.predictionId}`,
    );
    const ready = await finishedFixture();
    expect(await advanceProgressiveCfdStages(db)).toMatchObject({
      admitted: 1,
      closed: 0,
    });
    const decisions = await db.execute(
      sql`SELECT work_id FROM progressive_cfd_stage_decisions`,
    );
    expect(decisions.map((decision) => decision.work_id)).toEqual([
      ready.leases[0].workId,
    ]);
    await db.execute(
      sql`UPDATE progressive_polar_fit_work SET state = 'gap', error = 'isolated exhausted fit' WHERE prediction_id = ${waiting.predictionId}`,
    );
    expect(await advanceProgressiveCfdStages(db)).toMatchObject({
      admitted: 0,
      closed: 1,
    });
    const [work] = await db.execute(
      sql`SELECT state, error FROM progressive_work WHERE id = ${waiting.leases[0].workId}`,
    );
    expect(work).toMatchObject({
      state: "gap",
      error: "fast_model_unavailable_after_bounded_work",
    });
    const [generation] = await db.execute(
      sql`SELECT stage FROM progressive_generations WHERE id = ${waiting.leases[0].generationId}`,
    );
    expect(generation.stage).toBe(3);
  }, 120_000);

  it("never advances evidence from a previous calculation epoch", async () => {
    const fixture = await finishedFixture();
    await rotateCalculationEpoch(db, "isolated stage transition epoch reset");
    expect(await advanceProgressiveCfdStages(db)).toMatchObject({
      admitted: 0,
      closed: 0,
      campaignsCompleted: 0,
    });
    const decisions = await db.execute(
      sql`SELECT work_id FROM progressive_cfd_stage_decisions WHERE work_id = ${fixture.leases[0].workId}`,
    );
    expect(decisions).toHaveLength(0);
  }, 120_000);

  it("does not close or refine a logically completed unit without physical stop proof", async () => {
    const fixture = await fitFixture();
    await db.execute(
      sql`UPDATE progressive_cfd_units SET state = 'complete', lease_token = NULL, lease_owner = NULL, lease_until = NULL WHERE work_id = ${fixture.leases[0].workId}`,
    );
    await db.execute(
      sql`UPDATE progressive_cfd_attempts SET outcome = 'complete' WHERE unit_id IN (SELECT id FROM progressive_cfd_units WHERE work_id = ${fixture.leases[0].workId})`,
    );
    expect(await advanceProgressiveCfdStages(db)).toMatchObject({
      admitted: 0,
      closed: 0,
      waiting: 0,
    });
  });

  it.each(["active", "paused", "cancelled"])(
    "preserves %s campaign semantics when the exact precise grid is finished",
    async (status) => {
      const fixture = await finishedFixture(3);
      await db
        .update(simCampaigns)
        .set({ status })
        .where(eq(simCampaigns.id, fixture.campaignId));
      const receipt = await advanceProgressiveCfdStages(db);
      expect(receipt.closed).toBe(status === "cancelled" ? 0 : 1);
      const [generation] = await db.execute(
        sql`SELECT status FROM progressive_generations WHERE id = ${fixture.leases[0].generationId}`,
      );
      expect(generation.status).toBe(
        status === "cancelled" ? "active" : "complete",
      );
      const [stored] = await db
        .select()
        .from(simCampaigns)
        .where(eq(simCampaigns.id, fixture.campaignId));
      expect(stored.status).toBe(status === "active" ? "completed" : status);
      if (status === "active") expect(stored.completedAt).not.toBeNull();
    },
    120_000,
  );

  it("finishes a sealed generation with honest gaps and does not repeatedly finish an attention campaign", async () => {
    const fixture = await fitFixture(3);
    expect(await reconcileProgressiveGenerationRequest(db)).toMatchObject({
      campaignId: fixture.campaignId,
      error: null,
    });
    await acknowledgeProgressiveCfdExecutionStop(db, {
      simJobId: fixture.composed.jobId,
      proof: executionStopProof(fixture.engineJobId),
    });
    await db
      .update(simJobs)
      .set({ status: "cancelled", ingestedAt: new Date() })
      .where(eq(simJobs.id, fixture.composed.jobId));
    await settleProgressiveCfdExecution(db, fixture.composed.jobId);
    expect(await advanceProgressiveCfdStages(db)).toMatchObject({
      closed: 1,
      campaignsCompleted: 1,
    });
    const [stored] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, fixture.campaignId));
    expect(stored.status).toBe("attention");
    expect(stored.completedAt).toBeNull();
    expect(await advanceProgressiveCfdStages(db)).toMatchObject({
      closed: 0,
      campaignsCompleted: 0,
    });
  });

  it("reconciles campaign completion after a pending profile-expansion request settles, even with no open CFD work", async () => {
    const fixture = await finishedFixture(3);
    await db.execute(
      sql`UPDATE progressive_scope_requests SET requested_version = requested_version + 1 WHERE campaign_id = ${fixture.campaignId}`,
    );
    expect(await advanceProgressiveCfdStages(db)).toMatchObject({
      closed: 1,
      campaignsCompleted: 0,
    });
    await db.execute(
      sql`UPDATE progressive_scope_requests SET processed_version = requested_version WHERE campaign_id = ${fixture.campaignId}`,
    );
    expect(await advanceProgressiveCfdStages(db)).toMatchObject({
      closed: 0,
      campaignsCompleted: 1,
    });
  }, 120_000);
});

describe("progressive live solver accounting", () => {
  it("marches unequal remaining allocations together and validates each exact case receipt", async () => {
    const scope = await cfdEvidenceFixture(
      32.173 + (sequence + 1) / 100,
      2,
      [],
      [-2, 0, 2],
      true,
    );
    expect(scope.leases).toHaveLength(2);
    expect(
      scope.composed.request.resources!.case_solver_budget_seconds,
    ).toBeUndefined();
    expect(scope.composed.request.expected_solver_budget_version).toBe(2);
    const allocations =
      scope.composed.request.resources!.case_solver_allocations!;
    expect(
      allocations.map((allocation) => allocation.limit_seconds).sort(),
    ).toEqual([780, 900]);
    expect(scope.composed.request.aoa.angles).toEqual(
      allocations.map((allocation) => allocation.aoa_deg),
    );
    expect(scope.composed.request.resources!.case_concurrency).toBe(1);
    expect(scope.composed.request.solver!.warm_start).toBe(true);
    const progress = {
      version: 1 as const,
      job_id: scope.engineJobId,
      observed_at: "2026-09-07T06:00:00.000001Z",
      cases: allocations.map((allocation) => ({
        ...allocation,
        solver_active_seconds: 3,
        solver_running: true,
      })),
    };
    expect(
      await recordProgressiveCfdRuntimeProgress(db, {
        simJobId: scope.composed.jobId,
        engineJobId: scope.engineJobId,
        progress,
      }),
    ).toMatchObject({ updated: 2 });
    const swapped = structuredClone(progress);
    swapped.observed_at = "2026-09-07T06:00:00.000002Z";
    swapped.cases[0].limit_seconds = allocations[1].limit_seconds;
    await expect(
      recordProgressiveCfdRuntimeProgress(db, {
        simJobId: scope.composed.jobId,
        engineJobId: scope.engineJobId,
        progress: swapped,
      }),
    ).rejects.toThrow("immutable physical case allocation");
    for (const allocation of allocations) {
      const evidence = await scope.save(4, "rans", allocation.aoa_deg, {
        solver_budget: {
          version: 1,
          scope: "physical_case_v1",
          limit_seconds: allocation.limit_seconds,
          exhausted: false,
        },
      });
      await scope.record([evidence]);
    }
    const units =
      await db.execute(sql`SELECT id, active_seconds, attempts FROM progressive_cfd_units
      WHERE id IN (${scope.leases[0].id}, ${scope.leases[1].id})`);
    expect(units.find((unit) => unit.id === scope.retriedUnitId)).toMatchObject(
      { active_seconds: 124, attempts: 2 },
    );
    expect(units.find((unit) => unit.id !== scope.retriedUnitId)).toMatchObject(
      { active_seconds: 4, attempts: 1 },
    );
  });

  async function fixture() {
    const scope = await fitFixture();
    const observation = (
      seconds: number,
      observedAt = "2026-09-07T00:00:00.000001Z",
    ) => ({
      version: 1 as const,
      job_id: scope.engineJobId,
      observed_at: observedAt,
      cases: [
        {
          chord: scope.execution.snapshot.referenceGeometry.referenceLengthM,
          speed: scope.execution.snapshot.flowState.speedMps,
          aoa_deg: scope.leases[0].alpha,
          solver_active_seconds: seconds,
          limit_seconds:
            scope.composed.request.resources!.case_solver_budget_seconds!,
          solver_running: true,
        },
      ],
    });
    const record = (progress: ReturnType<typeof observation>) =>
      recordProgressiveCfdRuntimeProgress(db, {
        simJobId: scope.composed.jobId,
        engineJobId: scope.engineJobId,
        progress,
      });
    return { ...scope, observation, recordRuntime: record };
  }

  it("accounts actual live seconds idempotently and combines final evidence without double counting", async () => {
    const scope = await fixture();
    expect(await scope.recordRuntime(scope.observation(30.25))).toEqual({
      updated: 1,
      replayed: 0,
      stale: 0,
    });
    expect(await scope.recordRuntime(scope.observation(30.25))).toEqual({
      updated: 0,
      replayed: 1,
      stale: 0,
    });
    expect(
      await scope.recordRuntime(
        scope.observation(60.5, "2026-09-07T00:00:00.000002Z"),
      ),
    ).toMatchObject({ updated: 1 });
    expect(await scope.recordRuntime(scope.observation(500))).toMatchObject({
      stale: 1,
    });
    await expect(
      scope.recordRuntime(scope.observation(61, "2026-09-07T00:00:00.000002Z")),
    ).rejects.toThrow("replay changed");
    await expect(
      scope.recordRuntime(scope.observation(50, "2026-09-07T00:00:01Z")),
    ).rejects.toThrow("time regressed");
    const [unit] = await db.execute(
      sql`SELECT active_seconds FROM progressive_cfd_units WHERE id = ${scope.leases[0].id}`,
    );
    expect(unit.active_seconds).toBe(60.5);
    expect(
      await db.execute(
        sql`SELECT id FROM result_attempts WHERE sim_job_id = ${scope.composed.jobId}`,
      ),
    ).toHaveLength(0);
    const queued = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, scope.composed.jobId));
    for (const result of queued)
      expect(result).toMatchObject({
        status: "queued",
        cl: null,
        cd: null,
        cm: null,
      });
    await scope.record([await scope.save(70)]);
    const [combined] = await db.execute(
      sql`SELECT active_seconds FROM progressive_cfd_units WHERE id = ${scope.leases[0].id}`,
    );
    expect(combined.active_seconds).toBe(70);
    expect(
      await scope.recordRuntime(scope.observation(72, "2026-09-07T00:00:02Z")),
    ).toMatchObject({ updated: 1 });
    await scope.record([await scope.save(72, "urans")]);
    const [final] = await db.execute(
      sql`SELECT active_seconds FROM progressive_cfd_units WHERE id = ${scope.leases[0].id}`,
    );
    expect(final.active_seconds).toBe(72);
  });

  it.each([
    "duplicate",
    "speed",
    "chord",
    "alpha",
    "limit",
    "duration",
    "identity",
    "timezone",
  ])("rejects invalid live scope atomically (%s)", async (change) => {
    const scope = await fixture();
    const observation = scope.observation(30);
    if (change === "duplicate")
      observation.cases.push({ ...observation.cases[0] });
    if (change === "speed") observation.cases[0].speed += 0.1;
    if (change === "chord") observation.cases[0].chord += 0.1;
    if (change === "alpha") observation.cases[0].aoa_deg = 89;
    if (change === "limit") observation.cases[0].limit_seconds += 1;
    if (change === "duration") observation.cases[0].solver_active_seconds = NaN;
    if (change === "identity") observation.job_id = randomUUID();
    if (change === "timezone") observation.observed_at = "2026-09-07T00:00:00";
    await expect(scope.recordRuntime(observation)).rejects.toThrow();
    expect(
      await db.execute(
        sql`SELECT attempt_token FROM progressive_cfd_runtime_progress WHERE engine_job_id = ${scope.engineJobId}`,
      ),
    ).toHaveLength(0);
    const [unit] = await db.execute(
      sql`SELECT active_seconds FROM progressive_cfd_units WHERE id = ${scope.leases[0].id}`,
    );
    expect(unit.active_seconds).toBe(0);
  });

  it("ingests live progress without a completed-case counter and preserves sibling execution at the guarded limit", async () => {
    const scope = await fixture();
    const engine = new EngineClient("http://unused.invalid");
    const progress = scope.observation(
      scope.composed.request.resources!.case_solver_budget_seconds!,
    );
    const status = vi.spyOn(engine, "getJob").mockResolvedValue({
      job_id: scope.engineJobId,
      state: "running",
      total_cases: scope.leases.length,
      completed_cases: 0,
      solver_budget_progress: progress,
    });
    const resultsCall = vi.spyOn(engine, "getResult");
    const cancel = vi.spyOn(engine, "cancelJob");
    try {
      const [job] = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.id, scope.composed.jobId));
      await reconcileProgressiveCfdJob(db, engine, job);
      expect(resultsCall).not.toHaveBeenCalled();
      expect(
        await reconcileProgressiveExecutions(db, engine, { jobIds: [job.id] }),
      ).toMatchObject({ inspected: 0 });
      expect(cancel).not.toHaveBeenCalled();
      const [unit] = await db.execute(
        sql`SELECT state, active_seconds FROM progressive_cfd_units WHERE id = ${scope.leases[0].id}`,
      );
      expect(unit).toMatchObject({
        state: "blocked",
        active_seconds: progress.cases[0].limit_seconds,
      });
      await expect(settleProgressiveCfdExecution(db, job.id)).rejects.toThrow(
        "no persisted stop acknowledgement",
      );
      await expect(
        acknowledgeProgressiveCfdExecutionStop(db, {
          simJobId: job.id,
          proof: {
            ...executionStopProof(scope.engineJobId),
            fence: "cancel_marker",
            ownership_basis: "never_started_cancellation_fence",
          },
        }),
      ).rejects.toThrow("conflicts with stored solver attempts");
    } finally {
      status.mockRestore();
      resultsCall.mockRestore();
      cancel.mockRestore();
    }
  });
});

describe("progressive CPU admission", () => {
  it("indexes exact text promise identity without broadening legacy ownership", async () => {
    const campaignId = await campaign();
    const [condition] = await db
      .select()
      .from(simCampaignConditions)
      .where(eq(simCampaignConditions.campaignId, campaignId))
      .limit(1);
    const promiseIds: string[] = [];
    try {
      const inserted = await db.execute(sql`
        INSERT INTO sync_sweep_promises (airfoil_id, simulation_preset_revision_id, aoa_count, "expiresAt")
        SELECT ${originalId}::uuid, ${condition.simulationPresetRevisionId}::uuid, 1, clock_timestamp() + interval '1 hour'
        FROM generate_series(1, 800) RETURNING id
      `);
      promiseIds.push(...inserted.map((row) => String(row.id)));
      await db.execute(sql`ANALYZE sync_sweep_promises`);
      const exact = promiseIds.find((id) => /[a-f]/.test(id))!;
      const [planned] = await db.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT id FROM sync_sweep_promises WHERE id::text = ${exact}`);
      const plan = (
        planned["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>
      )[0].Plan;
      expect(JSON.stringify(plan)).toContain(
        "sync_sweep_promises_text_identity_idx",
      );
      expect(plan["Actual Rows"]).toBe(1);
      for (const incorrect of [
        exact.toUpperCase(),
        `${exact} `,
        "not-a-uuid",
        null,
      ]) {
        expect(
          await db.execute(
            sql`SELECT id FROM sync_sweep_promises WHERE id::text = ${incorrect}`,
          ),
        ).toHaveLength(0);
      }
    } finally {
      if (promiseIds.length)
        await db.execute(sql`
        DELETE FROM sync_sweep_promises WHERE id IN (${sql.join(
          promiseIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      `);
    }
  });

  async function ready(
    run: (scope: {
      campaignId: string;
      generationId: string;
      poolId: string;
    }) => Promise<void>,
    speeds = [32.173],
    stage: 2 | 3 = 2,
  ) {
    const campaignId = await campaign("active", speeds);
    await newProfile();
    await reconcileCampaignProfileEnrollment(db);
    const generation = await materializeProgressiveCampaignScope(
      db,
      campaignId,
    );
    const scope = { campaignId, generationId: generation!.id };
    for (let profile = 0; profile < 2 * speeds.length; profile += 1) {
      const baseline = (await claim([1]))!;
      await storeNeuralFoilPrediction(
        db,
        baseline,
        predictionFixture(baseline),
      );
    }
    if (stage === 3) {
      for (let target = 0; target < 2 * speeds.length; target += 1) {
        const fast = (await claim([2]))!;
        expect(fast.generationId).toBe(generation!.id);
        await failProgressiveWork(
          db,
          fast,
          "Isolated capability fixture: preliminary work unavailable",
          false,
        );
      }
    }
    await initializeProgressiveCfdWork(db);
    const [pool] =
      await db.execute(sql`SELECT pool.id, pool.enabled FROM progressive_generation_targets target
      JOIN simulation_preset_revisions revision ON revision.id = target.revision_id
      JOIN solver_execution_pools pool ON pool.solver_implementation_id = revision.solver_implementation_id
      WHERE target.generation_id = ${scope.generationId} ORDER BY pool.id LIMIT 1`);
    const [state] = await db
      .select()
      .from(sweeperState)
      .where(eq(sweeperState.id, 1));
    await db
      .update(solverExecutionPools)
      .set({ enabled: true })
      .where(eq(solverExecutionPools.id, String(pool.id)));
    await db
      .update(sweeperState)
      .set({ enabled: true, cpuSlots: 2, maxConcurrentJobs: 2 })
      .where(eq(sweeperState.id, 1));
    try {
      await run({ ...scope, poolId: String(pool.id) });
    } finally {
      await db
        .update(solverExecutionPools)
        .set({ enabled: Boolean(pool.enabled) })
        .where(eq(solverExecutionPools.id, String(pool.id)));
      await db
        .update(sweeperState)
        .set({
          enabled: state.enabled,
          cpuSlots: state.cpuSlots,
          maxConcurrentJobs: state.maxConcurrentJobs,
          diskAdmissionBlocked: state.diskAdmissionBlocked,
        })
        .where(eq(sweeperState.id, 1));
    }
  }

  it.each(["local", "remote"] as const)(
    "defers owned result cells without blocking another target on the %s path",
    async (mode) => {
      await ready(
        (scope) => verifyProgressiveClaimDeferral(db, scope, mode),
        [32.1793],
      );
    },
  );

  it("progressive remote dispatch pins one exact request and holds CPU through promise expiry until physical stop", async () => {
    await ready(async () => {
      const leases = await claimProgressiveCfdBatch(db, {
        owner: "remote-dispatch-fixture",
        leaseSeconds: 120,
        solverBudgetVersion: 2,
      });
      const composed = await composeProgressiveCfdJob(db, leases, {
        cpuSlots: 1,
        meshRecoveryVersion: 1,
        solverBudgetVersion: 2,
      });
      const [job] = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.id, composed.jobId));
      const solverId = randomUUID();
      const promiseId = randomUUID();
      const assignment = { simJobId: job.id, solverId, promiseId };
      await db.execute(sql`
        INSERT INTO registered_remote_solvers (id, instance_id, instance_name, cpu_capacity, cpu_budget, max_active_polar_promises)
        VALUES (${solverId}::uuid, ${randomUUID()}, 'isolated remote worker', 96, 96, 96)
      `);
      await db.execute(sql`
        INSERT INTO sync_sweep_promises (id, registered_solver_id, airfoil_id, simulation_preset_revision_id, aoa_count, "expiresAt")
        VALUES (${promiseId}::uuid, ${solverId}::uuid, ${job.airfoilId}::uuid, ${job.simulationPresetRevisionId}::uuid,
          ${leases.length}, clock_timestamp() + interval '1 hour')
      `);
      for (const lease of leases)
        await db.execute(sql`
          INSERT INTO sync_sweep_promise_points (promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg)
          VALUES (${promiseId}::uuid, ${job.airfoilId}::uuid, ${job.simulationPresetRevisionId}::uuid, ${lease.alpha})
        `);
      try {
        await db.execute(
          sql`UPDATE sync_sweep_promise_points SET aoa_deg = aoa_deg + 0.125 WHERE promise_id = ${promiseId}::uuid`,
        );
        await expect(
          bindProgressiveRemoteDispatch(db, assignment),
        ).rejects.toThrow("angle list");
        await db.execute(
          sql`UPDATE sync_sweep_promise_points SET aoa_deg = aoa_deg - 0.125 WHERE promise_id = ${promiseId}::uuid`,
        );
        await db.execute(
          sql`UPDATE registered_remote_solvers SET cpu_capacity = 0 WHERE id = ${solverId}::uuid`,
        );
        await expect(
          bindProgressiveRemoteDispatch(db, assignment),
        ).rejects.toThrow("CPU reservation");
        await db.execute(
          sql`UPDATE registered_remote_solvers SET cpu_capacity = 96, max_active_polar_promises = 0 WHERE id = ${solverId}::uuid`,
        );
        await expect(
          bindProgressiveRemoteDispatch(db, assignment),
        ).rejects.toThrow("promise policy");
        await db.execute(
          sql`UPDATE registered_remote_solvers SET max_active_polar_promises = 96 WHERE id = ${solverId}::uuid`,
        );
        const payload = structuredClone(job.requestPayload) as {
          engineRequest: { resources: { case_solver_budget_seconds: number } };
          progressive: { units: Array<{ activeBudgetSeconds: number }> };
        };
        payload.engineRequest.resources.case_solver_budget_seconds -= 1;
        payload.progressive.units.forEach((unit) => {
          unit.activeBudgetSeconds -= 1;
        });
        await db
          .update(simJobs)
          .set({ requestPayload: payload })
          .where(eq(simJobs.id, job.id));
        await expect(
          bindProgressiveRemoteDispatch(db, assignment),
        ).rejects.toThrow("remaining allocation");
        await db
          .update(simJobs)
          .set({ requestPayload: job.requestPayload })
          .where(eq(simJobs.id, job.id));
        const bound = await bindProgressiveRemoteDispatch(db, assignment);
        expect(bound.replayed).toBe(false);
        expect(bound.envelope.request).toEqual(
          JSON.parse(JSON.stringify(composed.request)),
        );
        const forecastRollback = new Error(
          "isolated disk attribution rollback",
        );
        await expect(
          db.transaction(async (transaction) => {
            const connection = transaction as unknown as DB;
            await connection.execute(
              sql`UPDATE sim_jobs SET status = 'running', engine_state = 'running' WHERE id = ${job.id}::uuid`,
            );
            const remote = await loadDiskAdmissionExposure(connection);
            await connection.execute(
              sql`DELETE FROM progressive_remote_dispatches WHERE sim_job_id = ${job.id}::uuid`,
            );
            const local = await loadDiskAdmissionExposure(connection);
            expect(local.activeLocalJobCount).toBe(
              remote.activeLocalJobCount + 1,
            );
            expect(local.activeLocalReservedBytes).toBeGreaterThan(
              remote.activeLocalReservedBytes,
            );
            throw forecastRollback;
          }),
        ).rejects.toBe(forecastRollback);
        const report: ProgressiveRemoteReport = {
          version: 1,
          solverId,
          promiseId,
          executionId: job.id,
          assignmentSignature: bound.envelope.contentSignature,
          sequence: 1,
          status: {
            job_id: job.id,
            state: "pending",
            total_cases: leases.length,
            completed_cases: 0,
          },
          result: null,
          stopProof: null,
        };
        const sender = { solverId, promiseId, executionId: job.id };
        await expect(
          storeProgressiveRemoteReport(db, {
            ...sender,
            solverId: randomUUID(),
            report,
          }),
        ).rejects.toThrow("sender");
        const receipts = await Promise.all([
          storeProgressiveRemoteReport(db, { ...sender, report }),
          storeProgressiveRemoteReport(db, { ...sender, report }),
        ]);
        expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([
          false,
          true,
        ]);
        expect(receipts[0].contentSignature).toBe(receipts[1].contentSignature);
        await expect(
          storeProgressiveRemoteReport(db, {
            ...sender,
            report: {
              ...report,
              status: { ...report.status, message: "changed replay" },
            },
          }),
        ).rejects.toThrow("immutable content");
        await expect(
          storeProgressiveRemoteReport(db, {
            ...sender,
            report: { ...report, sequence: 3 },
          }),
        ).rejects.toThrow("publication order");
        const reportedResult = progressiveRemoteEvidenceResult(bound.envelope);
        const running = {
          ...report,
          sequence: 2,
          result: reportedResult,
          status: {
            ...report.status,
            engine: reportedResult.engine,
            state: "running" as const,
            completed_cases: 1,
            solver_budget_progress: {
              version: 1 as const,
              job_id: job.id,
              observed_at: new Date().toISOString(),
              cases: [
                {
                  chord: bound.envelope.request.chord_lengths![0],
                  speed: bound.envelope.request.speeds![0],
                  aoa_deg: leases[0].alpha,
                  solver_active_seconds: 1,
                  limit_seconds: leases[0].remainingActiveSeconds,
                  solver_running: true,
                },
              ],
            },
          },
        };
        await verifyProgressiveAcceptedArchiveReplay(
          db,
          bound.envelope,
          running,
          client.sql,
        );
        await storeProgressiveRemoteReport(db, { ...sender, report: running });
        await verifyProgressiveRemoteEvidenceSource(
          db,
          bound.envelope,
          running,
          client.sql,
        );
        const terminal = {
          ...running,
          sequence: 3,
          result: { ...running.result, state: "failed" as const },
          status: { ...running.status, state: "failed" as const },
          stopProof: executionStopProof(job.id),
        };
        await storeProgressiveRemoteReport(db, { ...sender, report: terminal });
        expect(await progressiveRemoteReservedSlots(db, solverId)).toBe(1);
        const stopRollback = new Error(
          "isolated early-stop acknowledgement rollback",
        );
        await expect(
          db.transaction(async (transaction) => {
            const connection = transaction as unknown as DB;
            expect(
              await acknowledgeLatestProgressiveRemoteStop(connection, job.id),
            ).toBe(true);
            expect(
              await progressiveRemoteReservedSlots(connection, solverId),
            ).toBe(0);
            expect(
              await acknowledgeLatestProgressiveRemoteStop(connection, job.id),
            ).toBe(false);
            const [unchanged] = await connection.execute(sql`
            SELECT job.status, job."ingestedAt" AS ingested,
              (SELECT count(*)::integer FROM progressive_remote_progress_receipts receipt WHERE receipt.sim_job_id = job.id) AS progress
            FROM sim_jobs job WHERE id = ${job.id}::uuid
          `);
            expect(unchanged).toEqual({
              status: "pending",
              ingested: null,
              progress: 0,
            });
            for (const sequence of [1, 2]) {
              expect(
                await applyProgressiveRemoteProgress(connection, job.id),
              ).toMatchObject({ kind: "applied", sequence });
            }
            expect(
              await progressiveRemoteReservedSlots(connection, solverId),
            ).toBe(0);
            await connection.execute(
              sql`UPDATE sim_jobs SET engine_job_id = ${randomUUID()} WHERE id = ${job.id}::uuid`,
            );
            await expect(
              acknowledgeLatestProgressiveRemoteStop(connection, job.id),
            ).rejects.toThrow("immutable hub execution ownership");
            throw stopRollback;
          }),
        ).rejects.toBe(stopRollback);
        await expect(
          storeProgressiveRemoteReport(db, {
            ...sender,
            report: { ...running, sequence: 4 },
          }),
        ).rejects.toThrow("cannot resume");
        await expect(
          storeProgressiveRemoteReport(db, {
            ...sender,
            report: {
              ...terminal,
              sequence: 4,
              status: { ...terminal.status, completed_cases: 0 },
            },
          }),
        ).rejects.toThrow("completed cases");
        await expect(
          db.execute(
            sql`UPDATE progressive_remote_reports SET content_signature = ${"0".repeat(64)} WHERE sim_job_id = ${job.id}::uuid`,
          ),
        ).rejects.toThrow();
        const [storedReports] = await db.execute(
          sql`SELECT count(*)::integer AS count FROM progressive_remote_reports WHERE sim_job_id = ${job.id}::uuid`,
        );
        expect(storedReports.count).toBe(3);
        await verifyProgressiveWorkerJobMirror(
          db,
          bound.envelope,
          executionStopProof,
        );
        await verifyProgressiveWorkerJobMirror(
          db,
          bound.envelope,
          executionStopProof,
          "success",
        );
        await verifyProgressiveWorkerJobMirror(
          db,
          bound.envelope,
          executionStopProof,
          "never-authorized",
        );
        await verifyProgressiveWorkerReportDelivery(db, bound.envelope, [
          report,
          running,
          terminal,
        ]);
        expect(await bindProgressiveRemoteDispatch(db, assignment)).toEqual({
          ...bound,
          replayed: true,
        });
        await expect(
          bindProgressiveRemoteDispatch(db, {
            ...assignment,
            promiseId: randomUUID(),
          }),
        ).rejects.toThrow("stored assignment");
        await expect(
          db.execute(
            sql`UPDATE progressive_remote_dispatches SET cpu_slots = 2 WHERE sim_job_id = ${job.id}::uuid`,
          ),
        ).rejects.toThrow();
        expect(await progressiveRemoteReservedSlots(db, solverId)).toBe(1);
        expect(await solverQueuePressure(db, { jobIds: [job.id] })).toBe(0);
        await db.execute(
          sql`UPDATE sync_sweep_promises SET status = 'expired', "expiresAt" = clock_timestamp() - interval '1 second' WHERE id = ${promiseId}::uuid`,
        );
        expect(await progressiveRemoteReservedSlots(db, solverId)).toBe(1);
        await db.execute(
          sql`UPDATE sync_sweep_promises SET status = 'cancelled' WHERE id = ${promiseId}::uuid`,
        );
        expect(await progressiveRemoteReservedSlots(db, solverId)).toBe(1);
        await db
          .update(simJobs)
          .set({
            status: "cancelled",
            engineJobId: job.id,
            engineState: "submission_cancel_pending",
          })
          .where(eq(simJobs.id, job.id));
        const wrongHost = new EngineClient("http://unused.invalid");
        const cancelLocal = vi.spyOn(wrongHost, "cancelJob");
        const pollLocal = vi.spyOn(wrongHost, "getJob");
        const stopLocal = vi.spyOn(wrongHost, "getExecutionStopProof");
        expect(
          await recoverProgressiveSubmissions(db, wrongHost, {
            jobIds: [job.id],
          }),
        ).toMatchObject({ inspected: 0 });
        expect(
          await reconcileProgressiveExecutions(db, wrongHost, {
            jobIds: [job.id],
          }),
        ).toMatchObject({ inspected: 0 });
        const [cancelledJob] = await db
          .select()
          .from(simJobs)
          .where(eq(simJobs.id, job.id));
        await reconcileProgressiveCfdJob(db, wrongHost, cancelledJob);
        expect(cancelLocal).not.toHaveBeenCalled();
        expect(pollLocal).not.toHaveBeenCalled();
        expect(stopLocal).not.toHaveBeenCalled();
        await db.execute(
          sql`UPDATE sim_jobs SET engine_job_id = ${randomUUID()} WHERE id = ${job.id}::uuid`,
        );
        await expect(
          applyProgressiveRemoteProgress(db, job.id),
        ).rejects.toThrow("immutable hub execution ownership");
        expect(await progressiveRemoteReservedSlots(db, solverId)).toBe(1);
        await db.execute(
          sql`UPDATE sim_jobs SET engine_job_id = ${job.id} WHERE id = ${job.id}::uuid`,
        );
        for (const sequence of [1, 2, 3]) {
          if (sequence === 3)
            await db.execute(
              sql`UPDATE sim_campaigns SET status = 'cancelled' WHERE id = ${job.campaignId}::uuid`,
            );
          expect(
            await applyProgressiveRemoteProgress(db, job.id),
          ).toMatchObject({
            kind: "applied",
            sequence,
            stopped: sequence === 3,
          });
        }
        expect(await applyProgressiveRemoteProgress(db, job.id)).toEqual({
          kind: "idle",
        });
        await verifyProgressiveRemoteReportInventory(db, terminal);
        const [projected] = await db.execute(sql`SELECT job.status,
          (SELECT count(*)::integer FROM progressive_remote_progress_receipts receipt WHERE receipt.sim_job_id = job.id) AS receipts,
          (SELECT count(*)::integer FROM result_attempts attempt WHERE attempt.sim_job_id = job.id) AS evidence,
          (SELECT sum(progress.active_seconds)::float FROM progressive_cfd_runtime_progress progress JOIN progressive_cfd_attempts attempt
            ON attempt.token = progress.attempt_token WHERE attempt.sim_job_id = job.id) AS active_seconds
          FROM sim_jobs job WHERE job.id = ${job.id}::uuid`);
        expect(projected).toEqual({
          status: "cancelled",
          receipts: 3,
          evidence: 0,
          active_seconds: 1,
        });
        expect(await progressiveRemoteReservedSlots(db, solverId)).toBe(0);
      } finally {
        await db.execute(
          sql`DELETE FROM progressive_remote_dispatches WHERE sim_job_id = ${job.id}::uuid`,
        );
        await db.execute(
          sql`DELETE FROM sync_sweep_promises WHERE id = ${promiseId}::uuid`,
        );
        await db.execute(
          sql`DELETE FROM registered_remote_solvers WHERE id = ${solverId}::uuid`,
        );
      }
    });
  }, 60_000);

  it("progressive remote dispatch composes only after authenticated capabilities and rolls back incompatible work", async () => {
    await ready(async ({ generationId, poolId }) => {
      const solverId = randomUUID();
      const [settings] = await db.execute(
        sql`SELECT enabled FROM sync_api_settings WHERE id = 1`,
      );
      const [permission] = await db.execute(
        sql`SELECT * FROM sync_api_permissions WHERE data_type = 'sweeps'`,
      );
      const [pool] = await db
        .select()
        .from(solverExecutionPools)
        .where(eq(solverExecutionPools.id, poolId));
      const [generation] = await db.execute(sql`
        SELECT revision.snapshot FROM progressive_generation_targets target
        JOIN simulation_preset_revisions revision ON revision.id = target.revision_id
        WHERE target.generation_id = ${generationId}::uuid LIMIT 1
      `);
      const engine = (generation.snapshot as SimulationSetupSnapshot).engine!;
      const capability = {
        version: 1,
        solverBudgetVersion: 2,
        meshRecoveryVersion: 1,
        uransRecoveryVersion: 14,
        engine: {
          family: engine.family,
          distribution: engine.distribution,
          version: engine.releaseVersion,
          numerics_revision: engine.numericsRevision,
          adapter_contract_version: engine.adapterContractVersion,
        },
        executionPools: [pool.routingKey],
      };
      await db.execute(
        sql`UPDATE sync_api_settings SET enabled = true WHERE id = 1`,
      );
      await db.execute(sql`
        INSERT INTO sync_api_permissions (data_type, can_fetch, can_push) VALUES ('sweeps', true, false)
        ON CONFLICT (data_type) DO UPDATE SET can_fetch = true
      `);
      await db.execute(sql`
        INSERT INTO registered_remote_solvers (id, instance_id, instance_name, cpu_capacity, cpu_budget, max_active_polar_promises,
          auth_token_hash, credential_version, last_heartbeat_at, metadata)
        VALUES (${solverId}::uuid, ${`${PREFIX}-${solverId}`}, 'isolated admission worker', 96, 96, 96,
          ${"a".repeat(64)}, 1, clock_timestamp(), '{}'::jsonb)
      `);
      const attemptCount = async () => {
        const [row] = await db.execute(sql`
          SELECT count(*)::integer AS count FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
          JOIN progressive_work work ON work.id = unit.work_id WHERE work.generation_id = ${generationId}::uuid
        `);
        return Number(row.count);
      };
      try {
        expect(
          await prepareProgressiveRemoteDispatch(db, solverId),
        ).toMatchObject({ kind: "waiting" });
        expect(await attemptCount()).toBe(0);
        await db.execute(
          sql`UPDATE registered_remote_solvers SET metadata = ${JSON.stringify({ progressiveExecution: capability, progressiveExecutionObservedAt: new Date(Date.now() - 61000).toISOString() })}::jsonb WHERE id = ${solverId}::uuid`,
        );
        expect(
          await prepareProgressiveRemoteDispatch(db, solverId),
        ).toMatchObject({ kind: "waiting" });
        expect(await attemptCount()).toBe(0);
        await db.execute(
          sql`UPDATE registered_remote_solvers SET metadata = ${JSON.stringify({ progressiveExecution: { ...capability, executionPools: ["unavailable-pool"] }, progressiveExecutionObservedAt: new Date().toISOString() })}::jsonb WHERE id = ${solverId}::uuid`,
        );
        expect(
          await prepareProgressiveRemoteDispatch(db, solverId),
        ).toMatchObject({
          kind: "waiting",
          reason: expect.stringContaining("exact engine"),
        });
        expect(await attemptCount()).toBe(0);
        await db.execute(
          sql`UPDATE registered_remote_solvers SET metadata = ${JSON.stringify({ progressiveExecution: capability, progressiveExecutionObservedAt: new Date().toISOString() })}::jsonb WHERE id = ${solverId}::uuid`,
        );
        const [targets] =
          await db.execute(sql`SELECT count(*)::integer AS count FROM progressive_work
          WHERE generation_id = ${generationId}::uuid AND stage = 2 AND state = 'pending'`);
        expect(await prepareProgressiveRemoteFleet(db)).toMatchObject({
          prepared: targets.count,
          errors: [],
        });
        const dispatches = await db.execute(
          sql`SELECT envelope FROM progressive_remote_dispatches WHERE solver_id = ${solverId}::uuid`,
        );
        expect(dispatches).toHaveLength(Number(targets.count));
        const [dispatch] = dispatches;
        expect(dispatch).toBeDefined();
        const prepared = {
          envelope:
            dispatch.envelope as unknown as ProgressiveRemoteExecutionEnvelope,
        };
        expect(prepared.envelope.scope.generationId).toBe(generationId);
        expect(prepared.envelope.scope.stage).toBe(2);
        expect(await attemptCount()).toBe(
          dispatches.reduce(
            (total, item) =>
              total +
              (item.envelope as unknown as ProgressiveRemoteExecutionEnvelope)
                .scope.units.length,
            0,
          ),
        );
        expect(await progressiveRemoteReservedSlots(db, solverId)).toBe(
          Number(targets.count),
        );
        const [job] = await db
          .select()
          .from(simJobs)
          .where(eq(simJobs.id, prepared.envelope.scope.executionId));
        expect(job.status).toBe("pending");
        expect(job.engineJobId).toBeNull();
        const [promise] = await db
          .select()
          .from(syncSweepPromises)
          .where(eq(syncSweepPromises.id, prepared.envelope.promiseId));
        expect(promise.requestPayload).toMatchObject({
          solverId,
          progressiveExecutionId: prepared.envelope.scope.executionId,
          executionContract: "progressive-cfd-v1",
        });
        expect(await progressiveRemoteActivePromiseCount(db, solverId)).toBe(
          Number(targets.count),
        );
        await verifyProgressiveRemoteStart(db, prepared.envelope);
        await db.execute(
          sql`UPDATE registered_remote_solvers SET last_heartbeat_at = clock_timestamp() - interval '3 minutes' WHERE id = ${solverId}::uuid`,
        );
        expect(
          await prepareProgressiveRemoteDispatch(db, solverId),
        ).toMatchObject({
          kind: "waiting",
          reason: expect.stringContaining("heartbeat"),
        });
        const neverStarted: ProgressiveRemoteReport = {
          version: 1,
          solverId,
          promiseId: prepared.envelope.promiseId,
          executionId: job.id,
          assignmentSignature: prepared.envelope.contentSignature,
          sequence: 1,
          status: {
            job_id: job.id,
            state: "cancelled",
            total_cases: 0,
            completed_cases: 0,
          },
          result: null,
          stopProof: {
            ...executionStopProof(job.id),
            ownership_basis: "never_started_cancellation_fence",
            fence: "cancel_marker",
          },
        };
        await storeProgressiveRemoteReport(db, {
          solverId,
          promiseId: prepared.envelope.promiseId,
          executionId: job.id,
          report: neverStarted,
        });
        const [expiredPromise] = await db.execute(sql`
          SELECT "expiresAt" FROM sync_sweep_promises WHERE id = ${prepared.envelope.promiseId}::uuid
        `);
        await db.execute(sql`
          UPDATE sync_sweep_promises SET "expiresAt" = ${promise.expiresAt.toISOString()}
          WHERE id = ${prepared.envelope.promiseId}::uuid
        `);
        expect(await progressiveRemoteActivePromiseCount(db, solverId)).toBe(
          Number(targets.count),
        );
        await db.execute(
          sql`UPDATE sim_jobs SET engine_job_id = id::text WHERE id = ${job.id}::uuid`,
        );
        await acknowledgeProgressiveCfdExecutionStop(db, {
          simJobId: job.id,
          proof: neverStarted.stopProof!,
        });
        expect(await progressiveRemoteActivePromiseCount(db, solverId)).toBe(
          Number(targets.count) - 1,
        );
        const [unsettled] = await db.execute(sql`
          SELECT promise.status, job."ingestedAt" AS ingested FROM sync_sweep_promises promise
          JOIN sim_jobs job ON job.id = ${job.id}::uuid WHERE promise.id = ${prepared.envelope.promiseId}::uuid
        `);
        expect(unsettled).toEqual({ status: "active", ingested: null });
        const legacyPromise = randomUUID();
        await db.execute(sql`
          INSERT INTO sync_sweep_promises (id, registered_solver_id, airfoil_id, simulation_preset_revision_id, aoa_count, "expiresAt")
          SELECT ${legacyPromise}::uuid, registered_solver_id, airfoil_id, simulation_preset_revision_id, aoa_count, "expiresAt"
          FROM sync_sweep_promises WHERE id = ${prepared.envelope.promiseId}::uuid
        `);
        expect(await progressiveRemoteActivePromiseCount(db, solverId)).toBe(
          Number(targets.count),
        );
        await db.execute(
          sql`DELETE FROM sync_sweep_promises WHERE id = ${legacyPromise}::uuid`,
        );
        await db.execute(sql`
          UPDATE sync_sweep_promises SET "expiresAt" = ${new Date(expiredPromise.expiresAt as string | Date).toISOString()}
          WHERE id = ${prepared.envelope.promiseId}::uuid
        `);
        expect(await applyProgressiveRemoteProgress(db, job.id)).toMatchObject({
          kind: "applied",
          stopped: true,
          settled: {
            complete: 0,
            retry: prepared.envelope.scope.units.length,
            gaps: 0,
          },
        });
        expect(await progressiveRemoteReservedSlots(db, solverId)).toBe(
          Number(targets.count) - 1,
        );
        const [empty] = await db.execute(sql`SELECT
          (SELECT count(*)::integer FROM result_attempts WHERE sim_job_id = ${job.id}::uuid) AS evidence,
          (SELECT count(*)::integer FROM results WHERE sim_job_id = ${job.id}::uuid) AS claims,
          (SELECT sum(active_seconds)::float FROM progressive_cfd_attempts WHERE sim_job_id = ${job.id}::uuid) AS seconds`);
        expect(empty).toEqual({ evidence: 0, claims: 0, seconds: 0 });
      } finally {
        await db.execute(
          sql`DELETE FROM progressive_remote_dispatches WHERE solver_id = ${solverId}::uuid`,
        );
        await db.execute(
          sql`DELETE FROM sync_sweep_promises WHERE registered_solver_id = ${solverId}::uuid`,
        );
        await db.execute(
          sql`DELETE FROM registered_remote_solvers WHERE id = ${solverId}::uuid`,
        );
        if (settings)
          await db.execute(
            sql`UPDATE sync_api_settings SET enabled = ${settings.enabled} WHERE id = 1`,
          );
        if (permission)
          await db.execute(
            sql`UPDATE sync_api_permissions SET can_fetch = ${permission.can_fetch}, can_push = ${permission.can_push} WHERE data_type = 'sweeps'`,
          );
        else
          await db.execute(
            sql`DELETE FROM sync_api_permissions WHERE data_type = 'sweeps'`,
          );
      }
    });
  }, 60_000);

  it("holds all progressive CFD without spending attempts until budget enforcement is known", async () => {
    await ready(async ({ generationId }) => {
      const engine = new EngineClient("http://unused.invalid");
      const submit = vi.spyOn(engine, "submitPolar");
      for (const solverBudgetVersion of [undefined, null, 0, 1, 3])
        expect(
          await admitProgressiveCfdBatch(db, engine, {
            meshRecoveryVersion: 1,
            uransRecoveryVersion: 14,
            solverBudgetVersion,
          }),
        ).toEqual({ kind: "capability_wait", capability: "solver_budget_v2" });
      expect(submit).not.toHaveBeenCalled();
      const units =
        await db.execute(sql`SELECT unit.state, unit.attempts FROM progressive_cfd_units unit
        JOIN progressive_work work ON work.id = unit.work_id WHERE work.generation_id = ${generationId}`);
      expect(units.length).toBeGreaterThan(0);
      for (const unit of units)
        expect(unit).toMatchObject({ state: "pending", attempts: 0 });
    });
  });

  it("retains transient cases without spending attempts until the exact engine contract is available", async () => {
    await ready(
      async ({ generationId }) => {
        const engine = new EngineClient("http://unused.invalid");
        const submit = vi.spyOn(engine, "submitPolar").mockImplementation(
          async (request) =>
            ({
              job_id: request.execution_id!,
              state: "pending",
              completed_cases: 0,
              total_cases: request.aoa.angles!.length,
            }) as never,
        );
        for (const uransRecoveryVersion of [undefined, null, 13, 15])
          expect(
            await admitProgressiveCfdBatch(db, engine, {
              solverBudgetVersion: 2,
              meshRecoveryVersion: 1,
              uransRecoveryVersion,
            }),
          ).toEqual({ kind: "idle" });
        expect(submit).not.toHaveBeenCalled();
        const waiting =
          await db.execute(sql`SELECT unit.attempts, unit.state, unit.recipe->'selection'->>'solver' AS family
        FROM progressive_cfd_units unit JOIN progressive_work work ON work.id = unit.work_id WHERE work.generation_id = ${generationId}`);
        expect(waiting.length).toBeGreaterThan(0);
        for (const unit of waiting)
          expect(unit).toMatchObject({
            state: "pending",
            attempts: 0,
            family: "rhoCentralFoam",
          });
        expect(
          await admitProgressiveCfdBatch(db, engine, {
            solverBudgetVersion: 2,
            meshRecoveryVersion: 1,
            uransRecoveryVersion: 14,
          }),
        ).toMatchObject({ kind: "attempted", outcome: { kind: "submitted" } });
        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit.mock.calls[0][0]).toMatchObject({
          expected_urans_recovery_version: 14,
          solver: {
            force_transient: true,
            flow_solver_family: "rhoCentralFoam",
          },
        });
      },
      [500],
      3,
    );
  });

  it("skips capability-blocked transient targets without starving compatible steady polars", async () => {
    await ready(
      async ({ generationId }) => {
        const engine = new EngineClient("http://unused.invalid");
        const submit = vi.spyOn(engine, "submitPolar").mockImplementation(
          async (request) =>
            ({
              job_id: request.execution_id!,
              state: "pending",
              completed_cases: 0,
              total_cases: request.aoa.angles!.length,
            }) as never,
        );
        expect(
          await admitProgressiveCfdBatch(db, engine, {
            solverBudgetVersion: 2,
            meshRecoveryVersion: 1,
            uransRecoveryVersion: null,
          }),
        ).toMatchObject({ kind: "attempted", outcome: { kind: "submitted" } });
        expect(submit.mock.calls[0][0].solver?.force_transient).toBe(false);
        const waiting =
          await db.execute(sql`SELECT unit.state, unit.attempts FROM progressive_cfd_units unit
        JOIN progressive_work work ON work.id = unit.work_id WHERE work.generation_id = ${generationId}
        AND unit.recipe->'selection'->>'solver' = 'rhoCentralFoam'`);
        expect(waiting.length).toBeGreaterThan(0);
        for (const unit of waiting)
          expect(unit).toMatchObject({ state: "pending", attempts: 0 });
      },
      [500, 32.173],
      3,
    );
  });

  it.each([undefined, null, 13, 15])(
    "admits local density steady work without URANS capability %s",
    async (uransRecoveryVersion) => {
      await ready(async () => {
        const engine = new EngineClient("http://unused.invalid");
        const submit = vi.spyOn(engine, "submitPolar").mockImplementation(
          async (request) =>
            ({
              job_id: request.execution_id!,
              state: "pending",
              completed_cases: 0,
              total_cases: request.aoa.angles!.length,
            }) as never,
        );
        expect(
          await admitProgressiveCfdBatch(db, engine, {
            solverBudgetVersion: 2,
            meshRecoveryVersion: 1,
            uransRecoveryVersion,
          }),
        ).toMatchObject({ kind: "attempted", outcome: { kind: "submitted" } });
        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit.mock.calls[0][0].solver).toMatchObject({
          flow_solver_family: "rhoCentralFoam",
          force_transient: false,
        });
        expect(
          submit.mock.calls[0][0].expected_urans_recovery_version,
        ).toBeUndefined();
      }, [500]);
    },
  );

  it("atomically fills available slots with distinct fast polars without admitting precise or legacy work", async () => {
    await ready(async ({ campaignId }) => {
      const engine = new EngineClient("http://unused.invalid");
      const submit = vi.spyOn(engine, "submitPolar").mockImplementation(
        async (request) =>
          ({
            job_id: request.execution_id!,
            state: "pending",
            completed_cases: 0,
            total_cases: request.aoa.angles!.length,
            engine: {
              ...request.expected_engine!,
              build_id: "isolated-progressive-admission",
              application_source_sha256: analysisContentHash({
                admission: PREFIX,
              }),
            },
          }) as never,
      );
      const admitted = await Promise.all([
        admitProgressiveCfdBatch(db, engine, {
          solverBudgetVersion: 2,
          meshRecoveryVersion: 1,
          owner: "admission-a",
        }),
        admitProgressiveCfdBatch(db, engine, {
          solverBudgetVersion: 2,
          meshRecoveryVersion: 1,
          owner: "admission-b",
        }),
      ]);
      expect(admitted).toHaveLength(2);
      expect(admitted.some((outcome) => outcome.kind === "attempted")).toBe(
        true,
      );
      if (admitted.some((outcome) => outcome.kind === "idle")) {
        const refill = await admitProgressiveCfdBatch(db, engine, {
          solverBudgetVersion: 2,
          meshRecoveryVersion: 1,
          owner: "admission-refill",
        });
        expect(refill.kind).toBe("attempted");
        admitted.push(refill);
      }
      const submitted = admitted.filter(
        (outcome) => outcome.kind === "attempted",
      );
      expect(submitted).toHaveLength(2);
      for (const outcome of submitted)
        expect(outcome).toMatchObject({
          kind: "attempted",
          stage: 2,
          outcome: { kind: "submitted" },
        });
      expect(
        new Set(
          submitted.map(
            (outcome) => outcome.kind === "attempted" && outcome.jobId,
          ),
        ).size,
      ).toBe(2);
      expect(submit).toHaveBeenCalledTimes(2);
      expect(
        await admitProgressiveCfdBatch(db, engine, {
          solverBudgetVersion: 2,
          meshRecoveryVersion: 1,
        }),
      ).toEqual({ kind: "idle" });
      const jobs = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.campaignId, campaignId));
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(job.status).toBe("submitted");
        expect(job.engineJobId).toBe(job.id);
        expect(job.requestPayload).toMatchObject({
          progressive: { executionContract: "progressive-cfd-v1", stage: 2 },
        });
      }
      expect(
        await solverQueuePressure(db, { jobIds: jobs.map((job) => job.id) }),
      ).toBe(2);
    });
  });

  it("does not claim finite attempts while paused, disk-blocked or without available CPU capacity", async () => {
    await ready(async ({ generationId }) => {
      const engine = new EngineClient("http://unused.invalid");
      const submit = vi.spyOn(engine, "submitPolar");
      for (const state of [
        { enabled: false, diskAdmissionBlocked: false },
        { enabled: true, diskAdmissionBlocked: true },
      ]) {
        await db.update(sweeperState).set(state).where(eq(sweeperState.id, 1));
        expect(
          await admitProgressiveCfdBatch(db, engine, {
            solverBudgetVersion: 2,
            meshRecoveryVersion: 1,
          }),
        ).toEqual({ kind: "idle" });
      }
      const units =
        await db.execute(sql`SELECT unit.state, unit.attempts FROM progressive_cfd_units unit JOIN progressive_work work
        ON work.id = unit.work_id WHERE work.generation_id = ${generationId}`);
      expect(units.length).toBeGreaterThan(0);
      for (const unit of units)
        expect(unit).toMatchObject({ state: "pending", attempts: 0 });
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it("rolls back composition failures without spending a finite CFD attempt", async () => {
    await ready(async ({ generationId, poolId }) => {
      await db
        .update(solverExecutionPools)
        .set({ enabled: false })
        .where(eq(solverExecutionPools.id, poolId));
      const engine = new EngineClient("http://unused.invalid");
      await expect(
        admitProgressiveCfdBatch(db, engine, {
          solverBudgetVersion: 2,
          meshRecoveryVersion: 1,
        }),
      ).rejects.toThrow("no enabled execution pool");
      const units =
        await db.execute(sql`SELECT unit.state, unit.attempts FROM progressive_cfd_units unit JOIN progressive_work work
        ON work.id = unit.work_id WHERE work.generation_id = ${generationId}`);
      for (const unit of units)
        expect(unit).toMatchObject({ state: "pending", attempts: 0 });
    });
  });

  it("retains timed-out dispatch capacity so the next polar cannot over-admit", async () => {
    await ready(async ({ campaignId }) => {
      await db
        .update(sweeperState)
        .set({ cpuSlots: 1, maxConcurrentJobs: 1 })
        .where(eq(sweeperState.id, 1));
      const engine = new EngineClient("http://unused.invalid");
      const submit = vi
        .spyOn(engine, "submitPolar")
        .mockRejectedValue(new Error("dispatch acknowledgement timed out"));
      expect(
        await admitProgressiveCfdBatch(db, engine, {
          solverBudgetVersion: 2,
          meshRecoveryVersion: 1,
        }),
      ).toMatchObject({
        kind: "attempted",
        outcome: { kind: "submission_in_progress" },
      });
      expect(
        await admitProgressiveCfdBatch(db, engine, {
          solverBudgetVersion: 2,
          meshRecoveryVersion: 1,
        }),
      ).toEqual({ kind: "idle" });
      const jobs = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.campaignId, campaignId));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        status: "pending",
        engineState: "submitting",
        engineJobId: null,
      });
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });
});

describe("progressive submission recovery", () => {
  async function fixture() {
    const scope = await fitFixture();
    await db
      .update(simJobs)
      .set({
        status: "pending",
        engineJobId: null,
        engineState: "submitting",
        updatedAt: new Date(Date.now() - 120_000),
      })
      .where(eq(simJobs.id, scope.composed.jobId));
    await db.execute(sql`UPDATE progressive_cfd_units SET lease_until = clock_timestamp() - interval '1 minute'
      WHERE id IN (${sql.join(
        scope.leases.map((lease) => sql`${lease.id}::uuid`),
        sql`, `,
      )})`);
    const proof = {
      ...executionStopProof(scope.engineJobId),
      fence: "cancel_marker" as const,
      ownership_basis: "never_started_cancellation_fence" as const,
    };
    const engine = {
      cancelJob: vi
        .fn()
        .mockResolvedValue({ job_id: scope.engineJobId, cancelled: true }),
      getExecutionStopProof: vi.fn().mockResolvedValue(proof),
    };
    const options = { jobIds: [scope.composed.jobId] };
    return { ...scope, proof, engine, options };
  }

  it("keeps obsolete bound submissions recoverable and fences the replacement target until they stop", async () => {
    const scope = await fixture();
    await db
      .update(simJobs)
      .set({ updatedAt: new Date() })
      .where(eq(simJobs.id, scope.composed.jobId));
    await db.execute(sql`UPDATE progressive_cfd_units SET lease_until = clock_timestamp() + interval '5 minutes'
      WHERE id IN (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id = ${scope.composed.jobId})`);
    await db
      .update(simCampaigns)
      .set({ status: "cancelled" })
      .where(eq(simCampaigns.id, scope.campaignId));
    await reconcileProgressiveGenerationRequest(db);
    const retained =
      await db.execute(sql`SELECT unit.state, attempt.outcome FROM progressive_cfd_units unit
      JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id WHERE attempt.sim_job_id = ${scope.composed.jobId}`);
    expect(retained).toHaveLength(scope.leases.length);
    for (const unit of retained)
      expect(unit).toMatchObject({ state: "cancelled", outcome: "running" });
    scope.engine.getExecutionStopProof.mockResolvedValueOnce({
      ...scope.proof,
      execution_stopped: false,
    });
    expect(
      await recoverProgressiveSubmissions(db, scope.engine, scope.options),
    ).toMatchObject({ inspected: 1, waiting: 1, errors: [] });
    expect(
      await solverQueuePressure(db, { jobIds: scope.options.jobIds }),
    ).toBe(1);
    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, scope.campaignId));
    const replacement = await reconcileProgressiveGenerationRequest(db);
    expect(replacement?.generationId).toBeTruthy();
    expect(replacement?.generationId).not.toBe(scope.leases[0].generationId);
    const baseline = (await claim([1]))!;
    await storeNeuralFoilPrediction(db, baseline, predictionFixture(baseline));
    await initializeProgressiveCfdWork(db);
    expect(await claimCfd()).toBeNull();
    expect(
      await recoverProgressiveSubmissions(db, scope.engine, scope.options),
    ).toMatchObject({ neverStarted: 1, errors: [] });
    expect(
      await solverQueuePressure(db, { jobIds: scope.options.jobIds }),
    ).toBe(0);
    const next = await claimCfd();
    expect(next?.generationId).toBe(replacement?.generationId);
    const [finished] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, scope.composed.jobId));
    expect(finished).toMatchObject({
      status: "cancelled",
      ingestedAt: expect.any(Date),
    });
    expect(
      await db.execute(
        sql`SELECT id FROM result_attempts WHERE sim_job_id = ${scope.composed.jobId}`,
      ),
    ).toHaveLength(0);
  });

  it("preserves ambiguous ownership across restart, then retries only after an exact no-start proof", async () => {
    const scope = await fixture();
    await resetOrphans(db, { jobIds: scope.options.jobIds });
    const [pending] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, scope.composed.jobId));
    expect(pending).toMatchObject({
      status: "pending",
      engineJobId: null,
      engineState: "submitting",
    });
    const claims = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, scope.composed.jobId));
    expect(claims).toHaveLength(scope.leases.length);
    scope.engine.getExecutionStopProof.mockResolvedValueOnce({
      ...scope.proof,
      execution_stopped: false,
    });
    expect(
      await recoverProgressiveSubmissions(db, scope.engine, scope.options),
    ).toMatchObject({ fenced: 1, waiting: 1, neverStarted: 0, errors: [] });
    const before =
      await db.execute(sql`SELECT unit.state FROM progressive_cfd_units unit JOIN progressive_cfd_attempts attempt
      ON attempt.unit_id = unit.id WHERE attempt.sim_job_id = ${scope.composed.jobId}`);
    expect(before.every((unit) => unit.state === "leased")).toBe(true);
    expect(
      await recoverProgressiveSubmissions(db, scope.engine, scope.options),
    ).toMatchObject({ neverStarted: 1, errors: [] });
    expect(scope.engine.cancelJob).toHaveBeenCalledWith(
      scope.engineJobId,
      expect.objectContaining({
        unregisteredExecution: {
          expected_engine: scope.composed.request.expected_engine,
          expected_execution_pool:
            scope.composed.request.expected_execution_pool,
        },
      }),
    );
    const after =
      await db.execute(sql`SELECT unit.state, unit.active_seconds, attempt.outcome FROM progressive_cfd_units unit
      JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id WHERE attempt.sim_job_id = ${scope.composed.jobId}`);
    expect(after).toHaveLength(scope.leases.length);
    for (const unit of after)
      expect(unit).toMatchObject({
        state: "pending",
        active_seconds: 0,
        outcome: "cancelled",
      });
    expect(
      await recoverProgressiveSubmissions(db, scope.engine, scope.options),
    ).toMatchObject({ inspected: 0 });
    const evidence = await db.execute(
      sql`SELECT id FROM result_attempts WHERE sim_job_id = ${scope.composed.jobId}`,
    );
    expect(evidence).toHaveLength(0);
  });

  it("keeps started execution bound until its final evidence is ingested", async () => {
    const scope = await fixture();
    scope.engine.getExecutionStopProof.mockResolvedValue({
      ...scope.proof,
      ownership_basis: "recorded_execution_namespace",
    });
    expect(
      await recoverProgressiveSubmissions(db, scope.engine, scope.options),
    ).toMatchObject({ awaitingIngest: 1, neverStarted: 0, errors: [] });
    const [job] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, scope.composed.jobId));
    expect(job).toMatchObject({
      status: "submitted",
      engineJobId: scope.engineJobId,
      ingestedAt: null,
    });
    expect(await settleProgressiveCfdExecution(db, job.id)).toMatchObject({
      waiting: 1,
      retry: 0,
    });
    expect(
      await db.select().from(results).where(eq(results.simJobId, job.id)),
    ).toHaveLength(scope.leases.length);
  });

  it("does not cancel a fresh submit and never converts missing or wrong ownership into a retry", async () => {
    const scope = await fixture();
    await db
      .update(simJobs)
      .set({ updatedAt: new Date() })
      .where(eq(simJobs.id, scope.composed.jobId));
    expect(
      await recoverProgressiveSubmissions(db, scope.engine, scope.options),
    ).toMatchObject({ inspected: 0 });
    expect(scope.engine.cancelJob).not.toHaveBeenCalled();
    await db
      .update(simJobs)
      .set({ status: "cancelled" })
      .where(eq(simJobs.id, scope.composed.jobId));
    scope.engine.cancelJob.mockResolvedValueOnce({
      job_id: randomUUID(),
      cancelled: true,
    });
    expect(
      (await recoverProgressiveSubmissions(db, scope.engine, scope.options))
        .errors,
    ).toHaveLength(1);
    expect(scope.engine.getExecutionStopProof).not.toHaveBeenCalled();
    scope.engine.getExecutionStopProof.mockResolvedValueOnce({
      ...scope.proof,
      job_id: randomUUID(),
    });
    expect(
      (await recoverProgressiveSubmissions(db, scope.engine, scope.options))
        .errors,
    ).toHaveLength(1);
    scope.engine.getExecutionStopProof.mockRejectedValueOnce(
      new Error("inventory unavailable"),
    );
    expect(
      (await recoverProgressiveSubmissions(db, scope.engine, scope.options))
        .errors,
    ).toHaveLength(1);
    const stops = await db.execute(
      sql`SELECT sim_job_id FROM progressive_cfd_execution_stops WHERE sim_job_id = ${scope.composed.jobId}`,
    );
    expect(stops).toHaveLength(0);
    const units =
      await db.execute(sql`SELECT unit.state FROM progressive_cfd_units unit JOIN progressive_cfd_attempts attempt
      ON attempt.unit_id = unit.id WHERE attempt.sim_job_id = ${scope.composed.jobId}`);
    expect(units.every((unit) => unit.state === "leased")).toBe(true);
  });

  it("rejects a no-start proof contradicted by retained solver attempts", async () => {
    const scope = await fixture();
    await scope.save(20);
    const recovered = await recoverProgressiveSubmissions(
      db,
      scope.engine,
      scope.options,
    );
    expect(recovered.neverStarted).toBe(0);
    expect(recovered.errors[0].error).toContain(
      "conflicts with stored solver attempts",
    );
    expect(
      await db.execute(
        sql`SELECT sim_job_id FROM progressive_cfd_execution_stops WHERE sim_job_id = ${scope.composed.jobId}`,
      ),
    ).toHaveLength(0);
  });

  it("bounds no-start retries and does not invent a measured CFD failure", async () => {
    const scope = await fixture();
    await db.execute(sql`UPDATE progressive_cfd_units SET attempts = 2 WHERE id IN (
      SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id = ${scope.composed.jobId})`);
    expect(
      await recoverProgressiveSubmissions(db, scope.engine, scope.options),
    ).toMatchObject({ neverStarted: 1, errors: [] });
    const units =
      await db.execute(sql`SELECT unit.state, unit.active_seconds, attempt.outcome FROM progressive_cfd_units unit
      JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id WHERE attempt.sim_job_id = ${scope.composed.jobId}`);
    for (const unit of units)
      expect(unit).toMatchObject({
        state: "gap",
        active_seconds: 0,
        outcome: "cancelled",
      });
  });

  it("retains timed-out stable submissions instead of releasing results through the legacy failure path", async () => {
    const scope = await fixture();
    await db.execute(sql`UPDATE progressive_cfd_units SET lease_until = clock_timestamp() + interval '2 minutes'
      WHERE id IN (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id = ${scope.composed.jobId})`);
    await db.execute(sql`UPDATE sim_jobs SET engine_state = NULL, request_payload = jsonb_set(request_payload,
      '{progressive,executionContract}', '"progressive-cfd-v1"'::jsonb) WHERE id = ${scope.composed.jobId}`);
    await db
      .update(sweeperState)
      .set({ enabled: true, cpuSlots: 2, maxConcurrentJobs: 2 })
      .where(eq(sweeperState.id, 1));
    const engine = new EngineClient("http://unused.invalid");
    const submit = vi
      .spyOn(engine, "submitPolar")
      .mockRejectedValue(new Error("ETIMEDOUT after dispatch"));
    try {
      const input = {
        db,
        engine,
        jobId: scope.composed.jobId,
        campaignId: scope.campaignId,
        request: scope.composed.request,
        connectionErrorPrefix: "connection",
        submitErrorPrefix: "submit",
      };
      expect(await submitPendingJobWithLifecycleGuard(input)).toMatchObject({
        kind: "submission_in_progress",
      });
      expect(await submitPendingJobWithLifecycleGuard(input)).toMatchObject({
        kind: "submission_in_progress",
      });
      expect(submit).toHaveBeenCalledTimes(1);
      const [job] = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.id, scope.composed.jobId));
      expect(job).toMatchObject({
        status: "pending",
        engineJobId: null,
        engineState: "submitting",
      });
      expect(
        await db.select().from(results).where(eq(results.simJobId, job.id)),
      ).toHaveLength(scope.leases.length);
      await expect(
        submitPendingJobWithLifecycleGuard({
          ...input,
          request: { ...input.request, execution_id: randomUUID() },
        }),
      ).rejects.toThrow("immutable registered request");
    } finally {
      submit.mockRestore();
      await db
        .update(sweeperState)
        .set({ enabled: false })
        .where(eq(sweeperState.id, 1));
    }
  });
});

describe("progressive execution stop and settlement", () => {
  it("quarantines conflicting execution identities without touching the foreign engine job", async () => {
    const fixture = await fitFixture();
    const jobId = fixture.composed.jobId;
    const foreignId = randomUUID();
    await db
      .update(simJobs)
      .set({
        engineJobId: foreignId,
        status: "failed",
        engineState: "submission_identity_conflict",
      })
      .where(eq(simJobs.id, jobId));
    const engine = new EngineClient("http://unused.invalid");
    const getJob = vi.spyOn(engine, "getJob");
    const cancel = vi.spyOn(engine, "cancelJob");
    const proof = vi.spyOn(engine, "getExecutionStopProof");
    const [job] = await db.select().from(simJobs).where(eq(simJobs.id, jobId));
    await expect(reconcileProgressiveCfdJob(db, engine, job)).rejects.toThrow(
      "identity conflict",
    );
    const stopped = await reconcileProgressiveExecutions(db, engine, {
      jobIds: [jobId],
    });
    expect(stopped.errors[0].error).toContain("identity conflict");
    await expect(
      acknowledgeProgressiveCfdExecutionStop(db, {
        simJobId: jobId,
        proof: executionStopProof(foreignId),
      }),
    ).rejects.toThrow("identity conflict");
    expect(getJob).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(proof).not.toHaveBeenCalled();
    expect(await solverQueuePressure(db, { jobIds: [jobId] })).toBe(1);
  });

  it("rejects status and result payloads from another execution without inventing completion", async () => {
    const fixture = await fitFixture();
    const jobId = fixture.composed.jobId;
    const [job] = await db.select().from(simJobs).where(eq(simJobs.id, jobId));
    const engine = new EngineClient("http://unused.invalid");
    const status = vi.spyOn(engine, "getJob").mockResolvedValue({
      job_id: randomUUID(),
      state: "cancelled",
      completed_cases: 0,
      total_cases: fixture.leases.length,
    } as never);
    vi.spyOn(engine, "getExecutionStopProof").mockResolvedValue(
      executionStopProof(fixture.engineJobId),
    );
    const result = vi.spyOn(engine, "getResult").mockResolvedValue({
      job_id: randomUUID(),
      state: "cancelled",
      polars: [],
    } as never);
    await expect(reconcileProgressiveCfdJob(db, engine, job)).rejects.toThrow(
      "status belongs to another",
    );
    expect(result).not.toHaveBeenCalled();
    status.mockResolvedValue({
      job_id: fixture.engineJobId,
      state: "cancelled",
      completed_cases: 0,
      total_cases: fixture.leases.length,
    } as never);
    await expect(reconcileProgressiveCfdJob(db, engine, job)).rejects.toThrow(
      "result belongs to another",
    );
    const [waiting] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, jobId));
    expect(waiting.ingestedAt).toBeNull();
    expect(
      await db.execute(
        sql`SELECT id FROM result_attempts WHERE sim_job_id = ${jobId}`,
      ),
    ).toHaveLength(0);
  });

  it("reserves bound CPU slots across coarse terminal states until the exact execution stops", async () => {
    const fixture = await fitFixture();
    const jobId = fixture.composed.jobId;
    await db
      .update(simJobs)
      .set({ admissionCpuSlots: 3 })
      .where(eq(simJobs.id, jobId));
    for (const status of [
      "pending",
      "submitted",
      "running",
      "ingesting",
      "failed",
      "cancelled",
      "done",
    ] as const) {
      await db
        .update(simJobs)
        .set({ status, engineState: "cancelled" })
        .where(eq(simJobs.id, jobId));
      expect(await solverQueuePressure(db, { jobIds: [jobId] })).toBe(3);
      const [aliased] = await db.execute(
        sql`SELECT ${solverCpuReservationSql("job")} AS reserved,
          job.id IN (${solverCpuReservedJobIdsSql()}) AS set_reserved FROM sim_jobs job WHERE job.id = ${jobId}`,
      );
      expect(aliased.reserved).toBe(true);
      expect(aliased.set_reserved).toBe(true);
    }
    await db.execute(
      sql`UPDATE progressive_cfd_attempts SET outcome = 'cancelled', finished_at = clock_timestamp() WHERE sim_job_id = ${jobId}`,
    );
    expect(await solverQueuePressure(db, { jobIds: [jobId] })).toBe(3);
    await acknowledgeProgressiveCfdExecutionStop(db, {
      simJobId: jobId,
      proof: executionStopProof(fixture.engineJobId),
    });
    await db
      .update(simJobs)
      .set({ status: "ingesting", ingestedAt: null })
      .where(eq(simJobs.id, jobId));
    expect(await solverQueuePressure(db, { jobIds: [jobId] })).toBe(0);
    const [releasedSet] = await db.execute(
      sql`SELECT ${jobId}::uuid IN (${solverCpuReservedJobIdsSql()}) AS reserved`,
    );
    expect(releasedSet.reserved).toBe(false);
    await db
      .update(simJobs)
      .set({ engineJobId: randomUUID() })
      .where(eq(simJobs.id, jobId));
    expect(await solverQueuePressure(db, { jobIds: [jobId] })).toBe(3);
    const [foreignSet] = await db.execute(
      sql`SELECT ${jobId}::uuid IN (${solverCpuReservedJobIdsSql()}) AS reserved`,
    );
    expect(foreignSet.reserved).toBe(true);
  });

  it("preserves legacy reservation semantics for jobs without progressive bindings", async () => {
    const fixture = await fitFixture();
    const [source] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, fixture.composed.jobId));
    const jobId = randomUUID();
    await db.insert(simJobs).values({
      ...source,
      id: jobId,
      engineJobId: randomUUID(),
      requestPayload: {},
      admissionCpuSlots: 2,
    });
    for (const [status, engineState, reserved] of [
      ["pending", null, 0],
      ["pending", "submitting", 2],
      ["submitted", "pending", 2],
      ["running", "running", 2],
      ["ingesting", "completed", 2],
      ["cancelled", "cancel_pending", 2],
      ["cancelled", "cancelled", 0],
      ["failed", "failed", 0],
      ["done", "completed", 0],
    ] as const) {
      await db
        .update(simJobs)
        .set({ status, engineState })
        .where(eq(simJobs.id, jobId));
      expect(await solverQueuePressure(db, { jobIds: [jobId] })).toBe(reserved);
    }
  });

  it("keeps failed progressive jobs on exact reconciliation instead of legacy missing-job retries", async () => {
    const fixture = await fitFixture();
    const jobId = fixture.composed.jobId;
    await db
      .update(simJobs)
      .set({
        status: "failed",
        engineState: "missing",
        error: "engine job not found",
      })
      .where(eq(simJobs.id, jobId));
    const engine = new EngineClient("http://unused.invalid");
    vi.spyOn(engine, "getQueue").mockResolvedValue(null as never);
    vi.spyOn(engine, "getJobRuntimes").mockResolvedValue({ jobs: [] } as never);
    const getJob = vi
      .spyOn(engine, "getJob")
      .mockRejectedValue(new EngineError("engine job not found", 404));
    const getResult = vi
      .spyOn(engine, "getResult")
      .mockRejectedValue(new EngineError("result missing", 404));
    vi.spyOn(engine, "getExecutionStopProof").mockResolvedValue({
      ...executionStopProof(fixture.engineJobId),
      execution_stopped: false,
    });
    const cancel = vi
      .spyOn(engine, "cancelJob")
      .mockResolvedValue({ job_id: fixture.engineJobId, cancelled: true });
    await reconcile(db, engine, {
      jobIds: [jobId],
      recoverFailedJobIds: [jobId],
    });
    expect(getJob).toHaveBeenCalled();
    expect(getResult).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(fixture.engineJobId, expect.anything());
    const [job] = await db.select().from(simJobs).where(eq(simJobs.id, jobId));
    expect(job).toMatchObject({
      status: "failed",
      engineState: "missing",
      engineJobId: fixture.engineJobId,
      ingestedAt: null,
    });
    expect(await solverQueuePressure(db, { jobIds: [jobId] })).toBe(1);
    expect(
      await db.select().from(results).where(eq(results.simJobId, jobId)),
    ).toHaveLength(fixture.leases.length);
  });

  it("ingests cancelled progressive work only after its exact physical stop and does not resurrect it", async () => {
    const fixture = await fitFixture();
    const jobId = fixture.composed.jobId;
    await db
      .update(simJobs)
      .set({ status: "cancelled", engineState: "cancelling" })
      .where(eq(simJobs.id, jobId));
    expect(await claimJobForIngest(db, jobId)).toBeNull();
    expect(
      await claimJobForIngest(db, jobId, { progressiveStopped: true }),
    ).toBeNull();
    const engine = new EngineClient("http://unused.invalid");
    vi.spyOn(engine, "getQueue").mockResolvedValue(null as never);
    vi.spyOn(engine, "getJobRuntimes").mockResolvedValue({ jobs: [] } as never);
    const getJob = vi.spyOn(engine, "getJob").mockResolvedValue({
      job_id: fixture.engineJobId,
      state: "running",
      completed_cases: 0,
      total_cases: fixture.leases.length,
    } as never);
    const getResult = vi
      .spyOn(engine, "getResult")
      .mockRejectedValue(new EngineError("result missing", 404));
    const proof = vi.spyOn(engine, "getExecutionStopProof").mockResolvedValue({
      ...executionStopProof(fixture.engineJobId),
      execution_stopped: false,
    });
    vi.spyOn(engine, "cancelJob").mockResolvedValue({
      job_id: fixture.engineJobId,
      cancelled: true,
    });
    const options = { jobIds: [jobId], skipFailedRecovery: true };
    await reconcile(db, engine, options);
    const [waiting] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, jobId));
    expect(waiting).toMatchObject({ status: "cancelled", ingestedAt: null });
    expect(getResult).not.toHaveBeenCalled();
    expect(await solverQueuePressure(db, { jobIds: [jobId] })).toBe(1);
    getJob.mockResolvedValue({
      job_id: fixture.engineJobId,
      state: "cancelled",
      completed_cases: 0,
      total_cases: fixture.leases.length,
    } as never);
    proof.mockResolvedValue(executionStopProof(fixture.engineJobId));
    await reconcile(db, engine, options);
    const [finished] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, jobId));
    expect(finished).toMatchObject({
      status: "cancelled",
      engineState: "cancelled",
    });
    expect(finished.ingestedAt).not.toBeNull();
    expect(await solverQueuePressure(db, { jobIds: [jobId] })).toBe(0);
    expect(
      await db.execute(
        sql`SELECT id FROM result_attempts WHERE sim_job_id = ${jobId}`,
      ),
    ).toHaveLength(0);
  });

  it("does not cancel sibling angles when the engine has exhausted an exact per-case guard", async () => {
    const fixture = await fitFixture();
    const limit =
      fixture.composed.request.resources!.case_solver_budget_seconds!;
    const attempt = await fixture.save(limit, "rans", fixture.leases[0].alpha, {
      solver_budget: {
        version: 1,
        scope: "physical_case_v1",
        limit_seconds: limit,
        exhausted: true,
      },
    });
    expect(await fixture.record([attempt])).toMatchObject({
      linked: 1,
      stopRequired: false,
    });
    expect(await fixture.record([attempt])).toMatchObject({
      linked: 0,
      stopRequired: false,
    });
    const engine = { cancelJob: vi.fn(), getExecutionStopProof: vi.fn() };
    expect(
      await reconcileProgressiveExecutions(db, engine, {
        jobIds: [fixture.composed.jobId],
      }),
    ).toMatchObject({ inspected: 0, errors: [] });
    expect(engine.cancelJob).not.toHaveBeenCalled();
    expect(engine.getExecutionStopProof).not.toHaveBeenCalled();
    const units =
      await db.execute(sql`SELECT unit.state, unit.aoa_deg FROM progressive_cfd_units unit
      JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id WHERE attempt.sim_job_id = ${fixture.composed.jobId}`);
    expect(
      units.some(
        (unit) =>
          unit.aoa_deg !== fixture.leases[0].alpha && unit.state === "leased",
      ),
    ).toBe(true);
    await expect(
      settleProgressiveCfdExecution(db, fixture.composed.jobId),
    ).rejects.toThrow("no persisted stop acknowledgement");
    await db.execute(
      sql`UPDATE sim_campaigns SET status = 'cancelled' WHERE id = ${fixture.campaignId}`,
    );
    engine.cancelJob.mockResolvedValue({
      job_id: fixture.engineJobId,
      cancelled: true,
    });
    engine.getExecutionStopProof.mockResolvedValue({
      ...executionStopProof(fixture.engineJobId),
      execution_stopped: false,
    });
    expect(
      await reconcileProgressiveExecutions(db, engine, {
        jobIds: [fixture.composed.jobId],
      }),
    ).toMatchObject({ inspected: 1, stopRequests: 1, waiting: 1, errors: [] });
  });

  it.each([
    { version: 2 },
    { scope: "whole_job" },
    { limit_seconds: 1 },
    { limit_seconds: "900" },
    { exhausted: false },
    { exhausted: "true" },
  ])(
    "rejects mismatched case-budget acknowledgement %j without suppressing cancellation",
    async (change) => {
      const fixture = await fitFixture();
      const limit =
        fixture.composed.request.resources!.case_solver_budget_seconds!;
      const attempt = await fixture.save(
        limit,
        "rans",
        fixture.leases[0].alpha,
        {
          solver_budget: {
            version: 1,
            scope: "physical_case_v1",
            limit_seconds: limit,
            exhausted: true,
            ...change,
          },
        },
      );
      await expect(fixture.record([attempt])).rejects.toThrow(
        "measured immutable case allocation",
      );
      expect(
        await db.execute(
          sql`SELECT result_attempt_id FROM progressive_cfd_evidence WHERE result_attempt_id = ${attempt}`,
        ),
      ).toHaveLength(0);
    },
  );

  it("ingests cancelled final attempt histories only after physical stop without inventing omitted angles or legacy retries", async () => {
    const fixture = await fitFixture();
    const engine = new EngineClient("http://unused.invalid");
    vi.spyOn(engine, "getJob").mockResolvedValue({
      job_id: fixture.engineJobId,
      state: "cancelled",
      total_cases: fixture.leases.length,
      completed_cases: 1,
    });
    const proof = vi.spyOn(engine, "getExecutionStopProof").mockResolvedValue({
      ...executionStopProof(fixture.engineJobId),
      execution_stopped: false,
    });
    const result = vi.spyOn(engine, "getResult").mockResolvedValue({
      job_id: fixture.engineJobId,
      state: "cancelled",
      mesh_recovery_version: 1,
      engine: {
        ...fixture.composed.request.expected_engine!,
        build_id: `isolated-progressive-tail-${sequence}`,
        application_source_sha256: analysisContentHash({
          fixture: PREFIX,
          sequence,
        }),
      },
      polars: [
        {
          speed: fixture.execution.snapshot.flowState.speedMps,
          chord: fixture.execution.snapshot.referenceGeometry.referenceLengthM,
          reynolds:
            (fixture.execution.snapshot.flowState.density *
              fixture.execution.snapshot.flowState.speedMps *
              fixture.execution.snapshot.referenceGeometry.referenceLengthM) /
            fixture.execution.snapshot.flowState.dynamicViscosity,
          points: [],
          attempts: [
            {
              aoa_deg: fixture.leases[0].alpha,
              solver_active_seconds: 60,
              converged: false,
              unsteady: false,
              first_order_fallback: false,
              images: {},
              failure_disposition: "infrastructure",
              error: "isolated interrupted solver fixture",
            },
          ],
        },
      ],
    });
    const load = async () =>
      (
        await db
          .select()
          .from(simJobs)
          .where(eq(simJobs.id, fixture.composed.jobId))
      )[0];
    await reconcileProgressiveCfdJob(db, engine, await load());
    expect(result).not.toHaveBeenCalled();
    expect((await load()).ingestedAt).toBeNull();
    proof.mockResolvedValue(executionStopProof(fixture.engineJobId));
    result.mockRejectedValueOnce(
      new Error("isolated temporary result transport failure"),
    );
    await expect(
      reconcileProgressiveCfdJob(db, engine, await load()),
    ).rejects.toThrow("transport failure");
    expect((await load()).ingestedAt).toBeNull();
    await reconcileProgressiveCfdJob(db, engine, await load());
    const finished = await load();
    expect(finished.status).toBe("cancelled");
    expect(finished.ingestedAt).toBeInstanceOf(Date);
    const attempts = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.simJobId, finished.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      aoaDeg: fixture.leases[0].alpha,
      validForPolar: false,
    });
    expect(attempts[0].evidencePayload).toMatchObject({
      solver_active_seconds: 60,
    });
    expect(
      await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.campaignId, fixture.campaignId)),
    ).toHaveLength(1);
  });

  it("reconciles budget stops without releasing work before physical proof and terminal ingestion", async () => {
    const fixture = await fitFixture();
    const options = { jobIds: [fixture.composed.jobId] };
    const cancelJob = vi.fn(async (jobId: string) => ({
      job_id: jobId,
      cancelled: true,
    }));
    const getExecutionStopProof = vi.fn(async () => ({
      ...executionStopProof(fixture.engineJobId),
      execution_stopped: false,
    }));
    const engine = { cancelJob, getExecutionStopProof };
    expect(
      await reconcileProgressiveExecutions(db, engine, options),
    ).toMatchObject({ inspected: 0 });
    expect(cancelJob).not.toHaveBeenCalled();
    await fixture.record([await fixture.save(900)]);
    expect(
      await reconcileProgressiveExecutions(db, engine, options),
    ).toMatchObject({
      inspected: 1,
      stopRequests: 1,
      acknowledged: 0,
      waiting: 1,
      gaps: 0,
      errors: [],
    });
    const [running] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, fixture.composed.jobId));
    expect(running.status).toBe("running");
    getExecutionStopProof.mockImplementation(async () =>
      executionStopProof(fixture.engineJobId),
    );
    expect(
      await reconcileProgressiveExecutions(db, engine, options),
    ).toMatchObject({
      inspected: 1,
      acknowledged: 1,
      waiting: 1,
      gaps: 0,
      errors: [],
    });
    await db
      .update(simJobs)
      .set({ status: "cancelled" })
      .where(eq(simJobs.id, fixture.composed.jobId));
    const calls = getExecutionStopProof.mock.calls.length;
    expect(
      await reconcileProgressiveExecutions(db, engine, options),
    ).toMatchObject({ waiting: 1, gaps: 0 });
    const fit = (await fixture.acquire())!;
    const request = buildProgressiveFitRequest(fit);
    await storeProgressivePolarFit(
      db,
      fit,
      request,
      await fitUsingPython(request),
    );
    await db
      .update(simJobs)
      .set({ ingestedAt: new Date() })
      .where(eq(simJobs.id, fixture.composed.jobId));
    expect(
      await reconcileProgressiveExecutions(db, engine, options),
    ).toMatchObject({
      inspected: 1,
      stopRequests: 0,
      gaps: fixture.leases.length,
      waiting: 0,
      errors: [],
    });
    expect(getExecutionStopProof).toHaveBeenCalledTimes(calls);
    expect(
      await reconcileProgressiveExecutions(db, engine, options),
    ).toMatchObject({ inspected: 0 });
  }, 120_000);

  it("verifies natural terminal stops without cancellation and rejects wrong-job proofs", async () => {
    const fixture = await cfdEvidenceFixture();
    await db
      .update(simJobs)
      .set({ status: "failed" })
      .where(eq(simJobs.id, fixture.composed.jobId));
    const cancelJob = vi.fn();
    const getExecutionStopProof = vi.fn(async () =>
      executionStopProof(randomUUID()),
    );
    const options = { jobIds: [fixture.composed.jobId] };
    const engine = { cancelJob, getExecutionStopProof };
    const rejected = await reconcileProgressiveExecutions(db, engine, options);
    expect(rejected.errors).toHaveLength(1);
    expect(rejected.errors[0].error).toContain("another engine job");
    expect(rejected.acknowledged).toBe(0);
    expect(cancelJob).not.toHaveBeenCalled();
    getExecutionStopProof.mockImplementation(async () =>
      executionStopProof(fixture.engineJobId),
    );
    expect(
      await reconcileProgressiveExecutions(db, engine, options),
    ).toMatchObject({ acknowledged: 1, waiting: 1, gaps: 0 });
    await db
      .update(simJobs)
      .set({ ingestedAt: new Date() })
      .where(eq(simJobs.id, fixture.composed.jobId));
    expect(
      await reconcileProgressiveExecutions(db, engine, options),
    ).toMatchObject({
      inspected: 1,
      acknowledged: 0,
      gaps: fixture.leases.length,
      errors: [],
    });
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it.each(["estimate", "accepted", "exclude", "superseded"] as const)(
    "requires accepted evidence rather than a fitted curve to complete precise work (%s)",
    async (mode) => {
      const fixture = await fitFixture(3);
      const evidence = await fixture.save(60);
      await db
        .update(resultAttempts)
        .set({
          status: mode === "estimate" ? "failed" : "done",
          validForPolar: mode !== "estimate",
          evidencePayload: {
            solver_active_seconds: 60,
            converged: true,
            cl: 0.7,
            cd: 0.025,
            cm: -0.03,
          },
        })
        .where(eq(resultAttempts.id, evidence));
      if (mode !== "estimate")
        await db.execute(sql`
      INSERT INTO result_classifications(result_attempt_id, airfoil_id, simulation_preset_revision_id, aoa_deg, classifier_version, state)
      SELECT id, airfoil_id, simulation_preset_revision_id, aoa_deg, 'isolated-precise-settlement',
        ${mode === "superseded" ? "superseded_by_urans" : "accepted"}::result_classification_state
      FROM result_attempts WHERE id = ${evidence}
    `);
      if (mode === "exclude")
        await db.execute(sql`
      INSERT INTO result_review_verdicts(result_id, verdict, reviewer)
      SELECT result_id, 'exclude', 'isolated-precise-settlement' FROM result_attempts WHERE id = ${evidence}
    `);
      await fixture.record([evidence]);
      const lease = (await fixture.acquire())!;
      const request = buildProgressiveFitRequest(lease);
      const response = await fitUsingPython(request);
      if (mode === "estimate")
        expect(response.estimate.best_method).toBe("openfoam_precise");
      await storeProgressivePolarFit(db, lease, request, response);
      await acknowledgeProgressiveCfdExecutionStop(db, {
        simJobId: fixture.composed.jobId,
        proof: executionStopProof(fixture.engineJobId),
      });
      await db
        .update(simJobs)
        .set({ status: "done", ingestedAt: new Date() })
        .where(eq(simJobs.id, fixture.composed.jobId));
      const complete = mode === "accepted" ? 1 : 0;
      expect(
        await settleProgressiveCfdExecution(db, fixture.composed.jobId),
      ).toMatchObject({
        complete,
        gaps: fixture.leases.length - complete,
        retry: 0,
        waiting: 0,
      });
    },
    120_000,
  );

  it("requires a persisted exact physical stop, retains it immutably, and waits for terminal ingestion", async () => {
    const fixture = await fitFixture();
    const simJobId = fixture.composed.jobId;
    await expect(settleProgressiveCfdExecution(db, simJobId)).rejects.toThrow(
      "no persisted stop acknowledgement",
    );
    const proof = executionStopProof(fixture.engineJobId);
    for (const invalid of [
      { execution_stopped: false },
      { producer_stopped: false },
      { namespace_verified: false },
      { remaining: [12345] },
      { fence: null },
      { ownership_basis: "unknown" },
      {
        ownership_basis: "never_started_cancellation_fence",
        fence: "terminal_result",
      },
      { observed_at: "unknown" },
      { error: "inventory unavailable" },
    ])
      await expect(
        acknowledgeProgressiveCfdExecutionStop(db, {
          simJobId,
          proof: { ...proof, ...invalid },
        }),
      ).rejects.toThrow("verified execution-stop proof");
    await expect(
      acknowledgeProgressiveCfdExecutionStop(db, {
        simJobId,
        proof: { ...proof, job_id: randomUUID() },
      }),
    ).rejects.toThrow("this progressive engine job");
    expect(
      await acknowledgeProgressiveCfdExecutionStop(db, { simJobId, proof }),
    ).toMatchObject({ replayed: false });
    expect(
      await acknowledgeProgressiveCfdExecutionStop(db, {
        simJobId,
        proof: { ...proof, observed_at: new Date().toISOString() },
      }),
    ).toMatchObject({ replayed: true });
    await expect(
      db.execute(
        sql`UPDATE progressive_cfd_execution_stops SET observed_at = clock_timestamp() WHERE sim_job_id = ${simJobId}`,
      ),
    ).rejects.toThrow("immutable");
    expect(await settleProgressiveCfdExecution(db, simJobId)).toEqual({
      complete: 0,
      retry: 0,
      gaps: 0,
      cancelled: 0,
      waiting: 1,
    });
    const [stored] = await db.execute(
      sql`SELECT proof_signature FROM progressive_cfd_execution_stops WHERE sim_job_id = ${simJobId}`,
    );
    expect(stored.proof_signature).toBe(analysisContentHash(proof));
    await db
      .update(simJobs)
      .set({ status: "failed" })
      .where(eq(simJobs.id, simJobId));
    expect(await settleProgressiveCfdExecution(db, simJobId)).toMatchObject({
      waiting: 1,
      gaps: 0,
    });
    await db
      .update(simJobs)
      .set({ ingestedAt: new Date() })
      .where(eq(simJobs.id, simJobId));
    expect(await settleProgressiveCfdExecution(db, simJobId)).toMatchObject({
      complete: 0,
      gaps: fixture.leases.length,
      waiting: 0,
    });
    expect(await settleProgressiveCfdExecution(db, simJobId)).toEqual({
      complete: 0,
      retry: 0,
      gaps: 0,
      cancelled: 0,
      waiting: 0,
    });
  });

  it("settles an informative fast anchor without promoting it to accepted CFD", async () => {
    const fixture = await fitFixture();
    const evidence = await fixture.save(60);
    await db
      .update(resultAttempts)
      .set({
        evidencePayload: {
          solver_active_seconds: 60,
          converged: true,
          cl: 0.7,
          cd: 0.025,
          cm: -0.03,
        },
      })
      .where(eq(resultAttempts.id, evidence));
    await fixture.record([evidence]);
    await acknowledgeProgressiveCfdExecutionStop(db, {
      simJobId: fixture.composed.jobId,
      proof: executionStopProof(fixture.engineJobId),
    });
    await db
      .update(simJobs)
      .set({ status: "done", ingestedAt: new Date() })
      .where(eq(simJobs.id, fixture.composed.jobId));
    expect(
      await settleProgressiveCfdExecution(db, fixture.composed.jobId),
    ).toMatchObject({ complete: 0, waiting: 1 });
    const lease = (await fixture.acquire())!;
    const request = buildProgressiveFitRequest(lease);
    await storeProgressivePolarFit(
      db,
      lease,
      request,
      await fitUsingPython(request),
    );
    expect(
      await settleProgressiveCfdExecution(db, fixture.composed.jobId),
    ).toMatchObject({ complete: 1, waiting: 0 });
    const [raw] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.id, evidence));
    expect(raw.validForPolar).toBe(false);
    expect(raw.status).toBe("failed");
    expect(raw.evidencePayload).toMatchObject({
      cl: 0.7,
      solver_active_seconds: 60,
    });
    const [unit] = await db.execute(
      sql`SELECT state, active_seconds FROM progressive_cfd_units WHERE id = ${fixture.leases[0].id}`,
    );
    expect(unit).toMatchObject({ state: "complete", active_seconds: 60 });
  }, 120_000);

  it.each([
    ["infrastructure", 30, 1],
    ["infrastructure", 900, 0],
    ["hard_solver", 30, 0],
    ["deterministic_mesh", 30, 0],
  ])(
    "only retries diagnosed infrastructure failures within measured budget (%s, %s)",
    async (failure, duration, retry) => {
      const fixture = await fitFixture();
      const evidence = await fixture.save(duration);
      await db
        .update(resultAttempts)
        .set({
          evidencePayload: {
            solver_active_seconds: duration,
            failure_disposition: failure,
            error: "isolated failed execution",
          },
        })
        .where(eq(resultAttempts.id, evidence));
      await fixture.record([evidence]);
      const lease = (await fixture.acquire())!;
      const request = buildProgressiveFitRequest(lease);
      await storeProgressivePolarFit(
        db,
        lease,
        request,
        await fitUsingPython(request),
      );
      await acknowledgeProgressiveCfdExecutionStop(db, {
        simJobId: fixture.composed.jobId,
        proof: executionStopProof(fixture.engineJobId),
      });
      await db
        .update(simJobs)
        .set({ status: "failed", ingestedAt: new Date() })
        .where(eq(simJobs.id, fixture.composed.jobId));
      expect(
        await settleProgressiveCfdExecution(db, fixture.composed.jobId),
      ).toMatchObject({ retry, complete: 0, waiting: 0 });
      const replacement = await claimProgressiveCfdUnit(db, {
        owner: "bounded-infrastructure-retry",
        leaseSeconds: 120,
      });
      if (retry) {
        expect(replacement).toMatchObject({
          id: fixture.leases[0].id,
          remainingActiveSeconds: 870,
        });
        expect(replacement!.token).not.toBe(fixture.leases[0].token);
      } else expect(replacement).toBeNull();
    },
    120_000,
  );

  it("can acknowledge obsolete execution without resurrecting cancelled campaign work", async () => {
    const fixture = await fitFixture();
    await db
      .update(simCampaigns)
      .set({ status: "cancelled" })
      .where(eq(simCampaigns.id, fixture.campaignId));
    await db
      .update(simJobs)
      .set({ status: "cancelled" })
      .where(eq(simJobs.id, fixture.composed.jobId));
    await acknowledgeProgressiveCfdExecutionStop(db, {
      simJobId: fixture.composed.jobId,
      proof: {
        ...executionStopProof(fixture.engineJobId),
        fence: "cancel_marker",
      },
    });
    await settleProgressiveCfdExecution(db, fixture.composed.jobId);
    const rows = await db.execute(
      sql`SELECT state FROM progressive_cfd_units WHERE id IN (${sql.join(
        fixture.leases.map((lease) => sql`${lease.id}::uuid`),
        sql`, `,
      )})`,
    );
    expect(rows.every((row) => row.state === "cancelled")).toBe(true);
    expect(
      await claimProgressiveCfdUnit(db, {
        owner: "obsolete-job",
        leaseSeconds: 120,
      }),
    ).toBeNull();
  });
});

describe("bounded progressive numerical recovery", () => {
  async function composeRecovery(
    leases: Awaited<ReturnType<typeof claimProgressiveCfdBatch>>,
  ) {
    const execution = await materializeProgressiveCfdExecution(db, leases[0]);
    const [pool] = await db
      .select()
      .from(solverExecutionPools)
      .where(
        eq(
          solverExecutionPools.solverImplementationId,
          execution.revision.solverImplementationId,
        ),
      )
      .limit(1);
    await db
      .update(solverExecutionPools)
      .set({ enabled: true })
      .where(eq(solverExecutionPools.id, pool.id));
    await db
      .update(sweeperState)
      .set({ enabled: true })
      .where(eq(sweeperState.id, 1));
    try {
      return await composeProgressiveCfdJob(db, leases, {
        cpuSlots: 1,
        meshRecoveryVersion: 1,
        solverBudgetVersion: 2,
      });
    } finally {
      await db
        .update(solverExecutionPools)
        .set({ enabled: pool.enabled })
        .where(eq(solverExecutionPools.id, pool.id));
      await db
        .update(sweeperState)
        .set({ enabled: false })
        .where(eq(sweeperState.id, 1));
    }
  }

  async function stopped(
    fixture: Awaited<ReturnType<typeof cfdEvidenceFixture>>,
  ) {
    await acknowledgeProgressiveCfdExecutionStop(db, {
      simJobId: fixture.composed.jobId,
      proof: executionStopProof(fixture.engineJobId),
    });
    await db
      .update(simJobs)
      .set({ status: "failed", ingestedAt: new Date() })
      .where(eq(simJobs.id, fixture.composed.jobId));
  }

  it.each([0, 5])(
    "conserves the exact original sweep after a hard RANS failure at %s degrees",
    async (triggerAlpha) => {
      const angles = [-2, 0, 5, 8];
      const fixture = await cfdEvidenceFixture(32.619, 3, [42.619], angles);
      const originals = fixture.leases.map((lease) =>
        structuredClone(lease.recipe),
      );
      const attemptedAoas = triggerAlpha === 0 ? [0] : [0, 5];
      const ids = [];
      for (const alpha of attemptedAoas) {
        const evidence = await fixture.save(
          12,
          "rans",
          alpha,
          alpha === triggerAlpha
            ? { failure_disposition: "hard_solver" }
            : { converged: true },
        );
        ids.push(evidence);
        if (alpha !== triggerAlpha) {
          await db
            .update(resultAttempts)
            .set({ status: "done", validForPolar: true })
            .where(eq(resultAttempts.id, evidence));
          await db.execute(sql`
          INSERT INTO result_classifications(result_attempt_id, airfoil_id, simulation_preset_revision_id,
            aoa_deg, classifier_version, state, reasons)
          SELECT id, airfoil_id, simulation_preset_revision_id, aoa_deg, 'isolated-recovery-test', 'accepted', '{}'
          FROM result_attempts WHERE id = ${evidence}
        `);
        }
      }
      await fixture.record(ids);
      const promotion = {
        revisionId: fixture.execution.revision.id,
        triggerResultAttemptId: ids.at(-1)!,
        triggerAoaDeg: triggerAlpha,
        attemptedAoas,
        intentionallyOmittedAoas: angles.filter(
          (alpha) => !attemptedAoas.includes(alpha),
        ),
      };
      await expect(
        recordProgressiveCfdRecoveryPlans(db, fixture.composed.jobId, [
          promotion,
        ]),
      ).rejects.toThrow("physically stopped");
      await stopped(fixture);
      await expect(
        recordProgressiveCfdRecoveryPlans(db, fixture.composed.jobId, [
          promotion,
        ]),
      ).resolves.toBe(4);
      await expect(
        recordProgressiveCfdRecoveryPlans(db, fixture.composed.jobId, [
          promotion,
        ]),
      ).resolves.toBe(0);
      const plans = await db.execute(sql`
      SELECT plan.*, unit.recipe AS original_recipe FROM progressive_cfd_recovery_plans plan
      JOIN progressive_cfd_units unit ON unit.id = plan.unit_id WHERE plan.parent_job_id = ${fixture.composed.jobId}
      ORDER BY unit.aoa_deg
    `);
      expect(plans).toHaveLength(4);
      for (const [index, plan] of plans.entries()) {
        expect(plan.original_recipe).toEqual(originals[index]);
        expect(plan).toMatchObject({
          scope: "original_sweep",
          diagnostic_attempt_id: ids.at(-1),
        });
        expect(plan.recipe).toMatchObject({
          mesh: originals[index].mesh,
          selection: { solver: "rhoPimpleFoam", pressureKind: "absolute" },
        });
      }
      await expect(
        db.execute(
          sql`UPDATE progressive_cfd_recovery_plans SET reason = 'needs_urans' WHERE id = ${plans[0].id}`,
        ),
      ).rejects.toThrow();
      expect(
        await settleProgressiveCfdExecution(db, fixture.composed.jobId),
      ).toMatchObject({ retry: 4, complete: 0, gaps: 0 });
      const replacements = await claimProgressiveCfdBatch(db, {
        owner: "bounded-numerical-recovery",
        leaseSeconds: 120,
        solverBudgetVersion: 2,
        allowedSolverFamilies: ["rhoPimpleFoam"],
      });
      expect(replacements.map((lease) => lease.alpha)).toEqual(angles);
      expect(
        replacements.every(
          (lease) =>
            lease.recoveryParentJobId === fixture.composed.jobId &&
            lease.recoveryPlanId,
        ),
      ).toBe(true);
      for (const lease of replacements)
        expect(lease.remainingActiveSeconds).toBe(
          43_200 - (attemptedAoas.includes(lease.alpha) ? 12 : 0),
        );
      const recovered = await materializeProgressiveCfdExecution(
        db,
        replacements[0],
      );
      expect(recovered.snapshot.solver.flowSolverFamily).toBe("rhoPimpleFoam");
      expect(recovered.snapshot.mesh).toEqual(fixture.execution.snapshot.mesh);
      await expect(
        materializeProgressiveCfdExecution(db, {
          ...replacements[0],
          recoveryPlanId: randomUUID(),
        }),
      ).rejects.toThrow("sealed scope");
      const [remaining] = await db.execute(sql`
      SELECT count(*)::int AS count FROM progressive_cfd_recovery_plans plan JOIN progressive_cfd_units unit ON unit.id = plan.unit_id
      WHERE unit.work_id <> ${fixture.leases[0].workId}
    `);
      expect(remaining.count).toBe(0);
      const retained = await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.simJobId, fixture.composed.jobId));
      expect(retained).toHaveLength(attemptedAoas.length);
    },
    120_000,
  );

  it("verifies only accepted preliminary sweep recovery within the original time allocation", async () => {
    const fixture = await cfdEvidenceFixture(33.119, 3, [], [0, 5]);
    const failure = await fixture.save(10, "rans", 5, {
      failure_disposition: "hard_solver",
    });
    const acceptedRans = await fixture.save(10, "rans", 0, { converged: true });
    await db
      .update(resultAttempts)
      .set({ status: "done", validForPolar: true })
      .where(eq(resultAttempts.id, acceptedRans));
    await db.execute(sql`
      UPDATE results SET current_result_attempt_id = ${acceptedRans} WHERE id = (SELECT result_id FROM result_attempts WHERE id = ${acceptedRans})
    `);
    await db.execute(sql`
      INSERT INTO result_classifications(result_attempt_id, airfoil_id, simulation_preset_revision_id,
        aoa_deg, classifier_version, regime, state, reasons)
      SELECT id, airfoil_id, simulation_preset_revision_id, aoa_deg, 'isolated-recovery-test', regime, 'accepted', '{}'
      FROM result_attempts WHERE id = ${acceptedRans}
    `);
    await db.execute(sql`
      INSERT INTO result_classifications(result_id, airfoil_id, simulation_preset_revision_id,
        aoa_deg, classifier_version, regime, state, reasons)
      SELECT result_id, airfoil_id, simulation_preset_revision_id, aoa_deg, 'isolated-recovery-test', regime, 'accepted', '{}'
      FROM result_attempts WHERE id = ${acceptedRans}
    `);
    await fixture.record([acceptedRans, failure]);
    await stopped(fixture);
    await recordProgressiveCfdRecoveryPlans(db, fixture.composed.jobId, [
      {
        revisionId: fixture.execution.revision.id,
        triggerResultAttemptId: failure,
        triggerAoaDeg: 5,
        attemptedAoas: [0, 5],
        intentionallyOmittedAoas: [],
      },
    ]);
    expect(
      await settleProgressiveCfdExecution(db, fixture.composed.jobId),
    ).toMatchObject({ retry: 2 });
    const preliminaryLeases = await claimProgressiveCfdBatch(db, {
      owner: "preliminary-recovery",
      leaseSeconds: 120,
      solverBudgetVersion: 2,
    });
    const preliminary = await composeRecovery(preliminaryLeases);
    expect(preliminary.request.solver).toMatchObject({
      flow_solver_family: "rhoPimpleFoam",
      urans_fidelity: "precalc",
      warm_start: true,
    });
    expect(preliminary.request.aoa.angles).toEqual([0, 5]);
    expect(preliminary.request.urans_precalc_mesh).toEqual(
      preliminary.request.mesh,
    );
    expect(preliminary.request.urans_mesh).toEqual(preliminary.request.mesh);
    const [preliminaryJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, preliminary.jobId));
    expect(preliminaryJob.parentJobId).toBe(fixture.composed.jobId);

    async function finish(job: typeof preliminary, duration: number) {
      await db
        .update(simJobs)
        .set({ engineJobId: job.jobId, status: "running" })
        .where(eq(simJobs.id, job.jobId));
      const cells = await db
        .select()
        .from(results)
        .where(eq(results.simJobId, job.jobId));
      const evidenceIds = [];
      for (const cell of cells) {
        const accepted = cell.aoaDeg === 0;
        const [raw] = await db
          .insert(resultAttempts)
          .values({
            resultId: cell.id,
            airfoilId: cell.airfoilId,
            bcId: cell.bcId,
            simulationPresetRevisionId: cell.simulationPresetRevisionId,
            simJobId: job.jobId,
            engineJobId: job.jobId,
            aoaDeg: cell.aoaDeg,
            regime: "urans",
            status: accepted ? "done" : "failed",
            source: "queued",
            validForPolar: accepted,
            evidencePayload: {
              solver_active_seconds: duration,
              fidelity:
                job.request.solver?.urans_fidelity === "precalc"
                  ? "urans_precalc"
                  : "urans_full",
            },
          })
          .returning();
        evidenceIds.push(raw.id);
        if (accepted)
          await db.execute(sql`
          INSERT INTO result_classifications(result_attempt_id, airfoil_id, simulation_preset_revision_id,
            aoa_deg, classifier_version, state, reasons)
          SELECT id, airfoil_id, simulation_preset_revision_id, aoa_deg, 'isolated-recovery-test', 'accepted', '{}'
          FROM result_attempts WHERE id = ${raw.id}
        `);
      }
      await recordProgressiveCfdEvidence(db, {
        simJobId: job.jobId,
        engineJobId: job.jobId,
        resultAttemptIds: evidenceIds,
      });
      await acknowledgeProgressiveCfdExecutionStop(db, {
        simJobId: job.jobId,
        proof: executionStopProof(job.jobId),
      });
      await db
        .update(simJobs)
        .set({ status: "done", ingestedAt: new Date() })
        .where(eq(simJobs.id, job.jobId));
      return evidenceIds;
    }
    await finish(preliminary, 100);
    expect(await recordProgressiveCfdRecoveryPlans(db, preliminary.jobId)).toBe(
      1,
    );
    expect(await recordProgressiveCfdRecoveryPlans(db, preliminary.jobId)).toBe(
      0,
    );
    expect(
      await settleProgressiveCfdExecution(db, preliminary.jobId),
    ).toMatchObject({ retry: 1, gaps: 1, complete: 0 });
    const verificationLeases = await claimProgressiveCfdBatch(db, {
      owner: "precise-verification",
      leaseSeconds: 120,
      solverBudgetVersion: 2,
    });
    expect(verificationLeases).toHaveLength(1);
    expect(verificationLeases[0]).toMatchObject({
      alpha: 0,
      remainingActiveSeconds: 43_090,
      recoveryParentJobId: preliminary.jobId,
    });
    const verification = await composeRecovery(verificationLeases);
    expect(verification.request.solver?.urans_fidelity).toBe("full");
    expect(verification.request.mesh).toEqual(preliminary.request.mesh);
    await finish(verification, 50);
    expect(
      await recordProgressiveCfdRecoveryPlans(db, verification.jobId),
    ).toBe(0);
    expect(
      await settleProgressiveCfdExecution(db, verification.jobId),
    ).toMatchObject({ complete: 1, retry: 0 });
    const [unit] = await db.execute(
      sql`SELECT attempts, active_seconds, active_budget_seconds, state FROM progressive_cfd_units WHERE id = ${verificationLeases[0].id}`,
    );
    expect(unit).toEqual({
      attempts: 3,
      active_seconds: 160,
      active_budget_seconds: 43_200,
      state: "complete",
    });
    expect(
      await claimProgressiveCfdBatch(db, {
        owner: "no-fourth-attempt",
        leaseSeconds: 120,
      }),
    ).toEqual([]);
    const [preliminaryRaw] = await db
      .select()
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.simJobId, preliminary.jobId),
          eq(resultAttempts.aoaDeg, 0),
        ),
      );
    const [verifiedRaw] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.simJobId, verification.jobId));
    expect(
      await progressiveParentRevisionIds(
        db,
        originalId,
        verifiedRaw.simulationPresetRevisionId!,
      ),
    ).toEqual([preliminaryRaw.simulationPresetRevisionId]);
    expect(
      await progressiveParentRevisionIds(
        db,
        originalId,
        preliminaryRaw.simulationPresetRevisionId!,
      ),
    ).toEqual([fixture.execution.revision.id]);
    expect(
      await progressiveParentRevisionIds(
        db,
        randomUUID(),
        verifiedRaw.simulationPresetRevisionId!,
      ),
    ).toEqual([]);
    await supersedeProgressivePriorEvidence(
      db,
      randomUUID(),
      fixture.execution.revision.id,
    );
    const classes = () =>
      db.execute(sql`
      SELECT state, superseded_by_result_id FROM result_classifications
      WHERE result_attempt_id = ${acceptedRans} OR result_id = (SELECT result_id FROM result_attempts WHERE id = ${acceptedRans})
    `);
    expect((await classes()).every((row) => row.state === "accepted")).toBe(
      true,
    );
    await supersedeProgressivePriorEvidence(
      db,
      originalId,
      preliminaryRaw.simulationPresetRevisionId!,
    );
    await supersedeProgressivePriorEvidence(
      db,
      originalId,
      fixture.execution.revision.id,
    );
    const superseded = await classes();
    expect(superseded).toHaveLength(2);
    expect(
      superseded.every(
        (row) =>
          row.state === "superseded_by_urans" &&
          row.superseded_by_result_id === verifiedRaw.resultId,
      ),
    ).toBe(true);
    const [retainedRans] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.id, acceptedRans));
    expect(retainedRans).toMatchObject({ status: "done", validForPolar: true });
    await db.execute(
      sql`INSERT INTO result_review_verdicts(result_id, verdict, reviewer) VALUES (${verifiedRaw.resultId}, 'exclude', 'isolated-recovery-test')`,
    );
    await db.execute(
      sql`UPDATE result_classifications SET state = 'accepted', superseded_by_result_id = NULL WHERE result_attempt_id = ${preliminaryRaw.id}`,
    );
    await supersedeProgressivePriorEvidence(
      db,
      originalId,
      preliminaryRaw.simulationPresetRevisionId!,
    );
    await supersedeProgressivePriorEvidence(
      db,
      originalId,
      fixture.execution.revision.id,
    );
    expect(
      (await classes()).every(
        (row) => row.superseded_by_result_id === preliminaryRaw.resultId,
      ),
    ).toBe(true);
  }, 120_000);

  it.each([-2, 6])(
    "keeps hard failure outside the promotion interval targeted at %s degrees",
    async (alpha) => {
      const fixture = await cfdEvidenceFixture(32.719, 3, [], [-2, 0, 6]);
      const evidence = await fixture.save(20, "rans", alpha, {
        failure_disposition: "hard_solver",
      });
      await fixture.record([evidence]);
      await stopped(fixture);
      await expect(
        recordProgressiveCfdRecoveryPlans(db, fixture.composed.jobId),
      ).resolves.toBe(1);
      const plans = await db.execute(sql`
      SELECT unit.aoa_deg, plan.scope FROM progressive_cfd_recovery_plans plan JOIN progressive_cfd_units unit ON unit.id = plan.unit_id
      WHERE plan.parent_job_id = ${fixture.composed.jobId}
    `);
      expect(plans).toEqual([{ aoa_deg: alpha, scope: "targeted" }]);
      expect(
        await settleProgressiveCfdExecution(db, fixture.composed.jobId),
      ).toMatchObject({ retry: 1, gaps: 2 });
    },
    120_000,
  );

  it("keeps explicit single-angle and needs-URANS evidence targeted", async () => {
    const fixture = await cfdEvidenceFixture(32.819, 3, [], [0]);
    const evidence = await fixture.save(20, "rans", 0);
    await fixture.record([evidence]);
    await db.execute(sql`
      INSERT INTO result_classifications(result_attempt_id, airfoil_id, simulation_preset_revision_id,
        aoa_deg, classifier_version, state, reasons)
      SELECT id, airfoil_id, simulation_preset_revision_id, aoa_deg, 'isolated-recovery-test', 'needs_urans', '{}'
      FROM result_attempts WHERE id = ${evidence}
    `);
    await stopped(fixture);
    await expect(
      recordProgressiveCfdRecoveryPlans(db, fixture.composed.jobId, [
        {
          revisionId: fixture.execution.revision.id,
          triggerResultAttemptId: evidence,
          triggerAoaDeg: 0,
          attemptedAoas: [0],
          intentionallyOmittedAoas: [],
        },
      ]),
    ).rejects.toThrow("original RANS promotion scope");
    await expect(
      recordProgressiveCfdRecoveryPlans(db, fixture.composed.jobId),
    ).resolves.toBe(1);
    const [plan] = await db.execute(
      sql`SELECT scope, reason FROM progressive_cfd_recovery_plans WHERE parent_job_id = ${fixture.composed.jobId}`,
    );
    expect(plan).toEqual({ scope: "targeted", reason: "needs_urans" });
  }, 120_000);

  it.each([false, true])(
    "progressive remote dispatch retains recovery on its original execution owner (remote=%s)",
    async (remote) => {
      const fixture = await cfdEvidenceFixture(
        remote ? 33.319 : 33.219,
        3,
        [],
        [0],
      );
      const evidence = await fixture.save(20, "rans", 0);
      await fixture.record([evidence]);
      await db.execute(sql`INSERT INTO result_classifications(result_attempt_id, airfoil_id, simulation_preset_revision_id,
      aoa_deg, classifier_version, state, reasons)
      SELECT id, airfoil_id, simulation_preset_revision_id, aoa_deg, 'isolated-owner-recovery-test', 'needs_urans', '{}'
      FROM result_attempts WHERE id = ${evidence}`);
      const solverId = randomUUID();
      const promiseId = randomUUID();
      try {
        if (remote) {
          const [job] = await db
            .select()
            .from(simJobs)
            .where(eq(simJobs.id, fixture.composed.jobId));
          const envelope = sealProgressiveRemoteExecution({
            solverId,
            promiseId,
            request: job.requestPayload!
              .engineRequest as typeof fixture.composed.request,
            scope: job.requestPayload!.progressive,
          });
          await db.execute(sql`INSERT INTO registered_remote_solvers(id, instance_id, instance_name, cpu_capacity, cpu_budget)
          VALUES (${solverId}::uuid, ${randomUUID()}, 'isolated recovery owner', 96, 96)`);
          await db.execute(sql`INSERT INTO sync_sweep_promises(id, registered_solver_id, airfoil_id, simulation_preset_revision_id, aoa_count, "expiresAt")
          VALUES (${promiseId}::uuid, ${solverId}::uuid, ${job.airfoilId}::uuid, ${job.simulationPresetRevisionId}::uuid, 1, clock_timestamp() + interval '1 hour')`);
          await db.execute(sql`INSERT INTO progressive_remote_dispatches(sim_job_id, solver_id, promise_id, cpu_slots, content_signature, envelope)
          VALUES (${job.id}::uuid, ${solverId}::uuid, ${promiseId}::uuid, 1, ${envelope.contentSignature}, ${JSON.stringify(envelope)}::jsonb)`);
        }
        await stopped(fixture);
        expect(
          await recordProgressiveCfdRecoveryPlans(db, fixture.composed.jobId),
        ).toBe(1);
        expect(
          await settleProgressiveCfdExecution(db, fixture.composed.jobId),
        ).toMatchObject({ retry: 1 });
        const request = {
          owner: "isolated-affinity-recovery",
          leaseSeconds: 120,
          solverBudgetVersion: 2,
        };
        expect(
          await claimProgressiveCfdBatch(db, {
            ...request,
            remoteSolverId: randomUUID(),
          }),
        ).toEqual([]);
        if (remote)
          expect(await claimProgressiveCfdBatch(db, request)).toEqual([]);
        const [untouched] = await db.execute(
          sql`SELECT state, attempts FROM progressive_cfd_units WHERE id = ${fixture.leases[0].id}::uuid`,
        );
        expect(untouched).toEqual({ state: "pending", attempts: 1 });
        const recovery = await claimProgressiveCfdBatch(db, {
          ...request,
          ...(remote ? { remoteSolverId: solverId } : {}),
        });
        expect(recovery).toHaveLength(1);
        expect(recovery[0].recoveryParentJobId).toBe(fixture.composed.jobId);
      } finally {
        if (remote) {
          await db.execute(
            sql`DELETE FROM progressive_remote_dispatches WHERE sim_job_id = ${fixture.composed.jobId}::uuid`,
          );
          await db.execute(
            sql`DELETE FROM sync_sweep_promises WHERE id = ${promiseId}::uuid`,
          );
          await db.execute(
            sql`DELETE FROM registered_remote_solvers WHERE id = ${solverId}::uuid`,
          );
        }
      }
    },
    120_000,
  );

  it.each(["infrastructure", "deterministic_mesh", "material_domain"])(
    "does not convert %s into an unsteady diagnosis",
    async (failure) => {
      const fixture = await cfdEvidenceFixture(32.919, 3, [], [0]);
      const evidence = await fixture.save(20, "rans", 0, {
        failure_disposition: failure,
      });
      await fixture.record([evidence]);
      await stopped(fixture);
      await expect(
        recordProgressiveCfdRecoveryPlans(db, fixture.composed.jobId),
      ).resolves.toBe(0);
    },
    120_000,
  );

  it("does not enlarge exhausted compute allocations for numerical recovery", async () => {
    const fixture = await cfdEvidenceFixture(33.019, 3, [], [0]);
    const evidence = await fixture.save(43_200, "rans", 0, {
      failure_disposition: "hard_solver",
    });
    await fixture.record([evidence]);
    await stopped(fixture);
    expect(
      await recordProgressiveCfdRecoveryPlans(db, fixture.composed.jobId),
    ).toBe(1);
    expect(
      await settleProgressiveCfdExecution(db, fixture.composed.jobId),
    ).toMatchObject({ retry: 0, gaps: 1 });
    expect(
      await claimProgressiveCfdUnit(db, {
        owner: "exhausted-numerical-recovery",
        leaseSeconds: 120,
      }),
    ).toBeNull();
  }, 120_000);

  it("preserves pressure and mesh meaning when selecting unsteady numerical variants", () => {
    for (const [steady, transient, pressure] of [
      ["simpleFoam", "pimpleFoam", "kinematic"],
      ["rhoSimpleFoam", "rhoPimpleFoam", "absolute"],
    ]) {
      const base = {
        selection: { solver: steady, pressureKind: pressure },
        mesh: { cells: 100 },
        solver: { tolerance: 1e-6 },
      };
      const original = structuredClone(base);
      const local = {
        ...base,
        timeCoordinate: "local_pseudo_time_iterations",
        selection: { solver: "rhoCentralFoam", pressureKind: "absolute" },
      };
      const recovered = progressiveUnsteadyRecipe(local, "needs_urans");
      expect(recovered).toMatchObject({
        timeCoordinate: "physical_time_seconds",
        selection: {
          solver: "rhoCentralFoam",
          reason: "bounded_needs_urans_recovery",
        },
      });
      expect(local.timeCoordinate).toBe("local_pseudo_time_iterations");
      expect(progressiveUnsteadyRecipe(recovered!, "hard_solver")).toBeNull();
      expect(progressiveUnsteadyRecipe(base, "hard_solver")).toMatchObject({
        selection: { solver: transient, pressureKind: pressure },
        mesh: base.mesh,
        solver: base.solver,
      });
      expect(base).toEqual(original);
    }
    for (const family of ["pimpleFoam", "rhoPimpleFoam", "rhoCentralFoam"])
      expect(
        progressiveUnsteadyRecipe(
          { selection: { solver: family } },
          "hard_solver",
        ),
      ).toBeNull();
  });

  it("persists an engine promotion through terminal ingestion before admitting its original replacement scope", async () => {
    const fixture = await cfdEvidenceFixture(33.219, 3, [], [-2, 0, 5]);
    const engine = new EngineClient("http://unused.invalid");
    vi.spyOn(engine, "getJob").mockResolvedValue({
      job_id: fixture.engineJobId,
      state: "completed",
      total_cases: 3,
      completed_cases: 1,
    });
    vi.spyOn(engine, "getExecutionStopProof").mockResolvedValue(
      executionStopProof(fixture.engineJobId),
    );
    vi.spyOn(engine, "getResult").mockResolvedValue({
      job_id: fixture.engineJobId,
      state: "completed",
      mesh_recovery_version: 1,
      engine: {
        ...fixture.composed.request.expected_engine!,
        build_id: `isolated-progressive-promotion-${sequence}`,
        application_source_sha256: analysisContentHash({
          fixture: PREFIX,
          sequence,
        }),
      },
      polars: [
        {
          speed: fixture.execution.snapshot.flowState.speedMps,
          chord: fixture.execution.snapshot.referenceGeometry.referenceLengthM,
          reynolds: fixture.execution.snapshot.derived.reynolds!,
          points: [],
          attempts: [
            {
              aoa_deg: 0,
              solver_active_seconds: 12,
              converged: false,
              unsteady: false,
              first_order_fallback: false,
              images: {},
              failure_disposition: "hard_solver",
              error: "isolated structured RANS failure",
            },
          ],
          rans_precalc_promotion: {
            trigger_aoa_deg: 0,
            failure_disposition: "hard_solver",
            attempted_aoas: [0],
            intentionally_omitted_aoas: [-2, 5],
          },
        },
      ],
    });
    const [job] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, fixture.composed.jobId));
    await reconcileProgressiveCfdJob(db, engine, job);
    const [finished] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, job.id));
    expect(finished.ingestedAt).toBeInstanceOf(Date);
    const evidence = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.simJobId, job.id));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ aoaDeg: 0, validForPolar: false });
    const plans = await db.execute(
      sql`SELECT diagnostic_attempt_id, scope FROM progressive_cfd_recovery_plans WHERE parent_job_id = ${job.id}`,
    );
    expect(plans).toHaveLength(3);
    expect(
      plans.every(
        (plan) =>
          plan.scope === "original_sweep" &&
          plan.diagnostic_attempt_id === evidence[0].id,
      ),
    ).toBe(true);
    expect(await settleProgressiveCfdExecution(db, job.id)).toMatchObject({
      retry: 3,
      complete: 0,
      gaps: 0,
    });
    const leases = await claimProgressiveCfdBatch(db, {
      owner: "ingested-promotion",
      leaseSeconds: 120,
      solverBudgetVersion: 2,
    });
    expect(leases.map((lease) => lease.alpha)).toEqual([-2, 0, 5]);
    const replacement = await composeRecovery(leases);
    expect(replacement.request.aoa.angles).toEqual([-2, 0, 5]);
    expect(replacement.request.solver?.urans_fidelity).toBe("precalc");
    expect(
      await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.campaignId, fixture.campaignId)),
    ).toHaveLength(2);
  }, 120_000);
});

describe("persistent progressive polar cache", () => {
  it("automatically fits notified CFD receipts while respecting the global stop gate", async () => {
    const fixture = await fitFixture();
    const engine = new EngineClient("http://unused.invalid");
    const fitting = vi
      .spyOn(engine, "fitProgressivePolar")
      .mockImplementation(fitUsingPython);
    const predictions = vi
      .spyOn(engine, "predictNeuralFoil")
      .mockRejectedValue(new Error("No baseline is missing"));
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 30_000);
    try {
      expect(
        await runProgressiveFitBatch(db, engine, "stopped-fitting"),
      ).toMatchObject({ claimed: 0 });
      await db
        .update(sweeperState)
        .set({ enabled: true })
        .where(eq(sweeperState.id, 1));
      expect(
        await runProgressiveFitBatch(db, engine, "no-cfd-fitting"),
      ).toMatchObject({ claimed: 0 });
      const evidence = await fixture.save(60);
      await db
        .update(resultAttempts)
        .set({
          evidencePayload: {
            solver_active_seconds: 60,
            converged: true,
            cl: 0.7,
            cd: 0.025,
            cm: -0.03,
          },
        })
        .where(eq(resultAttempts.id, evidence));
      await fixture.record([evidence]);
      await db
        .update(sweeperState)
        .set({ enabled: false })
        .where(eq(sweeperState.id, 1));
      expect(
        await runProgressiveFitBatch(db, engine, "stopped-with-cfd"),
      ).toMatchObject({ claimed: 0 });
      expect(fitting).not.toHaveBeenCalled();
      await db
        .update(sweeperState)
        .set({ enabled: true })
        .where(eq(sweeperState.id, 1));
      const receipts: Record<string, unknown>[] = [];
      await runProgressiveBaselineService(
        db,
        client.sql,
        engine,
        abort.signal,
        (receipt) => {
          receipts.push(receipt);
          if (receipt.component === "progressive-fitting") abort.abort();
        },
      );
      expect(receipts).toContainEqual({
        component: "progressive-fitting",
        claimed: 1,
        stored: 1,
        errors: [],
      });
      expect(fitting).toHaveBeenCalledTimes(1);
      expect(predictions).not.toHaveBeenCalled();
      expect(
        await runProgressiveFitBatch(db, engine, "unchanged-fitting"),
      ).toMatchObject({ claimed: 0 });
      expect(
        await invalidateProgressiveFitPolicy(db, PROGRESSIVE_FIT_POLICY_ID),
      ).toBe(0);
      expect(
        await invalidateProgressiveFitPolicy(db, "isolated-revised-fit-policy"),
      ).toBe(1);
      expect((await fixture.acquire())!.source.evidence).toHaveLength(1);
    } finally {
      clearTimeout(timeout);
      abort.abort();
      fitting.mockRestore();
      predictions.mockRestore();
      await db
        .update(sweeperState)
        .set({ enabled: false })
        .where(eq(sweeperState.id, 1));
    }
  }, 120_000);

  it("reduces actual unconverged histories after producer windowing without losing the source origin", async () => {
    const fixture = await fitFixture();
    const evidenceIds: string[] = [];
    for (const unit of fixture.leases.slice(0, 2)) {
      const evidenceId = await fixture.save(70, "urans", unit.alpha);
      evidenceIds.push(evidenceId);
      const history = JSON.parse(
        execFileSync(
          resolve(ROOT, ".venv/bin/python"),
          [resolve(ROOT, "tests/windowed_force_history_fixture.py")],
          {
            cwd: ROOT,
            encoding: "utf8",
            timeout: 20_000,
            input: JSON.stringify({ offset: 203, alpha: unit.alpha }),
          },
        ),
      );
      expect(history.t[0]).toBeCloseTo(history.window_start, 10);
      expect(history.source_start_time).toBe(203);
      await db
        .update(resultAttempts)
        .set({
          evidencePayload: {
            fixture_kind: "synthetic-producer-window-contract",
            solver_active_seconds: 70,
            unsteady: true,
            converged: false,
            force_history: history,
          },
        })
        .where(eq(resultAttempts.id, evidenceId));
    }
    await fixture.record(evidenceIds);
    const lease = (await fixture.acquire())!;
    const request = buildProgressiveFitRequest(lease);
    expect(request.histories).toHaveLength(2);
    const response = await fitUsingPython(request);
    expect(
      new Set(response.estimate.contributors.map((row) => row.attempt_id)),
    ).toEqual(new Set(evidenceIds));
    for (const origin of [1e9, "203"]) {
      const invalid = structuredClone(lease);
      for (const evidence of invalid.source.evidence)
        (
          evidence.payload.force_history as Record<string, unknown>
        ).source_start_time = origin;
      expect(buildProgressiveFitRequest(invalid).histories).toHaveLength(0);
    }
    for (const offset of [-500, 500]) {
      const shifted = structuredClone(lease);
      for (const evidence of shifted.source.evidence) {
        const history = evidence.payload.force_history as {
          t: number[];
          source_start_time: number;
          window_start: number;
          window_end: number;
        };
        history.t = history.t.map((value) => value + offset);
        history.source_start_time += offset;
        history.window_start += offset;
        history.window_end += offset;
      }
      expect(buildProgressiveFitRequest(shifted).histories).toHaveLength(2);
    }
    const negative = structuredClone(lease);
    for (const evidence of negative.source.evidence)
      (evidence.payload.force_history as { cd: number[] }).cd[0] = -0.01;
    expect(buildProgressiveFitRequest(negative).histories).toHaveLength(0);
    const transit =
      lease.source.physical.reference.referenceLengthM /
      lease.source.physical.flow.speedMps;
    const partialStartup = structuredClone(lease);
    for (const evidence of partialStartup.source.evidence) {
      const history = evidence.payload.force_history as {
        t: number[];
        source_start_time: number;
        window_start: number;
        window_end: number;
      };
      history.source_start_time = 203;
      history.t = history.t.map(
        (_, index) =>
          203 + (0.6 + (0.9 * index) / (history.t.length - 1)) * transit,
      );
      history.window_start = history.t[0];
      history.window_end = history.t.at(-1)!;
    }
    const suffixRequest = buildProgressiveFitRequest(partialStartup);
    expect(suffixRequest.histories).toHaveLength(2);
    for (const history of suffixRequest.histories)
      expect(history.informative_start).toBeCloseTo(203 + transit, 10);
    const suffixResponse = await fitUsingPython(suffixRequest);
    expect(
      new Set(
        suffixResponse.estimate.contributors.map((row) => row.attempt_id),
      ),
    ).toEqual(new Set(evidenceIds));
    for (const origin of [undefined, null]) {
      const unknown = structuredClone(partialStartup);
      for (const evidence of unknown.source.evidence)
        (
          evidence.payload.force_history as Record<string, unknown>
        ).source_start_time = origin;
      expect(buildProgressiveFitRequest(unknown).histories).toHaveLength(0);
    }
    const startup = structuredClone(partialStartup);
    for (const evidence of startup.source.evidence) {
      const history = evidence.payload.force_history as {
        source_start_time: number;
        window_start: number;
        t: number[];
        window_end: number;
      };
      history.t = history.t.map(
        (_, index) => 203 + (0.5 * transit * index) / (history.t.length - 1),
      );
      history.window_start = history.t[0];
      history.window_end = history.t.at(-1)!;
    }
    expect(buildProgressiveFitRequest(startup).histories).toHaveLength(0);
  }, 30_000);

  it("reduces actual unconverged histories and excludes earlier lineage evidence without inventing points", async () => {
    const fixture = await fitFixture();
    const ids: string[] = [];
    for (const seconds of [60, 70]) {
      const unsteady = seconds === 70;
      const evidence = await fixture.save(seconds, unsteady ? "urans" : "rans");
      ids.push(evidence);
      const coordinate = Array.from({ length: seconds * 2 + 1 }, (_, index) =>
        unsteady ? index / 10 : index,
      );
      await db
        .update(resultAttempts)
        .set({
          evidencePayload: {
            solver_active_seconds: seconds,
            unsteady,
            converged: false,
            error:
              "Convergence not established; no floating point exception detected",
            [unsteady ? "force_history" : "steady_history"]: {
              ...(unsteady
                ? { t: coordinate, window_start: 2 }
                : { iterations: coordinate, window: { start_iter: 2 } }),
              cl: coordinate.map((time) => 0.7 + 0.03 * Math.sin(time)),
              cd: coordinate.map(() => 0.025),
              cm: coordinate.map(() => -0.03),
            },
          },
        })
        .where(eq(resultAttempts.id, evidence));
    }
    await fixture.record(ids);
    const lease = (await fixture.acquire())!;
    const request = buildProgressiveFitRequest(lease);
    expect(request.histories).toHaveLength(1);
    expect(request.histories[0]).toMatchObject({
      informative_start: 2,
      correlation_time: null,
      correlation_evidence_id: null,
    });
    expect(request.observations).toHaveLength(1);
    expect(request.observations[0]).toMatchObject({
      eligible: false,
      coefficients: null,
      exclusion_reason: "overlapping_lineage_evidence",
    });
    const response = await fitUsingPython(request);
    expect(response.estimate.contributors).toHaveLength(3);
    expect(
      response.estimate.contributors.every(
        (row) => row.numerical_convergence === "unconverged",
      ),
    ).toBe(true);
    const startup = structuredClone(lease);
    const unsteadySource = startup.source.evidence.find(
      (source) => source.payload.unsteady === true,
    )!;
    unsteadySource.classification = null;
    const history = unsteadySource.payload.force_history as {
      t: number[];
      window_start: number;
    };
    const transit =
      startup.source.physical.reference.referenceLengthM /
      startup.source.physical.flow.speedMps;
    history.t = history.t.map((time) => (time * transit) / 1400);
    history.window_start *= transit / 1400;
    const excludedStartup = buildProgressiveFitRequest(startup);
    expect(excludedStartup.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempt_id: unsteadySource.resultAttemptId,
          eligible: false,
          exclusion_reason: "startup_only_history",
        }),
      ]),
    );
    history.t = history.t.map((time) => time + 203);
    history.window_start += 203;
    expect(buildProgressiveFitRequest(startup).observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempt_id: unsteadySource.resultAttemptId,
          eligible: false,
          exclusion_reason: "startup_only_history",
        }),
      ]),
    );
    expect(
      excludedStartup.histories.every(
        (item) => item.coordinate_kind === "iteration",
      ),
    ).toBe(true);
    unsteadySource.classification = {
      state: "accepted",
      reasons: [],
      version: "isolated-accepted-unsteady-fixture",
    };
    expect(
      buildProgressiveFitRequest(startup).histories.some(
        (item) =>
          item.observation.attempt_id === unsteadySource.resultAttemptId,
      ),
    ).toBe(true);
    unsteadySource.classification = null;
    startup.source.physical.flow.speedMps = 0;
    expect(buildProgressiveFitRequest(startup).observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempt_id: unsteadySource.resultAttemptId,
          eligible: false,
          exclusion_reason: "missing_physical_history_scale",
        }),
      ]),
    );
    await storeProgressivePolarFit(db, lease, request, response);
    const [reducer] = await db.execute(sql`
      INSERT INTO result_reducer_versions(reducer_key, reducer_version, build_id, policy_sha256)
      VALUES ('isolated-progressive-history', '1', ${PREFIX}, ${analysisContentHash({ fixture: PREFIX })}) RETURNING id
    `);
    const current = request.histories[0].observation;
    const [interpretation] = await db.execute(sql`
      INSERT INTO result_interpretations(result_id, result_attempt_id, reducer_version_id, source,
        input_evidence_signature, state, regime, continuation_reason, max_iat_seconds,
        uncertainty_basis, effective_blocks)
      VALUES (${current.result_id}, ${current.attempt_id}, ${reducer.id}, 'engine_reported',
        'isolated-stored-history-interpretation', 'continuation_required', 'broadband_stationary',
        'additional bounded blocks required', 0.5, 'paired_blocks', 2) RETURNING id
    `);
    const interpreted = (await fixture.acquire())!;
    const interpretedRequest = buildProgressiveFitRequest(interpreted);
    expect(interpretedRequest.histories[0]).toMatchObject({
      correlation_time: 0.5,
      correlation_evidence_id: interpretation.id,
    });
    const interpretedResponse = await fitUsingPython(interpretedRequest);
    const inventedCorrelation = structuredClone(interpretedRequest);
    inventedCorrelation.histories[0].correlation_time = 0.7;
    await expect(
      storeProgressivePolarFit(
        db,
        interpreted,
        inventedCorrelation,
        interpretedResponse,
      ),
    ).rejects.toThrow("matching stored interpretation");
    await storeProgressivePolarFit(
      db,
      interpreted,
      interpretedRequest,
      interpretedResponse,
    );
    for (const source of lease.source.evidence)
      source.payload.failure_disposition = "material_domain";
    const clamped = buildProgressiveFitRequest(lease);
    expect(clamped.histories).toEqual([]);
    expect(
      clamped.observations.every(
        (row) =>
          !row.eligible && row.exclusion_reason === "failure_material_domain",
      ),
    ).toBe(true);
    for (const source of lease.source.evidence) {
      delete source.payload.failure_disposition;
      source.payload.error = "FOAM FATAL ERROR: solver diverged";
    }
    const rejected = buildProgressiveFitRequest(lease);
    expect(rejected.histories).toEqual([]);
    expect(
      rejected.observations.every(
        (row) =>
          !row.eligible &&
          row.exclusion_reason === "divergent_or_fatal_solver_evidence",
      ),
    ).toBe(true);
  }, 120_000);

  it("constructs a working whole-curve fit from real stored coefficients and invalidates it on review changes", async () => {
    const fixture = await fitFixture();
    const evidence = await fixture.save(60);
    await db
      .update(resultAttempts)
      .set({
        evidencePayload: {
          solver_active_seconds: 60,
          converged: true,
          cl: 0.7,
          cd: 0.025,
          cm: -0.03,
        },
      })
      .where(eq(resultAttempts.id, evidence));
    await fixture.record([evidence]);
    const lease = (await fixture.acquire())!;
    const request = buildProgressiveFitRequest(lease);
    expect(request.policy.policy_id).toBe(PROGRESSIVE_FIT_POLICY_ID);
    expect(request.policy.calibration_status).toBe("unvalidated");
    expect(request.observations[0]).toMatchObject({
      coefficients: [0.7, 0.025, -0.03],
      eligible: true,
    });
    const response = await fitUsingPython(request);
    expect(response.estimate.best_method).toBe("openfoam_fast");
    await storeProgressivePolarFit(db, lease, request, response);
    const [review] = await db.execute(sql`
      INSERT INTO result_review_verdicts(result_id, verdict, reviewer)
      VALUES (${lease.source.evidence[0].resultId}, 'exclude', 'isolated-progressive-test') RETURNING id
    `);
    const excludedLease = (await fixture.acquire())!;
    expect(excludedLease.source.signature).not.toBe(lease.source.signature);
    expect(excludedLease.source.evidence[0].review?.verdict).toBe("exclude");
    const excludedRequest = buildProgressiveFitRequest(excludedLease);
    expect(excludedRequest.observations[0]).toMatchObject({
      eligible: false,
      coefficients: null,
      exclusion_reason: "review_exclude",
    });
    const excludedResponse = await fitUsingPython(excludedRequest);
    expect(excludedResponse.estimate.best_method).toBe("neuralfoil");
    await expect(
      storeProgressivePolarFit(
        db,
        excludedLease,
        {
          ...excludedRequest,
          observations: request.observations,
        },
        excludedResponse,
      ),
    ).rejects.toThrow("eligibility");
    await db.execute(
      sql`UPDATE result_review_verdicts SET note = 'A note is not a changed verdict' WHERE id = ${review.id}`,
    );
    await storeProgressivePolarFit(
      db,
      excludedLease,
      excludedRequest,
      excludedResponse,
    );
    expect(await fixture.acquire()).toBeNull();
    await db.execute(
      sql`UPDATE result_review_verdicts SET "revokedAt" = clock_timestamp() WHERE id = ${review.id}`,
    );
    const restored = (await fixture.acquire())!;
    expect(restored.source.evidence[0].review).toBeNull();
    expect(buildProgressiveFitRequest(restored).observations[0].eligible).toBe(
      true,
    );
  }, 120_000);

  it("invalidates changed classification meaning, not refresh timestamps", async () => {
    const fixture = await fitFixture();
    const evidence = await fixture.save(60);
    await fixture.record([evidence]);
    const oldLease = (await fixture.acquire())!;
    const [classification] = await db.execute(sql`
      INSERT INTO result_classifications(result_attempt_id, airfoil_id, simulation_preset_revision_id,
        aoa_deg, classifier_version, state, reasons)
      SELECT id, airfoil_id, simulation_preset_revision_id, aoa_deg, 'isolated-progressive-test', 'needs_urans', '{}'
      FROM result_attempts WHERE id = ${evidence} RETURNING id
    `);
    expect(
      await failProgressivePolarFit(db, oldLease, "stale classification"),
    ).toBe(false);
    const lease = (await fixture.acquire())!;
    expect(lease.source.evidence[0].classification?.state).toBe("needs_urans");
    const request = buildProgressiveFitRequest(lease);
    const response = await fitUsingPython(request);
    await db.execute(
      sql`UPDATE result_classifications SET "updatedAt" = clock_timestamp() WHERE id = ${classification.id}`,
    );
    await storeProgressivePolarFit(db, lease, request, response);
    expect(await fixture.acquire()).toBeNull();
    await db.execute(
      sql`UPDATE result_classifications SET state = 'superseded_by_urans' WHERE id = ${classification.id}`,
    );
    const superseded = (await fixture.acquire())!;
    expect(
      buildProgressiveFitRequest(superseded).observations[0].exclusion_reason,
    ).toBe("superseded_by_urans");
    await db.execute(
      sql`DELETE FROM result_classifications WHERE id = ${classification.id}`,
    );
    expect(
      await failProgressivePolarFit(db, superseded, "deleted classification"),
    ).toBe(false);
    expect(
      (await fixture.acquire())!.source.evidence[0].classification,
    ).toBeNull();
  }, 120_000);

  it("publishes a real fitted curve, retains its prior and exposes exact contributor ids without minting solved points", async () => {
    const fixture = await fitFixture();
    const evidence = await fixture.save(40);
    await db
      .update(resultAttempts)
      .set({
        evidencePayload: {
          solver_active_seconds: 40,
          cl: 0.12,
          cd: 0.025,
          cm: -0.035,
          converged: true,
        },
      })
      .where(eq(resultAttempts.id, evidence));
    await fixture.record([evidence]);
    const lease = (await fixture.acquire())!;
    const request = fittingRequest(lease);
    const response = await fitUsingPython(request);
    const id = await storeProgressivePolarFit(db, lease, request, response);
    expect(await storeProgressivePolarFit(db, lease, request, response)).toBe(
      id,
    );
    const curves = await publicProgressivePolars(
      db,
      originalId,
      fixture.leases[0].revisionId,
    );
    const curve = curves.find((row) => row.targetId === lease.source.targetId)!;
    expect(curve.kind).toBe("estimate");
    expect(curve.conditionKey).toBe(
      progressiveComparisonConditionKey(lease.source.physical),
    );
    expect(curve.curves.map((row) => row.method).sort()).toEqual([
      "composite",
      "neuralfoil",
      "openfoam_fast",
    ]);
    expect(curve.explanation.contributors?.[0].attemptId).toBe(evidence);
    expect(curve.explanation.contributors?.[0].alpha).toBe(
      lease.source.evidence[0].alpha,
    );
    const baseline = curve.curves.find((row) => row.method === "neuralfoil")!;
    const combined = curve.curves.find((row) => row.method === "composite")!;
    expect(combined.metrics?.liftMaximum).toBe(
      Math.max(...combined.samples.map((sample) => sample.cl)),
    );
    expect(combined.metrics?.liftMaximum).toBeGreaterThan(
      baseline.metrics!.liftMaximum,
    );
    expect(combined.metrics?.alphaMinimum).toBe(combined.samples[0].alpha);
    expect(combined.metrics?.alphaMaximum).toBe(combined.samples.at(-1)!.alpha);
    expect(
      combined.samples.every(
        (row, index) => row.cl > baseline.samples[index].cl,
      ),
    ).toBe(true);
    expect(combined.samples.every((row) => row.lower!.cd > 0)).toBe(true);
    const cells = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, fixture.composed.jobId));
    expect(
      cells.every(
        (row) => row.currentResultAttemptId === null && row.status === "queued",
      ),
    ).toBe(true);
    await expect(
      db.execute(
        sql`UPDATE progressive_polar_models SET source_signature = ${"0".repeat(64)} WHERE id = ${id}`,
      ),
    ).rejects.toThrow("immutable");
    await fixture.record([evidence]);
    expect(await fixture.acquire()).toBeNull();
  }, 120_000);

  it("invalidates an in-flight fit when new CFD arrives and records excluded attempts without fabricated coefficients", async () => {
    const fixture = await fitFixture();
    const oldLease = (await fixture.acquire())!;
    const oldRequest = fittingRequest(oldLease);
    const oldResponse = await fitUsingPython(oldRequest);
    await fixture.record([await fixture.save(50)]);
    await expect(
      storeProgressivePolarFit(db, oldLease, oldRequest, oldResponse),
    ).rejects.toThrow("Obsolete or expired");
    const lease = (await fixture.acquire())!;
    const request = fittingRequest(lease);
    expect(request.observations[0].coefficients).toBeNull();
    const response = await fitUsingPython(request);
    await storeProgressivePolarFit(db, lease, request, response);
    expect(response.estimate.contributors).toEqual([]);
    expect(response.estimate.excluded).toHaveLength(1);
    const [work] = await db.execute(
      sql`SELECT state, model_id FROM progressive_polar_fit_work WHERE prediction_id = ${fixture.predictionId}`,
    );
    expect(work.state).toBe("ready");
    expect(work.model_id).toBeTruthy();
  }, 120_000);

  it("invalidates selected models on receipt removal and does not suppress deletion of raw attempts", async () => {
    const fixture = await fitFixture();
    const evidence = await fixture.save(20);
    await fixture.record([evidence]);
    const lease = (await fixture.acquire())!;
    const request = fittingRequest(lease);
    await storeProgressivePolarFit(
      db,
      lease,
      request,
      await fitUsingPython(request),
    );
    await db.delete(resultAttempts).where(eq(resultAttempts.id, evidence));
    expect(
      await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.id, evidence)),
    ).toEqual([]);
    const [work] = await db.execute(
      sql`SELECT state, model_id FROM progressive_polar_fit_work WHERE prediction_id = ${fixture.predictionId}`,
    );
    expect(work).toMatchObject({ state: "pending", model_id: null });
    const refreshed = (await fixture.acquire())!;
    expect(refreshed.source.evidence).toEqual([]);
  }, 120_000);

  it("rejects changed prior coefficients, response ownership and invented fidelity", async () => {
    const fixture = await fitFixture();
    const lease = (await fixture.acquire())!;
    const request = fittingRequest(lease);
    const response = await fitUsingPython(request);
    const changed = structuredClone(request);
    changed.prior.coefficients[0][0] += 1;
    await expect(
      storeProgressivePolarFit(db, lease, changed, response),
    ).rejects.toThrow("stored NeuralFoil");
    await expect(
      storeProgressivePolarFit(db, lease, request, {
        ...response,
        epoch_id: randomUUID(),
      }),
    ).rejects.toThrow("exact request");
    await expect(
      storeProgressivePolarFit(db, lease, request, {
        ...response,
        estimate: { ...response.estimate, best_method: "openfoam_precise" },
      }),
    ).rejects.toThrow("contributing methods");
    await rotateCalculationEpoch(db, "isolated fit epoch reset");
    await expect(
      storeProgressivePolarFit(db, lease, request, response),
    ).rejects.toThrow("Obsolete fitted polar calculation epoch");
  }, 120_000);

  it("caps fit retries and prevents a stale worker from failing its replacement", async () => {
    const fixture = await fitFixture();
    const oldLease = (await fixture.acquire())!;
    await db.execute(
      sql`UPDATE progressive_polar_fit_work SET lease_until = clock_timestamp() - interval '1 second' WHERE prediction_id = ${fixture.predictionId}`,
    );
    const replacement = (await fixture.acquire())!;
    expect(await failProgressivePolarFit(db, oldLease, "late response")).toBe(
      false,
    );
    expect(
      await failProgressivePolarFit(db, replacement, "temporary fit failure"),
    ).toBe(true);
    const third = (await fixture.acquire())!;
    expect(await failProgressivePolarFit(db, third, "third fit failure")).toBe(
      true,
    );
    expect(await fixture.acquire()).toBeNull();
    const [work] = await db.execute(
      sql`SELECT state, attempts FROM progressive_polar_fit_work WHERE prediction_id = ${fixture.predictionId}`,
    );
    expect(work).toMatchObject({ state: "gap", attempts: 3 });
  });

  it("quarantines a mismatched source receipt without repeatedly claiming it", async () => {
    const fixture = await fitFixture();
    const evidence = await fixture.save(60);
    await fixture.record([evidence]);
    await db
      .update(resultAttempts)
      .set({ evidencePayload: { solver_active_seconds: 61 } })
      .where(eq(resultAttempts.id, evidence));
    expect(await fixture.acquire()).toBeNull();
    const [work] = await db.execute(
      sql`SELECT state, error FROM progressive_polar_fit_work WHERE prediction_id = ${fixture.predictionId}`,
    );
    expect(work).toMatchObject({
      state: "gap",
      error: expect.stringContaining("immutable evidence receipt"),
    });
    expect(await fixture.acquire()).toBeNull();
  });

  it("fits exact stored unsteady samples without duplicating raw histories in the model cache", async () => {
    const fixture = await fitFixture();
    const evidence = await fixture.save(60);
    const coordinate = Array.from({ length: 161 }, (_, index) => index / 20);
    const forceHistory = {
      t: coordinate,
      cl: coordinate.map((time) => 0.2 + 0.04 * Math.sin(2 * Math.PI * time)),
      cd: coordinate.map(
        (time) => 0.025 + 0.002 * Math.cos(2 * Math.PI * time),
      ),
      cm: coordinate.map(
        (time) => -0.03 + 0.001 * Math.sin(2 * Math.PI * time),
      ),
    };
    await db
      .update(resultAttempts)
      .set({
        evidencePayload: {
          solver_active_seconds: 60,
          unsteady: true,
          converged: false,
          force_history: forceHistory,
        },
      })
      .where(eq(resultAttempts.id, evidence));
    await fixture.record([evidence]);
    const lease = (await fixture.acquire())!;
    const request = fittingRequest(lease);
    const observation = {
      ...request.observations[0],
      eligible: true,
      exclusion_reason: null,
      statistical_certification: "informative_uncertified",
    };
    request.observations = [];
    request.histories = [
      {
        observation,
        artifact_sha256: analysisContentHash(forceHistory),
        coordinate_kind: "physical_time",
        coordinate,
        coefficients: coordinate.map((_, index) => [
          forceHistory.cl[index],
          forceHistory.cd[index],
          forceHistory.cm[index],
        ]),
        informative_start: 2,
        correlation_time: null,
        correlation_evidence_id: null,
      },
    ];
    request.history_policy = {
      block_duration: 2,
      minimum_samples: 4,
      noise_floor: [0.01, 0.001, 0.002],
    };
    const response = await fitUsingPython(request);
    expect(response.estimate.contributors).toHaveLength(3);
    const changed = structuredClone(request);
    changed.histories[0].coefficients[0][0] += 1;
    await expect(
      storeProgressivePolarFit(db, lease, changed, response),
    ).rejects.toThrow("immutable source");
    await expect(
      storeProgressivePolarFit(
        db,
        lease,
        { ...request, histories: [] },
        response,
      ),
    ).rejects.toThrow("every source attempt");
    const id = await storeProgressivePolarFit(db, lease, request, response);
    const [stored] = await db.execute(
      sql`SELECT request FROM progressive_polar_models WHERE id = ${id}`,
    );
    const manifest = stored.request as {
      kind: string;
      histories: Array<Record<string, unknown>>;
    };
    expect(manifest.kind).toBe("progressive-fit-replay-manifest-v1");
    expect(manifest.histories[0].sample_count).toBe(161);
    expect(manifest.histories[0]).not.toHaveProperty("coordinate");
    expect(manifest.histories[0]).not.toHaveProperty("coefficients");
  }, 120_000);
});

describe("progressive CFD evidence accounting", () => {
  it("conserves rejected evidence and charges cumulative observations only once without completing work", async () => {
    const fixture = await cfdEvidenceFixture();
    const first = await fixture.save(50);
    expect(await fixture.record([first, first])).toEqual({
      progressive: true,
      linked: 1,
      stopRequired: false,
    });
    expect(await fixture.record([first])).toEqual({
      progressive: true,
      linked: 0,
      stopRequired: false,
    });
    await heartbeatProgressiveCfdUnit(db, fixture.leases[0], {
      attemptActiveSeconds: 75,
      leaseSeconds: 120,
    });
    await fixture.record([first]);
    const second = await fixture.save(90, "urans");
    expect(await fixture.record([second, first])).toMatchObject({
      linked: 1,
      stopRequired: false,
    });
    const [unit] = await db.execute(
      sql`SELECT state, active_seconds FROM progressive_cfd_units WHERE id = ${fixture.leases[0].id}`,
    );
    expect(unit).toMatchObject({ state: "leased", active_seconds: 90 });
    const saved = await db
      .select()
      .from(resultAttempts)
      .where(inArray(resultAttempts.id, [first, second]));
    expect(saved).toHaveLength(2);
    expect(saved.every((row) => !row.validForPolar && row.cl === null)).toBe(
      true,
    );
    const publicCells = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, fixture.composed.jobId));
    expect(
      publicCells.every(
        (row) => row.currentResultAttemptId === null && row.status === "queued",
      ),
    ).toBe(true);
    await expect(
      db.execute(
        sql`UPDATE progressive_cfd_evidence SET solver_active_seconds = 1 WHERE result_attempt_id = ${first}`,
      ),
    ).rejects.toThrow("immutable");
  });

  it("requires exact engine identity, numerical scope and real measured time", async () => {
    const fixture = await cfdEvidenceFixture();
    await expect(
      assertProgressiveCfdEvidenceJob(
        db,
        fixture.composed.jobId,
        "another-engine-job",
      ),
    ).rejects.toThrow("ownership");
    const invalid = await fixture.save("50");
    await expect(fixture.record([invalid])).rejects.toThrow(
      "measured cumulative",
    );
    await expect(fixture.record([randomUUID()])).rejects.toThrow(
      "exact stored job evidence",
    );
    const wrongAngle = await fixture.save(55, "urans", 99);
    await expect(fixture.record([wrongAngle])).rejects.toThrow(
      "immutable physical/numerical scope",
    );
    await expect(
      assertProgressiveCfdEvidenceJob(
        db,
        fixture.composed.jobId,
        fixture.engineJobId,
        [
          {
            alpha: fixture.leases[0].alpha,
            speed: 999,
            chord: 1,
            solverActiveSeconds: 1,
          },
        ],
      ),
    ).rejects.toThrow("physical scope");
    const [count] = await db.execute(
      sql`SELECT count(*)::integer AS count FROM progressive_cfd_evidence WHERE attempt_token = ${fixture.leases[0].token}`,
    );
    expect(count.count).toBe(0);
  });

  it("rolls back a batch containing evidence from outside the exact job", async () => {
    const fixture = await cfdEvidenceFixture();
    const first = await fixture.save(50);
    await expect(fixture.record([first, randomUUID()])).rejects.toThrow(
      "exact stored job evidence",
    );
    const [unit] = await db.execute(
      sql`SELECT active_seconds FROM progressive_cfd_units WHERE id = ${fixture.leases[0].id}`,
    );
    expect(unit.active_seconds).toBe(0);
  });

  it("rejects an attempt attached to a different physical cell within the same job", async () => {
    const fixture = await cfdEvidenceFixture();
    const evidence = await fixture.save(50);
    const [otherCell] = await db
      .select({ id: results.id })
      .from(results)
      .where(
        and(
          eq(results.simJobId, fixture.composed.jobId),
          eq(results.aoaDeg, fixture.leases[1].alpha),
        ),
      );
    await db
      .update(resultAttempts)
      .set({ resultId: otherCell.id })
      .where(eq(resultAttempts.id, evidence));
    await expect(fixture.record([evidence])).rejects.toThrow(
      "immutable physical/numerical scope",
    );
    const [unit] = await db.execute(
      sql`SELECT active_seconds FROM progressive_cfd_units WHERE id = ${fixture.leases[0].id}`,
    );
    expect(unit.active_seconds).toBe(0);
  });

  it("accepts real late delivery during a pause but does not reclaim an expired execution", async () => {
    const fixture = await cfdEvidenceFixture();
    await db
      .update(simCampaigns)
      .set({ status: "paused" })
      .where(eq(simCampaigns.id, fixture.campaignId));
    await db.execute(
      sql`UPDATE progressive_cfd_units SET lease_until = clock_timestamp() - interval '1 second' WHERE id = ${fixture.leases[0].id}`,
    );
    expect(await fixture.record([await fixture.save(60)])).toMatchObject({
      linked: 1,
    });
    expect(await claimCfd()).toBeNull();
    const [campaignRow] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, fixture.campaignId));
    expect(campaignRow.status).toBe("paused");
  });

  it("blocks at measured exhaustion and requires execution stop acknowledgement", async () => {
    const fixture = await cfdEvidenceFixture();
    const evidence = await fixture.save(905);
    expect(await fixture.record([evidence])).toMatchObject({
      linked: 1,
      stopRequired: true,
    });
    expect(await fixture.record([evidence])).toMatchObject({
      linked: 0,
      stopRequired: true,
    });
    expect(await fixture.record([])).toMatchObject({
      linked: 0,
      stopRequired: true,
    });
    const [unit] = await db.execute(
      sql`SELECT state, active_seconds, lease_token FROM progressive_cfd_units WHERE id = ${fixture.leases[0].id}`,
    );
    expect(unit).toMatchObject({
      state: "blocked",
      active_seconds: 905,
      lease_token: null,
    });
    const [attempt] = await db.execute(
      sql`SELECT outcome FROM progressive_cfd_attempts WHERE token = ${fixture.leases[0].token}`,
    );
    expect(attempt.outcome).toBe("running");
  });

  it.each(["cancelled", "archived"] as const)(
    "rejects delivery after campaign %s",
    async (status) => {
      const fixture = await cfdEvidenceFixture();
      const evidence = await fixture.save(10);
      await db
        .update(simCampaigns)
        .set({ status })
        .where(eq(simCampaigns.id, fixture.campaignId));
      await expect(fixture.record([evidence])).rejects.toThrow(
        "no longer accepts",
      );
    },
  );

  it("rejects obsolete calculation epochs", async () => {
    const fixture = await cfdEvidenceFixture();
    const evidence = await fixture.save(10);
    await rotateCalculationEpoch(db, "isolated CFD receipt reset");
    await expect(fixture.record([evidence])).rejects.toThrow(
      "Obsolete CFD calculation epoch",
    );
  });
});

describe("durable progressive CFD units", () => {
  it("keeps prior-generation stop safety scoped to the exact target and execution", async () => {
    const fixture = await cfdEvidenceFixture();
    const originalLease = fixture.leases[0];
    const [stored] = await db.execute(sql`
      SELECT target.airfoil_id, scope.revision_id, scope.angles, scope.recipes, target.physical,
        generation.plan_revision_id
      FROM progressive_generation_targets scope
      JOIN progressive_generations generation ON generation.id = scope.generation_id
      JOIN polar_analysis_targets target ON target.id = scope.target_id
      WHERE scope.generation_id = ${originalLease.generationId} AND scope.target_id = ${originalLease.targetId}
    `);
    const added = await newProfile();
    await reconcileCampaignProfileEnrollment(db);
    const original: SealedPolarTarget = {
      airfoilId: String(stored.airfoil_id),
      targetId: originalLease.targetId,
      revisionId: String(stored.revision_id),
      physical: stored.physical as SealedPolarTarget["physical"],
      angles: stored.angles as number[],
      recipes: stored.recipes as SealedPolarTarget["recipes"],
    };
    const otherPhysical = { ...original.physical, airfoilId: added };
    const otherTarget = analysisContentHash(otherPhysical);
    const generation = await sealProgressiveGeneration(db, {
      campaignId: fixture.campaignId,
      planRevisionId: String(stored.plan_revision_id),
      scopeKey: "prior-execution-safety",
      targets: [
        original,
        {
          ...original,
          airfoilId: added,
          physical: otherPhysical,
          targetId: otherTarget,
        },
      ],
    });
    for (let index = 0; index < 2; index += 1) {
      const baseline = (await claim([1]))!;
      expect(baseline.generationId).toBe(generation.id);
      await storeNeuralFoilPrediction(
        db,
        baseline,
        predictionFixture(baseline),
      );
    }
    await initializeProgressiveCfdWork(db);
    const unrelated = await claimProgressiveCfdBatch(db, {
      owner: "unrelated-target",
      leaseSeconds: 120,
    });
    expect(unrelated.length).toBeGreaterThan(0);
    expect(unrelated.every((lease) => lease.targetId === otherTarget)).toBe(
      true,
    );
    expect(await claimCfd()).toBeNull();
    await acknowledgeProgressiveCfdExecutionStop(db, {
      simJobId: fixture.composed.jobId,
      proof: executionStopProof(fixture.engineJobId),
    });
    await db
      .update(simJobs)
      .set({ engineJobId: randomUUID() })
      .where(eq(simJobs.id, fixture.composed.jobId));
    expect(await claimCfd()).toBeNull();
    await db
      .update(simJobs)
      .set({ engineJobId: fixture.engineJobId })
      .where(eq(simJobs.id, fixture.composed.jobId));
    const released = await claimCfd();
    expect(released).toMatchObject({
      generationId: generation.id,
      targetId: originalLease.targetId,
    });
    expect((await claimCfd())?.generationId).toBe(generation.id);
  });

  it.each(["rans", "urans"] as const)(
    "reclaims only its stopped failed %s cell for an authorized retry",
    async (regime) => {
      const fixture = await cfdEvidenceFixture(32.173, 3);
      const originalLease = fixture.leases[0];
      const evidenceId = await fixture.save(25, regime, originalLease.alpha, {
        failure_disposition: "infrastructure",
      });
      await fixture.record([evidenceId]);
      const [evidence] = await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.id, evidenceId));
      await db
        .update(results)
        .set({ status: "failed", regime })
        .where(eq(results.id, evidence.resultId!));
      await db
        .update(simJobs)
        .set({ status: "done", ingestedAt: new Date() })
        .where(eq(simJobs.id, fixture.composed.jobId));
      await acknowledgeProgressiveCfdExecutionStop(db, {
        simJobId: fixture.composed.jobId,
        proof: executionStopProof(fixture.engineJobId),
      });
      expect(
        (await settleProgressiveCfdExecution(db, fixture.composed.jobId)).retry,
      ).toBe(1);
      const retry = await claimProgressiveCfdBatch(db, {
        owner: "owned-retry-fixture",
        leaseSeconds: 120,
        solverBudgetVersion: 2,
      });
      expect(retry).toHaveLength(1);
      expect(retry[0].id).toBe(originalLease.id);
      const [pool] = await db
        .select()
        .from(solverExecutionPools)
        .where(
          eq(
            solverExecutionPools.solverImplementationId,
            fixture.execution.revision.solverImplementationId,
          ),
        )
        .limit(1);
      await db
        .update(sweeperState)
        .set({ enabled: true })
        .where(eq(sweeperState.id, 1));
      await db
        .update(solverExecutionPools)
        .set({ enabled: true })
        .where(eq(solverExecutionPools.id, pool.id));
      const options = {
        cpuSlots: 1,
        meshRecoveryVersion: 1,
        solverBudgetVersion: 2,
      };
      try {
        for (const guard of ["no-stop", "completed-cell"] as const) {
          await expect(
            db.transaction(async (transaction) => {
              if (guard === "no-stop")
                await transaction.execute(sql`
            DELETE FROM progressive_cfd_execution_stops WHERE sim_job_id = ${fixture.composed.jobId}
          `);
              else
                await transaction
                  .update(results)
                  .set({ status: "done" })
                  .where(eq(results.id, evidence.resultId!));
              await composeProgressiveCfdJob(
                transaction as unknown as DB,
                retry,
                options,
              );
            }),
          ).rejects.toThrow("another execution owner");
        }
        const retried = await composeProgressiveCfdJob(db, retry, options);
        expect(retried.jobId).not.toBe(fixture.composed.jobId);
        const [cell] = await db
          .select()
          .from(results)
          .where(eq(results.id, evidence.resultId!));
        expect(cell).toMatchObject({
          simJobId: retried.jobId,
          status: "queued",
        });
        const [preserved] = await db
          .select()
          .from(resultAttempts)
          .where(eq(resultAttempts.id, evidenceId));
        expect(preserved).toEqual(evidence);
      } finally {
        await db
          .update(sweeperState)
          .set({ enabled: false })
          .where(eq(sweeperState.id, 1));
        await db
          .update(solverExecutionPools)
          .set({ enabled: pool.enabled })
          .where(eq(solverExecutionPools.id, pool.id));
      }
    },
  );

  it("matches comparison conditions across geometries without merging different physical inputs", async () => {
    const campaignId = await campaign();
    const scope = await progressiveScope(campaignId);
    const physical = scope.targets[0].physical;
    const key = progressiveComparisonConditionKey(physical);
    expect(
      progressiveComparisonConditionKey({
        ...physical,
        airfoilId: randomUUID(),
        geometry: physical.geometry.map(([coordinateX, coordinateY]) => [
          coordinateX,
          coordinateY * 1.1,
        ]),
      }),
    ).toBe(key);
    for (const changed of [
      {
        ...physical,
        flow: {
          ...physical.flow,
          temperatureK: physical.flow.temperatureK + 0.001,
        },
      },
      {
        ...physical,
        reference: {
          ...physical.reference,
          referenceLengthM: physical.reference.referenceLengthM + 0.001,
        },
      },
      {
        ...physical,
        boundary: {
          ...physical.boundary,
          turbulenceIntensity: physical.boundary.turbulenceIntensity + 0.001,
        },
      },
      {
        ...physical,
        transition: {
          ...physical.transition,
          nCrit: physical.transition.nCrit + 0.001,
        },
      },
      {
        ...physical,
        derived: {
          ...physical.derived,
          reynolds: physical.derived.reynolds + 0.001,
        },
      },
      { ...physical, branch: "decreasing" as const },
    ])
      expect(progressiveComparisonConditionKey(changed)).not.toBe(key);
  });

  it("separates retry budgets without shortening a fresh sibling allocation", async () => {
    await fastCfdGeneration();
    await initializeProgressiveCfdWork(db);
    const previous = (await claimCfd())!;
    await heartbeatProgressiveCfdUnit(db, previous, {
      attemptActiveSeconds: 120,
      leaseSeconds: 60,
    });
    await db.execute(sql`
      UPDATE progressive_cfd_attempts SET outcome = 'failed', finished_at = clock_timestamp()
      WHERE token = ${previous.token}
    `);
    await db.execute(sql`
      UPDATE progressive_cfd_units SET state = 'pending', lease_token = NULL, lease_owner = NULL, lease_until = NULL
      WHERE id = ${previous.id}
    `);
    const retried = await claimProgressiveCfdBatch(db, {
      owner: "retry-budget-fixture",
      leaseSeconds: 120,
    });
    const fresh = await claimProgressiveCfdBatch(db, {
      owner: "fresh-budget-fixture",
      leaseSeconds: 120,
    });
    expect(retried).toHaveLength(1);
    expect(fresh).toHaveLength(1);
    expect(retried[0]).toMatchObject({
      id: previous.id,
      remainingActiveSeconds: 780,
    });
    expect(fresh[0].remainingActiveSeconds).toBe(900);
    expect(fresh[0].targetId).toBe(previous.targetId);
    await expect(
      materializeProgressiveCfdExecution(db, {
        ...retried[0],
        remainingActiveSeconds: 900,
      }),
    ).rejects.toThrow("remaining allocation");
    await expect(
      composeProgressiveCfdJob(db, [...retried, ...fresh], {
        solverBudgetVersion: 1,
        cpuSlots: 1,
        meshRecoveryVersion: 1,
      }),
    ).rejects.toThrow("known solver-budget capability");
    const attempts = await db.execute(sql`
      SELECT attempts FROM progressive_cfd_units WHERE id IN (${retried[0].id}, ${fresh[0].id}) ORDER BY attempts
    `);
    expect(attempts.map((unit) => unit.attempts)).toEqual([1, 2]);
  });

  it("composes high-Mach fast local-time work as immutable RANS rather than URANS", async () => {
    const id = await campaign("active", [900], [-2, 0, 2, 4]);
    await materializeProgressiveCampaignScope(db, id);
    const baseline = (await claim([1]))!;
    await storeNeuralFoilPrediction(db, baseline, predictionFixture(baseline));
    await initializeProgressiveCfdWork(db);
    const leases = await claimProgressiveCfdBatch(db, {
      owner: "local-density-fixture",
      leaseSeconds: 120,
    });
    expect(leases).toHaveLength(2);
    expect(leases[0].recipe).toMatchObject({
      timeCoordinate: "local_pseudo_time_iterations",
      selection: { solver: "rhoCentralFoam" },
    });
    const execution = await materializeProgressiveCfdExecution(db, leases[0]);
    expect(execution.snapshot.solver.timeCoordinate).toBe(
      "local_pseudo_time_iterations",
    );
    const [pool] = await db
      .select()
      .from(solverExecutionPools)
      .where(
        eq(
          solverExecutionPools.solverImplementationId,
          execution.revision.solverImplementationId!,
        ),
      );
    expect(pool).toBeTruthy();
    const [previous] = await db
      .select()
      .from(sweeperState)
      .where(eq(sweeperState.id, 1));
    try {
      await db
        .update(solverExecutionPools)
        .set({ enabled: true })
        .where(eq(solverExecutionPools.id, pool.id));
      await db
        .insert(sweeperState)
        .values({ id: 1, enabled: true })
        .onConflictDoUpdate({
          target: sweeperState.id,
          set: { enabled: true },
        });
      const composed = await composeProgressiveCfdJob(db, leases, {
        solverBudgetVersion: 2,
        cpuSlots: 1,
        meshRecoveryVersion: 2,
      });
      expect(composed.request.solver).toMatchObject({
        flow_solver_family: "rhoCentralFoam",
        force_transient: false,
        transient_fallback: false,
        momentum_scheme: "upwind",
        n_iterations: 5000,
      });
      const [job] = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.id, composed.jobId));
      expect(job).toMatchObject({
        wave: 1,
        methodKey: "openfoam.rans",
        simulationPresetRevisionId: execution.revision.id,
      });
      expect(composed.request.resources?.case_solver_budget_seconds).toBe(900);
      expect(execution.snapshot.mesh.targetYPlus).toBe(40);
    } finally {
      await db
        .update(solverExecutionPools)
        .set({ enabled: pool.enabled })
        .where(eq(solverExecutionPools.id, pool.id));
      await db
        .update(sweeperState)
        .set({ enabled: previous?.enabled ?? false })
        .where(eq(sweeperState.id, 1));
    }
  }, 120_000);

  it("pins a shared execution revision and composes every batch angle with atomic ownership", async () => {
    const id = await campaign();
    const generation = await materializeProgressiveCampaignScope(db, id);
    const baseline = (await claim([1]))!;
    await storeNeuralFoilPrediction(db, baseline, predictionFixture(baseline));
    await initializeProgressiveCfdWork(db);
    const leases = await claimProgressiveCfdBatch(db, {
      owner: "execution-fixture",
      leaseSeconds: 120,
    });
    expect(leases).toHaveLength(2);
    expect(new Set(leases.map((lease) => lease.generationId))).toEqual(
      new Set([generation!.id]),
    );
    const original = await db.execute(
      sql`SELECT snapshot FROM simulation_preset_revisions WHERE id = ${leases[0].revisionId}`,
    );
    const execution = await materializeProgressiveCfdExecution(db, leases[0]);
    expect(execution.revision.id).not.toBe(leases[0].revisionId);
    expect(execution.snapshot.flowState).toEqual(
      (original[0].snapshot as SimulationSetupSnapshot).flowState,
    );
    expect(execution.snapshot.material).toEqual(
      (original[0].snapshot as SimulationSetupSnapshot).material,
    );
    expect(execution.snapshot.solver.flowSolverFamily).toBe("rhoSimpleFoam");
    expect(execution.snapshot.mesh.nSurface).toBeLessThanOrEqual(
      (original[0].snapshot as SimulationSetupSnapshot).mesh.nSurface,
    );
    expect(
      (await materializeProgressiveCfdExecution(db, leases[1])).revision.id,
    ).toBe(execution.revision.id);
    await expect(
      materializeProgressiveCfdExecution(db, {
        ...leases[0],
        recipe: { ...leases[0].recipe, altered: true },
      }),
    ).rejects.toThrow("sealed scope");
    await db
      .insert(sweeperState)
      .values({ id: 1, enabled: true })
      .onConflictDoUpdate({ target: sweeperState.id, set: { enabled: true } });
    const [pool] = await db
      .select()
      .from(solverExecutionPools)
      .where(
        eq(
          solverExecutionPools.solverImplementationId,
          execution.revision.solverImplementationId,
        ),
      )
      .limit(1);
    expect(pool).toBeTruthy();
    await expect(
      composeProgressiveCfdJob(db, leases, {
        solverBudgetVersion: 2,
        cpuSlots: 1,
        meshRecoveryVersion: 1,
      }),
    ).rejects.toThrow("no enabled execution pool");
    await db
      .update(solverExecutionPools)
      .set({ enabled: true })
      .where(eq(solverExecutionPools.id, pool.id));
    try {
      const composed = await composeProgressiveCfdJob(db, leases, {
        solverBudgetVersion: 2,
        cpuSlots: 1,
        meshRecoveryVersion: 1,
      });
      expect(composed.request.execution_id).toBe(composed.jobId);
      const [registration] = await db.execute(sql`
        SELECT engine_job_id, status, request_payload->'progressive'->>'executionId' AS planned_execution_id
        FROM sim_jobs WHERE id = ${composed.jobId}
      `);
      expect(registration).toMatchObject({
        engine_job_id: null,
        status: "pending",
        planned_execution_id: composed.jobId,
      });
      expect(composed.request.aoa.angles).toEqual(
        leases.map((lease) => lease.alpha),
      );
      expect(composed.request.solver).toMatchObject({
        warm_start: true,
        flow_solver_family: "rhoSimpleFoam",
      });
      expect(composed.request.fluid?.gas?.provenance).toContain(
        "Model approximation",
      );
      expect(composed.request.flow_state).toEqual({
        temperature_k: 288.15,
        pressure_pa: 101325,
      });
      const replay = await composeProgressiveCfdJob(db, leases, {
        solverBudgetVersion: 2,
        cpuSlots: 1,
        meshRecoveryVersion: 1,
      });
      expect(replay).toEqual({ ...composed, replayed: true });
      const cells = await db.execute(
        sql`SELECT aoa_deg, status, cl, cd, cm, sim_job_id FROM results WHERE sim_job_id = ${composed.jobId} ORDER BY aoa_deg`,
      );
      expect(cells).toHaveLength(2);
      expect(cells.map((cell) => cell.aoa_deg)).toEqual(
        leases.map((lease) => lease.alpha),
      );
      for (const cell of cells)
        expect(cell).toMatchObject({
          status: "queued",
          cl: null,
          cd: null,
          cm: null,
          sim_job_id: composed.jobId,
        });
      const attempts = await db.execute(
        sql`SELECT sim_job_id, execution_recipe_id FROM progressive_cfd_attempts WHERE sim_job_id = ${composed.jobId}`,
      );
      expect(attempts).toHaveLength(2);
      expect(
        attempts.every(
          (attempt) => attempt.execution_recipe_id === execution.recipeId,
        ),
      ).toBe(true);
      const engine = new EngineClient("http://unused.invalid");
      const submit = vi
        .spyOn(engine, "submitPolar")
        .mockRejectedValue(
          new Error("must not submit an unvalidated execution contract"),
        );
      await db.execute(
        sql`UPDATE sim_jobs SET request_payload = request_payload #- '{progressive,executionContract}' WHERE id = ${composed.jobId}`,
      );
      try {
        await submitPendingJobWithLifecycleGuard({
          db,
          engine,
          jobId: composed.jobId,
          campaignId: id,
          request: composed.request,
          connectionErrorPrefix: "connection",
          submitErrorPrefix: "submit",
        });
        expect(submit).not.toHaveBeenCalled();
        const [legacy] = await db
          .insert(simJobs)
          .values({
            airfoilId: originalId,
            bcIds: [execution.snapshot.preset.legacyBoundaryConditionId!],
            simulationPresetRevisionId: execution.revision.id,
            solverImplementationId: execution.revision.solverImplementationId,
            solverExecutionPoolId: pool.id,
            campaignId: id,
            referenceChordM:
              execution.snapshot.referenceGeometry.referenceLengthM,
            wave: 1,
            status: "pending",
            totalCases: 1,
            admissionCpuSlots: 1,
            requestPayload: null,
          })
          .returning();
        await claimAoas(
          db,
          originalId,
          execution.snapshot.preset.legacyBoundaryConditionId!,
          execution.revision.id,
          [12],
          legacy.id,
        );
        await submitPendingJobWithLifecycleGuard({
          db,
          engine,
          jobId: legacy.id,
          campaignId: id,
          request: { ...composed.request, aoa: { angles: [12] } },
          connectionErrorPrefix: "connection",
          submitErrorPrefix: "submit",
        });
        expect(submit).not.toHaveBeenCalled();
        const [blockedLegacy] = await db
          .select()
          .from(simJobs)
          .where(eq(simJobs.id, legacy.id));
        expect(blockedLegacy.status).toBe("cancelled");
      } finally {
        submit.mockRestore();
      }
    } finally {
      await db
        .update(solverExecutionPools)
        .set({ enabled: pool.enabled })
        .where(eq(solverExecutionPools.id, pool.id));
      await db
        .update(sweeperState)
        .set({ enabled: false })
        .where(eq(sweeperState.id, 1));
    }
  });

  it("uses frozen physical values even if a reusable medium changes before the execution revision is created", async () => {
    const id = await campaign();
    await materializeProgressiveCampaignScope(db, id);
    const baseline = (await claim([1]))!;
    await storeNeuralFoilPrediction(db, baseline, predictionFixture(baseline));
    await initializeProgressiveCfdWork(db);
    const lease = (await claimCfd())!;
    await db
      .update(mediums)
      .set({ constantDynamicViscosity: 3e-5 })
      .where(eq(mediums.id, mediumId));
    try {
      const execution = await materializeProgressiveCfdExecution(db, lease);
      expect(execution.snapshot.material?.viscosity).toEqual({
        model: "constant",
        mu: 1.789e-5,
      });
      expect(execution.snapshot.flowState.dynamicViscosity).toBe(1.789e-5);
    } finally {
      await db
        .update(mediums)
        .set({ constantDynamicViscosity: 1.789e-5 })
        .where(eq(mediums.id, mediumId));
    }
  });

  it("materializes two initial anchors per polar only after baseline coverage, idempotently", async () => {
    const id = await campaign();
    await sealProgressiveGeneration(db, await progressiveScope(id));
    expect(await initializeProgressiveCfdWork(db)).toBe(0);
    expect(await claimCfd()).toBeNull();
    const baseline = (await claim([1]))!;
    await storeNeuralFoilPrediction(db, baseline, predictionFixture(baseline));
    expect(
      (
        await Promise.all([
          initializeProgressiveCfdWork(db),
          initializeProgressiveCfdWork(db),
        ])
      ).reduce((sum, count) => sum + count, 0),
    ).toBe(2);
    expect(await initializeProgressiveCfdWork(db)).toBe(0);
    expect(await claim([2])).toBeNull();
    const unit = (await claimCfd())!;
    expect(unit).toMatchObject({ stage: 2, remainingActiveSeconds: 900 });
    expect(unit.recipe.selection).toMatchObject({
      solver: "rhoSimpleFoam",
      pressureKind: "absolute",
    });
    expect([-2, 0, 2]).toContain(unit.alpha);
    const second = (await claimCfd())!;
    expect(second.id).not.toBe(unit.id);
    expect(second.alpha).not.toBe(unit.alpha);
    expect(await claimCfd()).toBeNull();
    await expect(
      db.execute(
        sql`UPDATE progressive_cfd_units SET aoa_deg = 17 WHERE id = ${unit.id}`,
      ),
    ).rejects.toThrow("immutable");
    const [resultCount] = await db.execute(
      sql`SELECT count(*)::integer AS count FROM results WHERE airfoil_id = ${originalId}`,
    );
    expect(resultCount.count).toBe(0);
  });

  it("distributes initial coverage before additional angles across the finite cohort", async () => {
    await fastCfdGeneration(true);
    expect(await initializeProgressiveCfdWork(db)).toBe(4);
    const first = (await claimCfd())!;
    const second = (await claimCfd())!;
    expect(first.targetId).not.toBe(second.targetId);
    await db.execute(sql`
      INSERT INTO progressive_cfd_units (work_id, aoa_deg, ordinal, purpose, recipe, reason, active_budget_seconds, policy_version)
      SELECT work_id, -2, 2, 'adaptive', recipe, 'isolated posterior fixture', active_budget_seconds, policy_version
      FROM progressive_cfd_units WHERE id = ${first.id}
    `);
    const third = (await claimCfd())!;
    const fourth = (await claimCfd())!;
    expect(third.alpha).not.toBe(first.alpha);
    expect(fourth.alpha).not.toBe(second.alpha);
    expect(await claimCfd()).toBeNull();
    await db.execute(sql`
      UPDATE progressive_cfd_units SET state = 'complete', lease_token = NULL, lease_owner = NULL, lease_until = NULL
      WHERE purpose = 'initial'
    `);
    const adaptive = (await claimCfd())!;
    expect(adaptive).toMatchObject({
      targetId: first.targetId,
      alpha: -2,
      stage: 2,
    });
  });

  it("waits for complete cohort initialization before selecting a CFD candidate", async () => {
    const { generationId } = await fastCfdGeneration(true);
    expect(await initializeProgressiveCfdWork(db)).toBe(4);
    const [missing] = await db.execute(sql`
      SELECT id FROM progressive_work WHERE generation_id = ${generationId} AND stage = 2
      ORDER BY target_id DESC LIMIT 1
    `);
    await db.execute(
      sql`DELETE FROM progressive_cfd_units WHERE work_id = ${missing.id}`,
    );
    expect(await claimCfd()).toBeNull();
    expect(await initializeProgressiveCfdWork(db)).toBe(2);
    const first = (await claimCfd())!;
    const second = (await claimCfd())!;
    expect(first.generationId).toBe(generationId);
    expect(second.generationId).toBe(generationId);
    expect(first.targetId).not.toBe(second.targetId);
  });

  it("does not let a terminal gap without units block initialized CFD targets", async () => {
    const { generationId } = await fastCfdGeneration(true);
    expect(await initializeProgressiveCfdWork(db)).toBe(4);
    const [missing] = await db.execute(sql`
      SELECT id FROM progressive_work WHERE generation_id = ${generationId} AND stage = 2
      ORDER BY target_id DESC LIMIT 1
    `);
    await db.execute(
      sql`DELETE FROM progressive_cfd_units WHERE work_id = ${missing.id}`,
    );
    await db.execute(
      sql`UPDATE progressive_work SET state = 'gap' WHERE id = ${missing.id}`,
    );
    const candidate = (await claimCfd())!;
    expect(candidate.generationId).toBe(generationId);
    expect(candidate.workId).not.toBe(missing.id);
  });

  it("charges measured active time idempotently and requires a stop when the shared angle budget is exhausted", async () => {
    await fastCfdGeneration();
    await initializeProgressiveCfdWork(db);
    const lease = (await claimCfd())!;
    const progress = (seconds: number) =>
      heartbeatProgressiveCfdUnit(db, lease, {
        attemptActiveSeconds: seconds,
        leaseSeconds: 60,
      });
    expect(await progress(200)).toEqual({
      remainingActiveSeconds: 700,
      stopRequired: false,
    });
    expect(await progress(200)).toEqual({
      remainingActiveSeconds: 700,
      stopRequired: false,
    });
    await expect(progress(199)).rejects.toThrow("cannot decrease");
    await expect(progress(NaN)).rejects.toThrow("Invalid measured");
    expect(await progress(905)).toEqual({
      remainingActiveSeconds: 0,
      stopRequired: true,
    });
    const [unit] = await db.execute(
      sql`SELECT state, active_seconds FROM progressive_cfd_units WHERE id = ${lease.id}`,
    );
    expect(unit).toEqual({ state: "blocked", active_seconds: 905 });
    await expect(progress(905)).rejects.toThrow("Obsolete");
    expect((await claimCfd())?.id).not.toBe(lease.id);
  });

  it("does not duplicate an expired execution and rejects stale progress after reset", async () => {
    await fastCfdGeneration();
    await initializeProgressiveCfdWork(db);
    const lease = (await claimCfd())!;
    await db.execute(
      sql`UPDATE progressive_cfd_units SET lease_until = clock_timestamp() - interval '1 second' WHERE id = ${lease.id}`,
    );
    await expect(
      heartbeatProgressiveCfdUnit(db, lease, {
        attemptActiveSeconds: 10,
        leaseSeconds: 60,
      }),
    ).rejects.toThrow("expired");
    expect((await claimCfd())?.id).not.toBe(lease.id);
    expect(await claimCfd()).toBeNull();
    await rotateCalculationEpoch(db, "CFD lease reset regression");
    await expect(
      heartbeatProgressiveCfdUnit(db, lease, {
        attemptActiveSeconds: 10,
        leaseSeconds: 60,
      }),
    ).rejects.toThrow("epoch");
    const [unit] = await db.execute(
      sql`SELECT state FROM progressive_cfd_units WHERE id = ${lease.id}`,
    );
    expect(unit.state).toBe("cancelled");
  });

  it("allows no new work on pause but preserves valid in-flight progress until explicit cancellation", async () => {
    const generation = await fastCfdGeneration();
    await initializeProgressiveCfdWork(db);
    const lease = (await claimCfd())!;
    await db
      .update(simCampaigns)
      .set({ status: "paused" })
      .where(eq(simCampaigns.id, generation.campaignId));
    expect(await claimCfd()).toBeNull();
    expect(
      await heartbeatProgressiveCfdUnit(db, lease, {
        attemptActiveSeconds: 25,
        leaseSeconds: 60,
      }),
    ).toMatchObject({ remainingActiveSeconds: 875 });
    await db
      .update(simCampaigns)
      .set({ status: "cancelled" })
      .where(eq(simCampaigns.id, generation.campaignId));
    await expect(
      heartbeatProgressiveCfdUnit(db, lease, {
        attemptActiveSeconds: 26,
        leaseSeconds: 60,
      }),
    ).rejects.toThrow("no longer accepts");
    await reconcileProgressiveGenerationRequest(db);
    const [attempt] = await db.execute(
      sql`SELECT outcome FROM progressive_cfd_attempts WHERE token = ${lease.token}`,
    );
    expect(attempt.outcome).toBe("cancelled");
  });
});

describe("sealed progressive generations", () => {
  it("materializes full campaign intent and computes matching conditions in one bounded prediction batch", async () => {
    const trustedGeometry = readFileSync(
      resolve(ROOT, "packages/db/seed/selig-database/ag24.dat"),
      "utf8",
    )
      .split(/\r?\n/)
      .slice(1)
      .filter((line) => line.trim())
      .map((line) => {
        const [x, y] = line.trim().split(/\s+/).map(Number);
        return { x, y };
      });
    await db
      .update(airfoils)
      .set({ points: trustedGeometry })
      .where(eq(airfoils.id, originalId));
    const id = await campaign("active", [32.173, 61.173]);
    await db
      .delete(simCampaignPoints)
      .where(eq(simCampaignPoints.campaignId, id));
    const generation = await materializeProgressiveCampaignScope(db, id);
    expect(generation).not.toBeNull();
    expect(await materializeProgressiveCampaignScope(db, id)).toEqual({
      ...generation,
      replayed: true,
    });
    const engine = new EngineClient("http://unused.invalid");
    const gateway = vi
      .spyOn(engine, "predictNeuralFoil")
      .mockImplementation(async (request) => {
        expect(request.conditions).toHaveLength(2);
        return new Promise((resolveResponse, reject) => {
          const child = spawn(
            resolve(ROOT, ".venv/bin/python"),
            [resolve(ROOT, "tests/prediction_gateway_fixture.py")],
            { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
          );
          let output = "";
          let errors = "";
          const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
          child.stdout.on("data", (chunk) => {
            output += chunk.toString();
          });
          child.stderr.on("data", (chunk) => {
            errors = (errors + chunk.toString()).slice(-4000);
          });
          child.on("error", (error) => {
            clearTimeout(deadline);
            reject(error);
          });
          child.on("close", (code) => {
            clearTimeout(deadline);
            if (code !== 0)
              reject(
                new Error(`Real prediction gateway fixture failed: ${errors}`),
              );
            else {
              try {
                resolveResponse(JSON.parse(output));
              } catch (error) {
                reject(error);
              }
            }
          });
          child.stdin.end(JSON.stringify(request));
        });
      });
    try {
      expect(
        await runProgressiveBaselineBatch(db, engine, "isolated-batch-test"),
      ).toEqual({ claimed: 2, stored: 2, reused: 0, errors: [] });
      expect(gateway).toHaveBeenCalledTimes(1);
      expect(await publicProgressivePolars(db, originalId)).toEqual([]);
      const [scope] =
        await client.sql`SELECT revision_id FROM progressive_generation_targets WHERE generation_id = ${generation!.id} LIMIT 1`;
      const publicCurves = await publicProgressivePolars(
        db,
        originalId,
        scope.revision_id,
      );
      expect(publicCurves).toHaveLength(1);
      expect(publicCurves[0].curves[0].method).toBe("neuralfoil");
      expect(publicCurves[0].curves[0].samples).toHaveLength(3);
      expect(publicCurves[0].curves[0].metrics?.liftMaximum).toBe(
        Math.max(
          ...publicCurves[0].curves[0].samples.map((sample) => sample.cl),
        ),
      );
      expect(
        publicCurves[0].curves[0].samples.every((sample) => sample.cd > 0),
      ).toBe(true);
      expect(publicCurves[0]).not.toHaveProperty("resultId");
      const [state] =
        await client.sql`SELECT stage FROM progressive_generations WHERE id = ${generation!.id}`;
      expect(state.stage).toBe(2);
      const another = await campaign("active", [32.173, 61.173]);
      await materializeProgressiveCampaignScope(db, another);
      await db
        .insert(sweeperState)
        .values({ id: 1, enabled: false })
        .onConflictDoUpdate({
          target: sweeperState.id,
          set: { enabled: false },
        });
      expect(
        await runProgressiveBaselineBatch(db, engine, "paused-service", {
          requireSweeperEnabled: true,
        }),
      ).toEqual({ claimed: 0, stored: 0, reused: 0, errors: [] });
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 30_000);
      const receipts: Record<string, unknown>[] = [];
      const updates: Promise<unknown>[] = [];
      try {
        await runProgressiveBaselineService(
          db,
          client.sql,
          engine,
          abort.signal,
          (receipt) => {
            receipts.push(receipt);
            if (
              receipt.component === "progressive-scope" &&
              updates.length === 0
            )
              updates.push(
                db
                  .update(sweeperState)
                  .set({ enabled: true })
                  .where(eq(sweeperState.id, 1))
                  .execute(),
              );
            if (receipt.component === "progressive-baseline") abort.abort();
          },
        );
        await Promise.all(updates);
        expect(
          receipts.find(
            (receipt) => receipt.component === "progressive-baseline",
          ),
        ).toEqual({
          component: "progressive-baseline",
          claimed: 2,
          stored: 0,
          reused: 2,
          errors: [],
        });
      } finally {
        clearTimeout(timeout);
        abort.abort();
        await Promise.allSettled(updates);
        await db
          .update(sweeperState)
          .set({ enabled: false })
          .where(eq(sweeperState.id, 1));
      }
      expect(gateway).toHaveBeenCalledTimes(1);
    } finally {
      gateway.mockRestore();
      await db
        .update(airfoils)
        .set({ points })
        .where(eq(airfoils.id, originalId));
    }
  }, 60_000);
  it("uses temperature-dependent gas Mach and preserves liquid/unknown sound-speed behavior", () => {
    const material = {
      phase: "gas" as const,
      density: 1.225,
      refTemperatureK: 288.15,
      refPressurePa: 101325,
      speedOfSound: 340.3,
      viscosity: { model: "constant" as const, mu: 1.789e-5 },
    };
    const state = {
      temperatureK: 4 * 288.15,
      pressurePa: 101325,
      speedMps: 340.3,
    };
    expect(deriveFlowConditionState(material, state).mach).toBe(0.5);
    expect(deriveFlowConditionState(material, state).density).toBe(1.225 / 4);
    expect(
      deriveFlowConditionState({ ...material, phase: "liquid" }, state).mach,
    ).toBe(1);
    expect(
      deriveFlowConditionState({ ...material, speedOfSound: null }, state).mach,
    ).toBeNull();
    expect(() =>
      deriveFlowConditionState(material, { ...state, temperatureK: 0 }),
    ).toThrow("temperature");
  });

  it("pins constitutive material inputs without rewriting old resolved setups", async () => {
    const id = await campaign();
    const [source] = await client.sql<
      {
        preset_id: string;
        revision_id: string;
        snapshot: SimulationSetupSnapshot;
      }[]
    >`
      SELECT condition.preset_id, revision.id AS revision_id, revision.snapshot FROM sim_campaign_conditions condition
      JOIN simulation_preset_revisions revision ON revision.id = condition.simulation_preset_revision_id
      WHERE condition.campaign_id = ${id} LIMIT 1
    `;
    expect(source.snapshot.material?.viscosity).toEqual({
      model: "constant",
      mu: 1.789e-5,
    });
    try {
      await db
        .update(mediums)
        .set({ constantDynamicViscosity: 2 * 1.789e-5 })
        .where(eq(mediums.id, mediumId));
      const successor = await ensureSimulationPresetRevision(
        db,
        source.preset_id,
      );
      expect(successor?.revision.id).not.toBe(source.revision_id);
      expect(successor?.snapshot.material?.viscosity).toEqual({
        model: "constant",
        mu: 2 * 1.789e-5,
      });
      expect(successor?.snapshot.flowState.dynamicViscosity).toBe(2 * 1.789e-5);
      const [original] =
        await client.sql`SELECT snapshot FROM simulation_preset_revisions WHERE id = ${source.revision_id}`;
      expect(original.snapshot).toEqual(source.snapshot);
    } finally {
      await db
        .update(mediums)
        .set({ constantDynamicViscosity: 1.789e-5 })
        .where(eq(mediums.id, mediumId));
    }
  });
  it("keeps numerical compatibility separate from physical fusion identity", async () => {
    const id = await campaign();
    const scope = await progressiveScope(id);
    const physical = scope.targets[0].physical;
    expect(physical).not.toHaveProperty("mesh");
    expect(physical).not.toHaveProperty("solver");
    expect(analysisContentHash({ ...physical, branch: "decreasing" })).not.toBe(
      scope.targets[0].targetId,
    );
    expect(
      analysisContentHash({
        ...physical,
        transition: { ...physical.transition, upper: 1 },
      }),
    ).not.toBe(scope.targets[0].targetId);
    expect(() => analysisContentHash({ broken: NaN })).toThrow("finite");
    const first = await sealProgressiveGeneration(db, scope);
    expect(await sealProgressiveGeneration(db, scope)).toEqual({
      ...first,
      replayed: true,
    });
    await expect(
      sealProgressiveGeneration(db, {
        ...scope,
        targets: [{ ...scope.targets[0], angles: [-2, 0, 3] }],
      }),
    ).rejects.toThrow("scope cannot change");
    await expect(
      client.sql`UPDATE progressive_generation_targets SET angles = ARRAY[0, 1] WHERE generation_id = ${first.id}`,
    ).rejects.toThrow("immutable");
  });

  it("requires every baseline before fast work and every bounded fast pass before precise work", async () => {
    const id = await campaign();
    const added = await newProfile();
    await reconcileCampaignProfileEnrollment(db);
    const scope = await progressiveScope(id, "initial", [originalId, added]);
    await sealProgressiveGeneration(db, scope);
    const first = (await claim([1]))!;
    const second = (await claim([1]))!;
    expect(first.id).not.toBe(second.id);
    expect(await claim([2, 3])).toBeNull();
    const payload = predictionFixture(first);
    const predictionId = await storeNeuralFoilPrediction(db, first, payload);
    expect(await storeNeuralFoilPrediction(db, first, payload)).toBe(
      predictionId,
    );
    await expect(
      storeNeuralFoilPrediction(db, first, {
        ...payload,
        analysis_confidence: [0.1, 0.1, 0.1],
      }),
    ).rejects.toThrow("different content");
    expect(await claim([2])).toBeNull();
    await storeNeuralFoilPrediction(db, second, predictionFixture(second));
    const fast = (await claim([2]))!;
    expect(fast.stage).toBe(2);
    expect(await claim([3])).toBeNull();
    await failProgressiveWork(db, fast, "isolated bounded fast failure", false);
    expect(await claim([3])).toBeNull();
    const otherFast = (await claim([2]))!;
    await failProgressiveWork(
      db,
      otherFast,
      "isolated bounded fast failure",
      false,
    );
    expect((await claim([3]))?.stage).toBe(3);
    const [{ count }] =
      await client.sql`SELECT count(*)::integer AS count FROM results WHERE airfoil_id = ${originalId}`;
    expect(count).toBe(0);
  });

  it("fences reset, stale and expired deliveries while preserving failed attempt history", async () => {
    const id = await campaign();
    const scope = await progressiveScope(id);
    await sealProgressiveGeneration(db, scope);
    const first = (await claim([1]))!;
    await failProgressiveWork(db, first, "temporary transport failure", true);
    const retry = (await claim([1]))!;
    expect(retry.attempts).toBe(2);
    await expect(
      storeNeuralFoilPrediction(db, first, predictionFixture(first)),
    ).rejects.toThrow("obsolete");
    const nextEpoch = await rotateCalculationEpoch(db, "isolated reset test");
    expect(nextEpoch).not.toBe(first.epochId);
    await expect(
      storeNeuralFoilPrediction(db, retry, predictionFixture(retry)),
    ).rejects.toThrow("epoch");
    expect(await rotateCalculationEpoch(db, "upstream replay", nextEpoch)).toBe(
      nextEpoch,
    );
    await expect(
      rotateCalculationEpoch(db, "old upstream replay", first.epochId),
    ).rejects.toThrow("reactivated");
    const attempts =
      await client.sql`SELECT outcome, error FROM progressive_work_attempts WHERE work_id = ${first.id} ORDER BY started_at`;
    expect(attempts.map((attempt) => attempt.outcome)).toEqual([
      "failed",
      "cancelled",
    ]);
    expect(attempts[0].error).toBe("temporary transport failure");
    await sealProgressiveGeneration(db, scope);
    const renewed = (await claim([1]))!;
    await client.sql`UPDATE progressive_work SET lease_until = clock_timestamp() - interval '1 second' WHERE id = ${renewed.id}`;
    await expect(
      storeNeuralFoilPrediction(db, renewed, predictionFixture(renewed)),
    ).rejects.toThrow("expired");
  });

  it("never accepts fabricated success for incompatible inputs or nonfinite output", async () => {
    const id = await campaign();
    await sealProgressiveGeneration(db, await progressiveScope(id));
    const lease = (await claim([1]))!;
    const payload = predictionFixture(lease);
    for (const changed of [
      { ...payload, cfd_evidence: true },
      { ...payload, target_signature: "wrong" },
      {
        ...payload,
        coefficients: [
          [0, -1, 0],
          [0, 1, 0],
          [0, 1, 0],
        ],
      },
      { ...payload, model: {} },
    ]) {
      await expect(
        storeNeuralFoilPrediction(db, lease, changed),
      ).rejects.toThrow();
    }
    const [{ count }] =
      await client.sql`SELECT count(*)::integer AS count FROM neuralfoil_predictions WHERE target_id = ${lease.targetId} AND epoch_id = ${lease.epochId}`;
    expect(count).toBe(0);
  });

  it("respects paused, cancelled and archived campaigns and reopens only completed additional scope", async () => {
    for (const status of ["paused", "cancelled", "archived"]) {
      const id = await campaign(status);
      await sealProgressiveGeneration(db, await progressiveScope(id));
      expect(await claim()).toBeNull();
      const [row] = await db
        .select()
        .from(simCampaigns)
        .where(eq(simCampaigns.id, id));
      expect(row.status).toBe(status);
    }
    const completed = await campaign("completed");
    await sealProgressiveGeneration(db, await progressiveScope(completed));
    expect((await claim([1]))?.campaignId).toBe(completed);
  });

  it("does not let a late expansion mutate an existing generation or steal its in-flight lease", async () => {
    const id = await campaign();
    const initial = await sealProgressiveGeneration(
      db,
      await progressiveScope(id),
    );
    const lease = (await claim([1]))!;
    const added = await newProfile();
    await reconcileCampaignProfileEnrollment(db);
    const expansion = await sealProgressiveGeneration(
      db,
      await progressiveScope(id, "new-profile-batch", [added]),
    );
    expect(expansion.id).not.toBe(initial.id);
    await storeNeuralFoilPrediction(db, lease, predictionFixture(lease));
    expect((await claim([2]))?.generationId).toBe(initial.id);
    expect((await claim([1]))?.generationId).toBe(expansion.id);
  });

  it("serializes concurrent claims without duplicate leases", async () => {
    const id = await campaign();
    await sealProgressiveGeneration(db, await progressiveScope(id));
    const claimed = (
      await Promise.all([claim([1]), claim([1]), claim([1])])
    ).filter(Boolean);
    expect(claimed).toHaveLength(1);
  });
});

afterAll(async () => {
  try {
    await client?.sql.end();
    if (created) await admin.unsafe(`DROP DATABASE "${DATABASE}"`);
    await admin.end();
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(workerMedia.directory, { recursive: true, force: true });
    if (workerMedia.previous === undefined) delete process.env.MEDIA_DIR;
    else process.env.MEDIA_DIR = workerMedia.previous;
  }
});

describe("durable profile enrollment", () => {
  it("opens a campaign while an unrelated profile deletion commits", async () => {
    const removed = await newProfile();
    let release!: () => void;
    let notify!: (pid: number) => void;
    const ready = new Promise<number>((resolve) => {
      notify = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deletion = db.transaction(async (transaction) => {
      const [backend] = await transaction.execute(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      await transaction.delete(airfoils).where(eq(airfoils.id, removed));
      notify(Number(backend.pid));
      await proceed;
    });
    const blocker = await ready;
    const launch = campaign().then(
      (id) => ({ id, error: null }),
      (error: unknown) => ({ id: null, error }),
    );
    try {
      await expect
        .poll(
          async () => {
            const [waiting] = await db.execute(sql`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE ${blocker}::integer = ANY(pg_blocking_pids(pid))) AS blocked
        `);
            return waiting.blocked;
          },
          { timeout: 10000, interval: 10 },
        )
        .toBe(true);
    } finally {
      release();
      await deletion;
    }
    const result = await launch;
    expect(result.error).toBeNull();
    expect(result.id).not.toBeNull();
    const rows = await db.execute(sql`
      SELECT airfoil_id FROM campaign_catalog_snapshot
      WHERE campaign_id = ${result.id}::uuid AND airfoil_id = ${removed}::uuid
    `);
    expect(rows).toHaveLength(0);
  });

  it("cleans only the owned retained-condition scopes and progressive generations", async () => {
    const removedId = await campaign("active", [73.9181]);
    const survivorId = await campaign("active", [73.9182]);
    await sealProgressiveGeneration(db, await progressiveScope(removedId));
    await sealProgressiveGeneration(db, await progressiveScope(survivorId));
    await db.execute(sql`
      INSERT INTO campaign_condition_scopes (condition_id, angles, source_plan_revision_id)
      SELECT condition.id, ARRAY[-2, 0, 2]::float8[], campaign.current_plan_revision_id
      FROM sim_campaign_conditions condition JOIN sim_campaigns campaign ON campaign.id = condition.campaign_id
      WHERE campaign.id IN (${removedId}::uuid, ${survivorId}::uuid)
    `);
    const [before] = await db.execute(sql`
      SELECT scope.* FROM campaign_condition_scopes scope
      JOIN sim_campaign_conditions condition ON condition.id = scope.condition_id
      WHERE condition.campaign_id = ${survivorId}
    `);
    await cleanupCampaignFixtures(db, {
      campaignIds: [removedId],
      presetSlugPrefix: `campaign-${randomUUID()}`,
    });
    expect(
      await db
        .select()
        .from(simCampaigns)
        .where(eq(simCampaigns.id, removedId)),
    ).toHaveLength(0);
    const [after] = await db.execute(sql`
      SELECT scope.* FROM campaign_condition_scopes scope
      JOIN sim_campaign_conditions condition ON condition.id = scope.condition_id
      WHERE condition.campaign_id = ${survivorId}
    `);
    expect(after).toEqual(before);
    const generations = await db.execute(sql`
      SELECT campaign_id FROM progressive_generations WHERE campaign_id IN (${removedId}::uuid, ${survivorId}::uuid)
    `);
    expect(generations.map((row) => row.campaign_id)).toEqual([survivorId]);
  });

  it("materializes original angles from campaign intent even after all solver points are discarded", async () => {
    const id = await campaign();
    await db
      .delete(simCampaignPoints)
      .where(eq(simCampaignPoints.campaignId, id));
    const added = await newProfile();
    expect(await reconcileCampaignProfileEnrollment(db)).toMatchObject({
      campaignId: id,
      addedAirfoils: 1,
      addedPoints: 3,
    });
    const rows = await db
      .select()
      .from(simCampaignPoints)
      .where(
        and(
          eq(simCampaignPoints.campaignId, id),
          eq(simCampaignPoints.airfoilId, added),
        ),
      );
    expect(
      rows.map((row) => row.aoaDeg).sort((left, right) => left - right),
    ).toEqual([-2, 0, 2]);
    expect(
      rows.every((row) => row.resultId === null && row.state === "requested"),
    ).toBe(true);
  });

  it("catches direct inserts with backdated source timestamps without enrolling original exclusions", async () => {
    const id = await campaign();
    const added = await newProfile({
      createdAt: new Date("2000-01-01T00:00:00Z"),
    });
    expect(await reconcileCampaignProfileEnrollment(db)).toMatchObject({
      campaignId: id,
      addedAirfoils: 1,
    });
    const rows = await db
      .select()
      .from(simCampaignAirfoils)
      .where(eq(simCampaignAirfoils.campaignId, id));
    expect(rows.map((row) => row.airfoilId).sort()).toEqual(
      [originalId, added].sort(),
    );
    expect(rows.map((row) => row.airfoilId)).not.toContain(excludedId);
    expect(await reconcileCampaignProfileEnrollment(db)).toBeNull();
  });

  it("reopens completed campaigns and does not rewrite their existing work", async () => {
    const id = await campaign("completed");
    const before = await db
      .select()
      .from(simCampaignPoints)
      .where(eq(simCampaignPoints.airfoilId, originalId));
    await newProfile();
    await reconcileCampaignProfileEnrollment(db);
    const [state] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, id));
    expect(state.status).toBe("active");
    const after = await db
      .select()
      .from(simCampaignPoints)
      .where(eq(simCampaignPoints.airfoilId, originalId));
    expect(after.map((row) => [row.aoaDeg, row.resultId, row.state])).toEqual(
      before.map((row) => [row.aoaDeg, row.resultId, row.state]),
    );
  });

  it("enrolls paused campaigns while preserving their pause", async () => {
    const id = await campaign("paused");
    await newProfile();
    expect(await reconcileCampaignProfileEnrollment(db)).toMatchObject({
      campaignId: id,
    });
    const [state] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, id));
    expect(state.status).toBe("paused");
  });

  it.each(["cancelled", "archived"])(
    "leaves %s campaigns inactive and catches up after explicit reactivation",
    async (status) => {
      const id = await campaign(status);
      await newProfile();
      expect(await reconcileCampaignProfileEnrollment(db)).toBeNull();
      await db
        .update(simCampaigns)
        .set({ status: "active" })
        .where(eq(simCampaigns.id, id));
      expect(await reconcileCampaignProfileEnrollment(db)).toMatchObject({
        campaignId: id,
        addedAirfoils: 1,
      });
    },
  );

  it("seals finite batches and is safe across concurrent reconcilers", async () => {
    const id = await campaign();
    await newProfile();
    await newProfile();
    const first = await Promise.all([
      reconcileCampaignProfileEnrollment(db, 1),
      reconcileCampaignProfileEnrollment(db, 1),
    ]);
    expect(
      first
        .filter(Boolean)
        .reduce((sum, row) => sum + (row?.addedAirfoils ?? 0), 0),
    ).toBeGreaterThanOrEqual(1);
    await reconcileCampaignProfileEnrollment(db, 1);
    expect(await reconcileCampaignProfileEnrollment(db, 1)).toBeNull();
    const batches = await db
      .select()
      .from(campaignProfileExpansions)
      .where(eq(campaignProfileExpansions.campaignId, id));
    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => batch.airfoilIds.length === 1)).toBe(true);
  });

  it("waits for usable geometry without losing the insertion event", async () => {
    const id = await campaign();
    const added = await newProfile({ points: [] });
    expect(await reconcileCampaignProfileEnrollment(db)).toBeNull();
    await db.update(airfoils).set({ points }).where(eq(airfoils.id, added));
    expect(await reconcileCampaignProfileEnrollment(db)).toMatchObject({
      campaignId: id,
      addedAirfoils: 1,
    });
  });

  it("enrolls an insertion that started before launch but committed after the catalog snapshot", async () => {
    let release!: () => void;
    let inserted!: () => void;
    const ready = new Promise<void>((resolveReady) => {
      inserted = resolveReady;
    });
    const proceed = new Promise<void>((resolveProceed) => {
      release = resolveProceed;
    });
    const insertion = db.transaction(async (tx) => {
      const [row] = await tx
        .insert(airfoils)
        .values({
          slug: `${PREFIX}-concurrent-${sequence++}`,
          name: "concurrent insert",
          categoryId,
          points,
        })
        .returning();
      addedProfileIds.push(row.id);
      inserted();
      await proceed;
      return row.id;
    });
    await ready;
    let id: string;
    try {
      id = await campaign();
    } finally {
      release();
    }
    const added = await insertion;
    expect(await reconcileCampaignProfileEnrollment(db)).toMatchObject({
      campaignId: id,
      addedAirfoils: 1,
    });
    const rows = await db
      .select()
      .from(simCampaignAirfoils)
      .where(
        and(
          eq(simCampaignAirfoils.campaignId, id),
          eq(simCampaignAirfoils.airfoilId, added),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
