// Pure segment/bar math for the coverage matrix redesign (approved mockup
// 1ed4374f, recolored per amendment A / design c19fd74a): per-airfoil
// segmented bars, one flex segment per condition; fill HEIGHT is the fraction
// of that condition's angles that are terminal. Awaiting-URANS points tint
// the fill VIOLET (calm stage-2 queue); needs-review/failed render the
// segment solid RED; the legacy amber 'rejected' tint survives only for
// payloads without the split counters. Kept React-free with relative imports
// (not @/ aliases): this module is covered by node vitest, which resolves no
// tsconfig paths (same pattern as campaign-status.ts).

import type {
  AdminCampaignAirfoilRow,
  AdminCampaignConditionSummary,
  CampaignProgressTotals,
  CampaignReviewBuckets,
} from "../../../lib/admin";

/** Matrix cell payload: real counters + the optional amendment-A split. */
export type CoverageCell = CampaignProgressTotals &
  Partial<CampaignReviewBuckets>;

// Local copies of ui.tsx's formatRe/fCount: importing ui.tsx here would drag
// the React component tree into node vitest, defeating the point of this
// pure module.
function formatRe(v: number): string {
  if (v >= 1_000_000)
    return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(Math.round(v));
}

function fCount(v: number): string {
  return v.toLocaleString("en-US");
}

/** Optional per-cell sync-promise flag: counted ONLY when the row payload
 *  actually carries it (spec §11 "when the row payload flags it"). */
export function syncPromisedCount(cell: CampaignProgressTotals): number {
  const v = (cell as CampaignProgressTotals & { syncPromised?: number })
    .syncPromised;
  return typeof v === "number" && v > 0 ? v : 0;
}

// ---------------------------------------------------------------------------
// Segment state + fill
// ---------------------------------------------------------------------------

/** 'rejected' is the LEGACY amber tint: it only appears for payloads without
 *  the amendment-A split counters. With the split, red is strictly
 *  needs-review/failed and violet is the calm awaiting-URANS queue. */
export type SegmentState =
  | "empty"
  | "progress"
  | "rejected"
  | "blocked"
  | "awaiting_urans"
  | "needs_review"
  | "failed";

export interface SegmentView {
  state: SegmentState;
  /** 0..1 fraction of this condition's requested angles that are terminal
   *  (solved + derived + failed + rejected — settled, no longer pending or
   *  running). Real counters from sim_campaign_progress only. */
  fillFraction: number;
}

/** Terminal-done points for one cell: settled either way. `remaining` and
 *  `running` are still open; `superseded` points were replaced and are not
 *  part of the requested denominator's terminal share. */
export function terminalCount(cell: CampaignProgressTotals): number {
  return (
    cell.solved +
    cell.derived +
    cell.failed +
    cell.rejected +
    (cell.blocked ?? 0)
  );
}

/** Encoding (design c19fd74a): failed wins, then needs-review (both solid
 *  red), then awaiting-URANS (violet), then plain progress. A cell whose
 *  rejected points ALL have their next solve scheduled (split present, both
 *  buckets 0) renders as plain progress — it is back in the pipeline. The
 *  legacy amber 'rejected' state survives only when the payload has no split
 *  counters. A missing cell or requested === 0 renders empty. */
export function segmentView(
  cell: CoverageCell | null | undefined,
): SegmentView {
  if (!cell || cell.requested <= 0) return { state: "empty", fillFraction: 0 };
  const fillFraction = Math.min(
    1,
    Math.max(0, terminalCount(cell) / cell.requested),
  );
  const hasSplit = cell.awaitingUrans != null || cell.needsReview != null;
  if (cell.failed > 0) return { state: "failed", fillFraction };
  if (hasSplit) {
    if ((cell.needsReview ?? 0) > 0)
      return { state: "needs_review", fillFraction };
    if ((cell.blocked ?? 0) > 0) return { state: "blocked", fillFraction };
    if ((cell.awaitingUrans ?? 0) > 0)
      return { state: "awaiting_urans", fillFraction };
    return { state: "progress", fillFraction };
  }
  if (cell.rejected > 0) return { state: "rejected", fillFraction };
  return { state: "progress", fillFraction };
}

/** Rendered fill height (0..1). Critical/failed/needs-review segments render
 *  SOLID so recovery incidents stay visible at any progress; every other
 *  state fills to the terminal fraction. */
export function segmentFillHeight(view: SegmentView): number {
  return view.state === "failed" ||
    view.state === "needs_review" ||
    view.state === "blocked"
    ? 1
    : view.fillFraction;
}

// ---------------------------------------------------------------------------
// Tooltip label (identification moved off the removed column headers)
// ---------------------------------------------------------------------------

/** "Re 614k · #13 · 24/31 · 2 awaiting URANS" — condition label + index +
 *  real counts. Legacy nonzero needsReview payloads are described as
 *  unavailable; payloads without the split keep the rejected wording. `stateLabel`
 *  is the ConditionStrip display state; anything other than "active" is
 *  appended so kept/critical/retired/released stay visible without column
 *  headers. */
export function segmentTitle(
  condition: Pick<AdminCampaignConditionSummary, "reynolds" | "ord">,
  cell: CoverageCell | null | undefined,
  stateLabel?: string,
): string {
  const parts = [`Re ${formatRe(condition.reynolds)}`, `#${condition.ord}`];
  if (!cell || cell.requested <= 0) {
    parts.push("no points");
  } else {
    parts.push(`${fCount(terminalCount(cell))}/${fCount(cell.requested)}`);
    const hasSplit = cell.awaitingUrans != null || cell.needsReview != null;
    if (hasSplit) {
      if ((cell.awaitingUrans ?? 0) > 0)
        parts.push(`${fCount(cell.awaitingUrans ?? 0)} awaiting URANS`);
      if ((cell.needsReview ?? 0) > 0)
        parts.push(`${fCount(cell.needsReview ?? 0)} unavailable`);
    } else if (cell.rejected > 0) {
      parts.push(`${fCount(cell.rejected)} rejected`);
    }
    if ((cell.blocked ?? 0) > 0) {
      const critical = cell.blocked ?? 0;
      parts.push(
        `${fCount(critical)} critical failure${critical === 1 ? "" : "s"}`,
      );
    }
    if (cell.failed > 0) parts.push(`${fCount(cell.failed)} failed`);
    if (cell.running > 0) parts.push(`${fCount(cell.running)} running`);
    const sync = syncPromisedCount(cell);
    if (sync > 0) parts.push(`${fCount(sync)} sync-promised`);
  }
  if (stateLabel && stateLabel !== "active") parts.push(stateLabel);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Row "DONE" fraction
// ---------------------------------------------------------------------------

/** Per-row "n/total" over the conditions currently rendered in the bar
 *  (visible conditions, or the selected chord group when grouped): terminal
 *  points / requested points. Matches the segment fill semantics. */
export function rowDoneFraction(
  row: AdminCampaignAirfoilRow,
  renderedConditionIds: ReadonlySet<string>,
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const cell of row.perCondition) {
    if (!renderedConditionIds.has(cell.conditionId)) continue;
    done += terminalCount(cell);
    total += cell.requested;
  }
  return { done, total };
}

// ---------------------------------------------------------------------------
// Chord grouping (very-many-conditions fallback)
// ---------------------------------------------------------------------------

/** Below this per-segment width the segments stop being usable hover/click
 *  targets (mockup annotation: "min 4px, then the bar groups conditions by
 *  chord with a chord selector above"). Current real campaigns run 9–30
 *  conditions, so the ungrouped path is the primary one; grouping only
 *  engages when the measured bar width can no longer give every condition
 *  MIN_SEGMENT_PX after SEGMENT_GAP_PX gaps. */
export const MIN_SEGMENT_PX = 4;
export const SEGMENT_GAP_PX = 2;

export function needsChordGrouping(
  conditionCount: number,
  barWidthPx: number,
): boolean {
  if (conditionCount <= 1 || barWidthPx <= 0) return false;
  const perSegment =
    (barWidthPx - (conditionCount - 1) * SEGMENT_GAP_PX) / conditionCount;
  return perSegment < MIN_SEGMENT_PX;
}

export interface ChordGroup {
  /** Stable key: canonical chord number as string, or "none". */
  key: string;
  /** Chip label, e.g. "c 0.3 m". */
  label: string;
  conditions: AdminCampaignConditionSummary[];
}

function fChord(v: number): string {
  return `${v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")} m`;
}

/** Groups conditions by their real plan chord (chordM), ascending, with the
 *  chord-less bucket last. Condition order within a group is preserved from
 *  the input (ord order). If every condition shares one chord the caller gets
 *  a single group and keeps the ungrouped rendering — grouping cannot help. */
export function groupConditionsByChord(
  conditions: AdminCampaignConditionSummary[],
): ChordGroup[] {
  const map = new Map<string, ChordGroup>();
  for (const c of conditions) {
    const key = c.chordM == null ? "none" : String(c.chordM);
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        label: c.chordM == null ? "no chord" : `c ${fChord(c.chordM)}`,
        conditions: [],
      };
      map.set(key, group);
    }
    group.conditions.push(c);
  }
  return [...map.values()].sort((a, b) => {
    if (a.key === "none") return b.key === "none" ? 0 : 1;
    if (b.key === "none") return -1;
    return Number(a.key) - Number(b.key);
  });
}
