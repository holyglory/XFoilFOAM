import {
  OPENCFD_2606_EXECUTION_POOL_ID,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
} from "@aerodb/db";
import { describe, expect, it, vi } from "vitest";

import {
  parseSuccessorAdmissionArgs,
  withOperationalLogsOnStderr,
} from "../src/successor-continuation-once-cli";
import {
  admitOneSuccessor,
  type SuccessorAdmissionCandidate,
  type SuccessorAdmissionDependencies,
  type SuccessorAdmissionJob,
  type SuccessorAdmissionPreflight,
  type SuccessorAdmissionTarget,
} from "../src/successor-continuation-once";

const target: SuccessorAdmissionTarget = {
  campaignId: "c24047fa-743f-4ae5-bcd6-f3071ff79fb4",
  canaryAttestationId: "112f52cd-eb8b-4908-bc79-6353daea6e12",
  targetPlanRevisionId: "2b65ecc9-318d-4e48-85d1-2fee221a0e01",
  targetGeneration: 2,
};

const candidate: SuccessorAdmissionCandidate = {
  campaignId: target.campaignId,
  airfoilId: "2a965fd4-a85f-4434-833e-7b208423f705",
  conditionCount: 3,
  angleCount: 26,
  conditionIds: [
    "6d87fb23-2c83-48a0-8658-447db7c67093",
    "46f658c5-900c-4d48-b6ed-274d3b3f88f8",
    "a977346b-7014-4240-8f18-9ecba223e407",
  ],
  angles: Array.from({ length: 26 }, (_value, index) => index - 5),
};

function requestPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    aoas: candidate.angles,
    conditionMap: candidate.conditionIds.map((conditionId) => ({
      conditionId,
    })),
    ...overrides,
  };
}

function preflight(
  overrides: Partial<SuccessorAdmissionPreflight> = {},
): SuccessorAdmissionPreflight {
  return {
    campaignStatus: "active",
    campaignPlanRevisionId: target.targetPlanRevisionId,
    campaignGeneration: target.targetGeneration,
    cutoverStatus: "completed",
    cutoverAttestationId: target.canaryAttestationId,
    cutoverPlanRevisionId: target.targetPlanRevisionId,
    cutoverGeneration: target.targetGeneration,
    cutoverToSolverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    priorCampaignStatus: "active",
    continuationStatus: "pending",
    continuationJobId: null,
    continuationEvidenceResultId: null,
    continuationLastError: null,
    attestedRuntimeBuildId: "ec5ec9cd-fb30-4803-988c-a607d4344a43",
    attestedSolverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    attestedExecutionPoolId: OPENCFD_2606_EXECUTION_POOL_ID,
    poolEnabled: true,
    otherEnabledPoolCount: 0,
    sweeperEnabled: false,
    openJobCount: 0,
    activePrecalcCount: 0,
    activeVerifyCount: 0,
    activeUransRequestCount: 0,
    activeSubmitRetryCount: 0,
    activeRemotePromiseCount: 0,
    ...overrides,
  };
}

function job(
  overrides: Partial<SuccessorAdmissionJob> = {},
): SuccessorAdmissionJob {
  return {
    id: "47ba789e-e630-4df5-a8af-f52bb91737f8",
    campaignId: target.campaignId,
    airfoilId: candidate.airfoilId,
    totalCases: candidate.conditionCount * candidate.angleCount,
    requestPayload: requestPayload(),
    simulationPresetRevisionId: "f469c0ec-55e0-4197-96df-44ed8af05fd2",
    solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    solverExecutionPoolId: OPENCFD_2606_EXECUTION_POOL_ID,
    solverRuntimeBuildId: preflight().attestedRuntimeBuildId,
    status: "submitted",
    engineState: "running",
    engineJobId: "2606-engine-successor-1",
    submittedAt: new Date("2026-07-17T10:00:00Z"),
    belongsToTargetGeneration: true,
    ...overrides,
  };
}

function dependencies(
  overrides: {
    preflight?: SuccessorAdmissionPreflight;
    candidate?: SuccessorAdmissionCandidate | null;
    submitted?: boolean;
    jobs?: SuccessorAdmissionJob[];
  } = {},
): SuccessorAdmissionDependencies<SuccessorAdmissionCandidate> & {
  disableSweeper: ReturnType<typeof vi.fn>;
  claimAdmissionLease: ReturnType<typeof vi.fn>;
  closeAdmission: ReturnType<typeof vi.fn>;
  loadCandidate: ReturnType<typeof vi.fn>;
  loadPreflight: ReturnType<typeof vi.fn>;
  submitCandidate: ReturnType<typeof vi.fn>;
} {
  return {
    disableSweeper: vi.fn(async () => undefined),
    claimAdmissionLease: vi.fn(async () => undefined),
    closeAdmission: vi.fn(async () => undefined),
    loadPreflight: vi.fn(async () => overrides.preflight ?? preflight()),
    assertDiskAdmission: vi.fn(async () => undefined),
    loadJobIds: vi.fn(async () => new Set(["old-job"])),
    loadCandidate: vi.fn(async () =>
      overrides.candidate === undefined ? candidate : overrides.candidate,
    ),
    candidateSummary: (value) => value,
    submitCandidate: vi.fn(async () => overrides.submitted ?? true),
    loadJobsNotIn: vi.fn(async () => overrides.jobs ?? [job()]),
  };
}

describe("OpenCFD 2606 successor one-shot admission", () => {
  it("admits one exact target-generation job and closes both admission fences", async () => {
    const deps = dependencies();
    await expect(admitOneSuccessor(target, deps)).resolves.toEqual({
      status: "submitted",
      campaignId: target.campaignId,
      jobId: job().id,
      engineJobId: job().engineJobId,
      solverRuntimeBuildId: preflight().attestedRuntimeBuildId,
      attestedSolverRuntimeBuildId: preflight().attestedRuntimeBuildId,
      runtimeAcknowledgement: "acknowledged",
      targetGeneration: 2,
      targetPlanRevisionId: target.targetPlanRevisionId,
      airfoilId: candidate.airfoilId,
      conditionCount: 3,
      angleCount: 26,
    });
    expect(deps.disableSweeper).toHaveBeenCalledTimes(1);
    expect(deps.claimAdmissionLease).toHaveBeenCalledTimes(1);
    expect(deps.submitCandidate).toHaveBeenCalledTimes(1);
    expect(deps.closeAdmission).toHaveBeenCalledTimes(1);
  });

  it("accepts an acknowledged pending engine task before worker runtime provenance exists", async () => {
    const deps = dependencies({
      jobs: [
        job({
          solverRuntimeBuildId: null,
          status: "submitted",
          engineState: "pending",
        }),
      ],
    });
    await expect(admitOneSuccessor(target, deps)).resolves.toMatchObject({
      status: "submitted",
      jobId: job().id,
      solverRuntimeBuildId: null,
      attestedSolverRuntimeBuildId: preflight().attestedRuntimeBuildId,
      runtimeAcknowledgement: "pending",
    });
    expect(deps.submitCandidate).toHaveBeenCalledTimes(1);
    expect(deps.closeAdmission).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["sweeper enabled", { sweeperEnabled: true }],
    ["pool disabled", { poolEnabled: false }],
    ["campaign paused", { campaignStatus: "paused" }],
    ["cutover only finalized", { cutoverStatus: "finalized" }],
    ["wrong generation", { campaignGeneration: 3 }],
    ["wrong plan", { campaignPlanRevisionId: crypto.randomUUID() }],
    [
      "wrong cutover attestation",
      { cutoverAttestationId: crypto.randomUUID() },
    ],
    ["wrong cutover generation", { cutoverGeneration: 3 }],
    ["wrong cutover plan", { cutoverPlanRevisionId: crypto.randomUUID() }],
    [
      "wrong cutover implementation",
      { cutoverToSolverImplementationId: crypto.randomUUID() },
    ],
    ["campaign was not runnable", { priorCampaignStatus: "paused" }],
    ["already routed", { continuationStatus: "routed" }],
    ["continuation has a job", { continuationJobId: crypto.randomUUID() }],
    [
      "continuation has evidence",
      { continuationEvidenceResultId: crypto.randomUUID() },
    ],
    ["continuation has an error", { continuationLastError: "drift" }],
    ["attestation has no runtime", { attestedRuntimeBuildId: "" }],
    [
      "attestation has the wrong implementation",
      { attestedSolverImplementationId: crypto.randomUUID() },
    ],
    [
      "attestation has the wrong pool",
      { attestedExecutionPoolId: crypto.randomUUID() },
    ],
    ["another pool is enabled", { otherEnabledPoolCount: 1 }],
    ["open physical work", { activePrecalcCount: 1 }],
    ["open verification work", { activeVerifyCount: 1 }],
    ["open explicit URANS work", { activeUransRequestCount: 1 }],
    ["open submit retry", { activeSubmitRetryCount: 1 }],
    ["active remote promise", { activeRemotePromiseCount: 1 }],
    ["existing job", { openJobCount: 1 }],
  ])("fails closed before submission when %s", async (_label, change) => {
    const deps = dependencies({ preflight: preflight(change) });
    await expect(admitOneSuccessor(target, deps)).rejects.toThrow(
      "successor one-shot admission refused",
    );
    expect(deps.submitCandidate).not.toHaveBeenCalled();
    expect(deps.closeAdmission).toHaveBeenCalledTimes(1);
  });

  it("fails closed when campaign-scoped discovery has no gap", async () => {
    const deps = dependencies({ candidate: null });
    await expect(admitOneSuccessor(target, deps)).rejects.toThrow(
      "has no RANS gap",
    );
    expect(deps.closeAdmission).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the durable one-shot lease is already claimed", async () => {
    const deps = dependencies();
    deps.claimAdmissionLease.mockRejectedValueOnce(new Error("lease exists"));
    await expect(admitOneSuccessor(target, deps)).rejects.toThrow(
      "lease exists",
    );
    expect(deps.loadPreflight).not.toHaveBeenCalled();
    expect(deps.submitCandidate).not.toHaveBeenCalled();
    expect(deps.closeAdmission).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the immutable target changes between preflight reads", async () => {
    const deps = dependencies();
    deps.loadPreflight
      .mockResolvedValueOnce(preflight())
      .mockResolvedValueOnce(preflight({ campaignGeneration: 3 }));
    await expect(admitOneSuccessor(target, deps)).rejects.toThrow(
      "campaign generation differs",
    );
    expect(deps.submitCandidate).not.toHaveBeenCalled();
    expect(deps.closeAdmission).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the exact batch changes between discovery reads", async () => {
    const deps = dependencies();
    deps.loadCandidate.mockResolvedValueOnce(candidate).mockResolvedValueOnce({
      ...candidate,
      airfoilId: crypto.randomUUID(),
    });
    await expect(admitOneSuccessor(target, deps)).rejects.toThrow(
      "exact campaign batch changed",
    );
    expect(deps.submitCandidate).not.toHaveBeenCalled();
    expect(deps.closeAdmission).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another campaign", { campaignId: crypto.randomUUID() }],
    ["no airfoil", { airfoilId: "" }],
    ["no conditions", { conditionCount: 0 }],
    ["no angles", { angleCount: 0 }],
    [
      "duplicate conditions",
      {
        conditionIds: [
          candidate.conditionIds[0],
          candidate.conditionIds[0],
          candidate.conditionIds[2],
        ],
      },
    ],
  ])(
    "fails closed when candidate discovery returns %s",
    async (_label, change) => {
      const deps = dependencies({ candidate: { ...candidate, ...change } });
      await expect(admitOneSuccessor(target, deps)).rejects.toThrow(
        "successor one-shot admission refused",
      );
      expect(deps.submitCandidate).not.toHaveBeenCalled();
      expect(deps.closeAdmission).toHaveBeenCalledTimes(1);
    },
  );

  it("fails closed when the engine does not accept the exact candidate", async () => {
    const deps = dependencies({ submitted: false });
    await expect(admitOneSuccessor(target, deps)).rejects.toThrow(
      "not accepted by the engine",
    );
    expect(deps.closeAdmission).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["zero", []],
    ["two", [job(), job({ id: crypto.randomUUID() })]],
  ])(
    "fails closed when submission creates %s job rows",
    async (_label, jobs) => {
      const deps = dependencies({ jobs });
      await expect(admitOneSuccessor(target, deps)).rejects.toThrow(
        /created [02] new job rows instead of exactly one/,
      );
      expect(deps.closeAdmission).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["another campaign", { campaignId: crypto.randomUUID() }],
    ["another generation", { belongsToTargetGeneration: false }],
    ["another airfoil", { airfoilId: crypto.randomUUID() }],
    ["partial batch", { totalCases: 1 }],
    ["different angles", { requestPayload: requestPayload({ aoas: [0] }) }],
    [
      "different conditions",
      {
        requestPayload: requestPayload({
          conditionMap: [{ conditionId: crypto.randomUUID() }],
        }),
      },
    ],
    ["another implementation", { solverImplementationId: crypto.randomUUID() }],
    ["another pool", { solverExecutionPoolId: crypto.randomUUID() }],
    ["another runtime", { solverRuntimeBuildId: crypto.randomUUID() }],
    [
      "missing runtime with a non-pending engine state",
      {
        solverRuntimeBuildId: null,
        status: "submitted",
        engineState: "running",
      },
    ],
    [
      "missing runtime with a non-submitted job status",
      {
        solverRuntimeBuildId: null,
        status: "running",
        engineState: "pending",
      },
    ],
    [
      "missing runtime after pending",
      {
        solverRuntimeBuildId: null,
        status: "running",
        engineState: "running",
      },
    ],
    ["no engine acknowledgement", { engineJobId: null }],
    ["failed shell", { status: "failed" }],
  ])("fails closed on a post-submit %s", async (_label, change) => {
    const deps = dependencies({ jobs: [job(change)] });
    await expect(admitOneSuccessor(target, deps)).rejects.toThrow(
      "successor one-shot admission refused",
    );
    expect(deps.closeAdmission).toHaveBeenCalledTimes(1);
  });

  it("surfaces failure to confirm the fail-safe together with the root error", async () => {
    const deps = dependencies({ candidate: null });
    deps.closeAdmission.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(admitOneSuccessor(target, deps)).rejects.toThrow(
      "fail-safe could not be confirmed",
    );
  });
});

describe("successor one-shot CLI arguments", () => {
  it("requires the complete immutable campaign allowlist", () => {
    expect(
      parseSuccessorAdmissionArgs([
        "--campaign-id",
        target.campaignId,
        "--canary-attestation-id",
        target.canaryAttestationId,
        "--target-plan-revision-id",
        target.targetPlanRevisionId,
        "--target-generation",
        "2",
      ]),
    ).toEqual(target);
  });

  it.each([
    [[]],
    [["--campaign-id", "not-a-uuid"]],
    [["--target-generation", "0"]],
    [["unexpected"]],
  ])("rejects incomplete or malformed arguments", (argv) => {
    expect(() => parseSuccessorAdmissionArgs(argv)).toThrow();
  });

  it("reserves stdout for the JSON receipt while submit logs go to stderr", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const receipt = await withOperationalLogsOnStderr(async () => {
      console.log("[sweeper] job submitted → engine successor-1");
      return { status: "submitted" as const, jobId: "successor-job-1" };
    });

    process.stdout.write(`${JSON.stringify(receipt)}\n`);

    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith(
      '{"status":"submitted","jobId":"successor-job-1"}\n',
    );
    expect(stderr).toHaveBeenCalledWith(
      "[sweeper] job submitted → engine successor-1",
    );
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
