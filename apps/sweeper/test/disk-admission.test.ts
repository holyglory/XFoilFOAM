import { describe, expect, it } from "vitest";

import {
  DEFAULT_DISK_JOB_RESERVE_BYTES,
  DEFAULT_DISK_MAX_USED_PCT,
  DEFAULT_DISK_MIN_FREE_BYTES,
  DEFAULT_REMOTE_DISK_MAX_USED_PCT,
  diskAdmissionConfigFromEnv,
  diskAdmissionExposureForJobs,
  diskMeasurementFromStatfs,
  evaluateDiskAdmission,
} from "../src/disk-admission";

const GIB = 1024 ** 3;
const config = {
  maxUsedPct: DEFAULT_DISK_MAX_USED_PCT,
  minFreeBytes: DEFAULT_DISK_MIN_FREE_BYTES,
  jobReserveBytes: DEFAULT_DISK_JOB_RESERVE_BYTES,
};

describe("disk admission", () => {
  it("uses the remote emergency ceiling only for the explicit remote role", () => {
    expect(
      diskAdmissionConfigFromEnv({
        AIRFOILFOAM_DEPLOYMENT_ROLE: "remote-solver",
      }),
    ).toMatchObject({
      deploymentRole: "remote-solver",
      maxUsedPct: DEFAULT_REMOTE_DISK_MAX_USED_PCT,
    });
    expect(diskAdmissionConfigFromEnv({})).toMatchObject({
      deploymentRole: "hub",
      maxUsedPct: DEFAULT_DISK_MAX_USED_PCT,
    });
    expect(
      diskAdmissionConfigFromEnv({
        AIRFOILFOAM_DEPLOYMENT_ROLE: "unexpected-role",
      }),
    ).toMatchObject({
      deploymentRole: "hub",
      maxUsedPct: DEFAULT_DISK_MAX_USED_PCT,
    });
  });

  it("admits a new job when measured use and reserved headroom are safe", () => {
    expect(
      evaluateDiskAdmission(
        { total_bytes: 300 * GIB, free_bytes: 220 * GIB, used_pct: 26.7 },
        {
          activeLocalJobCount: 3,
          activeLocalReservedBytes: 72 * GIB,
        },
        config,
      ),
    ).toMatchObject({
      allowed: true,
      reason: null,
      requiredFreeBytes: 116 * GIB,
    });
  });

  it("blocks at the percentage ceiling even when no job is active", () => {
    const decision = evaluateDiskAdmission(
      { total_bytes: 300 * GIB, free_bytes: 14 * GIB, used_pct: 95.1 },
      {
        activeLocalJobCount: 0,
        activeLocalReservedBytes: 0,
      },
      config,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("95.1% used");
  });

  it("admits the remote node at 95.9% only when its absolute reserve is safe", () => {
    const remoteConfig = diskAdmissionConfigFromEnv({
      AIRFOILFOAM_DEPLOYMENT_ROLE: "remote-solver",
    });
    const safeExposure = {
      activeLocalJobCount: 0,
      activeLocalReservedBytes: 0,
    };
    expect(
      evaluateDiskAdmission(
        {
          total_bytes: 3.3 * 1024 * GIB,
          free_bytes: 137.3 * GIB,
          used_pct: 95.9,
        },
        safeExposure,
        remoteConfig,
      ),
    ).toMatchObject({
      allowed: true,
      requiredFreeBytes: 44 * GIB,
    });

    expect(
      evaluateDiskAdmission(
        {
          total_bytes: 3.3 * 1024 * GIB,
          free_bytes: 43.9 * GIB,
          used_pct: 95.9,
        },
        safeExposure,
        remoteConfig,
      ),
    ).toMatchObject({ allowed: false, usedPct: 95.9 });
    expect(
      evaluateDiskAdmission(
        {
          total_bytes: 3.3 * 1024 * GIB,
          free_bytes: 137.3 * GIB,
          used_pct: 99,
        },
        safeExposure,
        remoteConfig,
      ),
    ).toMatchObject({ allowed: false, usedPct: 99 });
  });

  it("reserves worst-case growth for active jobs and the next admission", () => {
    const decision = evaluateDiskAdmission(
      { total_bytes: 300 * GIB, free_bytes: 110 * GIB, used_pct: 63.3 },
      {
        activeLocalJobCount: 3,
        activeLocalReservedBytes: 72 * GIB,
      },
      config,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("116.0 GiB required");
    expect(decision.reason).toContain(
      "72.0 GiB remaining local work across 3 jobs",
    );
  });

  it("fails closed on an invalid measurement", () => {
    expect(
      evaluateDiskAdmission(
        { total_bytes: 0, free_bytes: Number.NaN, used_pct: 0 },
        {
          activeLocalJobCount: 0,
          activeLocalReservedBytes: 0,
        },
        config,
      ),
    ).toMatchObject({
      allowed: false,
      usedPct: null,
      freeBytes: null,
      requiredFreeBytes: null,
    });
  });

  it("reserves measured future growth by solver fidelity and remaining cases", () => {
    const exposure = diskAdmissionExposureForJobs(
      [
        {
          totalCases: 78,
          completedCases: 77,
          requestPayload: null,
        },
        {
          totalCases: 8,
          completedCases: 6,
          requestPayload: { uransFidelity: "precalc" },
        },
        {
          totalCases: 1,
          completedCases: 0,
          requestPayload: { uransFidelity: "full" },
        },
      ],
      config,
    );

    expect(exposure).toEqual({
      activeLocalJobCount: 3,
      // 0.3125 GiB RANS + 2 × 2 GiB FAST + 1 × 6 GiB FINAL URANS.
      activeLocalReservedBytes: 10.3125 * GIB,
    });
  });

  it("does not turn CPU slots into local disk jobs", () => {
    const exposure = diskAdmissionExposureForJobs(
      [
        {
          totalCases: 1,
          completedCases: 0,
          admissionCpuSlots: 40,
          requestPayload: null,
        },
      ],
      config,
    );

    expect(exposure).toEqual({
      activeLocalJobCount: 1,
      activeLocalReservedBytes: 0.3125 * GIB,
    });
    expect(
      evaluateDiskAdmission(
        { total_bytes: 500 * GIB, free_bytes: 50 * GIB, used_pct: 70 },
        exposure,
        config,
      ),
    ).toMatchObject({
      allowed: true,
      requiredFreeBytes: 44.3125 * GIB,
    });
  });

  it("keeps a full unknown-job reserve instead of underestimating malformed work", () => {
    expect(
      diskAdmissionExposureForJobs(
        [
          {
            totalCases: 0,
            completedCases: 0,
            requestPayload: { uransFidelity: "unexpected" },
          },
        ],
        config,
      ),
    ).toEqual({
      activeLocalJobCount: 1,
      activeLocalReservedBytes: DEFAULT_DISK_JOB_RESERVE_BYTES,
    });
  });

  it("allows the observed mixed production workload without weakening a full RANS batch", () => {
    const exposure = diskAdmissionExposureForJobs(
      [
        { totalCases: 78, completedCases: 28, requestPayload: null },
        { totalCases: 78, completedCases: 43, requestPayload: null },
        { totalCases: 78, completedCases: 37, requestPayload: null },
        { totalCases: 78, completedCases: 0, requestPayload: null },
        {
          totalCases: 8,
          completedCases: 1,
          requestPayload: { uransFidelity: "precalc" },
        },
        { totalCases: 2, completedCases: 0, requestPayload: null },
        { totalCases: 2, completedCases: 0, requestPayload: null },
        {
          totalCases: 1,
          completedCases: 0,
          requestPayload: { uransFidelity: "full" },
        },
      ],
      config,
    );
    const decision = evaluateDiskAdmission(
      { total_bytes: 500 * GIB, free_bytes: 215.2 * GIB, used_pct: 56.9 },
      exposure,
      config,
    );

    expect(exposure.activeLocalReservedBytes / GIB).toBeCloseTo(85, 5);
    expect(decision).toMatchObject({
      allowed: true,
      requiredFreeBytes: 129 * GIB,
    });
    expect(
      diskAdmissionExposureForJobs(
        [{ totalCases: 78, completedCases: 0, requestPayload: null }],
        config,
      ).activeLocalReservedBytes,
    ).toBeCloseTo(24.375 * GIB, 4);
  });

  it("can measure the mounted media volume without waiting for the engine API", () => {
    expect(
      diskMeasurementFromStatfs({
        blocks: 1000,
        bfree: 400,
        bavail: 350,
        bsize: 4096,
      }),
    ).toEqual({
      total_bytes: 4_096_000,
      free_bytes: 1_433_600,
      used_pct: 65,
    });
  });
});
