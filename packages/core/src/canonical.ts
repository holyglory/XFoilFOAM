// Campaign canonicalization (spec §4) — the ONE module every producer uses for
// angle/SI value rounding, canonical decimal strings, and angle-grid expansion.
// All rounding is round-half-even applied to the shortest round-trip decimal
// representation of the double, so ties like 0.00025 → 0.0002 are deterministic
// and independent of binary float dust. Grids are expanded with integer-step
// decimal arithmetic (never repeated float addition) so a 0.5° grid is
// byte-identical to the matching subset of a 0.1° grid.

export type CanonicalSiKind =
  | "temperatureK"
  | "pressurePa"
  | "speedMps"
  | "chordM"
  | "spanM"
  | "areaM2";

const SI_DECIMALS: Record<CanonicalSiKind, number> = {
  temperatureK: 2, // 0.01 K
  pressurePa: 0, // 1 Pa
  speedMps: 3, // 0.001 m/s
  chordM: 4, // 0.0001 m
  spanM: 4, // 0.0001 m
  areaM2: 6, // 1e-6 m²
};

const AOA_DECIMALS = 4; // 1e-4 deg
const AOA_SCALE = 10 ** AOA_DECIMALS;

interface DecimalDigits {
  neg: boolean;
  int: string; // integer digits, no sign, no leading zeros (except "0")
  frac: string; // fraction digits, may be ""
}

/** Shortest round-trip decimal digits of |x| with exponential notation expanded. */
function decimalDigits(x: number): DecimalDigits {
  const neg = x < 0;
  let s = Math.abs(x).toString();
  let exp = 0;
  const eIdx = s.indexOf("e");
  if (eIdx >= 0) {
    exp = Number(s.slice(eIdx + 1));
    s = s.slice(0, eIdx);
  }
  const dot = s.indexOf(".");
  let int = dot >= 0 ? s.slice(0, dot) : s;
  let frac = dot >= 0 ? s.slice(dot + 1) : "";
  if (exp > 0) {
    if (frac.length <= exp) {
      int += frac.padEnd(exp, "0");
      frac = "";
    } else {
      int += frac.slice(0, exp);
      frac = frac.slice(exp);
    }
  } else if (exp < 0) {
    const shift = -exp;
    if (int.length <= shift) {
      frac = int.padStart(shift, "0") + frac;
      int = "0";
    } else {
      frac = int.slice(int.length - shift) + frac;
      int = int.slice(0, int.length - shift);
    }
  }
  int = int.replace(/^0+(?=\d)/, "");
  return { neg, int, frac };
}

function incrementDigits(digits: string): string {
  const out = digits.split("");
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] === "9") {
      out[i] = "0";
    } else {
      out[i] = String(out[i].charCodeAt(0) - 48 + 1);
      return out.join("");
    }
  }
  return "1" + out.join("");
}

/** Fixed-precision decimal string of x, rounded half-even at `decimals` places. */
function roundHalfEvenFixed(x: number, decimals: number): string {
  if (!Number.isFinite(x)) throw new Error(`cannot canonicalize non-finite value: ${x}`);
  const { neg, int, frac } = decimalDigits(x);
  const kept = frac.slice(0, decimals).padEnd(decimals, "0");
  const rest = frac.slice(decimals);
  let digits = int + kept; // integer in units of 10^-decimals
  const restTrimmed = rest.replace(/0+$/, "");
  if (restTrimmed) {
    const first = rest.charCodeAt(0) - 48;
    if (first > 5 || (first === 5 && restTrimmed.length > 1)) {
      digits = incrementDigits(digits);
    } else if (first === 5) {
      // exact half — round to the even neighbour
      const last = digits.charCodeAt(digits.length - 1) - 48;
      if (last % 2 === 1) digits = incrementDigits(digits);
    }
  }
  const intOut = (decimals ? digits.slice(0, digits.length - decimals) : digits).replace(/^0+(?=\d)/, "") || "0";
  const fracOut = decimals ? digits.slice(digits.length - decimals) : "";
  const isZero = /^0*$/.test(intOut + fracOut); // never emit "-0.0000"
  return (neg && !isZero ? "-" : "") + intOut + (decimals ? "." + fracOut : "");
}

/** Canonical angle of attack: round-half-even to 1e-4 deg (spec §4). */
export function canonicalAoa(x: number): number {
  return Number(roundHalfEvenFixed(x, AOA_DECIMALS));
}

/** Canonical SI value at the campaign precision for `kind` (spec §4). */
export function canonicalSi(kind: CanonicalSiKind, x: number): number {
  return Number(roundHalfEvenFixed(x, SI_DECIMALS[kind]));
}

/** Canonical fixed-precision decimal string, as stored in plan jsonb (spec §4). */
export function canonicalSiString(kind: CanonicalSiKind, x: number): string {
  return roundHalfEvenFixed(x, SI_DECIMALS[kind]);
}

export interface AngleGridSpec {
  fromDeg?: number;
  toDeg?: number;
  stepDeg?: number;
  listDeg?: number[] | null;
}

/** Expand a base-sweep angle spec into canonical angles, sorted ascending and
 *  deduped. An explicit list overrides the range. Range expansion computes
 *  from + i·step as scaled integers at 1e-4 deg so overlapping grids share
 *  byte-identical values. */
export function expandAngleGrid(spec: AngleGridSpec): number[] {
  if (spec.listDeg != null) {
    return [...new Set(spec.listDeg.map(canonicalAoa))].sort((a, b) => a - b);
  }
  const { fromDeg, toDeg, stepDeg } = spec;
  if (!Number.isFinite(fromDeg) || !Number.isFinite(toDeg) || !Number.isFinite(stepDeg)) {
    throw new Error("angle grid requires fromDeg/toDeg/stepDeg when listDeg is absent");
  }
  if ((stepDeg as number) <= 0) throw new Error("angle grid stepDeg must be > 0");
  const from = Math.round(canonicalAoa(fromDeg as number) * AOA_SCALE);
  const to = Math.round(canonicalAoa(toDeg as number) * AOA_SCALE);
  const step = Math.round(canonicalAoa(stepDeg as number) * AOA_SCALE);
  if (step === 0) throw new Error("angle grid stepDeg rounds to zero at 1e-4 deg precision");
  const out: number[] = [];
  for (let v = from; v <= to; v += step) out.push(canonicalAoa(v / AOA_SCALE));
  return out;
}
