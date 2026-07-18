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
  it("MUST-CATCH: shows a requested point at the RANS stage before any handoff exists", () => {
    const queuedRans = outcome({
      state: "pending",
      outcome: "recovering",
      ransStage: "not_started",
      fastState: "not_started",
      finalState: "not_started",
      criticalStage: null,
      physicalAttemptsUsed: 0,
      physicalAttemptsMax: 0,
      ransEvidenceRuns: 0,
      preliminaryEvidenceRuns: 0,
      evidenceReasons: [],
    });

    const view = preliminaryOutcomeView(queuedRans);
    expect(preliminaryOutcomeCurrentStage(queuedRans)).toBe("rans");
    expect(view.ransLabel).toBe("Queued");
    expect(view.fastLabel).toBe("Waiting");
    expect(view.finalLabel).toBe("Waiting");
    expect(view.statusLabel).toBe("RANS · queued");
    expect(view.statusTone).toBe("violet");
    expect(view.critical).toBe(false);
    expect(view.budgetLabel).toBe("Fast URANS · waits for RANS handoff");
  });

  it("MUST-CATCH: shows an accepted RANS point as complete without inventing URANS work", () => {
    const acceptedRans = outcome({
      state: "satisfied",
      outcome: "accepted",
      ransStage: "screened",
      fastState: "not_started",
      finalState: "not_started",
      criticalStage: null,
      physicalAttemptsUsed: 0,
      physicalAttemptsMax: 0,
      ransEvidenceRuns: 1,
      preliminaryEvidenceRuns: 0,
      evidenceReasons: [],
    });

    const view = preliminaryOutcomeView(acceptedRans);
    expect(preliminaryOutcomeCurrentStage(acceptedRans)).toBe("rans");
    expect(view.ransLabel).toBe("Accepted");
    expect(view.fastLabel).toBe("Not needed");
    expect(view.finalLabel).toBe("Not needed");
    expect(view.statusLabel).toBe("RANS · accepted");
    expect(view.statusTone).toBe("teal");
    expect(view.critical).toBe(false);
    expect(view.budgetLabel).toBe("Fast URANS · not required");
  });

  it("MUST-CATCH: a screened non-publishable RANS point awaiting obligation repair remains a neutral fast handoff", () => {
    const handoff = outcome({
      state: "pending",
      outcome: "recovering",
      ransStage: "screened",
      fastState: "not_started",
      finalState: "not_started",
      criticalStage: null,
      physicalAttemptsUsed: 0,
      physicalAttemptsMax: 2,
      ransEvidenceRuns: 1,
      preliminaryEvidenceRuns: 0,
      evidenceReasons: ["not-converged", "solver-stalled"],
    });

    const view = preliminaryOutcomeView(handoff);
    expect(view.ransLabel).toBe("Handed off");
    expect(view.fastLabel).toBe("Queued");
    expect(view.finalLabel).toBe("Waiting");
    expect(view.statusLabel).toBe("URANS fast · queued");
    expect(view.statusTone).toBe("violet");
    expect(view.ransAcceptedResult).toBe(false);
    expect(view.ransHandoffPending).toBe(true);
    expect(view.critical).toBe(false);
    expect(view.budgetLabel).toBe("Fast URANS · handoff pending");
    expect(view.diagnostics.join(" ")).not.toContain("URANS did not settle");
    expect(preliminaryOutcomeCurrentCounts([handoff])).toMatchObject({
      active: 1,
      ransAccepted: 0,
      critical: 0,
    });
  });

  it("MUST-CATCH: fast URANS exhaustion is a critical incident, while run accounting stays diagnostic", () => {
    const view = preliminaryOutcomeView(outcome());

    expect(view.fastLabel).toBe("Exhausted");
    expect(view.ransLabel).toBe("Screened");
    expect(view.finalLabel).toBe("Next");
    expect(view.statusLabel).toBe("CRITICAL · FAST URANS EXHAUSTED");
    expect(view.statusTone).toBe("critical");
    expect(view.critical).toBe(true);
    expect(view.ransProvenanceLabel).toBe("2 evidence records");
    expect(view.fastProvenanceLabel).toBe("2/2 physical attempts");
    expect(view.finalProvenanceLabel).toBe("not started");
    expect(view.budgetLabel).toBe("Fast URANS · 2/2 physical attempts");
    expect(view.evidenceLabel).toContain("2 RANS evidence records");
    expect(view.evidenceLabel).toContain("1 fast URANS evidence record");
    expect(view.evidenceLabel).toContain("1 interrupted before evidence");
    expect(view.diagnostics.join(" ")).toContain(
      "Saved-transient recovery exhausted",
    );
    expect(view.diagnostics.join(" ")).toContain(
      "1 engine submission ended before CFD; not a physical run",
    );
    expect(JSON.stringify(view)).not.toMatch(/no action required/i);
    expect(JSON.stringify(view)).not.toMatch(/RANS failure/i);
  });

  it.each([
    {
      ransStage: "polar_handoff" as const,
      label: "Polar handoff",
      diagnostic: "Whole-polar RANS handoff",
    },
    {
      ransStage: "skipped" as const,
      label: "Skipped",
      diagnostic: "RANS skipped",
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
        ransEvidenceRuns: 0,
        preliminaryEvidenceRuns: 0,
        nonPhysicalSubmissions: 0,
        evidenceReasons: ["mesh-quality-failure"],
      }),
    );

    expect(view.ransLabel).toBe("Not started");
    expect(view.fastLabel).toBe("Next");
    expect(view.finalLabel).toBe("Next");
    expect(view.statusLabel).toBe("CRITICAL · SOLVER COULD NOT START");
    expect(view.statusTone).toBe("critical");
    expect(view.budgetLabel).toBe("Fast URANS · not started");
    expect(view.diagnostics.join(" ")).toContain(
      "Automatic mesh repair exhausted",
    );
    expect(view.diagnostics.join(" ")).toContain(
      "RANS and fast URANS did not start",
    );
    expect(
      preliminaryOutcomeCurrentStage(
        outcome({
          ransStage: "not_started",
          fastState: "not_started",
          criticalStage: "preflight",
        }),
      ),
    ).toBe("rans");
  });

  it("MUST-CATCH: attempted RANS recovery exhaustion is critical without pretending RANS never started", () => {
    const attemptedRans = outcome({
      state: "blocked",
      outcome: "recovery_unavailable",
      ransStage: "attempted",
      fastState: "not_started",
      finalState: "not_started",
      criticalStage: "rans",
      physicalAttemptsUsed: 0,
      physicalAttemptsMax: 0,
      ransEvidenceRuns: 2,
      preliminaryEvidenceRuns: 0,
      evidenceReasons: ["solver-execution-failed"],
    });

    const view = preliminaryOutcomeView(attemptedRans);
    expect(preliminaryOutcomeCurrentStage(attemptedRans)).toBe("rans");
    expect(view.ransLabel).toBe("Recovery exhausted");
    expect(view.fastLabel).toBe("Next");
    expect(view.finalLabel).toBe("Next");
    expect(view.statusLabel).toBe("CRITICAL · SCREENING RECOVERY EXHAUSTED");
    expect(view.statusTone).toBe("critical");
    expect(view.evidenceLabel).toContain("2 RANS evidence records");
    expect(view.diagnostics.join(" ")).toContain(
      "RANS attempt evidence exists; automatic recovery exhausted before fast URANS",
    );
    expect(view.diagnostics.join(" ")).not.toContain(
      "RANS and fast URANS did not start",
    );
    expect(preliminaryOutcomeCurrentCounts([attemptedRans])).toMatchObject({
      active: 0,
      critical: 1,
    });
  });

  it.each([
    {
      fastState: "queued" as const,
      state: "pending" as const,
      fastLabel: "Queued",
      status: "URANS fast · queued",
    },
    {
      fastState: "running" as const,
      state: "running" as const,
      fastLabel: "Running",
      status: "URANS fast · running",
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
    expect(view.statusLabel).toBe("URANS final · queued");
    expect(view.statusTone).toBe("violet");
  });

  it("shows an accepted fast result as a successful result while final URANS is next", () => {
    const view = preliminaryOutcomeView(
      outcome({
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "not_started",
        criticalStage: null,
        fastResultId: "fast-result",
        fastResultAttemptId: "fast-attempt",
        physicalAttemptsUsed: 1,
        interruptedPhysicalRuns: 0,
        nonPhysicalSubmissions: 0,
        evidenceReasons: [],
      }),
    );

    expect(view.statusLabel).toBe("URANS fast · ready");
    expect(view.statusTone).toBe("teal");
    expect(view.critical).toBe(false);
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
    expect(view.statusLabel).toBe("URANS final · verified");
    expect(view.statusTone).toBe("teal");
    expect(view.critical).toBe(false);
  });

  it("MUST-CATCH: accepted final evidence stays publishable while fast exhaustion remains a critical incident", () => {
    const item = outcome({
      state: "blocked",
      outcome: "evidence_unavailable",
      fastState: "critical",
      finalState: "accepted",
      finalSource: "full_request",
      criticalStage: "fast",
      finalResultId: "authoritative-final-result",
      finalResultAttemptId: "authoritative-final-attempt",
      fullUransEvidenceRuns: 1,
    });
    const view = preliminaryOutcomeView(item);
    const counts = preliminaryOutcomeCurrentCounts([item]);

    expect(view.fastLabel).toBe("Exhausted");
    expect(view.statusLabel).toBe("URANS final · verified");
    expect(view.statusTone).toBe("teal");
    expect(view.fastRecoveredByFinal).toBe(true);
    expect(view.critical).toBe(true);
    expect(view.incidentStage).toBe("fast");
    expect(view.incidentLabel).toBe("FAST URANS EXHAUSTED");
    expect(view.diagnostics.join(" ")).toContain(
      "Final URANS is authoritative",
    );
    expect(counts).toMatchObject({ verified: 1, critical: 1, total: 1 });
  });

  it("MUST-CATCH: keeps a differing accepted final result verified with a non-critical comparison warning", () => {
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
        criticalStage: null,
        finalResultId: "final-result",
        finalResultAttemptId: "final-attempt",
        interruptedPhysicalRuns: 0,
        nonPhysicalSubmissions: 0,
        evidenceReasons: [],
      }),
    );

    expect(view.finalLabel).toBe("Verified · differs from fast");
    expect(view.statusLabel).toBe("VERIFIED · DIFFERS FROM FAST");
    expect(view.statusTone).toBe("warning");
    expect(view.critical).toBe(false);
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

    expect(view.finalLabel).toBe("Verified + update running");
    expect(view.statusLabel).toBe("URANS final · update running");
    expect(view.statusTone).toBe("violet");
  });

  it("keeps accepted final evidence verified while exposing an exhausted update as a separate critical incident", () => {
    const item = outcome({
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
    });
    const view = preliminaryOutcomeView(item);

    expect(view.finalLabel).toBe("Verified");
    expect(view.statusLabel).toBe("URANS final · verified");
    expect(view.statusTone).toBe("teal");
    expect(view.critical).toBe(true);
    expect(view.incidentStage).toBe("final");
    expect(view.incidentLabel).toBe("FINAL URANS UPDATE EXHAUSTED");
    expect(preliminaryOutcomeCurrentCounts([item])).toMatchObject({
      verified: 1,
      critical: 1,
    });
    expect(view.diagnostics.join(" ")).toContain(
      "Verified result retained; the latest update exhausted recovery",
    );
  });

  it("reports comparison drift and an independently exhausted final update together", () => {
    const view = preliminaryOutcomeView(
      outcome({
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "accepted",
        finalActivityState: "critical",
        finalComparison: "disagreed",
        finalDeltaCl: 0.02,
        finalSource: "full_request",
        criticalStage: null,
        finalResultId: "retained-final-result",
        finalResultAttemptId: "retained-final-attempt",
      }),
    );

    expect(view.finalLabel).toBe("Verified · differs from fast");
    expect(view.critical).toBe(true);
    expect(view.incidentLabel).toBe("FINAL URANS UPDATE EXHAUSTED");
    expect(view.diagnostics.join(" ")).toContain(
      "Fast/final comparison differs",
    );
    expect(view.diagnostics.join(" ")).toContain(
      "Verified result retained; the latest update exhausted recovery",
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
    ).toBe("rans");
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

  it("reports result availability independently from active work and incident facets", () => {
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
        ransStage: "screened",
        fastState: "not_started",
        finalState: "not_started",
        criticalStage: null,
      }),
      outcome({
        aoaDeg: 2,
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "not_started",
        criticalStage: null,
      }),
      outcome({
        aoaDeg: 3,
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "accepted",
        criticalStage: null,
      }),
      outcome({
        aoaDeg: 4,
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "accepted",
        finalActivityState: "running",
        criticalStage: null,
      }),
      outcome({
        aoaDeg: 5,
        state: "satisfied",
        outcome: "accepted",
        fastState: "accepted",
        finalState: "accepted",
        finalActivityState: "critical",
        criticalStage: null,
      }),
    ];

    const counts = preliminaryOutcomeCurrentCounts(items);
    expect(counts).toEqual({
      active: 2,
      ransAccepted: 1,
      fastReady: 1,
      verified: 3,
      critical: 1,
      total: 6,
    });
    expect(
      counts.active +
        counts.ransAccepted +
        counts.fastReady +
        counts.verified +
        counts.critical,
    ).toBeGreaterThan(counts.total);
  });

  it("does not hide a fast-stage incident behind later final work", () => {
    const view = preliminaryOutcomeView(
      outcome({
        finalState: "running",
        finalSource: "verify",
      }),
    );

    expect(view.statusLabel).toBe("URANS final · running");
    expect(view.statusTone).toBe("violet");
    expect(view.critical).toBe(true);
    expect(view.incidentStage).toBe("fast");
    expect(view.incidentLabel).toBe("FAST URANS EXHAUSTED");
  });

  it("makes exhausted final URANS critical and keeps service detail collapsed-ready", () => {
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

    expect(view.finalLabel).toBe("Exhausted");
    expect(view.statusLabel).toBe("CRITICAL · FINAL URANS EXHAUSTED");
    expect(view.finalProvenanceLabel).toBe("recovery exhausted");
    expect(view.diagnostics.join(" ")).toContain(
      "Final URANS recovery exhausted",
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
    expect(view.diagnostics).toContain("Drag coefficient is not publishable.");
    expect(view.diagnostics).toContain(
      "Force history required for averaging is missing.",
    );
    expect(view.diagnostics).toContain("Solver · future classifier reason.");
  });
});
