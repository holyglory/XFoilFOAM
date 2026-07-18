// URANS fidelity-ladder integration (contracts 3–7, migration 0034):
// schema pin, durable partial-route recording, wave-2 re-attempt at precalc
// fidelity, idempotent verify-queue enqueue,
// tier ordering (pending admin request ⇒ no verify consume), verify solve +
// disagreement path, request-URANS idempotency, phase derivation and
// completion blocking. Live shared-DB pattern (scoped rows, full cleanup).

import "./enabled-engine-pool-fixture";

import {
  AUTO_PRECALC_CONTINUATION_BUDGET_S,
  AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
  finalVerifyInterleaveDecision,
  MAX_WAVE1_ADMISSIONS_BEFORE_VERIFY,
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
  UransRequestCoverageConflict,
  airfoils,
  boundaryProfiles,
  campaignHasOpenRansGaps,
  campaignOpenTierCounts,
  campaignSummary,
  categories,
  claimNextPendingUransRequest,
  createClient,
  createUransRequest,
  deriveCampaignPhase,
  enqueuePrecalcVerifications,
  ensurePrecalcObligations,
  hasOpenCampaignLadderWork,
  healOrphanedUransRequests,
  isExactRestartablePrecalcAttempt,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  onResultIngestedWithAutomaticPrecalcHandoff,
  outputProfiles,
  precalcContinuationsForObligations,
  precalcSnapshotForVerifyItem,
  probeCampaignCompletion,
  recordPrecalcObligationSubmission,
  requeueRestartablePrecalcContinuations,
  resultAttempts,
  resultClassifications,
  results,
  schedulingProfiles,
  simCampaignConditions,
  simCampaignPoints,
  simCampaigns,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligationCampaigns,
  simPrecalcObligations,
  simSolverIncidents,
  simulationPresetRevisions,
  simulationPresets,
  simUransRequestCampaigns,
  simUransRequests,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
  solverEvidenceArchives,
  solverEvidenceArtifactMembers,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
  solverProfiles,
  settlePrecalcObligationsForJob,
  sweeperState,
} from "@aerodb/db";
import { URANS_CONTINUATION_REQUIRED_MARKER } from "@aerodb/core";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import {
  type EngineClient,
  type JobResult,
  type JobStatus,
  type PolarPoint,
  type PolarRequest,
} from "@aerodb/engine-client";
import { and, eq, inArray, or, sql as dsql } from "drizzle-orm";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { reconcile, submitUransRetryForJob } from "../src/reconcile";
import { submitPendingJobWithLifecycleGuard } from "../src/submit-lifecycle";
import {
  resetUransLadderMemory,
  submitCampaignPrecalcRecoveries,
  submitInterleavedVerifyIfDue,
  uransLadderTick,
} from "../src/urans-ladder";
import { withExactManifestEvidence } from "./exact-result-fixture";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-ladder-${process.pid}-${Date.now().toString(36)}`;
const mediaRoot = resolve("/tmp", `${PREFIX}-media`);
const previousMediaDir = process.env.MEDIA_DIR;
process.env.MEDIA_DIR = mediaRoot;

const here = dirname(fileURLToPath(import.meta.url));
const frameTrackFixture = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(resolve(here, "fixtures/frame-track-contract.json"), "utf8"),
  );

const ANGLES = [4, 8];
const SPEED = 20;
const CHORD = 0.253719;
const REJECTED_AOA = 8;

let campaignId = "";
let airfoilId = "";
let categoryId = "";
let mediumId = "";
let conditionId = "";
let revisionId = "";
let bcId = "";
let parentJobId = "";
const profileIds = {
  boundary: "",
  mesh: "",
  solver: "",
  scheduling: "",
  output: "",
};
let restoreSweeperEnabled: boolean | null = null;
const continuationEvidenceBlobIds: string[] = [];

const RESTART_ARCHIVE_MEMBERS = [
  "openfoam/transient/transient_start.json",
  "openfoam/transient/system/controlDict",
  "openfoam/transient/system/fvSchemes",
  "openfoam/transient/system/fvSolution",
  "openfoam/transient/constant/polyMesh/points",
  "openfoam/transient/constant/polyMesh/faces",
  "openfoam/transient/constant/polyMesh/owner",
  "openfoam/transient/constant/polyMesh/neighbour",
  "openfoam/transient/constant/polyMesh/boundary",
  "openfoam/transient/constant/transportProperties",
  "openfoam/transient/constant/turbulenceProperties",
  "time_directories/10/U",
  "time_directories/10/p",
  "time_directories/10/k",
  "time_directories/10/omega",
  "time_directories/10/nut",
  "time_directories/10/phi",
  "openfoam/postProcessing/forceCoeffs1/0/coefficient.dat",
] as const;

const points = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

function stubEngine(
  capture: PolarRequest[],
  engineJobId: string,
): EngineClient {
  return {
    submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
      capture.push(request);
      return {
        job_id: engineJobId,
        state: "pending",
        total_cases: request.aoa?.angles?.length ?? 0,
        completed_cases: 0,
      };
    },
  } as unknown as EngineClient;
}

async function createAcceptedPrecalcGeneration(input: {
  resultId: string;
  aoaDeg: number;
  label: string;
  cl: number;
  cd: number;
  cm: number;
  createdAt?: Date;
}): Promise<string> {
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: input.resultId,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: input.aoaDeg,
      engineJobId: `${PREFIX}-${input.label}`,
      engineCaseSlug: `aoa_${input.aoaDeg}_precalc`,
      methodKey: "openfoam.urans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      status: "done",
      source: "solved",
      regime: "urans",
      validForPolar: true,
      cl: input.cl,
      cd: input.cd,
      cm: input.cm,
      clCd: input.cd === 0 ? null : input.cl / input.cd,
      converged: true,
      unsteady: true,
      evidencePayload: { fidelity: "urans_precalc" },
      solvedAt: input.createdAt ?? new Date(),
      createdAt: input.createdAt ?? new Date(),
    })
    .returning({ id: resultAttempts.id });
  await db.insert(resultClassifications).values({
    resultId: input.resultId,
    resultAttemptId: attempt.id,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg: input.aoaDeg,
    regime: "urans",
    classifierVersion: "verify-generation-fixture-v1",
    state: "accepted",
    region: "attached",
    confidence: 1,
    reasons: [],
  });
  await db
    .update(results)
    .set({
      currentResultAttemptId: attempt.id,
      methodKey: "openfoam.urans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    })
    .where(eq(results.id, input.resultId));
  const [manifest] = await db
    .insert(solverEvidenceArtifacts)
    .values({
      resultId: input.resultId,
      resultAttemptId: attempt.id,
      airfoilId,
      engineJobId: `${PREFIX}-${input.label}`,
      engineCaseSlug: `aoa_${input.aoaDeg}_precalc`,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      aoaDeg: input.aoaDeg,
      kind: "manifest",
      storageKey: `${PREFIX}/manifest/${attempt.id}.json`,
      mimeType: "application/json",
      sha256: "c".repeat(64),
      byteSize: 1,
    })
    .returning({ id: solverEvidenceArtifacts.id });
  await attachExactRestartArchive({
    resultId: input.resultId,
    resultAttemptId: attempt.id,
    airfoilId,
    simJobId: null,
    engineJobId: `${PREFIX}-${input.label}`,
    engineCaseSlug: `aoa_${input.aoaDeg}_precalc`,
    aoaDeg: input.aoaDeg,
    solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    manifestId: manifest.id,
  });
  return attempt.id;
}

async function attachExactRestartArchive(input: {
  resultId: string;
  resultAttemptId: string;
  airfoilId: string;
  simJobId: string | null;
  engineJobId: string | null;
  engineCaseSlug: string | null;
  aoaDeg: number;
  solverImplementationId: string;
  manifestId: string;
  omitMember?: string;
}): Promise<void> {
  const [bundle] = await db
    .insert(solverEvidenceArtifacts)
    .values({
      resultId: input.resultId,
      resultAttemptId: input.resultAttemptId,
      airfoilId: input.airfoilId,
      simJobId: input.simJobId,
      engineJobId: input.engineJobId,
      engineCaseSlug: input.engineCaseSlug,
      solverImplementationId: input.solverImplementationId,
      aoaDeg: input.aoaDeg,
      kind: "engine_bundle",
      storageKey: `${PREFIX}/continuation/${input.resultAttemptId}/engine.tar.zst`,
      mimeType: "application/zstd",
      sha256: "b".repeat(64),
      byteSize: 4096,
    })
    .returning({ id: solverEvidenceArtifacts.id });
  const [blob] = await db
    .insert(solverEvidenceBlobs)
    .values({
      backend: "gcs",
      bucket: "exact-continuation-sweeper-test",
      objectKey: `${PREFIX}/${input.resultAttemptId}.tar.zst`,
      generation: String(40_000 + continuationEvidenceBlobIds.length),
      compression: "zstd",
      mimeType: "application/zstd",
      sha256: "c".repeat(64),
      byteSize: 4096,
      crc32c: "AAAAAA==",
      uncompressedTarSha256: "d".repeat(64),
      uncompressedTarByteSize: 8192,
      verifiedAt: new Date(),
    })
    .returning({ id: solverEvidenceBlobs.id });
  continuationEvidenceBlobIds.push(blob.id);
  const [archive] = await db
    .insert(solverEvidenceArchives)
    .values({
      resultId: input.resultId,
      resultAttemptId: input.resultAttemptId,
      sourceArtifactId: bundle.id,
      blobId: blob.id,
    })
    .returning({ id: solverEvidenceArchives.id });
  const memberPaths = RESTART_ARCHIVE_MEMBERS.filter(
    (path) => path !== input.omitMember,
  );
  const members = await db
    .insert(solverEvidenceArtifacts)
    .values(
      memberPaths.map((path, index) => ({
        resultId: input.resultId,
        resultAttemptId: input.resultAttemptId,
        airfoilId: input.airfoilId,
        simJobId: input.simJobId,
        engineJobId: input.engineJobId,
        engineCaseSlug: input.engineCaseSlug,
        solverImplementationId: input.solverImplementationId,
        aoaDeg: input.aoaDeg,
        kind: "time_directory" as const,
        storageKey: `${PREFIX}/continuation/${input.resultAttemptId}/${path}`,
        mimeType: "application/octet-stream",
        sha256: (index % 16).toString(16).repeat(64),
        byteSize: 64,
      })),
    )
    .returning({ id: solverEvidenceArtifacts.id });
  await db.insert(solverEvidenceArtifactMembers).values([
    {
      archiveId: archive.id,
      artifactId: input.manifestId,
      memberPath: "evidence_manifest.json",
    },
    ...members.map((member, index) => ({
      archiveId: archive.id,
      artifactId: member.id,
      memberPath: memberPaths[index]!,
    })),
  ]);
}

async function attachExistingAcceptedRestartArchive(
  resultId: string,
  resultAttemptId: string,
): Promise<void> {
  const [attempt] = await db
    .select()
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.id, resultAttemptId),
        eq(resultAttempts.resultId, resultId),
      ),
    )
    .limit(1);
  if (!attempt) {
    throw new Error(
      `accepted PRECALC fixture ${resultId}/${resultAttemptId} is missing`,
    );
  }
  const solverImplementationId =
    attempt.solverImplementationId ?? OPENCFD_2606_SOLVER_IMPLEMENTATION_ID;
  if (!attempt.solverImplementationId) {
    await db
      .update(resultAttempts)
      .set({
        methodKey: "openfoam.urans",
        solverImplementationId,
      })
      .where(eq(resultAttempts.id, resultAttemptId));
    await db
      .update(results)
      .set({
        methodKey: "openfoam.urans",
        solverImplementationId,
      })
      .where(eq(results.id, resultId));
  }
  const manifests = await db
    .select({ id: solverEvidenceArtifacts.id })
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.resultId, resultId),
        eq(solverEvidenceArtifacts.resultAttemptId, resultAttemptId),
        eq(solverEvidenceArtifacts.kind, "manifest"),
      ),
    );
  if (manifests.length !== 1) {
    throw new Error(
      `accepted PRECALC fixture ${resultId}/${resultAttemptId} has ${manifests.length} manifests`,
    );
  }
  await attachExactRestartArchive({
    resultId,
    resultAttemptId,
    airfoilId: attempt.airfoilId,
    simJobId: attempt.simJobId,
    engineJobId: attempt.engineJobId,
    engineCaseSlug: attempt.engineCaseSlug,
    aoaDeg: attempt.aoaDeg,
    solverImplementationId,
    manifestId: manifests[0].id,
  });
}

async function attachRestartableContinuationAttempt(input: {
  archive?: "valid" | "missing" | "incomplete";
  airfoilId?: string;
  bcId?: string;
  classification?: "accepted" | "rejected";
  resultId: string;
  revisionId?: string;
  aoaDeg: number;
  fidelity?: "rans" | "urans_precalc" | "urans_full";
  simJobId?: string | null;
  engineJobId?: string | null;
  engineCaseSlug?: string | null;
  solverImplementationId?: string;
  source?: "queued" | "solved";
  status?: "done" | "failed" | "running";
  qualityWarnings: string[];
}): Promise<string> {
  const attemptAirfoilId = input.airfoilId ?? airfoilId;
  const attemptBcId = input.bcId ?? bcId;
  const attemptRevisionId = input.revisionId ?? revisionId;
  const [revision] = await db
    .select({
      solverImplementationId: simulationPresetRevisions.solverImplementationId,
    })
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, attemptRevisionId));
  const solverImplementationId =
    input.solverImplementationId ?? revision?.solverImplementationId;
  if (!solverImplementationId)
    throw new Error(
      `fixture revision ${attemptRevisionId} has no solver implementation`,
    );
  if (input.simJobId) {
    await db.execute(dsql`
      UPDATE sim_jobs
      SET solver_implementation_id = COALESCE(
        solver_implementation_id,
        ${solverImplementationId}::uuid
      )
      WHERE id = ${input.simJobId}::uuid
    `);
  }
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: input.resultId,
      airfoilId: attemptAirfoilId,
      bcId: attemptBcId,
      simulationPresetRevisionId: attemptRevisionId,
      aoaDeg: input.aoaDeg,
      simJobId: input.simJobId ?? null,
      engineJobId: input.engineJobId ?? null,
      engineCaseSlug: input.engineCaseSlug ?? null,
      methodKey: "openfoam.urans",
      solverImplementationId,
      status: input.status ?? "done",
      source: input.source ?? "solved",
      regime: "urans",
      validForPolar: false,
      converged: true,
      unsteady: true,
      qualityWarnings: input.qualityWarnings,
      evidencePayload: { fidelity: input.fidelity ?? "urans_precalc" },
      solvedAt: new Date(),
    })
    .returning();
  await db.insert(resultClassifications).values({
    resultAttemptId: attempt.id,
    airfoilId: attemptAirfoilId,
    simulationPresetRevisionId: attemptRevisionId,
    aoaDeg: input.aoaDeg,
    regime: "urans",
    classifierVersion: "exact-continuation-fixture-v1",
    state: input.classification ?? "rejected",
    region: "post_stall",
    confidence: 1,
    reasons: ["continuation-required"],
  });
  const [manifest] = await db
    .insert(solverEvidenceArtifacts)
    .values({
      resultId: input.resultId,
      resultAttemptId: attempt.id,
      airfoilId: attemptAirfoilId,
      simJobId: attempt.simJobId,
      engineJobId: attempt.engineJobId,
      engineCaseSlug: attempt.engineCaseSlug,
      solverImplementationId,
      aoaDeg: input.aoaDeg,
      kind: "manifest",
      storageKey: `${PREFIX}/continuation/${attempt.id}/manifest.json`,
      mimeType: "application/json",
      sha256: "d".repeat(64),
      byteSize: 1,
    })
    .returning({ id: solverEvidenceArtifacts.id });
  if (input.archive !== "missing") {
    await attachExactRestartArchive({
      resultId: input.resultId,
      resultAttemptId: attempt.id,
      airfoilId: attemptAirfoilId,
      simJobId: attempt.simJobId,
      engineJobId: attempt.engineJobId,
      engineCaseSlug: attempt.engineCaseSlug,
      aoaDeg: input.aoaDeg,
      solverImplementationId,
      manifestId: manifest.id,
      ...(input.archive === "incomplete"
        ? { omitMember: "time_directories/10/p" }
        : {}),
    });
  }
  await db
    .update(results)
    .set({ currentResultAttemptId: attempt.id })
    .where(eq(results.id, input.resultId));
  return attempt.id;
}

/** Closed scheduler scope for this file's physical fixtures. Vitest files run
 * in parallel against one database; campaign scoping alone still permits tier
 * 2b to claim another file's global/admin request. */
async function ladderScope(): Promise<{
  campaignIds: string[];
  requestIds: string[];
  verifyIds: string[];
}> {
  const ownedRequests =
    airfoilId && revisionId
      ? await db
          .select({ id: simUransRequests.id })
          .from(simUransRequests)
          .where(
            and(
              eq(simUransRequests.airfoilId, airfoilId),
              eq(simUransRequests.revisionId, revisionId),
            ),
          )
      : [];
  const ownedVerifyItems =
    airfoilId && revisionId
      ? await db
          .select({ id: simUransVerifyQueue.id })
          .from(simUransVerifyQueue)
          .where(
            and(
              eq(simUransVerifyQueue.airfoilId, airfoilId),
              eq(simUransVerifyQueue.revisionId, revisionId),
            ),
          )
      : [];
  return {
    campaignIds: campaignId ? [campaignId] : [],
    requestIds: ownedRequests.map((row) => row.id),
    verifyIds: ownedVerifyItems.map((row) => row.id),
  };
}

beforeAll(async () => {
  resetUransLadderMemory();
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
      slug: `${PREFIX}-foil`,
      name: `${PREFIX} foil`,
      categoryId: cat.id,
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
  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({
      slug: `${PREFIX}-scheduling`,
      name: `${PREFIX} scheduling`,
      schedulingPolicy: "auto",
    })
    .returning();
  profileIds.boundary = boundary.id;
  profileIds.mesh = mesh.id;
  profileIds.solver = solver.id;
  profileIds.scheduling = scheduling.id;
  profileIds.output = output.id;

  const launch = await materializeCampaignLaunch(db, {
    name: `${PREFIX} ladder campaign`,
    priority: 7,
    idempotencyKey: `${PREFIX}-idem`,
    airfoilIds: [airfoilId],
    schedulingProfileId: profileIds.scheduling,
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
    .select({
      legacyBoundaryConditionId: simulationPresets.legacyBoundaryConditionId,
    })
    .from(simulationPresets)
    .where(eq(simulationPresets.id, condition.presetId))
    .limit(1);
  bcId = preset!.legacyBoundaryConditionId!;
});

afterAll(async () => {
  if (continuationEvidenceBlobIds.length) {
    await db
      .delete(solverEvidenceArchives)
      .where(
        inArray(solverEvidenceArchives.blobId, continuationEvidenceBlobIds),
      );
  }
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
  if (profileIds.scheduling)
    await db
      .delete(schedulingProfiles)
      .where(eq(schedulingProfiles.id, profileIds.scheduling));
  if (profileIds.output)
    await db
      .delete(outputProfiles)
      .where(eq(outputProfiles.id, profileIds.output));
  if (mediumId) await db.delete(mediums).where(eq(mediums.id, mediumId));
  if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
  if (continuationEvidenceBlobIds.length) {
    await db
      .delete(solverEvidenceBlobs)
      .where(inArray(solverEvidenceBlobs.id, continuationEvidenceBlobIds));
  }
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
  rmSync(mediaRoot, { recursive: true, force: true });
  if (previousMediaDir == null) delete process.env.MEDIA_DIR;
  else process.env.MEDIA_DIR = previousMediaDir;
});

describe("migration 0034 schema pin", () => {
  it("results carries fidelity + steady_history; ladder tables match the pinned contract columns", async () => {
    const resultCols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'results' AND column_name IN ('fidelity', 'steady_history')
    `)) as unknown as { column_name: string }[];
    expect(resultCols.map((c) => c.column_name).sort()).toEqual([
      "fidelity",
      "steady_history",
    ]);

    const verifyCols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'sim_urans_verify_queue'
    `)) as unknown as { column_name: string }[];
    // Contract 4 plus migration 0056's exact execution-owner column and
    // migration 0068's durable final-recovery ledger and migration 0072's
    // monotonic no-progress breaker, pinned exactly. JSON request provenance
    // never substitutes for sim_job_id.
    expect(verifyCols.map((c) => c.column_name).sort()).toEqual(
      [
        "id",
        "airfoil_id",
        "revision_id",
        "aoa_deg",
        "campaign_id",
        "background_owner",
        "sim_job_id",
        "state",
        "precalc_result_id",
        "precalc_result_attempt_id",
        "verify_result_id",
        "delta_cl",
        "delta_cd",
        "delta_cm",
        "fresh_attempt_count",
        "max_fresh_attempts",
        "continuation_attempt_count",
        "continuation_no_progress_count",
        "continuation_budget_override_s",
        "latest_result_attempt_id",
        "next_submit_at",
        "last_outcome",
        "last_error",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    const requestCols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'sim_urans_requests'
    `)) as unknown as { column_name: string }[];
    expect(requestCols.map((c) => c.column_name)).toContain("fidelity");
    expect(requestCols.map((c) => c.column_name)).toContain("sim_job_id");
    expect(requestCols.map((c) => c.column_name)).toContain("background_owner");
    expect(requestCols.map((c) => c.column_name)).not.toContain("campaign_id");

    const verifyOwnerCols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'sim_urans_verify_queue_campaigns'
    `)) as unknown as { column_name: string }[];
    expect(verifyOwnerCols.map((c) => c.column_name).sort()).toEqual(
      [
        "queue_id",
        "campaign_id",
        "state",
        "cancelled_at",
        "createdAt",
        "updatedAt",
      ].sort(),
    );

    const requestOwnerCols = (await db.execute(dsql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'sim_urans_request_campaigns'
    `)) as unknown as { column_name: string }[];
    expect(requestOwnerCols.map((c) => c.column_name).sort()).toEqual(
      [
        "request_id",
        "campaign_id",
        "state",
        "cancelled_at",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
  });
});

describe("fidelity ladder end-to-end (gating → precalc retry → verify queue → completion)", () => {
  it("MUST-CATCH: open RANS gaps defer inline submission but persist the campaign's precalc route", async () => {
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
        requestPayload: {
          speedMap: [
            {
              speed: SPEED,
              bcId,
              presetRevisionId: revisionId,
              mach: SPEED / 340.3,
            },
          ],
          aoas: ANGLES,
        },
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
      evidencePayload: { failure_disposition: "hard_solver" },
      solvedAt: new Date(),
    });

    // Campaign points are all still 'requested' with no results rows — open
    // RANS gaps. The inline path must not start a child outside scheduler
    // capacity, but it must persist the exact preliminary route.
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(true);
    const requests: PolarRequest[] = [];
    await submitUransRetryForJob(
      db,
      stubEngine(requests, `${PREFIX}-should-not-exist`),
      parent,
    );
    expect(requests.length).toBe(0);
    const children = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
    expect(children.length).toBe(0);
    expect(
      await db
        .select({ id: simPrecalcObligations.id })
        .from(simPrecalcObligations)
        .where(
          and(
            eq(simPrecalcObligations.airfoilId, airfoilId),
            eq(simPrecalcObligations.revisionId, revisionId),
            eq(simPrecalcObligations.aoaDeg, REJECTED_AOA),
          ),
        ),
    ).toHaveLength(1);

    const tiers = await campaignOpenTierCounts(db, campaignId);
    expect(tiers.ransOpen).toBe(ANGLES.length);
    expect(deriveCampaignPhase("active", tiers)).toBe("running_rans");
  }, 60000);

  it("MUST-CATCH: the capacity ladder submits the terminal parent's exact PRECALC angle while unrelated campaign RANS gaps remain", async () => {
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(true);
    resetUransLadderMemory();
    const requests: PolarRequest[] = [];
    const submitted = await uransLadderTick(
      db,
      stubEngine(requests, `${PREFIX}-precalc-child`),
      0,
      await ladderScope(),
    );
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
    expect(child.campaignId).toBeNull();
    expect(
      (child.requestPayload as { uransFidelity?: string }).uransFidelity,
    ).toBe("precalc");
    const childObligationIds = (
      child.requestPayload as { precalcObligationIds?: string[] }
    ).precalcObligationIds;
    expect(childObligationIds).toHaveLength(1);
    expect(
      await db
        .select({ campaignId: simPrecalcObligationCampaigns.campaignId })
        .from(simPrecalcObligationCampaigns)
        .where(
          eq(
            simPrecalcObligationCampaigns.obligationId,
            childObligationIds![0],
          ),
        ),
    ).toEqual([{ campaignId }]);
    // Admission above happened while the campaign-wide RANS tier was still
    // open. Settle the unrelated fixture points now so the remainder of this
    // sequential end-to-end ladder test can advance to verify/completion.
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(true);
    await db
      .update(simCampaignPoints)
      .set({ state: "terminal" })
      .where(eq(simCampaignPoints.campaignId, campaignId));
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(false);
    // Settle through the real ingest/classification path. This pins the
    // replace/ledger contract rather than faking a terminal child row.
    const acceptedPrecalc: JobResult = {
      job_id: `${PREFIX}-precalc-child`,
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
              cl: 1.01,
              cd: 0.051,
              cm: -0.06,
              cl_cd: 1.01 / 0.051,
              unsteady: true,
              converged: true,
              first_order_fallback: false,
              fidelity: "urans_precalc",
              frame_track:
                frameTrackFixture() as unknown as PolarPoint["frame_track"],
              images: {},
              video: {
                velocity_magnitude: `/jobs/${PREFIX}-precalc-child/files/cases/a0/images/velocity_magnitude.mp4`,
              },
              force_history: {
                t: [0, 0.1, 0.2, 0.3],
                cl: [0.99, 1.03, 0.98, 1.04],
                cd: [0.05, 0.052, 0.05, 0.052],
                cm: [-0.05, -0.07, -0.05, -0.07],
                shedding_freq_hz: 7.1,
                samples: 240,
              },
            } as PolarPoint,
          ],
        },
      ],
    };
    const ingestEngine = {
      getQueue: async () => {
        throw new Error("queue unavailable in test");
      },
      getJob: async (): Promise<JobStatus> => ({
        job_id: `${PREFIX}-precalc-child`,
        state: "completed",
        total_cases: 1,
        completed_cases: 1,
      }),
      getResult: async () => withExactManifestEvidence(acceptedPrecalc),
      fileUrl: (id: string, relPath: string) =>
        `http://engine.test/jobs/${id}/files/${relPath}`,
    } as unknown as EngineClient;
    await reconcile(db, ingestEngine, {
      jobIds: [child.id],
      skipFailedRecovery: true,
    });
    const [settledObligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, airfoilId),
          eq(simPrecalcObligations.revisionId, revisionId),
          eq(simPrecalcObligations.aoaDeg, REJECTED_AOA),
        ),
      );
    expect(settledObligation).toMatchObject({
      state: "satisfied",
      attemptCount: 1,
    });
    expect(
      await db
        .select({ id: simPrecalcObligationAttempts.id })
        .from(simPrecalcObligationAttempts)
        .where(
          eq(simPrecalcObligationAttempts.obligationId, settledObligation.id),
        ),
    ).toHaveLength(1);

    // The next sequential contract reuses this accepted physical evidence but
    // expects to prove verification enqueue itself, so remove only the queue
    // item produced by terminal ingest.
    await db
      .delete(simUransVerifyQueue)
      .where(
        and(
          eq(simUransVerifyQueue.revisionId, revisionId),
          eq(simUransVerifyQueue.aoaDeg, REJECTED_AOA),
        ),
      );
    await db
      .update(simCampaigns)
      .set({ status: "active", completedAt: null })
      .where(eq(simCampaigns.id, campaignId));
  }, 60000);

  it("STRICT PRIORITY: every due terminal-parent PRECALC admission stays ahead of unrelated open RANS", async () => {
    const parentIds: string[] = [];
    const childIds: string[] = [];
    const resultAttemptIds: string[] = [];
    const obligationIds: string[] = [];
    const strictPriorityAngles = [11.375, 12.375];
    try {
      await db
        .update(simCampaigns)
        .set({ status: "active", completedAt: null })
        .where(eq(simCampaigns.id, campaignId));
      await db
        .update(simCampaignPoints)
        .set({ state: "requested", resultId: null })
        .where(eq(simCampaignPoints.campaignId, campaignId));
      expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(true);

      for (const [index, aoaDeg] of strictPriorityAngles.entries()) {
        const [parent] = await db
          .insert(simJobs)
          .values({
            airfoilId,
            bcIds: [bcId],
            simulationPresetRevisionId: revisionId,
            campaignId,
            jobKind: "targeted",
            referenceChordM: CHORD,
            wave: 1,
            status: "done",
            engineJobId: `${PREFIX}-fair-rans-${index}`,
            totalCases: 1,
            completedCases: 1,
            submittedAt: new Date(1_000 + index),
            ingestedAt: new Date(2_000 + index),
            finishedAt: new Date(3_000 + index),
            requestPayload: {
              speedMap: [
                {
                  speed: SPEED,
                  bcId,
                  presetRevisionId: revisionId,
                  mach: SPEED / 340.3,
                },
              ],
              aoas: [aoaDeg],
            },
          })
          .returning();
        parentIds.push(parent.id);
        const [attempt] = await db
          .insert(resultAttempts)
          .values({
            airfoilId,
            bcId,
            simulationPresetRevisionId: revisionId,
            aoaDeg,
            simJobId: parent.id,
            engineJobId: parent.engineJobId,
            status: "failed",
            source: "queued",
            regime: "rans",
            validForPolar: false,
            converged: false,
            stalled: true,
            unsteady: false,
            error: "RANS did not converge",
            evidencePayload: { failure_disposition: "hard_solver" },
            solvedAt: new Date(4_000 + index),
          })
          .returning();
        resultAttemptIds.push(attempt.id);
      }

      const requests: PolarRequest[] = [];
      const engine = stubEngine(requests, `${PREFIX}-fair-precalc`);
      resetUransLadderMemory();
      expect(
        await submitCampaignPrecalcRecoveries(
          db,
          engine,
          [campaignId],
          parentIds,
          0,
        ),
      ).toBe(true);
      expect(requests).toHaveLength(1);

      // The newer per-point fidelity contract is strict: another due
      // terminal-parent PRECALC handoff still owns the next free slot even
      // while unrelated campaign RANS gaps remain open.
      expect(
        await submitCampaignPrecalcRecoveries(
          db,
          engine,
          [campaignId],
          parentIds,
          0,
        ),
      ).toBe(true);
      expect(requests).toHaveLength(2);

      // One scheduler pass still admits at most one physical child. Once both
      // exact handoffs are live, the targeted tier is quiet and ordinary RANS
      // may own the subsequent main-loop slot.
      expect(
        await submitCampaignPrecalcRecoveries(
          db,
          engine,
          [campaignId],
          parentIds,
          0,
        ),
      ).toBe(false);
      expect(requests).toHaveLength(2);
      expect(
        requests
          .map((request) => request.aoa?.angles?.[0])
          .sort((left, right) => Number(left) - Number(right)),
      ).toEqual(strictPriorityAngles);

      const children = await db
        .select()
        .from(simJobs)
        .where(
          and(inArray(simJobs.parentJobId, parentIds), eq(simJobs.wave, 2)),
        );
      childIds.push(...children.map((child) => child.id));
      for (const child of children) {
        const ids = (
          child.requestPayload as { precalcObligationIds?: string[] }
        ).precalcObligationIds;
        obligationIds.push(...(ids ?? []));
      }
      expect(children).toHaveLength(2);
      expect(
        children
          .flatMap(
            (child) => (child.requestPayload as { aoas?: number[] }).aoas ?? [],
          )
          .sort((left, right) => left - right),
      ).toEqual(strictPriorityAngles);
    } finally {
      resetUransLadderMemory();
      if (childIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, childIds));
      }
      if (obligationIds.length) {
        await db
          .delete(simPrecalcObligations)
          .where(inArray(simPrecalcObligations.id, obligationIds));
      }
      if (resultAttemptIds.length) {
        await db
          .delete(resultAttempts)
          .where(inArray(resultAttempts.id, resultAttemptIds));
      }
      if (parentIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, parentIds));
      }
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal" })
        .where(eq(simCampaignPoints.campaignId, campaignId));
      await db
        .update(simCampaigns)
        .set({ status: "active", completedAt: null })
        .where(eq(simCampaigns.id, campaignId));
    }
  }, 120000);

  it("CAPACITY MUST-CATCH: one batched parent admits only one condition child per scheduler pass", async () => {
    const resultAttemptIds: string[] = [];
    const childIds: string[] = [];
    const obligationIds: string[] = [];
    let secondRevisionId = "";
    let parentId = "";
    try {
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal" })
        .where(eq(simCampaignPoints.campaignId, campaignId));
      await db
        .update(simCampaigns)
        .set({ status: "active", completedAt: null })
        .where(eq(simCampaigns.id, campaignId));

      const [targetRevision] = await db
        .select()
        .from(simulationPresetRevisions)
        .where(eq(simulationPresetRevisions.id, revisionId))
        .limit(1);
      expect(targetRevision).toBeDefined();
      const [secondRevision] = await db
        .insert(simulationPresetRevisions)
        .values({
          presetId: targetRevision!.presetId,
          revisionNumber: targetRevision!.revisionNumber + 200_000,
          signatureHash: `${PREFIX}-batched-capacity-second-revision`,
          reynolds: targetRevision!.reynolds,
          mach: targetRevision!.mach,
          referenceLengthM: targetRevision!.referenceLengthM,
          snapshot: targetRevision!.snapshot,
          solverImplementationId: targetRevision!.solverImplementationId,
          physicsHash: null,
          methodCompatibilityHashVersion: null,
          methodCompatibilityHash: null,
          isCanonicalPhysics: false,
          isCanonicalMethod: false,
        })
        .returning();
      secondRevisionId = secondRevision.id;

      const retryCells = [
        {
          conditionId: `${PREFIX}-batched-capacity-a`,
          revisionId,
          aoaDeg: 11.625,
          speed: SPEED,
        },
        {
          conditionId: `${PREFIX}-batched-capacity-b`,
          revisionId: secondRevision.id,
          aoaDeg: 12.625,
          speed: SPEED + 1,
        },
      ];
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
          engineJobId: `${PREFIX}-batched-capacity-parent`,
          totalCases: retryCells.length,
          completedCases: retryCells.length,
          ingestedAt: new Date(),
          finishedAt: new Date(),
          requestPayload: {
            aoas: retryCells.map((cell) => cell.aoaDeg),
            conditionMap: retryCells.map((cell) => ({
              conditionId: cell.conditionId,
              revisionId: cell.revisionId,
              presetId: targetRevision!.presetId,
              speed: cell.speed,
              reynolds: targetRevision!.reynolds,
              bcId,
              ransRetryScope: {
                origin: "explicit-targeted",
                requestedAoas: [cell.aoaDeg],
              },
            })),
          },
        })
        .returning();
      parentId = parent.id;

      for (const cell of retryCells) {
        const [attempt] = await db
          .insert(resultAttempts)
          .values({
            airfoilId,
            bcId,
            simulationPresetRevisionId: cell.revisionId,
            aoaDeg: cell.aoaDeg,
            simJobId: parent.id,
            engineJobId: parent.engineJobId,
            status: "failed",
            source: "queued",
            regime: "rans",
            validForPolar: false,
            converged: false,
            stalled: true,
            unsteady: false,
            error: "RANS did not converge",
            evidencePayload: { failure_disposition: "hard_solver" },
            solvedAt: new Date(),
          })
          .returning();
        resultAttemptIds.push(attempt.id);
        await db.insert(resultClassifications).values({
          resultAttemptId: attempt.id,
          airfoilId,
          simulationPresetRevisionId: cell.revisionId,
          aoaDeg: cell.aoaDeg,
          regime: "rans",
          classifierVersion: "batched-capacity-v1",
          state: "rejected",
          region: "post_stall",
          confidence: 1,
          reasons: ["not-converged"],
        });
      }

      const captured: PolarRequest[] = [];
      let submitted = 0;
      const engine = {
        submitPolar: async (request: PolarRequest): Promise<JobStatus> => {
          captured.push(request);
          submitted += 1;
          return {
            job_id: `${PREFIX}-batched-capacity-child-${submitted}`,
            state: "pending",
            total_cases: request.aoa?.angles?.length ?? 0,
            completed_cases: 0,
          };
        },
      } as unknown as EngineClient;

      resetUransLadderMemory();
      expect(
        await submitCampaignPrecalcRecoveries(
          db,
          engine,
          [campaignId],
          [parent.id],
          0,
        ),
      ).toBe(true);
      expect(captured).toHaveLength(1);
      let children = await db
        .select()
        .from(simJobs)
        .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
      expect(children).toHaveLength(1);
      childIds.push(children[0].id);
      obligationIds.push(
        ...((
          children[0].requestPayload as {
            precalcObligationIds?: string[];
          }
        ).precalcObligationIds ?? []),
      );

      await db
        .update(simJobs)
        .set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() })
        .where(eq(simJobs.id, children[0].id));
      resetUransLadderMemory();
      expect(
        await submitCampaignPrecalcRecoveries(
          db,
          engine,
          [campaignId],
          [parent.id],
          0,
        ),
      ).toBe(true);
      expect(captured).toHaveLength(2);
      children = await db
        .select()
        .from(simJobs)
        .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
      expect(children).toHaveLength(2);
      for (const child of children) {
        if (!childIds.includes(child.id)) childIds.push(child.id);
        obligationIds.push(
          ...((
            child.requestPayload as {
              precalcObligationIds?: string[];
            }
          ).precalcObligationIds ?? []),
        );
      }
      expect(
        captured
          .map((request) => request.aoa?.angles?.[0])
          .sort((left, right) => Number(left) - Number(right)),
      ).toEqual(retryCells.map((cell) => cell.aoaDeg));
    } finally {
      resetUransLadderMemory();
      if (obligationIds.length) {
        await db
          .delete(simPrecalcObligations)
          .where(inArray(simPrecalcObligations.id, obligationIds));
      }
      if (childIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, childIds));
      }
      if (resultAttemptIds.length) {
        await db
          .delete(resultClassifications)
          .where(
            inArray(resultClassifications.resultAttemptId, resultAttemptIds),
          );
        await db
          .delete(resultAttempts)
          .where(inArray(resultAttempts.id, resultAttemptIds));
      }
      if (parentId) {
        await db.delete(simJobs).where(eq(simJobs.id, parentId));
      }
      if (secondRevisionId) {
        await db
          .delete(simulationPresetRevisions)
          .where(eq(simulationPresetRevisions.id, secondRevisionId));
      }
    }
  }, 120000);

  it("automatically queues exactly one durable continuation and leaves media-only rejection to renderer repair", async () => {
    const aoa = ANGLES[0];
    const [source] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: aoa,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        reynolds: Math.round((SPEED * CHORD) / (1.789e-5 / 1.225)),
        speed: SPEED,
        chord: CHORD,
        cl: 0.7,
        cd: 0.04,
        cm: -0.04,
        unsteady: true,
        converged: true,
        engineJobId: `${PREFIX}-auto-continuation-source`,
        engineCaseSlug: "aoa_4.00",
        qualityWarnings: [
          "URANS integration stopped by the wall-clock budget guard: retained 1.4 of 3 periods (budget)",
        ],
        solvedAt: new Date(),
      })
      .returning();
    await db.insert(resultClassifications).values({
      resultId: source.id,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: aoa,
      regime: "urans",
      classifierVersion: "auto-continuation-test-v1",
      state: "rejected",
      region: "post_stall",
      confidence: 0.8,
      reasons: ["insufficient-periods"],
    });
    const sourceAttemptId = await attachRestartableContinuationAttempt({
      resultId: source.id,
      aoaDeg: aoa,
      engineJobId: source.engineJobId,
      engineCaseSlug: source.engineCaseSlug,
      qualityWarnings: source.qualityWarnings ?? [],
    });
    await db
      .update(simCampaignPoints)
      .set({
        state: "terminal",
        resultId: source.id,
        resultAttemptId: sourceAttemptId,
      })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, aoa),
        ),
      );

    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        campaignId,
      }),
    ).toBe(0);
    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        campaignId,
      }),
    ).toBe(0);
    let requests = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.continueFromResultId, source.id));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      state: "pending",
      requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      continueFromResultId: source.id,
      continueFromResultAttemptId: sourceAttemptId,
      budgetOverrideS: AUTO_PRECALC_CONTINUATION_BUDGET_S,
    });
    expect(
      await db
        .select({
          campaignId: simUransRequestCampaigns.campaignId,
          state: simUransRequestCampaigns.state,
        })
        .from(simUransRequestCampaigns)
        .where(eq(simUransRequestCampaigns.requestId, requests[0].id)),
    ).toEqual([{ campaignId, state: "active" }]);
    const tiers = await campaignOpenTierCounts(db, campaignId);
    expect(tiers.precalcOpen).toBeGreaterThanOrEqual(1);

    // A campaign already surfaced as attention must not look settled while
    // its automatic continuation is still open.
    await db
      .update(simCampaigns)
      .set({ status: "attention" })
      .where(eq(simCampaigns.id, campaignId));
    await probeCampaignCompletion(db, campaignId);
    let [campaign] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
    expect(campaign.status).toBe("attention");

    // A settled request remains durable history and suppresses another after
    // a process restart/repeated cache refresh.
    await db
      .update(simUransRequests)
      .set({ state: "done" })
      .where(eq(simUransRequests.id, requests[0].id));
    await enqueuePrecalcVerifications(db, {
      airfoilId,
      revisionId,
      campaignId,
    });
    requests = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.continueFromResultId, source.id));
    expect(requests).toHaveLength(1);

    // Once the continued evidence is accepted and no automatic work remains,
    // the same probe is allowed to close an attention campaign cleanly.
    await db
      .update(resultClassifications)
      .set({ state: "accepted", reasons: [] })
      .where(
        or(
          eq(resultClassifications.resultId, source.id),
          eq(resultClassifications.resultAttemptId, sourceAttemptId),
        ),
      );
    await probeCampaignCompletion(db, campaignId);
    [campaign] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
    expect(campaign.status).toBe("completed");
    await db
      .update(simCampaigns)
      .set({ status: "active", completedAt: null })
      .where(eq(simCampaigns.id, campaignId));

    // A cancelled pre-submit composition did not spend the bounded solve. It
    // remains history, but one fresh automatic request is allowed because no
    // physical solver attempt crossed the engine boundary.
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, requests[0].id));
    const [cancelledBeforeSubmit] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: aoa,
        fidelity: "precalc",
        state: "cancelled",
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
        continueFromResultId: source.id,
        continueFromResultAttemptId: sourceAttemptId,
        budgetOverrideS: AUTO_PRECALC_CONTINUATION_BUDGET_S,
      })
      .returning();
    await db.insert(simUransRequestCampaigns).values({
      requestId: cancelledBeforeSubmit.id,
      campaignId,
      state: "active",
    });
    await db
      .update(resultClassifications)
      .set({ state: "rejected", reasons: ["insufficient-periods"] })
      .where(
        or(
          eq(resultClassifications.resultId, source.id),
          eq(resultClassifications.resultAttemptId, sourceAttemptId),
        ),
      );
    await enqueuePrecalcVerifications(db, {
      airfoilId,
      revisionId,
      campaignId,
    });
    requests = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.continueFromResultId, source.id));
    expect(requests).toHaveLength(2);
    expect(
      requests.find((request) => request.id !== cancelledBeforeSubmit.id)
        ?.state,
    ).toBe("pending");

    // Even if the previous request history were removed, an otherwise
    // restartable row rejected ONLY for missing video belongs to bounded media
    // repair. It must not spend another solver budget.
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.continueFromResultId, source.id));
    await db
      .update(resultClassifications)
      .set({ state: "rejected", reasons: ["missing-urans-video"] })
      .where(
        or(
          eq(resultClassifications.resultId, source.id),
          eq(resultClassifications.resultAttemptId, sourceAttemptId),
        ),
      );
    await enqueuePrecalcVerifications(db, {
      airfoilId,
      revisionId,
      campaignId,
    });
    expect(
      await db
        .select({ id: simUransRequests.id })
        .from(simUransRequests)
        .where(eq(simUransRequests.continueFromResultId, source.id)),
    ).toHaveLength(0);

    await db
      .update(simCampaignPoints)
      .set({ resultId: null })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, aoa),
        ),
      );
    await db.delete(results).where(eq(results.id, source.id));
  }, 60000);

  it("MUST-CATCH: automatic PRECALC recovery reuses only the exact pair, replaces only unsubmitted exact-cell composition, and defers whole/running conflicts", async () => {
    const aoa = ANGLES[0];
    const differentAoa = 70.125;
    const [source] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: aoa,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        methodKey: "openfoam.urans",
        solverImplementationId: (
          await db
            .select({
              id: simulationPresetRevisions.solverImplementationId,
            })
            .from(simulationPresetRevisions)
            .where(eq(simulationPresetRevisions.id, revisionId))
        )[0]!.id,
        unsteady: true,
        converged: true,
        engineJobId: `${PREFIX}-auto-exact-source`,
        engineCaseSlug: `aoa_${aoa}`,
        qualityWarnings: [
          `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: exact checkpoint retained`,
        ],
        solvedAt: new Date(),
      })
      .returning();
    const exactAttemptId = await attachRestartableContinuationAttempt({
      resultId: source.id,
      aoaDeg: aoa,
      engineJobId: source.engineJobId,
      engineCaseSlug: source.engineCaseSlug,
      qualityWarnings: source.qualityWarnings ?? [],
    });
    const [differentSource] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: differentAoa,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        unsteady: true,
        converged: true,
        engineJobId: `${PREFIX}-auto-different-source`,
        engineCaseSlug: `aoa_${differentAoa}`,
        qualityWarnings: [
          `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: different checkpoint retained`,
        ],
        solvedAt: new Date(),
      })
      .returning();
    const differentAttemptId = await attachRestartableContinuationAttempt({
      resultId: differentSource.id,
      aoaDeg: differentAoa,
      engineJobId: differentSource.engineJobId,
      engineCaseSlug: differentSource.engineCaseSlug,
      qualityWarnings: differentSource.qualityWarnings ?? [],
    });
    await db
      .update(simCampaignPoints)
      .set({
        state: "terminal",
        resultId: source.id,
        resultAttemptId: exactAttemptId,
      })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, aoa),
        ),
      );

    const runAutomaticComposition = () =>
      enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        campaignId,
      });
    const exactRows = () =>
      db
        .select()
        .from(simUransRequests)
        .where(
          and(
            eq(simUransRequests.airfoilId, airfoilId),
            eq(simUransRequests.revisionId, revisionId),
            eq(simUransRequests.aoaDeg, aoa),
            inArray(simUransRequests.state, ["pending", "running"]),
          ),
        );
    const clearRequests = async () => {
      await db
        .delete(simUransRequests)
        .where(
          and(
            eq(simUransRequests.airfoilId, airfoilId),
            eq(simUransRequests.revisionId, revisionId),
          ),
        );
    };

    // A fresh, unsubmitted exact-cell composition is reversible. Automatic
    // recovery replaces it atomically with the immutable exact pair.
    const [fresh] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: aoa,
        fidelity: "precalc",
        state: "pending",
        backgroundOwner: true,
        requestedBy: `${PREFIX}-fresh-conflict`,
      })
      .returning();
    await runAutomaticComposition();
    const [cancelledFresh] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, fresh.id));
    expect(cancelledFresh.state).toBe("cancelled");
    expect(await exactRows()).toEqual([
      expect.objectContaining({
        continueFromResultId: source.id,
        continueFromResultAttemptId: exactAttemptId,
      }),
    ]);
    await clearRequests();

    // A pending different-generation composition has not crossed submission,
    // so it may also be replaced — but never retargeted in place.
    const [differentPending] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: aoa,
        fidelity: "precalc",
        state: "pending",
        backgroundOwner: true,
        requestedBy: `${PREFIX}-different-pending`,
        continueFromResultId: differentSource.id,
        continueFromResultAttemptId: differentAttemptId,
      })
      .returning();
    await runAutomaticComposition();
    const [cancelledDifferent] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, differentPending.id));
    expect(cancelledDifferent.state).toBe("cancelled");
    expect(await exactRows()).toEqual([
      expect.objectContaining({
        continueFromResultId: source.id,
        continueFromResultAttemptId: exactAttemptId,
      }),
    ]);
    await clearRequests();

    // A running different generation crossed the physical boundary. It owns
    // the cell until settlement and cannot be silently retargeted.
    const [running] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: aoa,
        fidelity: "precalc",
        state: "running",
        backgroundOwner: true,
        requestedBy: `${PREFIX}-different-running`,
        continueFromResultId: differentSource.id,
        continueFromResultAttemptId: differentAttemptId,
      })
      .returning();
    await runAutomaticComposition();
    expect(await exactRows()).toEqual([
      expect.objectContaining({
        id: running.id,
        continueFromResultId: differentSource.id,
        continueFromResultAttemptId: differentAttemptId,
      }),
    ]);
    await clearRequests();

    // Whole-polar work is a different composition and covers this angle. It
    // is neither replaced nor joined to the exact continuation.
    const [whole] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: null,
        fidelity: "precalc",
        state: "pending",
        backgroundOwner: true,
        requestedBy: `${PREFIX}-whole-conflict`,
      })
      .returning();
    await runAutomaticComposition();
    expect(await exactRows()).toEqual([]);
    const [unchangedWhole] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, whole.id));
    expect(unchangedWhole).toMatchObject({
      state: "pending",
      aoaDeg: null,
      continueFromResultId: null,
      continueFromResultAttemptId: null,
    });
    await clearRequests();

    await db
      .update(simCampaignPoints)
      .set({ resultId: null, resultAttemptId: null })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, aoa),
        ),
      );
    await db
      .delete(results)
      .where(inArray(results.id, [source.id, differentSource.id]));
  }, 120000);

  it("enqueues ONE verify item per precalc-accepted point, including steady-equivalent no-shedding evidence", async () => {
    // A no-shedding URANS result is physically steady and therefore carries
    // regime='rans', but fidelity still records that the preliminary URANS
    // tier produced it. Contract 4 keys verification on that fidelity.
    const [row] = await db
      .update(results)
      .set({
        regime: "rans",
        fidelity: "urans_precalc",
        cl: 1.0,
        cd: 0.05,
        cm: -0.06,
        unsteady: false,
        converged: true,
      })
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, revisionId),
          eq(results.aoaDeg, REJECTED_AOA),
        ),
      )
      .returning();
    expect(row.currentResultAttemptId).toBeTruthy();
    await db
      .update(resultAttempts)
      .set({
        regime: "rans",
        cl: 1.0,
        cd: 0.05,
        cm: -0.06,
        clCd: 20,
        unsteady: false,
        converged: true,
      })
      .where(eq(resultAttempts.id, row.currentResultAttemptId!));
    await db
      .update(resultClassifications)
      .set({
        regime: "rans",
        classifierVersion: "fidelity-ladder-v4",
        state: "accepted",
        region: "post_stall",
        confidence: 0.9,
        reasons: [],
      })
      .where(
        eq(resultClassifications.resultAttemptId, row.currentResultAttemptId!),
      );
    await attachExistingAcceptedRestartArchive(
      row.id,
      row.currentResultAttemptId!,
    );
    // Link the campaign point so completion/tier logic sees the cell.
    await db
      .update(simCampaignPoints)
      .set({
        resultId: row.id,
        resultAttemptId: row.currentResultAttemptId!,
      })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, REJECTED_AOA),
        ),
      );

    const first = await enqueuePrecalcVerifications(db, {
      airfoilId,
      revisionId,
      campaignId,
    });
    expect(first).toBe(1);
    const second = await enqueuePrecalcVerifications(db, {
      airfoilId,
      revisionId,
      campaignId,
    });
    expect(second).toBe(0);
    const items = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.revisionId, revisionId));
    expect(items.length).toBe(1);
    expect(items[0].state).toBe("pending");
    expect(items[0].campaignId).toBeNull();
    expect(items[0].backgroundOwner).toBe(false);
    expect(items[0].precalcResultId).toBe(row.id);
    expect(items[0].precalcResultAttemptId).toBe(row.currentResultAttemptId);
    expect(
      await db
        .select({
          campaignId: simUransVerifyQueueCampaigns.campaignId,
          state: simUransVerifyQueueCampaigns.state,
        })
        .from(simUransVerifyQueueCampaigns)
        .where(eq(simUransVerifyQueueCampaigns.queueId, items[0].id)),
    ).toEqual([{ campaignId, state: "active" }]);

    // Phase: no RANS gaps, no precalc obligations left, one open verify item.
    const tiers = await campaignOpenTierCounts(db, campaignId);
    expect(tiers.verifyOpen).toBe(1);
    expect(deriveCampaignPhase("active", tiers)).toBe("running_refinement");
    const summary = await campaignSummary(db, campaignId);
    expect(summary.tierCounts.verifyOpen).toBe(1);
    expect(summary.phase).toBe("running_refinement");
  }, 60000);

  it("VERIFY ORDER MUST-CATCH: a final admin request without a baseline runs fast URANS before an unrelated verify item", async () => {
    const requestedAoa = 40.625;
    const { request, created } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: requestedAoa,
      fidelity: "full",
      requestedBy: "test@airfoils.pro",
    });
    expect(created).toBe(true);

    const captured: PolarRequest[] = [];
    const submitted = await uransLadderTick(
      db,
      stubEngine(captured, `${PREFIX}-request-job`),
      0,
      await ladderScope(),
    );
    expect(submitted).toBe(true);
    expect(captured.length).toBe(1);
    // A final request owns the same point journey as automatic work. With no
    // accepted preliminary baseline it must execute fast URANS first, never a
    // direct full-fidelity bypass.
    expect(captured[0].solver).toMatchObject({
      force_transient: true,
      transient_fallback: true,
      warm_start: false,
      urans_fidelity: "precalc",
    });
    expect(captured[0].expected_mesh_recovery_version).toBe(0);
    expect(captured[0].aoa?.angles).toEqual([requestedAoa]);
    const [afterRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    expect(afterRequest.state).toBe("running");
    expect(afterRequest.simJobId).toBeTruthy();
    // The verify item was NOT consumed while precalc-rank work existed.
    const [item] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.revisionId, revisionId));
    expect(item.state).toBe("pending");

    // Settle the request job so the verify tier can open up.
    await db
      .update(simJobs)
      .set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() })
      .where(eq(simJobs.id, afterRequest.simJobId!));
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    await db
      .delete(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, airfoilId),
          eq(simPrecalcObligations.revisionId, revisionId),
          eq(simPrecalcObligations.aoaDeg, requestedAoa),
        ),
      );
    // Subsequent admin-request contract tests intentionally reuse this exact
    // immutable cell. Their explicit-request semantics are independent of the
    // direct-ingest obligation proven above.
    await db
      .delete(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, airfoilId),
          eq(simPrecalcObligations.revisionId, revisionId),
          eq(simPrecalcObligations.aoaDeg, REJECTED_AOA),
        ),
      );
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
    let requestStateAtEngineCall: string | null = null;
    const engine = {
      submitPolar: async (polarRequest: PolarRequest): Promise<JobStatus> => {
        const [owned] = await db
          .select({ state: simUransRequests.state })
          .from(simUransRequests)
          .where(eq(simUransRequests.id, request.id));
        requestStateAtEngineCall = owned?.state ?? null;
        captured.push(polarRequest);
        return {
          job_id: `${PREFIX}-precalc-request-job`,
          state: "pending",
          total_cases: polarRequest.aoa?.angles?.length ?? 0,
          completed_cases: 0,
        };
      },
    } as unknown as EngineClient;
    const submitted = await uransLadderTick(db, engine, 0, {
      ...(await ladderScope()),
      // A known version-1 engine remains eligible for ordinary first-pass
      // PRECALC work. Only continuation/corrective recovery requires v2.
      uransRecoveryVersion: 1,
    });
    expect(submitted).toBe(true);
    expect(captured.length).toBe(1);
    expect(requestStateAtEngineCall).toBe("running");
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
    expect(captured[0].expected_mesh_recovery_version).toBe(0);
    expect(captured[0].expected_urans_recovery_version).toBeUndefined();
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
    const snapshotMesh = (
      revision!.snapshot as {
        mesh: { nSurface: number; nRadial: number; nWake: number };
      }
    ).mesh;
    expect(captured[0].mesh?.n_surface).toBe(snapshotMesh.nSurface);
    expect(captured[0].mesh?.n_radial).toBe(snapshotMesh.nRadial);
    expect(captured[0].mesh?.n_wake).toBe(snapshotMesh.nWake);

    const [afterRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    expect(afterRequest.state).toBe("running");
    expect(afterRequest.simJobId).toBeTruthy();
    const [job] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, afterRequest.simJobId!));
    expect(job.wave).toBe(2);
    expect(job.jobKind).toBe("targeted");
    const payload = job.requestPayload as {
      uransFidelity?: string;
      uransRequestId?: string;
    };
    expect(payload.uransFidelity).toBe("precalc");
    expect(payload.uransRequestId).toBe(request.id);

    // Settle so the later verify-tier tests see a quiet machine.
    await db
      .update(simJobs)
      .set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() })
      .where(eq(simJobs.id, afterRequest.simJobId!));
    await db
      .update(simUransRequests)
      .set({ state: "done" })
      .where(eq(simUransRequests.id, request.id));
    await db
      .delete(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, airfoilId),
          eq(simPrecalcObligations.revisionId, revisionId),
          eq(simPrecalcObligations.aoaDeg, REJECTED_AOA),
        ),
      );
  }, 60000);

  it("CAPABILITY GATE MUST-CATCH: malformed PRECALC capability fails closed for both preliminary work and a final request that requires it", async () => {
    const precalc = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: 41,
      fidelity: "precalc",
      requestedBy: `${PREFIX}-capability-precalc`,
    });
    const full = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: 42,
      fidelity: "full",
      requestedBy: `${PREFIX}-capability-full`,
    });
    const captured: PolarRequest[] = [];
    const submitted = await uransLadderTick(
      db,
      stubEngine(captured, `${PREFIX}-capability-full-job`),
      0,
      {
        campaignIds: [],
        parentJobIds: [],
        promotionIds: [],
        requestIds: [precalc.request.id, full.request.id],
        verifyIds: [],
        meshRecoveryVersion: null,
      },
    );
    expect(submitted).toBe(false);
    expect(captured).toHaveLength(0);
    const requests = await db
      .select({ id: simUransRequests.id, state: simUransRequests.state })
      .from(simUransRequests)
      .where(
        inArray(simUransRequests.id, [precalc.request.id, full.request.id]),
      );
    expect(requests).toEqual(
      expect.arrayContaining([
        { id: precalc.request.id, state: "pending" },
        { id: full.request.id, state: "pending" },
      ]),
    );
    await db
      .delete(simUransRequests)
      .where(
        inArray(simUransRequests.id, [precalc.request.id, full.request.id]),
      );
    await db
      .delete(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, airfoilId),
          eq(simPrecalcObligations.revisionId, revisionId),
          inArray(simPrecalcObligations.aoaDeg, [41, 42]),
        ),
      );
  }, 60000);

  it("CAPABILITY GATE MUST-CATCH: orphan healing runs before a closed PRECALC capability gate", async () => {
    const created = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: 43,
      fidelity: "precalc",
      requestedBy: `${PREFIX}-capability-orphan`,
    });
    const claimed = await claimNextPendingUransRequest(db, {
      requestIds: [created.request.id],
    });
    expect(claimed?.id).toBe(created.request.id);
    const [orphanJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "pending",
        engineState: "submitting",
        totalCases: 1,
        requestPayload: {
          uransRequestId: created.request.id,
          uransFidelity: "precalc",
          aoas: [43],
        },
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({
        state: "running",
        simJobId: orphanJob.id,
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .where(eq(simUransRequests.id, created.request.id));

    const captured: PolarRequest[] = [];
    expect(
      await uransLadderTick(
        db,
        stubEngine(captured, `${PREFIX}-must-not-submit-precalc`),
        0,
        {
          campaignIds: [],
          parentJobIds: [],
          promotionIds: [],
          requestIds: [created.request.id],
          verifyIds: [],
          meshRecoveryVersion: null,
        },
      ),
    ).toBe(false);
    expect(captured).toHaveLength(0);
    const [healed] = await db
      .select({
        state: simUransRequests.state,
        simJobId: simUransRequests.simJobId,
      })
      .from(simUransRequests)
      .where(eq(simUransRequests.id, created.request.id));
    expect(healed).toEqual({ state: "pending", simJobId: null });
    const [cancelledJob] = await db
      .select({ status: simJobs.status })
      .from(simJobs)
      .where(eq(simJobs.id, orphanJob.id));
    expect(cancelledJob?.status).toBe("cancelled");
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, created.request.id));
  }, 60000);

  it("request-URANS is idempotent for an exact preliminary cell and a whole-polar final request", async () => {
    const exactAoa = 45.125;
    const a = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: exactAoa,
      fidelity: "precalc",
    });
    expect(a.created).toBe(true);
    const b = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: exactAoa,
      fidelity: "precalc",
    });
    expect(b.created).toBe(false);
    expect(b.request.id).toBe(a.request.id);
    // A whole-polar final request is a different aggregate owner.
    const c = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: null,
      fidelity: "full",
    });
    expect(c.created).toBe(true);
    expect(c.request.id).not.toBe(a.request.id);
    // Clean these up so they do not feed the verify-order checks below.
    await db
      .delete(simUransRequests)
      .where(inArray(simUransRequests.id, [a.request.id, c.request.id]));
  }, 60000);

  it("serializes exact/whole final-request coverage in both orders and never leaves overlapping open requests", async () => {
    const exactFirst = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: 31,
      fidelity: "full",
    });
    await expect(
      createUransRequest(db, {
        airfoilId,
        revisionId,
        aoaDeg: null,
        fidelity: "full",
      }),
    ).rejects.toBeInstanceOf(UransRequestCoverageConflict);
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, exactFirst.request.id));

    const wholeFirst = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: null,
      fidelity: "full",
    });
    const coveredExact = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: 32,
      fidelity: "full",
    });
    expect(coveredExact).toMatchObject({ created: false });
    expect(coveredExact.request.id).toBe(wholeFirst.request.id);
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, wholeFirst.request.id));

    async function assertConcurrentOrder(
      aoaDeg: number,
      wholeFirstInCallOrder: boolean,
    ) {
      const exact = () =>
        createUransRequest(db, {
          airfoilId,
          revisionId,
          aoaDeg,
          fidelity: "full",
        });
      const whole = () =>
        createUransRequest(db, {
          airfoilId,
          revisionId,
          aoaDeg: null,
          fidelity: "full",
        });
      const settled = await Promise.allSettled(
        wholeFirstInCallOrder ? [whole(), exact()] : [exact(), whole()],
      );
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          expect(outcome.reason).toBeInstanceOf(UransRequestCoverageConflict);
        }
      }
      const open = await db
        .select()
        .from(simUransRequests)
        .where(
          and(
            eq(simUransRequests.airfoilId, airfoilId),
            eq(simUransRequests.revisionId, revisionId),
            eq(simUransRequests.fidelity, "full"),
            inArray(simUransRequests.state, ["pending", "running"]),
            dsql`(${simUransRequests.aoaDeg} IS NULL OR ${simUransRequests.aoaDeg} = ${aoaDeg})`,
          ),
        );
      expect(open).toHaveLength(1);
      expect(open[0].aoaDeg == null || open[0].aoaDeg === aoaDeg).toBe(true);
      await db
        .delete(simUransRequests)
        .where(eq(simUransRequests.id, open[0].id));
    }

    await assertConcurrentOrder(33, false);
    await assertConcurrentOrder(34, true);
  }, 60000);

  it("atomically claims one admin request owner and heals its process-death pending composition", async () => {
    const requestAoa = 45.625;
    const created = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: requestAoa,
      fidelity: "precalc",
      requestedBy: `${PREFIX}-claim-owner`,
    });
    expect(created.created).toBe(true);
    const scope = { requestIds: [created.request.id] };
    const [first, second] = await Promise.all([
      claimNextPendingUransRequest(db, scope),
      claimNextPendingUransRequest(db, scope),
    ]);
    expect([first?.id, second?.id].filter(Boolean)).toEqual([
      created.request.id,
    ]);
    const claimed = first ?? second!;
    expect(
      await hasOpenCampaignLadderWork(db, { requestIds: [created.request.id] }),
    ).toBe(true);

    const [orphanJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "pending",
        engineState: "submitting",
        totalCases: 1,
        requestPayload: {
          uransRequestId: claimed.id,
          uransFidelity: "precalc",
          aoas: [requestAoa],
        },
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ state: "done", simJobId: orphanJob.id })
      .where(eq(simUransRequests.id, claimed.id));
    expect(
      await hasOpenCampaignLadderWork(db, { requestIds: [created.request.id] }),
    ).toBe(true);
    await db
      .update(simUransRequests)
      .set({
        state: "running",
        simJobId: orphanJob.id,
        updatedAt: new Date(Date.now() - 10 * 60_000),
      })
      .where(eq(simUransRequests.id, claimed.id));

    expect(await healOrphanedUransRequests(db, scope)).toBe(1);
    const [afterRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, claimed.id));
    const [afterJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, orphanJob.id));
    expect(afterRequest).toMatchObject({ state: "pending", simJobId: null });
    expect(afterJob.status).toBe("cancelled");
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, claimed.id));
  }, 60000);

  it("settles a request when the process dies after a terminal submit/job boundary", async () => {
    const rejectedAoa = 46.125;
    const completedAoa = 46.375;
    const rejected = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: rejectedAoa,
      fidelity: "precalc",
      requestedBy: `${PREFIX}-rejected-submit`,
    });
    const rejectedClaim = await claimNextPendingUransRequest(db, {
      requestIds: [rejected.request.id],
    });
    expect(rejectedClaim?.state).toBe("running");
    const [rejectedJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "failed",
        engineJobId: null,
        totalCases: 1,
        error: "ladder submit failed: engine rejected request",
        requestPayload: {
          uransRequestId: rejected.request.id,
          uransFidelity: "precalc",
          aoas: [rejectedAoa],
        },
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: rejectedJob.id })
      .where(eq(simUransRequests.id, rejected.request.id));

    const completed = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: completedAoa,
      fidelity: "precalc",
      requestedBy: `${PREFIX}-terminal-job`,
    });
    const completedClaim = await claimNextPendingUransRequest(db, {
      requestIds: [completed.request.id],
    });
    expect(completedClaim?.state).toBe("running");
    const [completedJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "done",
        engineJobId: `${PREFIX}-terminal-engine`,
        totalCases: 1,
        completedCases: 1,
        ingestedAt: new Date(),
        finishedAt: new Date(),
        requestPayload: {
          uransRequestId: completed.request.id,
          uransFidelity: "precalc",
          aoas: [completedAoa],
        },
      })
      .returning();
    await db
      .update(simUransRequests)
      .set({ simJobId: completedJob.id })
      .where(eq(simUransRequests.id, completed.request.id));

    expect(
      await healOrphanedUransRequests(db, {
        requestIds: [rejected.request.id, completed.request.id],
      }),
    ).toBe(2);
    const terminalRequests = await db
      .select({ id: simUransRequests.id, state: simUransRequests.state })
      .from(simUransRequests)
      .where(
        inArray(simUransRequests.id, [
          rejected.request.id,
          completed.request.id,
        ]),
      );
    expect(new Map(terminalRequests.map((row) => [row.id, row.state]))).toEqual(
      new Map([
        [rejected.request.id, "cancelled"],
        [completed.request.id, "done"],
      ]),
    );
  }, 60000);

  it("MUST-CATCH: a blocked final generation A yields to accepted preliminary generation B and verifies B against B", async () => {
    // Production's verify gate is machine-wide. This live-DB test supplies a
    // closed request/campaign scope so it proves this fixture's tier ordering
    // without waiting on or consuming another parallel file's legitimate work.
    // Keep one unrelated background obligation open deliberately: without the
    // campaign side of the test scope, this row reproduces the full-parallel
    // failure where another suite's preliminary work blocked this verify item.
    const [generationA] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(
        and(
          eq(simUransVerifyQueue.revisionId, revisionId),
          eq(simUransVerifyQueue.state, "pending"),
        ),
      )
      .limit(1);
    expect(generationA).toBeTruthy();
    await db
      .update(simUransVerifyQueue)
      .set({
        state: "blocked",
        freshAttemptCount: 2,
        maxFreshAttempts: 2,
        continuationAttemptCount: 1,
        lastOutcome: "final_recovery_exhausted",
        lastError: "generation A exhausted",
      })
      .where(eq(simUransVerifyQueue.id, generationA!.id));
    await db
      .update(resultClassifications)
      .set({ resultId: null })
      .where(eq(resultClassifications.resultId, generationA!.precalcResultId));
    const generationBAttemptId = await createAcceptedPrecalcGeneration({
      resultId: generationA!.precalcResultId,
      aoaDeg: REJECTED_AOA,
      label: "generation-b-precalc",
      cl: 1,
      cd: 0.05,
      cm: -0.06,
    });
    await db
      .update(results)
      .set({
        currentResultAttemptId: generationBAttemptId,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 1,
        cd: 0.05,
        cm: -0.06,
        clCd: 20,
        converged: true,
        unsteady: true,
      })
      .where(eq(results.id, generationA!.precalcResultId));
    await db
      .update(simCampaignPoints)
      .set({
        state: "terminal",
        resultId: generationA!.precalcResultId,
        resultAttemptId: generationBAttemptId,
      })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.aoaDeg, REJECTED_AOA),
        ),
      );
    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        campaignId,
        aoaDeg: REJECTED_AOA,
      }),
    ).toBe(1);
    const [pendingVerify] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(
        and(
          eq(simUransVerifyQueue.precalcResultAttemptId, generationBAttemptId),
          eq(simUransVerifyQueue.state, "pending"),
        ),
      )
      .limit(1);
    expect(pendingVerify).toMatchObject({
      state: "pending",
      freshAttemptCount: 0,
      continuationAttemptCount: 0,
      precalcResultId: generationA!.precalcResultId,
      precalcResultAttemptId: generationBAttemptId,
    });

    const [unrelatedObligation] = await db
      .insert(simPrecalcObligations)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: 77.125,
        state: "pending",
        backgroundOwner: true,
      })
      .returning({ id: simPrecalcObligations.id });
    const captured: PolarRequest[] = [];
    let submitted = false;
    const [pinnedPrecalc] = await db
      .select({
        resultId: resultAttempts.resultId,
        airfoilId: resultAttempts.airfoilId,
        revisionId: resultAttempts.simulationPresetRevisionId,
        aoaDeg: resultAttempts.aoaDeg,
        status: resultAttempts.status,
        source: resultAttempts.source,
        fidelity: dsql<
          string | null
        >`${resultAttempts.evidencePayload} ->> 'fidelity'`,
        classification: resultClassifications.state,
      })
      .from(resultAttempts)
      .leftJoin(
        resultClassifications,
        eq(resultClassifications.resultAttemptId, resultAttempts.id),
      )
      .where(eq(resultAttempts.id, pendingVerify!.precalcResultAttemptId!));
    expect(pinnedPrecalc).toMatchObject({
      resultId: pendingVerify!.precalcResultId,
      airfoilId: pendingVerify!.airfoilId,
      revisionId: pendingVerify!.revisionId,
      aoaDeg: pendingVerify!.aoaDeg,
      status: "done",
      source: "solved",
      fidelity: "urans_precalc",
      classification: "accepted",
    });
    expect(await precalcSnapshotForVerifyItem(db, pendingVerify!)).toEqual({
      resultAttemptId: pendingVerify!.precalcResultAttemptId,
      cl: 1,
      cd: 0.05,
      cm: -0.06,
    });
    // The natural-cell projection is mutable and may already reflect another
    // generation. Submission must still copy generation B's exact immutable
    // coefficients into the final job.
    await db
      .update(results)
      .set({ cl: 9.9, cd: 8.8, cm: 7.7 })
      .where(eq(results.id, pendingVerify!.precalcResultId));
    try {
      submitted = await uransLadderTick(
        db,
        stubEngine(captured, `${PREFIX}-verify-job`),
        0,
        {
          campaignIds: [campaignId],
          requestIds: [],
          verifyIds: [pendingVerify!.id],
        },
      );
    } finally {
      await db
        .delete(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, unrelatedObligation.id));
    }
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

    const [item] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, pendingVerify!.id));
    expect(item.state).toBe("running");
    const [verifyJob] = await db
      .select()
      .from(simJobs)
      .where(dsql`request_payload ->> 'verifyQueueItemId' = ${item.id}`);
    expect(verifyJob).toBeTruthy();
    expect(verifyJob.jobKind).toBe("verify");
    expect(item.simJobId).toBe(verifyJob.id);
    expect(verifyJob.requestPayload).toMatchObject({
      verifyPrecalcResultAttemptId: generationBAttemptId,
      verifyPrecalc: { cl: 1, cd: 0.05, cm: -0.06 },
    });
    // Settlement also re-reads the queue-pinned attempt instead of trusting a
    // mutable/stale coefficient copy on the job payload.
    await db
      .update(simJobs)
      .set({
        requestPayload: {
          ...(verifyJob.requestPayload as Record<string, unknown>),
          verifyPrecalc: { cl: -9, cd: -8, cm: -7 },
        },
      })
      .where(eq(simJobs.id, verifyJob.id));

    // Completion blocking (contract 7): every cell terminal, but the open
    // verify item must keep the campaign from flipping completed.
    await probeCampaignCompletion(db, campaignId);
    const [beforeCampaign] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
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
              frame_track:
                frameTrackFixture() as unknown as PolarPoint["frame_track"],
              images: {},
              video: {
                velocity_magnitude: `/jobs/${PREFIX}-verify-job/files/cases/a0/images/velocity_magnitude.mp4`,
              },
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
      getResult: async () => withExactManifestEvidence(verified),
      fileUrl: (id: string, relPath: string) =>
        `http://engine.test/jobs/${id}/files/${relPath}`,
    } as unknown as EngineClient;
    await reconcile(db, verifyEngine, {
      jobIds: [verifyJob.id],
      skipFailedRecovery: true,
    });

    const [settled] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, item.id));
    expect(settled.state).toBe("disagreed");
    expect(settled.deltaCl).toBeCloseTo(0.2, 6);
    expect(settled.deltaCd).toBeCloseTo(0.005, 6);
    expect(settled.verifyResultId).toBeTruthy();

    // The classification stays on the selected VERIFIED attempt (now the
    // full-fidelity projection). Machine disagreement belongs to the queue
    // state/deltas above; immutable solver-attempt warnings are not rewritten.
    const [verifiedRow] = await db
      .select()
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, revisionId),
          eq(results.aoaDeg, REJECTED_AOA),
        ),
      );
    expect(verifiedRow.fidelity).toBe("urans_full");
    expect(verifiedRow.cl).toBeCloseTo(1.2, 6);
    // No re-enqueue: the cell is full-fidelity now, so the enqueue predicate
    // no longer matches.
    const itemsAfter = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.revisionId, revisionId));
    expect(itemsAfter).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: generationA!.id,
          state: "blocked",
          precalcResultAttemptId: generationA!.precalcResultAttemptId,
        }),
        expect.objectContaining({
          id: item.id,
          state: "disagreed",
          precalcResultAttemptId: generationBAttemptId,
        }),
      ]),
    );
    expect(itemsAfter).toHaveLength(2);

    // All three tiers terminal now → the completion probe may settle the
    // campaign (the verified row classifies at refresh; whatever the verdict,
    // the ladder no longer blocks).
    const tiers = await campaignOpenTierCounts(db, campaignId);
    expect(tiers.verifyOpen).toBe(0);
  }, 300000);
});

describe("bounded final-verification interleave during a live RANS backlog", () => {
  async function seedPendingVerify(
    label: string,
    aoaDeg: number,
    createdAt: Date,
  ): Promise<{ resultId: string; queueId: string }> {
    const [precalc] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.72,
        cd: 0.041,
        cm: -0.038,
        clCd: 0.72 / 0.041,
        converged: true,
        unsteady: true,
        engineJobId: `${PREFIX}-${label}-precalc`,
        solvedAt: createdAt,
        createdAt,
      })
      .returning({ id: results.id });
    const precalcResultAttemptId = await createAcceptedPrecalcGeneration({
      resultId: precalc.id,
      aoaDeg,
      label: `${label}-precalc-attempt`,
      cl: 0.72,
      cd: 0.041,
      cm: -0.038,
      createdAt,
    });
    const [queue] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId,
        aoaDeg,
        state: "pending",
        precalcResultId: precalc.id,
        precalcResultAttemptId,
        backgroundOwner: false,
        createdAt,
      })
      .returning({ id: simUransVerifyQueue.id });
    await db.insert(simUransVerifyQueueCampaigns).values({
      queueId: queue.id,
      campaignId,
      state: "active",
      createdAt,
    });
    return { resultId: precalc.id, queueId: queue.id };
  }

  async function seedWave1Admissions(
    label: string,
    submittedTimes: Date[],
  ): Promise<string[]> {
    if (!submittedTimes.length) return [];
    return (
      await db
        .insert(simJobs)
        .values(
          submittedTimes.map((submittedAt, index) => ({
            airfoilId,
            bcIds: [bcId],
            simulationPresetRevisionId: revisionId,
            campaignId,
            methodKey: "openfoam.rans",
            jobKind: "sweep",
            referenceChordM: CHORD,
            wave: 1,
            status: "done" as const,
            engineJobId: `${PREFIX}-${label}-${index}`,
            totalCases: 1,
            completedCases: 1,
            submittedAt,
            finishedAt: submittedAt,
            createdAt: submittedAt,
            requestPayload: { aoas: [4] },
          })),
        )
        .returning({ id: simJobs.id })
    ).map((row) => row.id);
  }

  it("MUST-CATCH: the eighth admitted wave-1 job makes one pending final verification own the next eligible slot", async () => {
    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, campaignId));
    const baseMs = Date.now() - 60 * 60_000;
    const seeded = await seedPendingVerify(
      "bounded-next-slot",
      61.125,
      new Date(baseMs),
    );
    const cleanupJobIds: string[] = [];
    try {
      cleanupJobIds.push(
        ...(await seedWave1Admissions(
          "bounded-first-seven",
          Array.from(
            { length: 7 },
            (_, index) => new Date(baseMs + (index + 1) * 1000),
          ),
        )),
      );
      const scope = () => ({
        campaignIds: [campaignId],
        verifyIds: [seeded.queueId],
        wave1JobIds: cleanupJobIds,
      });
      expect(await finalVerifyInterleaveDecision(db, scope())).toMatchObject({
        due: false,
        wave1AdmissionsSinceOpportunity: 7,
      });

      // A local composition/answered failure is not an admitted RANS job and
      // cannot spend the fairness allowance.
      const [unsubmitted] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          campaignId,
          methodKey: "openfoam.rans",
          jobKind: "sweep",
          referenceChordM: CHORD,
          wave: 1,
          status: "failed",
          totalCases: 1,
          completedCases: 0,
          error: "engine rejected before admission",
          finishedAt: new Date(baseMs + 8000),
          createdAt: new Date(baseMs + 8000),
          requestPayload: { aoas: [4] },
        })
        .returning({ id: simJobs.id });
      cleanupJobIds.push(unsubmitted.id);
      expect(await finalVerifyInterleaveDecision(db, scope())).toMatchObject({
        due: false,
        wave1AdmissionsSinceOpportunity: 7,
      });

      cleanupJobIds.push(
        ...(await seedWave1Admissions("bounded-eighth", [
          new Date(baseMs + 9000),
        ])),
      );
      const due = await finalVerifyInterleaveDecision(db, scope());
      expect(due).toMatchObject({
        due: true,
        wave1AdmissionsSinceOpportunity: MAX_WAVE1_ADMISSIONS_BEFORE_VERIFY,
      });

      const captured: PolarRequest[] = [];
      expect(
        await submitInterleavedVerifyIfDue(
          db,
          stubEngine(captured, `${PREFIX}-bounded-verify`),
          0,
          scope(),
        ),
      ).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0].solver).toMatchObject({
        force_transient: true,
        urans_fidelity: "full",
      });
      expect(captured[0].aoa?.angles).toEqual([61.125]);
      const [claimed] = await db
        .select({
          state: simUransVerifyQueue.state,
          simJobId: simUransVerifyQueue.simJobId,
        })
        .from(simUransVerifyQueue)
        .where(eq(simUransVerifyQueue.id, seeded.queueId));
      expect(claimed.state).toBe("running");
      expect(claimed.simJobId).toBeTruthy();
      cleanupJobIds.push(claimed.simJobId!);
    } finally {
      await db
        .delete(simUransVerifyQueue)
        .where(eq(simUransVerifyQueue.id, seeded.queueId));
      await db.delete(results).where(eq(results.id, seeded.resultId));
      if (cleanupJobIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, cleanupJobIds));
      }
    }
  }, 120000);

  it("FALSE-POSITIVE: a latest admitted verify resets durable history, and seven later RANS admissions remain below the bound", async () => {
    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, campaignId));
    const baseMs = Date.now() - 2 * 60 * 60_000;
    const seeded = await seedPendingVerify(
      "restart-history",
      62.125,
      new Date(baseMs),
    );
    const cleanupJobIds: string[] = [];
    try {
      cleanupJobIds.push(
        ...(await seedWave1Admissions(
          "restart-old-rans",
          Array.from(
            { length: 8 },
            (_, index) => new Date(baseMs + (index + 1) * 1000),
          ),
        )),
      );
      const latestVerifyAt = new Date(baseMs + 20_000);
      const [latestVerify] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          campaignId: null,
          jobKind: "verify",
          referenceChordM: CHORD,
          wave: 2,
          status: "done",
          engineJobId: `${PREFIX}-restart-latest-verify`,
          totalCases: 1,
          completedCases: 1,
          submittedAt: latestVerifyAt,
          finishedAt: latestVerifyAt,
          createdAt: latestVerifyAt,
          requestPayload: { verifyQueueItemId: seeded.queueId },
        })
        .returning({ id: simJobs.id });
      cleanupJobIds.push(latestVerify.id);

      const scope = () => ({
        campaignIds: [campaignId],
        verifyIds: [seeded.queueId],
        wave1JobIds: cleanupJobIds.filter((id) => id !== latestVerify.id),
      });
      const reset = await finalVerifyInterleaveDecision(db, scope());
      expect(reset).toMatchObject({
        due: false,
        wave1AdmissionsSinceOpportunity: 0,
      });
      expect(reset.latestVerifySubmittedAt?.getTime()).toBe(
        latestVerifyAt.getTime(),
      );

      cleanupJobIds.push(
        ...(await seedWave1Admissions(
          "restart-next-seven",
          Array.from(
            { length: 7 },
            (_, index) => new Date(baseMs + (21 + index) * 1000),
          ),
        )),
      );
      expect(await finalVerifyInterleaveDecision(db, scope())).toMatchObject({
        due: false,
        wave1AdmissionsSinceOpportunity: 7,
      });

      cleanupJobIds.push(
        ...(await seedWave1Admissions("restart-next-eighth", [
          new Date(baseMs + 28_000),
        ])),
      );
      expect(await finalVerifyInterleaveDecision(db, scope())).toMatchObject({
        due: true,
        wave1AdmissionsSinceOpportunity: MAX_WAVE1_ADMISSIONS_BEFORE_VERIFY,
      });
    } finally {
      await db
        .delete(simUransVerifyQueue)
        .where(eq(simUransVerifyQueue.id, seeded.queueId));
      await db.delete(results).where(eq(results.id, seeded.resultId));
      if (cleanupJobIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, cleanupJobIds));
      }
    }
  }, 120000);
});

describe("final/full URANS automatic recovery", () => {
  it("MUST-CATCH: pre-submit exhausted and incompatible-checkpoint claims persist critical final incidents only after their fenced block succeeds", async () => {
    const [targetRevision] = await db
      .select({
        solverImplementationId:
          simulationPresetRevisions.solverImplementationId,
      })
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, revisionId))
      .limit(1);
    expect(targetRevision?.solverImplementationId).toBeTruthy();
    const sourceSolverImplementationId =
      targetRevision!.solverImplementationId ===
      OPENCFD_2406_SOLVER_IMPLEMENTATION_ID
        ? OPENCFD_2606_SOLVER_IMPLEMENTATION_ID
        : OPENCFD_2406_SOLVER_IMPLEMENTATION_ID;
    const resultIds: string[] = [];
    const queueIds: string[] = [];
    const jobIds: string[] = [];
    const captured: PolarRequest[] = [];
    const seedPrecalc = async (aoaDeg: number, label: string) => {
      const [precalc] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg,
          status: "done",
          source: "solved",
          regime: "urans",
          fidelity: "urans_precalc",
          cl: 0.8,
          cd: 0.05,
          cm: -0.04,
          clCd: 16,
          converged: true,
          unsteady: true,
          engineJobId: `${PREFIX}-${label}-precalc`,
          engineCaseSlug: `aoa_${aoaDeg}`,
          solvedAt: new Date(),
        })
        .returning();
      resultIds.push(precalc.id);
      const precalcResultAttemptId = await createAcceptedPrecalcGeneration({
        resultId: precalc.id,
        aoaDeg,
        label: `${label}-attempt`,
        cl: 0.8,
        cd: 0.05,
        cm: -0.04,
      });
      return { ...precalc, precalcResultAttemptId };
    };
    try {
      const exhaustedPrecalc = await seedPrecalc(
        64.125,
        "final-presubmit-exhausted",
      );
      const [exhaustedQueue] = await db
        .insert(simUransVerifyQueue)
        .values({
          airfoilId,
          revisionId,
          aoaDeg: 64.125,
          state: "pending",
          precalcResultId: exhaustedPrecalc.id,
          precalcResultAttemptId: exhaustedPrecalc.precalcResultAttemptId,
          backgroundOwner: true,
          freshAttemptCount: 2,
          maxFreshAttempts: 2,
          continuationAttemptCount: 2,
          lastOutcome: "fresh_retry_pending",
        })
        .returning();
      queueIds.push(exhaustedQueue.id);
      resetUransLadderMemory();
      expect(
        await uransLadderTick(
          db,
          stubEngine(captured, `${PREFIX}-must-not-submit-exhausted`),
          0,
          {
            requestIds: [],
            verifyIds: [exhaustedQueue.id],
            meshRecoveryVersion: null,
            uransRecoveryVersion: 2,
          },
        ),
      ).toBe(false);
      expect(captured).toEqual([]);
      const [blockedExhausted] = await db
        .select()
        .from(simUransVerifyQueue)
        .where(eq(simUransVerifyQueue.id, exhaustedQueue.id));
      expect(blockedExhausted).toMatchObject({
        state: "blocked",
        lastOutcome: "final_recovery_exhausted",
      });
      const [exhaustedIncident] = await db
        .select()
        .from(simSolverIncidents)
        .where(eq(simSolverIncidents.verifyQueueId, exhaustedQueue.id));
      expect(exhaustedIncident).toMatchObject({
        stage: "final",
        reason: "recovery-budget-exhausted",
        severity: "critical",
        status: "open",
        resultAttemptId: null,
        occurrenceKey: `final:${exhaustedQueue.id}:${exhaustedQueue.id}:final_recovery_exhausted`,
      });

      const mismatchPrecalc = await seedPrecalc(
        64.375,
        "final-presubmit-mismatch",
      );
      const [sourceJob] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          solverImplementationId: sourceSolverImplementationId,
          methodKey: "openfoam.urans",
          jobKind: "verify",
          referenceChordM: CHORD,
          wave: 2,
          status: "done",
          engineJobId: `${PREFIX}-final-presubmit-mismatch-source`,
          totalCases: 1,
          completedCases: 1,
          submittedAt: new Date(),
          finishedAt: new Date(),
        })
        .returning();
      jobIds.push(sourceJob.id);
      const [sourceAttempt] = await db
        .insert(resultAttempts)
        .values({
          resultId: mismatchPrecalc.id,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: 64.375,
          simJobId: sourceJob.id,
          engineJobId: sourceJob.engineJobId,
          engineCaseSlug: "aoa_64.375",
          solverImplementationId: sourceSolverImplementationId,
          status: "done",
          source: "solved",
          regime: "urans",
          validForPolar: false,
          converged: true,
          unsteady: true,
          qualityWarnings: [
            `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: restartable state retained`,
          ],
          evidencePayload: { fidelity: "urans_full" },
          solvedAt: new Date(),
        })
        .returning();
      await db.insert(resultClassifications).values({
        resultAttemptId: sourceAttempt.id,
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 64.375,
        regime: "urans",
        classifierVersion: "final-presubmit-mismatch-v1",
        state: "rejected",
        region: "post_stall",
        confidence: 1,
        reasons: ["insufficient-periods"],
      });
      const [sourceManifest] = await db
        .insert(solverEvidenceArtifacts)
        .values({
          resultId: mismatchPrecalc.id,
          resultAttemptId: sourceAttempt.id,
          airfoilId,
          simJobId: sourceJob.id,
          engineJobId: sourceJob.engineJobId,
          engineCaseSlug: sourceAttempt.engineCaseSlug,
          solverImplementationId: sourceSolverImplementationId,
          aoaDeg: 64.375,
          kind: "manifest",
          storageKey: `${PREFIX}/final-mismatch/${sourceAttempt.id}/manifest.json`,
          mimeType: "application/json",
          sha256: "e".repeat(64),
          byteSize: 1,
        })
        .returning({ id: solverEvidenceArtifacts.id });
      await attachExactRestartArchive({
        resultId: mismatchPrecalc.id,
        resultAttemptId: sourceAttempt.id,
        airfoilId,
        simJobId: sourceJob.id,
        engineJobId: sourceJob.engineJobId,
        engineCaseSlug: sourceAttempt.engineCaseSlug,
        aoaDeg: 64.375,
        solverImplementationId: sourceSolverImplementationId,
        manifestId: sourceManifest.id,
      });
      const [mismatchQueue] = await db
        .insert(simUransVerifyQueue)
        .values({
          airfoilId,
          revisionId,
          aoaDeg: 64.375,
          state: "pending",
          precalcResultId: mismatchPrecalc.id,
          precalcResultAttemptId: mismatchPrecalc.precalcResultAttemptId,
          backgroundOwner: true,
          freshAttemptCount: 2,
          maxFreshAttempts: 2,
          continuationAttemptCount: 1,
          latestResultAttemptId: sourceAttempt.id,
          lastOutcome: "continuation_pending",
        })
        .returning();
      queueIds.push(mismatchQueue.id);
      resetUransLadderMemory();
      expect(
        await uransLadderTick(
          db,
          stubEngine(captured, `${PREFIX}-must-not-submit-mismatch`),
          0,
          {
            requestIds: [],
            verifyIds: [mismatchQueue.id],
            meshRecoveryVersion: null,
            uransRecoveryVersion: 2,
          },
        ),
      ).toBe(false);
      expect(captured).toEqual([]);
      const [blockedMismatch] = await db
        .select()
        .from(simUransVerifyQueue)
        .where(eq(simUransVerifyQueue.id, mismatchQueue.id));
      expect(blockedMismatch).toMatchObject({
        state: "blocked",
        lastOutcome: "final_recovery_exhausted",
      });
      const [mismatchIncident] = await db
        .select()
        .from(simSolverIncidents)
        .where(eq(simSolverIncidents.verifyQueueId, mismatchQueue.id));
      expect(mismatchIncident).toMatchObject({
        stage: "final",
        reason: "solver-implementation-mismatch",
        severity: "critical",
        solverImplementationId: sourceSolverImplementationId,
        simJobId: sourceJob.id,
        resultAttemptId: sourceAttempt.id,
        occurrenceKey: `final:${mismatchQueue.id}:${sourceAttempt.id}:final_recovery_exhausted`,
      });
    } finally {
      resetUransLadderMemory();
      if (queueIds.length) {
        await db
          .delete(simUransVerifyQueue)
          .where(inArray(simUransVerifyQueue.id, queueIds));
      }
      if (resultIds.length) {
        await db.delete(results).where(inArray(results.id, resultIds));
      }
      if (jobIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
      }
    }
  }, 120000);

  it("MUST-CATCH: migration-reopened corrective fresh final recovery waits for the new engine contract", async () => {
    const aoaDeg = 63.625;
    const [precalc] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.78,
        cd: 0.051,
        cm: -0.039,
        clCd: 0.78 / 0.051,
        converged: true,
        unsteady: true,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    const precalcResultAttemptId = await createAcceptedPrecalcGeneration({
      resultId: precalc.id,
      aoaDeg,
      label: "migration-reopened-precalc-attempt",
      cl: 0.78,
      cd: 0.051,
      cm: -0.039,
    });
    const [queue] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId,
        aoaDeg,
        state: "pending",
        precalcResultId: precalc.id,
        precalcResultAttemptId,
        backgroundOwner: true,
        freshAttemptCount: 1,
        maxFreshAttempts: 2,
        continuationAttemptCount: 1,
        lastOutcome: "fresh_retry_pending",
      })
      .returning({ id: simUransVerifyQueue.id });

    const captured: PolarRequest[] = [];
    let submittedJobId: string | null = null;
    try {
      // Version 1 supported the older cross-job contract, but does not own the
      // current conservative numerical remediation. Corrective work waits.
      expect(
        await uransLadderTick(
          db,
          stubEngine(captured, `${PREFIX}-legacy-must-not-run-fresh-recovery`),
          0,
          {
            campaignIds: [],
            parentJobIds: [],
            promotionIds: [],
            requestIds: [],
            verifyIds: [queue.id],
            meshRecoveryVersion: 1,
            uransRecoveryVersion: 1,
          },
        ),
      ).toBe(false);
      expect(captured).toEqual([]);
      expect(
        (
          await db
            .select()
            .from(simUransVerifyQueue)
            .where(eq(simUransVerifyQueue.id, queue.id))
        )[0],
      ).toMatchObject({
        state: "pending",
        precalcResultId: precalc.id,
        freshAttemptCount: 1,
        lastOutcome: "fresh_retry_pending",
      });

      // Expand/contract safety: an older controller can leave a pending row
      // with durable submitted-job history but no new last_outcome marker.
      // Physical-attempt counters still prove that this is recovery, not an
      // initial final-verification submission. An unknown live capability also
      // fails closed instead of treating this as first-pass work.
      await db
        .update(simUransVerifyQueue)
        .set({ lastOutcome: null })
        .where(eq(simUransVerifyQueue.id, queue.id));
      expect(
        await uransLadderTick(
          db,
          stubEngine(
            captured,
            `${PREFIX}-legacy-must-not-run-unmarked-fresh-recovery`,
          ),
          0,
          {
            campaignIds: [],
            parentJobIds: [],
            promotionIds: [],
            requestIds: [],
            verifyIds: [queue.id],
            meshRecoveryVersion: 1,
            uransRecoveryVersion: null,
          },
        ),
      ).toBe(false);
      expect(captured).toEqual([]);

      expect(
        await uransLadderTick(
          db,
          stubEngine(captured, `${PREFIX}-final-fresh-recovery`),
          0,
          {
            parentJobIds: [],
            promotionIds: [],
            requestIds: [],
            verifyIds: [queue.id],
            meshRecoveryVersion: null,
            uransRecoveryVersion: 2,
          },
        ),
      ).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0].continue_from).toBeUndefined();
      expect(captured[0].expected_urans_recovery_version).toBe(2);
      const [running] = await db
        .select()
        .from(simUransVerifyQueue)
        .where(eq(simUransVerifyQueue.id, queue.id));
      expect(running).toMatchObject({
        state: "running",
        precalcResultId: precalc.id,
        freshAttemptCount: 1,
        continuationAttemptCount: 1,
      });
      submittedJobId = running.simJobId;
      const [submittedJob] = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.id, submittedJobId!));
      expect(submittedJob.requestPayload).toMatchObject({
        verifyQueueItemId: queue.id,
        finalRecoveryMode: "fresh",
        uransRecoveryVersion: 2,
      });
    } finally {
      await db
        .delete(simUransVerifyQueue)
        .where(eq(simUransVerifyQueue.id, queue.id));
      await db.delete(results).where(eq(results.id, precalc.id));
      if (submittedJobId) {
        await db.delete(simJobs).where(eq(simJobs.id, submittedJobId));
      }
    }
  }, 120000);

  it("MUST-CATCH: a restartable rejected full attempt submits an exact same-case continuation without consuming a fresh start", async () => {
    const aoaDeg = 63.875;
    const [targetRevision] = await db
      .select({
        solverImplementationId:
          simulationPresetRevisions.solverImplementationId,
      })
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, revisionId))
      .limit(1);
    expect(targetRevision?.solverImplementationId).toBeTruthy();
    const solverImplementationId = targetRevision!.solverImplementationId!;
    const [precalc] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.82,
        cd: 0.052,
        cm: -0.041,
        clCd: 0.82 / 0.052,
        converged: true,
        unsteady: true,
        engineJobId: `${PREFIX}-final-recovery-precalc`,
        engineCaseSlug: "aoa_63.88",
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    const precalcResultAttemptId = await createAcceptedPrecalcGeneration({
      resultId: precalc.id,
      aoaDeg,
      label: "final-recovery-precalc-attempt",
      cl: 0.82,
      cd: 0.052,
      cm: -0.041,
    });
    const [queue] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId,
        aoaDeg,
        state: "pending",
        precalcResultId: precalc.id,
        precalcResultAttemptId,
        backgroundOwner: true,
        freshAttemptCount: 1,
        // Productive exact-state continuation is not bounded by the number
        // of fresh starts. This fixture deliberately exceeds the historical
        // one-continuation-per-fresh constraint.
        continuationAttemptCount: 5,
        continuationNoProgressCount: 0,
        lastOutcome: "continuation_pending",
      })
      .returning({ id: simUransVerifyQueue.id });
    const [sourceJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        solverImplementationId,
        methodKey: "openfoam.urans",
        jobKind: "verify",
        referenceChordM: CHORD,
        wave: 2,
        status: "done",
        engineJobId: `${PREFIX}-final-recovery-source`,
        totalCases: 1,
        completedCases: 1,
        submittedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(Date.now() - 30_000),
        requestPayload: {
          aoas: [aoaDeg],
          uransFidelity: "full",
          verifyQueueItemId: queue.id,
          finalRecoveryMode: "fresh",
        },
      })
      .returning({ id: simJobs.id });
    const [sourceAttempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: precalc.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        simJobId: sourceJob.id,
        engineJobId: `${PREFIX}-final-recovery-source`,
        engineCaseSlug: "aoa_63.88",
        solverImplementationId,
        status: "done",
        source: "solved",
        regime: "urans",
        validForPolar: false,
        converged: true,
        unsteady: true,
        qualityWarnings: [
          `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: retained restartable latestTime state`,
        ],
        evidencePayload: { fidelity: "urans_full" },
        solvedAt: new Date(),
      })
      .returning({ id: resultAttempts.id });
    await db.insert(resultClassifications).values({
      resultAttemptId: sourceAttempt.id,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      regime: "urans",
      classifierVersion: "final-recovery-continuation-v1",
      state: "rejected",
      region: "post_stall",
      confidence: 1,
      reasons: ["insufficient-periods"],
    });
    const [sourceManifest] = await db
      .insert(solverEvidenceArtifacts)
      .values({
        resultId: precalc.id,
        resultAttemptId: sourceAttempt.id,
        airfoilId,
        simJobId: sourceJob.id,
        engineJobId: `${PREFIX}-final-recovery-source`,
        engineCaseSlug: "aoa_63.88",
        solverImplementationId,
        aoaDeg,
        kind: "manifest",
        storageKey: `${PREFIX}/final-recovery/${sourceAttempt.id}/manifest.json`,
        mimeType: "application/json",
        sha256: "f".repeat(64),
        byteSize: 1,
      })
      .returning({ id: solverEvidenceArtifacts.id });
    await attachExactRestartArchive({
      resultId: precalc.id,
      resultAttemptId: sourceAttempt.id,
      airfoilId,
      simJobId: sourceJob.id,
      engineJobId: `${PREFIX}-final-recovery-source`,
      engineCaseSlug: "aoa_63.88",
      aoaDeg,
      solverImplementationId,
      manifestId: sourceManifest.id,
    });
    await db
      .update(simUransVerifyQueue)
      .set({ latestResultAttemptId: sourceAttempt.id })
      .where(eq(simUransVerifyQueue.id, queue.id));

    const captured: PolarRequest[] = [];
    let submittedJobId: string | null = null;
    try {
      // Rolling deploy safety: a runtime advertising the older URANS recovery
      // v1 contract lacks the current v2 numerical remediation. The newly
      // reopened row must remain pending and untouched.
      expect(
        await uransLadderTick(
          db,
          stubEngine(captured, `${PREFIX}-legacy-must-not-run-recovery`),
          0,
          {
            campaignIds: [],
            parentJobIds: [],
            promotionIds: [],
            requestIds: [],
            verifyIds: [queue.id],
            meshRecoveryVersion: 1,
            uransRecoveryVersion: 1,
          },
        ),
      ).toBe(false);
      expect(captured).toEqual([]);
      expect(
        (
          await db
            .select()
            .from(simUransVerifyQueue)
            .where(eq(simUransVerifyQueue.id, queue.id))
        )[0],
      ).toMatchObject({
        state: "pending",
        freshAttemptCount: 1,
        continuationAttemptCount: 5,
        lastOutcome: "continuation_pending",
      });

      expect(
        await uransLadderTick(
          db,
          stubEngine(captured, `${PREFIX}-final-recovery-continuation`),
          0,
          {
            parentJobIds: [],
            promotionIds: [],
            requestIds: [],
            verifyIds: [queue.id],
            meshRecoveryVersion: null,
            uransRecoveryVersion: 2,
          },
        ),
      ).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0].continue_from).toEqual({
        engine_job_id: `${PREFIX}-final-recovery-source`,
        case_slug: "aoa_63.88",
      });
      expect(captured[0].budget_override_s).toBe(21_600);
      expect(captured[0].expected_urans_recovery_version).toBe(2);
      const [claimed] = await db
        .select()
        .from(simUransVerifyQueue)
        .where(eq(simUransVerifyQueue.id, queue.id));
      expect(claimed).toMatchObject({
        state: "running",
        freshAttemptCount: 1,
        continuationAttemptCount: 5,
      });
      submittedJobId = claimed.simJobId;
      expect(submittedJobId).toBeTruthy();
      const [submittedJob] = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.id, submittedJobId!));
      expect(submittedJob.requestPayload).toMatchObject({
        verifyQueueItemId: queue.id,
        finalRecoveryMode: "continuation",
        continueFromResultAttemptId: sourceAttempt.id,
        budgetOverrideS: 21_600,
        uransRecoveryVersion: 2,
      });
    } finally {
      await db
        .delete(simUransVerifyQueue)
        .where(eq(simUransVerifyQueue.id, queue.id));
      await db.delete(results).where(eq(results.id, precalc.id));
      await db.delete(simJobs).where(
        inArray(
          simJobs.id,
          [sourceJob.id, submittedJobId].filter((id): id is string =>
            Boolean(id),
          ),
        ),
      );
    }
  }, 120000);
});

describe("tier-2a durable-obligation priority MUST-CATCH", () => {
  // Production shape: healthy terminal parents dominate the finishedAt scan,
  // while the newer rejected point already owns an exact durable PRECALC
  // obligation. Process-local window sliding is insufficient: a restart puts
  // the target behind the same history again and lets ordinary RANS consume
  // every intervening free slot. The durable queue must win the first pass.
  it("admits a due durable recovery ranked 53rd on the first post-restart pass", async () => {
    const scopedParentIds: string[] = [];
    const obligationIds: string[] = [];
    const attemptIds: string[] = [];
    const childIds: string[] = [];
    const starvationAoa = 14.375;
    const unrelatedAoa = 13.875;
    try {
      // The verify test above ends with every tier terminal and the aoa-8 cell
      // ACCEPTED at full fidelity, so the completion probe settles the shared
      // fixture campaign to 'completed'. This scenario needs a LIVE mid-ladder
      // campaign (the gate just opened, gated retries still owed) — reactivate.
      await db
        .update(simCampaigns)
        .set({ status: "active" })
        .where(eq(simCampaigns.id, campaignId));
      const [unrelatedOpenObligation] = await ensurePrecalcObligations(
        db,
        [
          {
            airfoilId,
            revisionId,
            aoaDeg: unrelatedAoa,
          },
        ],
        { campaignIds: [campaignId] },
      );
      if (unrelatedOpenObligation)
        obligationIds.push(unrelatedOpenObligation.id);
      expect(unrelatedOpenObligation).toMatchObject({ state: "pending" });

      const base = Date.now() - 60 * 60 * 1000;
      // 52 completed, ingested, childless wave-1 parents with EMPTY retry plans
      // place the exact durable source parent at production rank 53.
      const fillers = await db
        .insert(simJobs)
        .values(
          Array.from({ length: 52 }, (_, i) => ({
            airfoilId,
            bcIds: [bcId],
            simulationPresetRevisionId: revisionId,
            campaignId,
            jobKind: "sweep",
            referenceChordM: CHORD,
            wave: 1,
            status: "done" as const,
            engineJobId: `${PREFIX}-starve-filler-${i}`,
            totalCases: 1,
            completedCases: 1,
            ingestedAt: new Date(base + i * 1000),
            finishedAt: new Date(base + i * 1000),
            requestPayload: {
              speedMap: [
                {
                  speed: SPEED,
                  bcId,
                  presetRevisionId: revisionId,
                  mach: SPEED / 340.3,
                },
              ],
              aoas: [4],
            },
          })),
        )
        .returning({ id: simJobs.id });
      scopedParentIds.push(...fillers.map((filler) => filler.id));

      // The needy parent finishes LAST and carries a failed RANS attempt at a
      // file-unique AoA (classifies rejected → non-empty targeted retry plan).
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
          requestPayload: {
            speedMap: [
              {
                speed: SPEED,
                bcId,
                presetRevisionId: revisionId,
                mach: SPEED / 340.3,
              },
            ],
            aoas: [starvationAoa],
          },
        })
        .returning();
      scopedParentIds.push(needy.id);
      const [needyAttempt] = await db
        .insert(resultAttempts)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: starvationAoa,
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
          evidencePayload: { failure_disposition: "hard_solver" },
          solvedAt: new Date(),
        })
        .returning();
      attemptIds.push(needyAttempt.id);
      const [durableObligation] = await ensurePrecalcObligations(
        db,
        [
          {
            airfoilId,
            revisionId,
            aoaDeg: starvationAoa,
            sourceResultAttemptId: needyAttempt.id,
          },
        ],
        { campaignIds: [campaignId] },
      );
      if (durableObligation) obligationIds.push(durableObligation.id);
      expect(durableObligation).toMatchObject({
        state: "pending",
        sourceResultAttemptId: needyAttempt.id,
      });
      expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(false);

      // A process restart clears legacy scan memory. Durable priority must still
      // admit this exact parent in one call rather than spending 18+ passes
      // re-settling the 52 older parents while unrelated RANS can jump ahead.
      resetUransLadderMemory();
      const requests: PolarRequest[] = [];
      expect(
        await submitCampaignPrecalcRecoveries(
          db,
          stubEngine(requests, `${PREFIX}-starve-child`),
          [campaignId],
          scopedParentIds,
          0,
          2,
        ),
      ).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.solver?.urans_fidelity).toBe("precalc");
      expect(requests[0]?.solver?.force_transient).toBe(true);
      expect(requests[0]?.aoa?.angles).toEqual([starvationAoa]);
      const [child] = await db
        .select()
        .from(simJobs)
        .where(and(eq(simJobs.parentJobId, needy.id), eq(simJobs.wave, 2)));
      if (child) childIds.push(child.id);
      expect(child).toBeTruthy();
      expect(child!.jobKind).toBe("targeted");
      expect(
        (child!.requestPayload as { uransFidelity?: string }).uransFidelity,
      ).toBe("precalc");
      expect((child!.requestPayload as { aoas?: number[] }).aoas).toEqual([
        starvationAoa,
      ]);
    } finally {
      resetUransLadderMemory();
      if (childIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, childIds));
      }
      if (obligationIds.length) {
        await db
          .delete(simPrecalcObligations)
          .where(inArray(simPrecalcObligations.id, obligationIds));
      }
      if (attemptIds.length) {
        await db
          .delete(resultAttempts)
          .where(inArray(resultAttempts.id, attemptIds));
      }
      if (scopedParentIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, scopedParentIds));
      }
    }
  }, 180000);

  it("MUST-CATCH: campaign-priority projection preserves an unclaimed exact admin continuation's larger budget", async () => {
    const targetAoa = 14.475;
    const jobIds: string[] = [];
    const standaloneAttemptIds: string[] = [];
    let obligationId = "";
    let checkpointResultId = "";
    let checkpointResultAttemptId = "";
    const requestIds: string[] = [];
    try {
      await db
        .update(simCampaigns)
        .set({ status: "active", completedAt: null })
        .where(eq(simCampaigns.id, campaignId));

      const [parent] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
          campaignId,
          jobKind: "sweep",
          referenceChordM: CHORD,
          wave: 1,
          status: "done",
          engineState: "completed",
          engineJobId: `${PREFIX}-priority-budget-parent`,
          totalCases: 1,
          completedCases: 1,
          ingestedAt: new Date(),
          finishedAt: new Date(),
          requestPayload: {
            speedMap: [
              {
                speed: SPEED,
                bcId,
                presetRevisionId: revisionId,
                mach: SPEED / 340.3,
              },
            ],
            aoas: [targetAoa],
          },
        })
        .returning();
      jobIds.push(parent.id);
      const [sourceRansAttempt] = await db
        .insert(resultAttempts)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: targetAoa,
          simJobId: parent.id,
          engineJobId: parent.engineJobId,
          solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
          status: "failed",
          source: "queued",
          regime: "rans",
          validForPolar: false,
          converged: false,
          stalled: true,
          unsteady: false,
          error: "RANS did not converge",
          evidencePayload: { failure_disposition: "hard_solver" },
          solvedAt: new Date(),
        })
        .returning();
      standaloneAttemptIds.push(sourceRansAttempt.id);
      const [obligation] = await ensurePrecalcObligations(
        db,
        [
          {
            airfoilId,
            revisionId,
            aoaDeg: targetAoa,
            sourceResultAttemptId: sourceRansAttempt.id,
          },
        ],
        { campaignIds: [campaignId] },
      );
      obligationId = obligation.id;

      const [checkpointJob] = await db
        .insert(simJobs)
        .values({
          parentJobId: parent.id,
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
          campaignId: null,
          methodKey: "openfoam.urans",
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "done",
          engineState: "completed",
          engineJobId: `${PREFIX}-priority-budget-checkpoint`,
          totalCases: 1,
          completedCases: 1,
          submittedAt: new Date(),
          ingestedAt: new Date(),
          finishedAt: new Date(),
          requestPayload: {
            aoas: [targetAoa],
            uransFidelity: "precalc",
            precalcObligationIds: [obligation.id],
          },
        })
        .returning();
      jobIds.push(checkpointJob.id);
      const warnings = [
        `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: retained restartable latestTime state`,
      ];
      const [checkpointResult] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: targetAoa,
          simJobId: checkpointJob.id,
          engineJobId: checkpointJob.engineJobId,
          engineCaseSlug: "aoa_14.475",
          methodKey: "openfoam.urans",
          solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
          status: "done",
          source: "solved",
          regime: "urans",
          fidelity: "urans_precalc",
          converged: true,
          unsteady: true,
          qualityWarnings: warnings,
          solvedAt: new Date(),
        })
        .returning();
      checkpointResultId = checkpointResult.id;
      checkpointResultAttemptId =
        await attachRestartableContinuationAttempt({
          resultId: checkpointResult.id,
          aoaDeg: targetAoa,
          simJobId: checkpointJob.id,
          engineJobId: checkpointJob.engineJobId,
          engineCaseSlug: "aoa_14.475",
          qualityWarnings: warnings,
        });
      await db.insert(simPrecalcObligationAttempts).values({
        obligationId: obligation.id,
        simJobId: checkpointJob.id,
        attemptNumber: 1,
        solverAttemptNumber: 1,
        consumesSolverAttempt: true,
        state: "rejected",
        outcome: "rejected",
        resultAttemptId: checkpointResultAttemptId,
        completedAt: new Date(),
      });
      await db
        .update(simPrecalcObligations)
        .set({
          state: "pending",
          attemptCount: 1,
          latestSimJobId: checkpointJob.id,
          lastOutcome: "rejected",
        })
        .where(eq(simPrecalcObligations.id, obligation.id));

      expect(
        await precalcContinuationsForObligations(db, [obligation.id]),
      ).toEqual([
        expect.objectContaining({
          obligationId: obligation.id,
          resultId: checkpointResult.id,
          resultAttemptId: checkpointResultAttemptId,
          budgetOverrideS: AUTO_PRECALC_CONTINUATION_BUDGET_S,
        }),
      ]);

      // A valid saved generation for the same physical cell is still a
      // different trajectory unless its immutable attempt id is the one the
      // obligation selected. Its larger request must neither retarget the
      // campaign continuation nor leak its budget onto that checkpoint.
      const [differentAttemptJob] = await db
        .insert(simJobs)
        .values({
          parentJobId: parent.id,
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
          campaignId: null,
          methodKey: "openfoam.urans",
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "done",
          engineState: "completed",
          engineJobId: `${PREFIX}-priority-budget-different-attempt`,
          totalCases: 1,
          completedCases: 1,
          submittedAt: new Date(),
          ingestedAt: new Date(),
          finishedAt: new Date(),
          requestPayload: {
            aoas: [targetAoa],
            uransFidelity: "precalc",
          },
        })
        .returning();
      jobIds.push(differentAttemptJob.id);
      const differentAttemptId = await attachRestartableContinuationAttempt({
        resultId: checkpointResult.id,
        aoaDeg: targetAoa,
        simJobId: differentAttemptJob.id,
        engineJobId: differentAttemptJob.engineJobId,
        engineCaseSlug: "aoa_14.475_different_attempt",
        qualityWarnings: warnings,
      });
      const differentAttemptRequest = await createUransRequest(db, {
        airfoilId,
        revisionId,
        aoaDeg: targetAoa,
        fidelity: "precalc",
        requestedBy: "operator@airfoils.pro",
        continueFromResultId: checkpointResult.id,
        continueFromResultAttemptId: differentAttemptId,
        budgetOverrideS: 86_400,
      });
      expect(differentAttemptRequest.created).toBe(true);
      requestIds.push(differentAttemptRequest.request.id);
      expect(
        await precalcContinuationsForObligations(db, [obligation.id]),
      ).toEqual([
        expect.objectContaining({
          resultAttemptId: checkpointResultAttemptId,
          budgetOverrideS: AUTO_PRECALC_CONTINUATION_BUDGET_S,
        }),
      ]);
      await db
        .update(simUransRequests)
        .set({ state: "cancelled" })
        .where(eq(simUransRequests.id, differentAttemptRequest.request.id));

      const lowerBudgetRequest = await createUransRequest(db, {
        airfoilId,
        revisionId,
        aoaDeg: targetAoa,
        fidelity: "precalc",
        requestedBy: "operator@airfoils.pro",
        continueFromResultId: checkpointResult.id,
        continueFromResultAttemptId: checkpointResultAttemptId,
        budgetOverrideS: 3_600,
      });
      expect(lowerBudgetRequest.created).toBe(true);
      requestIds.push(lowerBudgetRequest.request.id);
      expect(
        await precalcContinuationsForObligations(db, [obligation.id]),
      ).toEqual([
        expect.objectContaining({
          resultAttemptId: checkpointResultAttemptId,
          budgetOverrideS: AUTO_PRECALC_CONTINUATION_BUDGET_S,
        }),
      ]);
      await db
        .update(simUransRequests)
        .set({ state: "cancelled" })
        .where(eq(simUransRequests.id, lowerBudgetRequest.request.id));

      const { request, created } = await createUransRequest(db, {
        airfoilId,
        revisionId,
        aoaDeg: targetAoa,
        fidelity: "precalc",
        requestedBy: "operator@airfoils.pro",
        continueFromResultId: checkpointResult.id,
        continueFromResultAttemptId: checkpointResultAttemptId,
        budgetOverrideS: 21_600,
      });
      expect(created).toBe(true);
      requestIds.push(request.id);
      const requestCoverage = (await db.execute(dsql`
        SELECT 1
        FROM sim_precalc_obligation_requests
        WHERE obligation_id = ${obligation.id}::uuid
          AND request_id = ${request.id}::uuid
      `)) as unknown as Array<{ present: number }>;
      expect(requestCoverage).toEqual([]);
      expect(
        await precalcContinuationsForObligations(db, [obligation.id]),
      ).toEqual([
        expect.objectContaining({
          obligationId: obligation.id,
          resultId: checkpointResult.id,
          resultAttemptId: checkpointResultAttemptId,
          budgetOverrideS: 21_600,
        }),
      ]);
      const [unchangedRequest] = await db
        .select()
        .from(simUransRequests)
        .where(eq(simUransRequests.id, request.id));
      expect(unchangedRequest).toMatchObject({
        continueFromResultId: checkpointResult.id,
        continueFromResultAttemptId: checkpointResultAttemptId,
        budgetOverrideS: 21_600,
      });
    } finally {
      resetUransLadderMemory();
      if (requestIds.length) {
        await db
          .delete(simUransRequests)
          .where(inArray(simUransRequests.id, requestIds));
      }
      if (obligationId) {
        await db
          .delete(simPrecalcObligations)
          .where(eq(simPrecalcObligations.id, obligationId));
      }
      if (checkpointResultId) {
        await db
          .update(results)
          .set({ currentResultAttemptId: null })
          .where(eq(results.id, checkpointResultId));
        await db.delete(results).where(eq(results.id, checkpointResultId));
      }
      if (standaloneAttemptIds.length) {
        await db
          .delete(resultAttempts)
          .where(inArray(resultAttempts.id, standaloneAttemptIds));
      }
      if (jobIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
      }
    }
  }, 120000);

  it("schedules a campaign-owned handoff from its exact background RANS attempt and honors the beneficiary lifecycle", async () => {
    const targetAoa = 17.625;
    const unrelatedAoa = 18.625;
    let pointInserted = false;
    let parentId = "";
    const resultIds: string[] = [];
    const obligationIds: string[] = [];
    const childIds: string[] = [];
    try {
      await db
        .update(simCampaigns)
        .set({ status: "active", completedAt: null })
        .where(eq(simCampaigns.id, campaignId));
      const [pointTemplate] = await db
        .select({ planRevisionNumber: simCampaignPoints.planRevisionNumber })
        .from(simCampaignPoints)
        .where(eq(simCampaignPoints.campaignId, campaignId))
        .limit(1);
      await db.insert(simCampaignPoints).values({
        campaignId,
        conditionId,
        airfoilId,
        aoaDeg: targetAoa,
        revisionId,
        planRevisionNumber: pointTemplate!.planRevisionNumber,
        state: "requested",
      });
      pointInserted = true;

      const [parent] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          campaignId: null,
          jobKind: "sweep",
          referenceChordM: CHORD,
          wave: 1,
          status: "done",
          engineJobId: `${PREFIX}-background-source-parent`,
          totalCases: 2,
          completedCases: 2,
          ingestedAt: new Date(),
          finishedAt: new Date(),
          requestPayload: {
            speedMap: [
              {
                speed: SPEED,
                bcId,
                presetRevisionId: revisionId,
                mach: SPEED / 340.3,
              },
            ],
            aoas: [targetAoa, unrelatedAoa],
            ransRetryScope: {
              origin: "continuous-polar",
              requestedAoas: [targetAoa, unrelatedAoa],
            },
          },
        })
        .returning();
      parentId = parent.id;

      const sourceResults = await db
        .insert(results)
        .values(
          [targetAoa, unrelatedAoa].map((aoaDeg) => ({
            airfoilId,
            bcId,
            simulationPresetRevisionId: revisionId,
            aoaDeg,
            simJobId: parent.id,
            status: "failed" as const,
            source: "queued" as const,
            regime: "rans" as const,
            fidelity: "rans" as const,
            converged: false,
            stalled: true,
            error: "RANS did not converge",
            solvedAt: new Date(),
          })),
        )
        .returning();
      resultIds.push(...sourceResults.map((result) => result.id));
      const sourceAttempts = await db
        .insert(resultAttempts)
        .values(
          sourceResults.map((result) => ({
            resultId: result.id,
            airfoilId,
            bcId,
            simulationPresetRevisionId: revisionId,
            aoaDeg: result.aoaDeg,
            simJobId: parent.id,
            engineJobId: parent.engineJobId,
            status: "failed" as const,
            source: "queued" as const,
            regime: "rans" as const,
            validForPolar: false,
            converged: false,
            stalled: true,
            unsteady: false,
            error: "RANS did not converge",
            evidencePayload: { failure_disposition: "hard_solver" },
            solvedAt: new Date(),
          })),
        )
        .returning();
      await db.insert(resultClassifications).values(
        sourceAttempts.map((attempt) => ({
          resultId: attempt.resultId!,
          resultAttemptId: attempt.id,
          airfoilId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: attempt.aoaDeg,
          regime: "rans" as const,
          classifierVersion: `${PREFIX}-background-owner-handoff`,
          state: "rejected" as const,
          reasons: ["not-converged"],
        })),
      );
      const targetResult = sourceResults.find(
        (result) => result.aoaDeg === targetAoa,
      )!;
      const targetAttempt = sourceAttempts.find(
        (attempt) => attempt.aoaDeg === targetAoa,
      )!;

      await onResultIngestedWithAutomaticPrecalcHandoff(db, {
        airfoilId,
        revisionId,
        aoaDeg: targetAoa,
        resultId: targetResult.id,
        resultAttemptId: targetAttempt.id,
        simJobId: parent.id,
        status: "failed",
        regime: "rans",
      });
      const [obligation] = await db
        .select({
          id: simPrecalcObligations.id,
          state: simPrecalcObligations.state,
          sourceResultAttemptId: simPrecalcObligations.sourceResultAttemptId,
          backgroundOwner: simPrecalcObligations.backgroundOwner,
        })
        .from(simPrecalcObligations)
        .innerJoin(
          simPrecalcObligationCampaigns,
          and(
            eq(
              simPrecalcObligationCampaigns.obligationId,
              simPrecalcObligations.id,
            ),
            eq(simPrecalcObligationCampaigns.campaignId, campaignId),
            eq(simPrecalcObligationCampaigns.state, "active"),
          ),
        )
        .where(
          and(
            eq(simPrecalcObligations.airfoilId, airfoilId),
            eq(simPrecalcObligations.revisionId, revisionId),
            eq(simPrecalcObligations.aoaDeg, targetAoa),
          ),
        );
      obligationIds.push(obligation.id);
      expect(obligation).toMatchObject({
        state: "pending",
        sourceResultAttemptId: targetAttempt.id,
        backgroundOwner: false,
      });

      await db
        .update(simCampaigns)
        .set({ status: "paused" })
        .where(eq(simCampaigns.id, campaignId));
      const captured: PolarRequest[] = [];
      expect(
        await submitCampaignPrecalcRecoveries(
          db,
          stubEngine(captured, `${PREFIX}-background-source-child`),
          [campaignId],
          [parent.id],
          0,
          2,
        ),
      ).toBe(false);
      expect(captured).toHaveLength(0);

      await db
        .update(simCampaigns)
        .set({ status: "active" })
        .where(eq(simCampaigns.id, campaignId));
      expect(
        await submitCampaignPrecalcRecoveries(
          db,
          stubEngine(captured, `${PREFIX}-background-source-child`),
          [campaignId],
          [parent.id],
          0,
          2,
        ),
      ).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0].aoa?.angles).toEqual([targetAoa]);
      expect(captured[0].aoa?.angles).not.toContain(unrelatedAoa);
      const [child] = await db
        .select()
        .from(simJobs)
        .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
      childIds.push(child.id);
      expect(child).toMatchObject({
        campaignId: null,
        jobKind: "targeted",
        status: "submitted",
      });
      expect(child.requestPayload).toMatchObject({
        aoas: [targetAoa],
        precalcObligationIds: [obligation.id],
        uransFidelity: "precalc",
      });
    } finally {
      resetUransLadderMemory();
      await db
        .update(simCampaigns)
        .set({ status: "active" })
        .where(eq(simCampaigns.id, campaignId));
      if (childIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, childIds));
      }
      if (obligationIds.length) {
        await db
          .delete(simPrecalcObligations)
          .where(inArray(simPrecalcObligations.id, obligationIds));
      }
      if (pointInserted) {
        await db
          .delete(simCampaignPoints)
          .where(
            and(
              eq(simCampaignPoints.campaignId, campaignId),
              eq(simCampaignPoints.conditionId, conditionId),
              eq(simCampaignPoints.airfoilId, airfoilId),
              eq(simCampaignPoints.aoaDeg, targetAoa),
            ),
          );
      }
      if (resultIds.length) {
        await db.delete(results).where(inArray(results.id, resultIds));
      }
      if (parentId) {
        await db.delete(simJobs).where(eq(simJobs.id, parentId));
      }
    }
  }, 180000);

  it("recovers a cancelled wave-1 parent's partially-ingested rejected cell instead of losing its URANS obligation", async () => {
    resetUransLadderMemory();
    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, campaignId));
    const cancelledAoa = 9.125;
    const [cancelledParent] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        campaignId,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "cancelled",
        engineJobId: `${PREFIX}-cancelled-ingested-parent`,
        totalCases: 2,
        completedCases: 1,
        // Running-partial ingestion stores attempt evidence but deliberately
        // does not stamp the terminal-ingest timestamp. Admin cancellation
        // must not make that truthful partial evidence invisible to the ladder.
        ingestedAt: null,
        finishedAt: new Date(1),
        requestPayload: {
          speedMap: [
            {
              speed: SPEED,
              bcId,
              presetRevisionId: revisionId,
              mach: SPEED / 340.3,
            },
          ],
          aoas: [cancelledAoa, cancelledAoa + 1],
        },
      })
      .returning();
    expect(cancelledParent.ingestedAt).toBeNull();
    await db.insert(resultAttempts).values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: cancelledAoa,
      simJobId: cancelledParent.id,
      engineJobId: `${PREFIX}-cancelled-ingested-parent`,
      status: "failed",
      source: "queued",
      regime: "rans",
      validForPolar: false,
      converged: false,
      stalled: true,
      unsteady: false,
      error: "RANS did not converge before the remaining sweep was cancelled",
      evidencePayload: { failure_disposition: "hard_solver" },
      solvedAt: new Date(),
    });
    expect(await campaignHasOpenRansGaps(db, campaignId)).toBe(false);

    const requests: PolarRequest[] = [];
    const submitted = await uransLadderTick(
      db,
      stubEngine(requests, `${PREFIX}-cancelled-parent-child`),
      0,
      await ladderScope(),
    );

    expect(submitted).toBe(true);
    const [child] = await db
      .select()
      .from(simJobs)
      .where(
        and(eq(simJobs.parentJobId, cancelledParent.id), eq(simJobs.wave, 2)),
      );
    expect(child).toBeTruthy();
    expect((child!.requestPayload as { aoas?: number[] }).aoas).toEqual([
      cancelledAoa,
    ]);
    expect(requests[0]?.solver?.urans_fidelity).toBe("precalc");
    await db
      .update(simJobs)
      .set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() })
      .where(eq(simJobs.id, child!.id));
  }, 180000);
});

describe("continuation work items (amendment C): budget-stopped URANS resumes from saved case state", () => {
  const CONTINUE_AOA = 12;
  let sourceResultId = "";

  async function assertBlockedCheckpointRecovery(input: {
    aoaDeg: number;
    legacyInfrastructureInterruption: boolean;
  }): Promise<void> {
    const jobIds: string[] = [];
    let requestId = "";
    let obligationId = "";
    let checkpointResultId = "";
    let checkpointResultAttemptId = "";
    try {
      const { request, created } = await createUransRequest(db, {
        airfoilId,
        revisionId,
        aoaDeg: input.aoaDeg,
        fidelity: "precalc",
        requestedBy: "blocked-continuation-recovery@test.airfoils.pro",
      });
      expect(created).toBe(true);
      requestId = request.id;
      const [obligation] = await ensurePrecalcObligations(
        db,
        [{ airfoilId, revisionId, aoaDeg: input.aoaDeg }],
        { requestIds: [request.id] },
      );
      expect(obligation).toBeDefined();
      obligationId = obligation!.id;

      const insertJob = async (inputJob: {
        suffix: string;
        status: "done" | "failed";
        requestPayload: Record<string, unknown>;
        error?: string;
      }) => {
        const [job] = await db
          .insert(simJobs)
          .values({
            airfoilId,
            bcIds: [bcId],
            simulationPresetRevisionId: revisionId,
            campaignId: null,
            jobKind: "targeted",
            referenceChordM: CHORD,
            wave: 2,
            status: inputJob.status,
            engineJobId: `${PREFIX}-${inputJob.suffix}`,
            submittedAt: new Date(),
            finishedAt: new Date(),
            totalCases: 1,
            completedCases: inputJob.status === "done" ? 1 : 0,
            error: inputJob.error,
            requestPayload: inputJob.requestPayload,
          })
          .returning();
        jobIds.push(job.id);
        return job;
      };

      let checkpointSubmissionNumber: number;
      if (input.legacyInfrastructureInterruption) {
        checkpointSubmissionNumber = 1;
      } else {
        checkpointSubmissionNumber = 2;
        const firstPhysicalJob = await insertJob({
          suffix: `max-continuation-first-${input.aoaDeg}`,
          status: "failed",
          requestPayload: {
            uransRequestId: request.id,
            aoas: [input.aoaDeg],
            uransFidelity: "precalc",
            precalcObligationIds: [obligation.id],
          },
          error: "first physical PRECALC solve did not converge",
        });
        await db.insert(simPrecalcObligationAttempts).values({
          obligationId: obligation.id,
          simJobId: firstPhysicalJob.id,
          attemptNumber: 1,
          solverAttemptNumber: 1,
          consumesSolverAttempt: true,
          state: "failed",
          outcome: "failed",
          error: firstPhysicalJob.error,
          completedAt: new Date(),
        });
      }

      const checkpointJob = await insertJob({
        suffix: `blocked-checkpoint-${input.aoaDeg}`,
        status: "done",
        requestPayload: {
          uransRequestId: request.id,
          aoas: [input.aoaDeg],
          uransFidelity: "precalc",
          precalcObligationIds: [obligation.id],
        },
      });
      const [targetRevision] = await db
        .select({
          solverImplementationId:
            simulationPresetRevisions.solverImplementationId,
        })
        .from(simulationPresetRevisions)
        .where(eq(simulationPresetRevisions.id, revisionId));
      if (!targetRevision?.solverImplementationId) {
        throw new Error(
          `fixture revision ${revisionId} has no solver identity`,
        );
      }
      const [checkpointResult] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: input.aoaDeg,
          methodKey: "openfoam.urans",
          solverImplementationId: targetRevision.solverImplementationId,
          status: "done",
          source: "solved",
          regime: "urans",
          fidelity: "urans_precalc",
          converged: true,
          unsteady: true,
          engineJobId: checkpointJob.engineJobId,
          engineCaseSlug: `aoa_${input.aoaDeg}`,
          cl: 0.61,
          cd: 0.09,
          cm: -0.03,
          clCd: 6.78,
          qualityWarnings: [
            `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: retained restartable latestTime state`,
          ],
          solvedAt: new Date(),
        })
        .returning();
      checkpointResultId = checkpointResult.id;
      checkpointResultAttemptId = await attachRestartableContinuationAttempt({
        resultId: checkpointResult.id,
        aoaDeg: input.aoaDeg,
        simJobId: checkpointJob.id,
        engineJobId: checkpointJob.engineJobId,
        engineCaseSlug: `aoa_${input.aoaDeg}`,
        solverImplementationId: targetRevision.solverImplementationId,
        qualityWarnings: checkpointResult.qualityWarnings ?? [],
      });
      const [checkpoint] = await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.id, checkpointResultAttemptId));
      expect(checkpoint).toBeDefined();
      await db.insert(simPrecalcObligationAttempts).values({
        obligationId: obligation.id,
        simJobId: checkpointJob.id,
        attemptNumber: checkpointSubmissionNumber,
        solverAttemptNumber: checkpointSubmissionNumber,
        consumesSolverAttempt: true,
        state: "rejected",
        outcome: input.legacyInfrastructureInterruption
          ? "rejected"
          : "rejected_exhausted",
        resultAttemptId: checkpoint.id,
        completedAt: new Date(),
      });

      let latestJobId = checkpointJob.id;
      let legacySubmissionId: string | null = null;
      if (input.legacyInfrastructureInterruption) {
        const legacyError =
          "continuation failed: saved transient has no time directories; nothing to restart from";
        const legacyJob = await insertJob({
          suffix: `legacy-continuation-missing-${input.aoaDeg}`,
          status: "failed",
          requestPayload: {
            uransRequestId: request.id,
            aoas: [input.aoaDeg],
            uransFidelity: "precalc",
            precalcObligationIds: [obligation.id],
            continueFromResultAttemptId: checkpoint.id,
          },
          error: legacyError,
        });
        latestJobId = legacyJob.id;
        const [legacySubmission] = await db
          .insert(simPrecalcObligationAttempts)
          .values({
            obligationId: obligation.id,
            simJobId: legacyJob.id,
            attemptNumber: 2,
            solverAttemptNumber: 2,
            consumesSolverAttempt: true,
            state: "failed",
            outcome: "failed_exhausted",
            resultAttemptId: null,
            error: legacyError,
            completedAt: new Date(),
          })
          .returning();
        legacySubmissionId = legacySubmission.id;
      }

      await db
        .update(simPrecalcObligations)
        .set({
          state: "blocked",
          attemptCount: 2,
          latestSimJobId: latestJobId,
          lastOutcome: input.legacyInfrastructureInterruption
            ? "failed_exhausted"
            : "rejected_exhausted",
          lastError: input.legacyInfrastructureInterruption
            ? "continuation failed: saved transient has no time directories; nothing to restart from"
            : null,
          completedAt: new Date(),
        })
        .where(eq(simPrecalcObligations.id, obligation.id));
      await db
        .update(simUransRequests)
        .set({ state: "blocked", simJobId: latestJobId })
        .where(eq(simUransRequests.id, request.id));

      if (!input.legacyInfrastructureInterruption) {
        const recovery = await requeueRestartablePrecalcContinuations(db, {
          requestIds: [request.id],
        });
        expect(recovery).toMatchObject({
          obligationIds: [obligation.id],
          requestIds: [request.id],
          repairedSubmissionIds: [],
        });
        const [pendingAtMax] = await db
          .select()
          .from(simPrecalcObligations)
          .where(eq(simPrecalcObligations.id, obligation.id));
        expect(pendingAtMax).toMatchObject({
          state: "pending",
          attemptCount: 2,
          lastOutcome: "continuation_recovery_pending",
        });
        expect(
          await precalcContinuationsForObligations(db, [obligation.id]),
        ).toMatchObject([
          {
            obligationId: obligation.id,
            resultAttemptId: checkpoint.id,
          },
        ]);

        const freshAtMaxJob = await insertJob({
          suffix: `fresh-at-max-must-stop-${input.aoaDeg}`,
          status: "failed",
          requestPayload: {
            uransRequestId: request.id,
            aoas: [input.aoaDeg],
            uransFidelity: "precalc",
            precalcObligationIds: [obligation.id],
          },
        });
        await db
          .update(simJobs)
          .set({ status: "pending", finishedAt: null })
          .where(eq(simJobs.id, freshAtMaxJob.id));
        await db
          .update(simPrecalcObligations)
          .set({ latestSimJobId: freshAtMaxJob.id })
          .where(eq(simPrecalcObligations.id, obligation.id));
        let freshEngineCalled = false;
        const freshAtMax = await submitPendingJobWithLifecycleGuard({
          db,
          engine: {
            submitPolar: async () => {
              freshEngineCalled = true;
              throw new Error("fresh max-attempt job must not reach engine");
            },
          } as unknown as EngineClient,
          jobId: freshAtMaxJob.id,
          admissionLane: "local",
          campaignId: null,
          request: {} as PolarRequest,
          connectionErrorPrefix: "connection: ",
          submitErrorPrefix: "precalc submit: ",
          precalcObligationIds: [obligation.id],
        });
        expect(freshAtMax.kind).toBe("lifecycle_stopped");
        expect(freshEngineCalled).toBe(false);
        await db
          .update(simPrecalcObligations)
          .set({
            state: "pending",
            latestSimJobId: latestJobId,
            lastOutcome: "continuation_recovery_pending",
          })
          .where(eq(simPrecalcObligations.id, obligation.id));
      }

      const legacyCaptured: PolarRequest[] = [];
      resetUransLadderMemory();
      expect(
        await uransLadderTick(
          db,
          stubEngine(
            legacyCaptured,
            `${PREFIX}-legacy-must-not-reopen-${input.aoaDeg}`,
          ),
          0,
          {
            campaignIds: [],
            parentJobIds: [],
            promotionIds: [],
            requestIds: [request.id],
            verifyIds: [],
            // Production rolling-cutover shape: old 2406 advertises mesh v1
            // but has no durable URANS archive/continuation contract.
            meshRecoveryVersion: 1,
            uransRecoveryVersion: 0,
          },
        ),
      ).toBe(false);
      expect(legacyCaptured).toEqual([]);
      expect(
        (
          await db
            .select()
            .from(simPrecalcObligations)
            .where(eq(simPrecalcObligations.id, obligation.id))
        )[0],
      ).toMatchObject({
        state: input.legacyInfrastructureInterruption ? "blocked" : "pending",
      });

      const captured: PolarRequest[] = [];
      const engine = stubEngine(
        captured,
        `${PREFIX}-blocked-continuation-recovered-${input.aoaDeg}`,
      );
      resetUransLadderMemory();
      expect(
        await uransLadderTick(db, engine, 0, {
          campaignIds: [],
          parentJobIds: [],
          promotionIds: [],
          requestIds: [request.id],
          verifyIds: [],
          meshRecoveryVersion: 0,
          uransRecoveryVersion: 2,
        }),
      ).toBe(true);
      expect(captured[0].continue_from).toEqual({
        engine_job_id: checkpointJob.engineJobId,
        case_slug: checkpoint.engineCaseSlug,
      });
      expect(captured[0].expected_urans_recovery_version).toBe(2);

      const [runningRequest] = await db
        .select()
        .from(simUransRequests)
        .where(eq(simUransRequests.id, request.id));
      expect(runningRequest.state).toBe("running");
      const [continuationJob] = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.id, runningRequest.simJobId!));
      jobIds.push(continuationJob.id);
      expect(continuationJob.requestPayload).toMatchObject({
        continueFromResultAttemptId: checkpoint.id,
        precalcObligationIds: [obligation.id],
      });

      const [reopened] = await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation.id));
      expect(reopened).toMatchObject({
        state: "running",
        attemptCount: input.legacyInfrastructureInterruption ? 1 : 2,
        lastOutcome: "submitted",
      });
      const audit = await db
        .select()
        .from(simPrecalcObligationAttempts)
        .where(eq(simPrecalcObligationAttempts.obligationId, obligation.id))
        .orderBy(simPrecalcObligationAttempts.attemptNumber);
      expect(audit.at(-1)).toMatchObject({
        attemptNumber: 3,
        solverAttemptNumber: null,
        consumesSolverAttempt: false,
        state: "submitted",
      });
      if (legacySubmissionId) {
        const repaired = audit.find(
          (attempt) => attempt.id === legacySubmissionId,
        );
        expect(repaired).toMatchObject({
          solverAttemptNumber: null,
          consumesSolverAttempt: false,
          state: "cancelled",
          outcome: "infrastructure_retry_wait",
          resultAttemptId: null,
          error:
            "continuation failed: saved transient has no time directories; nothing to restart from",
        });
      } else {
        expect(audit[1]).toMatchObject({
          solverAttemptNumber: 2,
          consumesSolverAttempt: true,
          state: "rejected",
          resultAttemptId: checkpoint.id,
        });
      }
    } finally {
      if (requestId) {
        await db
          .delete(simUransRequests)
          .where(eq(simUransRequests.id, requestId));
      }
      if (obligationId) {
        await db
          .delete(simPrecalcObligations)
          .where(eq(simPrecalcObligations.id, obligationId));
      }
      if (checkpointResultAttemptId) {
        await db
          .update(results)
          .set({ currentResultAttemptId: null })
          .where(eq(results.id, checkpointResultId));
      }
      if (checkpointResultId) {
        await db.delete(results).where(eq(results.id, checkpointResultId));
      }
      if (jobIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
      }
    }
  }

  it("CONTINUATION PAYLOAD MUST-CATCH: the ladder tick composes continue_from + budget_override_s and pins them on the sim_job payload", async () => {
    // Quiet slate for tier 2b: earlier tests settled their requests; make sure
    // nothing pending remains scoped to this revision.
    await db
      .update(simUransRequests)
      .set({ state: "cancelled" })
      .where(
        and(
          eq(simUransRequests.revisionId, revisionId),
          inArray(simUransRequests.state, ["pending", "running"]),
        ),
      );

    // The budget-stopped source: a REJECTED precalc URANS row whose engine
    // case ids address the saved case state on the volume, quality warning
    // carrying the engine's wall-clock budget-guard sentence.
    const [sourceJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        campaignId: null,
        methodKey: "openfoam.urans",
        jobKind: "targeted",
        referenceChordM: CHORD,
        wave: 2,
        status: "done",
        engineState: "completed",
        engineJobId: `${PREFIX}-budget-stopped-job`,
        submittedAt: new Date(),
        finishedAt: new Date(),
        totalCases: 1,
        completedCases: 1,
        requestPayload: {
          aoas: [CONTINUE_AOA],
          uransFidelity: "precalc",
        },
      })
      .returning({ id: simJobs.id });
    const [source] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: CONTINUE_AOA,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        simJobId: sourceJob.id,
        methodKey: "openfoam.urans",
        solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        reynolds: Math.round((SPEED * CHORD) / (1.789e-5 / 1.225)),
        speed: SPEED,
        chord: CHORD,
        cl: 0.9,
        cd: 0.08,
        cm: -0.05,
        unsteady: true,
        converged: true,
        engineJobId: `${PREFIX}-budget-stopped-job`,
        engineCaseSlug: "aoa_12.00",
        qualityWarnings: [
          "URANS integration stopped by the wall-clock budget guard: retained 1.4 of 3 periods (budget); projected 3.2h continuation exceeds 80% of the 2.0h solver timeout",
        ],
        solvedAt: new Date(),
      })
      .returning();
    sourceResultId = source.id;
    const sourceResultAttemptId = await attachRestartableContinuationAttempt({
      resultId: source.id,
      aoaDeg: CONTINUE_AOA,
      simJobId: sourceJob.id,
      engineJobId: source.engineJobId,
      engineCaseSlug: source.engineCaseSlug,
      qualityWarnings: source.qualityWarnings ?? [],
    });

    const { request, created } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: CONTINUE_AOA,
      fidelity: "precalc",
      requestedBy: "test@airfoils.pro",
      continueFromResultId: sourceResultId,
      continueFromResultAttemptId: sourceResultAttemptId,
      budgetOverrideS: 21600, // the +6h choice
    });
    expect(created).toBe(true);
    expect(request.continueFromResultId).toBe(sourceResultId);
    expect(request.budgetOverrideS).toBe(21600);
    expect(
      await isExactRestartablePrecalcAttempt(
        db,
        sourceResultId,
        sourceResultAttemptId,
      ),
    ).toBe(true);
    const [sourceObligation] = await ensurePrecalcObligations(
      db,
      [
        {
          airfoilId,
          revisionId,
          aoaDeg: CONTINUE_AOA,
          sourceResultId,
        },
      ],
      { requestIds: [request.id], backgroundOwner: true },
    );
    await db.insert(simPrecalcObligationAttempts).values({
      obligationId: sourceObligation.id,
      simJobId: sourceJob.id,
      attemptNumber: 1,
      solverAttemptNumber: 1,
      consumesSolverAttempt: true,
      state: "rejected",
      outcome: "rejected",
      resultAttemptId: sourceResultAttemptId,
      completedAt: new Date(),
    });
    await db
      .update(simPrecalcObligations)
      .set({
        state: "pending",
        attemptCount: 1,
        latestSimJobId: sourceJob.id,
        lastOutcome: "rejected",
      })
      .where(eq(simPrecalcObligations.id, sourceObligation.id));

    const captured: PolarRequest[] = [];
    const scope = await ladderScope();
    expect(scope.requestIds).toContain(request.id);
    const submitted = await uransLadderTick(
      db,
      stubEngine(captured, `${PREFIX}-continuation-job`),
      0,
      {
        ...scope,
        // This assertion is specifically tier 2b request composition. Strict
        // durable tier 2a priority is covered above, so close both campaign
        // recovery scopes instead of letting unrelated fixture work win.
        parentJobIds: [],
        promotionIds: [],
        meshRecoveryVersion: 2,
        uransRecoveryVersion: 2,
      },
    );
    expect(submitted).toBe(true);
    expect(captured.length).toBe(1);
    // ENGINE-REQUEST SHAPE PIN (amendment C contract): the engine copies/links
    // the prior case dir and restarts the transient from latestTime, merging
    // coefficient history — addressed EXACTLY by these two fields.
    expect(captured[0].continue_from).toEqual({
      engine_job_id: `${PREFIX}-budget-stopped-job`,
      case_slug: "aoa_12.00",
    });
    expect(captured[0].budget_override_s).toBe(21600);
    expect(captured[0].expected_urans_recovery_version).toBe(2);
    // Still URANS-by-definition (prod job e89be2bb class).
    expect(captured[0].solver).toMatchObject({
      force_transient: true,
      transient_fallback: true,
      urans_fidelity: "precalc",
    });
    expect(captured[0].aoa?.angles).toEqual([CONTINUE_AOA]);

    const [afterRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    expect(afterRequest.state).toBe("running");
    expect(afterRequest.simJobId).toBeTruthy();
    const [job] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, afterRequest.simJobId!));
    expect(job.wave).toBe(2);
    expect(job.jobKind).toBe("targeted");
    const payload = job.requestPayload as {
      uransRequestId?: string;
      continueFromResultId?: string;
      continueFromResultAttemptId?: string;
      budgetOverrideS?: number;
      uransRecoveryVersion?: number;
    };
    expect(payload.uransRequestId).toBe(request.id);
    expect(payload.continueFromResultId).toBe(sourceResultId);
    expect(payload.continueFromResultAttemptId).toBe(sourceResultAttemptId);
    expect(payload.budgetOverrideS).toBe(21600);
    expect(payload.uransRecoveryVersion).toBe(2);

    // Settle (continuation results ingest normally — same cell upsert; the
    // ingest path itself is covered by the ladder ingest tests above).
    await db
      .update(simJobs)
      .set({ status: "done", ingestedAt: new Date(), finishedAt: new Date() })
      .where(eq(simJobs.id, job.id));
    await db
      .update(simUransRequests)
      .set({ state: "done" })
      .where(eq(simUransRequests.id, request.id));
  }, 120000);

  it("cancels a continuation whose source lost its saved case state instead of faking a fresh solve as a resume", async () => {
    const [orphanSource] = await db
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
        cl: 0.8,
        cd: 0.07,
        unsteady: true,
        converged: true,
        // engineJobId / engineCaseSlug DELIBERATELY absent: no case state.
        solvedAt: new Date(),
      })
      .returning();
    const orphanSourceAttemptId = await attachRestartableContinuationAttempt({
      resultId: orphanSource.id,
      aoaDeg: 13,
      engineJobId: null,
      engineCaseSlug: null,
      qualityWarnings: [
        `URANS continuation ${URANS_CONTINUATION_REQUIRED_MARKER}: exact source intentionally lost its saved case address`,
      ],
    });
    const { request } = await createUransRequest(db, {
      airfoilId,
      revisionId,
      aoaDeg: 13,
      fidelity: "precalc",
      continueFromResultId: orphanSource.id,
      continueFromResultAttemptId: orphanSourceAttemptId,
      budgetOverrideS: 7200,
    });
    const captured: PolarRequest[] = [];
    const submitted = await uransLadderTick(
      db,
      stubEngine(captured, `${PREFIX}-orphan-continuation`),
      0,
      {
        ...(await ladderScope()),
        parentJobIds: [],
        promotionIds: [],
        uransRecoveryVersion: 2,
      },
    );
    expect(submitted).toBe(false);
    expect(captured.length).toBe(0);
    const [afterRequest] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, request.id));
    expect(afterRequest.state).toBe("cancelled");
  }, 120000);

  it("MUST-CATCH: the scheduler rejects a continuation unless the exact archived PRECALC generation matches its target cell", async () => {
    const [otherAirfoil] = await db
      .select({ id: airfoils.id })
      .from(airfoils)
      .where(dsql`${airfoils.id} <> ${airfoilId}::uuid`)
      .limit(1);
    if (!otherAirfoil) throw new Error("second seeded airfoil missing");

    const variants = [
      "wrong-airfoil",
      "wrong-aoa",
      "attempt-status",
      "result-status",
      "source",
      "fidelity",
      "classification",
      "marker",
      "missing-archive",
      "incomplete-archive",
    ] as const;
    for (let index = 0; index < variants.length; index += 1) {
      const variant = variants[index]!;
      const sourceAoa = 60 + index / 10;
      const [source] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: sourceAoa,
          status: "done",
          source: "solved",
          regime: "urans",
          fidelity: "urans_precalc",
          methodKey: "openfoam.urans",
          solverImplementationId: (
            await db
              .select({
                id: simulationPresetRevisions.solverImplementationId,
              })
              .from(simulationPresetRevisions)
              .where(eq(simulationPresetRevisions.id, revisionId))
          )[0]!.id,
          unsteady: true,
          converged: true,
          engineJobId: `${PREFIX}-guard-${variant}`,
          engineCaseSlug: `aoa_${sourceAoa}`,
          qualityWarnings: [
            `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: exact checkpoint retained`,
          ],
          solvedAt: new Date(),
        })
        .returning();
      const sourceAttemptId = await attachRestartableContinuationAttempt({
        resultId: source.id,
        aoaDeg: sourceAoa,
        engineJobId: source.engineJobId,
        engineCaseSlug: source.engineCaseSlug,
        status: variant === "attempt-status" ? "running" : "done",
        source: variant === "source" ? "queued" : "solved",
        fidelity: variant === "fidelity" ? "urans_full" : "urans_precalc",
        classification: variant === "classification" ? "accepted" : "rejected",
        qualityWarnings:
          variant === "marker" ? [] : (source.qualityWarnings ?? []),
        archive:
          variant === "missing-archive"
            ? "missing"
            : variant === "incomplete-archive"
              ? "incomplete"
              : "valid",
      });
      if (variant === "result-status") {
        await db
          .update(results)
          .set({ status: "pending" })
          .where(eq(results.id, source.id));
      }

      const [request] = await db
        .insert(simUransRequests)
        .values({
          airfoilId: variant === "wrong-airfoil" ? otherAirfoil.id : airfoilId,
          revisionId,
          aoaDeg: variant === "wrong-aoa" ? sourceAoa + 1 : sourceAoa,
          fidelity: "precalc",
          state: "pending",
          backgroundOwner: true,
          requestedBy: `${PREFIX}-guard-${variant}`,
          continueFromResultId: source.id,
          continueFromResultAttemptId: sourceAttemptId,
          budgetOverrideS: 7200,
        })
        .returning();
      const captured: PolarRequest[] = [];
      resetUransLadderMemory();
      expect(
        await uransLadderTick(
          db,
          stubEngine(captured, `${PREFIX}-must-not-submit-${variant}`),
          0,
          {
            campaignIds: [],
            parentJobIds: [],
            promotionIds: [],
            requestIds: [request.id],
            verifyIds: [],
            meshRecoveryVersion: 0,
            uransRecoveryVersion: 2,
          },
        ),
        variant,
      ).toBe(false);
      expect(captured, variant).toEqual([]);
      const [cancelled] = await db
        .select({ state: simUransRequests.state })
        .from(simUransRequests)
        .where(eq(simUransRequests.id, request.id));
      expect(cancelled?.state, variant).toBe("cancelled");
      await db
        .delete(simUransRequests)
        .where(eq(simUransRequests.id, request.id));
      await db.delete(results).where(eq(results.id, source.id));
    }
  }, 180000);

  it("MUST-CATCH: a restartable PRECALC checkpoint reopens and schedules same-case continuation at the exhausted fresh-solve limit", async () => {
    await assertBlockedCheckpointRecovery({
      aoaDeg: 33.125,
      legacyInfrastructureInterruption: false,
    });
  }, 120000);

  it("MUST-CATCH: a pre-typed evidence-less continuation failure is repaired in place and auto-reopens from the earlier checkpoint", async () => {
    await assertBlockedCheckpointRecovery({
      aoaDeg: 34.125,
      legacyInfrastructureInterruption: true,
    });
  }, 120000);

  it("ENGINE IDENTITY MUST-CATCH: continuation preserves same-2406 state but never stages a 2406 checkpoint into a 2606 successor cell", async () => {
    const jobIds: string[] = [];
    const resultIds: string[] = [];
    const obligationIds: string[] = [];
    let legacyRevisionId = "";
    try {
      const [targetRevision] = await db
        .select()
        .from(simulationPresetRevisions)
        .where(eq(simulationPresetRevisions.id, revisionId))
        .limit(1);
      expect(targetRevision).toBeDefined();
      const targetSnapshot = targetRevision!.snapshot as Record<
        string,
        unknown
      > & {
        engine?: Record<string, unknown>;
      };
      const [legacyRevision] = await db
        .insert(simulationPresetRevisions)
        .values({
          presetId: targetRevision!.presetId,
          revisionNumber: targetRevision!.revisionNumber + 100_000,
          signatureHash: `${PREFIX}-same-2406-continuation`,
          reynolds: targetRevision!.reynolds,
          mach: targetRevision!.mach,
          referenceLengthM: targetRevision!.referenceLengthM,
          snapshot: {
            ...targetSnapshot,
            engine: {
              ...(targetSnapshot.engine ?? {}),
              implementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
              key: "openfoam:opencfd:2406:adapter-v1:numerics-v1",
              family: "openfoam",
              distribution: "opencfd",
              releaseVersion: "2406",
              methodFamily: "finite_volume_rans_urans",
              adapterContractVersion: 1,
              numericsRevision: "numerics-v1",
            },
          },
          solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
          physicsHash: null,
          methodCompatibilityHashVersion: null,
          methodCompatibilityHash: null,
          isCanonicalPhysics: false,
          isCanonicalMethod: false,
        })
        .returning();
      legacyRevisionId = legacyRevision.id;

      const insertCheckpoint = async (input: {
        revisionId: string;
        aoaDeg: number;
        suffix: string;
        obligationState: "pending" | "blocked";
        attemptCount: number;
      }) => {
        const [obligation] = await db
          .insert(simPrecalcObligations)
          .values({
            airfoilId,
            revisionId: input.revisionId,
            aoaDeg: input.aoaDeg,
            state: input.obligationState,
            attemptCount: input.attemptCount,
            backgroundOwner: true,
            lastOutcome:
              input.obligationState === "blocked"
                ? "rejected_exhausted"
                : "rejected",
            completedAt:
              input.obligationState === "blocked" ? new Date() : null,
          })
          .returning();
        obligationIds.push(obligation.id);
        const [job] = await db
          .insert(simJobs)
          .values({
            airfoilId,
            bcIds: [bcId],
            simulationPresetRevisionId: input.revisionId,
            solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
            campaignId: null,
            jobKind: "targeted",
            referenceChordM: CHORD,
            wave: 2,
            status: "done",
            engineJobId: `${PREFIX}-${input.suffix}`,
            submittedAt: new Date(),
            finishedAt: new Date(),
            totalCases: 1,
            completedCases: 1,
            requestPayload: {
              aoas: [input.aoaDeg],
              uransFidelity: "precalc",
              precalcObligationIds: [obligation.id],
            },
          })
          .returning();
        jobIds.push(job.id);
        const [checkpointResult] = await db
          .insert(results)
          .values({
            airfoilId,
            bcId,
            simulationPresetRevisionId: input.revisionId,
            methodKey: "openfoam.urans",
            solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
            aoaDeg: input.aoaDeg,
            engineJobId: job.engineJobId,
            engineCaseSlug: `aoa_${input.aoaDeg}`,
            status: "done",
            source: "solved",
            regime: "urans",
            fidelity: "urans_precalc",
            converged: true,
            unsteady: true,
            qualityWarnings: [
              `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: retained restartable latestTime state`,
            ],
            solvedAt: new Date(),
          })
          .returning();
        resultIds.push(checkpointResult.id);
        const checkpointId = await attachRestartableContinuationAttempt({
          resultId: checkpointResult.id,
          revisionId: input.revisionId,
          aoaDeg: input.aoaDeg,
          simJobId: job.id,
          engineJobId: job.engineJobId,
          engineCaseSlug: `aoa_${input.aoaDeg}`,
          solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
          qualityWarnings: checkpointResult.qualityWarnings ?? [],
        });
        const [checkpoint] = await db
          .select()
          .from(resultAttempts)
          .where(eq(resultAttempts.id, checkpointId));
        expect(checkpoint).toBeDefined();
        await db.insert(simPrecalcObligationAttempts).values({
          obligationId: obligation.id,
          simJobId: job.id,
          attemptNumber: input.attemptCount,
          solverAttemptNumber: input.attemptCount,
          consumesSolverAttempt: true,
          state: "rejected",
          outcome:
            input.obligationState === "blocked"
              ? "rejected_exhausted"
              : "rejected",
          resultAttemptId: checkpoint.id,
          completedAt: new Date(),
        });
        await db
          .update(simPrecalcObligations)
          .set({ latestSimJobId: job.id })
          .where(eq(simPrecalcObligations.id, obligation.id));
        return { obligation, checkpoint };
      };

      const same2406 = await insertCheckpoint({
        revisionId: legacyRevision.id,
        aoaDeg: 35.125,
        suffix: "same-2406-checkpoint",
        obligationState: "pending",
        attemptCount: 1,
      });
      expect(
        await precalcContinuationsForObligations(db, [same2406.obligation.id]),
      ).toMatchObject([
        {
          obligationId: same2406.obligation.id,
          resultAttemptId: same2406.checkpoint.id,
        },
      ]);

      const crossVersion = await insertCheckpoint({
        revisionId,
        aoaDeg: 36.125,
        suffix: "2406-checkpoint-for-2606-cell",
        obligationState: "blocked",
        attemptCount: 2,
      });
      expect(
        await precalcContinuationsForObligations(db, [
          crossVersion.obligation.id,
        ]),
      ).toEqual([]);
      expect(
        await requeueRestartablePrecalcContinuations(db, {
          obligationIds: [crossVersion.obligation.id],
        }),
      ).toEqual({
        obligationIds: [],
        campaignIds: [],
        requestIds: [],
        repairedSubmissionIds: [],
      });
      const [stillBlocked] = await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, crossVersion.obligation.id));
      expect(stillBlocked).toMatchObject({
        state: "blocked",
        attemptCount: 2,
      });
    } finally {
      if (obligationIds.length) {
        await db
          .delete(simPrecalcObligations)
          .where(inArray(simPrecalcObligations.id, obligationIds));
      }
      if (resultIds.length) {
        await db
          .update(results)
          .set({ currentResultAttemptId: null })
          .where(inArray(results.id, resultIds));
        await db.delete(results).where(inArray(results.id, resultIds));
      }
      if (jobIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
      }
      if (legacyRevisionId) {
        await db
          .delete(simulationPresetRevisions)
          .where(eq(simulationPresetRevisions.id, legacyRevisionId));
      }
    }
  }, 120000);

  it("OWNER MUST-CATCH: a parentless campaign-owned continuation request reopens and drains with its obligation", async () => {
    const aoaDeg = 37.125;
    const jobIds: string[] = [];
    const resultIds: string[] = [];
    let requestId = "";
    let obligationId = "";
    try {
      await db
        .update(simCampaigns)
        .set({ status: "active", completedAt: null })
        .where(eq(simCampaigns.id, campaignId));
      const [targetRevision] = await db
        .select()
        .from(simulationPresetRevisions)
        .where(eq(simulationPresetRevisions.id, revisionId))
        .limit(1);
      expect(targetRevision).toBeDefined();

      const [request] = await db
        .insert(simUransRequests)
        .values({
          airfoilId,
          revisionId,
          aoaDeg,
          fidelity: "precalc",
          state: "pending",
          backgroundOwner: false,
          requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
        })
        .returning();
      requestId = request.id;
      await db.insert(simUransRequestCampaigns).values({
        requestId: request.id,
        campaignId,
        state: "active",
      });
      const [obligation] = await ensurePrecalcObligations(
        db,
        [{ airfoilId, revisionId, aoaDeg }],
        { campaignIds: [campaignId], requestIds: [request.id] },
      );
      expect(obligation).toBeDefined();
      obligationId = obligation!.id;

      const [checkpointJob] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          solverImplementationId: targetRevision!.solverImplementationId,
          campaignId: null,
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "done",
          engineJobId: `${PREFIX}-campaign-owned-checkpoint`,
          submittedAt: new Date(),
          finishedAt: new Date(),
          totalCases: 1,
          completedCases: 1,
          requestPayload: {
            uransRequestId: request.id,
            aoas: [aoaDeg],
            uransFidelity: "precalc",
            precalcObligationIds: [obligation.id],
          },
        })
        .returning();
      jobIds.push(checkpointJob.id);
      const [checkpointResult] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          methodKey: "openfoam.urans",
          solverImplementationId: targetRevision!.solverImplementationId,
          aoaDeg,
          engineJobId: checkpointJob.engineJobId,
          engineCaseSlug: "aoa_37.125",
          status: "done",
          source: "solved",
          regime: "urans",
          fidelity: "urans_precalc",
          converged: true,
          unsteady: true,
          qualityWarnings: [
            `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: retained restartable latestTime state`,
          ],
          solvedAt: new Date(),
        })
        .returning();
      resultIds.push(checkpointResult.id);
      const checkpointId = await attachRestartableContinuationAttempt({
        resultId: checkpointResult.id,
        aoaDeg,
        simJobId: checkpointJob.id,
        engineJobId: checkpointJob.engineJobId,
        engineCaseSlug: "aoa_37.125",
        solverImplementationId: targetRevision!.solverImplementationId!,
        qualityWarnings: checkpointResult.qualityWarnings ?? [],
      });
      const [checkpoint] = await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.id, checkpointId));
      expect(checkpoint).toBeDefined();
      await db.insert(simPrecalcObligationAttempts).values({
        obligationId: obligation.id,
        simJobId: checkpointJob.id,
        attemptNumber: 2,
        solverAttemptNumber: 2,
        consumesSolverAttempt: true,
        state: "rejected",
        outcome: "rejected_exhausted",
        resultAttemptId: checkpoint.id,
        completedAt: new Date(),
      });
      await db
        .update(simPrecalcObligations)
        .set({
          state: "blocked",
          attemptCount: 2,
          latestSimJobId: checkpointJob.id,
          lastOutcome: "rejected_exhausted",
          completedAt: new Date(),
        })
        .where(eq(simPrecalcObligations.id, obligation.id));
      await db
        .update(simUransRequests)
        .set({ state: "blocked", simJobId: checkpointJob.id })
        .where(eq(simUransRequests.id, request.id));
      await db
        .update(simCampaigns)
        .set({ status: "paused" })
        .where(eq(simCampaigns.id, campaignId));

      expect(
        await requeueRestartablePrecalcContinuations(db, {
          requestIds: [request.id],
        }),
      ).toMatchObject({
        obligationIds: [obligation.id],
        requestIds: [request.id],
      });
      const [reopenedRequest] = await db
        .select()
        .from(simUransRequests)
        .where(eq(simUransRequests.id, request.id));
      expect(reopenedRequest).toMatchObject({
        state: "pending",
        backgroundOwner: false,
        simJobId: null,
      });

      await db
        .update(simCampaigns)
        .set({ status: "active" })
        .where(eq(simCampaigns.id, campaignId));
      const captured: PolarRequest[] = [];
      resetUransLadderMemory();
      expect(
        await uransLadderTick(
          db,
          stubEngine(captured, `${PREFIX}-campaign-owned-continuation`),
          0,
          {
            campaignIds: [],
            parentJobIds: [],
            promotionIds: [],
            requestIds: [request.id],
            verifyIds: [],
            meshRecoveryVersion: 0,
            uransRecoveryVersion: 2,
          },
        ),
      ).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0].continue_from).toEqual({
        engine_job_id: checkpointJob.engineJobId,
        case_slug: checkpoint.engineCaseSlug,
      });
      const [runningRequest] = await db
        .select()
        .from(simUransRequests)
        .where(eq(simUransRequests.id, request.id));
      expect(runningRequest.state).toBe("running");
      expect(runningRequest.simJobId).toBeTruthy();
      jobIds.push(runningRequest.simJobId!);
    } finally {
      resetUransLadderMemory();
      if (obligationId) {
        await db
          .delete(simPrecalcObligations)
          .where(eq(simPrecalcObligations.id, obligationId));
      }
      if (requestId) {
        await db
          .delete(simUransRequests)
          .where(eq(simUransRequests.id, requestId));
      }
      if (resultIds.length) {
        await db
          .update(results)
          .set({ currentResultAttemptId: null })
          .where(inArray(results.id, resultIds));
        await db.delete(results).where(inArray(results.id, resultIds));
      }
      if (jobIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
      }
      await db
        .update(simCampaigns)
        .set({ status: "active", completedAt: null })
        .where(eq(simCampaigns.id, campaignId));
    }
  }, 120000);

  it("MUST-CATCH: a typed infrastructure loss during same-case PRECALC continuation preserves the restartable checkpoint and fresh-solve budget", async () => {
    const aoaDeg = 32.125;
    const jobIds: string[] = [];
    const resultIds: string[] = [];
    const resultAttemptIds: string[] = [];
    let requestId = "";
    let obligationId = "";
    try {
      const { request, created } = await createUransRequest(db, {
        airfoilId,
        revisionId,
        aoaDeg,
        fidelity: "precalc",
        requestedBy: "continuation-recovery@test.airfoils.pro",
      });
      expect(created).toBe(true);
      requestId = request.id;

      const [obligation] = await ensurePrecalcObligations(
        db,
        [{ airfoilId, revisionId, aoaDeg }],
        { requestIds: [request.id], backgroundOwner: true },
      );
      expect(obligation).toBeDefined();
      obligationId = obligation!.id;

      const [initialJob] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          campaignId: null,
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "submitted",
          engineJobId: `${PREFIX}-continuation-recovery-initial`,
          submittedAt: new Date(),
          totalCases: 1,
          completedCases: 1,
          requestPayload: {
            uransRequestId: request.id,
            aoas: [aoaDeg],
            uransFidelity: "precalc",
            precalcObligationIds: [obligation.id],
          },
        })
        .returning();
      jobIds.push(initialJob.id);
      await db
        .update(simPrecalcObligations)
        .set({ latestSimJobId: initialJob.id, lastOutcome: "composed" })
        .where(eq(simPrecalcObligations.id, obligation.id));
      await db
        .update(simUransRequests)
        .set({ state: "running", simJobId: initialJob.id })
        .where(eq(simUransRequests.id, request.id));
      await recordPrecalcObligationSubmission(db, initialJob.id, [
        obligation.id,
      ]);

      const [targetRevision] = await db
        .select({
          solverImplementationId:
            simulationPresetRevisions.solverImplementationId,
        })
        .from(simulationPresetRevisions)
        .where(eq(simulationPresetRevisions.id, revisionId));
      if (!targetRevision?.solverImplementationId) {
        throw new Error(
          `fixture revision ${revisionId} has no solver identity`,
        );
      }
      const [checkpointResult] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          methodKey: "openfoam.urans",
          solverImplementationId: targetRevision.solverImplementationId,
          aoaDeg,
          engineJobId: initialJob.engineJobId,
          engineCaseSlug: "aoa_32.125",
          status: "done",
          source: "solved",
          regime: "urans",
          fidelity: "urans_precalc",
          cl: 0.74,
          cd: 0.11,
          cm: -0.04,
          clCd: 6.73,
          converged: true,
          unsteady: true,
          qualityWarnings: [
            `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: retained restartable latestTime state`,
          ],
          solvedAt: new Date(),
        })
        .returning();
      resultIds.push(checkpointResult.id);
      const checkpointId = await attachRestartableContinuationAttempt({
        resultId: checkpointResult.id,
        aoaDeg,
        simJobId: initialJob.id,
        engineJobId: initialJob.engineJobId,
        engineCaseSlug: "aoa_32.125",
        solverImplementationId: targetRevision.solverImplementationId,
        qualityWarnings: checkpointResult.qualityWarnings ?? [],
      });
      const [checkpoint] = await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.id, checkpointId));
      expect(checkpoint).toBeDefined();
      const [completedInitialJob] = await db
        .update(simJobs)
        .set({ status: "done", finishedAt: new Date() })
        .where(eq(simJobs.id, initialJob.id))
        .returning();
      await settlePrecalcObligationsForJob(db, completedInitialJob);

      const [afterCheckpoint] = await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation.id));
      expect(afterCheckpoint).toMatchObject({
        state: "pending",
        attemptCount: 1,
        lastOutcome: "rejected",
      });

      const captured: PolarRequest[] = [];
      let engineSubmission = 0;
      const engine = {
        submitPolar: async (polarRequest: PolarRequest): Promise<JobStatus> => {
          captured.push(polarRequest);
          engineSubmission += 1;
          return {
            job_id: `${PREFIX}-continuation-recovery-${engineSubmission}`,
            state: "pending",
            total_cases: polarRequest.aoa?.angles?.length ?? 0,
            completed_cases: 0,
          };
        },
      } as unknown as EngineClient;
      const scope = {
        campaignIds: [],
        parentJobIds: [],
        promotionIds: [],
        requestIds: [request.id],
        verifyIds: [],
        meshRecoveryVersion: 0,
        uransRecoveryVersion: 2,
      };

      resetUransLadderMemory();
      expect(await uransLadderTick(db, engine, 0, scope)).toBe(true);
      expect(captured[0].continue_from).toEqual({
        engine_job_id: initialJob.engineJobId,
        case_slug: checkpoint.engineCaseSlug,
      });
      const [runningRequest] = await db
        .select()
        .from(simUransRequests)
        .where(eq(simUransRequests.id, request.id));
      expect(runningRequest.state).toBe("running");
      expect(runningRequest.simJobId).toBeTruthy();
      const [interruptedJob] = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.id, runningRequest.simJobId!));
      jobIds.push(interruptedJob.id);
      expect(interruptedJob.requestPayload).toMatchObject({
        continueFromResultAttemptId: checkpoint.id,
        precalcObligationIds: [obligation.id],
      });
      const [interruptedSubmission] = await db
        .select()
        .from(simPrecalcObligationAttempts)
        .where(
          and(
            eq(simPrecalcObligationAttempts.obligationId, obligation.id),
            eq(simPrecalcObligationAttempts.simJobId, interruptedJob.id),
          ),
        );
      expect(interruptedSubmission).toMatchObject({
        attemptNumber: 2,
        solverAttemptNumber: null,
        consumesSolverAttempt: false,
        state: "submitted",
      });

      const [failedContinuationJob] = await db
        .update(simJobs)
        .set({
          status: "failed",
          finishedAt: new Date(),
          error: "worker restart removed the continuation case before evidence",
        })
        .where(eq(simJobs.id, interruptedJob.id))
        .returning();
      await settlePrecalcObligationsForJob(db, failedContinuationJob, {
        terminalError:
          "worker restart removed the continuation case before evidence",
        terminalContinuationFailureKind: "transient",
      });

      const [afterInfrastructureLoss] = await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation.id));
      expect(afterInfrastructureLoss).toMatchObject({
        state: "pending",
        attemptCount: 1,
        lastOutcome: "infrastructure_retry_wait",
      });
      const [interruptedAudit] = await db
        .select()
        .from(simPrecalcObligationAttempts)
        .where(eq(simPrecalcObligationAttempts.id, interruptedSubmission.id));
      expect(interruptedAudit).toMatchObject({
        attemptNumber: 2,
        solverAttemptNumber: null,
        consumesSolverAttempt: false,
        state: "cancelled",
        outcome: "infrastructure_retry_wait",
        resultAttemptId: null,
      });

      // Typed infrastructure recovery owns a durable retry time. The scheduler
      // must not spin an unchanged continuation before the backoff expires.
      resetUransLadderMemory();
      expect(await uransLadderTick(db, engine, 0, scope)).toBe(false);
      expect(captured).toHaveLength(1);

      await db
        .update(simPrecalcObligations)
        .set({ nextSubmitAt: new Date(0) })
        .where(eq(simPrecalcObligations.id, obligation.id));
      resetUransLadderMemory();
      expect(await uransLadderTick(db, engine, 0, scope)).toBe(true);
      expect(captured).toHaveLength(2);
      expect(captured[1].continue_from).toEqual({
        engine_job_id: initialJob.engineJobId,
        case_slug: checkpoint.engineCaseSlug,
      });

      const [recoveredRequest] = await db
        .select()
        .from(simUransRequests)
        .where(eq(simUransRequests.id, request.id));
      expect(recoveredRequest.state).toBe("running");
      expect(recoveredRequest.simJobId).toBeTruthy();
      const [recoveredJob] = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.id, recoveredRequest.simJobId!));
      jobIds.push(recoveredJob.id);
      expect(recoveredJob.requestPayload).toMatchObject({
        continueFromResultAttemptId: checkpoint.id,
        precalcObligationIds: [obligation.id],
      });

      const immutableAudit = await db
        .select()
        .from(simPrecalcObligationAttempts)
        .where(eq(simPrecalcObligationAttempts.obligationId, obligation.id))
        .orderBy(simPrecalcObligationAttempts.attemptNumber);
      expect(
        immutableAudit.map((attempt) => ({
          attemptNumber: attempt.attemptNumber,
          solverAttemptNumber: attempt.solverAttemptNumber,
          consumesSolverAttempt: attempt.consumesSolverAttempt,
          state: attempt.state,
        })),
      ).toEqual([
        {
          attemptNumber: 1,
          solverAttemptNumber: 1,
          consumesSolverAttempt: true,
          state: "rejected",
        },
        {
          attemptNumber: 2,
          solverAttemptNumber: null,
          consumesSolverAttempt: false,
          state: "cancelled",
        },
        {
          attemptNumber: 3,
          solverAttemptNumber: null,
          consumesSolverAttempt: false,
          state: "submitted",
        },
      ]);
      const [duringRecoveredContinuation] = await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation.id));
      expect(duringRecoveredContinuation.attemptCount).toBe(1);

      const [accepted] = await db
        .insert(resultAttempts)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg,
          simJobId: recoveredJob.id,
          engineJobId: recoveredJob.engineJobId,
          engineCaseSlug: "aoa_32.125",
          status: "done",
          source: "solved",
          regime: "urans",
          validForPolar: true,
          cl: 0.76,
          cd: 0.105,
          cm: -0.039,
          clCd: 7.24,
          converged: true,
          stalled: false,
          unsteady: true,
          evidencePayload: { fidelity: "urans_precalc" },
          solvedAt: new Date(),
        })
        .returning();
      resultAttemptIds.push(accepted.id);
      await db.insert(resultClassifications).values({
        resultAttemptId: accepted.id,
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        regime: "urans",
        classifierVersion: "continuation-infrastructure-recovery-v1",
        state: "accepted",
        region: "post_stall",
        confidence: 1,
        reasons: [],
      });
      const [completedRecoveredJob] = await db
        .update(simJobs)
        .set({
          status: "done",
          completedCases: 1,
          finishedAt: new Date(),
        })
        .where(eq(simJobs.id, recoveredJob.id))
        .returning();
      await settlePrecalcObligationsForJob(db, completedRecoveredJob);

      const [settled] = await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation.id));
      expect(settled).toMatchObject({
        state: "satisfied",
        attemptCount: 1,
        sourceResultAttemptId: accepted.id,
        lastOutcome: "accepted",
      });
    } finally {
      if (requestId) {
        await db
          .delete(simUransRequests)
          .where(eq(simUransRequests.id, requestId));
      }
      if (obligationId) {
        await db
          .delete(simPrecalcObligations)
          .where(eq(simPrecalcObligations.id, obligationId));
      }
      if (resultAttemptIds.length) {
        await db
          .delete(resultClassifications)
          .where(
            inArray(resultClassifications.resultAttemptId, resultAttemptIds),
          );
        await db
          .delete(resultAttempts)
          .where(inArray(resultAttempts.id, resultAttemptIds));
      }
      if (resultIds.length) {
        await db
          .update(results)
          .set({ currentResultAttemptId: null })
          .where(inArray(results.id, resultIds));
        await db.delete(results).where(inArray(results.id, resultIds));
      }
      if (jobIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
      }
    }
  }, 180000);

  it("MUST-CATCH: a typed permanent same-case continuation failure is a critical non-physical terminal outcome and never restarts unchanged or fresh", async () => {
    const aoaDeg = 38.125;
    const jobIds: string[] = [];
    const resultIds: string[] = [];
    let requestId = "";
    let obligationId = "";
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const { request, created } = await createUransRequest(db, {
        airfoilId,
        revisionId,
        aoaDeg,
        fidelity: "precalc",
        requestedBy: "continuation-permanent@test.airfoils.pro",
      });
      expect(created).toBe(true);
      requestId = request.id;
      const [obligation] = await ensurePrecalcObligations(
        db,
        [{ airfoilId, revisionId, aoaDeg }],
        { requestIds: [request.id], backgroundOwner: true },
      );
      expect(obligation).toBeDefined();
      obligationId = obligation!.id;

      const [checkpointJob] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          campaignId: null,
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "done",
          engineJobId: `${PREFIX}-continuation-permanent-checkpoint`,
          submittedAt: new Date(),
          finishedAt: new Date(),
          totalCases: 1,
          completedCases: 1,
          requestPayload: {
            uransRequestId: request.id,
            aoas: [aoaDeg],
            uransFidelity: "precalc",
            precalcObligationIds: [obligation!.id],
          },
        })
        .returning();
      jobIds.push(checkpointJob.id);
      const [targetRevision] = await db
        .select({
          solverImplementationId:
            simulationPresetRevisions.solverImplementationId,
        })
        .from(simulationPresetRevisions)
        .where(eq(simulationPresetRevisions.id, revisionId));
      if (!targetRevision?.solverImplementationId) {
        throw new Error(
          `fixture revision ${revisionId} has no solver identity`,
        );
      }
      const [checkpointResult] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          methodKey: "openfoam.urans",
          solverImplementationId: targetRevision.solverImplementationId,
          aoaDeg,
          engineJobId: checkpointJob.engineJobId,
          engineCaseSlug: "aoa_38.125",
          status: "done",
          source: "solved",
          regime: "urans",
          fidelity: "urans_precalc",
          cl: 0.77,
          cd: 0.12,
          cm: -0.04,
          clCd: 6.42,
          converged: true,
          unsteady: true,
          qualityWarnings: [
            `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: retained restartable latestTime state`,
          ],
          solvedAt: new Date(),
        })
        .returning();
      resultIds.push(checkpointResult.id);
      const checkpointId = await attachRestartableContinuationAttempt({
        resultId: checkpointResult.id,
        aoaDeg,
        simJobId: checkpointJob.id,
        engineJobId: checkpointJob.engineJobId,
        engineCaseSlug: "aoa_38.125",
        solverImplementationId: targetRevision.solverImplementationId,
        qualityWarnings: checkpointResult.qualityWarnings ?? [],
      });
      const [checkpoint] = await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.id, checkpointId));
      expect(checkpoint).toBeDefined();
      await db.insert(simPrecalcObligationAttempts).values({
        obligationId: obligation!.id,
        simJobId: checkpointJob.id,
        attemptNumber: 1,
        solverAttemptNumber: 1,
        consumesSolverAttempt: true,
        state: "rejected",
        outcome: "rejected",
        resultAttemptId: checkpoint.id,
        completedAt: new Date(),
      });
      await db
        .update(simPrecalcObligations)
        .set({
          state: "pending",
          attemptCount: 1,
          latestSimJobId: checkpointJob.id,
          lastOutcome: "rejected",
          completedAt: null,
        })
        .where(eq(simPrecalcObligations.id, obligation!.id));
      expect(
        await precalcContinuationsForObligations(db, [obligation!.id]),
      ).toMatchObject([
        {
          obligationId: obligation!.id,
          resultAttemptId: checkpoint.id,
        },
      ]);

      const [continuationJob] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          campaignId: null,
          jobKind: "targeted",
          methodKey: "openfoam.urans",
          solverImplementationId: targetRevision.solverImplementationId,
          referenceChordM: CHORD,
          wave: 2,
          status: "submitted",
          engineJobId: `${PREFIX}-continuation-permanent-failed`,
          submittedAt: new Date(),
          totalCases: 1,
          completedCases: 0,
          requestPayload: {
            uransRequestId: request.id,
            aoas: [aoaDeg],
            uransFidelity: "precalc",
            precalcObligationIds: [obligation!.id],
            continueFromResultId: checkpointResult.id,
            continueFromResultAttemptId: checkpoint.id,
          },
        })
        .returning();
      jobIds.push(continuationJob.id);
      await db
        .update(simPrecalcObligations)
        .set({ latestSimJobId: continuationJob.id })
        .where(eq(simPrecalcObligations.id, obligation!.id));
      await recordPrecalcObligationSubmission(db, continuationJob.id, [
        obligation!.id,
      ]);
      await db
        .update(simUransRequests)
        .set({
          state: "running",
          simJobId: continuationJob.id,
          continueFromResultId: checkpointResult.id,
          continueFromResultAttemptId: checkpoint.id,
        })
        .where(eq(simUransRequests.id, request.id));

      const failure =
        "continuation_source_permanent: immutable archive checksum mismatch";
      const failedResult: JobResult = {
        job_id: continuationJob.engineJobId!,
        state: "failed",
        polars: [],
        message: failure,
      };
      const engine = {
        getQueue: async () => {
          throw new Error("queue unavailable in test");
        },
        getJobRuntimes: async () => ({
          jobs: [
            {
              job_id: continuationJob.engineJobId!,
              exists: true,
              cancelled: false,
              process_count: 0,
              status_readable: true,
              status_state: "failed",
              status_message: failure,
              status_total_cases: 1,
              status_completed_cases: 0,
              status_continuation_failure_kind: "permanent",
              result_readable: true,
              has_result: true,
              result_state: "failed",
              result_message: failure,
              result_continuation_failure_kind: "permanent",
            },
          ],
        }),
        getJob: async (): Promise<JobStatus> => {
          throw new Error("runtime terminal result must bypass status polling");
        },
        getResult: async (): Promise<JobResult> => failedResult,
      } as unknown as EngineClient;
      await reconcile(db, engine, {
        jobIds: [continuationJob.id],
        skipFailedRecovery: true,
      });

      const [blocked] = await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation!.id));
      expect(blocked).toMatchObject({
        state: "blocked",
        attemptCount: 1,
        lastOutcome: "continuation_permanent_failure",
        lastError: failure,
        nextSubmitAt: null,
      });
      const [blockedRequest] = await db
        .select()
        .from(simUransRequests)
        .where(eq(simUransRequests.id, request.id));
      expect(blockedRequest).toMatchObject({
        state: "blocked",
        simJobId: continuationJob.id,
      });
      const audit = await db
        .select()
        .from(simPrecalcObligationAttempts)
        .where(eq(simPrecalcObligationAttempts.obligationId, obligation!.id))
        .orderBy(simPrecalcObligationAttempts.attemptNumber);
      expect(audit.at(-1)).toMatchObject({
        attemptNumber: 2,
        solverAttemptNumber: null,
        consumesSolverAttempt: false,
        state: "failed",
        outcome: "continuation_permanent_failure",
        resultAttemptId: null,
        error: failure,
      });
      expect(errorSpy.mock.calls.flat().join(" ")).toContain(
        "incident_signature=precalc-continuation-permanent-v1",
      );

      expect(
        await requeueRestartablePrecalcContinuations(db, {
          obligationIds: [obligation!.id],
        }),
      ).toEqual({
        obligationIds: [],
        campaignIds: [],
        requestIds: [],
        repairedSubmissionIds: [],
      });
      expect(
        await precalcContinuationsForObligations(db, [obligation!.id]),
      ).toEqual([]);
      const submissions: PolarRequest[] = [];
      resetUransLadderMemory();
      expect(
        await uransLadderTick(
          db,
          stubEngine(
            submissions,
            `${PREFIX}-permanent-continuation-must-not-resubmit`,
          ),
          0,
          {
            campaignIds: [],
            parentJobIds: [],
            promotionIds: [],
            requestIds: [request.id],
            verifyIds: [],
            meshRecoveryVersion: 0,
          },
        ),
      ).toBe(false);
      expect(submissions).toEqual([]);
    } finally {
      resetUransLadderMemory();
      errorSpy.mockRestore();
      if (requestId) {
        await db
          .delete(simUransRequests)
          .where(eq(simUransRequests.id, requestId));
      }
      if (obligationId) {
        await db
          .delete(simPrecalcObligations)
          .where(eq(simPrecalcObligations.id, obligationId));
      }
      if (resultIds.length) {
        await db
          .update(results)
          .set({ currentResultAttemptId: null })
          .where(inArray(results.id, resultIds));
        await db.delete(results).where(inArray(results.id, resultIds));
      }
      if (jobIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
      }
    }
  }, 180000);

  it("FALSE-POSITIVE GUARD: a permanent continuation tag on fresh PRECALC work follows the ordinary physical-attempt policy", async () => {
    const aoaDeg = 39.125;
    const jobIds: string[] = [];
    let requestId = "";
    let obligationId = "";
    try {
      const { request, created } = await createUransRequest(db, {
        airfoilId,
        revisionId,
        aoaDeg,
        fidelity: "precalc",
        requestedBy: "fresh-tag-guard@test.airfoils.pro",
      });
      expect(created).toBe(true);
      requestId = request.id;
      const [obligation] = await ensurePrecalcObligations(
        db,
        [{ airfoilId, revisionId, aoaDeg }],
        { requestIds: [request.id], backgroundOwner: true },
      );
      expect(obligation).toBeDefined();
      obligationId = obligation!.id;

      const [freshJob] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          campaignId: null,
          jobKind: "targeted",
          referenceChordM: CHORD,
          wave: 2,
          status: "submitted",
          engineJobId: `${PREFIX}-fresh-precalc-malformed-continuation-tag`,
          submittedAt: new Date(),
          totalCases: 1,
          completedCases: 0,
          requestPayload: {
            uransRequestId: request.id,
            aoas: [aoaDeg],
            uransFidelity: "precalc",
            precalcObligationIds: [obligation!.id],
          },
        })
        .returning();
      jobIds.push(freshJob.id);
      await db
        .update(simPrecalcObligations)
        .set({ latestSimJobId: freshJob.id })
        .where(eq(simPrecalcObligations.id, obligation!.id));
      await recordPrecalcObligationSubmission(db, freshJob.id, [
        obligation!.id,
      ]);
      await db
        .update(simUransRequests)
        .set({ state: "running", simJobId: freshJob.id })
        .where(eq(simUransRequests.id, request.id));
      const [failedFreshJob] = await db
        .update(simJobs)
        .set({
          status: "failed",
          finishedAt: new Date(),
          error: "malformed permanent continuation tag on fresh work",
        })
        .where(eq(simJobs.id, freshJob.id))
        .returning();

      const settlement = await settlePrecalcObligationsForJob(
        db,
        failedFreshJob,
        {
          terminalError: "malformed permanent continuation tag on fresh work",
          terminalContinuationFailureKind: "permanent",
        },
      );
      expect(settlement).toMatchObject({
        pending: [obligation!.id],
        blocked: [],
        continuationPermanent: [],
      });
      const [pending] = await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation!.id));
      expect(pending).toMatchObject({
        state: "pending",
        attemptCount: 1,
        lastOutcome: "failed",
        nextSubmitAt: null,
      });
      const [audit] = await db
        .select()
        .from(simPrecalcObligationAttempts)
        .where(eq(simPrecalcObligationAttempts.obligationId, obligation!.id));
      expect(audit).toMatchObject({
        attemptNumber: 1,
        solverAttemptNumber: 1,
        consumesSolverAttempt: true,
        state: "failed",
        outcome: "failed",
      });
      const [pendingRequest] = await db
        .select()
        .from(simUransRequests)
        .where(eq(simUransRequests.id, request.id));
      expect(pendingRequest).toMatchObject({
        state: "pending",
        simJobId: null,
      });
    } finally {
      if (requestId) {
        await db
          .delete(simUransRequests)
          .where(eq(simUransRequests.id, requestId));
      }
      if (obligationId) {
        await db
          .delete(simPrecalcObligations)
          .where(eq(simPrecalcObligations.id, obligationId));
      }
      if (jobIds.length) {
        await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
      }
    }
  }, 120000);
});
