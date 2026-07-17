import {
  OPENCFD_2606_EXECUTION_POOL_ID,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
  type CampaignGapBatch,
  type DB,
  findCampaignGapBatch,
  simCampaignConditions,
  simCampaignSolverCutovers,
  simCampaigns,
  simJobs,
  simLadderSubmitRetries,
  simPrecalcObligations,
  simResultSubmitRetries,
  simUransRequests,
  simUransVerifyQueue,
  solverCutoverContinuationChecks,
  solverEngineCanaryAttestations,
  solverExecutionPools,
  sweeperState,
  syncSweepPromises,
} from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";

import { refreshDiskAdmission } from "./disk-admission";
import { engineMeshRecoveryVersion } from "./engine-capabilities";
import { submitCampaignBatch } from "./loop";

export interface SuccessorAdmissionTarget {
  campaignId: string;
  canaryAttestationId: string;
  targetPlanRevisionId: string;
  targetGeneration: number;
}

export interface SuccessorAdmissionPreflight {
  campaignStatus: string;
  campaignPlanRevisionId: string | null;
  campaignGeneration: number;
  cutoverStatus: string;
  cutoverAttestationId: string | null;
  cutoverPlanRevisionId: string | null;
  cutoverGeneration: number | null;
  cutoverToSolverImplementationId: string;
  priorCampaignStatus: string;
  continuationStatus: string;
  continuationJobId: string | null;
  continuationEvidenceResultId: string | null;
  continuationLastError: string | null;
  attestedRuntimeBuildId: string;
  attestedSolverImplementationId: string;
  attestedExecutionPoolId: string;
  poolEnabled: boolean;
  otherEnabledPoolCount: number;
  sweeperEnabled: boolean;
  openJobCount: number;
  activePrecalcCount: number;
  activeVerifyCount: number;
  activeUransRequestCount: number;
  activeSubmitRetryCount: number;
  activeRemotePromiseCount: number;
}

export interface SuccessorAdmissionCandidate {
  campaignId: string;
  airfoilId: string;
  conditionCount: number;
  angleCount: number;
  conditionIds: string[];
  angles: number[];
}

export interface SuccessorAdmissionJob {
  id: string;
  campaignId: string | null;
  airfoilId: string;
  totalCases: number;
  requestPayload: unknown;
  simulationPresetRevisionId: string | null;
  solverImplementationId: string | null;
  solverExecutionPoolId: string | null;
  solverRuntimeBuildId: string | null;
  status: string;
  engineState: string | null;
  engineJobId: string | null;
  submittedAt: Date | null;
  belongsToTargetGeneration: boolean;
}

export interface SuccessorAdmissionReceipt {
  status: "submitted";
  campaignId: string;
  jobId: string;
  engineJobId: string;
  solverRuntimeBuildId: string | null;
  attestedSolverRuntimeBuildId: string;
  runtimeAcknowledgement: "pending" | "acknowledged";
  targetGeneration: number;
  targetPlanRevisionId: string;
  airfoilId: string;
  conditionCount: number;
  angleCount: number;
}

export interface SuccessorAdmissionDependencies<Candidate> {
  disableSweeper(): Promise<void>;
  claimAdmissionLease(target: SuccessorAdmissionTarget): Promise<void>;
  closeAdmission(reason: string): Promise<void>;
  loadPreflight(
    target: SuccessorAdmissionTarget,
  ): Promise<SuccessorAdmissionPreflight>;
  assertDiskAdmission(): Promise<void>;
  loadJobIds(): Promise<Set<string>>;
  loadCandidate(target: SuccessorAdmissionTarget): Promise<Candidate | null>;
  candidateSummary(candidate: Candidate): SuccessorAdmissionCandidate;
  submitCandidate(candidate: Candidate): Promise<boolean>;
  loadJobsNotIn(
    before: ReadonlySet<string>,
    target: SuccessorAdmissionTarget,
  ): Promise<SuccessorAdmissionJob[]>;
}

const OPEN_JOB_STATUSES = [
  "pending",
  "submitted",
  "running",
  "ingesting",
] as const;
const ACCEPTED_POST_SUBMIT_STATUSES = new Set([
  "submitted",
  "running",
  "ingesting",
  "done",
]);

function admissionError(message: string): Error {
  return new Error(`successor one-shot admission refused: ${message}`);
}

function exactStringSet(actual: unknown, expected: string[]): boolean {
  if (
    !Array.isArray(actual) ||
    !actual.every((value) => typeof value === "string")
  )
    return false;
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    JSON.stringify([...new Set(actual)].sort()) ===
      JSON.stringify([...new Set(expected)].sort())
  );
}

function exactNumberSet(actual: unknown, expected: number[]): boolean {
  if (
    !Array.isArray(actual) ||
    !actual.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
  )
    return false;
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    JSON.stringify([...new Set(actual)].sort((left, right) => left - right)) ===
      JSON.stringify([...new Set(expected)].sort((left, right) => left - right))
  );
}

function validCandidateSummary(
  target: SuccessorAdmissionTarget,
  candidate: SuccessorAdmissionCandidate,
): boolean {
  return (
    candidate.campaignId === target.campaignId &&
    Boolean(candidate.airfoilId) &&
    Number.isSafeInteger(candidate.conditionCount) &&
    candidate.conditionCount > 0 &&
    Number.isSafeInteger(candidate.angleCount) &&
    candidate.angleCount > 0 &&
    candidate.conditionIds.length === candidate.conditionCount &&
    new Set(candidate.conditionIds).size === candidate.conditionCount &&
    candidate.conditionIds.every(Boolean) &&
    candidate.angles.length === candidate.angleCount &&
    new Set(candidate.angles).size === candidate.angleCount &&
    candidate.angles.every(Number.isFinite)
  );
}

function sameCandidateSummary(
  left: SuccessorAdmissionCandidate,
  right: SuccessorAdmissionCandidate,
): boolean {
  return (
    left.campaignId === right.campaignId &&
    left.airfoilId === right.airfoilId &&
    left.conditionCount === right.conditionCount &&
    left.angleCount === right.angleCount &&
    exactStringSet(left.conditionIds, right.conditionIds) &&
    exactNumberSet(left.angles, right.angles)
  );
}

export function validateSuccessorAdmissionPreflight(
  target: SuccessorAdmissionTarget,
  preflight: SuccessorAdmissionPreflight,
): void {
  if (preflight.sweeperEnabled)
    throw admissionError("the durable sweeper admission switch is enabled");
  if (!preflight.poolEnabled)
    throw admissionError("the exact OpenCFD 2606 pool is not enabled");
  if (preflight.campaignStatus !== "active")
    throw admissionError("the allowlisted campaign is not active");
  if (preflight.campaignGeneration !== target.targetGeneration)
    throw admissionError("the campaign generation differs from the allowlist");
  if (preflight.campaignPlanRevisionId !== target.targetPlanRevisionId)
    throw admissionError(
      "the campaign plan revision differs from the allowlist",
    );
  if (preflight.cutoverStatus !== "completed")
    throw admissionError("the OpenCFD 2606 cutover is not completed");
  if (preflight.cutoverAttestationId !== target.canaryAttestationId)
    throw admissionError("the cutover attestation differs from the allowlist");
  if (preflight.cutoverGeneration !== target.targetGeneration)
    throw admissionError(
      "the cutover target generation differs from the allowlist",
    );
  if (preflight.cutoverPlanRevisionId !== target.targetPlanRevisionId)
    throw admissionError(
      "the cutover target plan revision differs from the allowlist",
    );
  if (
    preflight.cutoverToSolverImplementationId !==
    OPENCFD_2606_SOLVER_IMPLEMENTATION_ID
  )
    throw admissionError(
      "the cutover targets a non-OpenCFD-2606 implementation",
    );
  if (!new Set(["active", "attention"]).has(preflight.priorCampaignStatus))
    throw admissionError("the campaign was not runnable before maintenance");
  if (
    preflight.continuationStatus !== "pending" ||
    preflight.continuationJobId !== null ||
    preflight.continuationEvidenceResultId !== null ||
    preflight.continuationLastError !== null
  )
    throw admissionError(
      "the durable continuation check is not the pristine pending record",
    );
  if (!preflight.attestedRuntimeBuildId)
    throw admissionError("the canary attestation has no runtime build");
  if (
    preflight.attestedSolverImplementationId !==
    OPENCFD_2606_SOLVER_IMPLEMENTATION_ID
  )
    throw admissionError(
      "the canary attestation belongs to a non-OpenCFD-2606 implementation",
    );
  if (preflight.attestedExecutionPoolId !== OPENCFD_2606_EXECUTION_POOL_ID)
    throw admissionError("the canary attestation belongs to another pool");
  if (preflight.otherEnabledPoolCount !== 0)
    throw admissionError(
      `${preflight.otherEnabledPoolCount} non-target execution pool(s) are enabled`,
    );
  if (preflight.openJobCount !== 0)
    throw admissionError(
      `${preflight.openJobCount} pending or in-flight job(s) already exist`,
    );
  if (preflight.activePrecalcCount !== 0)
    throw admissionError(
      `${preflight.activePrecalcCount} preliminary-URANS recovery item(s) are active`,
    );
  if (preflight.activeVerifyCount !== 0)
    throw admissionError(
      `${preflight.activeVerifyCount} final-URANS verification item(s) are active`,
    );
  if (preflight.activeUransRequestCount !== 0)
    throw admissionError(
      `${preflight.activeUransRequestCount} explicit URANS request(s) are active`,
    );
  if (preflight.activeSubmitRetryCount !== 0)
    throw admissionError(
      `${preflight.activeSubmitRetryCount} solver submit retry item(s) are active`,
    );
  if (preflight.activeRemotePromiseCount !== 0)
    throw admissionError(
      `${preflight.activeRemotePromiseCount} remote solver promise(s) are active`,
    );
}

export function validateSuccessorAdmissionJob(
  target: SuccessorAdmissionTarget,
  attestedRuntimeBuildId: string,
  candidate: SuccessorAdmissionCandidate,
  job: SuccessorAdmissionJob,
): "pending" | "acknowledged" {
  if (job.campaignId !== target.campaignId)
    throw admissionError("the new job belongs to a non-allowlisted campaign");
  if (!job.belongsToTargetGeneration)
    throw admissionError(
      "the new job revision is not owned by the allowlisted successor generation",
    );
  if (job.airfoilId !== candidate.airfoilId)
    throw admissionError("the new job belongs to a different airfoil");
  if (job.totalCases !== candidate.conditionCount * candidate.angleCount)
    throw admissionError(
      "the new job does not contain the complete selected condition/angle batch",
    );
  const payload =
    job.requestPayload &&
    typeof job.requestPayload === "object" &&
    !Array.isArray(job.requestPayload)
      ? (job.requestPayload as Record<string, unknown>)
      : null;
  const conditionMap = payload?.conditionMap;
  const payloadConditionIds = Array.isArray(conditionMap)
    ? conditionMap.map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).conditionId
          : null,
      )
    : null;
  if (
    !exactNumberSet(payload?.aoas, candidate.angles) ||
    !exactStringSet(payloadConditionIds, candidate.conditionIds)
  )
    throw admissionError(
      "the new job payload differs from the exact selected conditions or angles",
    );
  if (job.solverImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID)
    throw admissionError("the new job used a non-OpenCFD-2606 implementation");
  if (job.solverExecutionPoolId !== OPENCFD_2606_EXECUTION_POOL_ID)
    throw admissionError("the new job used a non-attested execution pool");
  if (
    job.solverRuntimeBuildId == null &&
    (job.status !== "submitted" || job.engineState !== "pending")
  )
    throw admissionError(
      "the new job lacks runtime provenance after leaving the engine pending state",
    );
  if (
    job.solverRuntimeBuildId != null &&
    job.solverRuntimeBuildId !== attestedRuntimeBuildId
  )
    throw admissionError("the new job used a non-attested runtime build");
  if (!job.engineJobId || !job.submittedAt)
    throw admissionError("the new job lacks an acknowledged engine submission");
  if (!ACCEPTED_POST_SUBMIT_STATUSES.has(job.status))
    throw admissionError(
      `the new job reached unexpected post-submit status ${job.status}`,
    );
  return job.solverRuntimeBuildId == null ? "pending" : "acknowledged";
}

/**
 * Admit one and only one campaign-owned successor job.
 *
 * The host wrapper proves the looping sweeper container is stopped while it
 * holds the deploy lock. This function independently closes the durable
 * sweeper switch before reading any eligibility, scopes candidate discovery
 * to the single explicit campaign, and compares the complete job-id set on
 * both sides of submission. Any ambiguity closes both scheduler and target
 * pool; an already-accepted engine job is intentionally not killed.
 */
export async function admitOneSuccessor<Candidate>(
  target: SuccessorAdmissionTarget,
  dependencies: SuccessorAdmissionDependencies<Candidate>,
): Promise<SuccessorAdmissionReceipt> {
  let preflight: SuccessorAdmissionPreflight | null = null;
  let candidateSummary: SuccessorAdmissionCandidate | null = null;
  try {
    await dependencies.disableSweeper();
    await dependencies.claimAdmissionLease(target);
    preflight = await dependencies.loadPreflight(target);
    validateSuccessorAdmissionPreflight(target, preflight);
    await dependencies.assertDiskAdmission();

    const candidate = await dependencies.loadCandidate(target);
    if (!candidate)
      throw admissionError(
        "the allowlisted successor campaign has no RANS gap",
      );
    candidateSummary = dependencies.candidateSummary(candidate);
    if (!validCandidateSummary(target, candidateSummary))
      throw admissionError("candidate discovery returned an invalid batch");

    // The host wrapper quiesces every ordinary submit/mutation process. Re-read
    // both the immutable target and exact selected batch immediately before
    // composition so even an unexpected direct DB mutation fails closed.
    const confirmedPreflight = await dependencies.loadPreflight(target);
    validateSuccessorAdmissionPreflight(target, confirmedPreflight);
    if (
      confirmedPreflight.attestedRuntimeBuildId !==
      preflight.attestedRuntimeBuildId
    )
      throw admissionError("the attested runtime changed during preflight");
    const confirmedCandidate = await dependencies.loadCandidate(target);
    if (!confirmedCandidate)
      throw admissionError(
        "the allowlisted campaign gap changed during preflight",
      );
    const confirmedSummary = dependencies.candidateSummary(confirmedCandidate);
    if (
      !validCandidateSummary(target, confirmedSummary) ||
      !sameCandidateSummary(candidateSummary, confirmedSummary)
    )
      throw admissionError("the exact campaign batch changed during preflight");
    candidateSummary = confirmedSummary;

    const before = await dependencies.loadJobIds();
    const submitted = await dependencies.submitCandidate(confirmedCandidate);
    if (!submitted)
      throw admissionError(
        "the exact candidate was not accepted by the engine",
      );

    const newJobs = await dependencies.loadJobsNotIn(before, target);
    if (newJobs.length !== 1)
      throw admissionError(
        `submission created ${newJobs.length} new job rows instead of exactly one`,
      );
    const [job] = newJobs;
    const runtimeAcknowledgement = validateSuccessorAdmissionJob(
      target,
      preflight.attestedRuntimeBuildId,
      candidateSummary,
      job,
    );
    // Close both admission fences after engine acceptance. The background
    // sweeper may now be started for reconciliation, but neither it nor an
    // independent submitter can admit job #2 through the target pool.
    await dependencies.closeAdmission("the exact successor job was accepted");
    return {
      status: "submitted",
      campaignId: target.campaignId,
      jobId: job.id,
      engineJobId: job.engineJobId as string,
      solverRuntimeBuildId: job.solverRuntimeBuildId,
      attestedSolverRuntimeBuildId: preflight.attestedRuntimeBuildId,
      runtimeAcknowledgement,
      targetGeneration: target.targetGeneration,
      targetPlanRevisionId: target.targetPlanRevisionId,
      airfoilId: candidateSummary.airfoilId,
      conditionCount: candidateSummary.conditionCount,
      angleCount: candidateSummary.angleCount,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await dependencies.closeAdmission(reason);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "successor admission failed and its fail-safe could not be confirmed",
      );
    }
    throw error;
  }
}

async function scalarCount(
  query: Promise<Array<{ n: number }>>,
): Promise<number> {
  const [row] = await query;
  return Number(row?.n ?? 0);
}

export function productionSuccessorAdmissionDependencies(
  db: DB,
  engine: EngineClient,
): SuccessorAdmissionDependencies<CampaignGapBatch> {
  return {
    async disableSweeper() {
      const rows = await db
        .update(sweeperState)
        .set({ enabled: false })
        .where(eq(sweeperState.id, 1))
        .returning({ id: sweeperState.id });
      if (rows.length !== 1)
        throw admissionError("the singleton sweeper state row is missing");
    },
    async claimAdmissionLease(target) {
      const lease = {
        kind: "opencfd2606-successor-one-shot-v1",
        campaignId: target.campaignId,
        canaryAttestationId: target.canaryAttestationId,
        targetPlanRevisionId: target.targetPlanRevisionId,
        targetGeneration: target.targetGeneration,
        claimedAt: new Date().toISOString(),
      };
      const rows = await db
        .update(solverExecutionPools)
        .set({
          metadata: sql`COALESCE(${solverExecutionPools.metadata}, '{}'::jsonb)
            || jsonb_build_object('successorOneShotAdmission', ${JSON.stringify(lease)}::jsonb)`,
        })
        .where(
          and(
            eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID),
            eq(solverExecutionPools.enabled, true),
            sql`NOT (COALESCE(${solverExecutionPools.metadata}, '{}'::jsonb) ? 'successorOneShotAdmission')`,
          ),
        )
        .returning({ id: solverExecutionPools.id });
      if (rows.length !== 1)
        throw admissionError(
          "the durable successor one-shot lease is already claimed or the target pool is closed",
        );
    },
    async closeAdmission() {
      const closed = await db.transaction(async (tx) => {
        const sweeperRows = await tx
          .update(sweeperState)
          .set({ enabled: false })
          .where(eq(sweeperState.id, 1))
          .returning({ id: sweeperState.id });
        const poolRows = await tx
          .update(solverExecutionPools)
          .set({ enabled: false })
          .where(eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID))
          .returning({ id: solverExecutionPools.id });
        return {
          sweeper: sweeperRows.length === 1,
          pool: poolRows.length === 1,
        };
      });
      if (!closed.sweeper || !closed.pool)
        throw admissionError(
          "the database could not confirm both admission fences closed",
        );
    },
    async loadPreflight(target) {
      const [row] = await db
        .select({
          campaignStatus: simCampaigns.status,
          campaignPlanRevisionId: simCampaigns.currentPlanRevisionId,
          campaignGeneration: simCampaigns.currentConditionGeneration,
          cutoverStatus: simCampaignSolverCutovers.status,
          cutoverAttestationId: simCampaignSolverCutovers.canaryAttestationId,
          cutoverPlanRevisionId: simCampaignSolverCutovers.targetPlanRevisionId,
          cutoverGeneration: simCampaignSolverCutovers.targetGeneration,
          cutoverToSolverImplementationId:
            simCampaignSolverCutovers.toSolverImplementationId,
          priorCampaignStatus: simCampaignSolverCutovers.priorCampaignStatus,
          continuationStatus: solverCutoverContinuationChecks.status,
          continuationJobId: solverCutoverContinuationChecks.simJobId,
          continuationEvidenceResultId:
            solverCutoverContinuationChecks.evidenceResultId,
          continuationLastError: solverCutoverContinuationChecks.lastError,
          attestedRuntimeBuildId:
            solverEngineCanaryAttestations.solverRuntimeBuildId,
          attestedSolverImplementationId:
            solverEngineCanaryAttestations.solverImplementationId,
          attestedExecutionPoolId:
            solverEngineCanaryAttestations.solverExecutionPoolId,
          poolEnabled: solverExecutionPools.enabled,
          sweeperEnabled: sweeperState.enabled,
        })
        .from(simCampaigns)
        .innerJoin(
          simCampaignSolverCutovers,
          and(
            eq(simCampaignSolverCutovers.campaignId, simCampaigns.id),
            eq(
              simCampaignSolverCutovers.canaryAttestationId,
              target.canaryAttestationId,
            ),
          ),
        )
        .innerJoin(
          solverEngineCanaryAttestations,
          eq(
            solverEngineCanaryAttestations.id,
            simCampaignSolverCutovers.canaryAttestationId,
          ),
        )
        .innerJoin(
          solverCutoverContinuationChecks,
          eq(
            solverCutoverContinuationChecks.canaryAttestationId,
            solverEngineCanaryAttestations.id,
          ),
        )
        .innerJoin(
          solverExecutionPools,
          eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID),
        )
        .innerJoin(sweeperState, eq(sweeperState.id, 1))
        .where(eq(simCampaigns.id, target.campaignId))
        .limit(1);
      if (!row)
        throw admissionError(
          "the campaign/cutover/attestation continuation tuple is missing",
        );
      const [
        openJobCount,
        activePrecalcCount,
        activeVerifyCount,
        activeUransRequestCount,
        activeLadderSubmitRetryCount,
        activeResultSubmitRetryCount,
        activeRemotePromiseCount,
        otherEnabledPoolCount,
      ] = await Promise.all([
        scalarCount(
          db
            .select({ n: count() })
            .from(simJobs)
            .where(inArray(simJobs.status, [...OPEN_JOB_STATUSES])),
        ),
        scalarCount(
          db
            .select({ n: count() })
            .from(simPrecalcObligations)
            .where(
              inArray(simPrecalcObligations.state, ["pending", "running"]),
            ),
        ),
        scalarCount(
          db
            .select({ n: count() })
            .from(simUransVerifyQueue)
            .where(inArray(simUransVerifyQueue.state, ["pending", "running"])),
        ),
        scalarCount(
          db
            .select({ n: count() })
            .from(simUransRequests)
            .where(inArray(simUransRequests.state, ["pending", "running"])),
        ),
        scalarCount(
          db
            .select({ n: count() })
            .from(simLadderSubmitRetries)
            .where(eq(simLadderSubmitRetries.state, "retry_wait")),
        ),
        scalarCount(
          db
            .select({ n: count() })
            .from(simResultSubmitRetries)
            .where(eq(simResultSubmitRetries.state, "retry_wait")),
        ),
        scalarCount(
          db
            .select({ n: count() })
            .from(syncSweepPromises)
            .where(eq(syncSweepPromises.status, "active")),
        ),
        scalarCount(
          db
            .select({ n: count() })
            .from(solverExecutionPools)
            .where(
              and(
                eq(solverExecutionPools.enabled, true),
                ne(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID),
              ),
            ),
        ),
      ]);
      return {
        ...row,
        campaignGeneration: Number(row.campaignGeneration),
        cutoverGeneration:
          row.cutoverGeneration == null ? null : Number(row.cutoverGeneration),
        openJobCount,
        activePrecalcCount,
        activeVerifyCount,
        activeUransRequestCount,
        activeSubmitRetryCount:
          activeLadderSubmitRetryCount + activeResultSubmitRetryCount,
        activeRemotePromiseCount,
        otherEnabledPoolCount,
      };
    },
    async assertDiskAdmission() {
      const decision = await refreshDiskAdmission(db, engine, 0);
      if (!decision.allowed)
        throw admissionError(decision.reason ?? "disk admission is closed");
    },
    async loadJobIds() {
      const rows = await db.select({ id: simJobs.id }).from(simJobs);
      return new Set(rows.map((row) => row.id));
    },
    async loadCandidate(target) {
      return findCampaignGapBatch(db, {
        campaignIds: [target.campaignId],
        limit: 500,
      });
    },
    candidateSummary(candidate) {
      return {
        campaignId: candidate.campaignId,
        airfoilId: candidate.airfoilId,
        conditionCount: candidate.entries.length,
        angleCount: candidate.angles.length,
        conditionIds: candidate.entries.map((entry) => entry.conditionId),
        angles: candidate.angles,
      };
    },
    async submitCandidate(candidate) {
      const healthy = await engine.health();
      if (!healthy) throw admissionError("the engine health probe failed");
      const meshRecoveryVersion = await engineMeshRecoveryVersion(engine);
      if (meshRecoveryVersion == null)
        throw admissionError("the engine mesh-recovery capability is unknown");
      const [state] = await db
        .select({ cpuSlots: sweeperState.cpuSlots })
        .from(sweeperState)
        .where(eq(sweeperState.id, 1))
        .limit(1);
      if (!state)
        throw admissionError("the singleton sweeper state row is missing");
      return submitCampaignBatch(
        db,
        engine,
        candidate,
        state.cpuSlots,
        undefined,
        meshRecoveryVersion,
      );
    },
    async loadJobsNotIn(before, target) {
      const rows = await db
        .select({
          id: simJobs.id,
          campaignId: simJobs.campaignId,
          airfoilId: simJobs.airfoilId,
          totalCases: simJobs.totalCases,
          requestPayload: simJobs.requestPayload,
          simulationPresetRevisionId: simJobs.simulationPresetRevisionId,
          solverImplementationId: simJobs.solverImplementationId,
          solverExecutionPoolId: simJobs.solverExecutionPoolId,
          solverRuntimeBuildId: simJobs.solverRuntimeBuildId,
          status: simJobs.status,
          engineState: simJobs.engineState,
          engineJobId: simJobs.engineJobId,
          submittedAt: simJobs.submittedAt,
        })
        .from(simJobs);
      const fresh = rows.filter((row) => !before.has(row.id));
      return Promise.all(
        fresh.map(async (row) => {
          const [condition] =
            row.campaignId && row.simulationPresetRevisionId
              ? await db
                  .select({ id: simCampaignConditions.id })
                  .from(simCampaignConditions)
                  .where(
                    and(
                      eq(simCampaignConditions.campaignId, row.campaignId),
                      eq(
                        simCampaignConditions.generation,
                        target.targetGeneration,
                      ),
                      eq(
                        simCampaignConditions.simulationPresetRevisionId,
                        row.simulationPresetRevisionId,
                      ),
                    ),
                  )
                  .limit(1)
              : [];
          return {
            ...row,
            belongsToTargetGeneration: Boolean(condition),
          };
        }),
      );
    },
  };
}
