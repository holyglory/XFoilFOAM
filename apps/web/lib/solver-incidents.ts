import type {
  AdminSolverIncidentGroup,
  AdminSolverIncidentSeverity,
  AdminSolverIncidentStage,
  AdminSolverIncidentSummary,
} from "./admin";

const REASON_LABELS: Record<string, string> = {
  "auto-retry-exhausted": "automatic pre-solver repair exhausted",
  "continuation-no-progress": "continuation made no progress",
  "continuation-segment-limit": "continuation limit reached",
  "continuation-source-unavailable": "restart checkpoint unavailable",
  "engine-infrastructure-failure": "engine infrastructure failed",
  "engine-submit-rejected": "engine submission recovery exhausted",
  "incomplete-urans-integration": "incomplete averaging window",
  "infrastructure-failure": "solver infrastructure interrupted",
  "insufficient-periods": "too few repeatable periods",
  "media-repair-exhausted": "media recovery exhausted",
  "mesh-quality-failure": "mesh recovery exhausted",
  "non-publishable-rans-evidence": "unexpected pre-solver evidence state",
  "non-publishable-evidence": "publication checks unmet",
  "non-stationary": "no repeatable cycle",
  "recovery-exhausted": "automatic recovery exhausted",
  "solver-execution-failed": "solver execution interrupted",
  "solver-stalled": "solver stalled",
};

export interface SolverIncidentView {
  stage: AdminSolverIncidentStage;
  stageLabel: string;
  reasonLabel: string;
  occurrenceLabel: string;
  openLabel: string;
  recurrenceLabel: string;
  severity: AdminSolverIncidentSeverity;
  tone: "resolved" | AdminSolverIncidentSeverity;
  statusLabel: "RESOLVED" | "RECOVERING" | "CRITICAL";
  actionLabel: "HISTORY" | "AUTOMATIC" | "SYSTEM OWNED";
  requiresInvestigation: boolean;
  ariaLabel: string;
}

export function solverIncidentStageLabel(
  stage: AdminSolverIncidentStage,
): string {
  if (stage === "rans") return "PRE-SOLVER REPAIR";
  return stage === "preliminary" ? "FAST URANS" : "FINAL URANS";
}

function humanizeReasonPart(reason: string): string {
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return "unclassified recovery issue";
  return (
    REASON_LABELS[normalized] ??
    normalized.replace(/[_-]+/g, " ").replace(/\s+/g, " ")
  );
}

export function solverIncidentReasonLabel(reason: string): string {
  const labels = reason.split("+").map(humanizeReasonPart).filter(Boolean);
  return labels.length ? labels.join(" · ") : "unclassified recovery issue";
}

export function solverIncidentView(
  group: AdminSolverIncidentGroup,
  threshold: number,
): SolverIncidentView {
  const stageLabel = solverIncidentStageLabel(group.stage);
  const reasonLabel = solverIncidentReasonLabel(group.reason);
  const occurrenceLabel = `×${group.occurrenceCount.toLocaleString()}`;
  const openLabel =
    group.openCount > 0
      ? `${group.openCount.toLocaleString()} active`
      : "recovered";
  const recurrenceLabel =
    group.occurrenceCount >= threshold
      ? `same cause ≥${threshold.toLocaleString()}`
      : "isolated";
  const requiresInvestigation =
    group.requiresInvestigation ||
    group.effectiveSeverity === "critical" ||
    group.occurrenceCount >= threshold;
  const severity = group.effectiveSeverity;
  const isOpen = group.openCount > 0;
  const currentCritical =
    isOpen &&
    (group.openCriticalCount > 0 ||
      group.occurrenceCount >= threshold ||
      group.effectiveSeverity === "critical");
  const tone = isOpen ? (currentCritical ? "critical" : "warning") : "resolved";
  const statusLabel =
    tone === "critical"
      ? "CRITICAL"
      : tone === "warning"
        ? "RECOVERING"
        : "RESOLVED";
  const actionLabel =
    tone === "critical"
      ? "SYSTEM OWNED"
      : tone === "warning"
        ? "AUTOMATIC"
        : "HISTORY";
  return {
    stage: group.stage,
    stageLabel,
    reasonLabel,
    occurrenceLabel,
    openLabel,
    recurrenceLabel,
    severity,
    tone,
    statusLabel,
    actionLabel,
    requiresInvestigation,
    ariaLabel: [
      stageLabel,
      reasonLabel,
      `${group.occurrenceCount} occurrence${group.occurrenceCount === 1 ? "" : "s"}`,
      openLabel,
      statusLabel.toLowerCase(),
      actionLabel.toLowerCase(),
    ].join(", "),
  };
}

export function solverIncidentSummaryLabel(
  summary: AdminSolverIncidentSummary,
): string {
  if (summary.groups.length === 0) {
    return "Solver reliability clear; no recovery incidents";
  }
  if (summary.openCount === 0) {
    return [
      "Solver reliability currently clear",
      `${summary.occurrenceCount} historical occurrence${summary.occurrenceCount === 1 ? "" : "s"}`,
    ].join(", ");
  }
  const currentCriticalGroupCount = summary.groups.filter(
    (group) =>
      group.openCount > 0 &&
      (group.openCriticalCount > 0 ||
        group.occurrenceCount >= summary.threshold ||
        group.effectiveSeverity === "critical"),
  ).length;
  return [
    "Solver reliability",
    `${summary.openCount} active recovery event${summary.openCount === 1 ? "" : "s"}`,
    currentCriticalGroupCount > 0
      ? `${currentCriticalGroupCount} critical system-owned pattern${currentCriticalGroupCount === 1 ? "" : "s"}`
      : "automatic recovery active",
    `${summary.occurrenceCount} occurrence${summary.occurrenceCount === 1 ? "" : "s"}`,
  ].join(", ");
}
