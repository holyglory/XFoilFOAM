import { describe, expect, it } from "vitest";

import {
  applyUransBudgetOverrideToEngineRequest,
  freshPointCorrectionBudgetInvariant,
} from "../src/urans-ladder";

const exact = {
  fidelity: "precalc" as const,
  continuation: false,
  configuredBudgetS: 28_800,
  requestedBudgetS: 28_800,
  correctionRunId: "correction-1",
  recordedBudgetS: 28_800,
};

describe("fresh point-correction FAST budget boundary", () => {
  it("accepts only one exact immutable correction/revision/request value", () => {
    expect(freshPointCorrectionBudgetInvariant(exact)).toBeNull();
    const request: { budget_override_s?: number | null } = {};
    applyUransBudgetOverrideToEngineRequest(request, exact);
    expect(request.budget_override_s).toBe(28_800);
  });

  it("leaves the ordinary tier-default FAST path unchanged", () => {
    expect(
      freshPointCorrectionBudgetInvariant({
        ...exact,
        configuredBudgetS: null,
        requestedBudgetS: null,
        correctionRunId: null,
        recordedBudgetS: null,
      }),
    ).toBeNull();
  });

  it("rejects an experimental solver revision on an ordinary campaign owner", () => {
    expect(
      freshPointCorrectionBudgetInvariant({
        ...exact,
        requestedBudgetS: null,
        correctionRunId: null,
        recordedBudgetS: null,
      }),
    ).toMatch(/point-correction owner/);
    expect(() =>
      applyUransBudgetOverrideToEngineRequest(
        {},
        {
          ...exact,
          requestedBudgetS: null,
          correctionRunId: null,
          recordedBudgetS: null,
        },
      ),
    ).toThrow(/point-correction owner/);
  });

  it("rejects correction-provenance and immutable-revision mismatches", () => {
    expect(
      freshPointCorrectionBudgetInvariant({
        ...exact,
        recordedBudgetS: 21_600,
      }),
    ).toMatch(/correction provenance/);
    expect(
      freshPointCorrectionBudgetInvariant({
        ...exact,
        configuredBudgetS: 21_600,
      }),
    ).toMatch(/setup revision/);
  });

  it("rejects a fresh FULL request and leaves exact continuation policy separate", () => {
    expect(
      freshPointCorrectionBudgetInvariant({ ...exact, fidelity: "full" }),
    ).toMatch(/only for FAST/);
    expect(
      freshPointCorrectionBudgetInvariant({
        ...exact,
        continuation: true,
        correctionRunId: null,
        recordedBudgetS: null,
      }),
    ).toBeNull();
  });
});
