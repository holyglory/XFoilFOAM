// URANS FIDELITY LADDER CONTRACT (pinned 2026-07-07, same cross-runtime
// pattern as frame-track.ts / WORKER_RESTART_ORPHAN_MESSAGE).
//
// Contract 1 — request field solver.urans_fidelity: "precalc" | "full".
//   The ENGINE derives everything from the literal (src/airfoilfoam/models.py):
//     precalc → urans_min_periods 3, solver budget 14400 s (4 h), mesh scale
//               0.5 + wall-function y+ 40 (derived half-resolution URANS mesh:
//               halve n_surface/n_radial/n_wake, clear explicit low-Re
//               first-cell overrides — engine-side derivation, cached
//               separately in the mesh cache);
//     full    → urans_min_periods 7, solver budget 43200 s (12 h), full mesh
//               (background trickle tier).
//   Budgets retuned 2026-07-07 to measured prod rates (ladder-gate campaign,
//   naca-0012 alpha=15, 25 m/s, 0.1 m chord): ~14 min/period on the half-res
//   precalc mesh, ~8x on the full mesh ≈ 2 h/period (7 periods → 43200 s
//   under the 80% wall-guard fraction). Precalc raised again 2026-07-09
//   (3600 → 7200 → 14400 s): prod runs showed 9/9 precalc points
//   budget-stopped at 7200 s — the NACA 4412 class projected up to ~3.1 h of
//   continuation beyond the stop point; 14400 s absorbs that class.
//   The node NEVER sends the derived numbers — only the literal. The constants
//   below exist so node tests pin the SAME values the engine derives; drift is
//   a test failure on both sides:
//   - node:   apps/sweeper/test/fidelity-contract-pin.test.ts
//   - python: engine fidelity contract test against the same literals/values.
//
// Contract 1 echo — PolarPoint.fidelity: "rans" | "urans_precalc" |
//   "urans_full" (persisted to results.fidelity, migration 0034).
//
// Contract 2 — PolarPoint.steady_history (nullable): shipped whenever the
//   steady solve used oscillating-averaging; null for classic pointwise
//   convergence. Downsampled to <=2000 samples engine-side.

export type UransFidelity = "precalc" | "full";
export type PointFidelity = "rans" | "urans_precalc" | "urans_full";

export const URANS_FIDELITY_VALUES: readonly UransFidelity[] = ["precalc", "full"];
export const POINT_FIDELITY_VALUES: readonly PointFidelity[] = ["rans", "urans_precalc", "urans_full"];

/** Engine-derived per-fidelity parameters (contract 1) — pinned for parity
 *  tests only; the request carries ONLY the fidelity literal. */
export const URANS_PRECALC_MIN_PERIODS = 3;
export const URANS_FULL_MIN_PERIODS = 7;
export const URANS_PRECALC_SOLVER_BUDGET_S = 14400;
export const URANS_FULL_SOLVER_BUDGET_S = 43200;
export const URANS_PRECALC_MESH_SCALE = 0.5;

/** Backward-compatible transport-package exports. The authoritative domain
 * values live in @aerodb/core so DB projection and UI presentation cannot
 * drift from engine-facing consumers. */
export {
  URANS_VERIFY_DELTA_CD_LIMIT,
  URANS_VERIFY_DELTA_CL_LIMIT,
} from "@aerodb/core";

/** Strict literal parse of the PolarPoint.fidelity echo. Returns null on any
 *  unknown/absent value — callers decide the honest fallback and log drift. */
export function parsePointFidelity(value: unknown): PointFidelity | null {
  return (POINT_FIDELITY_VALUES as readonly string[]).includes(value as string) ? (value as PointFidelity) : null;
}

// ---------------------------------------------------------------------------
// steady_history (contract 2) — strict structural parser, exact-shape only,
// mirroring parseFrameTrack: any missing/extra/retyped key is an error so a
// drifted engine payload fails tests on the node side too.
// ---------------------------------------------------------------------------

/** Hard payload bound pinned by the contract: iterations.length <= 2000. */
export const STEADY_HISTORY_MAX_SAMPLES = 2000;

export interface SteadyHistoryWindow {
  start_iter: number;
  end_iter: number;
}

export interface SteadyHistory {
  iterations: number[];
  cl: number[];
  cd: number[];
  cm: number[];
  window: SteadyHistoryWindow;
  mean_stable: boolean;
  note: string;
}

export type SteadyHistoryParseResult = { ok: true; value: SteadyHistory } | { ok: false; errors: string[] };

const TOP_KEYS = ["iterations", "cl", "cd", "cm", "window", "mean_stable", "note"] as const;
const WINDOW_KEYS = ["start_iter", "end_iter"] as const;
const SERIES_KEYS = ["iterations", "cl", "cd", "cm"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function checkExactKeys(obj: Record<string, unknown>, allowed: readonly string[], at: string, errors: string[]): void {
  for (const key of allowed) {
    if (!(key in obj)) errors.push(`${at}: missing key "${key}"`);
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${at}: unexpected key "${key}" (contract drift)`);
  }
}

/** Strict validator for the pinned steady_history shape. `null` is a valid
 *  value only at the PolarPoint level (classic pointwise convergence) — pass
 *  that case through before calling this. */
export function parseSteadyHistory(value: unknown): SteadyHistoryParseResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: [`steady_history: expected object, got ${value === null ? "null" : typeof value}`] };
  }
  checkExactKeys(value, TOP_KEYS, "steady_history", errors);

  let seriesLength: number | null = null;
  for (const key of SERIES_KEYS) {
    if (!(key in value)) continue;
    const series = value[key];
    if (!Array.isArray(series) || series.some((x) => !finiteNumber(x))) {
      errors.push(`steady_history.${key}: expected array of finite numbers`);
      continue;
    }
    if (key === "iterations" && series.some((x) => !Number.isInteger(x))) {
      errors.push("steady_history.iterations: expected integers");
    }
    if (series.length > STEADY_HISTORY_MAX_SAMPLES) {
      errors.push(`steady_history.${key}: ${series.length} samples exceeds contract cap of ${STEADY_HISTORY_MAX_SAMPLES}`);
    }
    if (seriesLength === null) {
      seriesLength = series.length;
    } else if (series.length !== seriesLength) {
      errors.push(`steady_history.${key}: length ${series.length} != iterations length ${seriesLength}`);
    }
  }

  if ("window" in value) {
    if (!isRecord(value.window)) {
      errors.push("steady_history.window: expected object");
    } else {
      checkExactKeys(value.window, WINDOW_KEYS, "steady_history.window", errors);
      for (const key of WINDOW_KEYS) {
        if (key in value.window && !(finiteNumber(value.window[key]) && Number.isInteger(value.window[key]))) {
          errors.push(`steady_history.window.${key}: expected integer`);
        }
      }
    }
  }

  if ("mean_stable" in value && typeof value.mean_stable !== "boolean") {
    errors.push("steady_history.mean_stable: expected boolean");
  }
  if ("note" in value && typeof value.note !== "string") {
    errors.push("steady_history.note: expected string");
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as SteadyHistory };
}
