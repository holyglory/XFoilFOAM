// Pure model assembly for the campaign-detail dashboard hero (approved design
// c19fd74a, section D): the 3-stage pipeline strip (steady → unsteady →
// verify), the SINGLE progress bar's segment fractions (teal done / amber
// solving / violet awaiting-URANS / empty open) and the honest stage ETA from
// the measured trailing ingest rate. Kept React-free with relative imports
// (not @/ aliases): node vitest covers this module and resolves no tsconfig
// paths (same pattern as campaign-status.ts / coverage-segments.ts).
//
// Every number is a REAL counter from the API payload (tierCounts,
// reviewBuckets, totals, rate). Nothing is projected beyond the measured
// trailing-24h ingest; the ETA hides itself rather than invent a rate.

import type {
  AdminCampaignSummary,
  CampaignReviewBuckets,
} from "../../../lib/admin";
import type {
  CampaignLadderPhase,
  CampaignTierCounts,
} from "./campaign-status";

// Local copy of ui.tsx's fCount (importing ui.tsx would drag React into node
// vitest — same rationale as campaign-status.ts).
function fCount(v: number): string {
  return v.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// 3-stage pipeline strip
// ---------------------------------------------------------------------------
export type PipelineStageKey = "steady" | "unsteady" | "verify";

export interface PipelineStage {
  key: PipelineStageKey;
  title: string;
  /** Open work in this stage (real counters; see openDetail for composition). */
  open: number;
  /** Composition line under the count, e.g. "12 open · 96 awaiting" — only
   *  real counters, omitted parts never render as zeros. */
  detail: string | null;
  /** This stage is the ladder's current phase (running_* from the API). */
  active: boolean;
  /** Truly settled: this stage has no open work AND no earlier stage can
   *  still feed it (work only flows left → right). A downstream stage with 0
   *  open while stage 1 is still solving is NOT settled — it just has not
   *  started (renders as "—", mockup c19fd74a stage 3). */
  settled: boolean;
}

export interface PipelineModel {
  stages: PipelineStage[];
  /** Live scheduler truth for the strip's in-flight line (jobs solving now). */
  jobsRunning: number;
}

/** null = the payload has no tierCounts (older API): render no pipeline strip
 *  rather than invented zeros. The stage-2 open count is the sum of two
 *  DISJOINT real counters: precalcOpen (needs_urans terminal + live urans
 *  rows) and awaitingUrans (tier-1 rejects queued for the unsteady re-solve —
 *  done+rejected rows, so never double-counted by precalcOpen). */
export function assemblePipelineModel(input: {
  tierCounts: CampaignTierCounts | null | undefined;
  reviewBuckets: CampaignReviewBuckets | null | undefined;
  phase: CampaignLadderPhase | undefined;
  jobsRunning: number;
}): PipelineModel | null {
  const tiers = input.tierCounts;
  if (!tiers) return null;
  const awaiting = input.reviewBuckets?.awaitingUrans ?? 0;
  const unsteadyOpen = tiers.precalcOpen + awaiting;
  const stages: PipelineStage[] = [
    {
      key: "steady",
      title: "1 · steady RANS",
      open: tiers.ransOpen,
      detail: tiers.ransOpen > 0 ? `${fCount(tiers.ransOpen)} open` : null,
      active: input.phase === "running_rans",
      settled: tiers.ransOpen === 0,
    },
    {
      key: "unsteady",
      title: "2 · unsteady URANS",
      open: unsteadyOpen,
      detail:
        unsteadyOpen > 0
          ? [
              tiers.precalcOpen > 0
                ? `${fCount(tiers.precalcOpen)} open`
                : null,
              awaiting > 0 ? `${fCount(awaiting)} awaiting` : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : null,
      active: input.phase === "running_precalc",
      // Stage-1 rejects keep feeding this stage until stage 1 is settled.
      settled: unsteadyOpen === 0 && tiers.ransOpen === 0,
    },
    {
      key: "verify",
      title: "3 · verify",
      open: tiers.verifyOpen,
      detail:
        tiers.verifyOpen > 0 ? `${fCount(tiers.verifyOpen)} queued` : null,
      active: input.phase === "running_refinement",
      // Precalc solves keep enqueueing verifications until stages 1+2 settle.
      settled:
        tiers.verifyOpen === 0 && unsteadyOpen === 0 && tiers.ransOpen === 0,
    },
  ];
  return { stages, jobsRunning: input.jobsRunning };
}

/** Static stage annotations from the approved mockup — scheduling truths, not
 *  projections ("starts when stage 1 finishes · ~4h each" reflects the
 *  RANS-first scheduler rank; "background" the verify queue's lowest rank).
 *  "~4 h" mirrors URANS_PRECALC_SOLVER_BUDGET_S (14400 s, raised 2026-07-09). */
export const PIPELINE_STAGE_NOTES: Record<PipelineStageKey, string | null> = {
  steady: null,
  unsteady: "starts when stage 1 finishes · ~4 h each",
  verify: "background, after stage 2",
};

// ---------------------------------------------------------------------------
// Single progress bar (teal done / amber solving / violet awaiting / empty)
// ---------------------------------------------------------------------------
export interface ProgressBarSegments {
  /** Fractions of totals.requested, each clamped to [0,1]; the remainder of
   *  the bar stays empty (open work). */
  done: number;
  solving: number;
  awaitingUrans: number;
  blocked: number;
  /** Open = requested − done − solving − awaiting counts (never negative). */
  openCount: number;
  doneCount: number;
  solvingCount: number;
  awaitingCount: number;
  blockedCount: number;
}

/** Done = solved + derived (settled evidence). Solving = running (mid-ingest).
 *  Violet = awaiting-URANS (rejected tier-1, queued for stage 2). Failed /
 *  needs-review points are NOT a bar segment — they surface exclusively as
 *  the red chip (approved design D). */
export function progressBarSegments(
  totals: AdminCampaignSummary["totals"],
  reviewBuckets: CampaignReviewBuckets | null | undefined,
): ProgressBarSegments {
  const requested = totals.requested;
  const doneCount = totals.solved + totals.derived;
  const solvingCount = totals.running;
  const awaitingCount = reviewBuckets?.awaitingUrans ?? 0;
  const blockedCount = totals.blocked ?? 0;
  const frac = (n: number) =>
    requested > 0 ? Math.min(1, Math.max(0, n / requested)) : 0;
  return {
    done: frac(doneCount),
    solving: frac(solvingCount),
    awaitingUrans: frac(awaitingCount),
    blocked: frac(blockedCount),
    openCount: Math.max(
      0,
      requested - doneCount - solvingCount - awaitingCount - blockedCount,
    ),
    doneCount,
    solvingCount,
    awaitingCount,
    blockedCount,
  };
}

// ---------------------------------------------------------------------------
// Honest stage ETA from the measured trailing ingest rate
// ---------------------------------------------------------------------------
export interface StageEta {
  /** 1-based stage number the ETA covers (the ladder's current phase). */
  stage: 1 | 2 | 3;
  hours: number;
  /** "~2 h" / "~36 h" / "~3 d" — always tilde-prefixed (measured, not promised). */
  label: string;
}

/** Minimum measurement window before the trailing rate counts as stable —
 *  under an hour of history the 24h-window count is dominated by startup
 *  noise/plan edits, so the ETA hides instead. */
export const ETA_MIN_WINDOW_MS = 60 * 60 * 1000;

export function formatEtaHours(hours: number): string {
  if (hours >= 48) return `~${Math.round(hours / 24)} d`;
  if (hours >= 10) return `~${Math.round(hours)} h`;
  if (hours >= 1) {
    const rounded = Math.round(hours * 2) / 2; // half-hour steps under 10 h
    return Number.isInteger(rounded)
      ? `~${rounded} h`
      : `~${rounded.toFixed(1)} h`;
  }
  return "~<1 h";
}

/** null = hidden: no rate payload (non-active campaign / older API), a zero
 *  measured rate (division by zero would be a lie), an unstable measurement
 *  window (< ETA_MIN_WINDOW_MS of history), no current running_* phase, or a
 *  stage with nothing open. `stageOpen` must be the CURRENT stage's open
 *  count from assemblePipelineModel — the ETA never spans stages (stage-2/3
 *  work solves at a different per-point cost than the measured mix; an
 *  all-stages ETA would be invented precision). */
export function stageEta(input: {
  phase: CampaignLadderPhase | undefined;
  stageOpenByPhase: {
    ransOpen: number;
    unsteadyOpen: number;
    verifyOpen: number;
  } | null;
  rate: { pointsLast24h: number; measuredSince: string } | null | undefined;
  nowMs?: number;
}): StageEta | null {
  const { phase, rate } = input;
  if (!rate || !input.stageOpenByPhase) return null;
  if (rate.pointsLast24h <= 0) return null;
  const now = input.nowMs ?? Date.now();
  const since = new Date(rate.measuredSince).getTime();
  if (!Number.isFinite(since) || now - since < ETA_MIN_WINDOW_MS) return null;
  let stage: 1 | 2 | 3;
  let open: number;
  if (phase === "running_rans") {
    stage = 1;
    open = input.stageOpenByPhase.ransOpen;
  } else if (phase === "running_precalc") {
    stage = 2;
    open = input.stageOpenByPhase.unsteadyOpen;
  } else if (phase === "running_refinement") {
    stage = 3;
    open = input.stageOpenByPhase.verifyOpen;
  } else {
    return null; // completed / no phase — nothing to estimate
  }
  if (open <= 0) return null;
  const hours = open / (rate.pointsLast24h / 24);
  return { stage, hours, label: formatEtaHours(hours) };
}

// ---------------------------------------------------------------------------
// One-line stats summary (the stats wall collapsed to a single line)
// ---------------------------------------------------------------------------
/** "1,240 done · 12 solving · 96 awaiting URANS · 402 open of 1,750" — zero
 *  parts are omitted (never "0 solving" noise); done and the total always
 *  render. */
export function progressSummaryLine(
  seg: ProgressBarSegments,
  requested: number,
): string {
  const parts = [`${fCount(seg.doneCount)} done`];
  if (seg.solvingCount > 0) parts.push(`${fCount(seg.solvingCount)} solving`);
  if (seg.awaitingCount > 0)
    parts.push(`${fCount(seg.awaitingCount)} awaiting URANS`);
  if (seg.blockedCount > 0) parts.push(`${fCount(seg.blockedCount)} critical`);
  parts.push(`${fCount(seg.openCount)} open of ${fCount(requested)}`);
  return parts.join(" · ");
}

/** Sweep chip text for the details disclosure, from the REAL plan baseSweep
 *  (canonical decimal strings): "sweep −4°…14° step 2°" or "sweep 7 angles". */
export function sweepChipLabel(baseSweep: {
  fromDeg: string | null;
  toDeg: string | null;
  stepDeg: string | null;
  listDeg: string[] | null;
}): string | null {
  const deg = (s: string) => {
    const n = Number(s);
    return Number.isFinite(n) ? `${n}°` : `${s}°`;
  };
  if (baseSweep.listDeg && baseSweep.listDeg.length > 0) {
    return `sweep ${baseSweep.listDeg.length} angle${baseSweep.listDeg.length === 1 ? "" : "s"}`;
  }
  if (
    baseSweep.fromDeg != null &&
    baseSweep.toDeg != null &&
    baseSweep.stepDeg != null
  ) {
    return `sweep ${deg(baseSweep.fromDeg)}…${deg(baseSweep.toDeg)} step ${deg(baseSweep.stepDeg)}`;
  }
  return null;
}
