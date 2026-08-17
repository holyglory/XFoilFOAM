import { describe, expect, it } from "vitest";

import {
  effectiveMaxConcurrentJobs,
  submitOneLocalFastLane,
} from "../src/loop";

describe("automatic concurrent-job admission", () => {
  it("uses the engine worker budget when the legacy cap is auto", () => {
    expect(effectiveMaxConcurrentJobs(0, 0, 8)).toBe(8);
  });

  it("honours the visible CPU-slot cap before the auto worker budget", () => {
    expect(effectiveMaxConcurrentJobs(0, 3, 8)).toBe(3);
  });

  it("lets the visible CPU-slot control supersede the legacy API override", () => {
    expect(effectiveMaxConcurrentJobs(5, 8, 8)).toBe(8);
  });

  it("fails safely to the conservative local default for malformed capacity", () => {
    expect(effectiveMaxConcurrentJobs(0, 0, Number.NaN)).toBe(2);
  });
});

describe("local FAST admission priority", () => {
  it("lets recorded promotion short-circuit campaign PRECALC work", async () => {
    const calls: string[] = [];
    const outcome = await submitOneLocalFastLane({
      promotion: async () => (calls.push("promotion"), true),
      campaignRecovery: async () => (calls.push("campaign"), true),
    });

    expect(calls).toEqual(["promotion"]);
    expect(outcome).toEqual({
      promotedSubmitted: true,
      campaignTargetedSubmitted: false,
    });
  });

  it("falls through directly to ordinary campaign PRECALC work", async () => {
    const calls: string[] = [];
    const outcome = await submitOneLocalFastLane({
      promotion: async () => (calls.push("promotion"), false),
      campaignRecovery: async () => (calls.push("campaign"), true),
    });

    expect(calls).toEqual(["promotion", "campaign"]);
    expect(outcome).toEqual({
      promotedSubmitted: false,
      campaignTargetedSubmitted: true,
    });
  });
});
