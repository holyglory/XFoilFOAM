import { describe, expect, it } from "vitest";

import { effectiveMaxConcurrentJobs } from "../src/loop";

describe("automatic concurrent-job admission", () => {
  it("uses the engine worker budget when the legacy cap is auto", () => {
    expect(effectiveMaxConcurrentJobs(0, 0, 8)).toBe(8);
  });

  it("honours the visible CPU-slot cap before the auto worker budget", () => {
    expect(effectiveMaxConcurrentJobs(0, 3, 8)).toBe(3);
  });

  it("retains a positive explicit API override", () => {
    expect(effectiveMaxConcurrentJobs(5, 8, 8)).toBe(5);
  });

  it("fails safely to the conservative local default for malformed capacity", () => {
    expect(effectiveMaxConcurrentJobs(0, 0, Number.NaN)).toBe(2);
  });
});
