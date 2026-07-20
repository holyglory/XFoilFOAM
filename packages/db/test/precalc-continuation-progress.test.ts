import { URANS_CONTINUATION_REQUIRED_MARKER } from "@aerodb/core";
import {
  MAX_PRECALC_NO_PROGRESS_SEGMENTS,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
  airfoils,
  createClient,
  ensurePrecalcObligations,
  isExactRestartablePrecalcAttempt,
  precalcContinuationMadeProgress,
  precalcContinuationProgressFromEvidence,
  precalcContinuationsForObligations,
  recordPrecalcObligationSubmission,
  requeueRestartablePrecalcContinuations,
  resultAttempts,
  resultClassifications,
  results,
  settlePrecalcObligationsForJob,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligations,
  simSolverIncidents,
  simulationPresetRevisions,
  solverEvidenceArchives,
  solverEvidenceArtifactMembers,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
} from "@aerodb/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMinimalSolverFixture,
  type MinimalSolverFixture,
} from "./solver-fixture";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `precalc-progress-${process.pid}-${Date.now().toString(36)}`;
const jobIds: string[] = [];
const resultAttemptIds: string[] = [];
const resultIds: string[] = [];
const evidenceBlobIds: string[] = [];
const obligationIds: string[] = [];
let airfoilId = "";
let otherAirfoilId = "";
let createdOtherAirfoilId: string | null = null;
let bcId = "";
let revisionId = "";
let solverImplementationId = "";
let obligationId = "";
let fixture: MinimalSolverFixture;
let legacyFixture: MinimalSolverFixture;
let legacyWrongRevisionFixture: MinimalSolverFixture;
const aoaDeg = 80 + (process.pid % 1000) / 100_000;

const frameTrack = {
  period_s: 2,
  periods_retained: 1,
  stationary: false,
  drift_frac: 0.4,
  window: { t_start: 8, t_end: 10 },
};

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
  "openfoam/transient/constant/physicalProperties",
  "openfoam/transient/constant/momentumTransport",
  "time_directories/10/U",
  "time_directories/10/p",
  "time_directories/10/k",
  "time_directories/10/omega",
  "time_directories/10/nut",
  "time_directories/10/phi",
  "openfoam/postProcessing/forceCoeffs1/0/coefficient.dat",
] as const;

async function attachVerifiedRestartArchive(input: {
  resultId: string;
  resultAttemptId: string;
  airfoilId: string;
  simJobId: string | null;
  engineJobId: string | null;
  engineCaseSlug: string | null;
  aoaDeg: number;
  solverImplementationId: string;
  suffix: string;
  omitMember?: string;
}): Promise<void> {
  const [manifest] = await db
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
      kind: "manifest",
      storageKey: `${PREFIX}/${input.suffix}/evidence_manifest.json`,
      mimeType: "application/json",
      sha256: "a".repeat(64),
      byteSize: 128,
    })
    .returning({ id: solverEvidenceArtifacts.id });
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
      storageKey: `${PREFIX}/${input.suffix}/engine_evidence.tar.zst`,
      mimeType: "application/zstd",
      sha256: "b".repeat(64),
      byteSize: 4096,
    })
    .returning({ id: solverEvidenceArtifacts.id });
  const [blob] = await db
    .insert(solverEvidenceBlobs)
    .values({
      backend: "gcs",
      bucket: "exact-continuation-test",
      objectKey: `${PREFIX}/${input.suffix}/${input.resultAttemptId}.tar.zst`,
      generation: String(20_000 + evidenceBlobIds.length),
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
  evidenceBlobIds.push(blob.id);
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
  const artifacts = await db
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
        storageKey: `${PREFIX}/${input.suffix}/${path}`,
        mimeType: "application/octet-stream",
        sha256: (index % 16).toString(16).repeat(64),
        byteSize: 64,
      })),
    )
    .returning({ id: solverEvidenceArtifacts.id });
  await db.insert(solverEvidenceArtifactMembers).values([
    {
      archiveId: archive.id,
      artifactId: manifest.id,
      memberPath: "evidence_manifest.json",
    },
    ...artifacts.map((artifact, index) => ({
      archiveId: archive.id,
      artifactId: artifact.id,
      memberPath: memberPaths[index]!,
    })),
  ]);
}

beforeAll(async () => {
  const seededAirfoils = await db
    .select({
      id: airfoils.id,
      categoryId: airfoils.categoryId,
      points: airfoils.points,
    })
    .from(airfoils)
    .limit(2);
  const [airfoil, seededOtherAirfoil] = seededAirfoils;
  if (!airfoil) throw new Error("seeded airfoil fixture missing");
  let otherAirfoil = seededOtherAirfoil;
  if (!otherAirfoil) {
    [otherAirfoil] = await db
      .insert(airfoils)
      .values({
        slug: `${PREFIX}-wrong-manifest-owner`,
        name: `${PREFIX} wrong manifest owner`,
        categoryId: airfoil.categoryId,
        points: airfoil.points,
        isSymmetric: false,
      })
      .returning({
        id: airfoils.id,
        categoryId: airfoils.categoryId,
        points: airfoils.points,
      });
    createdOtherAirfoilId = otherAirfoil.id;
  }
  fixture = await createMinimalSolverFixture(db, PREFIX);
  airfoilId = airfoil.id;
  otherAirfoilId = otherAirfoil.id;
  bcId = fixture.bcId;
  revisionId = fixture.revisionId;
  solverImplementationId = fixture.solverImplementationId;
  const [obligation] = await ensurePrecalcObligations(
    db,
    [{ airfoilId, revisionId, aoaDeg }],
    { backgroundOwner: true },
  );
  if (!obligation) throw new Error("precalc obligation was not created");
  obligationId = obligation.id;
  obligationIds.push(obligation.id);

  legacyFixture = await createMinimalSolverFixture(db, `${PREFIX}-legacy`);
  await db
    .update(simulationPresetRevisions)
    .set({ solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID })
    .where(eq(simulationPresetRevisions.id, legacyFixture.revisionId));
  legacyWrongRevisionFixture = await createMinimalSolverFixture(
    db,
    `${PREFIX}-legacy-wrong-revision`,
  );
  await db
    .update(simulationPresetRevisions)
    .set({ solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID })
    .where(
      eq(simulationPresetRevisions.id, legacyWrongRevisionFixture.revisionId),
    );
});

afterAll(async () => {
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
  }
  if (resultAttemptIds.length) {
    await db
      .delete(resultClassifications)
      .where(inArray(resultClassifications.resultAttemptId, resultAttemptIds));
    await db
      .delete(resultAttempts)
      .where(inArray(resultAttempts.id, resultAttemptIds));
  }
  if (resultIds.length) {
    await db.delete(results).where(inArray(results.id, resultIds));
  }
  if (evidenceBlobIds.length) {
    await db
      .delete(solverEvidenceBlobs)
      .where(inArray(solverEvidenceBlobs.id, evidenceBlobIds));
  }
  if (jobIds.length) {
    await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
  }
  await fixture?.cleanup();
  await legacyFixture?.cleanup();
  await legacyWrongRevisionFixture?.cleanup();
  if (createdOtherAirfoilId) {
    await db.delete(airfoils).where(eq(airfoils.id, createdOtherAirfoilId));
  }
  await sql.end();
});

async function completeRejectedSegment(input: {
  archive?: "valid" | "missing" | "incomplete";
  suffix: string;
  continueFromResultAttemptId?: string;
  targetObligationId?: string;
  targetAoaDeg?: number;
  track?: typeof frameTrack;
}) {
  const targetObligationId = input.targetObligationId ?? obligationId;
  const targetAoaDeg = input.targetAoaDeg ?? aoaDeg;
  const [continuationAttempt] = input.continueFromResultAttemptId
    ? await db
        .select({ resultId: resultAttempts.resultId })
        .from(resultAttempts)
        .where(eq(resultAttempts.id, input.continueFromResultAttemptId))
        .limit(1)
    : [];
  if (input.continueFromResultAttemptId && !continuationAttempt) {
    throw new Error(
      `continuation fixture attempt ${input.continueFromResultAttemptId} is missing`,
    );
  }
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      solverImplementationId,
      jobKind: "targeted",
      referenceChordM: 1,
      wave: 2,
      status: "submitted",
      engineJobId: `${PREFIX}-${input.suffix}`,
      submittedAt: new Date(),
      totalCases: 1,
      completedCases: 1,
      requestPayload: {
        aoas: [targetAoaDeg],
        uransFidelity: "precalc",
        precalcObligationIds: [targetObligationId],
        ...(input.continueFromResultAttemptId
          ? {
              continueFromResultId: continuationAttempt!.resultId,
              continueFromResultAttemptId: input.continueFromResultAttemptId,
            }
          : {}),
      },
    })
    .returning();
  jobIds.push(job.id);
  await db
    .update(simPrecalcObligations)
    .set({ latestSimJobId: job.id, state: "pending" })
    .where(eq(simPrecalcObligations.id, targetObligationId));
  await recordPrecalcObligationSubmission(db, job.id, [targetObligationId]);

  let [ownerResult] = await db
    .select()
    .from(results)
    .where(
      and(
        eq(results.airfoilId, airfoilId),
        eq(results.simulationPresetRevisionId, revisionId),
        eq(results.aoaDeg, targetAoaDeg),
      ),
    )
    .limit(1);
  if (!ownerResult) {
    [ownerResult] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: targetAoaDeg,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        methodKey: "openfoam.urans",
        solverImplementationId,
        converged: true,
        unsteady: true,
        solvedAt: new Date(),
      })
      .returning();
    resultIds.push(ownerResult.id);
  }

  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: ownerResult.id,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      solverImplementationId,
      aoaDeg: targetAoaDeg,
      simJobId: job.id,
      engineJobId: job.engineJobId,
      engineCaseSlug: "aoa_80",
      methodKey: "openfoam.urans",
      status: "done",
      source: "solved",
      regime: "urans",
      validForPolar: false,
      converged: true,
      unsteady: true,
      qualityWarnings: [
        `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: retained restartable latestTime state`,
      ],
      evidencePayload: {
        fidelity: "urans_precalc",
        frame_track: input.track ?? frameTrack,
      },
      solvedAt: new Date(),
    })
    .returning();
  resultAttemptIds.push(attempt.id);
  await db.insert(resultClassifications).values({
    resultAttemptId: attempt.id,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg: targetAoaDeg,
    regime: "urans",
    classifierVersion: PREFIX,
    state: "rejected",
    region: "post_stall",
    confidence: 1,
    reasons: ["non-stationary"],
  });
  if (input.archive !== "missing") {
    await attachVerifiedRestartArchive({
      resultId: ownerResult.id,
      resultAttemptId: attempt.id,
      airfoilId,
      simJobId: job.id,
      engineJobId: job.engineJobId,
      engineCaseSlug: attempt.engineCaseSlug,
      aoaDeg: targetAoaDeg,
      solverImplementationId,
      suffix: input.suffix,
      ...(input.archive === "incomplete"
        ? { omitMember: "time_directories/10/p" }
        : {}),
    });
  }
  await db
    .update(results)
    .set({ currentResultAttemptId: attempt.id })
    .where(eq(results.id, ownerResult.id));
  const [completedJob] = await db
    .update(simJobs)
    .set({ status: "done", finishedAt: new Date() })
    .where(eq(simJobs.id, job.id))
    .returning();
  await settlePrecalcObligationsForJob(db, completedJob);
  return attempt;
}

const LEGACY_HORIZON_WARNING =
  "URANS period acquisition exhausted the physical slow-shedding horizon (39.6 initial guesses); URANS quality could not be measured";
const LEGACY_NON_STATIONARY_WARNING =
  "URANS window not stationary (precalc established-oscillation test): cycle means trend downward monotonically";
const LEGACY_RESTART_MEMBERS = [
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
  "time_directories/0.13209700680316/U",
  "time_directories/0.13209700680316/p",
  "time_directories/0.13209700680316/k",
  "time_directories/0.13209700680316/omega",
  "time_directories/0.13209700680316/nut",
  "time_directories/0.13209700680316/phi",
  "openfoam/postProcessing/forceCoeffs1/0.124/coefficient.dat",
] as const;

type LegacyCheckpointVariant = {
  suffix: string;
  attemptAirfoil?: "wrong";
  attemptAoaOffset?: number;
  attemptRevision?: "wrong";
  attemptJob?: "wrong";
  continuationSubdir?: string | null;
  error?: string;
  failureDisposition?: string;
  manifest?: "valid" | "wrong-owner" | "missing";
  archive?: "valid" | "missing-member" | "missing";
};

async function createLegacyCheckpointVariant(
  input: LegacyCheckpointVariant,
  index: number,
) {
  const targetAoa = 82 + index / 100;
  const attemptAoa = targetAoa + (input.attemptAoaOffset ?? 0);
  const attemptAirfoilId =
    input.attemptAirfoil === "wrong" ? otherAirfoilId : airfoilId;
  const attemptRevisionId =
    input.attemptRevision === "wrong"
      ? legacyWrongRevisionFixture.revisionId
      : legacyFixture.revisionId;
  const attemptBcId =
    input.attemptRevision === "wrong"
      ? legacyWrongRevisionFixture.bcId
      : legacyFixture.bcId;
  const [obligation] = await ensurePrecalcObligations(
    db,
    [
      {
        airfoilId,
        revisionId: legacyFixture.revisionId,
        aoaDeg: targetAoa,
      },
    ],
    { backgroundOwner: true },
  );
  if (!obligation) throw new Error("legacy obligation missing");
  obligationIds.push(obligation.id);

  const [submissionJob] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [legacyFixture.bcId],
      simulationPresetRevisionId: legacyFixture.revisionId,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      jobKind: "targeted",
      referenceChordM: 1,
      wave: 2,
      status: "submitted",
      engineJobId: `${PREFIX}-${input.suffix}-job`,
      submittedAt: new Date(),
      totalCases: 1,
      completedCases: 1,
      requestPayload: {
        aoas: [targetAoa],
        uransFidelity: "precalc",
        precalcObligationIds: [obligation.id],
      },
    })
    .returning();
  jobIds.push(submissionJob.id);
  await db
    .update(simPrecalcObligations)
    .set({ latestSimJobId: submissionJob.id, state: "pending" })
    .where(eq(simPrecalcObligations.id, obligation.id));
  await recordPrecalcObligationSubmission(db, submissionJob.id, [
    obligation.id,
  ]);

  let attemptJob = submissionJob;
  if (input.attemptJob === "wrong") {
    [attemptJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [attemptBcId],
        simulationPresetRevisionId: attemptRevisionId,
        solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        jobKind: "targeted",
        referenceChordM: 1,
        wave: 2,
        status: "failed",
        engineJobId: `${PREFIX}-${input.suffix}-wrong-job`,
        submittedAt: new Date(),
        finishedAt: new Date(),
        totalCases: 1,
        completedCases: 1,
        requestPayload: { aoas: [attemptAoa], uransFidelity: "precalc" },
      })
      .returning();
    jobIds.push(attemptJob.id);
  }

  const [result] = await db
    .insert(results)
    .values({
      airfoilId: attemptAirfoilId,
      bcId: attemptBcId,
      simulationPresetRevisionId: attemptRevisionId,
      aoaDeg: attemptAoa,
      status: "done",
      source: "solved",
      regime: "rans",
      fidelity: "rans",
      converged: true,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    })
    .returning();
  resultIds.push(result.id);
  const [ransAttempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: result.id,
      airfoilId: attemptAirfoilId,
      bcId: attemptBcId,
      simulationPresetRevisionId: attemptRevisionId,
      aoaDeg: attemptAoa,
      engineJobId: `${PREFIX}-${input.suffix}-rans`,
      engineCaseSlug: `rans_${attemptAoa}`,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      status: "done",
      source: "solved",
      regime: "rans",
      validForPolar: true,
      converged: true,
      evidencePayload: { fidelity: "rans" },
      solvedAt: new Date(),
    })
    .returning();
  resultAttemptIds.push(ransAttempt.id);
  await db.insert(resultClassifications).values({
    resultAttemptId: ransAttempt.id,
    airfoilId: attemptAirfoilId,
    simulationPresetRevisionId: attemptRevisionId,
    aoaDeg: attemptAoa,
    regime: "rans",
    classifierVersion: `${PREFIX}-legacy-rans`,
    state: "needs_urans",
    region: "post_stall",
    confidence: 1,
    reasons: ["post-stall"],
  });
  await db
    .update(results)
    .set({ currentResultAttemptId: ransAttempt.id })
    .where(eq(results.id, result.id));

  const error =
    input.error ??
    `HardSolverError: URANS evidence rejected: ${LEGACY_HORIZON_WARNING}`;
  const [precalcAttempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: result.id,
      airfoilId: attemptAirfoilId,
      bcId: attemptBcId,
      simulationPresetRevisionId: attemptRevisionId,
      aoaDeg: attemptAoa,
      simJobId: attemptJob.id,
      engineJobId: attemptJob.engineJobId,
      engineCaseSlug: `c0p05_u30_a${attemptAoa}`,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      status: "failed",
      source: "queued",
      regime: "urans",
      validForPolar: false,
      converged: false,
      unsteady: true,
      error,
      qualityWarnings: [LEGACY_HORIZON_WARNING, LEGACY_NON_STATIONARY_WARNING],
      evidencePayload: {
        fidelity: "urans_precalc",
        failure_disposition: input.failureDisposition ?? "hard_solver",
        continuation_transient_subdir:
          input.continuationSubdir === undefined
            ? "transient"
            : input.continuationSubdir,
        frame_track: {
          period_s: 0.0033,
          periods_retained: 23.8,
          stationary: false,
          drift_frac: 0.094,
          window: { t_start: 0.055, t_end: 0.132 },
        },
        force_history: {
          period_s: 0.0035,
          retained_cycles: 3,
          window_start: 0.121,
          window_end: 0.132,
        },
      },
      solvedAt: new Date(),
    })
    .returning();
  resultAttemptIds.push(precalcAttempt.id);
  await db.insert(resultClassifications).values({
    resultAttemptId: precalcAttempt.id,
    airfoilId: attemptAirfoilId,
    simulationPresetRevisionId: attemptRevisionId,
    aoaDeg: attemptAoa,
    regime: "urans",
    classifierVersion: `${PREFIX}-legacy-precalc`,
    state: "rejected",
    region: "post_stall",
    confidence: 1,
    reasons: ["not-solved", "solver-error", "non-stationary"],
  });

  let manifestId: string | null = null;
  if (input.manifest !== "missing") {
    const [manifest] = await db
      .insert(solverEvidenceArtifacts)
      .values({
        resultId: result.id,
        resultAttemptId: precalcAttempt.id,
        airfoilId:
          input.manifest === "wrong-owner"
            ? input.attemptAirfoil === "wrong"
              ? airfoilId
              : otherAirfoilId
            : attemptAirfoilId,
        simJobId: attemptJob.id,
        engineJobId: precalcAttempt.engineJobId,
        engineCaseSlug: precalcAttempt.engineCaseSlug,
        solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        aoaDeg: attemptAoa,
        kind: "manifest",
        storageKey: `${PREFIX}/${input.suffix}/evidence_manifest.json`,
        mimeType: "application/json",
        sha256: "a".repeat(64),
        byteSize: 512,
      })
      .returning();
    manifestId = manifest.id;
  }

  if (input.archive !== "missing") {
    const [bundle] = await db
      .insert(solverEvidenceArtifacts)
      .values({
        resultId: result.id,
        resultAttemptId: precalcAttempt.id,
        airfoilId: attemptAirfoilId,
        simJobId: attemptJob.id,
        engineJobId: precalcAttempt.engineJobId,
        engineCaseSlug: precalcAttempt.engineCaseSlug,
        solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        aoaDeg: attemptAoa,
        kind: "engine_bundle",
        storageKey: `${PREFIX}/${input.suffix}/engine_evidence.tar.zst`,
        mimeType: "application/zstd",
        sha256: "b".repeat(64),
        byteSize: 4096,
        metadata: { evidenceBase: "evidence" },
      })
      .returning();
    const [blob] = await db
      .insert(solverEvidenceBlobs)
      .values({
        backend: "gcs",
        bucket: "legacy-continuation-test",
        objectKey: `${PREFIX}/${input.suffix}/evidence.tar.zst`,
        generation: String(10_000 + index),
        compression: "zstd",
        mimeType: "application/zstd",
        sha256: "c".repeat(64),
        byteSize: 4096,
        crc32c: "AAAAAA==",
        uncompressedTarSha256: "d".repeat(64),
        uncompressedTarByteSize: 8192,
        verifiedAt: new Date(),
      })
      .returning();
    evidenceBlobIds.push(blob.id);
    const [archive] = await db
      .insert(solverEvidenceArchives)
      .values({
        resultId: result.id,
        resultAttemptId: precalcAttempt.id,
        sourceArtifactId: bundle.id,
        blobId: blob.id,
      })
      .returning();

    const memberPaths = [
      ...(manifestId ? ["evidence_manifest.json"] : []),
      ...LEGACY_RESTART_MEMBERS,
    ].filter(
      (path) =>
        !(
          input.archive === "missing-member" &&
          path === "time_directories/0.13209700680316/p"
        ),
    );
    const memberArtifacts = await db
      .insert(solverEvidenceArtifacts)
      .values(
        memberPaths
          .filter((path) => path !== "evidence_manifest.json")
          .map((path, memberIndex) => ({
            resultId: result.id,
            resultAttemptId: precalcAttempt.id,
            airfoilId: attemptAirfoilId,
            simJobId: attemptJob.id,
            engineJobId: precalcAttempt.engineJobId,
            engineCaseSlug: precalcAttempt.engineCaseSlug,
            solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
            aoaDeg: attemptAoa,
            kind: "time_directory" as const,
            storageKey: `${PREFIX}/${input.suffix}/${path}`,
            mimeType: "application/octet-stream",
            sha256: (memberIndex % 10).toString().repeat(64),
            byteSize: 64,
          })),
      )
      .returning({ id: solverEvidenceArtifacts.id });
    const archiveMembers = [
      ...(manifestId
        ? [{ artifactId: manifestId, memberPath: "evidence_manifest.json" }]
        : []),
      ...memberArtifacts.map((artifact, memberIndex) => ({
        artifactId: artifact.id,
        memberPath: memberPaths.filter(
          (path) => path !== "evidence_manifest.json",
        )[memberIndex]!,
      })),
    ];
    await db.insert(solverEvidenceArtifactMembers).values(
      archiveMembers.map((member) => ({
        archiveId: archive.id,
        artifactId: member.artifactId,
        memberPath: member.memberPath,
      })),
    );
  }

  const [failedJob] = await db
    .update(simJobs)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(eq(simJobs.id, submissionJob.id))
    .returning();
  await settlePrecalcObligationsForJob(db, failedJob);
  if (
    input.attemptAirfoil === "wrong" ||
    input.attemptJob === "wrong" ||
    input.attemptRevision === "wrong" ||
    input.attemptAoaOffset
  ) {
    await db
      .update(simPrecalcObligationAttempts)
      .set({ resultAttemptId: precalcAttempt.id })
      .where(eq(simPrecalcObligationAttempts.obligationId, obligation.id));
  }
  return { obligation, precalcAttempt, ransAttempt, result };
}

describe("cross-segment preliminary URANS progress", () => {
  it("MUST-CATCH: only the exact archived OpenCFD 2606 legacy slow-shedding checkpoint resumes", async () => {
    const valid = await createLegacyCheckpointVariant(
      { suffix: "legacy-valid", manifest: "valid", archive: "valid" },
      1,
    );
    const [canonical] = await db
      .select({ currentResultAttemptId: results.currentResultAttemptId })
      .from(results)
      .where(eq(results.id, valid.result.id));
    expect(canonical?.currentResultAttemptId).toBe(valid.ransAttempt.id);

    const [settled] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, valid.obligation.id));
    expect(settled).toMatchObject({ state: "pending", attemptCount: 1 });
    expect(
      await precalcContinuationsForObligations(db, [valid.obligation.id]),
    ).toEqual([
      expect.objectContaining({
        obligationId: valid.obligation.id,
        resultId: valid.result.id,
        resultAttemptId: valid.precalcAttempt.id,
        engineJobId: valid.precalcAttempt.engineJobId,
        engineCaseSlug: valid.precalcAttempt.engineCaseSlug,
      }),
    ]);

    await db
      .update(simPrecalcObligations)
      .set({
        state: "blocked",
        attemptCount: 2,
        lastOutcome: "failed_exhausted",
        completedAt: new Date(),
      })
      .where(eq(simPrecalcObligations.id, valid.obligation.id));
    expect(
      await requeueRestartablePrecalcContinuations(db, {
        obligationIds: [valid.obligation.id],
      }),
    ).toEqual({
      obligationIds: [valid.obligation.id],
      campaignIds: [],
      requestIds: [],
      repairedSubmissionIds: [],
    });

    const guards: LegacyCheckpointVariant[] = [
      { suffix: "legacy-wrong-airfoil", attemptAirfoil: "wrong" },
      { suffix: "legacy-wrong-job", attemptJob: "wrong" },
      { suffix: "legacy-wrong-revision", attemptRevision: "wrong" },
      { suffix: "legacy-wrong-cell", attemptAoaOffset: 0.001 },
      { suffix: "legacy-no-checkpoint", continuationSubdir: null },
      { suffix: "legacy-missing-manifest", manifest: "missing" },
      { suffix: "legacy-wrong-manifest-owner", manifest: "wrong-owner" },
      { suffix: "legacy-missing-archive", archive: "missing" },
      { suffix: "legacy-missing-restart-member", archive: "missing-member" },
      {
        suffix: "legacy-generic-hard-solver",
        error:
          "HardSolverError: pimpleFoam diverged after a floating point exception",
      },
      {
        suffix: "legacy-deterministic-mesh",
        error: "HardSolverError: deterministic mesh quality rejected",
        failureDisposition: "deterministic_mesh",
      },
    ];
    for (let index = 0; index < guards.length; index += 1) {
      const guarded = await createLegacyCheckpointVariant(
        {
          manifest: "valid",
          archive: "valid",
          ...guards[index]!,
        },
        index + 2,
      );
      expect(
        await precalcContinuationsForObligations(db, [guarded.obligation.id]),
      ).toEqual([]);
      await db
        .update(simPrecalcObligations)
        .set({
          state: "blocked",
          attemptCount: 2,
          lastOutcome: "failed_exhausted",
          completedAt: new Date(),
        })
        .where(eq(simPrecalcObligations.id, guarded.obligation.id));
      expect(
        await requeueRestartablePrecalcContinuations(db, {
          obligationIds: [guarded.obligation.id],
        }),
      ).toEqual({
        obligationIds: [],
        campaignIds: [],
        requestIds: [],
        repairedSubmissionIds: [],
      });
    }
  }, 120_000);

  it("MUST-CATCH: typed same-case continuation requires the exact rejected PRECALC generation and one complete verified archive", async () => {
    const variants = [
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
      const targetAoaDeg = 84 + index / 100;
      const [obligation] = await ensurePrecalcObligations(
        db,
        [{ airfoilId, revisionId, aoaDeg: targetAoaDeg }],
        { backgroundOwner: true },
      );
      if (!obligation) throw new Error(`${variant} obligation missing`);
      obligationIds.push(obligation.id);
      const attempt = await completeRejectedSegment({
        suffix: `typed-guard-${variant}`,
        targetObligationId: obligation.id,
        targetAoaDeg,
        archive:
          variant === "missing-archive"
            ? "missing"
            : variant === "incomplete-archive"
              ? "incomplete"
              : "valid",
      });
      if (!attempt.resultId)
        throw new Error(`${variant} fixture has no exact result owner`);

      if (variant === "attempt-status") {
        await db
          .update(resultAttempts)
          .set({ status: "running" })
          .where(eq(resultAttempts.id, attempt.id));
      } else if (variant === "result-status") {
        await db
          .update(results)
          .set({ status: "pending" })
          .where(eq(results.id, attempt.resultId));
      } else if (variant === "source") {
        await db
          .update(resultAttempts)
          .set({ source: "queued" })
          .where(eq(resultAttempts.id, attempt.id));
      } else if (variant === "fidelity") {
        await db
          .update(resultAttempts)
          .set({ evidencePayload: { fidelity: "urans_full" } })
          .where(eq(resultAttempts.id, attempt.id));
      } else if (variant === "classification") {
        await db
          .update(resultClassifications)
          .set({ state: "accepted", reasons: [] })
          .where(eq(resultClassifications.resultAttemptId, attempt.id));
      } else if (variant === "marker") {
        await db
          .update(resultAttempts)
          .set({ qualityWarnings: [] })
          .where(eq(resultAttempts.id, attempt.id));
      }

      expect(
        await precalcContinuationsForObligations(db, [obligation.id]),
      ).toEqual([]);

      await db
        .update(simPrecalcObligations)
        .set({
          state: "blocked",
          attemptCount: 2,
          lastOutcome: "failed_exhausted",
          completedAt: new Date(),
        })
        .where(eq(simPrecalcObligations.id, obligation.id));
      expect(
        await requeueRestartablePrecalcContinuations(db, {
          obligationIds: [obligation.id],
        }),
      ).toEqual({
        obligationIds: [],
        campaignIds: [],
        requestIds: [],
        repairedSubmissionIds: [],
      });
    }
  }, 120_000);

  it("MUST-CATCH: a stale mutable result projection does not hide an exact archived checkpoint", async () => {
    const targetAoaDeg = 84.5;
    const [obligation] = await ensurePrecalcObligations(
      db,
      [{ airfoilId, revisionId, aoaDeg: targetAoaDeg }],
      { backgroundOwner: true },
    );
    if (!obligation) throw new Error("stale-projection obligation missing");
    obligationIds.push(obligation.id);
    const attempt = await completeRejectedSegment({
      suffix: "typed-stale-result-projection",
      targetObligationId: obligation.id,
      targetAoaDeg,
      archive: "valid",
    });
    if (!attempt.resultId)
      throw new Error("stale-projection fixture has no exact result owner");

    await db
      .update(results)
      .set({ status: "stale" })
      .where(eq(results.id, attempt.resultId));

    expect(
      await isExactRestartablePrecalcAttempt(db, attempt.resultId, attempt.id),
    ).toBe(true);
    expect(
      await precalcContinuationsForObligations(db, [obligation.id]),
    ).toEqual([
      expect.objectContaining({
        obligationId: obligation.id,
        resultId: attempt.resultId,
        resultAttemptId: attempt.id,
        engineJobId: attempt.engineJobId,
        engineCaseSlug: attempt.engineCaseSlug,
      }),
    ]);
  }, 120_000);

  it("requires measured phase/time improvement instead of a heartbeat", () => {
    const baseline = precalcContinuationProgressFromEvidence({
      frame_track: frameTrack,
    });
    expect(precalcContinuationMadeProgress(baseline, baseline)).toBe(false);
    expect(
      precalcContinuationMadeProgress(baseline, {
        ...baseline,
        periodsRetained: 1.25,
        simulatedTimeS: baseline.simulatedTimeS! + baseline.periodS! / 4,
      }),
    ).toBe(true);
    expect(
      precalcContinuationMadeProgress(baseline, {
        ...baseline,
        driftFrac: 0.35,
        simulatedTimeS: baseline.simulatedTimeS! + 0.001,
      }),
    ).toBe(true);
  });

  it("blocks after repeated no-progress continuations and records one replay-stable critical incident", async () => {
    const initial = await completeRejectedSegment({ suffix: "initial" });
    let obligation = (
      await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligationId))
    )[0]!;
    expect(obligation).toMatchObject({
      state: "pending",
      continuationSegmentCount: 0,
      continuationNoProgressCount: 0,
    });

    let checkpoint = initial;
    for (
      let segment = 1;
      segment <= MAX_PRECALC_NO_PROGRESS_SEGMENTS;
      segment += 1
    ) {
      checkpoint = await completeRejectedSegment({
        suffix: `continuation-${segment}`,
        continueFromResultAttemptId: checkpoint.id,
      });
    }

    obligation = (
      await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligationId))
    )[0]!;
    expect(obligation).toMatchObject({
      state: "blocked",
      lastOutcome: "continuation_no_progress_exhausted",
      continuationSegmentCount: MAX_PRECALC_NO_PROGRESS_SEGMENTS,
      continuationNoProgressCount: MAX_PRECALC_NO_PROGRESS_SEGMENTS,
    });
    expect(
      await precalcContinuationsForObligations(db, [obligationId]),
    ).toEqual([]);
    expect(
      await requeueRestartablePrecalcContinuations(db, {
        obligationIds: [obligationId],
      }),
    ).toEqual({
      obligationIds: [],
      campaignIds: [],
      requestIds: [],
      repairedSubmissionIds: [],
    });

    const ledger = await db
      .select()
      .from(simPrecalcObligationAttempts)
      .where(eq(simPrecalcObligationAttempts.obligationId, obligationId));
    expect(
      ledger.filter((entry) => entry.continuationSegmentNumber != null),
    ).toHaveLength(MAX_PRECALC_NO_PROGRESS_SEGMENTS);
    expect(
      ledger.filter((entry) => entry.continuationProgressed === false),
    ).toHaveLength(MAX_PRECALC_NO_PROGRESS_SEGMENTS);

    let incidents = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.precalcObligationId, obligationId));
    expect(
      incidents.filter((incident) => incident.severity === "critical"),
    ).toEqual([
      expect.objectContaining({
        reason: "continuation-no-progress",
        status: "open",
      }),
    ]);

    const [latestJob] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, jobIds.at(-1)!));
    await settlePrecalcObligationsForJob(db, latestJob);
    incidents = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.precalcObligationId, obligationId));
    expect(
      incidents.filter((incident) => incident.severity === "critical"),
    ).toHaveLength(1);
  }, 120_000);

  it("keeps a measurably productive trajectory schedulable beyond the former fixed continuation cap", async () => {
    const cappedAoaDeg = aoaDeg + 0.1;
    const [cappedObligation] = await ensurePrecalcObligations(
      db,
      [{ airfoilId, revisionId, aoaDeg: cappedAoaDeg }],
      { backgroundOwner: true },
    );
    if (!cappedObligation) throw new Error("capped obligation was not created");
    obligationIds.push(cappedObligation.id);

    let checkpoint = await completeRejectedSegment({
      suffix: "cap-initial",
      targetObligationId: cappedObligation.id,
      targetAoaDeg: cappedAoaDeg,
    });
    const productiveSegments = 7;
    for (let segment = 1; segment <= productiveSegments; segment += 1) {
      checkpoint = await completeRejectedSegment({
        suffix: `productive-continuation-${segment}`,
        continueFromResultAttemptId: checkpoint.id,
        targetObligationId: cappedObligation.id,
        targetAoaDeg: cappedAoaDeg,
        track: {
          ...frameTrack,
          periods_retained: frameTrack.periods_retained + segment * 0.3,
          window: {
            ...frameTrack.window,
            t_end: frameTrack.window.t_end + segment,
          },
        },
      });
    }

    const [settled] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, cappedObligation.id));
    expect(settled).toMatchObject({
      state: "pending",
      lastOutcome: "rejected",
      continuationSegmentCount: productiveSegments,
      continuationNoProgressCount: 0,
    });
    const continuations = await precalcContinuationsForObligations(db, [
      cappedObligation.id,
    ]);
    expect(continuations).toEqual([
      expect.objectContaining({
        obligationId: cappedObligation.id,
        resultAttemptId: checkpoint.id,
      }),
    ]);

    const incidents = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.precalcObligationId, cappedObligation.id));
    expect(
      incidents.filter((incident) => incident.severity === "critical"),
    ).toEqual([]);

    await db
      .update(simPrecalcObligations)
      .set({
        state: "blocked",
        lastOutcome: "continuation_segment_exhausted",
        completedAt: new Date(),
      })
      .where(eq(simPrecalcObligations.id, cappedObligation.id));
    expect(
      await requeueRestartablePrecalcContinuations(db, {
        obligationIds: [cappedObligation.id],
      }),
    ).toEqual({
      obligationIds: [cappedObligation.id],
      campaignIds: [],
      requestIds: [],
      repairedSubmissionIds: [],
    });
    const [reopened] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, cappedObligation.id));
    expect(reopened).toMatchObject({
      state: "pending",
      lastOutcome: "continuation_recovery_pending",
      continuationSegmentCount: productiveSegments,
      continuationNoProgressCount: 0,
    });

    const [legacyActiveJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        solverImplementationId,
        jobKind: "targeted",
        referenceChordM: 1,
        wave: 2,
        status: "submitted",
        engineJobId: `${PREFIX}-cap-legacy-active`,
        submittedAt: new Date(),
        totalCases: 1,
        requestPayload: {
          aoas: [cappedAoaDeg],
          uransFidelity: "precalc",
          precalcObligationIds: [cappedObligation.id],
          continueFromResultId: checkpoint.resultId,
          continueFromResultAttemptId: checkpoint.id,
        },
      })
      .returning();
    jobIds.push(legacyActiveJob.id);
    await db
      .update(simPrecalcObligations)
      .set({
        state: "pending",
        latestSimJobId: legacyActiveJob.id,
        lastOutcome: "continuation_recovery_pending",
      })
      .where(eq(simPrecalcObligations.id, cappedObligation.id));
    await recordPrecalcObligationSubmission(db, legacyActiveJob.id, [
      cappedObligation.id,
    ]);
    const [failedLegacyJob] = await db
      .update(simJobs)
      .set({
        status: "failed",
        error: "temporary continuation transport interruption",
        finishedAt: new Date(),
      })
      .where(eq(simJobs.id, legacyActiveJob.id))
      .returning();
    await settlePrecalcObligationsForJob(db, failedLegacyJob, {
      terminalError: failedLegacyJob.error,
      terminalFailureDisposition: "infrastructure",
      terminalContinuationFailureKind: "transient",
      cancellation: "transient",
    });
    const [legacySettlement] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, cappedObligation.id));
    expect(legacySettlement).toMatchObject({
      state: "pending",
      lastOutcome: "infrastructure_retry_wait",
      continuationSegmentCount: productiveSegments,
      continuationNoProgressCount: 0,
    });
  }, 120_000);
});
