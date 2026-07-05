// Symmetric-airfoil detection and polar mirroring (spec §9.1–§9.2).
// Symmetry is a real geometric property computed from stored coordinates —
// never inferred from names. Mirrored polar data is derived at read/assembly
// time; results rows stay real solves only.

import { interpY, splitSurfaces } from "./geometry";
import type { PolarEvidenceClassification } from "./polar-fit";
import type { Point } from "./types";

/** Max |y_up(x) + y_low(x)| allowed for a symmetric airfoil, chord = 1 (spec §9.1). */
export const SYMMETRY_TOLERANCE_CHORD = 1e-4;

const SYMMETRY_STATIONS = 100;

/** Chord-align a Selig-order contour: LE → origin, chord onto +x, chord length 1.
 *  TE is the midpoint of the Selig endpoints so open trailing edges close. */
function normalizeChord(contour: Point[]): Point[] {
  const first = contour[0];
  const last = contour[contour.length - 1];
  const te = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
  let le = first;
  let best = -Infinity;
  for (const p of contour) {
    const d = (p.x - te.x) ** 2 + (p.y - te.y) ** 2;
    if (d > best) {
      best = d;
      le = p;
    }
  }
  const chord = Math.sqrt(best);
  if (!(chord > 0)) return contour.map((p) => ({ ...p }));
  const cos = (te.x - le.x) / chord;
  const sin = (te.y - le.y) / chord;
  return contour.map((p) => {
    const dx = p.x - le.x;
    const dy = p.y - le.y;
    return { x: (dx * cos + dy * sin) / chord, y: (dy * cos - dx * sin) / chord };
  });
}

/** True iff the airfoil is geometrically symmetric: after chord-aligned
 *  normalization, both surfaces resampled at common cosine-spaced x stations
 *  satisfy max |y_up(x) + y_low(x)| ≤ 1e-4 of chord (spec §9.1). */
export function isAirfoilSymmetric(points: Point[]): boolean {
  if (points.length < 5) return false;
  const contour = normalizeChord(points);
  const { upper, lower } = splitSurfaces(contour);
  if (upper.length < 2 || lower.length < 2) return false;
  const us = [...upper].sort((a, b) => a.x - b.x);
  const ls = [...lower].sort((a, b) => a.x - b.x);
  for (let i = 0; i <= SYMMETRY_STATIONS; i++) {
    const beta = (Math.PI * i) / SYMMETRY_STATIONS;
    const x = (1 - Math.cos(beta)) / 2;
    if (Math.abs(interpY(us, x) + interpY(ls, x)) > SYMMETRY_TOLERANCE_CHORD) return false;
  }
  return true;
}

/** Odd-function negation that preserves null/undefined and never emits -0. */
function mirrorValue<V extends number | null | undefined>(v: V): V {
  return (v == null || v === 0 ? v : -v) as V;
}

/** Mirror one polar point across α = 0 (spec §9.2): Cl(−α) = −Cl(α),
 *  Cd(−α) = Cd(α), Cm(−α) = −Cm(α). Every other field is preserved. */
export function mirrorPolarPoint<T extends { aoaDeg: number; cl: number | null; cd: number | null; cm: number | null }>(
  p: T,
): T {
  return {
    ...p,
    aoaDeg: mirrorValue(p.aoaDeg),
    cl: mirrorValue(p.cl),
    cm: mirrorValue(p.cm),
  };
}

export interface MirroredEvidenceClassification extends PolarEvidenceClassification {
  /** The positive source angle this mirrored copy was derived from. */
  derivedFromAoaDeg: number;
}

/** Mirror classified +α evidence of a symmetric airfoil onto the negative side
 *  for fit-input assembly (spec §9.2). Only accepted/needs_urans evidence is
 *  derivable; the mirrored copy carries the same classification state plus
 *  derivedFromAoaDeg provenance. Sorted ascending by mirrored α. */
export function mirrorClassifiedEvidence(points: PolarEvidenceClassification[]): MirroredEvidenceClassification[] {
  const out: MirroredEvidenceClassification[] = [];
  for (const c of points) {
    if (c.evidence.a <= 0) continue;
    if (c.state !== "accepted" && c.state !== "needs_urans") continue;
    out.push({
      ...c,
      evidence: {
        ...c.evidence,
        a: -c.evidence.a,
        cl: mirrorValue(c.evidence.cl),
        cm: mirrorValue(c.evidence.cm),
        ld: mirrorValue(c.evidence.ld),
      },
      reasons: [...c.reasons],
      derivedFromAoaDeg: c.evidence.a,
    });
  }
  return out.sort((a, b) => a.evidence.a - b.evidence.a);
}
