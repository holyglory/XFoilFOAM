// Number formatting helpers — ported verbatim from airfoil-db.js / Airfoil Detail.dc.html
// so the UI renders identical strings to the design prototype.

/** Format a Reynolds number compactly: 300000 -> "300k", 1_000_000 -> "1M". */
export function fRe(re: number): string {
  return re >= 1e6
    ? (re / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M"
    : Math.round(re / 1000) + "k";
}

export const f1 = (x: number): string => x.toFixed(1);
export const f2 = (x: number): string => x.toFixed(2);
export const f4 = (x: number): string => x.toFixed(4);
