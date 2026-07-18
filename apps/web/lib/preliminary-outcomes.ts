import type { AdminCampaignPreliminaryOutcome } from "./admin";

const reasonLabels: Record<string, string> = {
  "non-stationary": "Repeatable averaging window not reached.",
  "insufficient-periods": "Too few repeatable shedding periods.",
  "incomplete-urans-integration": "Transient continuation still needed.",
  "missing-coefficients": "No usable coefficients stored.",
  "not-converged": "URANS did not settle.",
  "solver-stalled": "URANS stopped making measurable progress.",
  "solver-error": "URANS stopped before evidence was stored.",
  "not-solved": "No completed URANS result.",
  "non-positive-drag": "Drag coefficient is not publishable.",
  "non-physical-coefficients": "Coefficients failed physical checks.",
  "missing-force-history": "Force history required for averaging is missing.",
  "missing-urans-video": "Required transient field media is missing.",
  "sparse-frame-track": "Too few saved field frames.",
  "selected-attempt-needs-more-evidence": "More evidence is required.",
  "selected-attempt-rejected": "Publication checks did not pass.",
  "mesh-quality-failure": "Automatic mesh repair exhausted.",
  "engine-infrastructure-failure": "Automatic runtime recovery exhausted.",
  "solver-execution-failed": "Automatic screening recovery exhausted.",
  "auto-retry-exhausted": "Automatic screening recovery exhausted.",
};

const plural = (value: number, singular: string, pluralForm = `${singular}s`) =>
  `${value} ${value === 1 ? singular : pluralForm}`;

const diagnosticFor = (reason: string) =>
  reasonLabels[reason] ?? `Solver · ${reason.replace(/[-_]+/g, " ")}.`;

const NORMAL_RANS_HANDOFF_REASONS = new Set([
  "not-converged",
  "solver-stalled",
  "missing-coefficients",
  "not-solved",
  "selected-attempt-rejected",
]);

export interface PreliminaryOutcomeView {
  ransStage: AdminCampaignPreliminaryOutcome["ransStage"];
  ransLabel: string;
  ransDiagnostic: string;
  fastState: AdminCampaignPreliminaryOutcome["fastState"];
  finalState: AdminCampaignPreliminaryOutcome["finalState"];
  fastLabel: string;
  finalLabel: string;
  statusLabel: string;
  statusTone: "teal" | "violet" | "muted" | "warning" | "critical";
  critical: boolean;
  incidentStage: "preflight" | "rans" | "fast" | "final" | null;
  incidentLabel: string | null;
  ransAcceptedResult: boolean;
  ransHandoffPending: boolean;
  fastRecoveredByFinal: boolean;
  ransProvenanceLabel: string;
  fastProvenanceLabel: string;
  finalProvenanceLabel: string;
  budgetLabel: string;
  evidenceLabel: string;
  diagnostics: string[];
}

export type PreliminaryOutcomeCurrentStage = "rans" | "fast" | "final";

export interface PreliminaryOutcomeCurrentCounts {
  active: number;
  ransAccepted: number;
  fastReady: number;
  verified: number;
  critical: number;
  total: number;
}

function ransAcceptedWithoutUrans(
  item: AdminCampaignPreliminaryOutcome,
): boolean {
  return (
    item.state === "satisfied" &&
    item.outcome === "accepted" &&
    item.ransStage === "screened" &&
    item.fastState === "not_started" &&
    item.finalState === "not_started" &&
    item.criticalStage === null
  );
}

function ransHandoffAwaitingFast(
  item: AdminCampaignPreliminaryOutcome,
): boolean {
  return (
    item.ransStage === "screened" &&
    item.fastState === "not_started" &&
    item.finalState === "not_started" &&
    item.criticalStage === null &&
    !ransAcceptedWithoutUrans(item)
  );
}

export function preliminaryOutcomeIsCritical(
  item: AdminCampaignPreliminaryOutcome,
): boolean {
  return (
    item.criticalStage === "preflight" ||
    item.criticalStage === "rans" ||
    item.fastState === "critical" ||
    item.finalState === "critical" ||
    item.finalActivityState === "critical"
  );
}

function preliminaryOutcomeIncident(
  item: AdminCampaignPreliminaryOutcome,
): Pick<PreliminaryOutcomeView, "incidentStage" | "incidentLabel"> {
  if (item.criticalStage === "preflight") {
    return {
      incidentStage: "preflight",
      incidentLabel: "SOLVER COULD NOT START",
    };
  }
  if (item.criticalStage === "rans") {
    return {
      incidentStage: "rans",
      incidentLabel: "RANS RECOVERY EXHAUSTED",
    };
  } else if (item.finalState === "critical") {
    return {
      incidentStage: "final",
      incidentLabel:
        item.fastState === "critical"
          ? "FAST + FINAL URANS EXHAUSTED"
          : "FINAL URANS EXHAUSTED",
    };
  }
  if (item.finalActivityState === "critical") {
    return {
      incidentStage: "final",
      incidentLabel:
        item.fastState === "critical"
          ? "FAST + FINAL URANS EXHAUSTED"
          : "FINAL URANS UPDATE EXHAUSTED",
    };
  }
  if (item.fastState === "critical") {
    return {
      incidentStage: "fast",
      incidentLabel: "FAST URANS EXHAUSTED",
    };
  }
  return { incidentStage: null, incidentLabel: null };
}

/** The rail describes one point's current solver journey. A queued, critical
 * preflight/RANS, or terminal accepted-RANS row remains at RANS; only an
 * actual handoff advances the current marker to fast URANS. */
export function preliminaryOutcomeCurrentStage(
  item: AdminCampaignPreliminaryOutcome,
): PreliminaryOutcomeCurrentStage {
  if (
    item.ransStage === "not_started" ||
    item.criticalStage === "rans" ||
    ransAcceptedWithoutUrans(item)
  ) {
    return "rans";
  }
  return item.finalState !== "not_started" ||
    item.finalActivityState !== null ||
    item.finalComparison !== null
    ? "final"
    : "fast";
}

/** Result availability, active work, and critical incidents are independent
 * facets. One point can therefore be verified and still expose a red incident
 * when an earlier required stage exhausted its recovery path. */
export function preliminaryOutcomeCurrentCounts(
  items: AdminCampaignPreliminaryOutcome[],
): PreliminaryOutcomeCurrentCounts {
  const counts: PreliminaryOutcomeCurrentCounts = {
    active: 0,
    ransAccepted: 0,
    fastReady: 0,
    verified: 0,
    critical: 0,
    total: items.length,
  };

  for (const item of items) {
    if (preliminaryOutcomeIsCritical(item)) {
      counts.critical += 1;
    }
    if (
      item.fastState === "queued" ||
      item.fastState === "running" ||
      (item.ransStage === "not_started" && item.criticalStage === null) ||
      ransHandoffAwaitingFast(item) ||
      item.finalState === "queued" ||
      item.finalState === "running" ||
      item.finalActivityState === "queued" ||
      item.finalActivityState === "running"
    ) {
      counts.active += 1;
    }
    if (item.finalState === "accepted") {
      counts.verified += 1;
    } else if (ransAcceptedWithoutUrans(item)) {
      counts.ransAccepted += 1;
    } else if (item.fastState === "accepted") {
      counts.fastReady += 1;
    }
  }

  return counts;
}

export function preliminaryOutcomeView(
  item: AdminCampaignPreliminaryOutcome,
): PreliminaryOutcomeView {
  const ransOnlyAccepted = ransAcceptedWithoutUrans(item);
  const ransHandoff = ransHandoffAwaitingFast(item);
  const ransQueued =
    item.ransStage === "not_started" && item.criticalStage === null;
  let rans = {
    screened: {
      label: "Screened",
      diagnostic: "RANS screened; non-convergence hands off normally.",
    },
    attempted: {
      label: "Attempt recorded",
      diagnostic:
        "A RANS attempt/evidence record exists; this does not by itself prove a physical CFD run started.",
    },
    polar_handoff: {
      label: "Polar handoff",
      diagnostic: "Whole-polar RANS handoff to fast URANS.",
    },
    skipped: {
      label: "Skipped",
      diagnostic: "Direct fast-URANS request; RANS skipped.",
    },
    not_started: {
      label: "Not started",
      diagnostic: "Auto-repair exhausted before RANS screening.",
    },
  }[item.ransStage];
  if (item.criticalStage === "rans") {
    rans = {
      label: "Recovery exhausted",
      diagnostic:
        "RANS attempt evidence exists; automatic recovery exhausted before fast URANS.",
    };
  } else if (ransQueued) {
    rans = {
      label: "Queued",
      diagnostic: "RANS screening is queued.",
    };
  } else if (ransOnlyAccepted) {
    rans = {
      label: "Accepted",
      diagnostic: "RANS produced an accepted point; URANS is not required.",
    };
  } else if (ransHandoff) {
    rans = {
      label: "Handed off",
      diagnostic: "Normal aerodynamic handoff to URANS fast.",
    };
  }
  let fastLabel = {
    not_started: "Next",
    queued: "Queued",
    running: "Running",
    accepted: "Accepted",
    critical: "Exhausted",
  }[item.fastState];
  let finalLabel = {
    not_started: "Next",
    queued: "Queued",
    running: "Running",
    accepted: "Verified",
    critical: "Exhausted",
  }[item.finalState];
  const fastRecoveredByFinal =
    item.fastState === "critical" && item.finalState === "accepted";
  const incident = preliminaryOutcomeIncident(item);
  if (ransOnlyAccepted) {
    fastLabel = "Not needed";
    finalLabel = "Not needed";
  } else if (ransQueued) {
    fastLabel = "Waiting";
    finalLabel = "Waiting";
  } else if (ransHandoff) {
    fastLabel = "Queued";
    finalLabel = "Waiting";
  } else if (
    item.finalState === "accepted" &&
    item.finalComparison === "disagreed"
  ) {
    finalLabel = "Verified · differs from fast";
  } else if (item.finalState === "accepted" && item.finalActivityState) {
    finalLabel =
      item.finalActivityState === "critical"
        ? "Verified"
        : `Verified + update ${item.finalActivityState}`;
  }
  let status: {
    label: string;
    tone: "teal" | "violet" | "muted" | "warning" | "critical";
  };
  if (item.finalState === "accepted" && item.finalComparison === "disagreed") {
    status = { label: "VERIFIED · DIFFERS FROM FAST", tone: "warning" };
  } else if (
    item.finalState === "accepted" &&
    item.finalActivityState === "critical"
  ) {
    status = { label: "URANS final · verified", tone: "teal" };
  } else if (
    item.finalState === "accepted" &&
    item.finalActivityState !== null
  ) {
    status = {
      label: `URANS final · update ${item.finalActivityState}`,
      tone: "violet",
    };
  } else if (item.finalState === "accepted") {
    status = { label: "URANS final · verified", tone: "teal" };
  } else if (item.criticalStage === "preflight") {
    status = { label: "CRITICAL · SOLVER COULD NOT START", tone: "critical" };
  } else if (item.criticalStage === "rans") {
    status = {
      label: "CRITICAL · SCREENING RECOVERY EXHAUSTED",
      tone: "critical",
    };
  } else if (item.finalState === "critical") {
    status = {
      label:
        item.fastState === "critical"
          ? "CRITICAL · FAST + FINAL URANS EXHAUSTED"
          : "CRITICAL · FINAL URANS EXHAUSTED",
      tone: "critical",
    };
  } else if (item.finalState === "running") {
    status = {
      label: "URANS final · running",
      tone: "violet",
    };
  } else if (item.finalState === "queued") {
    status = {
      label: "URANS final · queued",
      tone: "violet",
    };
  } else if (item.fastState === "critical") {
    status = { label: "CRITICAL · FAST URANS EXHAUSTED", tone: "critical" };
  } else if (item.fastState === "accepted") {
    status = { label: "URANS fast · ready", tone: "teal" };
  } else if (item.fastState === "running") {
    status = { label: "URANS fast · running", tone: "violet" };
  } else if (ransOnlyAccepted) {
    status = { label: "RANS · accepted", tone: "teal" };
  } else if (ransQueued) {
    status = { label: "RANS · queued", tone: "violet" };
  } else {
    status = { label: "URANS fast · queued", tone: "violet" };
  }

  const evidence: string[] = [];
  if (item.ransEvidenceRuns > 0) {
    evidence.push(plural(item.ransEvidenceRuns, "RANS evidence record"));
  }
  if (item.preliminaryEvidenceRuns > 0) {
    evidence.push(
      plural(item.preliminaryEvidenceRuns, "fast URANS evidence record"),
    );
  }
  if (item.fullUransEvidenceRuns > 0) {
    evidence.push(
      plural(item.fullUransEvidenceRuns, "final URANS evidence record"),
    );
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
    ...item.evidenceReasons
      .filter(
        (reason) => !ransHandoff || !NORMAL_RANS_HANDOFF_REASONS.has(reason),
      )
      .map(diagnosticFor),
    ...item.finalEvidenceReasons.map(diagnosticFor),
  ];
  if (item.fastState === "critical") {
    if (fastRecoveredByFinal) {
      diagnostics.unshift(
        "Final URANS is authoritative; the fast path exhausted automatic recovery.",
      );
    } else if (item.outcome === "evidence_unavailable") {
      diagnostics.unshift("Fast URANS exhausted publication recovery.");
    } else if (item.outcome === "continuation_unavailable") {
      diagnostics.unshift("Saved-transient recovery exhausted.");
    } else if (item.outcome === "mesh_unavailable") {
      diagnostics.unshift("Automatic mesh recovery exhausted.");
    } else if (item.outcome === "submit_unavailable") {
      diagnostics.unshift("Automatic fast-run submission recovery exhausted.");
    } else {
      diagnostics.unshift("Fast URANS recovery exhausted.");
    }
  }
  if (item.criticalStage === "preflight") {
    diagnostics.unshift("RANS and fast URANS did not start.");
  } else if (item.criticalStage === "rans") {
    diagnostics.unshift(
      "RANS attempt evidence exists; automatic recovery exhausted before fast URANS.",
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
      `Fast/final comparison differs${deltas.length ? ` · ${deltas.join(" · ")}` : ""}.`,
    );
  }
  if (item.finalState === "critical") {
    diagnostics.unshift("Final URANS recovery exhausted.");
  } else if (
    item.finalState === "accepted" &&
    item.finalActivityState === "critical"
  ) {
    diagnostics.unshift(
      "Verified result retained; the latest update exhausted recovery.",
    );
  }
  if (item.finalSubmitError) {
    diagnostics.push(
      `${item.finalSubmitHttpStatus ? `Solver service HTTP ${item.finalSubmitHttpStatus}: ` : "Solver service: "}${item.finalSubmitError}`,
    );
  }
  if (item.nonPhysicalSubmissions > 0) {
    diagnostics.push(
      `${plural(item.nonPhysicalSubmissions, "engine submission")} ended before CFD; not a physical run.`,
    );
  }

  const ransProvenanceLabel =
    item.ransEvidenceRuns > 0
      ? plural(item.ransEvidenceRuns, "evidence record")
      : "no evidence yet";
  const fastProvenanceLabel =
    item.physicalAttemptsMax > 0
      ? `${item.physicalAttemptsUsed}/${item.physicalAttemptsMax} physical attempts`
      : item.preliminaryEvidenceRuns > 0
        ? plural(item.preliminaryEvidenceRuns, "evidence record")
        : item.fastState === "running"
          ? "physical run active"
          : item.fastState === "queued"
            ? "awaiting solver"
            : "not started";
  const finalProvenanceLabel =
    item.fullUransEvidenceRuns > 0
      ? plural(item.fullUransEvidenceRuns, "evidence record")
      : item.finalState === "running"
        ? "physical run active"
        : item.finalState === "queued"
          ? "verification queued"
          : item.finalState === "critical"
            ? "recovery exhausted"
            : "not started";

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
    incidentStage: incident.incidentStage,
    incidentLabel: incident.incidentLabel,
    ransAcceptedResult: ransOnlyAccepted,
    ransHandoffPending: ransHandoff,
    fastRecoveredByFinal,
    ransProvenanceLabel,
    fastProvenanceLabel,
    finalProvenanceLabel,
    budgetLabel: ransOnlyAccepted
      ? "Fast URANS · not required"
      : ransQueued
        ? "Fast URANS · waits for RANS handoff"
        : ransHandoff
          ? "Fast URANS · handoff pending"
          : item.fastState === "not_started"
            ? "Fast URANS · not started"
            : `Fast URANS · ${item.physicalAttemptsUsed}/${item.physicalAttemptsMax} physical attempts`,
    evidenceLabel:
      evidence.length > 0
        ? `Evidence · ${evidence.join(" · ")}`
        : "Evidence · none yet",
    diagnostics: [...new Set(diagnostics)],
  };
}
