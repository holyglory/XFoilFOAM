/** Reference Reynolds numbers used by the seeded OpenFOAM boundary conditions. */
export const RELIST = [100000, 200000, 500000, 1000000] as const;

/** Safe default ceiling for adaptive relaxed-PIMPLE URANS stepping.
 *
 * Cross-runtime pin: Python ``SolverParams.transient_max_courant`` uses the
 * same value.  Explicit expert profiles may override it; every Node-side
 * creation surface must import this constant instead of reviving the unsafe
 * historical default of 15.
 */
export const DEFAULT_TRANSIENT_MAX_COURANT = 4;

/** Per-Re curve colors for solved OpenFOAM polar charts. */
export const RE_COLORS: Record<number, string> = {
  100000: "#f5a524",
  200000: "#a78bfa",
  500000: "#f56565",
  1000000: "#38bdf8",
};

const FALLBACK_RE_COLORS = [
  "#34d399",
  "#fb7185",
  "#60a5fa",
  "#fbbf24",
  "#22d3ee",
  "#c084fc",
  "#f97316",
] as const;

export function colorForRe(re: number): string {
  const rounded = Math.round(re);
  if (RE_COLORS[rounded]) return RE_COLORS[rounded];
  const hash = Math.abs(Math.trunc(rounded / 1000));
  return FALLBACK_RE_COLORS[hash % FALLBACK_RE_COLORS.length];
}
