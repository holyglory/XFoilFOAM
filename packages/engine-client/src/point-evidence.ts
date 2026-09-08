import { parseFrameTrack } from "./frame-track";
import {
  parsePointFidelity,
  parseSteadyHistory,
  type PointFidelity,
  type UransFidelity,
} from "./fidelity";
import type { PolarPoint } from "./types";

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function stalledForPoint(point: PolarPoint): boolean {
  return point.unsteady || point.converged === false;
}

export function validForPolarPoint(point: PolarPoint): boolean {
  const hasCoefficients =
    finiteNumber(point.cl) && finiteNumber(point.cd) && point.cd > 0;
  if (point.unsteady) return !point.error && hasCoefficients;
  return (
    point.converged === true &&
    !stalledForPoint(point) &&
    !point.error &&
    hasCoefficients
  );
}

/** A point with an error or without finite coefficients is failure/absence —
 *  exported so reconcile's worker-restart orphan path can keep ONLY solved
 *  points as evidence and release everything else for a re-solve. */
export function failedForPoint(point: PolarPoint): boolean {
  return (
    Boolean(point.error) || !finiteNumber(point.cl) || !finiteNumber(point.cd)
  );
}

/** frame_track value to persist on the results row: the engine payload
 *  VERBATIM (null-safe). Contract drift is validated loudly here but the raw
 *  value is still persisted — it is solver evidence, and the classifier's
 *  stationarity gate fails closed on drifted shapes (a malformed frame_track
 *  can only ever REJECT a point, never sneak one through). Exported for the
 *  contract pin test. */
export function frameTrackForPoint(
  point: PolarPoint,
  context: string,
): unknown {
  const raw = point.frame_track ?? null;
  if (raw === null) {
    if (point.unsteady) {
      // Post-contract engines ship frame_track on EVERY shedding URANS point.
      // A shedding point arriving WITHOUT it (period unmeasurable / stats
      // computation failed engine-side) has zero stationarity evidence, so it
      // must NOT persist as null — null means legacy pre-contract evidence
      // and skips the classifier's stationarity gate entirely. Persist a
      // fail-closed sentinel: the gate reads stationary / periods_retained
      // and rejects honestly (non-stationary + insufficient-periods).
      console.error(
        `[sweeper] frame_track MISSING on shedding URANS point (${context}); persisting fail-closed sentinel`,
      );
      return {
        missing: true,
        stationary: false,
        periods_retained: null,
        reason: "engine shipped no frame_track for a shedding URANS point",
      };
    }
    return null;
  }
  const parsed = parseFrameTrack(raw);
  if (!parsed.ok) {
    // Loud, never silent: a drifted engine payload means the pinned
    // frame-track contract broke on one side. Tests pin both sides; this log
    // is the production tripwire.
    console.error(
      `[sweeper] frame_track CONTRACT DRIFT (${context}): ${parsed.errors.join("; ")}`,
    );
  }
  return raw;
}

/** Fidelity tier to persist on the results row (ladder contract 1/3).
 *  Precedence: the engine's strict-parsed echo; else the tier the JOB
 *  requested (including physically no-shedding URANS points — with a loud
 *  drift log, because a post-ladder engine must echo); else the honest
 *  regime-derived tier matching the 0034 backfill semantics (pre-ladder
 *  engines: urans = full behavior, steady = rans). Exported for the pin test. */
export function fidelityForPoint(
  point: PolarPoint,
  requestedUransFidelity: UransFidelity | undefined,
  context: string,
): PointFidelity {
  const echoed = parsePointFidelity(point.fidelity);
  if (echoed) return echoed;
  if (requestedUransFidelity) {
    console.error(
      `[sweeper] fidelity echo MISSING on a '${requestedUransFidelity}'-fidelity job (${context}); persisting the requested tier — engine contract drift`,
    );
    return requestedUransFidelity === "precalc"
      ? "urans_precalc"
      : "urans_full";
  }
  return point.unsteady ? "urans_full" : "rans";
}

/**
 * Solver regime describes the numerical method that produced an attempt; it
 * is not synonymous with whether the final physical wake sheds. A successful
 * URANS no-shedding observation is deliberately `unsteady=false`, but it must
 * remain attributable to URANS for provenance, comparison and the immutable
 * attempt identity. Conversely an unsteady payload claiming RANS fidelity is
 * a producer-contract contradiction and must never be silently reclassified.
 */
export function solverRegimeForPoint(
  point: PolarPoint,
  fidelity: PointFidelity,
  context: string,
): "rans" | "urans" {
  const urans = fidelity === "urans_precalc" || fidelity === "urans_full";
  if (point.unsteady && !urans) {
    throw new Error(
      `solver regime contract drift (${context}): shedding point carries non-URANS fidelity '${fidelity}'`,
    );
  }
  return urans ? "urans" : "rans";
}

/** steady_history value to persist verbatim (ladder contract 2). Like
 *  frame_track: drift is validated loudly but the raw payload is still
 *  persisted (solver evidence) — the classifier reads mean_stable fail-closed,
 *  so a malformed payload can never WAIVE a convergence gate. Exported for the
 *  pin test. */
export function steadyHistoryForPoint(
  point: PolarPoint,
  context: string,
): unknown {
  const raw = point.steady_history ?? null;
  if (raw === null) return null;
  const parsed = parseSteadyHistory(raw);
  if (!parsed.ok) {
    console.error(
      `[sweeper] steady_history CONTRACT DRIFT (${context}): ${parsed.errors.join("; ")}`,
    );
  }
  return raw;
}

/** Oscillating-steady quality marker (ladder contract 2): a steady point
 *  accepted through mean-stable oscillating averaging carries the honest
 *  note in quality_warnings — the marker every point-story surface already
 *  reads. Never duplicates an engine-shipped warning. Exported for tests. */
export const STEADY_OSCILLATING_MARKER = "steady-oscillating-mean";

export function hasStableSteadyMean(point: PolarPoint): boolean {
  return Boolean(
    !point.unsteady &&
    point.steady_history &&
    typeof point.steady_history === "object" &&
    (point.steady_history as { mean_stable?: unknown }).mean_stable === true,
  );
}

export function qualityWarningsForPoint(point: PolarPoint): string[] | null {
  const warnings = [...(point.quality_warnings ?? [])];
  const history = point.steady_history;
  if (hasStableSteadyMean(point) && history && typeof history === "object") {
    const note =
      typeof (history as { note?: unknown }).note === "string" &&
      (history as { note: string }).note.trim()
        ? (history as { note: string }).note
        : "steady solve settled into a bounded oscillation; coefficients are stable window means";
    const marker = `${STEADY_OSCILLATING_MARKER}: ${note}`;
    if (!warnings.includes(marker)) warnings.push(marker);
  }
  return warnings.length ? warnings : null;
}

export function solverPointEvidencePayload(
  point: PolarPoint,
  values: {
    fidelity: PointFidelity;
    frameTrack?: unknown;
    steadyHistory?: unknown;
    meshRecoveryVersion?: number | null;
  },
) {
  return {
    ...point,
    error: point.error ?? null,
    fidelity: values.fidelity,
    frame_track: values.frameTrack ?? point.frame_track ?? null,
    steady_history: values.steadyHistory ?? point.steady_history ?? null,
    quality_warnings: qualityWarningsForPoint(point) ?? [],
    ...(values.meshRecoveryVersion == null
      ? {}
      : { mesh_recovery_version: values.meshRecoveryVersion }),
  };
}
