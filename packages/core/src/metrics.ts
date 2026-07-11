import type { PolarMetrics, PolarPointData } from "./types";

/**
 * Derive the generalized-polar metrics from a polar — ported verbatim from
 * airfoil-db.js `metrics`. Powers the Detail-page interp-vs-solved table.
 */
export function metrics(arr: PolarPointData[]): PolarMetrics {
  let ldmax = -1e9;
  let aLd = 0;
  let cdmin = 1e9;
  let clCd = 0;
  let clmax = -1e9;
  let aStall = 0;
  arr.forEach((p) => {
    if (!p.stalled && p.cl > 0) {
      const ld = p.cl / p.cd;
      if (ld > ldmax) {
        ldmax = ld;
        aLd = p.a;
      }
    }
    if (p.cd < cdmin) {
      cdmin = p.cd;
      clCd = p.cl;
    }
    if (p.cl > clmax) {
      clmax = p.cl;
      aStall = p.a;
    }
  });
  let cd0 = cdmin;
  for (let i = 0; i < arr.length - 1; i++) {
    if (arr[i].cl <= 0 && arr[i + 1].cl >= 0) {
      const f = (0 - arr[i].cl) / (arr[i + 1].cl - arr[i].cl);
      cd0 = arr[i].cd + (arr[i + 1].cd - arr[i].cd) * f;
      break;
    }
  }
  const cmp = arr.find((p) => p.a === -4 && p.cm != null);
  const cm0 = cmp?.cm ?? null;
  return { ldmax, aLd, cdmin, clCd, cd0, clmax, aStall, cm0 };
}
