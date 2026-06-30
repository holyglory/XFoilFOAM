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

export function evaluateUransMediaQuality(input: UransMediaQualityInput): UransMediaQuality {
  const unevaluated = (reason: string): UransMediaQuality => ({
    ok: true,
    evaluated: false,
    reason,
    retainedCycles: 0,
    frameCount: 0,
    framesPerCycle: 0,
    measuredPeriodS: 0,
  });

  if (!input.unsteady) return unevaluated("steady RANS result; URANS media quality does not apply.");

  const st = finitePositive(input.strouhal);
  const speed = finitePositive(input.speed);
  const chord = finitePositive(input.chord);
  const times = input.historyTimes;
  if (!st || !speed || !chord || !times || times.length < 2) {
    return unevaluated("URANS media quality could not be evaluated: missing Strouhal, speed, chord, or force history.");
  }

  const fps = finitePositive(input.fps) ?? URANS_ANIMATION_FPS;
  const storedFrames = finitePositive(input.frameCount);
  const durationFrames = finitePositive(input.durationS) == null ? null : Math.round(input.durationS! * fps);
  const frameCount = storedFrames ?? durationFrames;
  if (!frameCount) {
    return unevaluated("URANS media quality could not be evaluated: missing animation frame count.");
  }

  const t0 = finiteNumber(times[0]);
  const t1 = finiteNumber(times[times.length - 1]);
  if (t0 == null || t1 == null || t1 <= t0) {
    return unevaluated("URANS media quality could not be evaluated: invalid retained force-history window.");
  }

  const minCycles = input.minCycles ?? URANS_MIN_RETAINED_CYCLES;
  const minFramesPerCycle = input.minFramesPerCycle ?? URANS_MIN_ANIMATION_FRAMES_PER_CYCLE;
  const measuredPeriodS = chord / (st * speed);
  const retainedCycles = (t1 - t0) / measuredPeriodS;
  const framesPerCycle = frameCount / retainedCycles;
  const eps = 1e-9;
  const short = retainedCycles + eps < minCycles;
  const sparse = framesPerCycle + eps < minFramesPerCycle;
  const ok = !short && !sparse;
  const parts = [];
  if (short) parts.push(`retained cycles ${retainedCycles.toFixed(2)} < ${minCycles.toFixed(2)}`);
  if (sparse) parts.push(`frames/cycle ${framesPerCycle.toFixed(2)} < ${minFramesPerCycle.toFixed(2)}`);

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
