import type { AirfoilGeometry, NacaParams, Point } from "./types";

// ---------------------------------------------------------------------------
// NACA 4-digit generator — ported verbatim from airfoil-db.js `buildAirfoil`
// for explicit NACA definitions supplied by seeds or users.
// Contour order: upper TE→LE, then lower LE→TE (Selig), sharp TE.
// ---------------------------------------------------------------------------
export interface RawNaca {
  contour: Point[];
  camber: Point[];
  areas: {
    profile: number;
    upper: number;
    lower: number;
    camber: number;
    upperPositive: number;
    upperNegative: number;
    lowerPositive: number;
    lowerNegative: number;
    camberPositive: number;
    camberNegative: number;
  };
  leRadius: number;
}

interface SignedAreaParts {
  signed: number;
  positive: number;
  negative: number;
}

function trapParts(dx: number, y0: number, y1: number): SignedAreaParts {
  const signed = (dx * (y0 + y1)) / 2;
  if (y0 >= 0 && y1 >= 0) return { signed, positive: signed, negative: 0 };
  if (y0 <= 0 && y1 <= 0) return { signed, positive: 0, negative: signed };
  const f = -y0 / (y1 - y0);
  const first = (dx * f * y0) / 2;
  const second = (dx * (1 - f) * y1) / 2;
  return {
    signed,
    positive: Math.max(0, first) + Math.max(0, second),
    negative: Math.min(0, first) + Math.min(0, second),
  };
}

export function buildNaca4(params: NacaParams, n = 90): RawNaca {
  const { t, m, p } = params;
  const up: [number, number][] = [];
  const lo: [number, number][] = [];
  const cam: [number, number][] = [];
  let areaU = 0;
  let areaL = 0;
  let areaC = 0;
  let areaProfile = 0;
  let upperPositive = 0;
  let upperNegative = 0;
  let lowerPositive = 0;
  let lowerNegative = 0;
  let camberPositive = 0;
  let camberNegative = 0;
  let lastx = 0;
  let lastyu = 0;
  let lastyl = 0;
  let lastyc = 0;
  for (let i = 0; i <= n; i++) {
    const beta = (Math.PI * i) / n;
    const x = (1 - Math.cos(beta)) / 2;
    const yt =
      5 *
      t *
      (0.2969 * Math.sqrt(x) -
        0.126 * x -
        0.3516 * x * x +
        0.2843 * x * x * x -
        0.1015 * x * x * x * x);
    let yc = 0;
    let dyc = 0;
    if (p > 0 && m > 0) {
      if (x < p) {
        yc = (m / (p * p)) * (2 * p * x - x * x);
        dyc = ((2 * m) / (p * p)) * (p - x);
      } else {
        yc = (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x - x * x);
        dyc = ((2 * m) / ((1 - p) * (1 - p))) * (p - x);
      }
    }
    const th = Math.atan(dyc);
    up.push([x - yt * Math.sin(th), yc + yt * Math.cos(th)]);
    lo.push([x + yt * Math.sin(th), yc - yt * Math.cos(th)]);
    cam.push([x, yc]);
    if (i > 0) {
      const dx = x - lastx;
      const u = trapParts(dx, lastyu, up[i][1]);
      const l = trapParts(dx, lastyl, lo[i][1]);
      const c = trapParts(dx, lastyc, yc);
      areaU += u.signed;
      areaL += l.signed;
      areaC += c.signed;
      upperPositive += u.positive;
      upperNegative += u.negative;
      lowerPositive += l.positive;
      lowerNegative += l.negative;
      camberPositive += c.positive;
      camberNegative += c.negative;
      areaProfile += (dx * (up[i][1] - lo[i][1] + lastyu - lastyl)) / 2;
    }
    lastx = x;
    lastyu = up[i][1];
    lastyl = lo[i][1];
    lastyc = yc;
  }
  const contour: Point[] = [];
  for (let i = up.length - 1; i >= 0; i--) contour.push({ x: up[i][0], y: up[i][1] });
  for (let i = 0; i < lo.length; i++) contour.push({ x: lo[i][0], y: lo[i][1] });
  const camber: Point[] = cam.map((c) => ({ x: c[0], y: c[1] }));
  return {
    contour,
    camber,
    areas: {
      profile: areaProfile,
      upper: areaU,
      lower: areaL,
      camber: areaC,
      upperPositive,
      upperNegative,
      lowerPositive,
      lowerNegative,
      camberPositive,
      camberNegative,
    },
    leRadius: 1.1019 * t * t,
  };
}

/** Full geometry metrics for a NACA 4-digit airfoil (exact, analytic positions). */
export function nacaGeometry(params: NacaParams, n = 90): AirfoilGeometry {
  const raw = buildNaca4(params, n);
  return {
    contour: raw.contour,
    camber: raw.camber,
    thicknessPct: params.t * 100,
    thicknessXPct: 30, // NACA 4-digit max thickness at ~0.30c
    camberPct: params.m * 100,
    camberXPct: params.p * 100,
    leRadiusPct: raw.leRadius * 100,
    teThicknessPct: 0,
    areaProfile: raw.areas.profile,
    areaUpper: raw.areas.upper,
    areaLower: raw.areas.lower,
    areaCamber: raw.areas.camber,
    areaUpperPositive: raw.areas.upperPositive,
    areaUpperNegative: raw.areas.upperNegative,
    areaLowerPositive: raw.areas.lowerPositive,
    areaLowerNegative: raw.areas.lowerNegative,
    areaCamberPositive: raw.areas.camberPositive,
    areaCamberNegative: raw.areas.camberNegative,
  };
}

// ---------------------------------------------------------------------------
// SVG path helper — ported from airfoil-db.js `makePath`.
// ---------------------------------------------------------------------------
export function makePath(
  pts: Point[],
  mx: number,
  cy: number,
  scale: number,
  close: boolean,
): string {
  let d = "";
  pts.forEach((pt, i) => {
    d += (i === 0 ? "M" : "L") + (mx + pt.x * scale).toFixed(1) + " " + (cy - pt.y * scale).toFixed(1) + " ";
  });
  return d + (close ? "Z" : "");
}

/** Profile + camber SVG paths in the Detail-page profile viewBox (340×150, baseline y=80, scale 312). */
export function profilePaths(geo: { contour: Point[]; camber: Point[] }): {
  profilePath: string;
  camberPath: string;
} {
  const MX = 14;
  const S = 312;
  const CY = 80;
  return {
    profilePath: makePath(geo.contour, MX, CY, S, true),
    camberPath: makePath(geo.camber, MX, CY, S, false),
  };
}

// ---------------------------------------------------------------------------
// Point-data geometry derivation (for non-NACA airfoils loaded from coords).
// ---------------------------------------------------------------------------
export function splitSurfaces(contour: Point[]): { upper: Point[]; lower: Point[] } {
  let leIdx = 0;
  for (let i = 1; i < contour.length; i++) {
    if (contour[i].x < contour[leIdx].x) leIdx = i;
  }
  // Selig order: TE → upper → LE(@leIdx) → lower → TE.
  const upper = contour.slice(0, leIdx + 1).reverse(); // LE→TE
  const lower = contour.slice(leIdx); // LE→TE
  return { upper, lower };
}

function interpY(surf: Point[], x: number): number {
  if (surf.length === 0) return 0;
  if (x <= surf[0].x) return surf[0].y;
  const last = surf[surf.length - 1];
  if (x >= last.x) return last.y;
  for (let i = 0; i < surf.length - 1; i++) {
    const a = surf[i];
    const b = surf[i + 1];
    if (x >= a.x && x <= b.x) {
      const dx = b.x - a.x;
      const f = dx === 0 ? 0 : (x - a.x) / dx;
      return a.y + (b.y - a.y) * f;
    }
  }
  return last.y;
}

/** Derive geometry metrics from an arbitrary contour (point-data airfoils). */
export function deriveGeometry(contour: Point[], n = 160): AirfoilGeometry {
  const { upper, lower } = splitSurfaces(contour);
  const us = [...upper].sort((a, b) => a.x - b.x);
  const ls = [...lower].sort((a, b) => a.x - b.x);
  const camber: Point[] = [];
  let tMax = 0;
  let tx = 0;
  let cMax = 0;
  let cx = 0;
  let areaU = 0;
  let areaL = 0;
  let areaC = 0;
  let areaProfile = 0;
  let upperPositive = 0;
  let upperNegative = 0;
  let lowerPositive = 0;
  let lowerNegative = 0;
  let camberPositive = 0;
  let camberNegative = 0;
  let lastx = 0;
  let lastyu = 0;
  let lastyl = 0;
  let lastyc = 0;
  for (let i = 0; i <= n; i++) {
    const beta = (Math.PI * i) / n;
    const x = (1 - Math.cos(beta)) / 2;
    const yu = interpY(us, x);
    const yl = interpY(ls, x);
    const th = yu - yl;
    const cm = (yu + yl) / 2;
    camber.push({ x, y: cm });
    if (th > tMax) {
      tMax = th;
      tx = x;
    }
    if (Math.abs(cm) > Math.abs(cMax)) {
      cMax = cm;
      cx = x;
    }
    if (i > 0) {
      const dx = x - lastx;
      const u = trapParts(dx, lastyu, yu);
      const l = trapParts(dx, lastyl, yl);
      const c = trapParts(dx, lastyc, cm);
      areaU += u.signed;
      areaL += l.signed;
      areaC += c.signed;
      upperPositive += u.positive;
      upperNegative += u.negative;
      lowerPositive += l.positive;
      lowerNegative += l.negative;
      camberPositive += c.positive;
      camberNegative += c.negative;
      areaProfile += (dx * (yu - yl + lastyu - lastyl)) / 2;
    }
    lastx = x;
    lastyu = yu;
    lastyl = yl;
    lastyc = cm;
  }
  const teThickness = interpY(us, 1) - interpY(ls, 1);
  return {
    contour,
    camber,
    thicknessPct: tMax * 100,
    thicknessXPct: tx * 100,
    camberPct: cMax * 100,
    camberXPct: cx * 100,
    leRadiusPct: 1.1019 * tMax * tMax * 100,
    teThicknessPct: teThickness * 100,
    areaProfile,
    areaUpper: areaU,
    areaLower: areaL,
    areaCamber: areaC,
    areaUpperPositive: upperPositive,
    areaUpperNegative: upperNegative,
    areaLowerPositive: lowerPositive,
    areaLowerNegative: lowerNegative,
    areaCamberPositive: camberPositive,
    areaCamberNegative: camberNegative,
  };
}

// ---------------------------------------------------------------------------
// Coordinate parsing / export (Selig + Lednicer), for seeding non-NACA airfoils
// from .dat files and for the coordinate-download endpoint.
// ---------------------------------------------------------------------------
const NUM = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

export interface ParsedCoordinates {
  name: string;
  points: Point[]; // Selig order
  format: "selig" | "lednicer";
}

export function parseCoordinates(text: string): ParsedCoordinates {
  const lines = text.split(/\r?\n/);
  let name = "airfoil";
  let nameSet = false;
  const pairs: [number, number][] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A coordinate line is purely numeric. Any line with letters is a title or
    // comment (UIUC files have varied headers like "MH 60 10.08%", "SD7037-092-88").
    const hasLetters = /[A-Za-z]/.test(trimmed);
    const nums = trimmed.match(NUM);
    if (hasLetters || !nums || nums.length < 2) {
      if (hasLetters && !nameSet) {
        name = trimmed;
        nameSet = true;
      }
      continue;
    }
    pairs.push([parseFloat(nums[0]), parseFloat(nums[1])]);
  }
  if (pairs.length === 0) throw new Error("no coordinate pairs found");

  // Lednicer files start with a count header (e.g. "61.  61.") where both
  // values exceed 1 — coordinates are always within [~ -0.5, 1.5].
  const [h0, h1] = pairs[0];
  const isLednicer = h0 > 1.5 && h1 > 1.5;
  if (isLednicer) {
    const nUp = Math.round(h0);
    const nLo = Math.round(h1);
    const body = pairs.slice(1);
    const upper = body.slice(0, nUp).map(([x, y]) => ({ x, y })); // LE→TE
    const lower = body.slice(nUp, nUp + nLo).map(([x, y]) => ({ x, y })); // LE→TE
    const contour = [...upper].reverse().concat(lower); // TE→LE→TE
    return { name, points: contour, format: "lednicer" };
  }
  return { name, points: pairs.map(([x, y]) => ({ x, y })), format: "selig" };
}

function fmt(n: number): string {
  return (n >= 0 ? " " : "") + n.toFixed(6);
}

export function toSelig(name: string, points: Point[]): string {
  const header = name || "airfoil";
  const body = points.map((p) => `${fmt(p.x)}  ${fmt(p.y)}`).join("\n");
  return `${header}\n${body}\n`;
}

/** XFOIL consumes labeled Selig coordinates. */
export const toXfoil = toSelig;

export function toLednicer(name: string, points: Point[]): string {
  const { upper, lower } = splitSurfaces(points);
  const us = [...upper].sort((a, b) => a.x - b.x); // LE→TE
  const ls = [...lower].sort((a, b) => a.x - b.x); // LE→TE
  const header = name || "airfoil";
  const up = us.map((p) => `${fmt(p.x)}  ${fmt(p.y)}`).join("\n");
  const lo = ls.map((p) => `${fmt(p.x)}  ${fmt(p.y)}`).join("\n");
  return `${header}\n${us.length.toFixed(1)}  ${ls.length.toFixed(1)}\n\n${up}\n\n${lo}\n`;
}

export function toCsv(points: Point[]): string {
  return "x,y\n" + points.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).join("\n") + "\n";
}

export function exportCoordinates(
  format: "selig" | "lednicer" | "xfoil" | "csv",
  name: string,
  points: Point[],
): string {
  switch (format) {
    case "selig":
      return toSelig(name, points);
    case "lednicer":
      return toLednicer(name, points);
    case "xfoil":
      return toXfoil(name, points);
    case "csv":
      return toCsv(points);
  }
}
