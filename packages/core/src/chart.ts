import type {
  ChartCurve,
  ChartPointVM,
  ChartProjection,
  ChartTick,
  ChartType,
  PolarFit,
  PolarPointData,
} from "./types";

/** Polar-chart viewBox + plot-area padding — verbatim from Airfoil Detail.dc.html. */
export const CHART_VIEW = {
  w: 684,
  h: 372,
  PX0: 58,
  PX1: 664,
  PY0: 20,
  PY1: 344,
} as const;

const X_TITLE: Record<ChartType, string> = {
  cla: "angle of attack α  [deg]",
  clcd: "drag coefficient  Cd",
  lda: "angle of attack α  [deg]",
  cma: "angle of attack α  [deg]",
};
const Y_TITLE: Record<ChartType, string> = {
  cla: "Cl",
  clcd: "Cl",
  lda: "L/D",
  cma: "Cm",
};

/** Provenance of a derived-by-symmetry display point (spec §9.3). The detail
 *  payload marks mirrored points with derived/derivedFromResultId/
 *  derivedFromAoaDeg; core PolarPointData keeps them structural so producers
 *  can attach them without widening every polar consumer. */
export interface DerivedBySymmetryInfo {
  derived: boolean;
  derivedFromResultId: string | null;
  derivedFromAoaDeg: number | null;
}

/** Read the derived-by-symmetry marker off a polar point (absent → not derived). */
export function derivedBySymmetryInfo(
  p: PolarPointData,
): DerivedBySymmetryInfo {
  const d = p as PolarPointData & {
    derived?: boolean;
    derivedFromResultId?: string | null;
    derivedFromAoaDeg?: number | null;
  };
  if (d.derived !== true)
    return {
      derived: false,
      derivedFromResultId: null,
      derivedFromAoaDeg: null,
    };
  return {
    derived: true,
    derivedFromResultId: d.derivedFromResultId ?? p.resultId ?? null,
    derivedFromAoaDeg:
      typeof d.derivedFromAoaDeg === "number" ? d.derivedFromAoaDeg : null,
  };
}

/** Exact §9.3 tooltip note for a mirrored point, e.g. "derived by symmetry (from +4°)". */
export function derivedBySymmetryNote(p: PolarPointData): string | null {
  const info = derivedBySymmetryInfo(p);
  if (!info.derived) return null;
  const src = info.derivedFromAoaDeg ?? Math.abs(p.a);
  return `derived by symmetry (from +${formatSourceAoa(src)}°)`;
}

function formatSourceAoa(a: number): string {
  // canonical 0.01° display, trailing zeros trimmed ("4", "4.5", "4.25")
  return String(Math.round(a * 100) / 100);
}

export function xyOf(p: PolarPointData, type: ChartType): [number, number] {
  if (type === "cla") return [p.a, p.cl];
  if (type === "clcd") return [p.cd, p.cl];
  if (type === "lda") return [p.a, p.ld];
  return [p.a, p.cm ?? Number.NaN];
}

/** "Nice" axis tick steps — verbatim from the prototype. */
export function niceTicks(
  min: number,
  max: number,
  count: number,
): { step: number; out: number[] } {
  const span = max - min || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) {
    out.push(Math.abs(v) < step / 1000 ? 0 : v);
  }
  return { step, out };
}

/** A data-space window of the chart (zoom/pan state round-trips through it). */
export interface ChartDomain {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface ProjectChartInput {
  chartType: ChartType;
  /** All public polar series available (used for the Cl–Cd domain scan
   *  regardless of visibility). Reynolds is display metadata, not identity. */
  polars: {
    seriesId: string;
    label: string;
    re: number;
    color: string;
    points: PolarPointData[];
    fit?: PolarFit | null;
  }[];
  visibleSeries: Record<string, boolean>;
  hoverKey?: string | null;
  /** Zoom/pan window override. Omitted/null → fit the visible data (auto). */
  domain?: Partial<ChartDomain> | null;
}

interface VisCurve {
  seriesId: string;
  re: number;
  color: string;
  dash: string;
  data: PolarPointData[];
  label: string;
  kind: "measured" | "fit";
}

interface VisPointSeries {
  seriesId: string;
  re: number;
  color: string;
  data: PolarPointData[];
  label: string;
}

function isPrimaryEvidence(point: PolarPointData): boolean {
  return point.evidenceRole == null || point.evidenceRole === "primary";
}

/** Build measured-line segments from primary evidence only. A conflict-only
 * angle is an explicit break: the chart keeps every contradictory result as a
 * clickable marker without drawing a line through an unresolved measurement. */
export function measuredEvidenceSegments(
  points: PolarPointData[],
): PolarPointData[][] {
  const byAoa = new Map<number, PolarPointData[]>();
  for (const point of [...points].sort((a, b) => a.a - b.a)) {
    const bucket = byAoa.get(point.a) ?? [];
    bucket.push(point);
    byAoa.set(point.a, bucket);
  }
  const segments: PolarPointData[][] = [];
  let current: PolarPointData[] = [];
  for (const bucket of byAoa.values()) {
    const primary = bucket.filter(isPrimaryEvidence);
    if (primary.length === 0) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(...primary);
  }
  if (current.length) segments.push(current);
  return segments;
}

function finiteChartSegments(
  points: PolarPointData[],
  type: ChartType,
): PolarPointData[][] {
  const segments: PolarPointData[][] = [];
  let current: PolarPointData[] = [];
  for (const point of points) {
    const [x, y] = xyOf(point, type);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}

/**
 * Project polars into SVG-ready curves/points/ticks. Pure port of the chart
 * section of renderVals() in Airfoil Detail.dc.html — same coordinate math,
 * colors, point radii and post-stall styling.
 */
export function projectChart(input: ProjectChartInput): ChartProjection {
  const { chartType: type, polars, visibleSeries, hoverKey } = input;
  const { PX0, PX1, PY0, PY1 } = CHART_VIEW;

  const visCurves: VisCurve[] = [];
  const visPointSeries: VisPointSeries[] = [];
  for (const pl of polars) {
    if (visibleSeries[pl.seriesId]) {
      visPointSeries.push({
        seriesId: pl.seriesId,
        re: pl.re,
        color: pl.color,
        data: pl.points,
        label: pl.label,
      });
      const measuredSegments = measuredEvidenceSegments(pl.points).flatMap(
        (segment) => finiteChartSegments(segment, type),
      );
      for (const segment of measuredSegments) {
        visCurves.push({
          seriesId: pl.seriesId,
          re: pl.re,
          color: pl.color,
          dash: "0",
          data: segment,
          label: pl.label,
          kind: "measured",
        });
      }
      if (pl.fit?.points.length) {
        // Support-gated: fit samples are drawn only where measured data
        // backs them. LOWESS interpolation across large solved-α gaps (and
        // extrapolation past the coverage ends) invents physically impossible
        // polar shapes — prod incident: an S1223 drag polar with 7 solved
        // points drew a second Cl-Cd lobe below the measured Cd minimum.
        for (const measuredSegment of measuredSegments) {
          for (const seg of supportedFitSegments(
            pl.fit.points,
            measuredSegment.map((point) => point.a),
          )) {
            visCurves.push({
              seriesId: pl.seriesId,
              re: pl.re,
              color: pl.color,
              dash: "7 5",
              data: seg.map(fitPointToPolarPoint),
              label: pl.label,
              kind: "fit",
            });
          }
        }
      }
    }
  }

  // ---- domain ----
  // Auto domain = zoom-to-fit: derived from the visible data. A zoom/pan
  // override (input.domain) replaces any subset of the fitted window.
  let xMin: number;
  let xMax: number;
  if (type === "clcd") {
    let mx = 0;
    for (const pl of polars) {
      for (const p of pl.points) {
        if (!p.stalled && p.cd > mx) mx = p.cd;
      }
    }
    // Fit contribution to the Cd window comes from the SUPPORT-GATED curves
    // (visCurves), never raw fit samples — unsupported LOWESS lobes must not
    // stretch the axis any more than they may draw.
    for (const c of visCurves) {
      if (c.kind !== "fit") continue;
      for (const p of c.data) {
        if (p.cd > mx) mx = p.cd;
      }
    }
    xMin = 0;
    xMax = Math.min(0.05, mx * 1.18);
    if (xMax < 0.02) xMax = 0.02;
  } else {
    // Fit the α window to the visible data (measured + fit samples). The
    // historical fixed −8..20 window predates campaign sweeps (prod: −15..30)
    // and drew wider polars OUTSIDE the axes; it survives only as the
    // no-data fallback.
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const c of [...visCurves, ...visPointSeries]) {
      for (const p of c.data) {
        const [xx, yy] = xyOf(p, type);
        if (!Number.isFinite(xx) || !Number.isFinite(yy)) continue;
        if (xx < aMin) aMin = xx;
        if (xx > aMax) aMax = xx;
      }
    }
    if (aMin > aMax) {
      xMin = -8;
      xMax = 20;
    } else {
      const pad = Math.max(0.5, (aMax - aMin) * 0.03);
      xMin = aMin - pad;
      xMax = aMax + pad;
    }
  }
  const override = input.domain;
  if (override) {
    if (Number.isFinite(override.xMin as number))
      xMin = override.xMin as number;
    if (Number.isFinite(override.xMax as number))
      xMax = override.xMax as number;
    if (xMax - xMin < 1e-9) xMax = xMin + 1e-9;
  }
  let yMin = 1e9;
  let yMax = -1e9;
  let hasDomainData = false;
  for (const c of [...visCurves, ...visPointSeries]) {
    for (const p of c.data) {
      const [xx, yy] = xyOf(p, type);
      if (!Number.isFinite(xx) || !Number.isFinite(yy)) continue;
      if (xx > xMax || xx < xMin) continue;
      if (yy < yMin) yMin = yy;
      if (yy > yMax) yMax = yy;
      hasDomainData = true;
    }
  }
  if (!hasDomainData) {
    if (type === "lda") {
      yMin = -5;
      yMax = 25;
    } else if (type === "cma") {
      yMin = -0.25;
      yMax = 0.1;
    } else {
      yMin = -1;
      yMax = 1;
    }
  } else {
    const pad = (yMax - yMin) * 0.08 || 1;
    yMin -= pad;
    yMax += pad;
  }
  if (override) {
    if (Number.isFinite(override.yMin as number))
      yMin = override.yMin as number;
    if (Number.isFinite(override.yMax as number))
      yMax = override.yMax as number;
    if (yMax - yMin < 1e-12) yMax = yMin + 1e-12;
  }

  const mapX = (v: number) => PX0 + ((v - xMin) / (xMax - xMin)) * (PX1 - PX0);
  const mapY = (v: number) => PY1 - ((v - yMin) / (yMax - yMin)) * (PY1 - PY0);

  // ---- ticks ----
  let xTicks: ChartTick[];
  if (type === "clcd") {
    const nt = niceTicks(xMin, xMax, 5);
    xTicks = nt.out.map((v) => ({
      pos: mapX(v),
      labelPos: mapX(v),
      label: v.toFixed(3),
    }));
  } else {
    // Dynamic α ticks: the window is data-fitted (and zoomable), so the old
    // fixed −8..20 tick list no longer spans it.
    const nt = niceTicks(xMin, xMax, 7);
    xTicks = nt.out.map((v) => {
      const r = Math.round(v * 100) / 100;
      return { pos: mapX(v), labelPos: mapX(v), label: String(r) };
    });
  }
  const ynt = niceTicks(yMin, yMax, 6);
  const ydp = type === "cma" ? 2 : type === "lda" ? 0 : 1;
  const yTicks: ChartTick[] = ynt.out.map((v) => ({
    pos: mapY(v),
    labelPos: mapY(v) + 3,
    label: v.toFixed(ydp),
  }));

  // ---- curve polylines ----
  // Every curve is clipped to the domain box in DATA space (segment
  // intersections interpolated at the window edges), so no polyline
  // coordinate can leave the plot rect — the pre-clip code drew campaign
  // polars (α beyond the window) across the axes into the margins. A curve
  // that exits and re-enters the window becomes multiple ChartCurve entries.
  const curves: ChartCurve[] = [];
  const domainBox: ChartDomain = { xMin, xMax, yMin, yMax };
  for (let curveIndex = 0; curveIndex < visCurves.length; curveIndex++) {
    const c = visCurves[curveIndex];
    const segments = clipCurveToDomain(c.data, type, domainBox);
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const seg = segments[segmentIndex];
      curves.push({
        key: `${c.seriesId}:${c.kind}:${curveIndex}:${segmentIndex}`,
        seriesId: c.seriesId,
        re: c.re,
        color: c.color,
        dash: c.dash,
        width: 1.6,
        opacity: c.kind === "fit" ? 0.92 : 0.72,
        points: seg
          .map(([xx, yy]) => mapX(xx).toFixed(1) + "," + mapY(yy).toFixed(1))
          .join(" "),
        label: c.label,
        kind: c.kind,
      });
    }
  }

  // ---- clickable points ----
  const points: ChartPointVM[] = [];
  const pointGroups = new Map<
    string,
    {
      series: VisPointSeries;
      cx: number;
      cy: number;
      choices: PolarPointData[];
    }
  >();
  for (const c of visPointSeries) {
    for (const p of c.data) {
      if (p.source !== "solved" || !p.resultId) continue;
      const [xx, yy] = xyOf(p, type);
      if (xx > xMax || xx < xMin || yy > yMax || yy < yMin) continue;
      if (!Number.isFinite(xx) || !Number.isFinite(yy)) continue;
      const cx = mapX(xx);
      const cy = mapY(yy);
      const stackKey = `${c.seriesId}:${xx}:${yy}`;
      const group = pointGroups.get(stackKey);
      if (group) group.choices.push(p);
      else pointGroups.set(stackKey, { series: c, cx, cy, choices: [p] });
    }
  }
  const roleRank = (point: PolarPointData) =>
    point.evidenceRole === "primary"
      ? 0
      : point.evidenceRole === "conflict"
        ? 1
        : point.evidenceRole === "alternate"
          ? 2
          : 0;
  for (const group of pointGroups.values()) {
    const choices = group.choices.sort(
      (a, b) =>
        roleRank(a) - roleRank(b) ||
        (a.resultId ?? "").localeCompare(b.resultId ?? ""),
    );
    const p = choices[0];
    const c = group.series;
    const derivedNote = derivedBySymmetryNote(p);
    const choiceIds = choices
      .map((choice) => choice.resultId)
      .sort()
      .join(":");
    const key = c.seriesId + ":" + choiceIds + (derivedNote ? ":d" + p.a : "");
    const hovered = key === hoverKey;
    const provisional = p.classificationState === "needs_urans";
    const alternate = p.evidenceRole === "alternate";
    const conflict = p.evidenceRole === "conflict";
    const stacked = choices.length > 1;
    const anyConflict = choices.some(
      (choice) => choice.evidenceRole === "conflict",
    );
    const anyAlternate = choices.some(
      (choice) => choice.evidenceRole === "alternate",
    );
    const baseRadius = stacked ? 5.2 : alternate ? 4.8 : conflict ? 4.2 : 3;
    // Derived points render hollow in the curve colour — visually distinct
    // from provisional (amber) and post-stall (red) outlines.
    const fill =
      stacked || alternate || conflict
        ? "#0a0f15"
        : derivedNote
          ? "#0a0f15"
          : p.stalled
            ? "#0a0f15"
            : provisional
              ? "#0a0f15"
              : c.color;
    const stroke = anyConflict
      ? "#d946ef"
      : stacked || anyAlternate
        ? "#94a3b8"
        : p.stalled
          ? "#ef4444"
          : provisional
            ? "#f59e0b"
            : derivedNote
              ? c.color
              : "rgba(7,11,16,0.6)";
    const roleNote = anyConflict
      ? " · repeated measurements disagree · excluded from best-fit"
      : stacked
        ? ` · ${choices.length} stored results`
        : alternate
          ? " · alternate stored result · excluded from best-fit"
          : "";
    points.push({
      cx: group.cx,
      cy: group.cy,
      r: hovered ? baseRadius + 2.5 : baseRadius,
      fill,
      stroke,
      sw: anyConflict
        ? 2.4
        : stacked
          ? 2.2
          : conflict
            ? 2.2
            : alternate
              ? 1.8
              : p.stalled || provisional
                ? 1.8
                : derivedNote
                  ? 1.6
                  : 1,
      seriesId: c.seriesId,
      re: c.re,
      label: (derivedNote ? c.label + " · " + derivedNote : c.label) + roleNote,
      stalled: choices.some((choice) => choice.stalled),
      key,
      point: p,
      resultChoices: stacked ? choices : undefined,
    });
  }

  return {
    curves,
    points,
    xTicks,
    yTicks,
    xTitle: X_TITLE[type],
    yTitle: Y_TITLE[type],
    domain: { xMin, xMax, yMin, yMax },
  };
}

// ============================ domain clipping ============================

/** Liang–Barsky clip of one segment against the domain box in DATA space.
 *  Returns the clipped endpoints, or null when the segment misses the box. */
function clipSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  dom: ChartDomain,
): [[number, number], [number, number]] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const edges: [number, number][] = [
    [-dx, x0 - dom.xMin],
    [dx, dom.xMax - x0],
    [-dy, y0 - dom.yMin],
    [dy, dom.yMax - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [
    [x0 + t0 * dx, y0 + t0 * dy],
    [x0 + t1 * dx, y0 + t1 * dy],
  ];
}

/** Clip a data series to the domain box. A curve that leaves and re-enters
 *  the window splits into separate visible segments (each length ≥ 2), with
 *  the boundary crossings interpolated — never clamped, never bled outside. */
export function clipCurveToDomain(
  data: PolarPointData[],
  type: ChartType,
  dom: ChartDomain,
): [number, number][][] {
  const epsX = (dom.xMax - dom.xMin) * 1e-9;
  const epsY = (dom.yMax - dom.yMin) * 1e-9;
  const segs: [number, number][][] = [];
  let cur: [number, number][] = [];
  let prev: [number, number] | null = null;
  const flush = () => {
    if (cur.length >= 2) segs.push(cur);
    cur = [];
  };
  for (const p of data) {
    const [xx, yy] = xyOf(p, type);
    if (!Number.isFinite(xx) || !Number.isFinite(yy)) {
      flush();
      prev = null;
      continue;
    }
    if (prev === null) {
      prev = [xx, yy];
      if (
        xx >= dom.xMin &&
        xx <= dom.xMax &&
        yy >= dom.yMin &&
        yy <= dom.yMax
      ) {
        cur.push([xx, yy]);
      }
      continue;
    }
    const clipped = clipSegment(prev[0], prev[1], xx, yy, dom);
    prev = [xx, yy];
    if (!clipped) {
      flush();
      continue;
    }
    const [a, b] = clipped;
    const last = cur[cur.length - 1];
    if (
      !last ||
      Math.abs(last[0] - a[0]) > epsX ||
      Math.abs(last[1] - a[1]) > epsY
    ) {
      flush();
      cur.push(a);
    }
    cur.push(b);
  }
  flush();
  return segs;
}

// ============================ zoom / pan ============================

/** New window after zooming by `factor` (<1 = in, >1 = out) about a data
 *  point; the anchor keeps its screen position (map-style zoom). */
export function zoomChartDomain(
  dom: ChartDomain,
  factor: number,
  center: { x: number; y: number },
): ChartDomain {
  const f = Math.min(10, Math.max(0.05, factor));
  const cx = Math.min(dom.xMax, Math.max(dom.xMin, center.x));
  const cy = Math.min(dom.yMax, Math.max(dom.yMin, center.y));
  return {
    xMin: cx - (cx - dom.xMin) * f,
    xMax: cx + (dom.xMax - cx) * f,
    yMin: cy - (cy - dom.yMin) * f,
    yMax: cy + (dom.yMax - cy) * f,
  };
}

/** Translate the window by data-space deltas (drag pan). */
export function panChartDomain(
  dom: ChartDomain,
  dx: number,
  dy: number,
): ChartDomain {
  return {
    xMin: dom.xMin + dx,
    xMax: dom.xMax + dx,
    yMin: dom.yMin + dy,
    yMax: dom.yMax + dy,
  };
}

// ============================ cursor readout ============================

export interface ChartReadoutRow {
  seriesId: string;
  re: number;
  color: string;
  label: string;
  kind: "measured" | "fit";
  y: number;
}

function fitPointToPolarPoint(p: {
  a: number;
  cl: number;
  cd: number;
  cm: number;
  ld: number;
}): PolarPointData {
  return {
    a: p.a,
    cl: p.cl,
    cd: p.cd,
    cm: p.cm,
    ld: p.ld,
    stalled: false,
    source: "queued",
    resultId: null,
  };
}

// ---- fit support gating ----
// A fit sample is drawn only where measured data backs it. The rule works on
// the INTERVALS between consecutive measured α: an interval is bridgeable iff
// it is no wider than max(2× the median measured gap, 6°); fit samples inside
// non-bridgeable holes are dropped, and nothing draws beyond the measured α
// range at all (a LOWESS fit has no business extrapolating). A −15…30° sweep
// solved every 5° keeps one continuous fit; a polar with a 15° pending-URANS
// hole gets the hole left visibly open instead of bridged by invented values.
const FIT_BRIDGE_FLOOR_DEG = 6;
const FIT_BRIDGE_GAP_FACTOR = 2;

export function measuredAlphas(points: PolarPointData[]): number[] {
  return points
    .filter(isPrimaryEvidence)
    .map((p) => p.a)
    .filter((a) => Number.isFinite(a));
}

export function fitBridgeThresholdDeg(alphas: number[]): number {
  const sorted = [...alphas].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  return Math.max(FIT_BRIDGE_FLOOR_DEG, median * FIT_BRIDGE_GAP_FACTOR);
}

/** Merge bridgeable measured intervals into supported α spans, then group fit
 *  samples by span. Spans yielding fewer than 2 samples are dropped (a lone
 *  sample cannot draw a curve). */
export function supportedFitSegments<T extends { a: number }>(
  fitPoints: T[],
  alphas: number[],
): T[][] {
  const sorted = [...new Set(alphas)].sort((a, b) => a - b);
  if (!fitPoints.length || sorted.length < 2) return [];
  const bridge = fitBridgeThresholdDeg(sorted);
  const spans: [number, number][] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - end <= bridge) {
      end = sorted[i];
    } else {
      spans.push([start, end]);
      start = sorted[i];
      end = sorted[i];
    }
  }
  spans.push([start, end]);
  return spans
    .map(([lo, hi]) =>
      fitPoints.filter((p) => p.a >= lo - 1e-9 && p.a <= hi + 1e-9),
    )
    .filter((s) => s.length >= 2);
}

/** Linear interpolation of a series' y at x; null outside the series' span. */
function interpSeriesAtX(
  points: PolarPointData[],
  type: ChartType,
  x: number,
): number | null {
  for (const segment of finiteChartSegments(points, type)) {
    const xs = segment
      .map((point) => xyOf(point, type))
      .sort((a, b) => a[0] - b[0]);
    if (!xs.length || x < xs[0][0] || x > xs[xs.length - 1][0]) continue;
    if (xs.length === 1) return x === xs[0][0] ? xs[0][1] : null;
    for (let i = 1; i < xs.length; i++) {
      if (x <= xs[i][0]) {
        const [x0, y0] = xs[i - 1];
        const [x1, y1] = xs[i];
        if (x1 === x0) return y0;
        return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return xs[xs.length - 1][1];
  }
  return null;
}

/** Every visible curve's interpolated value at cursor α (α-x charts only —
 *  Cl–Cd has no single-valued x there; snap to the nearest point instead). */
export function readoutAtX(input: {
  chartType: ChartType;
  polars: ProjectChartInput["polars"];
  visibleSeries: Record<string, boolean>;
  x: number;
}): ChartReadoutRow[] {
  const { chartType: type, polars, visibleSeries, x } = input;
  if (type === "clcd") return [];
  const rows: ChartReadoutRow[] = [];
  for (const pl of polars) {
    if (!visibleSeries[pl.seriesId]) continue;
    const measuredSegments = measuredEvidenceSegments(pl.points).flatMap(
      (segment) => finiteChartSegments(segment, type),
    );
    const measured =
      measuredSegments
        .map((segment) => interpSeriesAtX(segment, type, x))
        .find((value) => value !== null) ?? null;
    if (measured !== null) {
      rows.push({
        seriesId: pl.seriesId,
        re: pl.re,
        color: pl.color,
        label: pl.label,
        kind: "measured",
        y: measured,
      });
    }
    if (pl.fit?.points.length) {
      // Same support gating as the drawn curve: never read out a fit value
      // the chart refuses to draw (unsupported span or extrapolated tail).
      let fitMatched = false;
      for (const measuredSegment of measuredSegments) {
        for (const seg of supportedFitSegments(
          pl.fit.points,
          measuredSegment.map((point) => point.a),
        )) {
          const fy = interpSeriesAtX(seg.map(fitPointToPolarPoint), type, x);
          if (fy !== null) {
            rows.push({
              seriesId: pl.seriesId,
              re: pl.re,
              color: pl.color,
              label: `${pl.label} · best-fit`,
              kind: "fit",
              y: fy,
            });
            fitMatched = true;
            break;
          }
        }
        if (fitMatched) break;
      }
    }
  }
  return rows;
}
