export const SOLVER_WORK_STATES = [
  "verified",
  "provisional",
  "solving",
  "queued",
  "ladder",
  "needs_time",
  "needs_review",
  "blocked",
  "excluded",
  "superseded",
] as const;

export type SolverWorkPointState = (typeof SOLVER_WORK_STATES)[number];

export interface SolverWorkGate {
  name: string;
  detail: string;
}

export interface SolverWorkChainItem {
  label: string;
  tone: string;
}

export type SolverWorkReviewVerdict = "waive" | "exclude" | "defer";

export interface SolverWorkReviewed {
  verdict: SolverWorkReviewVerdict;
  note: string | null;
  reviewer: string | null;
  at: string;
}

export interface SolverWorkPoint {
  aoaDeg: number;
  state: SolverWorkPointState;
  resultId: string | null;
  fidelity: string | null;
  cl: number | null;
  cd: number | null;
  cm: number | null;
  plain: string;
  gate: SolverWorkGate | null;
  chain: SolverWorkChainItem[];
  continuable: boolean;
  actions: string[];
  supersededBy: string | null;
  reviewed?: SolverWorkReviewed | null;
}

export interface SolverWorkJob {
  id: string;
  kind: "rans-sweep" | "urans-retry";
  status: string;
  wave: number;
  engineState: string | null;
  engineJobId: string | null;
  retryMode: string | null;
  setupName: string | null;
  aoas: number[];
  aoaMin: number | null;
  aoaMax: number | null;
  totalCases: number;
  completedCases: number;
  solvedCount: number;
  pendingCount: number;
  failedCount: number;
  acceptedRansCount: number;
  rejectedRansCount: number;
  uransAttemptCount: number;
  reynolds: number | null;
  mach: number | null;
  createdAt: string;
  submittedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface SolverWorkCondition {
  presetRevisionId: string;
  reynolds: number;
  mach: number;
  chordM: number;
  speedMps: number;
  updatedAt: string;
  attentionCount: number;
  points: SolverWorkPoint[];
  jobs: SolverWorkJob[];
}

export interface SolverWorkPayload {
  conditions: SolverWorkCondition[];
}

export type SolverWorkFilter = "all" | "attention" | "solving";
export type SolverWorkSort = "re-asc" | "attention-first" | "recent";

export interface SolverWorkStateStyle {
  label: string;
  className: string;
  color: string;
  background: string;
  border: string;
}

export const SOLVER_WORK_STATE_STYLES: Record<SolverWorkPointState, SolverWorkStateStyle> = {
  verified: {
    label: "verified",
    className: "solver-work-state--verified",
    color: "#34d399",
    background: "#0e1d18",
    border: "#1c3a31",
  },
  provisional: {
    label: "provisional",
    className: "solver-work-state--provisional",
    color: "#2dd4bf",
    background: "#0b1f1f",
    border: "#155e59",
  },
  solving: {
    label: "solving",
    className: "solver-work-state--solving",
    color: "#60a5fa",
    background: "#0b172a",
    border: "#1d4ed8",
  },
  queued: {
    label: "queued",
    className: "solver-work-state--queued",
    color: "#94a3b8",
    background: "#111827",
    border: "#334155",
  },
  ladder: {
    label: "→ URANS",
    className: "solver-work-state--ladder",
    color: "#a78bfa",
    background: "#1b1231",
    border: "#4c1d95",
  },
  needs_time: {
    label: "needs time",
    className: "solver-work-state--needs-time",
    color: "#f59e0b",
    background: "#221a0a",
    border: "#92400e",
  },
  needs_review: {
    label: "needs review",
    className: "solver-work-state--needs-review",
    color: "#fb923c",
    background: "#25140a",
    border: "#7c2d12",
  },
  blocked: {
    label: "blocked",
    className: "solver-work-state--blocked",
    color: "#f87171",
    background: "#260d0d",
    border: "#7f1d1d",
  },
  excluded: {
    label: "excluded",
    className: "solver-work-state--excluded",
    color: "#fca5a5",
    background: "#260d0d",
    border: "#7f1d1d",
  },
  superseded: {
    label: "superseded",
    className: "solver-work-state--superseded",
    color: "#64748b",
    background: "#0d1117",
    border: "#1f2937",
  },
};

export interface SolverWorkConditionSummary {
  titleParts: {
    reynolds: string;
    mach: string;
    chord: string;
    speed: string;
  };
  meta: string;
  countLabel: string;
  attentionLabel: string | null;
}

export interface SolverWorkRollupSegment {
  state: SolverWorkPointState;
  count: number;
  percent: number;
  style: SolverWorkStateStyle;
}

export interface SolverWorkResultContext {
  re: number;
  aoa: number;
  resultId: string;
}

export interface SolverWorkPopoverAction {
  kind: "open-results" | "continue-2h" | "continue-6h" | "continue-24h" | "retry" | "request-full-tier" | "revoke-review";
  label: string;
  adminOnly: boolean;
}

export interface SolverWorkPointPresentation {
  visualState: SolverWorkPointState;
  stateLabel: string;
  badgeMark: string | null;
  reviewedDisclosure: string | null;
}

export interface SolverWorkPopoverView {
  title: string;
  state: SolverWorkPointState;
  visualState: SolverWorkPointState;
  stateLabel: string;
  plain: string;
  gate: SolverWorkGate | null;
  coefficients: { label: "Cl" | "Cd" | "Cm"; value: string }[];
  provisionalNote: boolean;
  chain: { label: string; tone: string; style: SolverWorkStateStyle }[];
  actions: SolverWorkPopoverAction[];
  reviewedDisclosure: string | null;
}

export function solverWorkStateClass(state: SolverWorkPointState): string {
  return `solver-work-state ${SOLVER_WORK_STATE_STYLES[state].className}`;
}

export function solverWorkPointPresentation(point: SolverWorkPoint): SolverWorkPointPresentation {
  const reviewed = point.reviewed ?? null;
  if (reviewed?.verdict === "waive") {
    return {
      visualState: "verified",
      stateLabel: "verified · reviewed ✓",
      badgeMark: "✓",
      reviewedDisclosure: solverWorkReviewDisclosure(reviewed),
    };
  }
  if (point.state === "excluded" || reviewed?.verdict === "exclude") {
    return {
      visualState: "excluded",
      stateLabel: reviewed ? "excluded · reviewed" : SOLVER_WORK_STATE_STYLES.excluded.label,
      badgeMark: null,
      reviewedDisclosure: reviewed ? solverWorkReviewDisclosure(reviewed) : null,
    };
  }
  return {
    visualState: point.state,
    stateLabel: SOLVER_WORK_STATE_STYLES[point.state].label,
    badgeMark: null,
    reviewedDisclosure: reviewed ? solverWorkReviewDisclosure(reviewed) : null,
  };
}

export function solverWorkPointKey(condition: SolverWorkCondition, point: SolverWorkPoint): string {
  return `${condition.presetRevisionId}:${point.aoaDeg}:${point.resultId ?? "no-result"}:${point.supersededBy ?? ""}`;
}

export function formatReynolds(value: number): string {
  if (value >= 1_000_000) {
    const scaled = value / 1_000_000;
    return `${scaled.toFixed(Number.isInteger(scaled) ? 0 : 1)}M`;
  }
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}

export function formatAoa(value: number): string {
  return `${value.toFixed(1)}°`;
}

export function formatCompactNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  const fixed = value.toFixed(digits);
  return fixed.replace(/\.?0+$/, "");
}

export function formatAgo(iso: string | null, nowMs = Date.now()): string {
  if (!iso) return "—";
  const seconds = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function conditionHasSolving(condition: SolverWorkCondition): boolean {
  return condition.points.some((point) => point.state === "solving");
}

export function visibleSolverWorkPoints(points: SolverWorkPoint[], showSuperseded: boolean): SolverWorkPoint[] {
  return showSuperseded ? points : points.filter((point) => point.state !== "superseded");
}

export function solverWorkLegendStates(points: SolverWorkPoint[], showSuperseded: boolean): SolverWorkPointState[] {
  const present = new Set(visibleSolverWorkPoints(points, showSuperseded).map((point) => point.state));
  return SOLVER_WORK_STATES.filter((state) => present.has(state));
}

export function solverWorkRollup(points: SolverWorkPoint[], showSuperseded = false): SolverWorkRollupSegment[] {
  const visible = visibleSolverWorkPoints(points, showSuperseded);
  if (!visible.length) return [];
  const counts = new Map<SolverWorkPointState, number>();
  for (const point of visible) counts.set(point.state, (counts.get(point.state) ?? 0) + 1);
  return SOLVER_WORK_STATES.flatMap((state) => {
    const count = counts.get(state) ?? 0;
    return count
      ? [
          {
            state,
            count,
            percent: (count / visible.length) * 100,
            style: SOLVER_WORK_STATE_STYLES[state],
          },
        ]
      : [];
  });
}

export function filterSortSolverWorkConditions(
  conditions: SolverWorkCondition[],
  filter: SolverWorkFilter,
  sort: SolverWorkSort,
): SolverWorkCondition[] {
  const filtered = conditions.filter((condition) => {
    if (filter === "attention") return condition.attentionCount > 0;
    if (filter === "solving") return conditionHasSolving(condition);
    return true;
  });
  return filtered
    .map((condition, index) => ({ condition, index }))
    .sort((a, b) => {
      if (sort === "re-asc") return a.condition.reynolds - b.condition.reynolds || a.index - b.index;
      if (sort === "attention-first") {
        return (
          b.condition.attentionCount - a.condition.attentionCount ||
          new Date(b.condition.updatedAt).getTime() - new Date(a.condition.updatedAt).getTime() ||
          a.index - b.index
        );
      }
      return new Date(b.condition.updatedAt).getTime() - new Date(a.condition.updatedAt).getTime() || a.index - b.index;
    })
    .map(({ condition }) => condition);
}

export function buildSolverWorkConditionSummary(condition: SolverWorkCondition, nowMs = Date.now()): SolverWorkConditionSummary {
  const visibleCount = visibleSolverWorkPoints(condition.points, false).length;
  const totalCount = condition.points.length;
  const ransLabel = deriveRansLabel(condition.points);
  const urans = deriveUransCounts(condition.points);
  return {
    titleParts: {
      reynolds: formatReynolds(condition.reynolds),
      mach: formatCompactNumber(condition.mach, 2),
      chord: `${formatCompactNumber(condition.chordM, 2)} m`,
      speed: `${formatCompactNumber(condition.speedMps, 1)} m/s`,
    },
    meta: `${ransLabel} · URANS ${urans.done}/${urans.total} · updated ${formatAgo(condition.updatedAt, nowMs)}`,
    countLabel: `${visibleCount}/${totalCount}`,
    attentionLabel: condition.attentionCount > 0 ? `attention ${condition.attentionCount}` : null,
  };
}

export function solverWorkResultContext(condition: SolverWorkCondition, point: SolverWorkPoint): SolverWorkResultContext | null {
  if (!point.resultId) return null;
  return { re: condition.reynolds, aoa: point.aoaDeg, resultId: point.resultId };
}

export function buildContinueUransPayload(resultId: string, hours: 2 | 6 | 24): { continueFromResultId: string; budgetOverrideS: number } {
  return { continueFromResultId: resultId, budgetOverrideS: hours * 3600 };
}

export function buildSolverWorkPopoverView(condition: SolverWorkCondition, point: SolverWorkPoint, admin: boolean): SolverWorkPopoverView {
  const presentation = solverWorkPointPresentation(point);
  const actions: SolverWorkPopoverAction[] = [];
  if (point.resultId) actions.push({ kind: "open-results", label: "full results ▸", adminOnly: false });
  if (admin && point.state === "needs_time" && point.continuable && point.resultId) {
    actions.push(
      { kind: "continue-2h", label: "Continue +2h", adminOnly: true },
      { kind: "continue-6h", label: "Continue +6h", adminOnly: true },
      { kind: "continue-24h", label: "Continue +24h", adminOnly: true },
    );
  }
  if (admin && point.state === "needs_review" && point.resultId && hasSolverWorkAction(point, "retry")) {
    actions.push({ kind: "retry", label: "Retry", adminOnly: true });
  }
  if (admin && (point.state === "needs_review" || point.state === "blocked") && hasFullTierAction(point) && condition.presetRevisionId) {
    actions.push({ kind: "request-full-tier", label: "Request full tier", adminOnly: true });
  }
  if (admin && point.reviewed && point.resultId) {
    actions.push({ kind: "revoke-review", label: "revoke review", adminOnly: true });
  }

  return {
    title: `α ${formatAoa(point.aoaDeg)}`,
    state: point.state,
    visualState: presentation.visualState,
    stateLabel: presentation.stateLabel,
    plain: point.plain,
    gate: point.gate,
    coefficients: [
      point.cl == null ? null : { label: "Cl" as const, value: point.cl.toFixed(3) },
      point.cd == null ? null : { label: "Cd" as const, value: point.cd.toFixed(4) },
      point.cm == null ? null : { label: "Cm" as const, value: point.cm.toFixed(3) },
    ].filter((item): item is { label: "Cl" | "Cd" | "Cm"; value: string } => item != null),
    provisionalNote: point.state === "needs_time" || point.state === "provisional",
    chain: point.chain.map((item) => ({
      label: item.label,
      tone: item.tone,
      style: styleForTone(item.tone),
    })),
    actions,
    reviewedDisclosure: presentation.reviewedDisclosure,
  };
}

function solverWorkReviewDisclosure(reviewed: SolverWorkReviewed): string {
  const verb = reviewed.verdict === "waive" ? "waived" : reviewed.verdict === "exclude" ? "excluded" : "deferred";
  const note = reviewed.note?.trim();
  return `${verb} by ${reviewed.reviewer || "unknown"} ${formatReviewDate(reviewed.at)}${note ? `: ${note}` : ""}`;
}

function formatReviewDate(iso: string): string {
  return iso ? iso.slice(0, 10) : "unknown date";
}

function normalizedAction(action: string): string {
  return action.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function hasSolverWorkAction(point: SolverWorkPoint, action: string): boolean {
  const target = normalizedAction(action);
  return point.actions.some((candidate) => normalizedAction(candidate) === target);
}

function hasFullTierAction(point: SolverWorkPoint): boolean {
  const actions = point.actions.map(normalizedAction);
  return actions.some((action) => action === "request_full_tier" || action === "request_full" || action === "full_tier");
}

function styleForTone(tone: string): SolverWorkStateStyle {
  const normalized = normalizedAction(tone);
  if (isSolverWorkState(normalized)) return SOLVER_WORK_STATE_STYLES[normalized];
  if (normalized === "teal") return SOLVER_WORK_STATE_STYLES.provisional;
  if (normalized === "amber") return SOLVER_WORK_STATE_STYLES.needs_time;
  if (normalized === "orange") return SOLVER_WORK_STATE_STYLES.needs_review;
  if (normalized === "red") return SOLVER_WORK_STATE_STYLES.blocked;
  if (normalized === "blue") return SOLVER_WORK_STATE_STYLES.solving;
  if (normalized === "violet") return SOLVER_WORK_STATE_STYLES.ladder;
  return SOLVER_WORK_STATE_STYLES.queued;
}

function isSolverWorkState(value: string): value is SolverWorkPointState {
  return (SOLVER_WORK_STATES as readonly string[]).includes(value);
}

function deriveRansLabel(points: SolverWorkPoint[]): string {
  const ransChain = points.flatMap((point) => point.chain).filter((item) => /^rans\b/i.test(item.label.trim()));
  if (ransChain.some((item) => item.label.includes("✓"))) return "RANS ✓";
  if (ransChain.some((item) => item.label.includes("✗") || /fail|reject|stall/i.test(item.label))) return "RANS ✗";
  if (points.some((point) => point.state === "verified" && !isUransRelated(point))) return "RANS ✓";
  return "RANS —";
}

function deriveUransCounts(points: SolverWorkPoint[]): { done: number; total: number } {
  const uransPoints = points.filter(isUransRelated);
  return {
    done: uransPoints.filter((point) => point.state === "verified" || point.state === "provisional").length,
    total: uransPoints.length,
  };
}

function isUransRelated(point: SolverWorkPoint): boolean {
  return (
    /urans/i.test(point.fidelity ?? "") ||
    point.chain.some((item) => /urans/i.test(item.label)) ||
    point.state === "ladder" ||
    point.state === "needs_time" ||
    point.state === "needs_review" ||
    point.state === "blocked" ||
    point.state === "excluded"
  );
}
