import { fRe } from "./format";
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
export function derivedBySymmetryInfo(p: PolarPointData): DerivedBySymmetryInfo {
  const d = p as PolarPointData & { derived?: boolean; derivedFromResultId?: string | null; derivedFromAoaDeg?: number | null };
  if (d.derived !== true) return { derived: false, derivedFromResultId: null, derivedFromAoaDeg: null };
  return {
    derived: true,
    derivedFromResultId: d.derivedFromResultId ?? p.resultId ?? null,
    derivedFromAoaDeg: typeof d.derivedFromAoaDeg === "number" ? d.derivedFromAoaDeg : null,
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
  return [p.a, p.cm];
}

/** "Nice" axis tick steps — verbatim from the prototype. */
export function niceTicks(min: number, max: number, count: number): { step: number; out: number[] } {
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

export interface ProjectChartInput {
  chartType: ChartType;
  /** all per-Re polars available (used for the Cl–Cd domain scan regardless of visibility) */
  polars: { re: number; color: string; points: PolarPointData[]; fit?: PolarFit | null }[];
  visibleRe: Record<number, boolean>;
  hoverKey?: string | null;
}

interface VisCurve {
  re: number;
  color: string;
  dash: string;
  data: PolarPointData[];
  label: string;
  kind: "measured" | "fit";
}

/**
 * Project polars into SVG-ready curves/points/ticks. Pure port of the chart
 * section of renderVals() in Airfoil Detail.dc.html — same coordinate math,
 * colors, point radii and post-stall styling.
 */
export function projectChart(input: ProjectChartInput): ChartProjection {
  const { chartType: type, polars, visibleRe, hoverKey } = input;
  const { PX0, PX1, PY0, PY1 } = CHART_VIEW;

  const visCurves: VisCurve[] = [];
  for (const pl of polars) {
    if (visibleRe[pl.re]) {
      visCurves.push({
        re: pl.re,
        color: pl.color,
        dash: "0",
        data: pl.points,
        label: "Re " + fRe(pl.re),
        kind: "measured",
      });
      if (pl.fit?.points.length) {
        visCurves.push({
          re: pl.re,
          color: pl.color,
          dash: "7 5",
          data: pl.fit.points.map((p) => ({
            a: p.a,
            cl: p.cl,
            cd: p.cd,
            cm: p.cm,
            ld: p.ld,
            stalled: false,
            source: "queued",
            resultId: null,
          })),
          label: "fit Re " + fRe(pl.re),
          kind: "fit",
        });
      }
    }
  }

  // ---- domain ----
  let xMin: number;
  let xMax: number;
  if (type === "clcd") {
    let mx = 0;
    for (const pl of polars) {
      for (const p of pl.points) {
        if (!p.stalled && p.cd > mx) mx = p.cd;
      }
      for (const p of pl.fit?.points ?? []) {
        if (p.cd > mx) mx = p.cd;
      }
    }
    xMin = 0;
    xMax = Math.min(0.05, mx * 1.18);
    if (xMax < 0.02) xMax = 0.02;
  } else {
    xMin = -8;
    xMax = 20;
  }
  let yMin = 1e9;
  let yMax = -1e9;
  let hasDomainData = false;
  for (const c of visCurves) {
    for (const p of c.data) {
      const [xx, yy] = xyOf(p, type);
      if (type === "clcd" && (xx > xMax || xx < xMin)) continue;
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

  const mapX = (v: number) => PX0 + ((v - xMin) / (xMax - xMin)) * (PX1 - PX0);
  const mapY = (v: number) => PY1 - ((v - yMin) / (yMax - yMin)) * (PY1 - PY0);

  // ---- ticks ----
  let xTicks: ChartTick[];
  if (type === "clcd") {
    const nt = niceTicks(xMin, xMax, 5);
    xTicks = nt.out.map((v) => ({ pos: mapX(v), labelPos: mapX(v), label: v.toFixed(3) }));
  } else {
    xTicks = [-8, -4, 0, 4, 8, 12, 16, 20]
      .filter((v) => v >= xMin && v <= xMax)
      .map((v) => ({ pos: mapX(v), labelPos: mapX(v), label: String(v) }));
  }
  const ynt = niceTicks(yMin, yMax, 6);
  const ydp = type === "cma" ? 2 : type === "lda" ? 0 : 1;
  const yTicks: ChartTick[] = ynt.out.map((v) => ({
    pos: mapY(v),
    labelPos: mapY(v) + 3,
    label: v.toFixed(ydp),
  }));

  // ---- curve polylines ----
  const curves: ChartCurve[] = visCurves.map((c) => {
    let pts = "";
    for (const p of c.data) {
      const [xx, yy] = xyOf(p, type);
      if (type === "clcd" && (xx > xMax || xx < xMin)) continue;
      if (!Number.isFinite(xx) || !Number.isFinite(yy)) continue;
      pts += mapX(xx).toFixed(1) + "," + mapY(yy).toFixed(1) + " ";
    }
    return {
      re: c.re,
      color: c.color,
      dash: c.dash,
      width: 1.6,
      opacity: c.kind === "fit" ? 0.92 : 0.72,
      points: pts.trim(),
      label: c.label,
      kind: c.kind,
    };
  });

  // ---- clickable points ----
  const points: ChartPointVM[] = [];
  for (const c of visCurves) {
    for (const p of c.data) {
      if (p.source !== "solved" || !p.resultId) continue;
      const [xx, yy] = xyOf(p, type);
      if (type === "clcd" && (xx > xMax || xx < xMin)) continue;
      if (!Number.isFinite(xx) || !Number.isFinite(yy)) continue;
      const cx = mapX(xx);
      const cy = mapY(yy);
      // Derived-by-symmetry mirrors share the source resultId, so their key
      // (and hover identity) must also carry the mirrored angle (spec §9.3).
      const derivedNote = derivedBySymmetryNote(p);
      const key = c.label + ":" + (p.resultId ?? p.a) + (derivedNote ? ":d" + p.a : "");
      const hovered = key === hoverKey;
      const provisional = p.classificationState === "needs_urans";
      // Derived points render hollow in the curve colour — visually distinct
      // from provisional (amber) and post-stall (red) outlines.
      const fill = derivedNote ? "#0a0f15" : p.stalled ? "#0a0f15" : provisional ? "#0a0f15" : c.color;
      const stroke = p.stalled ? "#ef4444" : provisional ? "#f59e0b" : derivedNote ? c.color : "rgba(7,11,16,0.6)";
      points.push({
        cx,
        cy,
        r: hovered ? 5.5 : 3,
        fill,
        stroke,
        sw: p.stalled || provisional ? 1.8 : derivedNote ? 1.6 : 1,
        re: c.re,
        label: derivedNote ? c.label + " · " + derivedNote : c.label,
        stalled: p.stalled,
        key,
        point: p,
      });
    }
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
