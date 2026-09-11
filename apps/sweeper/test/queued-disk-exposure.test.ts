import { expect, it } from "vitest";
import {
  diskAdmissionConfigFromEnv,
  diskAdmissionExposureForJobs,
  evaluateDiskAdmission,
  type LocalDiskJob,
} from "../src/disk-admission";
import {
  MAX_FORECAST_QUEUE_JOBS,
  queuedDiskExposure,
  queuedJobReserve,
} from "../src/queued-disk-exposure";

const GIB = 1024 ** 3;
const config = diskAdmissionConfigFromEnv();

function queued(
  cases = 2,
  slots = 1,
  solver = {
    force_transient: false,
    transient_fallback: false,
    urans_fidelity: "full",
  },
): LocalDiskJob {
  return {
    totalCases: cases,
    completedCases: 0,
    admissionCpuSlots: slots,
    requestPayload: {
      engineRequest: {
        chord_lengths: [1],
        speeds: [30],
        aoa: { angles: Array.from({ length: cases }, (_, index) => index) },
        solver,
      },
    },
  };
}

it("uses the existing RANS allowance for all96known two-angle jobs without lowering standby reserves", () => {
  const exposure = diskAdmissionExposureForJobs(
    [],
    config,
    96,
    Array.from({ length: 96 }, () => queued()),
  );
  expect(exposure.idleLocalReservedBytes).toBe(60 * GIB);
  expect(
    evaluateDiskAdmission(
      { total_bytes: 3300 * GIB, free_bytes: 2753 * GIB, used_pct: 17 },
      exposure,
      config,
    ),
  ).toMatchObject({ allowed: true, requiredFreeBytes: 80 * GIB });
  expect(
    diskAdmissionExposureForJobs([], config, 96).idleLocalReservedBytes,
  ).toBe(2880 * GIB);
  expect(config.idleSlotReserveBytes).toBe(30 * GIB);
});

it("keeps standby headroom for slots without queued work and keeps actual work separate", () => {
  const active = { ...queued(), completedCases: 1 };
  const exposure = diskAdmissionExposureForJobs([active], config, 8, [
    queued(),
    queued(),
  ]);
  expect(exposure.activeLocalCpuSlots).toBe(1);
  expect(exposure.activeLocalReservedBytes).toBe(320 * 1024 ** 2);
  expect(exposure.idleLocalReservedBytes).toBe(150 * GIB + 1280 * 1024 ** 2);
});

it("reserves precise URANS for fallback and the actual explicit transient fidelity", () => {
  expect(
    queuedJobReserve(
      queued(2, 1, {
        force_transient: false,
        transient_fallback: true,
        urans_fidelity: "precalc",
      }),
      config,
    ),
  ).toBe(12 * GIB);
  expect(
    queuedJobReserve(
      queued(2, 1, {
        force_transient: true,
        transient_fallback: false,
        urans_fidelity: "precalc",
      }),
      config,
    ),
  ).toBe(3 * GIB);
  expect(
    queuedJobReserve(
      queued(2, 1, {
        force_transient: true,
        transient_fallback: false,
        urans_fidelity: "full",
      }),
      config,
    ),
  ).toBe(12 * GIB);
});

it("does not hide unknown requests behind a cheaper known queue", () => {
  const unknown = { ...queued(), requestPayload: {} };
  expect(queuedDiskExposure([queued(), unknown], 1, config).reservedBytes).toBe(
    40 * GIB,
  );
  expect(
    queuedDiskExposure(
      [{ ...unknown, admissionCpuSlots: 4 }, queued()],
      4,
      config,
    ).reservedBytes,
  ).toBe(120 * GIB);
  expect(() =>
    queuedDiskExposure(
      [{ ...queued(), admissionCpuSlots: undefined }],
      8,
      config,
    ),
  ).toThrow("exact planned CPU slots");
});

it("upper-bounds every whole-job packing, including expensive partial slots", () => {
  const jobs = [
    queued(2, 2),
    queued(9, 3),
    queued(4, 4, {
      force_transient: true,
      transient_fallback: false,
      urans_fidelity: "full",
    }),
  ];
  for (let slots = 1; slots <= 9; slots += 1) {
    const forecast = queuedDiskExposure(jobs, slots, config).reservedBytes;
    for (let mask = 0; mask < 1 << jobs.length; mask += 1) {
      const subset = jobs.filter((_, index) => (mask & (1 << index)) !== 0);
      const occupied = subset.reduce(
        (sum, job) => sum + job.admissionCpuSlots!,
        0,
      );
      if (occupied <= slots)
        expect(forecast).toBeGreaterThanOrEqual(
          subset.reduce((sum, job) => sum + queuedJobReserve(job, config)!, 0),
        );
    }
  }
});

it("keeps malformed shapes, partial execution and continuation out of the cheap forecast", () => {
  const original = queued();
  const request = (
    original.requestPayload as { engineRequest: Record<string, unknown> }
  ).engineRequest;
  for (const changed of [
    { ...request, aoa: { angles: [0, 0] } },
    { ...request, speeds: [0] },
    { ...request, chord_lengths: [Infinity] },
    { ...request, continue_from: {} },
    {
      ...request,
      solver: { force_transient: "false", transient_fallback: false },
    },
    {
      ...request,
      solver: {
        force_transient: true,
        transient_fallback: false,
        urans_fidelity: "unknown",
      },
    },
  ])
    expect(
      queuedJobReserve(
        { ...original, requestPayload: { engineRequest: changed } },
        config,
      ),
    ).toBeNull();
  expect(queuedJobReserve({ ...original, totalCases: 3 }, config)).toBeNull();
  expect(
    queuedJobReserve({ ...original, completedCases: 1 }, config),
  ).toBeNull();
  expect(
    queuedDiskExposure(
      Array.from({ length: MAX_FORECAST_QUEUE_JOBS + 1 }, () => original),
      8,
      config,
    ).reservedBytes,
  ).toBe(240 * GIB);
  expect(() =>
    queuedJobReserve(original, { ...config, ransCaseReserveBytes: Infinity }),
  ).toThrow("finite storage");
});

it("does not bypass the free-space floor or percentage cutoff", () => {
  const exposure = diskAdmissionExposureForJobs(
    [],
    config,
    8,
    Array.from({ length: 8 }, () => queued()),
  );
  expect(
    evaluateDiskAdmission(
      { total_bytes: 1000 * GIB, free_bytes: 19 * GIB, used_pct: 98.1 },
      exposure,
      config,
    ).allowed,
  ).toBe(false);
  expect(
    evaluateDiskAdmission(
      { total_bytes: 1000 * GIB, free_bytes: 40 * GIB, used_pct: 96 },
      exposure,
      config,
    ).allowed,
  ).toBe(false);
});

it("rounds fractional storage upward exactly at large integer byte limits", () => {
  const measured = { ...config, ransCaseReserveBytes: Number.MAX_SAFE_INTEGER };
  expect(queuedDiskExposure([queued(1, 7)], 2, measured).reservedBytes).toBe(
    Number((BigInt(Number.MAX_SAFE_INTEGER) * 2n + 6n) / 7n),
  );
  expect(() => queuedDiskExposure([queued()], -1, config)).toThrow(
    "capacity bounds",
  );
});
