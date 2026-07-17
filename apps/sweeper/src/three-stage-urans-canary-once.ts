import { createHash } from "node:crypto";

import {
  OPENCFD_2606_EXECUTION_POOL_ID,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
  type DB,
  type Sql,
  FINAL_URANS_OUTCOMES,
  resultAttempts,
  resultClassifications,
  results,
  simCampaignConditions,
  simCampaignPoints,
  simCampaigns,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligationCampaigns,
  simPrecalcObligationRequests,
  simPrecalcObligations,
  simSolverIncidents,
  simUransRequestCampaigns,
  simUransRequests,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
  simUransVerifyQueueRequests,
  simulationPresetRevisions,
  solverExecutionPools,
  solverRuntimeBuilds,
  syncSweepPromisePoints,
  syncSweepPromises,
  sweeperState,
  URANS_RECOVERY_REMEDIATION_VERSION,
} from "@aerodb/db";
import { isAutomaticRansPrecalcHandoffEvidence } from "@aerodb/core";
import {
  OPENCFD_2606_ENGINE,
  isEngineRuntimeIdentity,
  sameEngineIdentity,
  type EngineCapabilities,
  type EngineClient,
  type EngineHealth,
  type EngineMaintenanceDiskResponse,
  type EngineQueueState,
} from "@aerodb/engine-client";
import { and, asc, count, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { evaluateDiskAdmission } from "./disk-admission";
import { submitExactUransCanaryStep } from "./urans-ladder";

const OPEN_JOB_STATUSES = [
  "pending",
  "submitted",
  "running",
  "ingesting",
] as const;
const TERMINAL_PARENT_STATUSES = new Set(["done", "failed", "cancelled"]);
const OPEN_VERIFY_STATES = ["pending", "running", "blocked"] as const;
const TERMINAL_VERIFY_SUCCESS_STATES = new Set(["done", "disagreed"]);
const TARGET_ROUTING_KEY = "openfoam-opencfd-2606";
const EXPECTED_EVIDENCE_STORAGE = Object.freeze({
  backend: "gcs",
  bucket: "airfoils-pro-storage-bucket",
  object_prefix: "solver-evidence/v1",
  archive_format: "tar+zstd",
  compression: "zstd",
  zstd_level: 10,
  remote_only: true,
});

export interface ThreeStageUransCanaryTarget {
  campaignId: string;
  conditionId: string;
  expectedCampaignGeneration: number;
  parentJobId: string;
  airfoilId: string;
  revisionId: string;
  aoaDeg: number;
  sourceResultId: string;
  sourceResultAttemptId: string;
  precalcObligationId: string;
  expectedEngineBuildId: string;
  expectedMeshRecoveryVersion: number;
  expectedUransRecoveryVersion: number;
}

export interface ThreeStageUransCanaryJob {
  id: string;
  campaignId: string | null;
  parentJobId: string | null;
  airfoilId: string;
  revisionId: string | null;
  methodKey: string | null;
  jobKind: string;
  wave: number;
  status: string;
  engineState: string | null;
  engineJobId: string | null;
  solverImplementationId: string | null;
  solverExecutionPoolId: string | null;
  solverRuntimeBuildId: string | null;
  solverRuntimeBuildLabel: string | null;
  requestPayload: unknown;
}

export interface ThreeStageUransCanarySnapshot {
  sweeperEnabled: boolean | null;
  maxConcurrentJobs: number;
  cpuSlots: number;
  campaignStatus: string | null;
  campaignGeneration: number | null;
  condition: {
    campaignId: string;
    generation: number;
    status: string;
    revisionId: string;
  } | null;
  campaignPointCount: number;
  parent: {
    campaignId: string | null;
    airfoilId: string;
    revisionId: string | null;
    methodKey: string | null;
    wave: number;
    status: string;
    engineJobId: string | null;
    solverImplementationId: string | null;
    solverExecutionPoolId: string | null;
  } | null;
  revisionSolverImplementationId: string | null;
  sourceResult: {
    airfoilId: string;
    revisionId: string | null;
    aoaDeg: number;
    currentResultAttemptId: string | null;
    status: string;
    source: string;
    regime: string | null;
    methodKey: string | null;
    fidelity: string | null;
    classificationState: string | null;
    classificationRegime: string | null;
    solverImplementationId: string | null;
    solverRuntimeBuildId: string | null;
    solverRuntimeBuildLabel: string | null;
  } | null;
  sourceAttempt: {
    resultId: string | null;
    simJobId: string | null;
    airfoilId: string;
    revisionId: string | null;
    aoaDeg: number;
    status: string;
    source: string;
    regime: string | null;
    methodKey: string | null;
    classificationState: string | null;
    failureDisposition: string | null;
    error: string | null;
    isLatestForParentGeneration: boolean;
  } | null;
  obligation: {
    airfoilId: string;
    revisionId: string;
    aoaDeg: number;
    sourceResultId: string | null;
    sourceResultAttemptId: string | null;
    state: string;
    attemptCount: number;
    submitFailureCount: number;
    continuationSegmentCount: number;
    continuationNoProgressCount: number;
    latestSimJobId: string | null;
    lastOutcome: string | null;
    lastError: string | null;
    nextSubmitAt: Date | null;
    completedAt: Date | null;
    backgroundOwner: boolean;
  } | null;
  obligationOwnerCampaignIds: string[];
  obligationRequestIds: string[];
  obligationLiveSyncPromiseIds: string[];
  obligationAttemptCount: number;
  pool: {
    id: string;
    solverImplementationId: string;
    routingKey: string;
    enabled: boolean;
  } | null;
  otherEnabledPoolCount: number;
  matchingRuntimeBuildCount: number;
  request: {
    id: string;
    airfoilId: string;
    revisionId: string;
    aoaDeg: number | null;
    fidelity: string;
    state: string;
    simJobId: string | null;
    requestedBy: string | null;
    backgroundOwner: boolean;
    continueFromResultId: string | null;
  } | null;
  markerRequestCount: number;
  overlappingOpenRequestIds: string[];
  requestOwnerCampaignIds: string[];
  requestCoveredObligationIds: string[];
  verify: {
    id: string;
    airfoilId: string;
    revisionId: string;
    aoaDeg: number;
    backgroundOwner: boolean;
    state: string;
    simJobId: string | null;
    precalcResultId: string;
    verifyResultId: string | null;
    precalcResultAttemptId: string | null;
    latestResultAttemptId: string | null;
    freshAttemptCount: number;
    maxFreshAttempts: number;
    continuationAttemptCount: number;
    continuationNoProgressCount: number;
    lastOutcome: string | null;
    lastError: string | null;
    nextSubmitAt: Date | null;
  } | null;
  verifyCount: number;
  verifyOwnerCampaignIds: string[];
  verifyRequestIds: string[];
  verifyPrecalcAttempt: {
    id: string;
    resultId: string | null;
    airfoilId: string;
    revisionId: string | null;
    aoaDeg: number;
    status: string;
    source: string;
    regime: string | null;
    methodKey: string | null;
    fidelity: string | null;
    classificationState: string | null;
    supersededByResultId: string | null;
    precalcObligationId: string | null;
  } | null;
  verifyLatestAttempt: {
    id: string;
    resultId: string | null;
    simJobId: string | null;
    airfoilId: string;
    revisionId: string | null;
    aoaDeg: number;
    status: string;
    source: string;
    regime: string | null;
    methodKey: string | null;
    fidelity: string | null;
    classificationState: string | null;
    solverImplementationId: string | null;
    solverRuntimeBuildId: string | null;
    solverRuntimeBuildLabel: string | null;
  } | null;
  conflictingOpenVerifyIds: string[];
  targetOpenCriticalIncidentCount: number;
  targetOpenCriticalIncident: {
    id: string;
    stage: string;
    reason: string;
    remediationVersion: string;
    solverImplementationId: string;
    resultId: string | null;
    precalcObligationId: string | null;
    verifyQueueId: string | null;
    uransRequestId: string | null;
  } | null;
  openJobs: ThreeStageUransCanaryJob[];
}

export interface ThreeStageUransEnginePreflight {
  health: EngineHealth;
  capabilities: EngineCapabilities;
  queue: EngineQueueState;
  disk: EngineMaintenanceDiskResponse;
}

export interface ThreeStageUransCanaryDependencies {
  withLease<T>(marker: string, operation: () => Promise<T>): Promise<T>;
  loadSnapshot(
    target: ThreeStageUransCanaryTarget,
    marker: string,
  ): Promise<ThreeStageUransCanarySnapshot>;
  loadEnginePreflight(): Promise<ThreeStageUransEnginePreflight>;
  ensureFullRequest(
    target: ThreeStageUransCanaryTarget,
    marker: string,
  ): Promise<string>;
  submitExactStep(input: {
    requestId: string;
    verifyId: string | null;
    cpuSlots: number;
    meshRecoveryVersion: number;
    uransRecoveryVersion: number;
  }): Promise<boolean>;
}

export interface ThreeStageUransCanaryReceipt {
  action: "submitted" | "observed" | "no-op" | "completed" | "critical";
  stage: "preliminary" | "final" | "complete" | "critical" | "transition";
  campaignId: string;
  conditionId: string;
  parentJobId: string;
  airfoilId: string;
  revisionId: string;
  aoaDeg: number;
  sourceResultId: string;
  sourceResultAttemptId: string;
  precalcObligationId: string;
  requestId: string | null;
  verifyQueueId: string | null;
  simJobId: string | null;
  engineJobId: string | null;
  requestState: string | null;
  obligationState: string;
  verifyState: string | null;
  criticalIncidentId: string | null;
  criticalIncidentStage: string | null;
  criticalIncidentReason: string | null;
  criticalRemediationVersion: string | null;
  expectedCampaignGeneration: number;
  expectedEngineBuildId: string;
  expectedMeshRecoveryVersion: number;
  expectedUransRecoveryVersion: number;
}

function canaryError(message: string): Error {
  return new Error(`three-stage URANS canary refused: ${message}`);
}

function canonicalAoa(value: number): string {
  return Object.is(value, -0) ? "0" : value.toString();
}

export function threeStageUransCanaryMarker(
  target: ThreeStageUransCanaryTarget,
): string {
  const canonical = JSON.stringify({
    campaignId: target.campaignId,
    conditionId: target.conditionId,
    expectedCampaignGeneration: target.expectedCampaignGeneration,
    parentJobId: target.parentJobId,
    airfoilId: target.airfoilId,
    revisionId: target.revisionId,
    aoaDeg: canonicalAoa(target.aoaDeg),
    sourceResultId: target.sourceResultId,
    sourceResultAttemptId: target.sourceResultAttemptId,
    precalcObligationId: target.precalcObligationId,
    expectedEngineBuildId: target.expectedEngineBuildId,
    expectedMeshRecoveryVersion: target.expectedMeshRecoveryVersion,
    expectedUransRecoveryVersion: target.expectedUransRecoveryVersion,
  });
  return `system:three-stage-urans-canary-v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

function exactStringSet(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

function payloadRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactOneAoa(value: unknown, aoaDeg: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === "number" &&
    Object.is(value[0], aoaDeg)
  );
}

function isExactCanaryJob(
  target: ThreeStageUransCanaryTarget,
  snapshot: ThreeStageUransCanarySnapshot,
  job: ThreeStageUransCanaryJob,
): boolean {
  if (!snapshot.request) return false;
  const payload = payloadRecord(job.requestPayload);
  if (
    !payload ||
    job.campaignId !== null ||
    job.parentJobId !== null ||
    job.airfoilId !== target.airfoilId ||
    job.revisionId !== target.revisionId ||
    job.methodKey !== "openfoam.urans" ||
    job.wave !== 2 ||
    job.solverImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
    job.solverExecutionPoolId !== OPENCFD_2606_EXECUTION_POOL_ID ||
    !exactOneAoa(payload.aoas, target.aoaDeg)
  ) {
    return false;
  }
  if (
    job.solverRuntimeBuildLabel != null &&
    job.solverRuntimeBuildLabel !== target.expectedEngineBuildId
  ) {
    return false;
  }
  if (payload.uransFidelity === "precalc") {
    const obligationIds = payload.precalcObligationIds;
    return (
      job.jobKind === "targeted" &&
      snapshot.request.simJobId === job.id &&
      snapshot.obligation?.latestSimJobId === job.id &&
      payload.meshRecoveryVersion === target.expectedMeshRecoveryVersion &&
      (payload.continueFromResultAttemptId == null ||
        payload.uransRecoveryVersion === target.expectedUransRecoveryVersion) &&
      payload.uransRequestId === snapshot.request.id &&
      Array.isArray(obligationIds) &&
      obligationIds.every((id): id is string => typeof id === "string") &&
      exactStringSet(obligationIds, [target.precalcObligationId])
    );
  }
  if (
    payload.uransFidelity !== "full" ||
    job.jobKind !== "verify" ||
    snapshot.verify == null ||
    snapshot.verify.simJobId !== job.id ||
    payload.verifyQueueItemId !== snapshot.verify.id ||
    payload.verifyPrecalcResultAttemptId !==
      snapshot.verify.precalcResultAttemptId
  ) {
    return false;
  }
  if (payload.finalRecoveryMode === "continuation") {
    return (
      snapshot.verify.latestResultAttemptId != null &&
      payload.continueFromResultAttemptId ===
        snapshot.verify.latestResultAttemptId &&
      payload.uransRecoveryVersion === target.expectedUransRecoveryVersion
    );
  }
  return (
    payload.finalRecoveryMode === "fresh" &&
    payload.continueFromResultAttemptId == null &&
    (payload.uransRecoveryVersion == null ||
      payload.uransRecoveryVersion === target.expectedUransRecoveryVersion)
  );
}

function pristineObligation(snapshot: ThreeStageUransCanarySnapshot): boolean {
  const obligation = snapshot.obligation;
  return Boolean(
    obligation &&
    obligation.state === "pending" &&
    obligation.attemptCount === 0 &&
    obligation.submitFailureCount === 0 &&
    obligation.continuationSegmentCount === 0 &&
    obligation.continuationNoProgressCount === 0 &&
    obligation.latestSimJobId == null &&
    obligation.lastOutcome == null &&
    obligation.lastError == null &&
    obligation.nextSubmitAt == null &&
    obligation.completedAt == null &&
    snapshot.obligationAttemptCount === 0,
  );
}

export function validateThreeStageUransCanarySnapshot(
  target: ThreeStageUransCanaryTarget,
  marker: string,
  snapshot: ThreeStageUransCanarySnapshot,
): void {
  if (snapshot.sweeperEnabled == null)
    throw canaryError("the singleton sweeper state row is missing");
  if (snapshot.sweeperEnabled)
    throw canaryError("the durable sweeper admission switch is enabled");
  if (
    snapshot.maxConcurrentJobs !== 0 ||
    snapshot.cpuSlots !== 0 ||
    !Number.isSafeInteger(snapshot.maxConcurrentJobs) ||
    !Number.isSafeInteger(snapshot.cpuSlots)
  ) {
    throw canaryError(
      "the durable scheduler capacity fence is not exactly maxConcurrentJobs=0 and cpuSlots=0",
    );
  }
  if (!snapshot.campaignStatus)
    throw canaryError("the exact campaign does not exist");
  if (!new Set(["active", "attention"]).has(snapshot.campaignStatus))
    throw canaryError("the exact campaign is not an active scheduling owner");
  if (snapshot.campaignGeneration !== target.expectedCampaignGeneration)
    throw canaryError(
      "the campaign is not at the explicitly expected condition generation",
    );
  if (
    !snapshot.condition ||
    snapshot.condition.campaignId !== target.campaignId ||
    snapshot.condition.generation !== target.expectedCampaignGeneration ||
    !new Set(["active", "kept"]).has(snapshot.condition.status) ||
    snapshot.condition.revisionId !== target.revisionId
  ) {
    throw canaryError(
      "the exact condition is not active in the expected campaign generation",
    );
  }
  if (snapshot.campaignPointCount !== 1)
    throw canaryError(
      "the exact campaign does not own the requested physical cell",
    );
  const chainIsCriticallyBlocked =
    snapshot.obligation?.state === "blocked" ||
    snapshot.request?.state === "blocked" ||
    snapshot.verify?.state === "blocked";
  if (
    (chainIsCriticallyBlocked &&
      (snapshot.targetOpenCriticalIncidentCount !== 1 ||
        snapshot.targetOpenCriticalIncident == null)) ||
    (!chainIsCriticallyBlocked &&
      (snapshot.targetOpenCriticalIncidentCount !== 0 ||
        snapshot.targetOpenCriticalIncident != null))
  )
    throw canaryError(
      "the exact canary chain's blocked state and open critical incident do not agree",
    );
  if (chainIsCriticallyBlocked) {
    const incident = snapshot.targetOpenCriticalIncident!;
    const expectedOwner =
      snapshot.verify?.state === "blocked"
        ? {
            stage: "final",
            resultId: null,
            precalcObligationId: null,
            verifyQueueId: snapshot.verify.id,
            uransRequestId: null,
          }
        : snapshot.obligation?.state === "blocked"
          ? {
              stage: "preliminary",
              resultId: null,
              precalcObligationId: target.precalcObligationId,
              verifyQueueId: null,
              uransRequestId: null,
            }
          : {
              stage: "final",
              resultId: null,
              precalcObligationId: null,
              verifyQueueId: null,
              uransRequestId: snapshot.request?.id ?? null,
            };
    if (
      incident.stage !== expectedOwner.stage ||
      incident.solverImplementationId !==
        OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
      incident.remediationVersion !== URANS_RECOVERY_REMEDIATION_VERSION ||
      incident.resultId !== expectedOwner.resultId ||
      incident.precalcObligationId !== expectedOwner.precalcObligationId ||
      incident.verifyQueueId !== expectedOwner.verifyQueueId ||
      incident.uransRequestId !== expectedOwner.uransRequestId
    ) {
      throw canaryError(
        "the blocked canary stage does not own its exact current-remediation critical incident",
      );
    }
  }
  const parent = snapshot.parent;
  if (
    !parent ||
    parent.campaignId !== target.campaignId ||
    parent.airfoilId !== target.airfoilId ||
    parent.revisionId !== target.revisionId ||
    parent.wave !== 1 ||
    parent.methodKey !== "openfoam.rans" ||
    !parent.engineJobId ||
    parent.solverImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
    parent.solverExecutionPoolId !== OPENCFD_2606_EXECUTION_POOL_ID ||
    !TERMINAL_PARENT_STATUSES.has(parent.status)
  ) {
    throw canaryError(
      "the exact source parent is not terminal campaign RANS work",
    );
  }
  if (
    snapshot.revisionSolverImplementationId !==
    OPENCFD_2606_SOLVER_IMPLEMENTATION_ID
  ) {
    throw canaryError("the immutable revision is not OpenCFD 2606");
  }
  const sourceResult = snapshot.sourceResult;
  if (
    !sourceResult ||
    sourceResult.airfoilId !== target.airfoilId ||
    sourceResult.revisionId !== target.revisionId ||
    !Object.is(sourceResult.aoaDeg, target.aoaDeg)
  ) {
    throw canaryError(
      "the exact source result does not own the requested cell",
    );
  }
  const sourceAttempt = snapshot.sourceAttempt;
  const requestHasExactCoverage = exactStringSet(
    snapshot.requestCoveredObligationIds,
    [target.precalcObligationId],
  );
  const sourceWasSupersededByThisChain =
    sourceAttempt?.classificationState === "superseded_by_urans" &&
    snapshot.request != null &&
    requestHasExactCoverage &&
    snapshot.obligation?.state === "satisfied" &&
    snapshot.verify?.precalcResultId === target.sourceResultId &&
    snapshot.verify.precalcResultAttemptId != null;
  const sourceHasAutomaticHandoff = Boolean(
    sourceAttempt &&
    isAutomaticRansPrecalcHandoffEvidence({
      classificationState: sourceAttempt.classificationState ?? "",
      failureDisposition: sourceAttempt.failureDisposition,
      status: sourceAttempt.status,
      source: sourceAttempt.source,
      error: sourceAttempt.error,
    }),
  );
  const sourceHasForbiddenDisposition =
    sourceAttempt?.failureDisposition === "deterministic_mesh" ||
    sourceAttempt?.failureDisposition === "infrastructure";
  if (
    !sourceAttempt ||
    sourceAttempt.resultId !== target.sourceResultId ||
    sourceAttempt.simJobId !== target.parentJobId ||
    sourceAttempt.airfoilId !== target.airfoilId ||
    sourceAttempt.revisionId !== target.revisionId ||
    !Object.is(sourceAttempt.aoaDeg, target.aoaDeg) ||
    sourceAttempt.status !== "done" ||
    sourceAttempt.source !== "solved" ||
    sourceAttempt.regime !== "rans" ||
    sourceAttempt.methodKey !== "openfoam.rans" ||
    !sourceAttempt.isLatestForParentGeneration ||
    !sourceAttempt.classificationState ||
    sourceHasForbiddenDisposition ||
    (!sourceHasAutomaticHandoff && !sourceWasSupersededByThisChain)
  ) {
    throw canaryError(
      "the exact immutable source attempt is not eligible RANS handoff evidence",
    );
  }
  const obligation = snapshot.obligation;
  // Ingestion replaces the obligation's source-attempt pointer with the
  // accepted preliminary generation. Keep accepting the original immutable
  // RANS pin only through the linked verify generation, which is fully
  // validated below before any final work can be admitted.
  const obligationPinsAcceptedPreliminary =
    obligation?.state === "satisfied" &&
    obligation.sourceResultId === target.sourceResultId &&
    snapshot.verify?.precalcResultId === target.sourceResultId &&
    snapshot.verify.precalcResultAttemptId != null &&
    obligation.sourceResultAttemptId === snapshot.verify.precalcResultAttemptId;
  if (
    !obligation ||
    obligation.airfoilId !== target.airfoilId ||
    obligation.revisionId !== target.revisionId ||
    !Object.is(obligation.aoaDeg, target.aoaDeg) ||
    obligation.sourceResultId !== target.sourceResultId ||
    (obligation.sourceResultAttemptId !== target.sourceResultAttemptId &&
      !obligationPinsAcceptedPreliminary)
  ) {
    throw canaryError(
      "the exact preliminary obligation does not pin the supplied RANS generation",
    );
  }
  if (obligation.backgroundOwner)
    throw canaryError(
      "the preliminary obligation has an unrelated background owner",
    );
  if (!exactStringSet(snapshot.obligationOwnerCampaignIds, [target.campaignId]))
    throw canaryError(
      "the preliminary obligation does not have the exact active campaign owner",
    );
  if (snapshot.obligationLiveSyncPromiseIds.length)
    throw canaryError(
      "the preliminary obligation is shared with an active remote-solver promise",
    );
  if (
    !snapshot.pool ||
    snapshot.pool.id !== OPENCFD_2606_EXECUTION_POOL_ID ||
    snapshot.pool.solverImplementationId !==
      OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
    snapshot.pool.routingKey !== TARGET_ROUTING_KEY ||
    !snapshot.pool.enabled
  ) {
    throw canaryError(
      "the exact OpenCFD 2606 execution pool is missing or disabled",
    );
  }
  if (snapshot.otherEnabledPoolCount !== 0)
    throw canaryError(
      `${snapshot.otherEnabledPoolCount} non-target execution pool(s) are enabled`,
    );
  if (snapshot.matchingRuntimeBuildCount > 1)
    throw canaryError(
      "the expected OpenCFD 2606 runtime build registry is ambiguous",
    );
  for (const job of snapshot.openJobs) {
    if (job.solverRuntimeBuildId == null) {
      if (
        job.solverRuntimeBuildLabel != null ||
        job.status !== "submitted" ||
        job.engineState !== "pending" ||
        !job.engineJobId
      ) {
        throw canaryError(
          "an exact job lacks runtime provenance after leaving the acknowledged engine-pending state",
        );
      }
    } else if (
      snapshot.matchingRuntimeBuildCount !== 1 ||
      job.solverRuntimeBuildLabel !== target.expectedEngineBuildId ||
      !job.engineJobId
    ) {
      throw canaryError(
        "an exact job does not acknowledge the one expected OpenCFD 2606 runtime build",
      );
    }
  }
  if (snapshot.markerRequestCount > 1)
    throw canaryError("more than one request carries the exact canary marker");
  if (snapshot.verifyCount > 1)
    throw canaryError(
      "more than one final-verification item is linked to the canary request",
    );
  if (snapshot.conflictingOpenVerifyIds.length)
    throw canaryError(
      `${snapshot.conflictingOpenVerifyIds.length} conflicting final-verification item(s) overlap the exact cell`,
    );

  if (!snapshot.request) {
    if (snapshot.markerRequestCount !== 0)
      throw canaryError("the marked request could not be resolved");
    if (snapshot.overlappingOpenRequestIds.length)
      throw canaryError(
        "unrelated open FULL work already overlaps the exact cell",
      );
    if (snapshot.obligationRequestIds.length)
      throw canaryError(
        "the pristine preliminary obligation is already covered by another FULL request",
      );
    if (
      !pristineObligation(snapshot) &&
      !(
        obligation.state === "blocked" &&
        snapshot.targetOpenCriticalIncidentCount > 0
      )
    )
      throw canaryError(
        "the preliminary obligation is not pristine and no exact canary chain exists",
      );
  } else {
    const request = snapshot.request;
    const obligationHasExactRequestOwner = exactStringSet(
      snapshot.obligationRequestIds,
      [request.id],
    );
    if (
      snapshot.markerRequestCount !== 1 ||
      request.airfoilId !== target.airfoilId ||
      request.revisionId !== target.revisionId ||
      request.aoaDeg == null ||
      !Object.is(request.aoaDeg, target.aoaDeg) ||
      request.fidelity !== "full" ||
      request.requestedBy !== marker ||
      request.backgroundOwner ||
      request.continueFromResultId != null ||
      request.state === "cancelled"
    ) {
      throw canaryError(
        "the existing marked request is not the exact fresh FULL canary owner",
      );
    }
    if (!exactStringSet(snapshot.requestOwnerCampaignIds, [target.campaignId]))
      throw canaryError(
        "the FULL request does not have the exact active campaign owner",
      );
    if (
      snapshot.obligationRequestIds.length > 0 &&
      !obligationHasExactRequestOwner
    )
      throw canaryError(
        "the preliminary obligation is covered by a request outside the exact canary chain",
      );
    if (requestHasExactCoverage !== obligationHasExactRequestOwner)
      throw canaryError(
        "the marked FULL request and preliminary obligation coverage disagree",
      );
    if (
      snapshot.requestCoveredObligationIds.length > 0 &&
      !requestHasExactCoverage
    )
      throw canaryError(
        "the FULL request covers obligations outside the exact canary cell",
      );
    if (snapshot.overlappingOpenRequestIds.some((id) => id !== request.id)) {
      throw canaryError(
        "unrelated open FULL work overlaps the exact canary cell",
      );
    }
    if (
      (snapshot.obligationAttemptCount > 0 ||
        obligation.latestSimJobId != null ||
        snapshot.verify != null) &&
      !requestHasExactCoverage
    ) {
      throw canaryError(
        "the progressed canary request does not own the exact preliminary obligation",
      );
    }
    if (snapshot.verify) {
      const verify = snapshot.verify;
      if (
        verify.airfoilId !== target.airfoilId ||
        verify.revisionId !== target.revisionId ||
        !Object.is(verify.aoaDeg, target.aoaDeg) ||
        verify.backgroundOwner ||
        verify.precalcResultId !== target.sourceResultId ||
        !verify.precalcResultAttemptId
      ) {
        throw canaryError(
          "the linked final-verification item is not the exact canary cell",
        );
      }
      if (!exactStringSet(snapshot.verifyRequestIds, [request.id]))
        throw canaryError(
          "the final-verification item is shared with a request outside the exact canary chain",
        );
      const preliminary = snapshot.verifyPrecalcAttempt;
      const terminalVerifySucceeded = TERMINAL_VERIFY_SUCCESS_STATES.has(
        verify.state,
      );
      const expectedPreliminaryClassification = terminalVerifySucceeded
        ? "superseded_by_urans"
        : "accepted";
      const expectedPreliminarySupersession = terminalVerifySucceeded
        ? verify.verifyResultId
        : null;
      if (
        !preliminary ||
        preliminary.id !== verify.precalcResultAttemptId ||
        preliminary.resultId !== verify.precalcResultId ||
        preliminary.airfoilId !== target.airfoilId ||
        preliminary.revisionId !== target.revisionId ||
        !Object.is(preliminary.aoaDeg, target.aoaDeg) ||
        preliminary.status !== "done" ||
        preliminary.source !== "solved" ||
        preliminary.regime !== "urans" ||
        preliminary.methodKey !== "openfoam.urans" ||
        preliminary.fidelity !== "urans_precalc" ||
        preliminary.classificationState !== expectedPreliminaryClassification ||
        preliminary.supersededByResultId !== expectedPreliminarySupersession ||
        preliminary.precalcObligationId !== target.precalcObligationId
      ) {
        throw canaryError(
          "the final-verification item does not pin the expected preliminary evidence lifecycle from the exact obligation",
        );
      }
      const latest = snapshot.verifyLatestAttempt;
      if (
        (verify.latestResultAttemptId == null) !== (latest == null) ||
        (latest != null && latest.id !== verify.latestResultAttemptId)
      ) {
        throw canaryError(
          "the final-verification latest-attempt pointer is missing or inconsistent",
        );
      }
      if (
        terminalVerifySucceeded &&
        (!latest ||
          !verify.simJobId ||
          verify.verifyResultId !== target.sourceResultId ||
          latest.resultId !== verify.verifyResultId ||
          latest.simJobId !== verify.simJobId ||
          latest.airfoilId !== target.airfoilId ||
          latest.revisionId !== target.revisionId ||
          !Object.is(latest.aoaDeg, target.aoaDeg) ||
          latest.status !== "done" ||
          latest.source !== "solved" ||
          latest.regime !== "urans" ||
          latest.methodKey !== "openfoam.urans" ||
          latest.fidelity !== "urans_full" ||
          latest.classificationState !== "accepted" ||
          latest.solverImplementationId !==
            OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
          !latest.solverRuntimeBuildId ||
          latest.solverRuntimeBuildLabel !== target.expectedEngineBuildId ||
          sourceResult.currentResultAttemptId !== latest.id ||
          sourceResult.status !== "done" ||
          sourceResult.source !== "solved" ||
          sourceResult.regime !== "urans" ||
          sourceResult.methodKey !== "openfoam.urans" ||
          sourceResult.fidelity !== "urans_full" ||
          sourceResult.classificationState !== "accepted" ||
          sourceResult.classificationRegime !== "urans" ||
          sourceResult.solverImplementationId !==
            OPENCFD_2606_SOLVER_IMPLEMENTATION_ID ||
          sourceResult.solverRuntimeBuildId !== latest.solverRuntimeBuildId ||
          sourceResult.solverRuntimeBuildLabel !== target.expectedEngineBuildId)
      ) {
        throw canaryError(
          "the terminal final-verification item does not publish one accepted full-URANS generation from the expected runtime",
        );
      }
      if (
        new Set(snapshot.verifyOwnerCampaignIds).size !==
          snapshot.verifyOwnerCampaignIds.length ||
        snapshot.verifyOwnerCampaignIds.some(
          (campaignId) => campaignId !== target.campaignId,
        )
      )
        throw canaryError(
          "the final-verification item has an unrelated direct campaign owner",
        );
      if (obligation.state !== "satisfied")
        throw canaryError(
          "final verification exists before the exact preliminary obligation is satisfied",
        );
      if (
        snapshot.openJobs.length === 0 &&
        !TERMINAL_VERIFY_SUCCESS_STATES.has(verify.state) &&
        verify.state !== "blocked"
      ) {
        if (verify.state !== "pending")
          throw canaryError(
            "the exact final-verification item is claimed without an exact live job",
          );
        if (verify.nextSubmitAt && verify.nextSubmitAt.getTime() > Date.now())
          throw canaryError("the exact final-verification item is not due yet");
        const continuationRequested =
          verify.lastOutcome === FINAL_URANS_OUTCOMES.continuationPending ||
          verify.lastOutcome === FINAL_URANS_OUTCOMES.continuationRetryWait;
        if (continuationRequested && verify.latestResultAttemptId == null)
          throw canaryError(
            "the exact continuation-ready item has no immutable source attempt",
          );
        const continuationReady =
          continuationRequested && verify.latestResultAttemptId != null;
        const freshOutcome =
          verify.lastOutcome == null ||
          verify.lastOutcome === FINAL_URANS_OUTCOMES.freshRetryPending ||
          verify.lastOutcome === FINAL_URANS_OUTCOMES.infrastructureRetryWait;
        const freshReady =
          freshOutcome && verify.freshAttemptCount < verify.maxFreshAttempts;
        if (!continuationReady && !freshReady)
          throw canaryError(
            "the exact final-verification item has no admissible continuation or fresh start",
          );
      }
    } else if (
      snapshot.verifyRequestIds.length > 0 ||
      snapshot.verifyPrecalcAttempt != null ||
      snapshot.verifyLatestAttempt != null
    ) {
      throw canaryError(
        "final-verification ownership or evidence exists without the exact queue item",
      );
    }
    if (
      request.state === "done" &&
      (!snapshot.verify ||
        !TERMINAL_VERIFY_SUCCESS_STATES.has(snapshot.verify.state))
    ) {
      throw canaryError(
        "the marked FULL request bypassed the exact final-verification chain",
      );
    }
  }

  if (snapshot.openJobs.length > 1)
    throw canaryError(
      `${snapshot.openJobs.length} nonterminal solver jobs exist`,
    );
  for (const job of snapshot.openJobs) {
    if (!isExactCanaryJob(target, snapshot, job))
      throw canaryError(
        `nonterminal job ${job.id} is unrelated to the exact canary chain`,
      );
  }
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw canaryError(`${label} is malformed`);
  return value;
}

export function validateThreeStageUransEnginePreflight(
  target: ThreeStageUransCanaryTarget,
  preflight: ThreeStageUransEnginePreflight,
): void {
  const { health, capabilities, queue } = preflight;
  if (health.status !== "ok" || health.role !== "solver_gateway")
    throw canaryError("the live solver gateway is not healthy");
  if (health.build_id !== target.expectedEngineBuildId)
    throw canaryError(
      "the live engine build differs from the explicit expectation",
    );
  if (health.mesh_recovery_version !== target.expectedMeshRecoveryVersion)
    throw canaryError(
      "the live mesh-recovery version differs from the explicit expectation",
    );
  if (health.urans_recovery_version !== target.expectedUransRecoveryVersion)
    throw canaryError(
      "the live URANS-recovery version differs from the explicit expectation",
    );
  const evidenceStorage = health.evidence_storage;
  if (
    !evidenceStorage ||
    evidenceStorage.backend !== EXPECTED_EVIDENCE_STORAGE.backend ||
    evidenceStorage.bucket !== EXPECTED_EVIDENCE_STORAGE.bucket ||
    evidenceStorage.object_prefix !== EXPECTED_EVIDENCE_STORAGE.object_prefix ||
    evidenceStorage.archive_format !==
      EXPECTED_EVIDENCE_STORAGE.archive_format ||
    evidenceStorage.compression !== EXPECTED_EVIDENCE_STORAGE.compression ||
    evidenceStorage.zstd_level !== EXPECTED_EVIDENCE_STORAGE.zstd_level ||
    evidenceStorage.remote_only !== EXPECTED_EVIDENCE_STORAGE.remote_only
  ) {
    throw canaryError(
      "the live evidence store is not the exact remote-only GCS tar+Zstandard contract",
    );
  }
  const diskAdmission = evaluateDiskAdmission(preflight.disk, 0);
  if (!diskAdmission.allowed)
    throw canaryError(diskAdmission.reason ?? "storage admission is closed");
  const supported = health.supported_engines ?? [];
  if (
    supported.filter((identity) =>
      sameEngineIdentity(identity, OPENCFD_2606_ENGINE),
    ).length !== 1
  ) {
    throw canaryError("health does not advertise OpenCFD 2606 exactly once");
  }
  if (
    supported.some(
      (identity) =>
        identity.family === "openfoam" &&
        identity.distribution === "opencfd" &&
        identity.version === "2406",
    )
  ) {
    throw canaryError("the retired OpenCFD 2406 runtime is still advertised");
  }

  const descriptors = (capabilities.engines ?? []).filter((descriptor) =>
    sameEngineIdentity(descriptor.engine, OPENCFD_2606_ENGINE),
  );
  if (descriptors.length !== 1)
    throw canaryError(
      "capabilities do not contain exactly one OpenCFD 2606 adapter",
    );
  const descriptor = descriptors[0];
  const methods = new Set(
    requiredStringArray(
      descriptor.analysis_methods,
      "2606 analysis methods",
    ).map((method) => method.replace(/^openfoam\./, "")),
  );
  if (
    descriptor.routing_key !== TARGET_ROUTING_KEY ||
    !methods.has("rans") ||
    !methods.has("urans") ||
    !descriptor.steady ||
    !descriptor.transient ||
    !descriptor.volume_fields ||
    !descriptor.mesh_evidence ||
    !descriptor.stored_media
  ) {
    throw canaryError(
      "the exact OpenCFD 2606 adapter lacks required RANS/URANS evidence capabilities",
    );
  }
  // The v2 health contract is the authoritative continuation capability.
  // Older capability documents omit this optional convenience flag; an
  // explicit false still contradicts the required v2 runtime and fails shut.
  if (capabilities.supports_continuation === false)
    throw canaryError(
      "the live adapter does not advertise same-case continuation",
    );

  if (queue.worker_queues_error != null || queue.worker_runtime_error != null)
    throw canaryError("live worker inspection is unavailable");
  if (Object.keys(queue.inspection_errors ?? {}).length)
    throw canaryError("Celery queue inspection reported an error");
  const queueRows = (queue.queues ?? []).filter(
    (row) => row.routing_key === TARGET_ROUTING_KEY,
  );
  if (
    queueRows.length !== 1 ||
    !queueRows[0].enabled ||
    !sameEngineIdentity(queueRows[0].engine, OPENCFD_2606_ENGINE) ||
    queue.queue_enabled?.[TARGET_ROUTING_KEY] !== true ||
    queueRows[0].depth !== 0 ||
    queue.queue_depths?.[TARGET_ROUTING_KEY] !== 0
  ) {
    throw canaryError(
      "the exact OpenCFD 2606 queue is missing, disabled, or nonempty",
    );
  }
  if (
    (queue.queues ?? []).some(
      (row) => row.routing_key !== TARGET_ROUTING_KEY && row.enabled,
    ) ||
    Object.entries(queue.queue_enabled ?? {}).some(
      ([route, enabled]) => route !== TARGET_ROUTING_KEY && enabled,
    )
  ) {
    throw canaryError("a non-target engine queue is enabled");
  }
  const targetWorkers = (queue.worker_queues ?? []).filter((binding) =>
    binding.queues?.includes(TARGET_ROUTING_KEY),
  );
  if (!targetWorkers.length)
    throw canaryError("no live worker consumes the exact OpenCFD 2606 queue");
  let runtimeSignature: string | null = null;
  for (const binding of targetWorkers) {
    if (
      binding.execution_pool !== TARGET_ROUTING_KEY ||
      !exactStringSet(binding.queues, [TARGET_ROUTING_KEY]) ||
      !isEngineRuntimeIdentity(binding.engine) ||
      !sameEngineIdentity(binding.engine, OPENCFD_2606_ENGINE) ||
      binding.engine.build_id !== target.expectedEngineBuildId
    ) {
      throw canaryError(
        "a target worker has the wrong route or runtime identity",
      );
    }
    const signature = JSON.stringify(binding.engine);
    if (runtimeSignature != null && runtimeSignature !== signature)
      throw canaryError(
        "OpenCFD 2606 workers do not share exact runtime provenance",
      );
    runtimeSignature = signature;
  }
  if (
    queue.active_count !== 0 ||
    queue.reserved_count !== 0 ||
    queue.scheduled_count !== 0 ||
    queue.active.length !== 0 ||
    queue.reserved.length !== 0 ||
    queue.scheduled.length !== 0 ||
    queue.job_ids.length !== 0 ||
    Object.keys(queue.duplicates).length !== 0 ||
    queue.redelivered.length !== 0
  ) {
    throw canaryError("engine queues are not empty before one-shot admission");
  }
}

function stageForSnapshot(
  snapshot: ThreeStageUransCanarySnapshot,
): ThreeStageUransCanaryReceipt["stage"] {
  if (
    snapshot.obligation?.state === "blocked" ||
    snapshot.request?.state === "blocked" ||
    snapshot.verify?.state === "blocked"
  )
    return "critical";
  if (
    snapshot.request?.state === "done" ||
    (snapshot.verify &&
      TERMINAL_VERIFY_SUCCESS_STATES.has(snapshot.verify.state))
  )
    return "complete";
  if (snapshot.verify) return "final";
  if (snapshot.request && snapshot.obligation?.state === "satisfied")
    return "transition";
  return "preliminary";
}

function receipt(
  action: ThreeStageUransCanaryReceipt["action"],
  target: ThreeStageUransCanaryTarget,
  snapshot: ThreeStageUransCanarySnapshot,
): ThreeStageUransCanaryReceipt {
  const job = snapshot.openJobs[0] ?? null;
  return {
    action,
    stage: stageForSnapshot(snapshot),
    campaignId: target.campaignId,
    conditionId: target.conditionId,
    parentJobId: target.parentJobId,
    airfoilId: target.airfoilId,
    revisionId: target.revisionId,
    aoaDeg: target.aoaDeg,
    sourceResultId: target.sourceResultId,
    sourceResultAttemptId: target.sourceResultAttemptId,
    precalcObligationId: target.precalcObligationId,
    requestId: snapshot.request?.id ?? null,
    verifyQueueId: snapshot.verify?.id ?? null,
    simJobId: job?.id ?? null,
    engineJobId: job?.engineJobId ?? null,
    requestState: snapshot.request?.state ?? null,
    obligationState: snapshot.obligation?.state ?? "missing",
    verifyState: snapshot.verify?.state ?? null,
    criticalIncidentId: snapshot.targetOpenCriticalIncident?.id ?? null,
    criticalIncidentStage: snapshot.targetOpenCriticalIncident?.stage ?? null,
    criticalIncidentReason: snapshot.targetOpenCriticalIncident?.reason ?? null,
    criticalRemediationVersion:
      snapshot.targetOpenCriticalIncident?.remediationVersion ?? null,
    expectedCampaignGeneration: target.expectedCampaignGeneration,
    expectedEngineBuildId: target.expectedEngineBuildId,
    expectedMeshRecoveryVersion: target.expectedMeshRecoveryVersion,
    expectedUransRecoveryVersion: target.expectedUransRecoveryVersion,
  };
}

/** Run one fail-closed admission/observation invocation. */
export async function runThreeStageUransCanaryOnce(
  target: ThreeStageUransCanaryTarget,
  dependencies: ThreeStageUransCanaryDependencies,
): Promise<ThreeStageUransCanaryReceipt> {
  const marker = threeStageUransCanaryMarker(target);
  return dependencies.withLease(marker, () =>
    runThreeStageUransCanaryWithLease(target, marker, dependencies),
  );
}

async function runThreeStageUransCanaryWithLease(
  target: ThreeStageUransCanaryTarget,
  marker: string,
  dependencies: ThreeStageUransCanaryDependencies,
): Promise<ThreeStageUransCanaryReceipt> {
  let snapshot = await dependencies.loadSnapshot(target, marker);
  validateThreeStageUransCanarySnapshot(target, marker, snapshot);

  if (snapshot.openJobs.length) return receipt("observed", target, snapshot);
  const initialStage = stageForSnapshot(snapshot);
  if (initialStage === "complete")
    return receipt("completed", target, snapshot);
  if (initialStage === "critical") return receipt("critical", target, snapshot);

  validateThreeStageUransEnginePreflight(
    target,
    await dependencies.loadEnginePreflight(),
  );

  if (!snapshot.request) {
    const requestId = await dependencies.ensureFullRequest(target, marker);
    snapshot = await dependencies.loadSnapshot(target, marker);
    validateThreeStageUransCanarySnapshot(target, marker, snapshot);
    if (snapshot.request?.id !== requestId)
      throw canaryError("the exact FULL request changed during creation");
  }

  if (snapshot.openJobs.length) return receipt("observed", target, snapshot);
  // Re-probe both database and engine immediately before mutation. A racing
  // invocation can win the atomic request claim, but it cannot make this
  // invocation admit a second job or proceed behind unrelated work.
  snapshot = await dependencies.loadSnapshot(target, marker);
  validateThreeStageUransCanarySnapshot(target, marker, snapshot);
  if (snapshot.openJobs.length) return receipt("observed", target, snapshot);
  validateThreeStageUransEnginePreflight(
    target,
    await dependencies.loadEnginePreflight(),
  );
  if (!snapshot.request)
    throw canaryError("the exact FULL request disappeared before admission");

  const submitted = await dependencies.submitExactStep({
    requestId: snapshot.request.id,
    verifyId: snapshot.verify?.id ?? null,
    cpuSlots: snapshot.cpuSlots,
    meshRecoveryVersion: target.expectedMeshRecoveryVersion,
    uransRecoveryVersion: target.expectedUransRecoveryVersion,
  });
  const after = await dependencies.loadSnapshot(target, marker);
  validateThreeStageUransCanarySnapshot(target, marker, after);
  const afterStage = stageForSnapshot(after);
  if (afterStage === "critical") return receipt("critical", target, after);
  if (afterStage === "complete") return receipt("completed", target, after);
  if (submitted && after.openJobs.length !== 1)
    throw canaryError(
      "the ladder reported admission without one exact nonterminal job",
    );
  if (!submitted && after.openJobs.length)
    return receipt("observed", target, after);
  return receipt(submitted ? "submitted" : "no-op", target, after);
}

async function scalarCount(
  query: Promise<Array<{ n: number }>>,
): Promise<number> {
  const [row] = await query;
  return Number(row?.n ?? 0);
}

export function countTargetOpenCriticalIncidents(
  target: ThreeStageUransCanaryTarget,
  requestId: string | null,
  verifyId: string | null,
  incidents: Array<{
    resultId: string | null;
    precalcObligationId: string | null;
    verifyQueueId: string | null;
    uransRequestId: string | null;
  }>,
): number {
  return incidents.filter(
    (incident) =>
      incident.resultId === target.sourceResultId ||
      incident.precalcObligationId === target.precalcObligationId ||
      (requestId != null && incident.uransRequestId === requestId) ||
      (verifyId != null && incident.verifyQueueId === verifyId),
  ).length;
}

function targetOpenCriticalIncidents<
  T extends {
    resultId: string | null;
    precalcObligationId: string | null;
    verifyQueueId: string | null;
    uransRequestId: string | null;
  },
>(
  target: ThreeStageUransCanaryTarget,
  requestId: string | null,
  verifyId: string | null,
  incidents: T[],
): T[] {
  return incidents.filter(
    (incident) =>
      incident.resultId === target.sourceResultId ||
      incident.precalcObligationId === target.precalcObligationId ||
      (requestId != null && incident.uransRequestId === requestId) ||
      (verifyId != null && incident.verifyQueueId === verifyId),
  );
}

export function productionThreeStageUransCanaryDependencies(
  db: DB,
  engine: EngineClient,
  rawSql: Sql,
): ThreeStageUransCanaryDependencies {
  return {
    async withLease(_marker, operation) {
      const reserved = await rawSql.reserve();
      const leaseKey = "airfoils-pro:three-stage-urans-canary-one-shot-v1";
      try {
        const rows = (await reserved`
          SELECT pg_try_advisory_lock(hashtextextended(${leaseKey}, 0)) AS acquired
        `) as unknown as Array<{ acquired: boolean }>;
        if (rows.length !== 1 || rows[0].acquired !== true)
          throw canaryError(
            "another three-stage canary invocation holds the operator lease",
          );
        try {
          return await operation();
        } finally {
          const released = (await reserved`
            SELECT pg_advisory_unlock(hashtextextended(${leaseKey}, 0)) AS released
          `) as unknown as Array<{ released: boolean }>;
          if (released.length !== 1 || released[0].released !== true)
            throw canaryError(
              "the operator advisory lease could not be released",
            );
        }
      } finally {
        reserved.release();
      }
    },
    async loadSnapshot(target, marker) {
      const [
        sweeperRows,
        campaignRows,
        conditionRows,
        campaignPointCount,
        parentRows,
        revisionRows,
        sourceResultRows,
        sourceAttemptRows,
        obligationRows,
        obligationOwners,
        obligationRequestOwners,
        obligationLiveSyncPromiseOwners,
        obligationAttemptCount,
        poolRows,
        otherEnabledPoolCount,
        matchingRuntimeBuildCount,
        markerRequests,
        overlappingOpenRequests,
        conflictingOpenVerifies,
        openCriticalIncidents,
        openJobs,
      ] = await Promise.all([
        db
          .select({
            enabled: sweeperState.enabled,
            maxConcurrentJobs: sweeperState.maxConcurrentJobs,
            cpuSlots: sweeperState.cpuSlots,
          })
          .from(sweeperState)
          .where(eq(sweeperState.id, 1))
          .limit(1),
        db
          .select({
            status: simCampaigns.status,
            generation: simCampaigns.currentConditionGeneration,
          })
          .from(simCampaigns)
          .where(eq(simCampaigns.id, target.campaignId))
          .limit(1),
        db
          .select({
            campaignId: simCampaignConditions.campaignId,
            generation: simCampaignConditions.generation,
            status: simCampaignConditions.status,
            revisionId: simCampaignConditions.simulationPresetRevisionId,
          })
          .from(simCampaignConditions)
          .where(eq(simCampaignConditions.id, target.conditionId))
          .limit(1),
        scalarCount(
          db
            .select({ n: count() })
            .from(simCampaignPoints)
            .where(
              and(
                eq(simCampaignPoints.campaignId, target.campaignId),
                eq(simCampaignPoints.conditionId, target.conditionId),
                eq(simCampaignPoints.airfoilId, target.airfoilId),
                eq(simCampaignPoints.revisionId, target.revisionId),
                eq(simCampaignPoints.aoaDeg, target.aoaDeg),
                eq(simCampaignPoints.derivedBySymmetry, false),
              ),
            ),
        ),
        db
          .select({
            campaignId: simJobs.campaignId,
            airfoilId: simJobs.airfoilId,
            revisionId: simJobs.simulationPresetRevisionId,
            methodKey: simJobs.methodKey,
            wave: simJobs.wave,
            status: simJobs.status,
            engineJobId: simJobs.engineJobId,
            solverImplementationId: simJobs.solverImplementationId,
            solverExecutionPoolId: simJobs.solverExecutionPoolId,
          })
          .from(simJobs)
          .where(eq(simJobs.id, target.parentJobId))
          .limit(1),
        db
          .select({
            solverImplementationId:
              simulationPresetRevisions.solverImplementationId,
          })
          .from(simulationPresetRevisions)
          .where(eq(simulationPresetRevisions.id, target.revisionId))
          .limit(1),
        db
          .select({
            airfoilId: results.airfoilId,
            revisionId: results.simulationPresetRevisionId,
            aoaDeg: results.aoaDeg,
            currentResultAttemptId: results.currentResultAttemptId,
            status: results.status,
            source: results.source,
            regime: results.regime,
            methodKey: results.methodKey,
            fidelity: results.fidelity,
            classificationState: resultClassifications.state,
            classificationRegime: resultClassifications.regime,
            solverImplementationId: results.solverImplementationId,
            solverRuntimeBuildId: results.solverRuntimeBuildId,
            solverRuntimeBuildLabel: solverRuntimeBuilds.buildId,
          })
          .from(results)
          .leftJoin(
            resultClassifications,
            eq(resultClassifications.resultId, results.id),
          )
          .leftJoin(
            solverRuntimeBuilds,
            eq(solverRuntimeBuilds.id, results.solverRuntimeBuildId),
          )
          .where(eq(results.id, target.sourceResultId))
          .limit(1),
        db
          .select({
            resultId: resultAttempts.resultId,
            simJobId: resultAttempts.simJobId,
            airfoilId: resultAttempts.airfoilId,
            revisionId: resultAttempts.simulationPresetRevisionId,
            aoaDeg: resultAttempts.aoaDeg,
            status: resultAttempts.status,
            source: resultAttempts.source,
            regime: resultAttempts.regime,
            methodKey: resultAttempts.methodKey,
            classificationState: resultClassifications.state,
            failureDisposition: sql<
              string | null
            >`${resultAttempts.evidencePayload} ->> 'failure_disposition'`,
            error: resultAttempts.error,
            isLatestForParentGeneration: sql<boolean>`NOT EXISTS (
              SELECT 1
              FROM result_attempts newer_attempt
              WHERE newer_attempt.result_id = ${resultAttempts.resultId}
                AND newer_attempt.sim_job_id
                      IS NOT DISTINCT FROM ${resultAttempts.simJobId}
                AND (
                  newer_attempt."createdAt" > ${resultAttempts.createdAt}
                  OR (
                    newer_attempt."createdAt" = ${resultAttempts.createdAt}
                    AND newer_attempt.id > ${resultAttempts.id}
                  )
                )
            )`,
          })
          .from(resultAttempts)
          .leftJoin(
            resultClassifications,
            eq(resultClassifications.resultAttemptId, resultAttempts.id),
          )
          .where(eq(resultAttempts.id, target.sourceResultAttemptId))
          .limit(1),
        db
          .select({
            airfoilId: simPrecalcObligations.airfoilId,
            revisionId: simPrecalcObligations.revisionId,
            aoaDeg: simPrecalcObligations.aoaDeg,
            sourceResultId: simPrecalcObligations.sourceResultId,
            sourceResultAttemptId: simPrecalcObligations.sourceResultAttemptId,
            state: simPrecalcObligations.state,
            attemptCount: simPrecalcObligations.attemptCount,
            submitFailureCount: simPrecalcObligations.submitFailureCount,
            continuationSegmentCount:
              simPrecalcObligations.continuationSegmentCount,
            continuationNoProgressCount:
              simPrecalcObligations.continuationNoProgressCount,
            latestSimJobId: simPrecalcObligations.latestSimJobId,
            lastOutcome: simPrecalcObligations.lastOutcome,
            lastError: simPrecalcObligations.lastError,
            nextSubmitAt: simPrecalcObligations.nextSubmitAt,
            completedAt: simPrecalcObligations.completedAt,
            backgroundOwner: simPrecalcObligations.backgroundOwner,
          })
          .from(simPrecalcObligations)
          .where(eq(simPrecalcObligations.id, target.precalcObligationId))
          .limit(1),
        db
          .select({ campaignId: simPrecalcObligationCampaigns.campaignId })
          .from(simPrecalcObligationCampaigns)
          .where(
            and(
              eq(
                simPrecalcObligationCampaigns.obligationId,
                target.precalcObligationId,
              ),
              eq(simPrecalcObligationCampaigns.state, "active"),
            ),
          )
          .orderBy(asc(simPrecalcObligationCampaigns.campaignId)),
        db
          .select({ requestId: simPrecalcObligationRequests.requestId })
          .from(simPrecalcObligationRequests)
          .where(
            eq(
              simPrecalcObligationRequests.obligationId,
              target.precalcObligationId,
            ),
          )
          .orderBy(asc(simPrecalcObligationRequests.requestId)),
        db
          .selectDistinct({ promiseId: syncSweepPromises.id })
          .from(syncSweepPromises)
          .innerJoin(
            syncSweepPromisePoints,
            eq(syncSweepPromisePoints.promiseId, syncSweepPromises.id),
          )
          .where(
            and(
              eq(syncSweepPromises.status, "active"),
              sql`${syncSweepPromises.expiresAt} > now()`,
              sql`${syncSweepPromises.requestPayload} ->> 'remoteSolver' = 'true'`,
              eq(syncSweepPromisePoints.status, "active"),
              eq(syncSweepPromisePoints.airfoilId, target.airfoilId),
              eq(
                syncSweepPromisePoints.simulationPresetRevisionId,
                target.revisionId,
              ),
              eq(syncSweepPromisePoints.aoaDeg, target.aoaDeg),
            ),
          )
          .orderBy(asc(syncSweepPromises.id)),
        scalarCount(
          db
            .select({ n: count() })
            .from(simPrecalcObligationAttempts)
            .where(
              eq(
                simPrecalcObligationAttempts.obligationId,
                target.precalcObligationId,
              ),
            ),
        ),
        db
          .select({
            id: solverExecutionPools.id,
            solverImplementationId: solverExecutionPools.solverImplementationId,
            routingKey: solverExecutionPools.routingKey,
            enabled: solverExecutionPools.enabled,
          })
          .from(solverExecutionPools)
          .where(eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID))
          .limit(1),
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
        scalarCount(
          db
            .select({ n: count() })
            .from(solverRuntimeBuilds)
            .where(
              and(
                eq(
                  solverRuntimeBuilds.solverImplementationId,
                  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
                ),
                eq(solverRuntimeBuilds.buildId, target.expectedEngineBuildId),
              ),
            ),
        ),
        db
          .select({
            id: simUransRequests.id,
            airfoilId: simUransRequests.airfoilId,
            revisionId: simUransRequests.revisionId,
            aoaDeg: simUransRequests.aoaDeg,
            fidelity: simUransRequests.fidelity,
            state: simUransRequests.state,
            simJobId: simUransRequests.simJobId,
            requestedBy: simUransRequests.requestedBy,
            backgroundOwner: simUransRequests.backgroundOwner,
            continueFromResultId: simUransRequests.continueFromResultId,
          })
          .from(simUransRequests)
          .where(eq(simUransRequests.requestedBy, marker))
          .orderBy(asc(simUransRequests.createdAt)),
        db
          .select({ id: simUransRequests.id })
          .from(simUransRequests)
          .where(
            and(
              eq(simUransRequests.airfoilId, target.airfoilId),
              eq(simUransRequests.revisionId, target.revisionId),
              inArray(simUransRequests.state, ["pending", "running"]),
              or(
                isNull(simUransRequests.aoaDeg),
                eq(simUransRequests.aoaDeg, target.aoaDeg),
              ),
            ),
          )
          .orderBy(asc(simUransRequests.createdAt)),
        db
          .select({ id: simUransVerifyQueue.id })
          .from(simUransVerifyQueue)
          .where(
            and(
              eq(simUransVerifyQueue.airfoilId, target.airfoilId),
              eq(simUransVerifyQueue.revisionId, target.revisionId),
              eq(simUransVerifyQueue.aoaDeg, target.aoaDeg),
              inArray(simUransVerifyQueue.state, [...OPEN_VERIFY_STATES]),
            ),
          )
          .orderBy(asc(simUransVerifyQueue.createdAt)),
        db
          .select({
            id: simSolverIncidents.id,
            stage: simSolverIncidents.stage,
            reason: simSolverIncidents.reason,
            remediationVersion: simSolverIncidents.remediationVersion,
            solverImplementationId: simSolverIncidents.solverImplementationId,
            resultId: simSolverIncidents.resultId,
            precalcObligationId: simSolverIncidents.precalcObligationId,
            verifyQueueId: simSolverIncidents.verifyQueueId,
            uransRequestId: simSolverIncidents.uransRequestId,
          })
          .from(simSolverIncidents)
          .where(
            and(
              eq(simSolverIncidents.status, "open"),
              eq(simSolverIncidents.severity, "critical"),
            ),
          ),
        db
          .select({
            id: simJobs.id,
            campaignId: simJobs.campaignId,
            parentJobId: simJobs.parentJobId,
            airfoilId: simJobs.airfoilId,
            revisionId: simJobs.simulationPresetRevisionId,
            methodKey: simJobs.methodKey,
            jobKind: simJobs.jobKind,
            wave: simJobs.wave,
            status: simJobs.status,
            engineState: simJobs.engineState,
            engineJobId: simJobs.engineJobId,
            solverImplementationId: simJobs.solverImplementationId,
            solverExecutionPoolId: simJobs.solverExecutionPoolId,
            solverRuntimeBuildId: simJobs.solverRuntimeBuildId,
            solverRuntimeBuildLabel: solverRuntimeBuilds.buildId,
            requestPayload: simJobs.requestPayload,
          })
          .from(simJobs)
          .leftJoin(
            solverRuntimeBuilds,
            eq(solverRuntimeBuilds.id, simJobs.solverRuntimeBuildId),
          )
          .where(inArray(simJobs.status, [...OPEN_JOB_STATUSES]))
          .orderBy(asc(simJobs.createdAt)),
      ]);

      const request = markerRequests[0] ?? null;
      const [requestOwners, requestCoverage, verifyRows] = request
        ? await Promise.all([
            db
              .select({ campaignId: simUransRequestCampaigns.campaignId })
              .from(simUransRequestCampaigns)
              .where(
                and(
                  eq(simUransRequestCampaigns.requestId, request.id),
                  eq(simUransRequestCampaigns.state, "active"),
                ),
              )
              .orderBy(asc(simUransRequestCampaigns.campaignId)),
            db
              .select({
                obligationId: simPrecalcObligationRequests.obligationId,
              })
              .from(simPrecalcObligationRequests)
              .where(eq(simPrecalcObligationRequests.requestId, request.id))
              .orderBy(asc(simPrecalcObligationRequests.obligationId)),
            db
              .select({
                id: simUransVerifyQueue.id,
                airfoilId: simUransVerifyQueue.airfoilId,
                revisionId: simUransVerifyQueue.revisionId,
                aoaDeg: simUransVerifyQueue.aoaDeg,
                backgroundOwner: simUransVerifyQueue.backgroundOwner,
                state: simUransVerifyQueue.state,
                simJobId: simUransVerifyQueue.simJobId,
                precalcResultId: simUransVerifyQueue.precalcResultId,
                verifyResultId: simUransVerifyQueue.verifyResultId,
                precalcResultAttemptId:
                  simUransVerifyQueue.precalcResultAttemptId,
                latestResultAttemptId:
                  simUransVerifyQueue.latestResultAttemptId,
                freshAttemptCount: simUransVerifyQueue.freshAttemptCount,
                maxFreshAttempts: simUransVerifyQueue.maxFreshAttempts,
                continuationAttemptCount:
                  simUransVerifyQueue.continuationAttemptCount,
                continuationNoProgressCount:
                  simUransVerifyQueue.continuationNoProgressCount,
                lastOutcome: simUransVerifyQueue.lastOutcome,
                lastError: simUransVerifyQueue.lastError,
                nextSubmitAt: simUransVerifyQueue.nextSubmitAt,
              })
              .from(simUransVerifyQueueRequests)
              .innerJoin(
                simUransVerifyQueue,
                eq(simUransVerifyQueue.id, simUransVerifyQueueRequests.queueId),
              )
              .where(eq(simUransVerifyQueueRequests.requestId, request.id))
              .orderBy(asc(simUransVerifyQueue.createdAt)),
          ])
        : [[], [], []];
      const verify = verifyRows[0] ?? null;
      const [
        verifyOwners,
        verifyRequestOwners,
        verifyPrecalcAttemptRows,
        verifyLatestAttemptRows,
      ] = verify
        ? await Promise.all([
            db
              .select({ campaignId: simUransVerifyQueueCampaigns.campaignId })
              .from(simUransVerifyQueueCampaigns)
              .where(
                and(
                  eq(simUransVerifyQueueCampaigns.queueId, verify.id),
                  eq(simUransVerifyQueueCampaigns.state, "active"),
                ),
              )
              .orderBy(asc(simUransVerifyQueueCampaigns.campaignId)),
            db
              .select({ requestId: simUransVerifyQueueRequests.requestId })
              .from(simUransVerifyQueueRequests)
              .where(eq(simUransVerifyQueueRequests.queueId, verify.id))
              .orderBy(asc(simUransVerifyQueueRequests.requestId)),
            verify.precalcResultAttemptId
              ? db
                  .select({
                    id: resultAttempts.id,
                    resultId: resultAttempts.resultId,
                    airfoilId: resultAttempts.airfoilId,
                    revisionId: resultAttempts.simulationPresetRevisionId,
                    aoaDeg: resultAttempts.aoaDeg,
                    status: resultAttempts.status,
                    source: resultAttempts.source,
                    regime: resultAttempts.regime,
                    methodKey: resultAttempts.methodKey,
                    fidelity: sql<
                      string | null
                    >`${resultAttempts.evidencePayload} ->> 'fidelity'`,
                    classificationState: resultClassifications.state,
                    supersededByResultId:
                      resultClassifications.supersededByResultId,
                    precalcObligationId:
                      simPrecalcObligationAttempts.obligationId,
                  })
                  .from(resultAttempts)
                  .leftJoin(
                    resultClassifications,
                    eq(
                      resultClassifications.resultAttemptId,
                      resultAttempts.id,
                    ),
                  )
                  .leftJoin(
                    simPrecalcObligationAttempts,
                    and(
                      eq(
                        simPrecalcObligationAttempts.resultAttemptId,
                        resultAttempts.id,
                      ),
                      eq(
                        simPrecalcObligationAttempts.obligationId,
                        target.precalcObligationId,
                      ),
                    ),
                  )
                  .where(eq(resultAttempts.id, verify.precalcResultAttemptId))
                  .limit(1)
              : Promise.resolve([]),
            verify.latestResultAttemptId
              ? db
                  .select({
                    id: resultAttempts.id,
                    resultId: resultAttempts.resultId,
                    simJobId: resultAttempts.simJobId,
                    airfoilId: resultAttempts.airfoilId,
                    revisionId: resultAttempts.simulationPresetRevisionId,
                    aoaDeg: resultAttempts.aoaDeg,
                    status: resultAttempts.status,
                    source: resultAttempts.source,
                    regime: resultAttempts.regime,
                    methodKey: resultAttempts.methodKey,
                    fidelity: sql<
                      string | null
                    >`${resultAttempts.evidencePayload} ->> 'fidelity'`,
                    classificationState: resultClassifications.state,
                    solverImplementationId:
                      resultAttempts.solverImplementationId,
                    solverRuntimeBuildId: resultAttempts.solverRuntimeBuildId,
                    solverRuntimeBuildLabel: solverRuntimeBuilds.buildId,
                  })
                  .from(resultAttempts)
                  .leftJoin(
                    resultClassifications,
                    eq(
                      resultClassifications.resultAttemptId,
                      resultAttempts.id,
                    ),
                  )
                  .leftJoin(
                    solverRuntimeBuilds,
                    eq(
                      solverRuntimeBuilds.id,
                      resultAttempts.solverRuntimeBuildId,
                    ),
                  )
                  .where(eq(resultAttempts.id, verify.latestResultAttemptId))
                  .limit(1)
              : Promise.resolve([]),
          ])
        : [[], [], [], []];
      const targetCriticalIncidents = targetOpenCriticalIncidents(
        target,
        request?.id ?? null,
        verify?.id ?? null,
        openCriticalIncidents,
      );
      const targetOpenCriticalIncidentCount = targetCriticalIncidents.length;
      const targetOpenCriticalIncident =
        targetCriticalIncidents.length === 1
          ? {
              id: targetCriticalIncidents[0].id,
              stage: targetCriticalIncidents[0].stage,
              reason: targetCriticalIncidents[0].reason,
              remediationVersion: targetCriticalIncidents[0].remediationVersion,
              solverImplementationId:
                targetCriticalIncidents[0].solverImplementationId,
              resultId: targetCriticalIncidents[0].resultId,
              precalcObligationId:
                targetCriticalIncidents[0].precalcObligationId,
              verifyQueueId: targetCriticalIncidents[0].verifyQueueId,
              uransRequestId: targetCriticalIncidents[0].uransRequestId,
            }
          : null;

      return {
        sweeperEnabled: sweeperRows[0]?.enabled ?? null,
        maxConcurrentJobs: sweeperRows[0]?.maxConcurrentJobs ?? -1,
        cpuSlots: sweeperRows[0]?.cpuSlots ?? 0,
        campaignStatus: campaignRows[0]?.status ?? null,
        campaignGeneration: campaignRows[0]?.generation ?? null,
        condition: conditionRows[0] ?? null,
        campaignPointCount,
        parent: parentRows[0] ?? null,
        revisionSolverImplementationId:
          revisionRows[0]?.solverImplementationId ?? null,
        sourceResult: sourceResultRows[0] ?? null,
        sourceAttempt: sourceAttemptRows[0] ?? null,
        obligation: obligationRows[0] ?? null,
        obligationOwnerCampaignIds: obligationOwners.map(
          (owner) => owner.campaignId,
        ),
        obligationRequestIds: obligationRequestOwners.map(
          (owner) => owner.requestId,
        ),
        obligationLiveSyncPromiseIds: obligationLiveSyncPromiseOwners.map(
          (owner) => owner.promiseId,
        ),
        obligationAttemptCount,
        pool: poolRows[0] ?? null,
        otherEnabledPoolCount,
        matchingRuntimeBuildCount,
        request,
        markerRequestCount: markerRequests.length,
        overlappingOpenRequestIds: overlappingOpenRequests.map((row) => row.id),
        requestOwnerCampaignIds: requestOwners.map((owner) => owner.campaignId),
        requestCoveredObligationIds: requestCoverage.map(
          (row) => row.obligationId,
        ),
        verify,
        verifyCount: verifyRows.length,
        verifyOwnerCampaignIds: verifyOwners.map((owner) => owner.campaignId),
        verifyRequestIds: verifyRequestOwners.map((owner) => owner.requestId),
        verifyPrecalcAttempt: verifyPrecalcAttemptRows[0] ?? null,
        verifyLatestAttempt: verifyLatestAttemptRows[0] ?? null,
        conflictingOpenVerifyIds: conflictingOpenVerifies
          .map((row) => row.id)
          .filter((id) => id !== verify?.id),
        targetOpenCriticalIncidentCount,
        targetOpenCriticalIncident,
        openJobs,
      };
    },

    async loadEnginePreflight() {
      const [health, capabilities, queue, disk] = await Promise.all([
        engine.healthDetails({ expectedEngine: OPENCFD_2606_ENGINE }),
        engine.capabilities({ expectedEngine: OPENCFD_2606_ENGINE }),
        engine.getQueue(),
        engine.maintenanceDisk(),
      ]);
      return { health, capabilities, queue, disk };
    },

    async ensureFullRequest(target, marker) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`urans-request:${target.airfoilId}:${target.revisionId}:full`},
              0
            )
          )
        `);
        const [campaign] = await tx
          .select({
            id: simCampaigns.id,
            status: simCampaigns.status,
            generation: simCampaigns.currentConditionGeneration,
          })
          .from(simCampaigns)
          .where(eq(simCampaigns.id, target.campaignId))
          .for("share")
          .limit(1);
        if (
          !campaign ||
          !new Set(["active", "attention"]).has(campaign.status) ||
          campaign.generation !== target.expectedCampaignGeneration
        )
          throw canaryError(
            "the exact campaign owner changed before request creation",
          );
        const [condition] = await tx
          .select({
            campaignId: simCampaignConditions.campaignId,
            generation: simCampaignConditions.generation,
            status: simCampaignConditions.status,
            revisionId: simCampaignConditions.simulationPresetRevisionId,
          })
          .from(simCampaignConditions)
          .where(eq(simCampaignConditions.id, target.conditionId))
          .for("share")
          .limit(1);
        if (
          !condition ||
          condition.campaignId !== target.campaignId ||
          condition.generation !== target.expectedCampaignGeneration ||
          !new Set(["active", "kept"]).has(condition.status) ||
          condition.revisionId !== target.revisionId
        ) {
          throw canaryError(
            "the exact campaign condition changed before request creation",
          );
        }
        const [campaignPoint] = await tx
          .select({ campaignId: simCampaignPoints.campaignId })
          .from(simCampaignPoints)
          .where(
            and(
              eq(simCampaignPoints.campaignId, target.campaignId),
              eq(simCampaignPoints.conditionId, target.conditionId),
              eq(simCampaignPoints.airfoilId, target.airfoilId),
              eq(simCampaignPoints.revisionId, target.revisionId),
              eq(simCampaignPoints.aoaDeg, target.aoaDeg),
              eq(simCampaignPoints.derivedBySymmetry, false),
            ),
          )
          .for("share")
          .limit(1);
        if (!campaignPoint)
          throw canaryError(
            "the exact campaign physical cell changed before request creation",
          );
        const existing = await tx
          .select({
            id: simUransRequests.id,
            requestedBy: simUransRequests.requestedBy,
            aoaDeg: simUransRequests.aoaDeg,
            backgroundOwner: simUransRequests.backgroundOwner,
          })
          .from(simUransRequests)
          .where(
            and(
              eq(simUransRequests.airfoilId, target.airfoilId),
              eq(simUransRequests.revisionId, target.revisionId),
              eq(simUransRequests.fidelity, "full"),
              inArray(simUransRequests.state, ["pending", "running"]),
              or(
                isNull(simUransRequests.aoaDeg),
                eq(simUransRequests.aoaDeg, target.aoaDeg),
              ),
            ),
          )
          .orderBy(asc(simUransRequests.createdAt))
          .for("update");
        if (existing.length) {
          if (
            existing.length !== 1 ||
            existing[0].requestedBy !== marker ||
            existing[0].aoaDeg == null ||
            !Object.is(existing[0].aoaDeg, target.aoaDeg) ||
            existing[0].backgroundOwner
          ) {
            throw canaryError(
              "unrelated open FULL work overlaps the exact cell",
            );
          }
          return existing[0].id;
        }
        const prior = await tx
          .select({ id: simUransRequests.id, state: simUransRequests.state })
          .from(simUransRequests)
          .where(eq(simUransRequests.requestedBy, marker))
          .orderBy(asc(simUransRequests.createdAt))
          .for("update");
        if (prior.length) {
          if (prior.length !== 1 || prior[0].state === "cancelled")
            throw canaryError(
              "the marked canary request is ambiguous or cancelled",
            );
          return prior[0].id;
        }
        const [created] = await tx
          .insert(simUransRequests)
          .values({
            airfoilId: target.airfoilId,
            revisionId: target.revisionId,
            aoaDeg: target.aoaDeg,
            fidelity: "full",
            state: "pending",
            backgroundOwner: false,
            requestedBy: marker,
          })
          .returning({ id: simUransRequests.id });
        await tx.insert(simUransRequestCampaigns).values({
          requestId: created.id,
          campaignId: target.campaignId,
          state: "active",
        });
        return created.id;
      });
    },

    async submitExactStep(input) {
      return submitExactUransCanaryStep(db, engine, input);
    },
  };
}
