import type {
  PolarFit,
  PolarFitMetrics,
  PolarFitPoint,
  PolarFitStatus,
  ResultClassificationRegion,
  ResultClassificationState,
  ResultRegime,
} from "./types";

export const POLAR_CLASSIFIER_VERSION = "rans-stall-v1";
export const POLAR_FIT_VERSION = "evidence-lowess-v2";

export interface PolarEvidencePoint {
  id?: string | null;
  attemptId?: string | null;
  a: number;
  cl: number | null;
  cd: number | null;
  cm: number | null;
  ld?: number | null;
  status: string;
  source: string;
  regime: ResultRegime | null;
  converged: boolean;
  stalled: boolean;
  unsteady?: boolean;
  error?: string | null;
  finalResidual?: number | null;
  iterations?: number | null;
  firstOrderFallback?: boolean | null;
  validForPolar?: boolean | null;
  hasForceHistory?: boolean;
  hasVideo?: boolean;
}

export interface PolarEvidenceClassification {
  evidence: PolarEvidencePoint;
  state: ResultClassificationState;
  region: ResultClassificationRegion;
  confidence: number;
  reasons: string[];
}

export interface ClassifiedPolar {
  classifications: PolarEvidenceClassification[];
  needsUransAoas: number[];
  hardRejectedAoas: number[];
  lowAoaFailure: boolean;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function ldOf(p: PolarEvidencePoint): number | null {
  if (finite(p.ld)) return p.ld;
  if (!finite(p.cl) || !finite(p.cd) || p.cd === 0) return null;
  return p.cl / p.cd;
}

function median(values: number[], fallback: number): number {
  const xs = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!xs.length) return fallback;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function nominalStep(points: PolarEvidencePoint[]): number {
  const xs = [...new Set(points.map((p) => p.a).filter(Number.isFinite))].sort((a, b) => a - b);
  return median(
    xs.slice(1).map((x, i) => x - xs[i]),
    1,
  );
}

function linearSlope(points: PolarEvidencePoint[]): number | null {
  const usable = points.filter((p) => finite(p.a) && finite(p.cl));
  if (usable.length < 2) return null;
  const mx = usable.reduce((sum, p) => sum + p.a, 0) / usable.length;
  const my = usable.reduce((sum, p) => sum + (p.cl ?? 0), 0) / usable.length;
  let num = 0;
  let den = 0;
  for (const p of usable) {
    const dx = p.a - mx;
    num += dx * ((p.cl ?? 0) - my);
    den += dx * dx;
  }
  return den > 0 ? num / den : null;
}

function baseRejectionReasons(p: PolarEvidencePoint): string[] {
  const reasons: string[] = [];
  if (p.status !== "done" || p.source !== "solved") reasons.push("not-solved");
  if (!finite(p.cl) || !finite(p.cd) || !finite(p.cm)) reasons.push("missing-coefficients");
  if (finite(p.cd) && p.cd <= 0) reasons.push("non-positive-drag");
  if (p.error) reasons.push("solver-error");
  if (p.converged !== true) reasons.push("not-converged");
  if (p.stalled) reasons.push("solver-stalled");
  if (p.regime === "urans") {
    if (!p.hasForceHistory) reasons.push("missing-force-history");
    if (!p.hasVideo) reasons.push("missing-urans-video");
  }
  return reasons;
}

function acceptedForShape(c: PolarEvidenceClassification): boolean {
  return c.state === "accepted" && c.evidence.regime === "rans" && finite(c.evidence.cl) && finite(c.evidence.cd);
}

export function classifyPolarEvidence(points: PolarEvidencePoint[]): ClassifiedPolar {
  const ordered = [...points].sort((a, b) => a.a - b.a);
  const classifications: PolarEvidenceClassification[] = ordered.map((evidence) => {
    const reasons = baseRejectionReasons(evidence);
    const state: ResultClassificationState = reasons.length ? "rejected" : "accepted";
    return {
      evidence,
      state,
      region: state === "accepted" ? "attached" : "unknown",
      confidence: state === "accepted" ? 0.9 : 1,
      reasons,
    };
  });

  const acceptedRans = classifications.filter(acceptedForShape).map((c) => c.evidence);
  const step = nominalStep(acceptedRans);
  const lowAoaFailure = classifications.some((c) => c.evidence.regime === "rans" && c.evidence.a >= 0 && c.evidence.a <= 5 && c.state === "rejected");
  if (lowAoaFailure) {
    for (const c of classifications) {
      if (c.evidence.regime === "rans" && c.state === "accepted") {
        c.state = "needs_urans";
        c.region = "unknown";
        c.confidence = 0.9;
        c.reasons = ["low-aoa-rans-failure"];
      }
    }
  }

  if (!lowAoaFailure && acceptedRans.length >= 5) {
    const baseline = acceptedRans.filter((p) => p.a >= 0 && p.a <= 5);
    const fallback = acceptedRans.filter((p) => p.a >= -4 && p.a <= 6);
    const slope = linearSlope(baseline.length >= 3 ? baseline : fallback);
    if (slope !== null && slope > 0.005) {
      let peak = acceptedRans[0];
      for (const p of acceptedRans) {
        if ((p.cl ?? -Infinity) > (peak.cl ?? -Infinity)) peak = p;
      }
      const postStallStart = peak.a + Math.max(step * 1.5, 1.5);
      let runningClMax = -Infinity;
      let runningLdMax = -Infinity;
      let runningCdMin = Infinity;
      let prev: PolarEvidencePoint | null = null;

      for (const p of acceptedRans) {
        const cl = p.cl ?? 0;
        const cd = p.cd ?? 0;
        const ld = ldOf(p) ?? 0;
        const previousClMax = runningClMax;
        const previousLdMax = runningLdMax;
        const previousCdMin = runningCdMin;
        runningClMax = Math.max(runningClMax, cl);
        runningLdMax = Math.max(runningLdMax, ld);
        runningCdMin = Math.min(runningCdMin, cd);

        if (!prev || p.a < postStallStart) {
          prev = p;
          continue;
        }
        const da = Math.max(Math.abs(p.a - prev.a), step);
        const localSlope = (cl - (prev.cl ?? cl)) / da;
        const reasons: string[] = [];
        if (localSlope < slope * 0.35) reasons.push("lift-slope-collapse");
        if (Number.isFinite(previousClMax) && previousClMax > 0 && (previousClMax - cl) / previousClMax > 0.05) {
          reasons.push("lift-drop-from-running-max");
        }
        if (Number.isFinite(previousCdMin) && previousCdMin > 0 && cd / previousCdMin > 1.75) {
          reasons.push("drag-acceleration");
        }
        if (Number.isFinite(previousLdMax) && previousLdMax > 0 && ld / previousLdMax < 0.78) {
          reasons.push("ld-collapse");
        }
        if (finite(p.iterations) && p.iterations > 0 && finite(p.finalResidual) && p.finalResidual > 1e-4) {
          reasons.push("weak-steady-convergence");
        }

        if (reasons.length >= 2) {
          const target = classifications.find((c) => c.evidence === p);
          if (target) {
            target.state = "needs_urans";
            target.region = "post_stall";
            target.confidence = Math.min(0.95, 0.58 + reasons.length * 0.1);
            target.reasons = reasons;
          }
        } else if (p.a > peak.a) {
          const target = classifications.find((c) => c.evidence === p);
          if (target) target.region = "near_stall";
        }
        prev = p;
      }
    }
  }

  const needsUransAoas = classifications
    .filter((c) => c.state === "needs_urans")
    .map((c) => c.evidence.a)
    .sort((a, b) => a - b);
  const hardRejectedAoas = classifications
    .filter((c) => c.state === "rejected")
    .map((c) => c.evidence.a)
    .sort((a, b) => a - b);

  return { classifications, needsUransAoas, hardRejectedAoas, lowAoaFailure };
}

interface FitInput {
  a: number;
  cl: number;
  cd: number;
  cm: number;
  state: ResultClassificationState;
  regime: ResultRegime | null;
}

function weightFor(p: FitInput): number {
  if (p.state === "needs_urans") return 0.45;
  if (p.regime === "urans") return 1.4;
  return 1;
}

function solve3(a: number[][], b: number[]): [number, number, number] | null {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const scale = m[col][col];
    for (let c = col; c < 4; c++) m[col][c] /= scale;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const factor = m[r][col];
      for (let c = col; c < 4; c++) m[r][c] -= factor * m[col][c];
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
}

function localQuadratic(points: FitInput[], x: number, key: "cl" | "cd" | "cm", span: number): number {
  const normal = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rhs = [0, 0, 0];
  let totalWeight = 0;
  let weightedAverage = 0;
  for (const p of points) {
    const dx = p.a - x;
    const distanceWeight = Math.exp(-0.5 * (dx / span) ** 2);
    const w = distanceWeight * weightFor(p);
    const basis = [1, dx, dx * dx];
    const y = p[key];
    totalWeight += w;
    weightedAverage += w * y;
    for (let r = 0; r < 3; r++) {
      rhs[r] += w * basis[r] * y;
      for (let c = 0; c < 3; c++) normal[r][c] += w * basis[r] * basis[c];
    }
  }
  const solved = solve3(normal, rhs);
  return solved ? solved[0] : weightedAverage / Math.max(totalWeight, 1e-9);
}

function interpolateAtClZero(points: PolarFitPoint[], key: "cd" | "cm"): number {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.cl === 0) return a[key];
    if ((a.cl < 0 && b.cl > 0) || (a.cl > 0 && b.cl < 0) || b.cl === 0) {
      const t = (0 - a.cl) / (b.cl - a.cl || 1);
      return a[key] + t * (b[key] - a[key]);
    }
  }
  return [...points].sort((a, b) => Math.abs(a.cl) - Math.abs(b.cl))[0]?.[key] ?? 0;
}

interface FineTargetContext {
  evaluate: (a: number, key: "cl" | "cd" | "cm") => number;
  stepDeg: number;
  minA: number;
  maxA: number;
}

const roundCenti = (x: number): number => Number(x.toFixed(2));

function goldenSectionMax(f: (x: number) => number, lo: number, hi: number): number {
  const invPhi = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - invPhi * (b - a);
  let d = a + invPhi * (b - a);
  let fc = f(c);
  let fd = f(d);
  while (b - a > 1e-5) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - invPhi * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + invPhi * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

function bisectRoot(f: (x: number) => number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  let fa = f(a);
  if (fa === 0) return a;
  for (let i = 0; i < 80 && b - a > 1e-7; i++) {
    const mid = (a + b) / 2;
    const fm = f(mid);
    if (fm === 0) return mid;
    if ((fa < 0 && fm < 0) || (fa > 0 && fm > 0)) {
      a = mid;
      fa = fm;
    } else {
      b = mid;
    }
  }
  return (a + b) / 2;
}

function fitMetrics(points: PolarFitPoint[], fine: FineTargetContext): PolarFitMetrics | null {
  if (points.length < 3) return null;
  const finitePoints = points.filter((p) => finite(p.cl) && finite(p.cd) && finite(p.cm) && finite(p.ld));
  if (finitePoints.length < 3) return null;
  const byLd = [...finitePoints].sort((a, b) => b.ld - a.ld)[0];
  const byCl = [...finitePoints].sort((a, b) => b.cl - a.cl)[0];
  const byCd = [...finitePoints].sort((a, b) => a.cd - b.cd)[0];

  // Fine targets (spec §8): golden-section argmax of the LOWESS-evaluated L/D
  // bracketed ±1 sample step around the coarse-grid argmax, and the Cl root in
  // the sample interval bracketing the coarse Cl = 0 crossing.
  const alphaLdmaxFine = roundCenti(
    goldenSectionMax(
      (a) => fine.evaluate(a, "cl") / fine.evaluate(a, "cd"),
      Math.max(fine.minA, byLd.a - fine.stepDeg),
      Math.min(fine.maxA, byLd.a + fine.stepDeg),
    ),
  );
  let alphaClZeroFine: number | null = null;
  for (let i = 1; i < finitePoints.length; i++) {
    const a = finitePoints[i - 1];
    const b = finitePoints[i];
    if (a.cl === 0) {
      alphaClZeroFine = roundCenti(a.a);
      break;
    }
    if (b.cl === 0) {
      alphaClZeroFine = roundCenti(b.a);
      break;
    }
    if ((a.cl < 0 && b.cl > 0) || (a.cl > 0 && b.cl < 0)) {
      alphaClZeroFine = roundCenti(bisectRoot((x) => fine.evaluate(x, "cl"), a.a, b.a));
      break;
    }
  }

  return {
    ldmax: byLd.ld,
    aLd: byLd.a,
    cdmin: byCd.cd,
    clCd: byCd.cl,
    cd0: interpolateAtClZero(finitePoints, "cd"),
    clmax: byCl.cl,
    aStall: byCl.a,
    cm0: interpolateAtClZero(finitePoints, "cm"),
    alphaLdmaxFine,
    alphaClZeroFine,
  };
}

export function buildPolarFit(classifications: PolarEvidenceClassification[]): PolarFit {
  const fitInputs = classifications
    .filter((c) => c.state === "accepted" || c.state === "needs_urans")
    .filter((c) => finite(c.evidence.cl) && finite(c.evidence.cd) && finite(c.evidence.cm) && (c.evidence.cd ?? 0) > 0)
    .map<FitInput>((c) => ({
      a: c.evidence.a,
      cl: c.evidence.cl ?? 0,
      cd: c.evidence.cd ?? 0,
      cm: c.evidence.cm ?? 0,
      state: c.state,
      regime: c.evidence.regime,
    }))
    .sort((a, b) => a.a - b.a);
  const acceptedPointCount = classifications.filter((c) => c.state === "accepted").length;
  const provisionalPointCount = classifications.filter((c) => c.state === "needs_urans").length;
  const rejectedPointCount = classifications.filter((c) => c.state === "rejected" || c.state === "superseded_by_urans").length;

  if (fitInputs.length < 3) {
    return {
      status: "insufficient",
      confidence: 0,
      metrics: null,
      points: [],
      acceptedPointCount,
      provisionalPointCount,
      rejectedPointCount,
    };
  }

  const step = Math.min(0.5, nominalStep(fitInputs.map((p) => ({ ...p, status: "done", source: "solved", converged: true, stalled: false }))));
  const minA = fitInputs[0].a;
  const maxA = fitInputs[fitInputs.length - 1].a;
  const span = Math.max(step * 6, 2.5);
  const evaluate = (a: number, key: "cl" | "cd" | "cm"): number => {
    const value = localQuadratic(fitInputs, a, key, span);
    return key === "cd" ? Math.max(1e-6, value) : value;
  };
  const samples: PolarFitPoint[] = [];
  for (let a = minA; a <= maxA + step * 0.5; a += step) {
    const cl = evaluate(a, "cl");
    const cd = evaluate(a, "cd");
    const cm = evaluate(a, "cm");
    samples.push({ a: Number(a.toFixed(4)), cl, cd, cm, ld: cl / cd });
  }
  const status: PolarFitStatus = provisionalPointCount > 0 ? "provisional" : "final";
  const confidenceBase = Math.min(0.98, 0.45 + fitInputs.length * 0.035);
  return {
    status,
    confidence: status === "provisional" ? Math.min(confidenceBase, 0.74) : confidenceBase,
    metrics: fitMetrics(samples, { evaluate, stepDeg: step, minA, maxA }),
    points: samples,
    acceptedPointCount,
    provisionalPointCount,
    rejectedPointCount,
  };
}
