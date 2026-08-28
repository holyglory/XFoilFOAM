import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DISK_IDLE_SLOT_RESERVE_BYTES,
  DEFAULT_DISK_JOB_RESERVE_BYTES,
  DEFAULT_DISK_MAX_USED_PCT,
  DEFAULT_DISK_MIN_FREE_BYTES,
  configuredDiskCapacitySlots,
  diskAdmissionExposureForJobs,
  diskMeasurementFromStatfs,
  evaluateDiskAdmission,
  isDiskPressureEmergency,
} from "../src/disk-admission";

const GIB = 1024 ** 3;
const config = {
  maxUsedPct: DEFAULT_DISK_MAX_USED_PCT,
  minFreeBytes: DEFAULT_DISK_MIN_FREE_BYTES,
  jobReserveBytes: DEFAULT_DISK_JOB_RESERVE_BYTES,
  idleSlotReserveBytes: DEFAULT_DISK_IDLE_SLOT_RESERVE_BYTES,
};

describe("disk admission", () => {
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
      requiredFreeBytes: 132 * GIB,
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

  it("keeps forecast-only and ordinary high-use admission separate from critical emergency use", () => {
    const forecastOnly = evaluateDiskAdmission(
      { total_bytes: 500 * GIB, free_bytes: 279 * GIB, used_pct: 47.2 },
      {
        activeLocalJobCount: 8,
        activeLocalReservedBytes: 256 * GIB,
      },
      config,
    );
    const ordinaryHighUse = evaluateDiskAdmission(
      { total_bytes: 3_300 * GIB, free_bytes: 531 * GIB, used_pct: 83.9 },
      { activeLocalJobCount: 1, activeLocalReservedBytes: 2 * GIB },
      config,
    );
    const emergency = evaluateDiskAdmission(
      { total_bytes: 500 * GIB, free_bytes: 7.5 * GIB, used_pct: 98.5 },
      { activeLocalJobCount: 1, activeLocalReservedBytes: 2 * GIB },
      config,
    );

    expect(forecastOnly.allowed).toBe(false);
    expect(isDiskPressureEmergency(forecastOnly)).toBe(false);
    expect(isDiskPressureEmergency(ordinaryHighUse)).toBe(false);
    expect(isDiskPressureEmergency(emergency)).toBe(true);
  });

  it("uses the absolute free-space floor as an independent emergency backstop", () => {
    const belowFloor = evaluateDiskAdmission(
      { total_bytes: 1_000 * GIB, free_bytes: 19 * GIB, used_pct: 97 },
      { activeLocalJobCount: 0, activeLocalReservedBytes: 0 },
      config,
    );

    expect(isDiskPressureEmergency(belowFloor, 99, 20 * GIB)).toBe(true);
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
    expect(decision.reason).toContain("132.0 GiB required");
    expect(decision.reason).toContain(
      "72.0 GiB remaining local work across 3 jobs",
    );
  });

  it("keeps every configured CPU slot inside a measured per-slot forecast before the pool fills", () => {
    const empty = diskAdmissionExposureForJobs([], config, 8);
    expect(empty).toEqual({
      activeLocalJobCount: 0,
      activeLocalReservedBytes: 0,
      configuredLocalCpuSlots: 8,
      activeLocalCpuSlots: 0,
      idleLocalCpuSlots: 8,
      idleLocalReservedBytes: 240 * GIB,
    });
    expect(
      evaluateDiskAdmission(
        { total_bytes: 492 * GIB, free_bytes: 259 * GIB, used_pct: 47.4 },
        empty,
        config,
      ),
    ).toMatchObject({
      allowed: false,
      requiredFreeBytes: 260 * GIB,
    });
    const allowed = evaluateDiskAdmission(
      { total_bytes: 492 * GIB, free_bytes: 300 * GIB, used_pct: 39 },
      empty,
      config,
    );
    expect(allowed).toMatchObject({
      allowed: true,
      reason: null,
      requiredFreeBytes: 260 * GIB,
    });
  });

  it("uses CPU reservations only to count occupied capacity, never to multiply active job bytes", () => {
    const exposure = diskAdmissionExposureForJobs(
      [
        {
          totalCases: 2,
          completedCases: 1,
          admissionCpuSlots: 3,
          requestPayload: { uransFidelity: "precalc" },
        },
      ],
      config,
      8,
    );
    expect(exposure).toMatchObject({
      activeLocalJobCount: 1,
      activeLocalReservedBytes: 1.5 * GIB,
      configuredLocalCpuSlots: 8,
      activeLocalCpuSlots: 3,
      idleLocalCpuSlots: 5,
      idleLocalReservedBytes: 150 * GIB,
    });
  });

  it("resolves the disk-capacity contract from persisted slots before deployment fallback", () => {
    expect(
      configuredDiskCapacitySlots(
        { cpuSlots: 8, maxConcurrentJobs: 3 },
        { AIRFOILFOAM_WORKER_CPU_BUDGET: "64" },
      ),
    ).toBe(8);
    expect(
      configuredDiskCapacitySlots(
        { cpuSlots: 0, maxConcurrentJobs: 6 },
        { AIRFOILFOAM_WORKER_CPU_BUDGET: "64" },
      ),
    ).toBe(6);
    expect(
      configuredDiskCapacitySlots(
        { cpuSlots: 0, maxConcurrentJobs: 0 },
        { AIRFOILFOAM_WORKER_CPU_BUDGET: "64" },
      ),
    ).toBe(64);
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
      // 0.3125 GiB RANS + 2 × 1.5 GiB FAST + 1 × 6 GiB FINAL URANS.
      activeLocalReservedBytes: 9.3125 * GIB,
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
        { total_bytes: 500 * GIB, free_bytes: 70 * GIB, used_pct: 70 },
        exposure,
        config,
      ),
    ).toMatchObject({
      allowed: true,
      requiredFreeBytes: 60.3125 * GIB,
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

    expect(exposure.activeLocalReservedBytes / GIB).toBeCloseTo(81.5, 5);
    expect(decision).toMatchObject({
      allowed: true,
      requiredFreeBytes: 141.5 * GIB,
    });
    expect(
      diskAdmissionExposureForJobs(
        [{ totalCases: 78, completedCases: 0, requestPayload: null }],
        config,
      ).activeLocalReservedBytes,
    ).toBeCloseTo(24.375 * GIB, 4);
  });

  it("admits the observed eight-job FAST-URANS workload with measured headroom", () => {
    const exposure = diskAdmissionExposureForJobs(
      [12, 15, 6, 13, 18, 15, 22, 11].map((remainingCases) => ({
        totalCases: remainingCases,
        completedCases: 0,
        requestPayload: { uransFidelity: "precalc" },
      })),
      config,
      8,
    );
    const decision = evaluateDiskAdmission(
      { total_bytes: 492 * GIB, free_bytes: 252 * GIB, used_pct: 49 },
      exposure,
      config,
    );

    expect(exposure.activeLocalReservedBytes).toBe(168 * GIB);
    expect(decision).toMatchObject({
      allowed: true,
      reason: null,
      requiredFreeBytes: 188 * GIB,
    });
  });

  it("re-evaluates storage before every local refill submission", () => {
    const loopSource = readFileSync(
      new URL("../src/loop.ts", import.meta.url),
      "utf8",
    );
    const refillStart = loopSource.indexOf(
      "for (let i = 0; i < MAX_LOCAL_ADMISSIONS_PER_TICK; i++)",
    );
    const refillEnd = loopSource.indexOf(
      "  await markTickCompleted(db);",
      refillStart,
    );
    const refillLoop = loopSource.slice(refillStart, refillEnd);

    expect(refillStart).toBeGreaterThan(-1);
    expect(refillEnd).toBeGreaterThan(refillStart);
    expect(refillLoop).toContain(
      "diskAdmission = await refreshDiskAdmission(db, engine)",
    );
    expect(refillLoop.indexOf("refreshDiskAdmission")).toBeLessThan(
      refillLoop.indexOf("submitInterleavedVerifyIfDue"),
    );
    expect(refillLoop).toContain("if (!diskAdmission.allowed) break");
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
