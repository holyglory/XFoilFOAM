import { describe, expect, it } from "vitest";

import type { AdminCampaignPreliminaryOutcome } from "../lib/admin";
import {
  preliminaryOutcomeCurrentCounts,
  preliminaryOutcomeCurrentStage,
  preliminaryOutcomeView,
} from "../lib/preliminary-outcomes";

function outcome(
  overrides: Partial<AdminCampaignPreliminaryOutcome> = {},
): AdminCampaignPreliminaryOutcome {
  return {
    aoaDeg: 10,
    sourceAoaDeg: 10,
    derivedBySymmetry: false,
    affectedAoaDegs: [10],
    affectedPointCount: 1,
    state: "blocked",
    outcome: "continuation_unavailable",
    ransStage: "screened",
    fastState: "critical",
    finalState: "not_started",
    finalActivityState: null,
    finalComparison: null,
    finalDeltaCl: null,
    finalDeltaCd: null,
    finalDeltaCm: null,
    finalSource: null,
    criticalStage: "fast",
    fastResultId: null,
    fastResultAttemptId: null,
    finalResultId: null,
    finalResultAttemptId: null,
    finalEvidenceReasons: [],
    finalSubmitError: null,
    finalSubmitHttpStatus: null,
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

describe("per-angle solver flow copy", () => {
  it("MUST-CATCH: fast URANS exhaustion is a critical incident, while run accounting stays diagnostic", () => {
    const view = preliminaryOutcomeView(outcome());

    expect(view.fastLabel).toBe("Critical");
    expect(view.ransLabel).toBe("Screened");
    expect(view.finalLabel).toBe("Next");
    expect(view.statusLabel).toBe("Fast critical");
    expect(view.statusTone).toBe("critical");
    expect(view.critical).toBe(true);
    expect(view.budgetLabel).toBe("Fast URANS physical runs: 2 of 2");
    expect(view.evidenceLabel).toContain("2 RANS");
    expect(view.evidenceLabel).toContain("1 fast URANS");
    expect(view.evidenceLabel).toContain("1 interrupted before evidence");
    expect(view.diagnostics.join(" ")).toContain(
      "could not restart from its saved transient state",
    );
    expect(view.diagnostics.join(" ")).toContain(
      "1 engine submission ended before CFD and did not count as a physical run",
    );
    expect(JSON.stringify(view)).not.toMatch(/no action required/i);
    expect(JSON.stringify(view)).not.toMatch(/RANS failure/i);
  });

  it.each([
    {
      ransStage: "polar_handoff" as const,
      label: "Polar handoff",
      diagnostic: "parent polar handed this point",
    },
    {
      ransStage: "skipped" as const,
      label: "Skipped",
      diagnostic: "no RANS run for this point",
    },
  ])(
    "keeps the per-point RANS stage truthful for $ransStage",
    ({ ransStage, label, diagnostic }) => {
      const view = preliminaryOutcomeView(
        outcome({
          ransStage,
          ransEvidenceRuns: 0,
        }),
      );

      expect(view.ransLabel).toBe(label);
      expect(view.ransDiagnostic).toContain(diagnostic);
      expect(view.ransDiagnostic).not.toMatch(/screening complete/i);
    },
  );

  it("MUST-CATCH: exceptional screening recovery is critical in the same per-point flow and does not pretend fast URANS ran", () => {
    const view = preliminaryOutcomeView(
      outcome({
        state: "blocked",
        outcome: "recovery_unavailable",
        ransStage: "not_started",
        fastState: "not_started",
        finalState: "not_started",
        criticalStage: "preflight",
        physicalAttemptsUsed: 0,
        interruptedPhysicalRuns: 0,
        preliminaryEvidenceRuns: 0,
        nonPhysicalSubmissions: 0,
        evidenceReasons: ["mesh-quality-failure"],
      }),
    );

    expect(view.ransLabel).toBe("Not started");
    expect(view.fastLabel).toBe("Next");
    expect(view.finalLabel).toBe("Next");
    expect(view.statusLabel).toBe("Pre-solver repair critical");
    expect(view.statusTone).toBe("critical");
    expect(view.budgetLabel).toBe("Fast URANS has not started.");
    expect(view.diagnostics.join(" ")).toContain(
      "Automatic mesh repair exhausted the available strategy",
    );
    expect(
      preliminaryOutcomeCurrentStage(
        outcome({
          ransStage: "not_started",
          fastState: "not_started",
          criticalStage: "preflight",
        }),
      ),
    ).toBe("preflight");
  });

  it.each([
    {
      fastState: "queued" as const,
      state: "pending" as const,
      fastLabel: "Queued",
      status: "Fast queued",
    },
    {
      fastState: "running" as const,
      state: "running" as const,
      fastLabel: "Running",
      status: "Fast running",
    },
  ])(
    "renders automatic fast state $fastState without calling RANS failed",
    (entry) => {
      const view = preliminaryOutcomeView(
        outcome({
          state: entry.state,
          outcome: "recovering",
          fastState: entry.fastState,
          criticalStage: null,
          physicalAttemptsUsed: entry.fastState === "queued" ? 0 : 1,
          interruptedPhysicalRuns: 0,
          preliminaryEvidenceRuns: entry.fastState === "queued" ? 0 : 1,
          nonPhysicalSubmissions: 0,
          evidenceReasons: [],
        }),
      );

      expect(view.fastLabel).toBe(entry.fastLabel);
      expect(view.finalLabel).toBe("Next");
      expect(view.statusLabel).toBe(entry.status);
      expect(view.statusTone).toBe("violet");
      expect(view.critical).toBe(false);
    },
  );

  it("shows an accepted fast result and queued final verification as distinct stages", () => {
    const view = preliminaryOutcomeView(
      outcome({
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "queued",
        finalSource: "verify",
        criticalStage: null,
        fastResultId: "fast-result",
        fastResultAttemptId: "fast-attempt",
        physicalAttemptsUsed: 1,
        interruptedPhysicalRuns: 0,
        nonPhysicalSubmissions: 0,
        evidenceReasons: [],
      }),
    );

    expect(view.fastLabel).toBe("Accepted");
    expect(view.finalLabel).toBe("Queued");
    expect(view.statusLabel).toBe("Final queued");
    expect(view.statusTone).toBe("violet");
  });

  it("renders exact accepted final evidence as verified", () => {
    const view = preliminaryOutcomeView(
      outcome({
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "accepted",
        finalComparison: "within_tolerance",
        finalDeltaCl: 0.01,
        finalDeltaCd: 0.001,
        finalDeltaCm: null,
        finalSource: "verify",
        criticalStage: null,
        finalResultId: "final-result",
        finalResultAttemptId: "final-attempt",
        interruptedPhysicalRuns: 0,
        nonPhysicalSubmissions: 0,
        evidenceReasons: [],
        fullUransEvidenceRuns: 1,
      }),
    );

    expect(view.finalLabel).toBe("Verified");
    expect(view.statusLabel).toBe("Final verified");
    expect(view.statusTone).toBe("teal");
    expect(view.critical).toBe(false);
  });

  it("keeps an accepted final result but raises a critical comparison mismatch", () => {
    const view = preliminaryOutcomeView(
      outcome({
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "accepted",
        finalComparison: "disagreed",
        finalDeltaCl: 0.061,
        finalDeltaCd: -0.012,
        finalDeltaCm: null,
        finalSource: "verify",
        criticalStage: "final",
        finalResultId: "final-result",
        finalResultAttemptId: "final-attempt",
        interruptedPhysicalRuns: 0,
        nonPhysicalSubmissions: 0,
        evidenceReasons: [],
      }),
    );

    expect(view.finalLabel).toBe("Verified · mismatch");
    expect(view.statusLabel).toBe("Verified · mismatch");
    expect(view.statusTone).toBe("critical");
    expect(view.diagnostics.join(" ")).toContain("ΔCl +0.0610");
    expect(view.diagnostics.join(" ")).toContain("ΔCd -0.01200");
  });

  it("keeps incremental accepted final evidence visible while its whole-polar job is still running", () => {
    const view = preliminaryOutcomeView(
      outcome({
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "accepted",
        finalActivityState: "running",
        finalSource: "full_request",
        criticalStage: null,
        finalResultId: "final-result",
        finalResultAttemptId: "final-attempt",
        interruptedPhysicalRuns: 0,
        nonPhysicalSubmissions: 0,
        evidenceReasons: [],
      }),
    );

    expect(view.finalLabel).toBe("Verified + running");
    expect(view.statusLabel).toBe("Verified · rerun running");
    expect(view.statusTone).toBe("violet");
  });

  it("keeps accepted final evidence visible while a newer final activity is critical", () => {
    const view = preliminaryOutcomeView(
      outcome({
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "accepted",
        finalActivityState: "critical",
        finalSource: "full_request",
        criticalStage: null,
        finalResultId: "retained-final-result",
        finalResultAttemptId: "retained-final-attempt",
        interruptedPhysicalRuns: 0,
        nonPhysicalSubmissions: 0,
        evidenceReasons: [],
      }),
    );

    expect(view.finalLabel).toBe("Verified + incident");
    expect(view.statusLabel).toBe("Verified · rerun critical");
    expect(view.statusTone).toBe("critical");
    expect(view.critical).toBe(true);
    expect(view.diagnostics.join(" ")).toContain(
      "Accepted final evidence is retained",
    );
  });

  it("assigns exactly one current rail stage across queued, accepted, and accepted-plus-activity states", () => {
    expect(
      preliminaryOutcomeCurrentStage(
        outcome({
          ransStage: "not_started",
          fastState: "not_started",
          finalState: "not_started",
          criticalStage: "preflight",
        }),
      ),
    ).toBe("preflight");
    expect(
      preliminaryOutcomeCurrentStage(
        outcome({
          fastState: "queued",
          finalState: "not_started",
          finalActivityState: null,
        }),
      ),
    ).toBe("fast");
    expect(
      preliminaryOutcomeCurrentStage(
        outcome({
          fastState: "accepted",
          finalState: "accepted",
          finalActivityState: null,
        }),
      ),
    ).toBe("final");
    expect(
      preliminaryOutcomeCurrentStage(
        outcome({
          fastState: "critical",
          finalState: "running",
          finalActivityState: null,
        }),
      ),
    ).toBe("final");
    expect(
      preliminaryOutcomeCurrentStage(
        outcome({
          fastState: "accepted",
          finalState: "accepted",
          finalActivityState: "critical",
        }),
      ),
    ).toBe("final");
  });

  it("reports mutually exclusive current-state totals even when accepted evidence has newer activity", () => {
    const items = [
      outcome({
        aoaDeg: 0,
        state: "pending",
        outcome: "recovering",
        fastState: "queued",
        finalState: "not_started",
        criticalStage: null,
      }),
      outcome({
        aoaDeg: 1,
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "not_started",
        criticalStage: null,
      }),
      outcome({
        aoaDeg: 2,
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "accepted",
        criticalStage: null,
      }),
      outcome({
        aoaDeg: 3,
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "accepted",
        finalActivityState: "running",
        criticalStage: null,
      }),
      outcome({
        aoaDeg: 4,
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "accepted",
        finalActivityState: "critical",
        criticalStage: "final",
      }),
    ];

    const counts = preliminaryOutcomeCurrentCounts(items);
    expect(counts).toEqual({
      active: 2,
      fastReady: 1,
      verified: 1,
      critical: 1,
      total: 5,
    });
    expect(
      counts.active + counts.fastReady + counts.verified + counts.critical,
    ).toBe(counts.total);
  });

  it("does not hide a fast-stage incident behind later final work", () => {
    const view = preliminaryOutcomeView(
      outcome({
        finalState: "running",
        finalSource: "verify",
      }),
    );

    expect(view.statusLabel).toBe("Fast critical · final running");
    expect(view.statusTone).toBe("critical");
  });

  it("makes a missing accepted final result critical and keeps service detail collapsed-ready", () => {
    const view = preliminaryOutcomeView(
      outcome({
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "critical",
        finalSource: "full_request",
        criticalStage: "final",
        finalSubmitHttpStatus: 422,
        finalSubmitError: "solver rejected request",
        interruptedPhysicalRuns: 0,
        nonPhysicalSubmissions: 0,
        evidenceReasons: [],
      }),
    );

    expect(view.finalLabel).toBe("Critical");
    expect(view.statusLabel).toBe("Final critical");
    expect(view.diagnostics.join(" ")).toContain(
      "Final URANS did not produce an accepted result",
    );
    expect(view.diagnostics.join(" ")).toContain(
      "Solver service HTTP 422: solver rejected request",
    );
  });

  it("keeps unknown classifier reasons honest", () => {
    const view = preliminaryOutcomeView(
      outcome({
        outcome: "evidence_unavailable",
        interruptedPhysicalRuns: 0,
        preliminaryEvidenceRuns: 0,
        legacyUransEvidenceRuns: 1,
        nonPhysicalSubmissions: 0,
        evidenceReasons: [
          "non-positive-drag",
          "missing-force-history",
          "future-classifier-reason",
        ],
      }),
    );

    expect(view.evidenceLabel).toContain("1 legacy URANS (tier unrecorded)");
    expect(view.diagnostics).toContain(
      "The stored drag coefficient was zero or negative and could not be published.",
    );
    expect(view.diagnostics).toContain(
      "The run did not store the force history required to validate its averages.",
    );
    expect(view.diagnostics).toContain(
      "Solver diagnostic: future classifier reason.",
    );
  });
});
