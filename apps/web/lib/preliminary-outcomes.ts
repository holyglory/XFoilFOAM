import type { AdminCampaignPreliminaryOutcome } from "./admin";

const reasonLabels: Record<string, string> = {
  "non-stationary":
    "The retained cycles did not settle into a repeatable stationary window.",
  "insufficient-periods":
    "Too few repeatable shedding periods were captured for preliminary acceptance.",
  "incomplete-urans-integration":
    "The saved transient needed more integration before it could be averaged.",
  "missing-coefficients": "No usable aerodynamic coefficients were stored.",
  "not-converged": "The solver did not converge to an acceptable solution.",
  "solver-stalled": "The solver stopped making measurable progress.",
  "solver-error": "The solver ended before usable evidence was stored.",
  "not-solved": "The run ended without a completed solved result.",
  "non-positive-drag":
    "The stored drag coefficient was zero or negative and could not be published.",
  "non-physical-coefficients":
    "The stored aerodynamic coefficients were outside the physical acceptance bounds.",
  "missing-force-history":
    "The run did not store the force history required to validate its averages.",
  "missing-urans-video":
    "The run did not store the transient field media required for this URANS evidence tier.",
  "sparse-frame-track":
    "Too few saved field frames were available across the retained periods.",
  "selected-attempt-needs-more-evidence":
    "The selected run still needs more evidence before it can be published.",
  "selected-attempt-rejected":
    "The selected run did not pass the publication gates.",
};

const plural = (value: number, singular: string, pluralForm = `${singular}s`) =>
  `${value} ${value === 1 ? singular : pluralForm}`;

export interface PreliminaryOutcomeView {
  stateLabel: string;
  stateDetail: string;
  budgetLabel: string;
  evidenceLabel: string;
  diagnostics: string[];
}

export function preliminaryOutcomeView(
  item: AdminCampaignPreliminaryOutcome,
): PreliminaryOutcomeView {
  const diagnostics = item.evidenceReasons.map(
    (reason) =>
      reasonLabels[reason] ??
      `Solver diagnostic: ${reason.replace(/[-_]+/g, " ")}.`,
  );

  let stateLabel: string;
  let stateDetail: string;
  if (item.state === "pending") {
    stateLabel = "Preliminary URANS queued";
    stateDetail =
      "RANS has handed this angle to the automatic preliminary solver.";
  } else if (item.state === "running") {
    stateLabel = "Preliminary URANS running";
    stateDetail = "Automatic preliminary recovery is still producing evidence.";
  } else if (item.outcome === "evidence_unavailable") {
    stateLabel = "Preliminary URANS unavailable";
    stateDetail =
      "The automatic runs completed, but their evidence did not meet the publication gates.";
  } else if (item.outcome === "continuation_unavailable") {
    stateLabel = "Preliminary URANS unavailable";
    stateDetail =
      "The first transient window needed continuation, but the saved state could not be restarted for the corrective run.";
    diagnostics.unshift(
      "The corrective preliminary run ended before it could produce a second evidence record.",
    );
  } else if (item.outcome === "mesh_unavailable") {
    stateLabel = "Preliminary mesh unavailable";
    stateDetail =
      "Automatic safer-mesh recovery did not produce a usable preliminary mesh.";
  } else if (item.outcome === "submit_unavailable") {
    stateLabel = "Preliminary submit unavailable";
    stateDetail =
      "The engine did not accept the bounded automatic preliminary submission.";
  } else {
    stateLabel = "Preliminary result unavailable";
    stateDetail =
      "Automatic recovery ended without publishable preliminary evidence.";
  }

  const evidence: string[] = [];
  if (item.ransEvidenceRuns > 0) {
    evidence.push(plural(item.ransEvidenceRuns, "RANS evidence record"));
  }
  if (item.preliminaryEvidenceRuns > 0) {
    evidence.push(
      plural(item.preliminaryEvidenceRuns, "preliminary URANS evidence record"),
    );
  }
  if (item.fullUransEvidenceRuns > 0) {
    evidence.push(
      plural(item.fullUransEvidenceRuns, "full URANS evidence record"),
    );
  }
  if (item.legacyUransEvidenceRuns > 0) {
    evidence.push(
      `${plural(item.legacyUransEvidenceRuns, "URANS evidence record")} · fidelity tier not recorded`,
    );
  }
  if (item.interruptedPhysicalRuns > 0) {
    evidence.push(
      plural(
        item.interruptedPhysicalRuns,
        "preliminary run interrupted before evidence",
        "preliminary runs interrupted before evidence",
      ),
    );
  }

  const nonPhysicalNote =
    item.nonPhysicalSubmissions > 0
      ? ` · ${plural(item.nonPhysicalSubmissions, "submission")} ended before a physical CFD run and did not consume that budget`
      : "";

  return {
    stateLabel,
    stateDetail,
    budgetLabel: `automatic physical runs ${item.physicalAttemptsUsed}/${item.physicalAttemptsMax} used${nonPhysicalNote}`,
    evidenceLabel:
      evidence.length > 0
        ? `evidence history: ${evidence.join(" · ")}`
        : "no solver evidence record stored yet",
    diagnostics,
  };
}
