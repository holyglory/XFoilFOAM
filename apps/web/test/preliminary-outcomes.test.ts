import { describe, expect, it } from "vitest";

import type { AdminCampaignPreliminaryOutcome } from "../lib/admin";
import { preliminaryOutcomeView } from "../lib/preliminary-outcomes";

function outcome(
  overrides: Partial<AdminCampaignPreliminaryOutcome> = {},
): AdminCampaignPreliminaryOutcome {
  return {
    aoaDeg: 10,
    affectedAoaDegs: [10],
    affectedPointCount: 1,
    state: "blocked",
    outcome: "continuation_unavailable",
    physicalAttemptsUsed: 2,
    physicalAttemptsMax: 2,
    recoverySubmissions: 3,
    nonPhysicalSubmissions: 1,
    interruptedPhysicalRuns: 1,
    ransEvidenceRuns: 2,
    preliminaryEvidenceRuns: 1,
    fullUransEvidenceRuns: 0,
    legacyUransEvidenceRuns: 0,
    evidenceReasons: ["incomplete-urans-integration", "non-stationary"],
    updatedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("preliminary outcome copy", () => {
  it("MUST-CATCH: distinguishes physical recovery runs from evidence records and interrupted continuation", () => {
    const view = preliminaryOutcomeView(outcome());

    expect(view.stateLabel).toBe("Preliminary URANS unavailable");
    expect(view.stateDetail).toContain("could not be restarted");
    expect(view.budgetLabel).toContain("automatic physical runs 2/2 used");
    expect(view.budgetLabel).toContain(
      "1 submission ended before a physical CFD run and did not consume that budget",
    );
    expect(view.evidenceLabel).toContain("2 RANS evidence records");
    expect(view.evidenceLabel).toContain("1 preliminary URANS evidence record");
    expect(view.evidenceLabel).toContain(
      "1 preliminary run interrupted before evidence",
    );
    expect(view.diagnostics.join(" ")).toContain(
      "corrective preliminary run ended before",
    );
    expect(view.diagnostics.join(" ")).toContain("needed more integration");
  });

  it("describes two classifier-rejected preliminary evidence runs without calling RANS escalation a failure", () => {
    const view = preliminaryOutcomeView(
      outcome({
        aoaDeg: 3,
        outcome: "evidence_unavailable",
        interruptedPhysicalRuns: 0,
        preliminaryEvidenceRuns: 2,
        evidenceReasons: ["non-stationary", "insufficient-periods"],
      }),
    );

    expect(view.stateDetail).toContain("did not meet the publication gates");
    expect(view.evidenceLabel).toContain(
      "2 preliminary URANS evidence records",
    );
    expect(view.evidenceLabel).not.toContain("interrupted");
    expect(view.diagnostics).toEqual([
      "The retained cycles did not settle into a repeatable stationary window.",
      "Too few repeatable shedding periods were captured for preliminary acceptance.",
    ]);
  });

  it("keeps active preliminary work visibly non-terminal", () => {
    const view = preliminaryOutcomeView(
      outcome({
        state: "running",
        outcome: "recovering",
        physicalAttemptsUsed: 1,
        interruptedPhysicalRuns: 0,
      }),
    );

    expect(view.stateLabel).toBe("Preliminary URANS running");
    expect(view.budgetLabel).toContain("1/2 used");
    expect(view.stateDetail).toContain("still producing evidence");
  });

  it("keeps unknown diagnostics visible and labels legacy URANS without inventing a fidelity tier", () => {
    const view = preliminaryOutcomeView(
      outcome({
        outcome: "evidence_unavailable",
        interruptedPhysicalRuns: 0,
        preliminaryEvidenceRuns: 0,
        legacyUransEvidenceRuns: 1,
        evidenceReasons: [
          "non-positive-drag",
          "missing-force-history",
          "future-classifier-reason",
        ],
      }),
    );

    expect(view.evidenceLabel).toContain(
      "1 URANS evidence record · fidelity tier not recorded",
    );
    expect(view.diagnostics).toEqual([
      "The stored drag coefficient was zero or negative and could not be published.",
      "The run did not store the force history required to validate its averages.",
      "Solver diagnostic: future classifier reason.",
    ]);
  });
});
