import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";

const hooks = vi.hoisted(() => ({
  slots: 0,
  fence: vi.fn(),
  enrollment: vi.fn(),
  reconcile: vi.fn(),
  admission: vi.fn(),
  pressure: vi.fn(),
  disk: vi.fn(),
  emergency: vi.fn(),
  cancelDisk: vi.fn(),
  retention: vi.fn(),
  mesh: vi.fn(),
  backoff: vi.fn(),
  unreachable: vi.fn(),
  reachable: vi.fn(),
  tickStarted: vi.fn(),
  tickCompleted: vi.fn(),
  heartbeat: vi.fn(),
  remoteReconcile: vi.fn(),
  remoteAdmit: vi.fn(),
  reclaim: vi.fn(),
  transfer: vi.fn(),
  media: vi.fn(),
  legacyGaps: vi.fn(),
  legacyCampaign: vi.fn(),
  correction: vi.fn(),
  progressiveCapabilities: vi.fn(),
  remotePrepare: vi.fn(),
  remoteProgress: vi.fn(),
}));

vi.mock("@aerodb/db", async (original) => ({
  ...(await original<typeof import("@aerodb/db")>()),
  enforceSweeperAdmissionFence: hooks.fence,
  reconcileCampaignProfileEnrollment: hooks.enrollment,
  findCampaignGapBatch: hooks.legacyCampaign,
}));
vi.mock("../src/progressive-admission", () => ({
  admitProgressiveCfdBatch: hooks.admission,
}));
vi.mock("../src/progressive-remote-admission", () => ({
  prepareProgressiveRemoteFleet: hooks.remotePrepare,
}));
vi.mock("../src/progressive-remote-progress", () => ({
  reconcileProgressiveRemoteProgress: hooks.remoteProgress,
}));
vi.mock("../src/urans-ladder", () => ({
  submitPendingPointCorrectionFastRequest: hooks.correction,
}));
vi.mock("../src/engine-capabilities", () => ({
  engineProgressiveCapabilities: hooks.progressiveCapabilities,
}));
vi.mock("../src/submit-lifecycle", () => ({
  solverQueuePressure: hooks.pressure,
  submitPendingJobWithLifecycleGuard: vi.fn(),
}));
vi.mock("../src/reconcile", () => ({
  reconcile: hooks.reconcile,
  resetOrphans: vi.fn(),
}));
vi.mock("../src/disk-admission", () => ({
  refreshDiskAdmission: hooks.disk,
  isDiskPressureEmergency: hooks.emergency,
  cancelDisposableJobsForDiskPressure: hooks.cancelDisk,
}));
vi.mock("../src/retention", () => ({ retentionTick: hooks.retention }));
vi.mock("../src/mesh-recovery", () => ({
  prepareAutomaticMeshRecovery: hooks.mesh,
}));
vi.mock("../src/engine-backoff", () => ({
  engineBackoffActive: hooks.backoff,
  recordEngineUnreachable: hooks.unreachable,
  clearEngineUnreachable: hooks.reachable,
}));
vi.mock("../src/heartbeat", () => ({
  markTickStarted: hooks.tickStarted,
  markTickCompleted: hooks.tickCompleted,
  touchHeartbeat: hooks.heartbeat,
}));
vi.mock("../src/remote-solver", () => ({
  reconcileRemoteSolverTick: hooks.remoteReconcile,
  admitRemoteSolverTick: hooks.remoteAdmit,
  scheduleRemoteSolverReclaims: hooks.reclaim,
  scheduleRemoteSolverTransfer: hooks.transfer,
}));
vi.mock("../src/media-object-store", () => ({
  scheduleResultMediaStorageMaintenance: hooks.media,
}));
vi.mock("../src/gaps", () => ({
  findGaps: hooks.legacyGaps,
  firstBatch: vi.fn(),
}));

import { tick } from "../src/loop";

function fixture(enabled = true) {
  const state = {
    enabled,
    cpuSlots: 3,
    maxConcurrentJobs: 3,
    diskAdmissionBlocked: false,
    pollIntervalMs: 5_000,
    submitIntervalMs: 15_000,
  };
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [state] }) }),
    }),
  } as unknown as DB;
  const health = vi.fn().mockResolvedValue(true);
  return { db, health, engine: { health } as unknown as EngineClient };
}

beforeEach(() => {
  vi.resetAllMocks();
  hooks.slots = 0;
  hooks.fence.mockResolvedValue({
    active: false,
    hazardPresent: false,
    fencedNow: false,
  });
  hooks.pressure.mockImplementation(async () => hooks.slots);
  hooks.disk.mockResolvedValue({ allowed: true });
  hooks.emergency.mockReturnValue(false);
  hooks.backoff.mockReturnValue(false);
  hooks.mesh.mockResolvedValue(1);
  hooks.progressiveCapabilities.mockResolvedValue({
    uransRecoveryVersion: 14,
    solverBudgetVersion: 2,
  });
  hooks.correction.mockResolvedValue({ attempted: false, submitted: false });
  hooks.remoteReconcile.mockResolvedValue(false);
  hooks.remotePrepare.mockResolvedValue({
    prepared: 0,
    waiting: 0,
    errors: [],
  });
  hooks.remoteProgress.mockResolvedValue({
    applied: 0,
    stopped: 0,
    errors: [],
  });
  hooks.admission.mockImplementation(async () => {
    hooks.slots += 1;
    return {
      kind: "attempted",
      jobId: `isolated-${hooks.slots}`,
      stage: 2,
      outcome: { kind: "submitted" },
    };
  });
});

describe("progressive controller tick", () => {
  it("prepares remote assignments even when all local CPU slots are occupied", async () => {
    hooks.slots = 3;
    const scope = fixture();
    await tick(scope.db, scope.engine);
    expect(hooks.remotePrepare).toHaveBeenCalledWith(scope.db);
    expect(hooks.admission).not.toHaveBeenCalled();
    expect(scope.health).not.toHaveBeenCalled();
  });
  it("admits assigned remote work through the existing capacity gates without local replanning", async () => {
    hooks.remoteReconcile.mockResolvedValue(true);
    const scope = fixture();
    await tick(scope.db, scope.engine);
    expect(hooks.remoteAdmit).toHaveBeenCalledWith(scope.db, scope.engine, {
      kind: "allow",
      meshRecoveryVersion: 1,
    });
    expect(hooks.admission).not.toHaveBeenCalled();
    expect(hooks.correction).not.toHaveBeenCalled();
    expect(hooks.tickCompleted).toHaveBeenCalledTimes(1);
  });
  it("preserves an explicit point correction without restoring automatic legacy campaign work", async () => {
    hooks.correction.mockImplementation(async () => {
      hooks.slots += 1;
      return { attempted: true, submitted: true };
    });
    const scope = fixture();
    await tick(scope.db, scope.engine);
    expect(hooks.correction).toHaveBeenCalledTimes(1);
    expect(hooks.correction).toHaveBeenCalledWith(
      scope.db,
      scope.engine,
      3,
      1,
      14,
    );
    expect(hooks.admission).toHaveBeenCalledTimes(2);
    expect(hooks.legacyGaps).not.toHaveBeenCalled();
    expect(hooks.legacyCampaign).not.toHaveBeenCalled();
    expect(hooks.remoteAdmit).not.toHaveBeenCalled();
  });

  it("holds explicit URANS corrections when their engine capability is unknown", async () => {
    hooks.progressiveCapabilities.mockResolvedValue({
      uransRecoveryVersion: null,
      solverBudgetVersion: 2,
    });
    const scope = fixture();
    await tick(scope.db, scope.engine);
    expect(hooks.correction).not.toHaveBeenCalled();
    expect(hooks.admission).toHaveBeenCalledTimes(3);
  });

  it("fills the actual CPU capacity using only progressive campaign work", async () => {
    const scope = fixture();
    await tick(scope.db, scope.engine);
    expect(hooks.admission).toHaveBeenCalledTimes(3);
    expect(hooks.admission).toHaveBeenCalledWith(scope.db, scope.engine, {
      meshRecoveryVersion: 1,
      uransRecoveryVersion: 14,
      solverBudgetVersion: 2,
    });
    expect(hooks.legacyGaps).not.toHaveBeenCalled();
    expect(hooks.legacyCampaign).not.toHaveBeenCalled();
    expect(hooks.remoteAdmit).not.toHaveBeenCalled();
    expect(hooks.tickCompleted).toHaveBeenCalledTimes(1);
  });

  it("keeps reconciliation and transfer maintenance alive while scheduling is paused", async () => {
    const scope = fixture(false);
    await tick(scope.db, scope.engine);
    expect(hooks.reconcile).toHaveBeenCalledTimes(1);
    expect(hooks.enrollment).toHaveBeenCalledTimes(1);
    expect(hooks.remoteReconcile).toHaveBeenCalledTimes(1);
    expect(hooks.transfer).toHaveBeenCalledTimes(1);
    expect(hooks.reclaim).not.toHaveBeenCalled();
    expect(hooks.retention).not.toHaveBeenCalled();
    expect(hooks.remoteProgress).not.toHaveBeenCalled();
    expect(hooks.remotePrepare).not.toHaveBeenCalled();
    expect(hooks.admission).not.toHaveBeenCalled();
    expect(scope.health).not.toHaveBeenCalled();
  });

  it("does not put routine cleanup ahead of free CPU admission", async () => {
    hooks.retention.mockImplementation(() => new Promise(() => {}));
    const scope = fixture();
    await tick(scope.db, scope.engine);
    expect(hooks.admission).toHaveBeenCalledTimes(3);
    expect(hooks.retention).not.toHaveBeenCalled();
  });

  it("still awaits emergency cleanup before considering new work", async () => {
    hooks.emergency.mockReturnValue(true);
    hooks.cancelDisk.mockResolvedValue(1);
    let release: () => void = () => {};
    hooks.retention.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const scope = fixture();
    const running = tick(scope.db, scope.engine);
    await vi.waitFor(() => expect(hooks.retention).toHaveBeenCalledOnce());
    expect(hooks.admission).not.toHaveBeenCalled();
    release();
    await running;
    expect(hooks.admission).toHaveBeenCalledTimes(3);
  });

  it("does not admit past a hazard discovered by reconciliation", async () => {
    hooks.fence
      .mockResolvedValueOnce({ active: false, hazardPresent: false })
      .mockResolvedValue({ active: true, hazardPresent: true });
    const scope = fixture();
    await tick(scope.db, scope.engine);
    expect(hooks.reconcile).toHaveBeenCalledTimes(1);
    expect(hooks.mesh).toHaveBeenCalledTimes(1);
    expect(hooks.remotePrepare).not.toHaveBeenCalled();
    expect(hooks.admission).not.toHaveBeenCalled();
  });

  it.each(["disk", "capacity", "capability", "health"])(
    "holds new work when %s is unavailable",
    async (reason) => {
      const scope = fixture();
      if (reason === "disk") hooks.disk.mockResolvedValue({ allowed: false });
      if (reason === "capacity") hooks.slots = 3;
      if (reason === "capability") hooks.mesh.mockResolvedValue(null);
      if (reason === "health") scope.health.mockResolvedValue(false);
      await tick(scope.db, scope.engine);
      expect(hooks.admission).not.toHaveBeenCalled();
      expect(hooks.tickCompleted).toHaveBeenCalledTimes(1);
      if (reason === "health")
        expect(hooks.unreachable).toHaveBeenCalledTimes(1);
      if (reason === "disk") expect(hooks.remotePrepare).not.toHaveBeenCalled();
    },
  );

  it("stops refilling after an ambiguous dispatch instead of consuming the other finite claims", async () => {
    hooks.admission.mockResolvedValue({
      kind: "attempted",
      jobId: "isolated-ambiguous",
      stage: 2,
      outcome: { kind: "submission_in_progress" },
    });
    const scope = fixture();
    await tick(scope.db, scope.engine);
    expect(hooks.admission).toHaveBeenCalledTimes(1);
    expect(hooks.tickCompleted).toHaveBeenCalledTimes(1);
  });

  it("never falls back to old automatic work when no progressive unit is ready", async () => {
    hooks.admission.mockResolvedValue({ kind: "idle" });
    const scope = fixture();
    await tick(scope.db, scope.engine);
    expect(hooks.admission).toHaveBeenCalledTimes(1);
    expect(hooks.legacyGaps).not.toHaveBeenCalled();
    expect(hooks.legacyCampaign).not.toHaveBeenCalled();
    expect(hooks.remoteAdmit).not.toHaveBeenCalled();
  });
});
