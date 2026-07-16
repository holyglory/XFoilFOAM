import type { AdminCampaignPreliminaryOutcome } from "./admin";

const reasonLabels: Record<string, string> = {
  "non-stationary":
    "The retained cycles did not settle into a repeatable stationary window.",
  "insufficient-periods":
    "Too few repeatable shedding periods were captured for preliminary acceptance.",
  "incomplete-urans-integration":
    "The saved transient needed more integration before it could be averaged.",
  "missing-coefficients": "No usable aerodynamic coefficients were stored.",
  "not-converged": "The URANS solve did not reach an acceptable solution.",
  "solver-stalled": "The URANS solve stopped making measurable progress.",
  "solver-error": "The URANS solve ended before usable evidence was stored.",
  "not-solved": "The URANS run ended without a completed result.",
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
  "mesh-quality-failure":
    "Automatic mesh repair exhausted the available strategy.",
  "engine-infrastructure-failure":
    "The solver runtime stopped after automatic recovery.",
  "solver-execution-failed":
    "RANS screening could not execute after automatic recovery.",
  "auto-retry-exhausted": "Automatic screening recovery was exhausted.",
};

const plural = (value: number, singular: string, pluralForm = `${singular}s`) =>
  `${value} ${value === 1 ? singular : pluralForm}`;

const diagnosticFor = (reason: string) =>
  reasonLabels[reason] ??
  `Solver diagnostic: ${reason.replace(/[-_]+/g, " ")}.`;

export interface PreliminaryOutcomeView {
  ransStage: AdminCampaignPreliminaryOutcome["ransStage"];
  ransLabel: string;
  ransDiagnostic: string;
  fastState: AdminCampaignPreliminaryOutcome["fastState"];
  finalState: AdminCampaignPreliminaryOutcome["finalState"];
  fastLabel: string;
  finalLabel: string;
  statusLabel: string;
  statusTone: "teal" | "violet" | "muted" | "critical";
  critical: boolean;
  budgetLabel: string;
  evidenceLabel: string;
  diagnostics: string[];
}

export type PreliminaryOutcomeCurrentStage = "preflight" | "fast" | "final";

export interface PreliminaryOutcomeCurrentCounts {
  active: number;
  fastReady: number;
  verified: number;
  critical: number;
  total: number;
}

export function preliminaryOutcomeIsCritical(
  item: AdminCampaignPreliminaryOutcome,
): boolean {
  return (
    item.criticalStage !== null ||
    item.fastState === "critical" ||
    item.finalState === "critical" ||
    item.finalActivityState === "critical" ||
    item.finalComparison === "disagreed"
  );
}

/** The rail describes one point's current solver journey. Normal rows have
 * already completed or skipped RANS, while a rare pre-URANS recovery incident
 * keeps the first stage current. */
export function preliminaryOutcomeCurrentStage(
  item: AdminCampaignPreliminaryOutcome,
): PreliminaryOutcomeCurrentStage {
  if (item.criticalStage === "preflight") {
    return "preflight";
  }
  return item.finalState !== "not_started" ||
    item.finalActivityState !== null ||
    item.finalComparison !== null
    ? "final"
    : "fast";
}

/**
 * Mutually exclusive current-state totals. The API also exposes useful
 * evidence facets, but those can overlap (for example, accepted evidence can
 * coexist with a newer final run). Header counts must not imply otherwise.
 */
export function preliminaryOutcomeCurrentCounts(
  items: AdminCampaignPreliminaryOutcome[],
): PreliminaryOutcomeCurrentCounts {
  const counts: PreliminaryOutcomeCurrentCounts = {
    active: 0,
    fastReady: 0,
    verified: 0,
    critical: 0,
    total: items.length,
  };

  for (const item of items) {
    if (preliminaryOutcomeIsCritical(item)) {
      counts.critical += 1;
    } else if (
      item.fastState === "queued" ||
      item.fastState === "running" ||
      item.finalState === "queued" ||
      item.finalState === "running" ||
      item.finalActivityState === "queued" ||
      item.finalActivityState === "running"
    ) {
      counts.active += 1;
    } else if (item.finalState === "accepted") {
      counts.verified += 1;
    } else {
      counts.fastReady += 1;
    }
  }

  return counts;
}

export function preliminaryOutcomeView(
  item: AdminCampaignPreliminaryOutcome,
): PreliminaryOutcomeView {
  const rans = {
    screened: {
      label: "Screened",
      diagnostic: "RANS handed off automatically.",
    },
    polar_handoff: {
      label: "Polar handoff",
      diagnostic: "The parent polar handed this point to fast URANS.",
    },
    skipped: {
      label: "Skipped",
      diagnostic: "Direct fast-URANS request; no RANS run for this point.",
    },
    not_started: {
      label: "Not started",
      diagnostic:
        "Automatic mesh/runtime repair exhausted before RANS screening could start.",
    },
  }[item.ransStage];
  const fastLabel = {
    not_started: "Next",
    queued: "Queued",
    running: "Running",
    accepted: "Accepted",
    critical: "Critical",
  }[item.fastState];
  let finalLabel = {
    not_started: "Next",
    queued: "Queued",
    running: "Running",
    accepted: "Verified",
    critical: "Critical",
  }[item.finalState];
  if (item.finalComparison === "disagreed") {
    finalLabel = "Verified · mismatch";
  } else if (item.finalState === "accepted" && item.finalActivityState) {
    finalLabel =
      item.finalActivityState === "critical"
        ? "Verified + incident"
        : `Verified + ${item.finalActivityState}`;
  }

  let status: {
    label: string;
    tone: "teal" | "violet" | "muted" | "critical";
  };
  if (item.criticalStage === "preflight") {
    status = { label: "Pre-solver repair critical", tone: "critical" };
  } else if (item.finalComparison === "disagreed") {
    status = { label: "Verified · mismatch", tone: "critical" };
  } else if (
    item.finalState === "accepted" &&
    item.finalActivityState === "critical"
  ) {
    status = { label: "Verified · rerun critical", tone: "critical" };
  } else if (item.finalState === "accepted" && item.fastState === "critical") {
    status = { label: "Verified · fast incident", tone: "critical" };
  } else if (
    item.finalState === "accepted" &&
    item.finalActivityState !== null
  ) {
    status = {
      label: `Verified · rerun ${item.finalActivityState}`,
      tone: "violet",
    };
  } else if (item.finalState === "critical") {
    status = {
      label:
        item.fastState === "critical"
          ? "Fast + final critical"
          : "Final critical",
      tone: "critical",
    };
  } else if (item.finalState === "accepted") {
    status = { label: "Final verified", tone: "teal" };
  } else if (item.finalState === "running") {
    status = {
      label:
        item.fastState === "critical"
          ? "Fast critical · final running"
          : "Final running",
      tone: item.fastState === "critical" ? "critical" : "violet",
    };
  } else if (item.finalState === "queued") {
    status = {
      label:
        item.fastState === "critical"
          ? "Fast critical · final queued"
          : "Final queued",
      tone: item.fastState === "critical" ? "critical" : "violet",
    };
  } else if (item.fastState === "critical") {
    status = { label: "Fast critical", tone: "critical" };
  } else if (item.fastState === "accepted") {
    status = { label: "Fast result ready", tone: "muted" };
  } else if (item.fastState === "running") {
    status = { label: "Fast running", tone: "violet" };
  } else {
    status = { label: "Fast queued", tone: "violet" };
  }

  const evidence: string[] = [];
  if (item.ransEvidenceRuns > 0) {
    evidence.push(`${item.ransEvidenceRuns} RANS`);
  }
  if (item.preliminaryEvidenceRuns > 0) {
    evidence.push(`${item.preliminaryEvidenceRuns} fast URANS`);
  }
  if (item.fullUransEvidenceRuns > 0) {
    evidence.push(`${item.fullUransEvidenceRuns} final URANS`);
  }
  if (item.legacyUransEvidenceRuns > 0) {
    evidence.push(
      `${item.legacyUransEvidenceRuns} legacy URANS (tier unrecorded)`,
    );
  }
  if (item.interruptedPhysicalRuns > 0) {
    evidence.push(
      `${item.interruptedPhysicalRuns} interrupted before evidence`,
    );
  }

  const diagnostics = [
    ...item.evidenceReasons.map(diagnosticFor),
    ...item.finalEvidenceReasons.map(diagnosticFor),
  ];
  if (item.fastState === "critical") {
    if (item.outcome === "evidence_unavailable") {
      diagnostics.unshift(
        "Fast URANS completed, but no run passed the publication checks.",
      );
    } else if (item.outcome === "continuation_unavailable") {
      diagnostics.unshift(
        "The corrective fast run could not restart from its saved transient state.",
      );
    } else if (item.outcome === "mesh_unavailable") {
      diagnostics.unshift(
        "Automatic mesh repair did not produce a usable fast-solver mesh.",
      );
    } else if (item.outcome === "submit_unavailable") {
      diagnostics.unshift(
        "The solver service rejected the automatic fast-run submission.",
      );
    } else {
      diagnostics.unshift(
        "Automatic fast URANS ended without publishable evidence.",
      );
    }
  }
  if (item.criticalStage === "preflight") {
    diagnostics.unshift(
      "RANS and fast URANS did not start because automatic mesh/runtime repair exhausted first.",
    );
  }
  if (item.finalComparison === "disagreed") {
    const deltas = [
      item.finalDeltaCl == null
        ? null
        : `ΔCl ${item.finalDeltaCl >= 0 ? "+" : ""}${item.finalDeltaCl.toFixed(4)}`,
      item.finalDeltaCd == null
        ? null
        : `ΔCd ${item.finalDeltaCd >= 0 ? "+" : ""}${item.finalDeltaCd.toFixed(5)}`,
      item.finalDeltaCm == null
        ? null
        : `ΔCm ${item.finalDeltaCm >= 0 ? "+" : ""}${item.finalDeltaCm.toFixed(4)}`,
    ].filter(Boolean);
    diagnostics.unshift(
      `The final result exists, but it differs from the fast result${deltas.length ? ` (${deltas.join(", ")})` : ""}.`,
    );
  } else if (item.finalState === "critical") {
    diagnostics.unshift(
      "Final URANS did not produce an accepted result; automatic investigation is required.",
    );
  } else if (
    item.finalState === "accepted" &&
    item.finalActivityState === "critical"
  ) {
    diagnostics.unshift(
      "Accepted final evidence is retained; a newer final run ended critically and requires automatic investigation.",
    );
  }
  if (item.finalSubmitError) {
    diagnostics.push(
      `${item.finalSubmitHttpStatus ? `Solver service HTTP ${item.finalSubmitHttpStatus}: ` : "Solver service: "}${item.finalSubmitError}`,
    );
  }
  if (item.nonPhysicalSubmissions > 0) {
    diagnostics.push(
      `${plural(item.nonPhysicalSubmissions, "engine submission")} ended before CFD and did not count as a physical run.`,
    );
  }

  return {
    ransStage: item.ransStage,
    ransLabel: rans.label,
    ransDiagnostic: rans.diagnostic,
    fastState: item.fastState,
    finalState: item.finalState,
    fastLabel,
    finalLabel,
    statusLabel: status.label,
    statusTone: status.tone,
    critical: preliminaryOutcomeIsCritical(item),
    budgetLabel:
      item.fastState === "not_started"
        ? "Fast URANS has not started."
        : `Fast URANS physical runs: ${item.physicalAttemptsUsed} of ${item.physicalAttemptsMax}`,
    evidenceLabel:
      evidence.length > 0
        ? `Stored evidence: ${evidence.join(" · ")}`
        : "No solver evidence stored yet",
    diagnostics: [...new Set(diagnostics)],
  };
}
