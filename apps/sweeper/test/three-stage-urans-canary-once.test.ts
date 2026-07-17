import {
  OPENCFD_2606_EXECUTION_POOL_ID,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
  type DB,
} from "@aerodb/db";
import {
  OPENCFD_2606_ENGINE,
  type EngineClient,
  type EngineRuntimeIdentity,
} from "@aerodb/engine-client";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  THREE_STAGE_URANS_CANARY_USAGE,
  parseThreeStageUransCanaryArgs,
  withThreeStageCanaryLogsOnStderr,
} from "../src/three-stage-urans-canary-once-cli";
import {
  countTargetOpenCriticalIncidents,
  runThreeStageUransCanaryOnce,
  threeStageUransCanaryMarker,
  validateThreeStageUransCanarySnapshot,
  validateThreeStageUransEnginePreflight,
  type ThreeStageUransCanaryDependencies,
  type ThreeStageUransCanarySnapshot,
  type ThreeStageUransCanaryTarget,
  type ThreeStageUransEnginePreflight,
} from "../src/three-stage-urans-canary-once";
import { submitCampaignPrecalcRecoveries } from "../src/urans-ladder";

const target: ThreeStageUransCanaryTarget = {
  campaignId: "c24047fa-743f-4ae5-bcd6-f3071ff79fb4",
  conditionId: "e2db6c43-2e4a-4b15-b99e-1e2d391543be",
  expectedCampaignGeneration: 2,
  parentJobId: "28d9ac1c-ad4d-4c60-a34b-f090842eeb54",
  airfoilId: "2a965fd4-a85f-4434-833e-7b208423f705",
  revisionId: "c2e5a680-474c-4188-be90-bd0523a51961",
  aoaDeg: 11,
  sourceResultId: "fa5ec6aa-cbd4-4035-900d-3f2dd44a92bc",
  sourceResultAttemptId: "e59a73ff-c84a-473f-8f5e-1ce7ab5c7087",
  precalcObligationId: "a5d34ae1-4588-4780-a66a-f6683ca0e99c",
  expectedEngineBuildId: "prod-20260717-8e6d9bd32615-r6",
  expectedMeshRecoveryVersion: 2,
  expectedUransRecoveryVersion: 2,
};

const requestId = "47ba789e-e630-4df5-a8af-f52bb91737f8";
const verifyId = "6d87fb23-2c83-48a0-8658-447db7c67093";
const jobId = "46f658c5-900c-4d48-b6ed-274d3b3f88f8";
const incidentId = "28f64512-74a2-4ab8-811b-20a25660a7ce";
const finalAttemptId = "2e91fb46-7d79-4d2d-8fa3-55ab5fcc7edf";
const runtimeBuildId = "d9a9237f-a49e-4e18-9a9a-b3ee19a50b91";

function markCritical(
  snapshot: ThreeStageUransCanarySnapshot,
  stage: "preliminary" | "final",
): void {
  snapshot.targetOpenCriticalIncidentCount = 1;
  snapshot.targetOpenCriticalIncident = {
    id: incidentId,
    stage,
    reason: "recovery-budget-exhausted",
    remediationVersion: "urans-recovery-2026-07-16-v2",
    solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    resultId: null,
    precalcObligationId:
      stage === "preliminary" ? target.precalcObligationId : null,
    verifyQueueId: stage === "final" ? (snapshot.verify?.id ?? null) : null,
    uransRequestId:
      stage === "final" && !snapshot.verify
        ? (snapshot.request?.id ?? null)
        : null,
  };
}

function baseSnapshot(): ThreeStageUransCanarySnapshot {
  return {
    sweeperEnabled: false,
    maxConcurrentJobs: 0,
    cpuSlots: 0,
    campaignStatus: "active",
    campaignGeneration: target.expectedCampaignGeneration,
    condition: {
      campaignId: target.campaignId,
      generation: target.expectedCampaignGeneration,
      status: "active",
      revisionId: target.revisionId,
    },
    campaignPointCount: 1,
    parent: {
      campaignId: target.campaignId,
      airfoilId: target.airfoilId,
      revisionId: target.revisionId,
      methodKey: "openfoam.rans",
      wave: 1,
      status: "done",
      engineJobId: "engine-source-rans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverExecutionPoolId: OPENCFD_2606_EXECUTION_POOL_ID,
    },
    revisionSolverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    sourceResult: {
      airfoilId: target.airfoilId,
      revisionId: target.revisionId,
      aoaDeg: target.aoaDeg,
      currentResultAttemptId: target.sourceResultAttemptId,
      status: "done",
      source: "solved",
      regime: "rans",
      methodKey: "openfoam.rans",
      fidelity: "rans",
      classificationState: "rejected",
      classificationRegime: "rans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: null,
      solverRuntimeBuildLabel: null,
    },
    sourceAttempt: {
      resultId: target.sourceResultId,
      simJobId: target.parentJobId,
      airfoilId: target.airfoilId,
      revisionId: target.revisionId,
      aoaDeg: target.aoaDeg,
      status: "done",
      source: "solved",
      regime: "rans",
      methodKey: "openfoam.rans",
      classificationState: "rejected",
      failureDisposition: "hard_solver",
      error: "steady RANS did not converge",
      isLatestForParentGeneration: true,
    },
    obligation: {
      airfoilId: target.airfoilId,
      revisionId: target.revisionId,
      aoaDeg: target.aoaDeg,
      sourceResultId: target.sourceResultId,
      sourceResultAttemptId: target.sourceResultAttemptId,
      state: "pending",
      attemptCount: 0,
      submitFailureCount: 0,
      continuationSegmentCount: 0,
      continuationNoProgressCount: 0,
      latestSimJobId: null,
      lastOutcome: null,
      lastError: null,
      nextSubmitAt: null,
      completedAt: null,
      backgroundOwner: false,
    },
    obligationOwnerCampaignIds: [target.campaignId],
    obligationRequestIds: [],
    obligationLiveSyncPromiseIds: [],
    obligationAttemptCount: 0,
    pool: {
      id: OPENCFD_2606_EXECUTION_POOL_ID,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      routingKey: "openfoam-opencfd-2606",
      enabled: true,
    },
    otherEnabledPoolCount: 0,
    matchingRuntimeBuildCount: 0,
    request: null,
    markerRequestCount: 0,
    overlappingOpenRequestIds: [],
    requestOwnerCampaignIds: [],
    requestCoveredObligationIds: [],
    verify: null,
    verifyCount: 0,
    verifyOwnerCampaignIds: [],
    verifyRequestIds: [],
    verifyPrecalcAttempt: null,
    verifyLatestAttempt: null,
    conflictingOpenVerifyIds: [],
    targetOpenCriticalIncidentCount: 0,
    targetOpenCriticalIncident: null,
    openJobs: [],
  };
}

function withRequest(
  overrides: Partial<ThreeStageUransCanarySnapshot["request"]> = {},
): ThreeStageUransCanarySnapshot {
  const snapshot = baseSnapshot();
  snapshot.request = {
    id: requestId,
    airfoilId: target.airfoilId,
    revisionId: target.revisionId,
    aoaDeg: target.aoaDeg,
    fidelity: "full",
    state: "pending",
    simJobId: null,
    requestedBy: threeStageUransCanaryMarker(target),
    backgroundOwner: false,
    continueFromResultId: null,
    ...overrides,
  };
  snapshot.markerRequestCount = 1;
  snapshot.overlappingOpenRequestIds = OPEN_REQUEST_STATE(
    snapshot.request.state,
  )
    ? [requestId]
    : [];
  snapshot.requestOwnerCampaignIds = [target.campaignId];
  return snapshot;
}

function OPEN_REQUEST_STATE(state: string): boolean {
  return state === "pending" || state === "running";
}

function withVerify(state = "pending"): ThreeStageUransCanarySnapshot {
  const snapshot = withRequest({ state: "running" });
  snapshot.obligation = {
    ...snapshot.obligation!,
    state: "satisfied",
    attemptCount: 1,
    completedAt: new Date("2026-07-17T14:00:00Z"),
  };
  snapshot.obligationAttemptCount = 1;
  snapshot.requestCoveredObligationIds = [target.precalcObligationId];
  snapshot.obligationRequestIds = [requestId];
  snapshot.verify = {
    id: verifyId,
    airfoilId: target.airfoilId,
    revisionId: target.revisionId,
    aoaDeg: target.aoaDeg,
    backgroundOwner: false,
    state,
    simJobId: null,
    precalcResultId: target.sourceResultId,
    verifyResultId: null,
    precalcResultAttemptId: "a977346b-7014-4240-8f18-9ecba223e407",
    latestResultAttemptId: null,
    freshAttemptCount: 0,
    maxFreshAttempts: 2,
    continuationAttemptCount: 0,
    continuationNoProgressCount: 0,
    lastOutcome: null,
    lastError: null,
    nextSubmitAt: null,
  };
  snapshot.verifyCount = 1;
  // Request-owned verification inherits the exact campaign through
  // request→campaign ownership and normally has no direct campaign row.
  snapshot.verifyOwnerCampaignIds = [];
  snapshot.verifyRequestIds = [requestId];
  snapshot.verifyPrecalcAttempt = {
    id: snapshot.verify.precalcResultAttemptId!,
    resultId: target.sourceResultId,
    airfoilId: target.airfoilId,
    revisionId: target.revisionId,
    aoaDeg: target.aoaDeg,
    status: "done",
    source: "solved",
    regime: "urans",
    methodKey: "openfoam.urans",
    fidelity: "urans_precalc",
    classificationState: "accepted",
    supersededByResultId: null,
    precalcObligationId: target.precalcObligationId,
  };
  if (state === "done" || state === "disagreed") {
    snapshot.verify = {
      ...snapshot.verify,
      simJobId: jobId,
      verifyResultId: target.sourceResultId,
      latestResultAttemptId: finalAttemptId,
      freshAttemptCount: 1,
      lastOutcome: state,
    };
    snapshot.verifyPrecalcAttempt.classificationState = "superseded_by_urans";
    snapshot.verifyPrecalcAttempt.supersededByResultId = target.sourceResultId;
    snapshot.verifyLatestAttempt = {
      id: finalAttemptId,
      resultId: target.sourceResultId,
      simJobId: jobId,
      airfoilId: target.airfoilId,
      revisionId: target.revisionId,
      aoaDeg: target.aoaDeg,
      status: "done",
      source: "solved",
      regime: "urans",
      methodKey: "openfoam.urans",
      fidelity: "urans_full",
      classificationState: "accepted",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: runtimeBuildId,
      solverRuntimeBuildLabel: target.expectedEngineBuildId,
    };
    snapshot.sourceResult = {
      ...snapshot.sourceResult!,
      currentResultAttemptId: finalAttemptId,
      status: "done",
      source: "solved",
      regime: "urans",
      methodKey: "openfoam.urans",
      fidelity: "urans_full",
      classificationState: "accepted",
      classificationRegime: "urans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: runtimeBuildId,
      solverRuntimeBuildLabel: target.expectedEngineBuildId,
    };
  }
  // Accepted preliminary evidence becomes the obligation's canonical source
  // attempt during ingestion. The original RANS attempt remains pinned by the
  // canary target and immutable result history.
  snapshot.obligation = {
    ...snapshot.obligation!,
    sourceResultAttemptId: snapshot.verify.precalcResultAttemptId,
  };
  return snapshot;
}

function submittedSnapshot(fidelity: "precalc" | "full" = "precalc") {
  const snapshot =
    fidelity === "precalc"
      ? withRequest({ state: "running" })
      : withVerify("running");
  snapshot.requestCoveredObligationIds = [target.precalcObligationId];
  snapshot.obligationRequestIds = [requestId];
  if (fidelity === "precalc") {
    snapshot.request = { ...snapshot.request!, simJobId: jobId };
    snapshot.obligation = {
      ...snapshot.obligation!,
      state: "running",
      latestSimJobId: jobId,
    };
    snapshot.obligationAttemptCount = 1;
  } else {
    snapshot.verify = { ...snapshot.verify!, simJobId: jobId };
  }
  snapshot.openJobs = [
    {
      id: jobId,
      campaignId: null,
      parentJobId: null,
      airfoilId: target.airfoilId,
      revisionId: target.revisionId,
      methodKey: "openfoam.urans",
      jobKind: fidelity === "precalc" ? "targeted" : "verify",
      wave: 2,
      status: "submitted",
      engineState: "pending",
      engineJobId: "engine-canary-1",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverExecutionPoolId: OPENCFD_2606_EXECUTION_POOL_ID,
      solverRuntimeBuildId: null,
      solverRuntimeBuildLabel: null,
      requestPayload: {
        aoas: [target.aoaDeg],
        uransFidelity: fidelity,
        ...(fidelity === "precalc"
          ? { meshRecoveryVersion: target.expectedMeshRecoveryVersion }
          : { finalRecoveryMode: "fresh" }),
        ...(fidelity === "precalc"
          ? {
              uransRequestId: requestId,
              precalcObligationIds: [target.precalcObligationId],
            }
          : { verifyQueueItemId: verifyId }),
        ...(fidelity === "full"
          ? {
              verifyPrecalcResultAttemptId:
                snapshot.verify!.precalcResultAttemptId,
              finalRecoveryMode: "fresh",
            }
          : {}),
      },
    },
  ];
  // POST /polars truthfully returns an accepted `pending` job before the
  // worker publishes its immutable runtime identity. The first one-shot
  // receipt must preserve that acknowledged-pending state instead of
  // reporting a false refusal after the irreversible submission.
  snapshot.matchingRuntimeBuildCount = 0;
  return snapshot;
}

function runtime(): EngineRuntimeIdentity {
  return {
    ...OPENCFD_2606_ENGINE,
    build_id: target.expectedEngineBuildId,
    source_revision: "8e6d9bd326153438301244682d989ed922934e4f",
    application_source_sha256: "a".repeat(64),
    package_sha256: "b".repeat(64),
    architecture: "x86_64",
  };
}

function enginePreflight(): ThreeStageUransEnginePreflight {
  return {
    health: {
      status: "ok",
      role: "solver_gateway",
      version: "2606",
      build_id: target.expectedEngineBuildId,
      mesh_recovery_version: target.expectedMeshRecoveryVersion,
      urans_recovery_version: target.expectedUransRecoveryVersion,
      default_engine: OPENCFD_2606_ENGINE,
      supported_engines: [OPENCFD_2606_ENGINE],
      evidence_storage: {
        backend: "gcs",
        bucket: "airfoils-pro-storage-bucket",
        object_prefix: "solver-evidence/v1",
        archive_format: "tar+zstd",
        compression: "zstd",
        zstd_level: 10,
        remote_only: true,
      },
    },
    capabilities: {
      default_engine: OPENCFD_2606_ENGINE,
      supported_engines: [OPENCFD_2606_ENGINE],
      supports_continuation: true,
      engines: [
        {
          engine: OPENCFD_2606_ENGINE,
          routing_key: "openfoam-opencfd-2606",
          analysis_methods: ["rans", "urans"],
          steady: true,
          transient: true,
          volume_fields: true,
          mesh_evidence: true,
          stored_media: true,
          custom_field_rendering: true,
          multi_element_geometry: false,
          supported_turbulence_models: ["kOmegaSST"],
          supported_image_fields: ["pressure"],
        },
      ],
    },
    queue: {
      queue_depth: 0,
      queue_depths: { "openfoam-opencfd-2606": 0 },
      queue_enabled: { "openfoam-opencfd-2606": true },
      queues: [
        {
          routing_key: "openfoam-opencfd-2606",
          enabled: true,
          depth: 0,
          engine: OPENCFD_2606_ENGINE,
        },
      ],
      worker_queues: [
        {
          worker: "opencfd2606@worker",
          queues: ["openfoam-opencfd-2606"],
          execution_pool: "openfoam-opencfd-2606",
          engine: runtime(),
        },
      ],
      worker_queues_error: null,
      worker_runtime_error: null,
      inspection_errors: {},
      active: [],
      reserved: [],
      scheduled: [],
      active_count: 0,
      reserved_count: 0,
      scheduled_count: 0,
      job_ids: [],
      duplicates: {},
      redelivered: [],
    },
    disk: {
      total_bytes: 500 * 1024 ** 3,
      free_bytes: 400 * 1024 ** 3,
      used_pct: 20,
    },
  };
}

function dependencies(
  snapshots: ThreeStageUransCanarySnapshot[],
  submit = true,
): ThreeStageUransCanaryDependencies & {
  loadEnginePreflight: ReturnType<typeof vi.fn>;
  ensureFullRequest: ReturnType<typeof vi.fn>;
  submitExactStep: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  return {
    async withLease<T>(_marker: string, operation: () => Promise<T>) {
      return operation();
    },
    loadSnapshot: vi.fn(
      async () => snapshots[Math.min(index++, snapshots.length - 1)],
    ),
    loadEnginePreflight: vi.fn(async () => enginePreflight()),
    ensureFullRequest: vi.fn(async () => requestId),
    submitExactStep: vi.fn(async () => submit),
  };
}

describe("three-stage URANS one-shot canary", () => {
  it("creates one exact FULL owner and admits only its preliminary stage", async () => {
    const deps = dependencies([
      baseSnapshot(),
      withRequest(),
      withRequest(),
      submittedSnapshot("precalc"),
    ]);
    await expect(runThreeStageUransCanaryOnce(target, deps)).resolves.toEqual({
      action: "submitted",
      stage: "preliminary",
      campaignId: target.campaignId,
      conditionId: target.conditionId,
      parentJobId: target.parentJobId,
      airfoilId: target.airfoilId,
      revisionId: target.revisionId,
      aoaDeg: target.aoaDeg,
      sourceResultId: target.sourceResultId,
      sourceResultAttemptId: target.sourceResultAttemptId,
      precalcObligationId: target.precalcObligationId,
      requestId,
      verifyQueueId: null,
      simJobId: jobId,
      engineJobId: "engine-canary-1",
      requestState: "running",
      obligationState: "running",
      verifyState: null,
      criticalIncidentId: null,
      criticalIncidentStage: null,
      criticalIncidentReason: null,
      criticalRemediationVersion: null,
      expectedCampaignGeneration: target.expectedCampaignGeneration,
      expectedEngineBuildId: target.expectedEngineBuildId,
      expectedMeshRecoveryVersion: 2,
      expectedUransRecoveryVersion: 2,
    });
    expect(deps.ensureFullRequest).toHaveBeenCalledTimes(1);
    expect(deps.loadEnginePreflight).toHaveBeenCalledTimes(2);
    expect(deps.submitExactStep).toHaveBeenCalledTimes(1);
    expect(deps.submitExactStep).toHaveBeenCalledWith({
      requestId,
      verifyId: null,
      cpuSlots: 0,
      meshRecoveryVersion: 2,
      uransRecoveryVersion: 2,
    });
  });

  it("admits the exact linked final verification after preliminary evidence", async () => {
    const before = withVerify("pending");
    before.sourceAttempt!.classificationState = "superseded_by_urans";
    const after = submittedSnapshot("full");
    after.sourceAttempt!.classificationState = "superseded_by_urans";
    const deps = dependencies([before, before, after]);
    const result = await runThreeStageUransCanaryOnce(target, deps);
    expect(result).toMatchObject({
      action: "submitted",
      stage: "final",
      requestId,
      verifyQueueId: verifyId,
      simJobId: jobId,
    });
    expect(deps.ensureFullRequest).not.toHaveBeenCalled();
    expect(deps.submitExactStep).toHaveBeenCalledWith(
      expect.objectContaining({ requestId, verifyId }),
    );
  });

  it("is observe-only while its exact job is nonterminal", async () => {
    const deps = dependencies([submittedSnapshot("precalc")]);
    const result = await runThreeStageUransCanaryOnce(target, deps);
    expect(result).toMatchObject({ action: "observed", simJobId: jobId });
    expect(deps.loadEnginePreflight).not.toHaveBeenCalled();
    expect(deps.ensureFullRequest).not.toHaveBeenCalled();
    expect(deps.submitExactStep).not.toHaveBeenCalled();
  });

  it("accepts only the exact pending-to-runtime-acknowledged transition", () => {
    const marker = threeStageUransCanaryMarker(target);
    const pending = submittedSnapshot("precalc");
    expect(() =>
      validateThreeStageUransCanarySnapshot(target, marker, pending),
    ).not.toThrow();
    const pendingWithPreviouslyKnownBuild = structuredClone(pending);
    pendingWithPreviouslyKnownBuild.matchingRuntimeBuildCount = 1;
    expect(() =>
      validateThreeStageUransCanarySnapshot(
        target,
        marker,
        pendingWithPreviouslyKnownBuild,
      ),
    ).not.toThrow();

    const acknowledged = submittedSnapshot("precalc");
    acknowledged.matchingRuntimeBuildCount = 1;
    acknowledged.openJobs[0] = {
      ...acknowledged.openJobs[0],
      status: "running",
      engineState: "running",
      solverRuntimeBuildId: crypto.randomUUID(),
      solverRuntimeBuildLabel: target.expectedEngineBuildId,
    };
    expect(() =>
      validateThreeStageUransCanarySnapshot(target, marker, acknowledged),
    ).not.toThrow();

    const invalid = [
      {
        label: "missing runtime after pending",
        mutate(snapshot: ThreeStageUransCanarySnapshot) {
          snapshot.openJobs[0] = {
            ...snapshot.openJobs[0],
            status: "running",
            engineState: "running",
          };
        },
      },
      {
        label: "pending submission without engine acknowledgement",
        mutate(snapshot: ThreeStageUransCanarySnapshot) {
          snapshot.openJobs[0] = {
            ...snapshot.openJobs[0],
            engineJobId: null,
          };
        },
      },
      {
        label: "runtime acknowledgement without its registry row",
        mutate(snapshot: ThreeStageUransCanarySnapshot) {
          snapshot.openJobs[0] = {
            ...snapshot.openJobs[0],
            solverRuntimeBuildId: crypto.randomUUID(),
            solverRuntimeBuildLabel: target.expectedEngineBuildId,
          };
        },
      },
      {
        label: "runtime acknowledgement for another build",
        mutate(snapshot: ThreeStageUransCanarySnapshot) {
          snapshot.matchingRuntimeBuildCount = 1;
          snapshot.openJobs[0] = {
            ...snapshot.openJobs[0],
            solverRuntimeBuildId: crypto.randomUUID(),
            solverRuntimeBuildLabel: "another-build",
          };
        },
      },
    ];
    for (const { label, mutate } of invalid) {
      const snapshot = submittedSnapshot("precalc");
      mutate(snapshot);
      expect(
        () => validateThreeStageUransCanarySnapshot(target, marker, snapshot),
        label,
      ).toThrow("three-stage URANS canary refused");
    }
  });

  it("returns terminal receipts without reopening completed or critical work", async () => {
    const completed = withVerify("done");
    completed.request = { ...completed.request!, state: "done" };
    completed.overlappingOpenRequestIds = [];
    const completedDeps = dependencies([completed]);
    await expect(
      runThreeStageUransCanaryOnce(target, completedDeps),
    ).resolves.toMatchObject({ action: "completed", stage: "complete" });
    expect(completedDeps.submitExactStep).not.toHaveBeenCalled();

    const critical = withVerify("blocked");
    markCritical(critical, "final");
    const criticalDeps = dependencies([critical]);
    await expect(
      runThreeStageUransCanaryOnce(target, criticalDeps),
    ).resolves.toMatchObject({
      action: "critical",
      stage: "critical",
      criticalIncidentId: incidentId,
      criticalIncidentStage: "final",
      criticalIncidentReason: "recovery-budget-exhausted",
      criticalRemediationVersion: "urans-recovery-2026-07-16-v2",
    });
    expect(criticalDeps.submitExactStep).not.toHaveBeenCalled();

    const preliminaryCritical = baseSnapshot();
    preliminaryCritical.obligation = {
      ...preliminaryCritical.obligation!,
      state: "blocked",
      lastOutcome: "recovery_budget_exhausted",
      lastError: "preliminary recovery exhausted",
    };
    markCritical(preliminaryCritical, "preliminary");
    const preliminaryCriticalDeps = dependencies([preliminaryCritical]);
    await expect(
      runThreeStageUransCanaryOnce(target, preliminaryCriticalDeps),
    ).resolves.toMatchObject({ action: "critical", stage: "critical" });
    expect(preliminaryCriticalDeps.submitExactStep).not.toHaveBeenCalled();
  });

  it("binds terminal completion to the superseded preliminary and exact accepted final generation", () => {
    const marker = threeStageUransCanaryMarker(target);
    const completed = withVerify("disagreed");
    completed.request = { ...completed.request!, state: "done" };
    completed.overlappingOpenRequestIds = [];
    expect(() =>
      validateThreeStageUransCanarySnapshot(target, marker, completed),
    ).not.toThrow();

    const noSheddingPreliminary = withVerify("pending");
    noSheddingPreliminary.verifyPrecalcAttempt!.regime = "rans";
    expect(() =>
      validateThreeStageUransCanarySnapshot(
        target,
        marker,
        noSheddingPreliminary,
      ),
    ).not.toThrow();

    const noSheddingTerminal = withVerify("done");
    noSheddingTerminal.request = {
      ...noSheddingTerminal.request!,
      state: "done",
    };
    noSheddingTerminal.overlappingOpenRequestIds = [];
    noSheddingTerminal.verifyPrecalcAttempt!.regime = "rans";
    noSheddingTerminal.verifyLatestAttempt!.regime = "rans";
    noSheddingTerminal.sourceResult!.regime = "rans";
    noSheddingTerminal.sourceResult!.classificationRegime = "rans";
    expect(() =>
      validateThreeStageUransCanarySnapshot(target, marker, noSheddingTerminal),
    ).not.toThrow();

    const invalid: Array<{
      label: string;
      mutate(snapshot: ThreeStageUransCanarySnapshot): void;
    }> = [
      {
        label: "preliminary was not superseded",
        mutate(snapshot) {
          snapshot.verifyPrecalcAttempt!.classificationState = "accepted";
        },
      },
      {
        label: "preliminary was superseded by another result",
        mutate(snapshot) {
          snapshot.verifyPrecalcAttempt!.supersededByResultId =
            crypto.randomUUID();
        },
      },
      {
        label: "missing accepted final attempt",
        mutate(snapshot) {
          snapshot.verifyLatestAttempt = null;
        },
      },
      {
        label: "final pointer changed",
        mutate(snapshot) {
          snapshot.verify!.latestResultAttemptId = crypto.randomUUID();
        },
      },
      {
        label: "final attempt is not accepted",
        mutate(snapshot) {
          snapshot.verifyLatestAttempt!.classificationState = "rejected";
        },
      },
      {
        label: "terminal verification has no physical job",
        mutate(snapshot) {
          snapshot.verify!.simJobId = null;
          snapshot.verifyLatestAttempt!.simJobId = null;
        },
      },
      {
        label: "final attempt came from another runtime",
        mutate(snapshot) {
          snapshot.verifyLatestAttempt!.solverRuntimeBuildLabel =
            "unexpected-build";
        },
      },
      {
        label: "final attempt has an impossible physical regime",
        mutate(snapshot) {
          snapshot.verifyLatestAttempt!.regime = "xfoil";
        },
      },
      {
        label: "canonical result regime differs from its final attempt",
        mutate(snapshot) {
          snapshot.sourceResult!.regime = "rans";
        },
      },
      {
        label: "canonical classification regime differs from final evidence",
        mutate(snapshot) {
          snapshot.sourceResult!.classificationRegime = "rans";
        },
      },
      {
        label: "final result identity changed",
        mutate(snapshot) {
          snapshot.verify!.verifyResultId = crypto.randomUUID();
        },
      },
      {
        label: "canonical result still publishes an older generation",
        mutate(snapshot) {
          snapshot.sourceResult!.currentResultAttemptId =
            target.sourceResultAttemptId;
        },
      },
      {
        label: "canonical result classification is not accepted",
        mutate(snapshot) {
          snapshot.sourceResult!.classificationState = "rejected";
        },
      },
    ];
    for (const { label, mutate } of invalid) {
      const snapshot = structuredClone(completed);
      mutate(snapshot);
      expect(
        () => validateThreeStageUransCanarySnapshot(target, marker, snapshot),
        label,
      ).toThrow("three-stage URANS canary refused");
    }

    const prematureSupersession = withVerify("pending");
    prematureSupersession.verifyPrecalcAttempt!.classificationState =
      "superseded_by_urans";
    expect(() =>
      validateThreeStageUransCanarySnapshot(
        target,
        marker,
        prematureSupersession,
      ),
    ).toThrow("does not pin the expected preliminary evidence lifecycle");

    const impossiblePreliminaryRegime = withVerify("pending");
    impossiblePreliminaryRegime.verifyPrecalcAttempt!.regime = "xfoil";
    expect(() =>
      validateThreeStageUransCanarySnapshot(
        target,
        marker,
        impossiblePreliminaryRegime,
      ),
    ).toThrow("does not pin the expected preliminary evidence lifecycle");
  });

  it("reports a scoped no-op without claiming a second item", async () => {
    const pending = withRequest();
    const deps = dependencies([pending, pending, pending], false);
    await expect(
      runThreeStageUransCanaryOnce(target, deps),
    ).resolves.toMatchObject({
      action: "no-op",
      requestId,
    });
    expect(deps.submitExactStep).toHaveBeenCalledTimes(1);
  });

  it("reports a terminal state reached during the exact submission attempt", async () => {
    const pending = withRequest();
    const critical = withRequest({ state: "blocked" });
    critical.obligation = {
      ...critical.obligation!,
      state: "blocked",
      lastOutcome: "recovery_budget_exhausted",
      lastError: "preliminary recovery exhausted",
    };
    markCritical(critical, "preliminary");
    const criticalDeps = dependencies([pending, pending, critical], false);
    await expect(
      runThreeStageUransCanaryOnce(target, criticalDeps),
    ).resolves.toMatchObject({ action: "critical", stage: "critical" });

    const completed = withVerify("done");
    completed.request = { ...completed.request!, state: "done" };
    completed.overlappingOpenRequestIds = [];
    const finalPending = withVerify("pending");
    const completedDeps = dependencies(
      [finalPending, finalPending, completed],
      false,
    );
    await expect(
      runThreeStageUransCanaryOnce(target, completedDeps),
    ).resolves.toMatchObject({ action: "completed", stage: "complete" });
  });

  it.each([
    [
      "enabled switch",
      (s: ThreeStageUransCanarySnapshot) => (s.sweeperEnabled = true),
    ],
    [
      "nonzero durable job capacity",
      (s: ThreeStageUransCanarySnapshot) => (s.maxConcurrentJobs = 1),
    ],
    [
      "nonzero durable CPU capacity",
      (s: ThreeStageUransCanarySnapshot) => (s.cpuSlots = 1),
    ],
    [
      "missing campaign point",
      (s: ThreeStageUransCanarySnapshot) => (s.campaignPointCount = 0),
    ],
    [
      "wrong campaign generation",
      (s: ThreeStageUransCanarySnapshot) => s.campaignGeneration!++,
    ],
    [
      "wrong condition generation",
      (s: ThreeStageUransCanarySnapshot) =>
        (s.condition!.generation = target.expectedCampaignGeneration + 1),
    ],
    [
      "target-owned critical incident without a blocked owner",
      (s: ThreeStageUransCanarySnapshot) => markCritical(s, "preliminary"),
    ],
    [
      "conflicting open verification",
      (s: ThreeStageUransCanarySnapshot) =>
        s.conflictingOpenVerifyIds.push(crypto.randomUUID()),
    ],
    [
      "running RANS parent",
      (s: ThreeStageUransCanarySnapshot) => (s.parent!.status = "running"),
    ],
    [
      "wrong source attempt",
      (s: ThreeStageUransCanarySnapshot) =>
        (s.sourceAttempt!.simJobId = crypto.randomUUID()),
    ],
    [
      "accepted source RANS",
      (s: ThreeStageUransCanarySnapshot) =>
        (s.sourceAttempt!.classificationState = "accepted"),
    ],
    [
      "deterministic-mesh source RANS",
      (s: ThreeStageUransCanarySnapshot) =>
        (s.sourceAttempt!.failureDisposition = "deterministic_mesh"),
    ],
    [
      "infrastructure source RANS",
      (s: ThreeStageUransCanarySnapshot) =>
        (s.sourceAttempt!.failureDisposition = "infrastructure"),
    ],
    [
      "stale source RANS generation",
      (s: ThreeStageUransCanarySnapshot) =>
        (s.sourceAttempt!.isLatestForParentGeneration = false),
    ],
    [
      "already superseded source RANS",
      (s: ThreeStageUransCanarySnapshot) =>
        (s.sourceAttempt!.classificationState = "superseded_by_urans"),
    ],
    [
      "shared obligation owner",
      (s: ThreeStageUransCanarySnapshot) =>
        s.obligationOwnerCampaignIds.push(crypto.randomUUID()),
    ],
    [
      "background obligation owner",
      (s: ThreeStageUransCanarySnapshot) =>
        (s.obligation!.backgroundOwner = true),
    ],
    [
      "remote-promise obligation owner",
      (s: ThreeStageUransCanarySnapshot) =>
        s.obligationLiveSyncPromiseIds.push(crypto.randomUUID()),
    ],
    [
      "pre-existing FULL request coverage",
      (s: ThreeStageUransCanarySnapshot) =>
        s.obligationRequestIds.push(crypto.randomUUID()),
    ],
    [
      "another enabled pool",
      (s: ThreeStageUransCanarySnapshot) => (s.otherEnabledPoolCount = 1),
    ],
    [
      "ambiguous runtime build",
      (s: ThreeStageUransCanarySnapshot) => (s.matchingRuntimeBuildCount = 2),
    ],
    [
      "spent unowned obligation",
      (s: ThreeStageUransCanarySnapshot) => (s.obligation!.attemptCount = 1),
    ],
  ])("refuses %s before creating any canary owner", async (_name, mutate) => {
    const snapshot = baseSnapshot();
    mutate(snapshot);
    const deps = dependencies([snapshot]);
    await expect(runThreeStageUransCanaryOnce(target, deps)).rejects.toThrow(
      "three-stage URANS canary refused",
    );
    expect(deps.loadEnginePreflight).not.toHaveBeenCalled();
    expect(deps.ensureFullRequest).not.toHaveBeenCalled();
    expect(deps.submitExactStep).not.toHaveBeenCalled();
  });

  it("does not inspect or mutate state when the operator lease is unavailable", async () => {
    const deps = dependencies([baseSnapshot()]);
    deps.withLease = async () => {
      throw new Error("operator lease unavailable");
    };
    await expect(runThreeStageUransCanaryOnce(target, deps)).rejects.toThrow(
      "operator lease unavailable",
    );
    expect(deps.loadSnapshot).not.toHaveBeenCalled();
    expect(deps.ensureFullRequest).not.toHaveBeenCalled();
    expect(deps.submitExactStep).not.toHaveBeenCalled();
  });

  it("ignores unrelated legacy critical incidents and counts exact-chain owners", () => {
    const unrelated = {
      resultId: crypto.randomUUID(),
      precalcObligationId: null,
      verifyQueueId: null,
      uransRequestId: null,
    };
    expect(
      countTargetOpenCriticalIncidents(target, requestId, verifyId, [
        unrelated,
      ]),
    ).toBe(0);
    expect(
      countTargetOpenCriticalIncidents(target, requestId, verifyId, [
        unrelated,
        { ...unrelated, resultId: target.sourceResultId },
        { ...unrelated, resultId: null, uransRequestId: requestId },
      ]),
    ).toBe(2);
  });

  it.each([
    [
      "claimed without a job",
      (s: ThreeStageUransCanarySnapshot) => (s.verify!.state = "running"),
    ],
    [
      "not due",
      (s: ThreeStageUransCanarySnapshot) =>
        (s.verify!.nextSubmitAt = new Date(Date.now() + 60_000)),
    ],
    [
      "media-only repair",
      (s: ThreeStageUransCanarySnapshot) =>
        (s.verify!.lastOutcome = "media_repair_pending"),
    ],
    [
      "exhausted fresh starts",
      (s: ThreeStageUransCanarySnapshot) => {
        s.verify!.freshAttemptCount = s.verify!.maxFreshAttempts;
        s.verify!.lastOutcome = "final_recovery_exhausted";
      },
    ],
    [
      "continuation without immutable source",
      (s: ThreeStageUransCanarySnapshot) => {
        s.verify!.lastOutcome = "continuation_pending";
        s.verify!.latestResultAttemptId = null;
      },
    ],
    [
      "owned directly by another campaign",
      (s: ThreeStageUransCanarySnapshot) =>
        s.verifyOwnerCampaignIds.push(crypto.randomUUID()),
    ],
    [
      "shared with another FULL request",
      (s: ThreeStageUransCanarySnapshot) =>
        s.verifyRequestIds.push(crypto.randomUUID()),
    ],
    [
      "not backed by accepted preliminary evidence",
      (s: ThreeStageUransCanarySnapshot) =>
        (s.verifyPrecalcAttempt!.classificationState = "rejected"),
    ],
    [
      "backed by a different preliminary obligation",
      (s: ThreeStageUransCanarySnapshot) =>
        (s.verifyPrecalcAttempt!.precalcObligationId = crypto.randomUUID()),
    ],
  ])("refuses final verification that is %s", (_name, mutate) => {
    const snapshot = withVerify("pending");
    mutate(snapshot);
    expect(() =>
      validateThreeStageUransCanarySnapshot(
        target,
        threeStageUransCanaryMarker(target),
        snapshot,
      ),
    ).toThrow("three-stage URANS canary refused");
  });

  it("refuses a marked FULL request that bypassed preliminary and final stages", () => {
    const snapshot = withRequest({ state: "done" });
    snapshot.overlappingOpenRequestIds = [];
    expect(() =>
      validateThreeStageUransCanarySnapshot(
        target,
        threeStageUransCanaryMarker(target),
        snapshot,
      ),
    ).toThrow("bypassed the exact final-verification chain");
  });

  it("refuses unrelated open work even when it resembles URANS", async () => {
    const unrelatedRequest = withRequest();
    unrelatedRequest.overlappingOpenRequestIds.push(crypto.randomUUID());
    expect(() =>
      validateThreeStageUransCanarySnapshot(
        target,
        threeStageUransCanaryMarker(target),
        unrelatedRequest,
      ),
    ).toThrow("unrelated open FULL work");

    const unrelatedJob = withRequest({ state: "running" });
    unrelatedJob.matchingRuntimeBuildCount = 1;
    unrelatedJob.openJobs = [
      {
        ...submittedSnapshot("precalc").openJobs[0],
        id: crypto.randomUUID(),
        requestPayload: {
          aoas: [target.aoaDeg],
          uransFidelity: "precalc",
          uransRequestId: crypto.randomUUID(),
          precalcObligationIds: [target.precalcObligationId],
        },
      },
    ];
    expect(() =>
      validateThreeStageUransCanarySnapshot(
        target,
        threeStageUransCanaryMarker(target),
        unrelatedJob,
      ),
    ).toThrow("is unrelated to the exact canary chain");
  });

  it("refuses a FULL owner associated with any unrelated obligation", () => {
    const snapshot = withRequest();
    snapshot.requestCoveredObligationIds = [
      target.precalcObligationId,
      crypto.randomUUID(),
    ];
    expect(() =>
      validateThreeStageUransCanarySnapshot(
        target,
        threeStageUransCanaryMarker(target),
        snapshot,
      ),
    ).toThrow("covers obligations outside the exact canary cell");
  });

  it("refuses exact-looking jobs with the wrong recovery contract", () => {
    const preliminary = submittedSnapshot("precalc");
    (preliminary.openJobs[0].requestPayload as Record<string, unknown>)[
      "meshRecoveryVersion"
    ] = target.expectedMeshRecoveryVersion - 1;
    expect(() =>
      validateThreeStageUransCanarySnapshot(
        target,
        threeStageUransCanaryMarker(target),
        preliminary,
      ),
    ).toThrow("is unrelated to the exact canary chain");

    const final = submittedSnapshot("full");
    Object.assign(final.openJobs[0].requestPayload as Record<string, unknown>, {
      finalRecoveryMode: "continuation",
      uransRecoveryVersion: target.expectedUransRecoveryVersion - 1,
    });
    expect(() =>
      validateThreeStageUransCanarySnapshot(
        target,
        threeStageUransCanaryMarker(target),
        final,
      ),
    ).toThrow("is unrelated to the exact canary chain");
  });

  it("keeps an explicit empty campaign or parent scope completely inert", async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error("closed-world scope touched the database");
        },
      },
    ) as DB;
    const engine = {} as EngineClient;
    await expect(
      submitCampaignPrecalcRecoveries(db, engine, [], undefined, 2, 2),
    ).resolves.toBe(false);
    await expect(
      submitCampaignPrecalcRecoveries(
        db,
        engine,
        [target.campaignId],
        [],
        2,
        2,
      ),
    ).resolves.toBe(false);
  });
});

describe("three-stage URANS engine admission preflight", () => {
  it("accepts only an empty exact 2606 pool with one runtime provenance", () => {
    expect(() =>
      validateThreeStageUransEnginePreflight(target, enginePreflight()),
    ).not.toThrow();
  });

  it.each([
    [
      "wrong build",
      (p: ThreeStageUransEnginePreflight) =>
        (p.health.build_id = "other-build"),
    ],
    [
      "wrong mesh recovery",
      (p: ThreeStageUransEnginePreflight) =>
        (p.health.mesh_recovery_version = 1),
    ],
    [
      "wrong URANS recovery",
      (p: ThreeStageUransEnginePreflight) =>
        (p.health.urans_recovery_version = 1),
    ],
    [
      "missing continuation",
      (p: ThreeStageUransEnginePreflight) =>
        (p.capabilities.supports_continuation = false),
    ],
    [
      "active task",
      (p: ThreeStageUransEnginePreflight) => {
        p.queue.active_count = 1;
        p.queue.active = [
          {
            worker: "w",
            task_id: "t",
            name: "solve",
            job_id: "j",
            redelivered: false,
          },
        ];
      },
    ],
    [
      "queued work",
      (p: ThreeStageUransEnginePreflight) => {
        p.queue.queues![0].depth = 1;
        p.queue.queue_depths!["openfoam-opencfd-2606"] = 1;
      },
    ],
    [
      "wrong worker build",
      (p: ThreeStageUransEnginePreflight) => {
        p.queue.worker_queues![0].engine = {
          ...runtime(),
          build_id: "wrong-build",
        };
      },
    ],
    [
      "worker also consumes legacy",
      (p: ThreeStageUransEnginePreflight) => {
        p.queue.worker_queues![0].queues.push("celery");
      },
    ],
    [
      "unrelated enabled route",
      (p: ThreeStageUransEnginePreflight) => {
        p.queue.queue_enabled!.celery = true;
      },
    ],
    [
      "inspection failure",
      (p: ThreeStageUransEnginePreflight) => {
        p.queue.worker_queues_error = "inspector unavailable";
      },
    ],
    [
      "wrong evidence bucket",
      (p: ThreeStageUransEnginePreflight) => {
        p.health.evidence_storage!.bucket = "wrong-bucket";
      },
    ],
    [
      "local raw evidence retention",
      (p: ThreeStageUransEnginePreflight) => {
        p.health.evidence_storage!.remote_only = false;
      },
    ],
    [
      "disk percentage safeguard",
      (p: ThreeStageUransEnginePreflight) => {
        p.disk.used_pct = 90;
      },
    ],
    [
      "disk reserve safeguard",
      (p: ThreeStageUransEnginePreflight) => {
        p.disk.free_bytes = 1;
      },
    ],
  ])("fails closed on %s", (_name, mutate) => {
    const preflight = structuredClone(enginePreflight());
    mutate(preflight);
    expect(() =>
      validateThreeStageUransEnginePreflight(target, preflight),
    ).toThrow("three-stage URANS canary refused");
  });
});

describe("three-stage URANS canary CLI", () => {
  const argv = [
    "--campaign-id",
    target.campaignId,
    "--condition-id",
    target.conditionId,
    "--expected-campaign-generation",
    String(target.expectedCampaignGeneration),
    "--parent-job-id",
    target.parentJobId,
    "--airfoil-id",
    target.airfoilId,
    "--revision-id",
    target.revisionId,
    "--aoa-deg",
    String(target.aoaDeg),
    "--source-result-id",
    target.sourceResultId,
    "--source-result-attempt-id",
    target.sourceResultAttemptId,
    "--precalc-obligation-id",
    target.precalcObligationId,
    "--expected-engine-build-id",
    target.expectedEngineBuildId,
    "--expected-mesh-recovery-version",
    "2",
    "--expected-urans-recovery-version",
    "2",
  ];

  it("requires every exact identifier and expected live recovery contract", () => {
    expect(parseThreeStageUransCanaryArgs(argv)).toEqual(target);
    expect(() =>
      parseThreeStageUransCanaryArgs(
        argv.filter((_value, index) => index < argv.length - 2),
      ),
    ).toThrow();
    const legacy = [...argv];
    legacy[legacy.length - 1] = "1";
    expect(() => parseThreeStageUransCanaryArgs(legacy)).toThrow(
      "must be at least 2",
    );
  });

  it("binds the durable marker to every exact target input", () => {
    const marker = threeStageUransCanaryMarker(target);
    expect(marker).toMatch(/^system:three-stage-urans-canary-v1:[0-9a-f]{64}$/);
    expect(threeStageUransCanaryMarker({ ...target })).toBe(marker);
    expect(
      threeStageUransCanaryMarker({ ...target, aoaDeg: target.aoaDeg + 1 }),
    ).not.toBe(marker);
    expect(
      threeStageUransCanaryMarker({
        ...target,
        conditionId: crypto.randomUUID(),
      }),
    ).not.toBe(marker);
    expect(
      threeStageUransCanaryMarker({
        ...target,
        expectedCampaignGeneration: target.expectedCampaignGeneration + 1,
      }),
    ).not.toBe(marker);
    expect(
      threeStageUransCanaryMarker({
        ...target,
        expectedEngineBuildId: "another-build",
      }),
    ).not.toBe(marker);
  });

  it("routes operational logs to stderr and restores console.log", async () => {
    const originalLog = console.log;
    const stderrLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await expect(
      withThreeStageCanaryLogsOnStderr(async () => {
        console.log("operator detail");
        return 42;
      }),
    ).resolves.toBe(42);
    expect(stderrLog).toHaveBeenCalledWith("operator detail");
    expect(console.log).toBe(originalLog);
    stderrLog.mockRestore();
  });

  it("documents the exact invocation and keeps invalid CLI stdout empty", () => {
    expect(THREE_STAGE_URANS_CANARY_USAGE).toContain(
      "--precalc-obligation-id UUID",
    );
    const cli = fileURLToPath(
      new URL("../src/three-stage-urans-canary-once-cli.ts", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", cli, "--not-a-canary-option"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown option");
  });

  it("transports CLI options through the production pnpm form without an option terminator", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const result = spawnSync(
      "corepack",
      [
        "pnpm",
        "--silent",
        "--filter",
        "@aerodb/sweeper",
        "urans-canary:admit-once",
        "--help",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.startsWith("Usage:\n")).toBe(true);
    expect(result.stdout).not.toContain(
      "\n> @aerodb/sweeper@0.1.0 urans-canary:admit-once",
    );
  });
});
