// Client-side campaign-plan math. Every value is canonicalized through
// @aerodb/core (the same module the API/db use, spec §4), so chip sets, combo
// keys and point arithmetic are byte-identical to what the server computes.

import { canonicalAoa, canonicalSiString, expandAngleGrid } from "@aerodb/core";

import type { CampaignPlanInput } from "@/lib/admin";

export const CAMPAIGN_MAX_VALUES_PER_AXIS = 25;
export const CAMPAIGN_MAX_CONDITIONS = 2000;
export const CAMPAIGN_CONFIRM_THRESHOLD = 10_000;

export type AmbientPair = [string, string];
export type ExcludedCondition = [string, string, string, string];

export function dedupeSorted<T>(items: T[], key: (t: T) => string, cmp: (a: T, b: T) => number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out.sort(cmp);
}

export function canonicalAxisValues(kind: "speedMps" | "chordM", values: Array<number | string>): string[] {
  const canon = values
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => canonicalSiString(kind, n));
  return dedupeSorted(canon, (x) => x, (a, b) => Number(a) - Number(b));
}

export function canonicalAmbients(pairs: Array<[number | string, number | string]>): AmbientPair[] {
  const canon = pairs
    .map(([t, p]) => [Number(t), Number(p)] as [number, number])
    .filter(([t, p]) => Number.isFinite(t) && t > 0 && Number.isFinite(p) && p > 0)
    .map(([t, p]) => [canonicalSiString("temperatureK", t), canonicalSiString("pressurePa", p)] as AmbientPair);
  return dedupeSorted(canon, (a) => `${a[0]}|${a[1]}`, (a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]));
}

export function comboKey(t: string, p: string, speed: string, chord: string): string {
  return `${t}|${p}|${speed}|${chord}`;
}

export interface PlanCombo {
  ord: number;
  temperatureK: string;
  pressurePa: string;
  speedMps: string;
  chordM: string;
  comboKey: string;
  excluded: boolean;
}

/** Full ambient × speed × chord grid, exclusion-flagged (spec §3.1/§5). */
export function planCombos(
  ambients: AmbientPair[],
  speedsMps: string[],
  chordsM: string[],
  excludedConditions: ExcludedCondition[],
): PlanCombo[] {
  const excluded = new Set(excludedConditions.map((x) => x.join("|")));
  const combos: PlanCombo[] = [];
  let ord = 0;
  for (const [t, p] of ambients) {
    for (const speed of speedsMps) {
      for (const chord of chordsM) {
        const key = comboKey(t, p, speed, chord);
        combos.push({ ord: ord++, temperatureK: t, pressurePa: p, speedMps: speed, chordM: chord, comboKey: key, excluded: excluded.has(key) });
      }
    }
  }
  return combos;
}

export interface AngleSets {
  angles: number[];
  negativeAngles: number[];
  symmetricSolverAngles: number[];
}

export function angleSetsFromAngles(angles: number[]): AngleSets {
  const canonical = [...new Set(angles.map(canonicalAoa))].sort((a, b) => a - b);
  const negativeAngles = canonical.filter((a) => a < 0);
  const symmetricSolverAngles = [...new Set(canonical.map((a) => canonicalAoa(Math.abs(a))))].sort((a, b) => a - b);
  return { angles: canonical, negativeAngles, symmetricSolverAngles };
}

/** Expand the wizard's base sweep. Returns null with a message on bad input. */
export function tryExpandSweep(spec: {
  mode: "range" | "list";
  fromDeg: number;
  toDeg: number;
  stepDeg: number;
  listDeg: number[];
}): { sets: AngleSets; error: null } | { sets: null; error: string } {
  try {
    const angles =
      spec.mode === "list"
        ? expandAngleGrid({ listDeg: spec.listDeg })
        : expandAngleGrid({ fromDeg: spec.fromDeg, toDeg: spec.toDeg, stepDeg: spec.stepDeg });
    if (angles.length === 0) return { sets: null, error: "base sweep expands to zero angles" };
    return { sets: angleSetsFromAngles(angles), error: null };
  } catch (e) {
    return { sets: null, error: (e as Error).message };
  }
}

/** Per-airfoil obligation sizes for one condition — mirror of the server's
 *  campaignPointArithmetic (packages/db/src/campaigns.ts). */
export function pointArithmetic(sets: AngleSets, asymmetricCount: number, symmetricCount: number) {
  const gridSet = new Set(sets.angles);
  const extraMirrored = sets.symmetricSolverAngles.filter((a) => !gridSet.has(a)).length;
  const points = (asymmetricCount + symmetricCount) * sets.angles.length + symmetricCount * extraMirrored;
  const solverRuns = asymmetricCount * sets.angles.length + symmetricCount * sets.symmetricSolverAngles.length;
  const derivedPoints = symmetricCount * sets.negativeAngles.length;
  return { points, solverRuns, derivedPoints };
}

export function aoaString(v: number): string {
  return canonicalAoa(v).toFixed(4);
}

// ---------------------------------------------------------------------------
// Wizard envelope state → CampaignPlanInput
// ---------------------------------------------------------------------------
export interface WizardEnvelope {
  mediumId: string;
  ambients: AmbientPair[];
  speedsMps: string[];
  chordsM: string[];
  spanM: string;
  areaMode: "derived" | "explicit";
  areaM2: string | null;
  excludedConditions: ExcludedCondition[];
}

export interface WizardAnglePlan {
  sweepMode: "range" | "list";
  fromDeg: number;
  toDeg: number;
  stepDeg: number;
  listText: string;
  ldMax: { enabled: boolean; toleranceDeg: number; maxRounds: number };
  clZero: { enabled: boolean; toleranceDeg: number; maxRounds: number };
  clMax: { enabled: boolean; toleranceDeg: number; maxRounds: number };
}

export function parseAngleListText(text: string): { values: number[]; invalidTokens: string[] } {
  const tokens = text
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const values: number[] = [];
  const invalidTokens: string[] = [];
  for (const token of tokens) {
    const n = Number(token);
    if (Number.isFinite(n)) values.push(n);
    else invalidTokens.push(token);
  }
  return { values, invalidTokens };
}

export function sweepSetsOf(angle: WizardAnglePlan) {
  return tryExpandSweep({
    mode: angle.sweepMode,
    fromDeg: angle.fromDeg,
    toDeg: angle.toDeg,
    stepDeg: angle.stepDeg,
    listDeg: parseAngleListText(angle.listText).values,
  });
}

/** Only exclusions that still hit the current grid count against the total. */
export function applicableExclusions(
  ambients: AmbientPair[],
  speedsMps: string[],
  chordsM: string[],
  excludedConditions: ExcludedCondition[],
): ExcludedCondition[] {
  const ambientSet = new Set(ambients.map((a) => `${a[0]}|${a[1]}`));
  const speedSet = new Set(speedsMps);
  const chordSet = new Set(chordsM);
  return excludedConditions.filter(([t, p, s, c]) => ambientSet.has(`${t}|${p}`) && speedSet.has(s) && chordSet.has(c));
}

export function buildPlanInput(envelope: WizardEnvelope, angle: WizardAnglePlan, numerics: CampaignPlanInput["numerics"]): CampaignPlanInput {
  const baseSweep =
    angle.sweepMode === "list"
      ? {
          fromDeg: null,
          toDeg: null,
          stepDeg: null,
          listDeg: [...new Set(parseAngleListText(angle.listText).values.map(canonicalAoa))].sort((a, b) => a - b).map(aoaString),
        }
      : { fromDeg: aoaString(angle.fromDeg), toDeg: aoaString(angle.toDeg), stepDeg: aoaString(angle.stepDeg), listDeg: null };
  return {
    mediumId: envelope.mediumId,
    ambients: envelope.ambients,
    speedsMps: envelope.speedsMps,
    chordsM: envelope.chordsM,
    spanM: envelope.spanM,
    areaMode: envelope.areaMode,
    areaM2: envelope.areaMode === "explicit" ? envelope.areaM2 : null,
    excludedConditions: applicableExclusions(envelope.ambients, envelope.speedsMps, envelope.chordsM, envelope.excludedConditions),
    objectives: {
      ldMax: { enabled: angle.ldMax.enabled, toleranceDeg: angle.ldMax.toleranceDeg.toFixed(2), maxRounds: angle.ldMax.maxRounds },
      clZero: { enabled: angle.clZero.enabled, toleranceDeg: angle.clZero.toleranceDeg.toFixed(2), maxRounds: angle.clZero.maxRounds },
      clMax: { enabled: angle.clMax.enabled, toleranceDeg: angle.clMax.toleranceDeg.toFixed(2), maxRounds: angle.clMax.maxRounds },
    },
    baseSweep,
    numerics,
  };
}
