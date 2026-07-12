/** Budget-stop marker (pinned cross-runtime contract, 2026-07-08): the engine
 *  (src/airfoilfoam/pipeline.py, URANS_BUDGET_STOP_MARKER — the identical
 *  literal) embeds exactly this substring in the quality reason of EVERY
 *  wall-clock-stopped URANS grade that leaves restartable saved case state:
 *  the between-chunks budget projection guard, the mid-chunk solver-timeout
 *  partial grade, and a timed-out continuation chunk. Crash/divergence grades
 *  never carry it. A REJECTED urans row whose quality_warnings carry this
 *  marker AND whose engine case ids are present is CONTINUABLE — the saved
 *  case state can be resumed with an increased budget (amendment C). Matching
 *  is substring-based so surrounding measurements never break detection;
 *  drift in the phrasing is a test failure on both sides (engine:
 *  tests/test_continuation.py marker pin; node: the fixtures embedding it). */
export const URANS_BUDGET_STOP_MARKER =
  "stopped by the wall-clock budget guard";

/** Same-case continuation marker (pinned cross-runtime contract): unlike the
 * wall-budget marker above, this says only that the engine reached its bounded
 * in-run chunk cap while leaving restartable state. It is still continuable,
 * but must never be presented as a timeout or budget exhaustion. */
export const URANS_CONTINUATION_REQUIRED_MARKER =
  "requires further same-case integration";

/** Durable owner marker for the one-shot campaign precalc continuation. */
export const AUTO_PRECALC_CONTINUATION_REQUESTED_BY =
  "system:precalc-continuation-v1";
export const AUTO_PRECALC_CONTINUATION_BUDGET_S = 2 * 60 * 60;

/** Exact engine error markers for the immutable precalc mesh-QA class. A row
 * carrying both is a setup blocker: repeating the same revision cannot repair
 * it, so review/requeue surfaces must not present it as a coefficient verdict. */
export const DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER =
  "mesh degenerate at this fidelity tier";
export const DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER =
  "max non-orthogonality";

export function isDeterministicMeshBlockerError(
  error: string | null | undefined,
): boolean {
  const normalized = (error ?? "").toLowerCase();
  return (
    normalized.includes(DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER) &&
    normalized.includes(DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER)
  );
}

export const URANS_MIN_RETAINED_CYCLES = 7;
export const URANS_MIN_ANIMATION_FRAMES_PER_CYCLE = 20;
export const URANS_ANIMATION_FPS = 20;

export interface UransMediaQualityInput {
  unsteady?: boolean;
  strouhal?: number | null;
  speed?: number | null;
  chord?: number | null;
  historyTimes?: number[] | null;
  frameCount?: number | null;
  durationS?: number | null;
  fps?: number;
  minCycles?: number;
  minFramesPerCycle?: number;
}

export interface UransMediaQuality {
  ok: boolean;
  evaluated: boolean;
  reason: string;
  retainedCycles: number;
  frameCount: number;
  framesPerCycle: number;
  measuredPeriodS: number;
}

function finitePositive(x: number | null | undefined): number | null {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null;
}

function finiteNumber(x: number | null | undefined): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

export function evaluateUransMediaQuality(
  input: UransMediaQualityInput,
): UransMediaQuality {
  const unevaluated = (reason: string): UransMediaQuality => ({
    ok: true,
    evaluated: false,
    reason,
    retainedCycles: 0,
    frameCount: 0,
    framesPerCycle: 0,
    measuredPeriodS: 0,
  });

  if (!input.unsteady)
    return unevaluated(
      "steady RANS result; URANS media quality does not apply.",
    );

  const st = finitePositive(input.strouhal);
  const speed = finitePositive(input.speed);
  const chord = finitePositive(input.chord);
  const times = input.historyTimes;
  if (!st || !speed || !chord || !times || times.length < 2) {
    return unevaluated(
      "URANS media quality could not be evaluated: missing Strouhal, speed, chord, or force history.",
    );
  }

  const fps = finitePositive(input.fps) ?? URANS_ANIMATION_FPS;
  const storedFrames = finitePositive(input.frameCount);
  const durationFrames =
    finitePositive(input.durationS) == null
      ? null
      : Math.round(input.durationS! * fps);
  const frameCount = storedFrames ?? durationFrames;
  if (!frameCount) {
    return unevaluated(
      "URANS media quality could not be evaluated: missing animation frame count.",
    );
  }

  const t0 = finiteNumber(times[0]);
  const t1 = finiteNumber(times[times.length - 1]);
  if (t0 == null || t1 == null || t1 <= t0) {
    return unevaluated(
      "URANS media quality could not be evaluated: invalid retained force-history window.",
    );
  }

  const minCycles = input.minCycles ?? URANS_MIN_RETAINED_CYCLES;
  const minFramesPerCycle =
    input.minFramesPerCycle ?? URANS_MIN_ANIMATION_FRAMES_PER_CYCLE;
  const measuredPeriodS = chord / (st * speed);
  const retainedCycles = (t1 - t0) / measuredPeriodS;
  const framesPerCycle = frameCount / retainedCycles;
  const eps = 1e-9;
  const short = retainedCycles + eps < minCycles;
  const sparse = framesPerCycle + eps < minFramesPerCycle;
  const ok = !short && !sparse;
  const parts = [];
  if (short)
    parts.push(
      `retained cycles ${retainedCycles.toFixed(2)} < ${minCycles.toFixed(2)}`,
    );
  if (sparse)
    parts.push(
      `frames/cycle ${framesPerCycle.toFixed(2)} < ${minFramesPerCycle.toFixed(2)}`,
    );

  return {
    ok,
    evaluated: true,
    reason: ok ? "URANS media quality target met." : parts.join("; "),
    retainedCycles,
    frameCount,
    framesPerCycle,
    measuredPeriodS,
  };
}
