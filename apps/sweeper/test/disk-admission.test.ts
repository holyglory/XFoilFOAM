import { describe, expect, it } from "vitest";

import {
  DEFAULT_DISK_JOB_RESERVE_BYTES,
  DEFAULT_DISK_MAX_USED_PCT,
  DEFAULT_DISK_MIN_FREE_BYTES,
  evaluateDiskAdmission,
} from "../src/disk-admission";

const GIB = 1024 ** 3;
const config = {
  maxUsedPct: DEFAULT_DISK_MAX_USED_PCT,
  minFreeBytes: DEFAULT_DISK_MIN_FREE_BYTES,
  jobReserveBytes: DEFAULT_DISK_JOB_RESERVE_BYTES,
};

describe("disk admission", () => {
  it("admits a new job when measured use and reserved headroom are safe", () => {
    expect(
      evaluateDiskAdmission(
        { total_bytes: 300 * GIB, free_bytes: 220 * GIB, used_pct: 26.7 },
        3,
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
      { total_bytes: 300 * GIB, free_bytes: 58 * GIB, used_pct: 80.1 },
      0,
      config,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("80.1% used");
  });

  it("reserves worst-case growth for active jobs and the next admission", () => {
    const decision = evaluateDiskAdmission(
      { total_bytes: 300 * GIB, free_bytes: 110 * GIB, used_pct: 63.3 },
      3,
      config,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("116.0 GiB required for 3 active jobs");
  });

  it("fails closed on an invalid measurement", () => {
    expect(
      evaluateDiskAdmission(
        { total_bytes: 0, free_bytes: Number.NaN, used_pct: 0 },
        0,
        config,
      ),
    ).toMatchObject({
      allowed: false,
      usedPct: null,
      freeBytes: null,
      requiredFreeBytes: null,
    });
  });
});
