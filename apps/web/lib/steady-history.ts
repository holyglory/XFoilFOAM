// Pure assembly for the oscillating-steady iteration-history chart in the
// solver-results modal (fidelity ladder contract 2). No DOM, no React —
// node vitest covers it (test/fidelity-ladder.test.ts).
//
// The engine ships results.steady_history ONLY when a steady solve was
// accepted via oscillating-averaging (mean over the trailing window instead
// of pointwise convergence). The modal draws the real recorded samples and
// shades the averaging window; absent/drifted payloads yield a null model and
// the modal renders nothing new — history is never invented.

import type { SteadyHistoryDetail } from "@aerodb/core";

export interface SteadyHistoryModel {
  /** Iteration axis (ascending as recorded; drawn by sample index). */
  iterations: number[];
  cl: number[];
  cd: number[];
  cm: number[];
  /** Averaging window bounds in ITERATION numbers (engine contract keys). */
  windowStartIter: number;
  windowEndIter: number;
  /** Window bounds as 0..1 fractions of the sample range — chart shading. */
  windowStartFrac: number;
  windowEndFrac: number;
  /** Iterations spanned by the averaging window (the "averaged over last N
   *  iterations" note). */
  windowIterCount: number;
  /** Recorded samples that fall inside the window. */
  windowSampleCount: number;
  meanStable: boolean;
  /** Engine's honest note, rendered verbatim. */
  note: string;
}

/** null = nothing to chart (absent payload or fewer than 2 usable samples). */
export function buildSteadyHistoryModel(sh: SteadyHistoryDetail | null | undefined): SteadyHistoryModel | null {
  if (!sh) return null;
  const len = Math.min(sh.iterations.length, sh.cl.length, sh.cd.length, sh.cm.length);
  if (len < 2) return null;
  const iterations = sh.iterations.slice(0, len);
  const cl = sh.cl.slice(0, len);
  const cd = sh.cd.slice(0, len);
  const cm = sh.cm.slice(0, len);
  const startIter = sh.window.startIter;
  const endIter = sh.window.endIter;
  // First sample at/after the window start; last sample at/before its end.
  let startIdx = iterations.findIndex((it) => it >= startIter);
  if (startIdx < 0) startIdx = len - 1;
  let endIdx = len - 1;
  for (let i = len - 1; i >= 0; i--) {
    if (iterations[i] <= endIter) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < startIdx) endIdx = startIdx;
  return {
    iterations,
    cl,
    cd,
    cm,
    windowStartIter: startIter,
    windowEndIter: endIter,
    windowStartFrac: startIdx / (len - 1),
    windowEndFrac: endIdx / (len - 1),
    windowIterCount: Math.max(0, endIter - startIter),
    windowSampleCount: endIdx - startIdx + 1,
    meanStable: sh.meanStable,
    note: sh.note,
  };
}
