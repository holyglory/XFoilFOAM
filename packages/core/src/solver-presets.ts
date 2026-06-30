/** Reference Reynolds numbers used by the seeded OpenFOAM boundary conditions. */
export const RELIST = [100000, 200000, 500000, 1000000] as const;

/** Per-Re curve colors for solved OpenFOAM polar charts. */
export const RE_COLORS: Record<number, string> = {
  100000: "#f5a524",
  200000: "#a78bfa",
  500000: "#f56565",
  1000000: "#38bdf8",
};

const FALLBACK_RE_COLORS = ["#34d399", "#fb7185", "#60a5fa", "#fbbf24", "#22d3ee", "#c084fc", "#f97316"] as const;

export function colorForRe(re: number): string {
  const rounded = Math.round(re);
  if (RE_COLORS[rounded]) return RE_COLORS[rounded];
  const hash = Math.abs(Math.trunc(rounded / 1000));
  return FALLBACK_RE_COLORS[hash % FALLBACK_RE_COLORS.length];
}
