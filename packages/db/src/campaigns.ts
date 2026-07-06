// Simulation-campaign domain module (spec: docs/simulation-campaigns-spec.md
// §5 launch, §6 plan editing/closure/lifecycle, §10 bounded reads).
//
// Framework-free and drizzle-only: the API routes and (later) the sweeper both
// import this module, so it must not reach into Fastify, env, or app state.
// Every write path is transactional and set-based; angle grids are ALWAYS
// generated in TS via @aerodb/core expandAngleGrid (never SQL generate_series).

import { createHash } from "node:crypto";

import {
  canonicalAoa,
  canonicalSiString,
  deriveFlowConditionState,
  expandAngleGrid,
  type MediumStateInput,
  type ViscositySpec,
} from "@aerodb/core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { recomputeProgressForCampaign } from "./campaign-execution";
import type { DB } from "./client";
import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  flowConditions,
  type Medium,
  mediums,
  mediumViscosityTablePoints,
  meshProfiles,
  outputProfiles,
  referenceGeometryProfiles,
  results,
  schedulingProfiles,
  simCampaignAirfoils,
  simCampaignConditions,
  simCampaignLanes,
  simCampaignPlanRevisions,
  simCampaignPoints,
  simCampaignProgress,
  simCampaigns,
  simulationPresetRevisions,
  simulationPresets,
  solverProfiles,
  sweepDefinitions,
} from "./schema";
import {
  ensureSimulationPresetRevision,
  flowConditionCanonicalKey,
  physicsHashForSnapshot,
  referenceGeometryCanonicalKey,
  resolveSimulationPresetSnapshot,
  type SimulationSetupSnapshot,
} from "./simulation-setup";

// ---------------------------------------------------------------------------
// Shared db/tx plumbing. Drizzle's PgTransaction is structurally the same
// query surface as the pooled client for everything this module does, so
// helpers accept either and narrow through `asDb`.
// ---------------------------------------------------------------------------
export type CampaignTx = Parameters<Parameters<DB["transaction"]>[0]>[0];
type DbTx = DB | CampaignTx;
const asDb = (db: DbTx): DB => db as DB;

// ---------------------------------------------------------------------------
// Errors — typed so the API layer can map to proper HTTP codes.
// ---------------------------------------------------------------------------
export type CampaignErrorCode = "validation" | "not_found" | "conflict" | "invalid_state" | "drift";

export class CampaignError extends Error {
  readonly code: CampaignErrorCode;
  readonly details?: unknown;
  constructor(code: CampaignErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CampaignError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Plan document (spec §3.1) — canonical, byte-stable jsonb shape.
// ---------------------------------------------------------------------------
export type CampaignObjectiveId = "ldMax" | "clZero";
export type CampaignObjectiveKey = "ld_max" | "cl_zero";

export const CAMPAIGN_OBJECTIVES: ReadonlyArray<{ id: CampaignObjectiveId; key: CampaignObjectiveKey }> = [
  { id: "ldMax", key: "ld_max" },
  { id: "clZero", key: "cl_zero" },
];

export interface CampaignObjectivePlan {
  enabled: boolean;
  toleranceDeg: string; // canonical 2-decimal string
  maxRounds: number;
}

export interface CampaignBaseSweep {
  fromDeg: string | null;
  toDeg: string | null;
  stepDeg: string | null;
  listDeg: string[] | null;
}

export interface CampaignPlan {
  mediumId: string;
  ambients: Array<[string, string]>; // [T_K, P_Pa] canonical strings, sorted
  speedsMps: string[]; // sorted canonical strings
  chordsM: string[]; // sorted canonical strings
  spanM: string;
  areaMode: "derived" | "explicit";
  areaM2: string | null;
  excludedConditions: Array<[string, string, string, string]>; // [T, P, speed, chord]
  baseSweep: CampaignBaseSweep;
  objectives: { ldMax: CampaignObjectivePlan; clZero: CampaignObjectivePlan };
  numerics: { boundaryProfileId: string; meshProfileId: string; solverProfileId: string; outputProfileId: string };
}

type NumberLike = number | string;

export interface CampaignPlanInput {
  mediumId: string;
  ambients: Array<[NumberLike, NumberLike]>;
  speedsMps: NumberLike[];
  chordsM: NumberLike[];
  spanM: NumberLike;
  areaMode?: "derived" | "explicit";
  areaM2?: NumberLike | null;
  excludedConditions?: Array<[NumberLike, NumberLike, NumberLike, NumberLike]>;
  baseSweep: { fromDeg?: NumberLike | null; toDeg?: NumberLike | null; stepDeg?: NumberLike | null; listDeg?: NumberLike[] | null };
  objectives: {
    ldMax: { enabled: boolean; toleranceDeg: NumberLike; maxRounds: number };
    clZero: { enabled: boolean; toleranceDeg: NumberLike; maxRounds: number };
  };
  numerics: { boundaryProfileId: string; meshProfileId: string; solverProfileId: string; outputProfileId: string };
}

export interface CampaignPlanIssue {
  path: string;
  message: string;
}

export const CAMPAIGN_MAX_VALUES_PER_AXIS = 25;
export const CAMPAIGN_MAX_CONDITIONS = 2000;

const num = (v: NumberLike): number => (typeof v === "number" ? v : Number(v));

function canonicalAoaString(v: NumberLike): string {
  return canonicalAoa(num(v)).toFixed(4);
}

function toleranceString(v: NumberLike): string {
  const n = num(v);
  if (!Number.isFinite(n) || n <= 0) throw new CampaignError("validation", `objective tolerance must be > 0 (got ${v})`);
  return n.toFixed(2);
}

/** Canonicalize + structurally validate a plan document. Throws
 *  CampaignError("validation") with an issue list on any failure. */
export function normalizeCampaignPlan(input: CampaignPlanInput): CampaignPlan {
  const issues: CampaignPlanIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  if (!input.mediumId || typeof input.mediumId !== "string") push("mediumId", "medium is required");

  const ambientPairs = (input.ambients ?? []).map(([t, p]) => {
    const tN = num(t);
    const pN = num(p);
    if (!(Number.isFinite(tN) && tN > 0)) push("ambients", `temperature must be > 0 K (got ${t})`);
    if (!(Number.isFinite(pN) && pN > 0)) push("ambients", `pressure must be > 0 Pa (got ${p})`);
    return [canonicalSiString("temperatureK", tN), canonicalSiString("pressurePa", pN)] as [string, string];
  });
  const ambients = dedupeSorted(ambientPairs, (a) => `${a[0]}|${a[1]}`, (a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]));
  if (ambients.length === 0) push("ambients", "at least one ambient (T, P) is required");
  if (ambients.length > CAMPAIGN_MAX_VALUES_PER_AXIS) push("ambients", `at most ${CAMPAIGN_MAX_VALUES_PER_AXIS} ambients`);

  const speeds = canonicalAxis(input.speedsMps ?? [], "speedMps", (m) => push("speedsMps", m));
  const chords = canonicalAxis(input.chordsM ?? [], "chordM", (m) => push("chordsM", m));

  const spanN = num(input.spanM);
  if (!(Number.isFinite(spanN) && spanN > 0)) push("spanM", "span must be > 0 m");
  const spanM = canonicalSiString("spanM", Number.isFinite(spanN) && spanN > 0 ? spanN : 1);

  const areaMode = input.areaMode ?? "derived";
  let areaM2: string | null = null;
  if (areaMode === "explicit") {
    if (chords.length > 1) push("areaMode", 'explicit reference area is only allowed while a single chord is selected');
    const areaN = num(input.areaM2 ?? NaN);
    if (!(Number.isFinite(areaN) && areaN > 0)) push("areaM2", "explicit area mode requires areaM2 > 0");
    else areaM2 = canonicalSiString("areaM2", areaN);
  } else if (input.areaM2 != null) {
    push("areaM2", 'areaM2 must be null while areaMode is "derived"');
  }

  const excluded = dedupeSorted(
    (input.excludedConditions ?? []).map(
      ([t, p, s, c]) =>
        [
          canonicalSiString("temperatureK", num(t)),
          canonicalSiString("pressurePa", num(p)),
          canonicalSiString("speedMps", num(s)),
          canonicalSiString("chordM", num(c)),
        ] as [string, string, string, string],
    ),
    (x) => x.join("|"),
    (a, b) => a.join("|").localeCompare(b.join("|")),
  );

  const rawSweep = input.baseSweep ?? {};
  let baseSweep: CampaignBaseSweep;
  let angleCount = 0;
  try {
    if (rawSweep.listDeg != null) {
      const list = expandAngleGrid({ listDeg: rawSweep.listDeg.map(num) });
      if (list.length === 0) push("baseSweep.listDeg", "angle list must contain at least one angle");
      angleCount = list.length;
      baseSweep = { fromDeg: null, toDeg: null, stepDeg: null, listDeg: list.map((a) => a.toFixed(4)) };
    } else {
      const grid = expandAngleGrid({ fromDeg: num(rawSweep.fromDeg ?? NaN), toDeg: num(rawSweep.toDeg ?? NaN), stepDeg: num(rawSweep.stepDeg ?? NaN) });
      if (grid.length === 0) push("baseSweep", "base sweep expands to zero angles");
      angleCount = grid.length;
      baseSweep = {
        fromDeg: canonicalAoaString(rawSweep.fromDeg ?? 0),
        toDeg: canonicalAoaString(rawSweep.toDeg ?? 0),
        stepDeg: canonicalAoaString(rawSweep.stepDeg ?? 0),
        listDeg: null,
      };
    }
  } catch (e) {
    push("baseSweep", (e as Error).message);
    baseSweep = { fromDeg: null, toDeg: null, stepDeg: null, listDeg: [] };
  }

  const objectives = {
    ldMax: normalizeObjective(input.objectives?.ldMax, "objectives.ldMax", push),
    clZero: normalizeObjective(input.objectives?.clZero, "objectives.clZero", push),
  };
  if ((objectives.ldMax.enabled || objectives.clZero.enabled) && angleCount < 3) {
    push("objectives", "refinement objectives require a base sweep of at least 3 angles");
  }

  const numerics = input.numerics ?? ({} as CampaignPlanInput["numerics"]);
  for (const slot of ["boundaryProfileId", "meshProfileId", "solverProfileId", "outputProfileId"] as const) {
    if (!numerics?.[slot]) push(`numerics.${slot}`, "numerics profile is required");
  }

  const comboCount = ambients.length * speeds.length * chords.length - countApplicableExclusions(ambients, speeds, chords, excluded);
  if (comboCount <= 0) push("excludedConditions", "every condition combination is excluded — nothing to run");
  if (comboCount > CAMPAIGN_MAX_CONDITIONS) push("conditions", `plan expands to ${comboCount} conditions (max ${CAMPAIGN_MAX_CONDITIONS})`);

  if (issues.length > 0) throw new CampaignError("validation", "campaign plan is invalid", { issues });

  return {
    mediumId: input.mediumId,
    ambients,
    speedsMps: speeds,
    chordsM: chords,
    spanM,
    areaMode,
    areaM2,
    excludedConditions: excluded,
    baseSweep,
    objectives,
    numerics: {
      boundaryProfileId: numerics.boundaryProfileId,
      meshProfileId: numerics.meshProfileId,
      solverProfileId: numerics.solverProfileId,
      outputProfileId: numerics.outputProfileId,
    },
  };
}

function normalizeObjective(
  input: { enabled: boolean; toleranceDeg: NumberLike; maxRounds: number } | undefined,
  path: string,
  push: (path: string, message: string) => void,
): CampaignObjectivePlan {
  if (!input) {
    push(path, "objective block is required (enabled=false is fine)");
    return { enabled: false, toleranceDeg: "0.10", maxRounds: 8 };
  }
  let toleranceDeg = "0.10";
  try {
    toleranceDeg = toleranceString(input.toleranceDeg);
  } catch (e) {
    push(`${path}.toleranceDeg`, (e as Error).message);
  }
  const maxRounds = Number(input.maxRounds);
  if (!(Number.isInteger(maxRounds) && maxRounds >= 1 && maxRounds <= 50)) push(`${path}.maxRounds`, "maxRounds must be an integer 1..50");
  return { enabled: Boolean(input.enabled), toleranceDeg, maxRounds: Number.isInteger(maxRounds) ? maxRounds : 8 };
}

function canonicalAxis(values: NumberLike[], kind: "speedMps" | "chordM", push: (message: string) => void): string[] {
  const canon = values.map((v) => {
    const n = num(v);
    if (!(Number.isFinite(n) && n > 0)) push(`values must be finite and > 0 (got ${v})`);
    return canonicalSiString(kind, Number.isFinite(n) && n > 0 ? n : 1);
  });
  const out = dedupeSorted(canon, (x) => x, (a, b) => Number(a) - Number(b));
  if (out.length === 0) push("at least one value is required");
  if (out.length > CAMPAIGN_MAX_VALUES_PER_AXIS) push(`at most ${CAMPAIGN_MAX_VALUES_PER_AXIS} values per axis`);
  return out;
}

function dedupeSorted<T>(items: T[], key: (t: T) => string, cmp: (a: T, b: T) => number): T[] {
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

function countApplicableExclusions(
  ambients: Array<[string, string]>,
  speeds: string[],
  chords: string[],
  excluded: Array<[string, string, string, string]>,
): number {
  const ambientSet = new Set(ambients.map((a) => `${a[0]}|${a[1]}`));
  const speedSet = new Set(speeds);
  const chordSet = new Set(chords);
  let n = 0;
  for (const [t, p, s, c] of excluded) {
    if (ambientSet.has(`${t}|${p}`) && speedSet.has(s) && chordSet.has(c)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Condition combos + angle grids
// ---------------------------------------------------------------------------
export interface CampaignConditionCombo {
  ord: number;
  temperatureK: string;
  pressurePa: string;
  speedMps: string;
  chordM: string;
  spanM: string;
  areaM2: string | null;
  comboKey: string; // T|P|speed|chord canonical strings
}

export function campaignComboKey(temperatureK: string, pressurePa: string, speedMps: string, chordM: string): string {
  return `${temperatureK}|${pressurePa}|${speedMps}|${chordM}`;
}

/** Ordered (ambient × speed × chord) minus exclusions (spec §3.1/§5). */
export function conditionCombosFromPlan(plan: CampaignPlan): CampaignConditionCombo[] {
  const excluded = new Set(plan.excludedConditions.map((x) => x.join("|")));
  const combos: CampaignConditionCombo[] = [];
  let ord = 0;
  for (const [t, p] of plan.ambients) {
    for (const speed of plan.speedsMps) {
      for (const chord of plan.chordsM) {
        const comboKey = campaignComboKey(t, p, speed, chord);
        if (excluded.has(comboKey)) continue;
        combos.push({
          ord: ord++,
          temperatureK: t,
          pressurePa: p,
          speedMps: speed,
          chordM: chord,
          spanM: plan.spanM,
          areaM2: plan.areaMode === "explicit" ? plan.areaM2 : null,
          comboKey,
        });
      }
    }
  }
  return combos;
}

export interface CampaignAngleSets {
  /** Full requested grid (canonical, ascending). */
  angles: number[];
  /** Negative angles of the grid (derived cells for symmetric airfoils). */
  negativeAngles: number[];
  /** Solver angles for symmetric airfoils: unique |α| of the grid, ascending. */
  symmetricSolverAngles: number[];
}

export function campaignAngleSets(plan: CampaignPlan): CampaignAngleSets {
  const angles = expandAngleGrid({
    fromDeg: plan.baseSweep.fromDeg == null ? undefined : Number(plan.baseSweep.fromDeg),
    toDeg: plan.baseSweep.toDeg == null ? undefined : Number(plan.baseSweep.toDeg),
    stepDeg: plan.baseSweep.stepDeg == null ? undefined : Number(plan.baseSweep.stepDeg),
    listDeg: plan.baseSweep.listDeg == null ? null : plan.baseSweep.listDeg.map(Number),
  });
  return angleSetsFromAngles(angles);
}

export function angleSetsFromAngles(angles: number[]): CampaignAngleSets {
  const canonical = [...new Set(angles.map(canonicalAoa))].sort((a, b) => a - b);
  const negativeAngles = canonical.filter((a) => a < 0);
  const symmetricSolverAngles = [...new Set(canonical.map((a) => canonicalAoa(Math.abs(a))))].sort((a, b) => a - b);
  return { angles: canonical, negativeAngles, symmetricSolverAngles };
}

/** Per-airfoil obligation sizes for one condition given the angle sets. */
export function campaignPointArithmetic(sets: CampaignAngleSets, asymmetricCount: number, symmetricCount: number) {
  // Every requested angle is a point for every airfoil. Symmetric airfoils
  // additionally need mirrored solver cells for negative angles whose |α| is
  // not already in the grid (the derived cell needs a real +α source).
  const gridSet = new Set(sets.angles);
  const extraMirrored = sets.symmetricSolverAngles.filter((a) => !gridSet.has(a)).length;
  const points = (asymmetricCount + symmetricCount) * sets.angles.length + symmetricCount * extraMirrored;
  const solverRuns = asymmetricCount * sets.angles.length + symmetricCount * sets.symmetricSolverAngles.length;
  const derivedPoints = symmetricCount * sets.negativeAngles.length;
  return { points, solverRuns, derivedPoints };
}

// ---------------------------------------------------------------------------
// Deterministic hashing (diff hashes, idempotent previews)
// ---------------------------------------------------------------------------
export function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function campaignDiffHash(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

// postgres-js binds plain JS arrays as records, so array parameters are
// serialized to Postgres array literals and cast explicitly.
function pgFloatArray(values: number[]): string {
  return `{${values.join(",")}}`;
}
function pgUuidArray(values: string[]): string {
  return `{${values.join(",")}}`;
}
function pgBoolArray(values: boolean[]): string {
  return `{${values.map((v) => (v ? "t" : "f")).join(",")}}`;
}
function pgTextArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

function slugifyCampaign(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "campaign"
  );
}

// ---------------------------------------------------------------------------
// Legacy boundary-condition bridge (spec §3.3). This is THE single
// implementation — apps/api/src/admin-routes.ts re-uses it. results.bcId is
// NOT NULL, so campaign launch runs this for every found-or-created preset
// BEFORE any points/results rows are created.
// ---------------------------------------------------------------------------
function legacyBoundaryValuesFromSnapshot(snapshot: SimulationSetupSnapshot) {
  return {
    name: snapshot.preset.name,
    mediumId: snapshot.flowState.mediumId,
    reynolds: Math.round(snapshot.derived.reynolds),
    referenceChordM: snapshot.referenceGeometry.referenceLengthM,
    temperatureK: snapshot.flowState.temperatureK,
    pressurePa: snapshot.flowState.pressurePa,
    speedMps: snapshot.flowState.speedMps,
    density: snapshot.flowState.density,
    dynamicViscosity: snapshot.flowState.dynamicViscosity,
    kinematicViscosity: snapshot.flowState.kinematicViscosity,
    mach: snapshot.flowState.mach,
    turbulenceModel: snapshot.solver.turbulenceModel,
    turbulenceIntensity: snapshot.boundary.turbulenceIntensity,
    viscosityRatio: snapshot.boundary.viscosityRatio,
    sandGrainHeight: snapshot.boundary.sandGrainHeight,
    roughnessConstant: snapshot.boundary.roughnessConstant,
    mesher: snapshot.mesh.mesher,
    farfieldRadiusChords: snapshot.mesh.farfieldRadiusChords,
    wakeLengthChords: snapshot.mesh.wakeLengthChords,
    nSurface: snapshot.mesh.nSurface,
    nRadial: snapshot.mesh.nRadial,
    nWake: snapshot.mesh.nWake,
    targetYPlus: snapshot.mesh.targetYPlus,
    spanChords: snapshot.mesh.spanChords,
    nIterations: snapshot.solver.nIterations,
    convergenceTolerance: snapshot.solver.convergenceTolerance,
    momentumScheme: snapshot.solver.momentumScheme,
    transientCycles: snapshot.solver.transientCycles,
    transientDiscardFraction: snapshot.solver.transientDiscardFraction,
    transientMaxCourant: snapshot.solver.transientMaxCourant,
    writeImages: snapshot.output.writeImages,
    imageZoomChords: snapshot.output.imageZoomChords,
    schedulingPolicy: snapshot.scheduling.schedulingPolicy,
    cpuBudget: snapshot.scheduling.cpuBudget,
    caseConcurrency: snapshot.scheduling.caseConcurrency,
    solverProcesses: snapshot.scheduling.solverProcesses,
    aoaStart: snapshot.sweep.aoaStart,
    aoaStop: snapshot.sweep.aoaStop,
    aoaStep: snapshot.sweep.aoaStep,
    aoaList: snapshot.sweep.aoaList,
    enabled: snapshot.preset.enabled,
  };
}

async function uniqueLegacyBoundarySlug(db: DbTx, base: string): Promise<string> {
  let slug = base;
  let n = 2;
  for (let i = 0; i < 1000; i++) {
    const [exists] = await asDb(db).select({ id: boundaryConditions.id }).from(boundaryConditions).where(eq(boundaryConditions.slug, slug)).limit(1);
    if (!exists) return slug;
    slug = `${base}-${n++}`;
  }
  return `${base}-${Date.now()}`;
}

/** Sync (create/update) the deprecated boundary_conditions bridge row for a
 *  preset so results.bcId (NOT NULL) always has a target. Identical behavior
 *  to the pre-campaign admin-routes implementation, parameterized on db. */
export async function syncLegacyBoundaryConditionForPreset(db: DbTx, presetId: string): Promise<string | null> {
  const snapshot = await resolveSimulationPresetSnapshot(asDb(db), presetId);
  if (!snapshot) return null;
  const values = legacyBoundaryValuesFromSnapshot(snapshot);
  if (snapshot.preset.legacyBoundaryConditionId) {
    await asDb(db)
      .update(boundaryConditions)
      .set(values)
      .where(eq(boundaryConditions.id, snapshot.preset.legacyBoundaryConditionId));
    return snapshot.preset.legacyBoundaryConditionId;
  }
  const slug = await uniqueLegacyBoundarySlug(db, slugifyCampaign(snapshot.preset.slug || snapshot.preset.name));
  const [legacy] = await asDb(db).insert(boundaryConditions).values({ ...values, slug }).returning({ id: boundaryConditions.id });
  await asDb(db).update(simulationPresets).set({ legacyBoundaryConditionId: legacy.id }).where(eq(simulationPresets.id, presetId));
  return legacy.id;
}

// ---------------------------------------------------------------------------
// Medium state + value-level registry find-or-create (spec §5.3b)
// ---------------------------------------------------------------------------
interface MediumState {
  medium: Medium;
  stateInput: MediumStateInput;
}

async function loadMediumState(db: DbTx, mediumId: string): Promise<MediumState> {
  const [medium] = await asDb(db).select().from(mediums).where(eq(mediums.id, mediumId)).limit(1);
  if (!medium) throw new CampaignError("not_found", "medium not found");
  let viscosity: ViscositySpec;
  if (medium.viscosityModel === "sutherland") {
    if (!(medium.sutherlandMuRef && medium.sutherlandTRef && medium.sutherlandS)) {
      throw new CampaignError("validation", `medium ${medium.slug} is missing Sutherland coefficients`);
    }
    viscosity = { model: "sutherland", muRef: medium.sutherlandMuRef, tRef: medium.sutherlandTRef, s: medium.sutherlandS };
  } else if (medium.viscosityModel === "table") {
    const rows = await asDb(db)
      .select()
      .from(mediumViscosityTablePoints)
      .where(eq(mediumViscosityTablePoints.mediumId, medium.id))
      .orderBy(asc(mediumViscosityTablePoints.sortOrder), asc(mediumViscosityTablePoints.temperatureK));
    if (rows.length === 0) throw new CampaignError("validation", `medium ${medium.slug} has an empty viscosity table`);
    viscosity = { model: "table", tempsK: rows.map((r) => r.temperatureK), mu: rows.map((r) => r.dynamicViscosity) };
  } else {
    if (!(medium.constantDynamicViscosity && medium.constantDynamicViscosity > 0)) {
      throw new CampaignError("validation", `medium ${medium.slug} is missing a constant dynamic viscosity`);
    }
    viscosity = { model: "constant", mu: medium.constantDynamicViscosity };
  }
  return {
    medium,
    stateInput: {
      phase: medium.phase,
      density: medium.density,
      refTemperatureK: medium.refTemperatureK,
      refPressurePa: medium.refPressurePa,
      viscosity,
      speedOfSound: medium.speedOfSound,
    },
  };
}

async function uniqueSlug(db: DbTx, table: "flow_conditions" | "reference_geometry_profiles" | "simulation_presets" | "sweep_definitions" | "scheduling_profiles" | "sim_campaigns", base: string): Promise<string> {
  let slug = base || "item";
  let n = 2;
  for (let i = 0; i < 1000; i++) {
    const rows = (await asDb(db).execute(sql`SELECT id FROM ${sql.raw(table)} WHERE slug = ${slug} LIMIT 1`)) as unknown as unknown[];
    if (rows.length === 0) return slug;
    slug = `${base}-${n++}`;
  }
  return `${base}-${Date.now()}`;
}

interface FoundOrCreated<T> {
  row: T;
  created: boolean;
}

async function findOrCreateFlowCondition(
  tx: CampaignTx,
  campaignId: string,
  mediumState: MediumState,
  combo: CampaignConditionCombo,
): Promise<FoundOrCreated<typeof flowConditions.$inferSelect>> {
  const temperatureK = Number(combo.temperatureK);
  const pressurePa = Number(combo.pressurePa);
  const speedMps = Number(combo.speedMps);
  const canonicalKey = flowConditionCanonicalKey({ mediumId: mediumState.medium.id, temperatureK, pressurePa, speedMps });
  const [existing] = await asDb(tx).select().from(flowConditions).where(eq(flowConditions.canonicalKey, canonicalKey)).limit(1);
  if (existing) return { row: existing, created: false };
  const derived = deriveFlowConditionState(mediumState.stateInput, { temperatureK, pressurePa, speedMps });
  const slug = await uniqueSlug(
    tx,
    "flow_conditions",
    slugifyCampaign(`${mediumState.medium.slug}-t${combo.temperatureK}k-p${combo.pressurePa}pa-v${combo.speedMps}ms`),
  );
  const [inserted] = await asDb(tx)
    .insert(flowConditions)
    .values({
      slug,
      name: `${mediumState.medium.name} · ${combo.temperatureK} K · ${combo.pressurePa} Pa · ${combo.speedMps} m/s`,
      mediumId: mediumState.medium.id,
      temperatureK,
      pressurePa,
      speedMps,
      density: derived.density,
      dynamicViscosity: derived.dynamicViscosity,
      kinematicViscosity: derived.kinematicViscosity,
      mach: derived.mach,
      origin: "campaign",
      createdByCampaignId: campaignId,
      canonicalKey,
    })
    .onConflictDoNothing({ target: flowConditions.canonicalKey })
    .returning();
  if (inserted) return { row: inserted, created: true };
  const [row] = await asDb(tx).select().from(flowConditions).where(eq(flowConditions.canonicalKey, canonicalKey)).limit(1);
  if (!row) throw new CampaignError("conflict", "flow condition insert race could not be resolved");
  return { row, created: false };
}

async function findOrCreateReferenceGeometry(
  tx: CampaignTx,
  campaignId: string,
  combo: CampaignConditionCombo,
): Promise<FoundOrCreated<typeof referenceGeometryProfiles.$inferSelect>> {
  const referenceLengthM = Number(combo.chordM);
  const spanM = Number(combo.spanM);
  const referenceAreaM2 = combo.areaM2 == null ? null : Number(combo.areaM2);
  const canonicalKey = referenceGeometryCanonicalKey({
    geometryType: "airfoil_2d",
    referenceLengthKind: "chord",
    referenceLengthM,
    spanM,
    referenceAreaM2,
  });
  const [existing] = await asDb(tx).select().from(referenceGeometryProfiles).where(eq(referenceGeometryProfiles.canonicalKey, canonicalKey)).limit(1);
  if (existing) return { row: existing, created: false };
  const slug = await uniqueSlug(
    tx,
    "reference_geometry_profiles",
    slugifyCampaign(`chord-${combo.chordM}m-span-${combo.spanM}m${combo.areaM2 ? `-area-${combo.areaM2}m2` : ""}`),
  );
  const [inserted] = await asDb(tx)
    .insert(referenceGeometryProfiles)
    .values({
      slug,
      name: `Chord ${combo.chordM} m · span ${combo.spanM} m${combo.areaM2 ? ` · area ${combo.areaM2} m²` : ""}`,
      geometryType: "airfoil_2d",
      referenceLengthKind: "chord",
      referenceLengthM,
      spanM,
      referenceAreaM2,
      origin: "campaign",
      createdByCampaignId: campaignId,
      canonicalKey,
    })
    .onConflictDoNothing({ target: referenceGeometryProfiles.canonicalKey })
    .returning();
  if (inserted) return { row: inserted, created: true };
  const [row] = await asDb(tx).select().from(referenceGeometryProfiles).where(eq(referenceGeometryProfiles.canonicalKey, canonicalKey)).limit(1);
  if (!row) throw new CampaignError("conflict", "reference geometry insert race could not be resolved");
  return { row, created: false };
}

// ---------------------------------------------------------------------------
// Physics-hash revision reuse (spec §3.2/§5.3c)
// ---------------------------------------------------------------------------
interface NumericsRows {
  boundary: typeof boundaryProfiles.$inferSelect;
  mesh: typeof meshProfiles.$inferSelect;
  solver: typeof solverProfiles.$inferSelect;
  output: typeof outputProfiles.$inferSelect;
}

async function loadNumericsRows(db: DbTx, numerics: CampaignPlan["numerics"]): Promise<NumericsRows> {
  const [[boundary], [mesh], [solver], [output]] = await Promise.all([
    asDb(db).select().from(boundaryProfiles).where(eq(boundaryProfiles.id, numerics.boundaryProfileId)).limit(1),
    asDb(db).select().from(meshProfiles).where(eq(meshProfiles.id, numerics.meshProfileId)).limit(1),
    asDb(db).select().from(solverProfiles).where(eq(solverProfiles.id, numerics.solverProfileId)).limit(1),
    asDb(db).select().from(outputProfiles).where(eq(outputProfiles.id, numerics.outputProfileId)).limit(1),
  ]);
  if (!boundary) throw new CampaignError("not_found", "boundary profile not found");
  if (!mesh) throw new CampaignError("not_found", "mesh profile not found");
  if (!solver) throw new CampaignError("not_found", "solver profile not found");
  if (!output) throw new CampaignError("not_found", "output profile not found");
  return { boundary, mesh, solver, output };
}

function stripRowMeta<T extends { createdAt: Date; updatedAt: Date; isSeeded: boolean }>(row: T) {
  const { createdAt: _c, updatedAt: _u, isSeeded: _s, ...rest } = row;
  return rest;
}

/** Build the physics-relevant snapshot subset for hashing. Only the blocks
 *  physicsHashForSnapshot reads are real; preset/scheduling/output/sweep are
 *  placeholders that the hash provably ignores (see simulation-setup.ts). */
function buildPhysicsHashSnapshot(args: {
  flow: typeof flowConditions.$inferSelect;
  medium: Medium;
  geo: typeof referenceGeometryProfiles.$inferSelect;
  numerics: NumericsRows;
}): { snapshot: SimulationSetupSnapshot; reynolds: number; mach: number | null } {
  const { flow, medium, geo, numerics } = args;
  const reynolds = Math.round((flow.speedMps * geo.referenceLengthM) / flow.kinematicViscosity);
  const snapshot = {
    preset: { id: "", slug: "", name: "", enabled: false, legacyBoundaryConditionId: null },
    flowState: {
      id: flow.id,
      slug: flow.slug,
      name: flow.name,
      mediumId: flow.mediumId,
      mediumSlug: medium.slug,
      mediumName: medium.name,
      temperatureK: flow.temperatureK,
      pressurePa: flow.pressurePa,
      speedMps: flow.speedMps,
      density: flow.density,
      dynamicViscosity: flow.dynamicViscosity,
      kinematicViscosity: flow.kinematicViscosity,
      mach: flow.mach,
    },
    referenceGeometry: {
      id: geo.id,
      slug: geo.slug,
      name: geo.name,
      geometryType: geo.geometryType,
      referenceLengthKind: geo.referenceLengthKind,
      referenceLengthM: geo.referenceLengthM,
      spanM: geo.spanM,
      referenceAreaM2: geo.referenceAreaM2,
    },
    derived: { reynolds, mach: flow.mach },
    boundary: {
      id: numerics.boundary.id,
      slug: numerics.boundary.slug,
      name: numerics.boundary.name,
      turbulenceIntensity: numerics.boundary.turbulenceIntensity,
      viscosityRatio: numerics.boundary.viscosityRatio,
      sandGrainHeight: numerics.boundary.sandGrainHeight,
      roughnessConstant: numerics.boundary.roughnessConstant,
    },
    mesh: stripRowMeta(numerics.mesh),
    solver: stripRowMeta(numerics.solver),
    scheduling: null,
    output: null,
    sweep: null,
  } as unknown as SimulationSetupSnapshot;
  return { snapshot, reynolds, mach: flow.mach };
}

interface ResolvedCampaignRevision {
  presetId: string;
  revisionId: string;
  reynolds: number;
  mach: number | null;
  physicsHash: string;
  presetCreated: boolean;
}

interface CampaignPresetSupport {
  schedulingProfileId: string;
  sweepDefinitionId: string;
}

/** Scheduling stays out of campaign composition (spec §3.2): campaign-created
 *  presets reuse the seeded/oldest auto scheduling profile (NULL budgets =
 *  engine auto, matching global cpuSlots semantics) and get one inert sweep
 *  definition per campaign carrying the base sweep for snapshot honesty. */
async function ensureCampaignPresetSupport(tx: CampaignTx, campaignSlug: string, plan: CampaignPlan): Promise<CampaignPresetSupport> {
  let [sched] = await asDb(tx)
    .select({ id: schedulingProfiles.id })
    .from(schedulingProfiles)
    .where(eq(schedulingProfiles.isSeeded, true))
    .orderBy(asc(schedulingProfiles.createdAt))
    .limit(1);
  if (!sched) {
    [sched] = await asDb(tx).select({ id: schedulingProfiles.id }).from(schedulingProfiles).orderBy(asc(schedulingProfiles.createdAt)).limit(1);
  }
  if (!sched) {
    const slug = await uniqueSlug(tx, "scheduling_profiles", "campaign-auto");
    [sched] = await asDb(tx)
      .insert(schedulingProfiles)
      .values({ slug, name: "Campaign auto scheduling", schedulingPolicy: "auto" })
      .returning({ id: schedulingProfiles.id });
  }
  const sweepSlugBase = slugifyCampaign(`campaign-${campaignSlug}-sweep`);
  const [existingSweep] = await asDb(tx).select({ id: sweepDefinitions.id }).from(sweepDefinitions).where(eq(sweepDefinitions.slug, sweepSlugBase)).limit(1);
  if (existingSweep) return { schedulingProfileId: sched.id, sweepDefinitionId: existingSweep.id };
  const list = plan.baseSweep.listDeg?.map(Number) ?? null;
  const [sweep] = await asDb(tx)
    .insert(sweepDefinitions)
    .values({
      slug: sweepSlugBase,
      name: `Campaign ${campaignSlug} base sweep`,
      aoaStart: plan.baseSweep.fromDeg != null ? Number(plan.baseSweep.fromDeg) : list && list.length ? Math.min(...list) : -8,
      aoaStop: plan.baseSweep.toDeg != null ? Number(plan.baseSweep.toDeg) : list && list.length ? Math.max(...list) : 20,
      aoaStep: plan.baseSweep.stepDeg != null ? Number(plan.baseSweep.stepDeg) : 1,
      aoaList: list,
    })
    .returning({ id: sweepDefinitions.id });
  return { schedulingProfileId: sched.id, sweepDefinitionId: sweep.id };
}

async function lookupRevisionByPhysicsHash(tx: CampaignTx, physicsHash: string) {
  const [found] = await asDb(tx)
    .select({ revision: simulationPresetRevisions, preset: simulationPresets })
    .from(simulationPresetRevisions)
    .innerJoin(simulationPresets, eq(simulationPresets.id, simulationPresetRevisions.presetId))
    .where(eq(simulationPresetRevisions.physicsHash, physicsHash))
    .orderBy(
      desc(simulationPresetRevisions.isCanonicalPhysics),
      desc(simulationPresets.enabled),
      asc(simulationPresetRevisions.createdAt),
      asc(simulationPresetRevisions.id),
    )
    .limit(1);
  return found ?? null;
}

async function resolveCampaignConditionRevision(
  tx: CampaignTx,
  args: {
    campaignName: string;
    campaignSlug: string;
    plan: CampaignPlan;
    combo: CampaignConditionCombo;
    flow: typeof flowConditions.$inferSelect;
    medium: Medium;
    geo: typeof referenceGeometryProfiles.$inferSelect;
    numerics: NumericsRows;
    support: () => Promise<CampaignPresetSupport>;
    cache: Map<string, ResolvedCampaignRevision>;
  },
): Promise<ResolvedCampaignRevision> {
  const { snapshot, reynolds, mach } = buildPhysicsHashSnapshot({ flow: args.flow, medium: args.medium, geo: args.geo, numerics: args.numerics });
  const physicsHash = physicsHashForSnapshot(snapshot);
  const cached = args.cache.get(physicsHash);
  if (cached) return cached;

  // Advisory lock on the hash: races between concurrent materializers on the
  // same physics collapse to one canonical revision (spec §5.3c).
  await asDb(tx).execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"campaign-physics:" + physicsHash}, 0))`);

  const found = await lookupRevisionByPhysicsHash(tx, physicsHash);
  if (found) {
    const resolved: ResolvedCampaignRevision = {
      presetId: found.preset.id,
      revisionId: found.revision.id,
      reynolds: found.revision.reynolds,
      mach: found.revision.mach,
      physicsHash,
      presetCreated: false,
    };
    args.cache.set(physicsHash, resolved);
    return resolved;
  }

  const support = await args.support();
  const presetSlug = await uniqueSlug(tx, "simulation_presets", slugifyCampaign(`campaign-${args.campaignSlug}-re${reynolds}`));
  const [preset] = await asDb(tx)
    .insert(simulationPresets)
    .values({
      slug: presetSlug,
      name: `Campaign ${args.campaignName} · ${args.combo.temperatureK} K / ${args.combo.pressurePa} Pa · ${args.combo.speedMps} m/s · ${args.combo.chordM} m`,
      flowConditionId: args.flow.id,
      referenceGeometryProfileId: args.geo.id,
      boundaryProfileId: args.numerics.boundary.id,
      meshProfileId: args.numerics.mesh.id,
      solverProfileId: args.numerics.solver.id,
      schedulingProfileId: support.schedulingProfileId,
      outputProfileId: args.numerics.output.id,
      sweepDefinitionId: support.sweepDefinitionId,
      targetScope: "all",
      origin: "campaign",
      enabled: false,
    })
    .returning();
  const resolvedPreset = await ensureSimulationPresetRevision(asDb(tx), preset.id);
  if (!resolvedPreset) throw new CampaignError("conflict", "failed to materialize a preset revision for a campaign condition");
  // Hash the authoritative resolved snapshot (identical inputs → identical
  // hash; recomputing guards against any drift between builders).
  const actualHash = physicsHashForSnapshot(resolvedPreset.snapshot);
  await asDb(tx)
    .update(simulationPresetRevisions)
    .set({ physicsHash: actualHash, isCanonicalPhysics: true })
    .where(eq(simulationPresetRevisions.id, resolvedPreset.revision.id));
  const resolved: ResolvedCampaignRevision = {
    presetId: preset.id,
    revisionId: resolvedPreset.revision.id,
    reynolds: resolvedPreset.revision.reynolds,
    mach: resolvedPreset.revision.mach,
    physicsHash: actualHash,
    presetCreated: true,
  };
  args.cache.set(physicsHash, resolved);
  if (actualHash !== physicsHash) args.cache.set(actualHash, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Set-based point/progress/lane maintenance
// ---------------------------------------------------------------------------
const POINT_CELL_JOIN = sql`r.airfoil_id = p.airfoil_id AND r.simulation_preset_revision_id = p.revision_id AND r.aoa_deg = p.aoa_deg`;

/** Insert requested points for a set of conditions × the campaign airfoil set
 *  from TS-generated canonical angle arrays (spec §5.3e / §9.2). */
async function insertCampaignPoints(
  tx: CampaignTx,
  campaignId: string,
  planRevisionNumber: number,
  sets: CampaignAngleSets,
  opts: { conditionIds?: string[]; airfoilIds?: string[] } = {},
): Promise<void> {
  const conditionFilter = opts.conditionIds
    ? sql`AND cc.id = ANY(${pgUuidArray(opts.conditionIds)}::uuid[])`
    : sql`AND cc.status = 'active'`;
  const airfoilFilter = opts.airfoilIds ? sql`AND ca.airfoil_id = ANY(${pgUuidArray(opts.airfoilIds)}::uuid[])` : sql``;
  const insertFor = async (angles: number[], symmetric: boolean, derived: boolean) => {
    if (angles.length === 0) return;
    await asDb(tx).execute(sql`
      INSERT INTO sim_campaign_points
        (campaign_id, condition_id, airfoil_id, aoa_deg, revision_id, plan_revision_number, state, derived_by_symmetry)
      SELECT cc.campaign_id, cc.id, ca.airfoil_id, g.aoa, cc.simulation_preset_revision_id, ${planRevisionNumber}, 'requested', ${derived}
      FROM sim_campaign_conditions cc
      JOIN sim_campaign_airfoils ca ON ca.campaign_id = cc.campaign_id
      JOIN airfoils af ON af.id = ca.airfoil_id AND af.is_symmetric = ${symmetric}
      CROSS JOIN unnest(${pgFloatArray(angles)}::float8[]) AS g(aoa)
      WHERE cc.campaign_id = ${campaignId}
        ${conditionFilter}
        ${airfoilFilter}
      ON CONFLICT (campaign_id, condition_id, airfoil_id, aoa_deg) DO NOTHING
    `);
  };
  await insertFor(sets.angles, false, false); // asymmetric airfoils: full grid
  await insertFor(sets.symmetricSolverAngles, true, false); // symmetric: α ≥ 0 solver cells (incl. mirrored sources)
  await insertFor(sets.negativeAngles, true, true); // symmetric: derived negative cells
  // The bulk insert above can add 10^6+ rows inside this transaction, but the
  // planner still sees pre-insert statistics; without ANALYZE the follow-up
  // self-joins (derived-cell linking, counters) pick runaway nested-loop plans
  // (measured: a 1.2M-point launch spent >5 min in one UPDATE, seconds after).
  await asDb(tx).execute(sql`ANALYZE sim_campaign_points`);
}

/** Reactivate previously released points that are requested again (re-adds
 *  re-use the original rows for evidence continuity, spec §6.1). */
async function reactivateReleasedPoints(
  tx: CampaignTx,
  campaignId: string,
  planRevisionNumber: number,
  sets: CampaignAngleSets,
  conditionIds: string[],
): Promise<number> {
  if (conditionIds.length === 0) return 0;
  const rows = (await asDb(tx).execute(sql`
    UPDATE sim_campaign_points p
    SET state = 'requested', plan_revision_number = ${planRevisionNumber}, "updatedAt" = now()
    FROM airfoils af
    WHERE p.campaign_id = ${campaignId}
      AND p.condition_id = ANY(${pgUuidArray(conditionIds)}::uuid[])
      AND p.state = 'released'
      AND af.id = p.airfoil_id
      AND (
        (NOT af.is_symmetric AND p.aoa_deg = ANY(${pgFloatArray(sets.angles)}::float8[]))
        OR (af.is_symmetric AND NOT p.derived_by_symmetry AND p.aoa_deg = ANY(${pgFloatArray(sets.symmetricSolverAngles)}::float8[]))
        OR (af.is_symmetric AND p.derived_by_symmetry AND p.aoa_deg = ANY(${pgFloatArray(sets.negativeAngles)}::float8[]))
      )
    RETURNING p.aoa_deg
  `)) as unknown as unknown[];
  return rows.length;
}

/** Link pre-solved evidence: solver cells first, then symmetric derived cells
 *  whose +α source is terminal (spec §5.3e / §9.2). */
async function linkPresolvedEvidence(tx: CampaignTx, campaignId: string): Promise<{ linkedSolver: number; linkedDerived: number }> {
  const solverRows = (await asDb(tx).execute(sql`
    UPDATE sim_campaign_points p
    SET state = 'terminal', result_id = r.id, "updatedAt" = now()
    FROM results r
    WHERE p.campaign_id = ${campaignId}
      AND p.state = 'requested'
      AND NOT p.derived_by_symmetry
      AND ${POINT_CELL_JOIN}
      AND r.status = 'done'
      AND r.source = 'solved'
    RETURNING p.aoa_deg
  `)) as unknown as unknown[];
  const derivedRows = (await asDb(tx).execute(sql`
    UPDATE sim_campaign_points p
    SET state = 'terminal', result_id = src.result_id, "updatedAt" = now()
    FROM sim_campaign_points src
    WHERE p.campaign_id = ${campaignId}
      AND p.derived_by_symmetry
      AND p.state = 'requested'
      AND src.campaign_id = p.campaign_id
      AND src.condition_id = p.condition_id
      AND src.airfoil_id = p.airfoil_id
      AND src.aoa_deg = -p.aoa_deg
      AND NOT src.derived_by_symmetry
      AND src.state = 'terminal'
      AND src.result_id IS NOT NULL
    RETURNING p.aoa_deg
  `)) as unknown as unknown[];
  return { linkedSolver: solverRows.length, linkedDerived: derivedRows.length };
}

/** §5.4 "mark reused points stale & re-solve": flip matching solved results to
 *  stale so the campaign branch treats them as gaps. */
async function markReusedResultsStale(tx: CampaignTx, campaignId: string): Promise<number> {
  const rows = (await asDb(tx).execute(sql`
    UPDATE results r
    SET status = 'stale'
    FROM sim_campaign_points p
    WHERE p.campaign_id = ${campaignId}
      AND NOT p.derived_by_symmetry
      AND p.state = 'requested'
      AND ${POINT_CELL_JOIN}
      AND r.status = 'done'
      AND r.source = 'solved'
    RETURNING r.id
  `)) as unknown as unknown[];
  return rows.length;
}

export interface CampaignProgressTotals {
  requested: number;
  solved: number;
  failed: number;
  running: number;
  superseded: number;
  derived: number;
  /** Terminal-done points whose classification is 'rejected' — settled but
   *  NOT solved (physics-invalid evidence, surfaced like failed). */
  rejected: number;
  remaining: number;
}

/** Whole-campaign recompute of sim_campaign_progress (spec §3.1: written at
 *  launch/plan-edit inside the same transaction; the sweeper increments and the
 *  reconciler heals afterwards).
 *
 *  Counter model is CANONICAL and single-sourced: the exact SELECT/joins live in
 *  recomputeProgressForCampaign (./campaign-execution.ts) — the same definitions
 *  the sweeper's incremental recomputeProgressForKeys uses, so both the launch/
 *  plan-edit path and the ingest path agree on what "solved/failed/running/
 *  superseded" mean:
 *   - requested: state <> 'released' (TOTAL obligation, the UI denominator)
 *   - solved:    state = 'terminal' AND NOT derived AND result.status = 'done'
 *                AND classification IS NOT 'rejected'
 *   - rejected:  state = 'terminal' AND NOT derived AND result.status = 'done'
 *                AND result_classifications.state = 'rejected'
 *   - failed:    state = 'terminal' AND result.status = 'failed'
 *   - running:   state = 'requested' AND live-cell result.status IN (queued, running)
 *   - superseded: result_classifications.state = 'superseded_by_urans'
 *   - derived:   state = 'terminal' AND derived
 *  (result joined ON r.id = p.result_id; live joined ON the cell key.)
 *
 *  This wrapper additionally DELETEs the campaign's progress rows first so that
 *  (condition, airfoil) keys whose points were removed by a plan edit lose their
 *  stale counter row — the transactional launch/plan-edit callers rely on this
 *  DELETE-then-recompute cleanup (the reconciler prunes vanished rows out of
 *  band; here we must prune synchronously). The delegate's INSERT...ON CONFLICT
 *  then repopulates every surviving key from scratch. */
export async function recomputeCampaignProgress(tx: CampaignTx, campaignId: string): Promise<void> {
  await asDb(tx).execute(sql`DELETE FROM sim_campaign_progress WHERE campaign_id = ${campaignId}`);
  await recomputeProgressForCampaign(asDb(tx), campaignId);
}

export async function campaignProgressTotals(db: DbTx, campaignId: string): Promise<CampaignProgressTotals> {
  const [row] = (await asDb(db).execute(sql`
    SELECT
      COALESCE(sum(requested), 0)::int AS requested,
      COALESCE(sum(solved), 0)::int AS solved,
      COALESCE(sum(failed), 0)::int AS failed,
      COALESCE(sum(running), 0)::int AS running,
      COALESCE(sum(superseded), 0)::int AS superseded,
      COALESCE(sum(derived), 0)::int AS derived,
      COALESCE(sum(rejected), 0)::int AS rejected
    FROM sim_campaign_progress
    WHERE campaign_id = ${campaignId}
  `)) as unknown as Array<Omit<CampaignProgressTotals, "remaining">>;
  const totals = row ?? { requested: 0, solved: 0, failed: 0, running: 0, superseded: 0, derived: 0, rejected: 0 };
  return {
    requested: Number(totals.requested),
    solved: Number(totals.solved),
    failed: Number(totals.failed),
    running: Number(totals.running),
    superseded: Number(totals.superseded),
    derived: Number(totals.derived),
    rejected: Number(totals.rejected),
    remaining: Math.max(
      0,
      Number(totals.requested) - Number(totals.solved) - Number(totals.derived) - Number(totals.failed) - Number(totals.rejected),
    ),
  };
}

/** Completion-state derivation (spec §6.4): every obligated cell settled and
 *  zero failed/rejected → completed; settled with failures OR physics-rejected
 *  points → attention (a rejected point is settled but NOT solved work); else
 *  active. */
export function deriveCampaignCompletion(totals: CampaignProgressTotals): "active" | "attention" | "completed" {
  if (totals.requested > 0 && totals.remaining <= 0) return totals.failed > 0 || totals.rejected > 0 ? "attention" : "completed";
  return "active";
}

/** Re-derive campaign status from counters. Only transitions between
 *  active/attention/completed; paused/cancelled/archived are verb-owned. */
export async function refreshCampaignCompletion(tx: CampaignTx, campaignId: string): Promise<CampaignProgressTotals> {
  const totals = await campaignProgressTotals(tx, campaignId);
  const [campaign] = await asDb(tx).select().from(simCampaigns).where(eq(simCampaigns.id, campaignId)).limit(1);
  if (!campaign) return totals;
  if (!["active", "attention", "completed"].includes(campaign.status)) return totals;
  const next = deriveCampaignCompletion(totals);
  if (next !== campaign.status || (next === "completed") !== Boolean(campaign.completedAt)) {
    await asDb(tx)
      .update(simCampaigns)
      .set({
        status: next,
        completedAt: next === "completed" ? campaign.completedAt ?? new Date() : null,
      })
      .where(eq(simCampaigns.id, campaignId));
  }
  return totals;
}

/** Create lanes for the enabled objectives (spec §5.3e / §8): one lane per
 *  (airfoil, condition, objective); symmetric airfoils' cl_zero lanes are
 *  `symmetric_definition` (α₀ = 0° by definition, no solve). */
async function ensureCampaignLanes(
  tx: CampaignTx,
  campaignId: string,
  plan: CampaignPlan,
  opts: { conditionIds?: string[]; airfoilIds?: string[] } = {},
): Promise<void> {
  const conditionFilter = opts.conditionIds ? sql`AND cc.id = ANY(${pgUuidArray(opts.conditionIds)}::uuid[])` : sql`AND cc.status = 'active'`;
  const airfoilFilter = opts.airfoilIds ? sql`AND ca.airfoil_id = ANY(${pgUuidArray(opts.airfoilIds)}::uuid[])` : sql``;
  for (const objective of CAMPAIGN_OBJECTIVES) {
    if (!plan.objectives[objective.id].enabled) continue;
    await asDb(tx).execute(sql`
      INSERT INTO sim_campaign_lanes (campaign_id, airfoil_id, condition_id, objective, state)
      SELECT cc.campaign_id, ca.airfoil_id, cc.id, ${objective.key},
        CASE WHEN ${objective.key} = 'cl_zero' AND af.is_symmetric THEN 'symmetric_definition' ELSE 'awaiting_seed' END
      FROM sim_campaign_conditions cc
      JOIN sim_campaign_airfoils ca ON ca.campaign_id = cc.campaign_id
      JOIN airfoils af ON af.id = ca.airfoil_id
      WHERE cc.campaign_id = ${campaignId}
        ${conditionFilter}
        ${airfoilFilter}
      ON CONFLICT (campaign_id, airfoil_id, condition_id, objective) DO NOTHING
    `);
  }
}

/** Delete campaign-claimed PENDING results rows of released cells; rows that
 *  attempts reference are marked stale instead (spec §6.4 cancel / §6.1).
 *  "Campaign-claimed" = pending, unowned by a submitted job (sim_job_id NULL
 *  or a job still composing), at a released campaign cell. Running rows are
 *  never touched. */
async function deleteReleasedPendingResults(tx: CampaignTx, campaignId: string): Promise<{ deleted: number; staled: number }> {
  const claimable = sql`
    p.campaign_id = ${campaignId}
    AND p.state = 'released'
    AND NOT p.derived_by_symmetry
    AND ${POINT_CELL_JOIN}
    AND (
      (r.status = 'pending' AND r.sim_job_id IS NULL)
      OR (r.status IN ('pending', 'queued') AND r.sim_job_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM sim_jobs j WHERE j.id = r.sim_job_id AND j.status = 'pending'
      ))
    )
  `;
  const staledRows = (await asDb(tx).execute(sql`
    UPDATE results r
    SET status = 'stale', sim_job_id = NULL
    FROM sim_campaign_points p
    WHERE ${claimable}
      AND EXISTS (SELECT 1 FROM result_attempts ra WHERE ra.result_id = r.id)
    RETURNING r.id
  `)) as unknown as unknown[];
  const deletedRows = (await asDb(tx).execute(sql`
    DELETE FROM results r
    USING sim_campaign_points p
    WHERE ${claimable}
      AND NOT EXISTS (SELECT 1 FROM result_attempts ra WHERE ra.result_id = r.id)
    RETURNING r.id
  `)) as unknown as unknown[];
  return { deleted: deletedRows.length, staled: staledRows.length };
}

// ---------------------------------------------------------------------------
// §5 — Launch
// ---------------------------------------------------------------------------
export interface CampaignLaunchInput {
  name: string;
  notes?: string | null;
  priority: number;
  idempotencyKey: string;
  airfoilIds: string[];
  plan: CampaignPlanInput;
  markStaleAndResolve?: boolean;
  createdBy?: string | null;
}

export interface CampaignLaunchResult {
  campaign: typeof simCampaigns.$inferSelect;
  replayed: boolean;
  totals: CampaignProgressTotals;
  conditionCount: number;
  presetsCreated: number;
  presetsReused: number;
  linkedSolver: number;
  linkedDerived: number;
  staleMarked: number;
}

interface ResolvedConditionSetup {
  combo: CampaignConditionCombo;
  flowConditionId: string;
  referenceGeometryProfileId: string;
  presetId: string;
  revisionId: string;
  reynolds: number;
  mach: number | null;
  presetCreated: boolean;
}

/** Resolve one condition combo to pinned registry rows + a physics revision.
 *  Shared by launch and plan-edit apply (spec §5.3b–c). */
async function resolveConditionSetups(
  tx: CampaignTx,
  args: {
    campaignId: string;
    campaignName: string;
    campaignSlug: string;
    plan: CampaignPlan;
    combos: CampaignConditionCombo[];
  },
): Promise<ResolvedConditionSetup[]> {
  const mediumState = await loadMediumState(tx, args.plan.mediumId);
  const numerics = await loadNumericsRows(tx, args.plan.numerics);
  const cache = new Map<string, ResolvedCampaignRevision>();
  let support: CampaignPresetSupport | null = null;
  const supportLoader = async () => {
    if (!support) support = await ensureCampaignPresetSupport(tx, args.campaignSlug, args.plan);
    return support;
  };
  const out: ResolvedConditionSetup[] = [];
  for (const combo of args.combos) {
    const flow = await findOrCreateFlowCondition(tx, args.campaignId, mediumState, combo);
    const geo = await findOrCreateReferenceGeometry(tx, args.campaignId, combo);
    const resolved = await resolveCampaignConditionRevision(tx, {
      campaignName: args.campaignName,
      campaignSlug: args.campaignSlug,
      plan: args.plan,
      combo,
      flow: flow.row,
      medium: mediumState.medium,
      geo: geo.row,
      numerics,
      support: supportLoader,
      cache,
    });
    out.push({
      combo,
      flowConditionId: flow.row.id,
      referenceGeometryProfileId: geo.row.id,
      presetId: resolved.presetId,
      revisionId: resolved.revisionId,
      reynolds: resolved.reynolds,
      mach: resolved.mach,
      presetCreated: resolved.presetCreated,
    });
  }
  return out;
}

async function validateCampaignAirfoils(db: DbTx, airfoilIds: string[]): Promise<Array<{ id: string; isSymmetric: boolean }>> {
  const unique = [...new Set(airfoilIds)];
  if (unique.length === 0) throw new CampaignError("validation", "at least one airfoil is required");
  const rows = await asDb(db)
    .select({ id: airfoils.id, isSymmetric: airfoils.isSymmetric })
    .from(airfoils)
    .where(and(inArray(airfoils.id, unique), sql`${airfoils.deletedAt} IS NULL`));
  if (rows.length !== unique.length) {
    throw new CampaignError("validation", `one or more airfoils are unavailable (${rows.length}/${unique.length} found)`);
  }
  return rows;
}

/** The §5 launch transaction. Idempotent by idempotencyKey (replay returns the
 *  existing campaign). */
export async function materializeCampaignLaunch(db: DB, input: CampaignLaunchInput): Promise<CampaignLaunchResult> {
  const plan = normalizeCampaignPlan(input.plan);
  if (!input.idempotencyKey || input.idempotencyKey.length < 8) {
    throw new CampaignError("validation", "idempotencyKey is required (min 8 chars)");
  }
  if (!(Number.isInteger(input.priority) && input.priority >= 0 && input.priority <= 9)) {
    throw new CampaignError("validation", "priority must be an integer 0..9");
  }
  if (!input.name?.trim()) throw new CampaignError("validation", "name is required");

  return db.transaction(async (tx) => {
    // Serialize launches: replay-safe idempotency, slug allocation, and
    // canonical-physics election all become race-free (launches are rare
    // admin operations; one lock is cheaper than per-row conflict recovery).
    await asDb(tx).execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('sim-campaign-launch', 0))`);

    const [existing] = await asDb(tx).select().from(simCampaigns).where(eq(simCampaigns.idempotencyKey, input.idempotencyKey)).limit(1);
    if (existing) {
      const totals = await campaignProgressTotals(tx, existing.id);
      const [conditionCount] = (await asDb(tx).execute(
        sql`SELECT count(*)::int AS n FROM sim_campaign_conditions WHERE campaign_id = ${existing.id}`,
      )) as unknown as Array<{ n: number }>;
      return {
        campaign: existing,
        replayed: true,
        totals,
        conditionCount: Number(conditionCount?.n ?? 0),
        presetsCreated: 0,
        presetsReused: 0,
        linkedSolver: 0,
        linkedDerived: 0,
        staleMarked: 0,
      };
    }

    const airfoilRows = await validateCampaignAirfoils(tx, input.airfoilIds);
    const combos = conditionCombosFromPlan(plan);
    const sets = campaignAngleSets(plan);
    // No point-count launch limit (user decision 2026-07-04): the arithmetic
    // feeds the audit summary only.
    const arithmetic = campaignPointArithmetic(
      sets,
      airfoilRows.filter((a) => !a.isSymmetric).length,
      airfoilRows.filter((a) => a.isSymmetric).length,
    );
    const totalPoints = arithmetic.points * combos.length;
    const slug = await uniqueSlug(tx, "sim_campaigns", slugifyCampaign(input.name));
    const [campaign] = await asDb(tx)
      .insert(simCampaigns)
      .values({
        slug,
        name: input.name.trim(),
        notes: input.notes ?? null,
        status: "active",
        priority: input.priority,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();

    const setups = await resolveConditionSetups(tx, {
      campaignId: campaign.id,
      campaignName: campaign.name,
      campaignSlug: campaign.slug,
      plan,
      combos,
    });

    // §3.3: legacy bcId bridge for every found-or-created preset BEFORE points.
    const presetIds = [...new Set(setups.map((s) => s.presetId))];
    for (const presetId of presetIds) {
      await syncLegacyBoundaryConditionForPreset(tx, presetId);
    }

    const [planRevision] = await asDb(tx)
      .insert(simCampaignPlanRevisions)
      .values({
        campaignId: campaign.id,
        revisionNumber: 1,
        kind: "initial",
        plan: plan as unknown as Record<string, unknown>,
        summary: {
          addedConditions: setups.length,
          keptConditions: 0,
          releasedConditions: 0,
          addedPoints: totalPoints,
          cancelledPoints: 0,
          valueDiffs: null,
          rateBaselineAt: new Date().toISOString(),
        },
        createdBy: input.createdBy ?? null,
      })
      .returning();
    await asDb(tx).update(simCampaigns).set({ currentPlanRevisionId: planRevision.id }).where(eq(simCampaigns.id, campaign.id));

    await asDb(tx).insert(simCampaignAirfoils).values(airfoilRows.map((a) => ({ campaignId: campaign.id, airfoilId: a.id }))).onConflictDoNothing();

    if (setups.length > 0) {
      await asDb(tx)
        .insert(simCampaignConditions)
        .values(
          setups.map((s) => ({
            campaignId: campaign.id,
            ord: s.combo.ord,
            flowConditionId: s.flowConditionId,
            referenceGeometryProfileId: s.referenceGeometryProfileId,
            presetId: s.presetId,
            simulationPresetRevisionId: s.revisionId,
            reynolds: s.reynolds,
            mach: s.mach,
            status: "active",
            introducedInPlanRevisionId: planRevision.id,
          })),
        );
    }

    await insertCampaignPoints(tx, campaign.id, 1, sets);

    let staleMarked = 0;
    let linkedSolver = 0;
    let linkedDerived = 0;
    if (input.markStaleAndResolve) {
      staleMarked = await markReusedResultsStale(tx, campaign.id);
    } else {
      const linked = await linkPresolvedEvidence(tx, campaign.id);
      linkedSolver = linked.linkedSolver;
      linkedDerived = linked.linkedDerived;
    }

    await recomputeCampaignProgress(tx, campaign.id);
    await ensureCampaignLanes(tx, campaign.id, plan);
    const totals = await refreshCampaignCompletion(tx, campaign.id);

    const [finalCampaign] = await asDb(tx).select().from(simCampaigns).where(eq(simCampaigns.id, campaign.id)).limit(1);
    return {
      campaign: finalCampaign,
      replayed: false,
      totals,
      conditionCount: setups.length,
      presetsCreated: setups.filter((s) => s.presetCreated).length,
      presetsReused: presetIds.length - new Set(setups.filter((s) => s.presetCreated).map((s) => s.presetId)).size,
      linkedSolver,
      linkedDerived,
      staleMarked,
    };
  });
}

// ---------------------------------------------------------------------------
// §5.4 — Read-only reuse preview
// ---------------------------------------------------------------------------
export interface CampaignReusePreviewInput {
  plan: CampaignPlanInput;
  airfoilIds: string[];
}

export interface CampaignReusePreviewCondition {
  comboKey: string;
  temperatureK: string;
  pressurePa: string;
  speedMps: string;
  chordM: string;
  revisionId: string | null;
  presetId: string | null;
  reynolds: number;
  solvedPoints: number;
}

export type CampaignReusePreview =
  | {
      status: "ok";
      totalPoints: number;
      totalSolverRuns: number;
      derivedPoints: number;
      reusedPoints: number;
      allSolved: boolean;
      conditions: CampaignReusePreviewCondition[];
    }
  | { status: "timeout" };

/** READ-ONLY §5.4 preview: in-memory physics hashes, canonical revision
 *  lookup, solved counts. Bounded by statement_timeout ≈ 5 s and degrades to
 *  {status:"timeout"} honestly. Never creates rows. */
export async function previewCampaignReuse(db: DB, input: CampaignReusePreviewInput): Promise<CampaignReusePreview> {
  const plan = normalizeCampaignPlan(input.plan);
  try {
    return await db.transaction(async (tx) => {
      await asDb(tx).execute(sql`SET LOCAL statement_timeout = 5000`);
      const airfoilRows = await validateCampaignAirfoils(tx, input.airfoilIds);
      const nSym = airfoilRows.filter((a) => a.isSymmetric).length;
      const nAsym = airfoilRows.length - nSym;
      const airfoilIds = airfoilRows.map((a) => a.id);
      const combos = conditionCombosFromPlan(plan);
      const sets = campaignAngleSets(plan);
      const perCondition = campaignPointArithmetic(sets, nAsym, nSym);

      const mediumState = await loadMediumState(tx, plan.mediumId);
      const numerics = await loadNumericsRows(tx, plan.numerics);

      const conditions: CampaignReusePreviewCondition[] = [];
      const combosByRevision = new Map<string, CampaignReusePreviewCondition[]>();
      for (const combo of combos) {
        const temperatureK = Number(combo.temperatureK);
        const pressurePa = Number(combo.pressurePa);
        const speedMps = Number(combo.speedMps);
        const chordM = Number(combo.chordM);
        const flowKey = flowConditionCanonicalKey({ mediumId: plan.mediumId, temperatureK, pressurePa, speedMps });
        const geoKey = referenceGeometryCanonicalKey({
          geometryType: "airfoil_2d",
          referenceLengthKind: "chord",
          referenceLengthM: chordM,
          spanM: Number(combo.spanM),
          referenceAreaM2: combo.areaM2 == null ? null : Number(combo.areaM2),
        });
        const [flowRow] = await asDb(tx).select().from(flowConditions).where(eq(flowConditions.canonicalKey, flowKey)).limit(1);
        const [geoRow] = await asDb(tx).select().from(referenceGeometryProfiles).where(eq(referenceGeometryProfiles.canonicalKey, geoKey)).limit(1);
        const derived = deriveFlowConditionState(mediumState.stateInput, { temperatureK, pressurePa, speedMps });
        const flow = flowRow ?? {
          ...({} as typeof flowConditions.$inferSelect),
          id: "",
          slug: "",
          name: "",
          mediumId: plan.mediumId,
          temperatureK,
          pressurePa,
          speedMps,
          density: derived.density,
          dynamicViscosity: derived.dynamicViscosity,
          kinematicViscosity: derived.kinematicViscosity,
          mach: derived.mach,
        };
        const geo = geoRow ?? {
          ...({} as typeof referenceGeometryProfiles.$inferSelect),
          id: "",
          slug: "",
          name: "",
          geometryType: "airfoil_2d",
          referenceLengthKind: "chord",
          referenceLengthM: chordM,
          spanM: Number(combo.spanM),
          referenceAreaM2: combo.areaM2 == null ? null : Number(combo.areaM2),
        };
        const { snapshot, reynolds } = buildPhysicsHashSnapshot({ flow, medium: mediumState.medium, geo, numerics });
        const hash = physicsHashForSnapshot(snapshot);
        const found = await lookupRevisionByPhysicsHash(tx, hash);
        const row: CampaignReusePreviewCondition = {
          comboKey: combo.comboKey,
          temperatureK: combo.temperatureK,
          pressurePa: combo.pressurePa,
          speedMps: combo.speedMps,
          chordM: combo.chordM,
          revisionId: found?.revision.id ?? null,
          presetId: found?.preset.id ?? null,
          reynolds: found?.revision.reynolds ?? reynolds,
          solvedPoints: 0,
        };
        conditions.push(row);
        if (row.revisionId) {
          const bucket = combosByRevision.get(row.revisionId) ?? [];
          bucket.push(row);
          combosByRevision.set(row.revisionId, bucket);
        }
      }

      let reusedPoints = 0;
      for (const [revisionId, rows] of combosByRevision) {
        const solvedRows = (await asDb(tx).execute(sql`
          SELECT r.airfoil_id, r.aoa_deg::float8 AS aoa
          FROM results r
          WHERE r.simulation_preset_revision_id = ${revisionId}
            AND r.airfoil_id = ANY(${pgUuidArray(airfoilIds)}::uuid[])
            AND r.aoa_deg = ANY(${pgFloatArray(sets.symmetricSolverAngles.concat(sets.angles))}::float8[])
            AND r.status = 'done'
            AND r.source = 'solved'
        `)) as unknown as Array<{ airfoil_id: string; aoa: number }>;
        const solvedByAirfoil = new Map<string, Set<number>>();
        for (const s of solvedRows) {
          const set = solvedByAirfoil.get(s.airfoil_id) ?? new Set<number>();
          set.add(canonicalAoa(s.aoa));
          solvedByAirfoil.set(s.airfoil_id, set);
        }
        let solvedForRevision = 0;
        for (const airfoil of airfoilRows) {
          const solved = solvedByAirfoil.get(airfoil.id);
          if (!solved) continue;
          if (airfoil.isSymmetric) {
            for (const a of sets.symmetricSolverAngles) if (solved.has(a)) solvedForRevision++;
            for (const a of sets.negativeAngles) if (solved.has(canonicalAoa(-a))) solvedForRevision++;
          } else {
            for (const a of sets.angles) if (solved.has(a)) solvedForRevision++;
          }
        }
        // The per-revision count applies to every combo pinned to it.
        for (const row of rows) row.solvedPoints = solvedForRevision;
        reusedPoints += solvedForRevision * rows.length;
      }

      const totalPoints = perCondition.points * combos.length;
      const totalSolverRuns = perCondition.solverRuns * combos.length;
      return {
        status: "ok" as const,
        totalPoints,
        totalSolverRuns,
        derivedPoints: perCondition.derivedPoints * combos.length,
        reusedPoints,
        allSolved: totalPoints > 0 && reusedPoints >= totalPoints,
        conditions,
      };
    });
  } catch (e) {
    if ((e as { code?: string }).code === "57014" || /statement timeout/i.test((e as Error).message ?? "")) {
      return { status: "timeout" };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// §6.3 — Closure classification + §6.1 preview/acknowledge plan editing
// ---------------------------------------------------------------------------
export interface PlanChangeObjectiveDelta {
  objective: CampaignObjectiveKey;
  changes: Array<"enabled" | "disabled" | "tolerance_tightened" | "tolerance_loosened" | "rounds_changed">;
  toleranceDeg: string;
}

export interface PlanChangeClassification {
  basePlanRevisionNumber: number;
  newPlan: CampaignPlan;
  diffHash: string;
  addedConditions: Array<{ comboKey: string; temperatureK: string; pressurePa: string; speedMps: string; chordM: string }>;
  reactivatedConditions: Array<{ conditionId: string; comboKey: string; previousStatus: string }>;
  keptConditions: Array<{ conditionId: string; comboKey: string; solvedAngles: number[]; releasedPoints: number; keptOpenPoints: number }>;
  releasedConditions: Array<{ conditionId: string; comboKey: string; releasedPoints: number }>;
  addedAngles: number[];
  removedAngles: number[];
  removedAngleKeptCells: number;
  removedAngleReleasedPoints: number;
  addedPoints: number;
  addedSolverRuns: number;
  reactivatedPoints: number;
  cancelledPoints: number;
  pendingResultDeletes: number;
  runningOnRemoved: number;
  objectiveDeltas: PlanChangeObjectiveDelta[];
  valueDiffs: Record<string, { added: string[]; removed: string[] }>;
  /** Apply-support payload (not part of the hash). */
  internal: {
    stayActiveConditionIds: string[];
    reactivatedConditionIds: string[];
    keptConditionIds: string[];
    releasedConditionIds: string[];
    releasedCellConditionIds: string[];
    releasedCellAoas: number[];
    releasedCellDerived: boolean[];
    newSets: CampaignAngleSets;
    deltaSets: CampaignAngleSets;
    addedCombos: CampaignConditionCombo[];
    maxOrd: number;
  };
}

interface RequestedCellGroup {
  condition_id: string;
  aoa: number;
  derived: boolean;
  n: number;
}

async function loadCampaignConditionCombos(db: DbTx, campaignId: string) {
  const rows = await asDb(db)
    .select({ cc: simCampaignConditions, flow: flowConditions, geo: referenceGeometryProfiles })
    .from(simCampaignConditions)
    .innerJoin(flowConditions, eq(flowConditions.id, simCampaignConditions.flowConditionId))
    .innerJoin(referenceGeometryProfiles, eq(referenceGeometryProfiles.id, simCampaignConditions.referenceGeometryProfileId))
    .where(eq(simCampaignConditions.campaignId, campaignId))
    .orderBy(asc(simCampaignConditions.ord));
  return rows.map((row) => ({
    condition: row.cc,
    comboKey: campaignComboKey(
      canonicalSiString("temperatureK", row.flow.temperatureK),
      canonicalSiString("pressurePa", row.flow.pressurePa),
      canonicalSiString("speedMps", row.flow.speedMps),
      canonicalSiString("chordM", row.geo.referenceLengthM),
    ),
  }));
}

async function loadCampaignWithCurrentPlan(db: DbTx, campaignId: string, opts: { forUpdate?: boolean } = {}) {
  const campaignQuery = asDb(db).select().from(simCampaigns).where(eq(simCampaigns.id, campaignId)).limit(1);
  const [campaign] = opts.forUpdate ? await campaignQuery.for("update") : await campaignQuery;
  if (!campaign) throw new CampaignError("not_found", "campaign not found");
  if (!campaign.currentPlanRevisionId) throw new CampaignError("invalid_state", "campaign has no plan revision");
  const [revision] = await asDb(db)
    .select()
    .from(simCampaignPlanRevisions)
    .where(eq(simCampaignPlanRevisions.id, campaign.currentPlanRevisionId))
    .limit(1);
  if (!revision) throw new CampaignError("invalid_state", "campaign plan revision is missing");
  return { campaign, revision, plan: revision.plan as unknown as CampaignPlan };
}

function axisDiff(oldValues: string[], newValues: string[]): { added: string[]; removed: string[] } {
  const oldSet = new Set(oldValues);
  const newSet = new Set(newValues);
  return {
    added: newValues.filter((v) => !oldSet.has(v)),
    removed: oldValues.filter((v) => !newSet.has(v)),
  };
}

/** §6.3 closure classification for an edited plan. Read-only; run again inside
 *  the acknowledge transaction (spec §6.1). */
export async function classifyPlanChange(
  db: DbTx,
  campaignId: string,
  newPlanInput: CampaignPlanInput,
): Promise<{ campaign: typeof simCampaigns.$inferSelect; currentPlan: CampaignPlan; currentRevisionNumber: number; classification: PlanChangeClassification }> {
  const { campaign, revision, plan: currentPlan } = await loadCampaignWithCurrentPlan(db, campaignId);
  const newPlan = normalizeCampaignPlan(newPlanInput);
  if (newPlan.mediumId !== currentPlan.mediumId) {
    throw new CampaignError("validation", "the medium is fixed once launched — duplicate this campaign to change it");
  }

  const condRows = await loadCampaignConditionCombos(db, campaignId);
  const byKey = new Map(condRows.map((r) => [r.comboKey, r]));
  const newCombos = conditionCombosFromPlan(newPlan);
  const newKeys = new Set(newCombos.map((c) => c.comboKey));

  const addedCombos = newCombos.filter((c) => !byKey.has(c.comboKey));
  const reactivated = condRows.filter((r) => r.condition.status !== "active" && newKeys.has(r.comboKey));
  const stayActive = condRows.filter((r) => r.condition.status === "active" && newKeys.has(r.comboKey));
  const removedActive = condRows.filter((r) => r.condition.status === "active" && !newKeys.has(r.comboKey));

  const oldSets = campaignAngleSets(currentPlan);
  const newSets = campaignAngleSets(newPlan);
  const oldAngleSet = new Set(oldSets.angles);
  const newAngleSet = new Set(newSets.angles);
  const addedAngles = newSets.angles.filter((a) => !oldAngleSet.has(a));
  const removedAngles = oldSets.angles.filter((a) => !newAngleSet.has(a));
  const deltaSets: CampaignAngleSets = {
    angles: addedAngles,
    negativeAngles: newSets.negativeAngles.filter((a) => !new Set(oldSets.negativeAngles).has(a)),
    symmetricSolverAngles: newSets.symmetricSolverAngles.filter((a) => !new Set(oldSets.symmetricSolverAngles).has(a)),
  };

  // Evidence per (condition, solver angle): a solved results row for ANY
  // campaign airfoil at the pinned revision (spec §6.3).
  const solvedRows = (await asDb(db).execute(sql`
    SELECT p.condition_id, p.aoa_deg::float8 AS aoa
    FROM sim_campaign_points p
    WHERE p.campaign_id = ${campaignId}
      AND NOT p.derived_by_symmetry
      AND p.state <> 'released'
      AND EXISTS (
        SELECT 1 FROM results r
        WHERE ${POINT_CELL_JOIN} AND r.status = 'done' AND r.source = 'solved'
      )
    GROUP BY p.condition_id, p.aoa_deg
  `)) as unknown as Array<{ condition_id: string; aoa: number }>;
  const solvedByCondition = new Map<string, Set<number>>();
  for (const row of solvedRows) {
    const set = solvedByCondition.get(row.condition_id) ?? new Set<number>();
    set.add(canonicalAoa(Number(row.aoa)));
    solvedByCondition.set(row.condition_id, set);
  }

  const requestedGroups = (await asDb(db).execute(sql`
    SELECT p.condition_id, p.aoa_deg::float8 AS aoa, p.derived_by_symmetry AS derived, count(*)::int AS n
    FROM sim_campaign_points p
    WHERE p.campaign_id = ${campaignId} AND p.state = 'requested'
    GROUP BY p.condition_id, p.aoa_deg, p.derived_by_symmetry
  `)) as unknown as RequestedCellGroup[];
  const requestedByCondition = new Map<string, RequestedCellGroup[]>();
  for (const g of requestedGroups) {
    const bucket = requestedByCondition.get(g.condition_id) ?? [];
    bucket.push({ ...g, aoa: canonicalAoa(Number(g.aoa)), n: Number(g.n) });
    requestedByCondition.set(g.condition_id, bucket);
  }
  const cellCovered = (solved: Set<number> | undefined, aoa: number, derived: boolean): boolean => {
    if (!solved) return false;
    return derived ? solved.has(canonicalAoa(-aoa)) : solved.has(aoa);
  };

  const keptConditions: PlanChangeClassification["keptConditions"] = [];
  const releasedConditions: PlanChangeClassification["releasedConditions"] = [];
  const releasedCellConditionIds: string[] = [];
  const releasedCellAoas: number[] = [];
  const releasedCellDerived: boolean[] = [];
  const pushReleasedCell = (conditionId: string, aoa: number, derived: boolean) => {
    releasedCellConditionIds.push(conditionId);
    releasedCellAoas.push(aoa);
    releasedCellDerived.push(derived);
  };

  for (const row of removedActive) {
    const solved = solvedByCondition.get(row.condition.id);
    const groups = requestedByCondition.get(row.condition.id) ?? [];
    if (!solved || solved.size === 0) {
      let releasedPoints = 0;
      for (const g of groups) {
        releasedPoints += g.n;
        pushReleasedCell(row.condition.id, g.aoa, g.derived);
      }
      releasedConditions.push({ conditionId: row.condition.id, comboKey: row.comboKey, releasedPoints });
    } else {
      let releasedPoints = 0;
      let keptOpenPoints = 0;
      for (const g of groups) {
        if (cellCovered(solved, g.aoa, g.derived)) {
          keptOpenPoints += g.n;
        } else {
          releasedPoints += g.n;
          pushReleasedCell(row.condition.id, g.aoa, g.derived);
        }
      }
      keptConditions.push({
        conditionId: row.condition.id,
        comboKey: row.comboKey,
        solvedAngles: [...solved].sort((a, b) => a - b),
        releasedPoints,
        keptOpenPoints,
      });
    }
  }

  // Removing angles: symmetric rule per (condition, angle) on conditions that
  // stay active — solved angles stay for all airfoils, unsolved are released.
  let removedAngleKeptCells = 0;
  let removedAngleReleasedPoints = 0;
  if (removedAngles.length > 0) {
    const removedSet = new Set(removedAngles);
    for (const row of stayActive) {
      const solved = solvedByCondition.get(row.condition.id);
      const groups = requestedByCondition.get(row.condition.id) ?? [];
      for (const g of groups) {
        if (!removedSet.has(g.aoa)) continue;
        if (cellCovered(solved, g.aoa, g.derived)) {
          removedAngleKeptCells++;
        } else {
          removedAngleReleasedPoints += g.n;
          pushReleasedCell(row.condition.id, g.aoa, g.derived);
        }
      }
    }
  }

  // Added work: airfoil class counts drive exact obligation arithmetic.
  const airfoilRows = await asDb(db)
    .select({ id: airfoils.id, isSymmetric: airfoils.isSymmetric })
    .from(simCampaignAirfoils)
    .innerJoin(airfoils, eq(airfoils.id, simCampaignAirfoils.airfoilId))
    .where(eq(simCampaignAirfoils.campaignId, campaignId));
  const nSym = airfoilRows.filter((a) => a.isSymmetric).length;
  const nAsym = airfoilRows.length - nSym;
  const fullPerCondition = campaignPointArithmetic(newSets, nAsym, nSym);
  const deltaPerCondition = campaignPointArithmetic(deltaSets, nAsym, nSym);

  let addedPoints = fullPerCondition.points * addedCombos.length;
  let addedSolverRuns = fullPerCondition.solverRuns * addedCombos.length;
  let reactivatedPoints = 0;

  // Reactivated conditions: full new grid minus rows still obligated.
  const reactivatedIds = reactivated.map((r) => r.condition.id);
  if (reactivatedIds.length > 0) {
    const existingRows = (await asDb(db).execute(sql`
      SELECT condition_id, state, count(*)::int AS n
      FROM sim_campaign_points
      WHERE campaign_id = ${campaignId} AND condition_id = ANY(${pgUuidArray(reactivatedIds)}::uuid[])
      GROUP BY condition_id, state
    `)) as unknown as Array<{ condition_id: string; state: string; n: number }>;
    const nonReleasedByCondition = new Map<string, number>();
    const releasedByCondition = new Map<string, number>();
    for (const row of existingRows) {
      if (row.state === "released") releasedByCondition.set(row.condition_id, Number(row.n));
      else nonReleasedByCondition.set(row.condition_id, (nonReleasedByCondition.get(row.condition_id) ?? 0) + Number(row.n));
    }
    for (const id of reactivatedIds) {
      const target = fullPerCondition.points;
      const nonReleased = nonReleasedByCondition.get(id) ?? 0;
      const released = releasedByCondition.get(id) ?? 0;
      reactivatedPoints += Math.min(released, Math.max(0, target - nonReleased));
      addedPoints += Math.max(0, target - nonReleased - released);
      addedSolverRuns += Math.max(0, fullPerCondition.solverRuns - nonReleased);
    }
  }

  // Angle additions on conditions that stay active (kept conditions are never
  // extended, spec §6.3).
  const stayActiveIds = stayActive.map((r) => r.condition.id);
  if (deltaPerCondition.points > 0 && stayActiveIds.length > 0) {
    addedPoints += deltaPerCondition.points * stayActiveIds.length;
    addedSolverRuns += deltaPerCondition.solverRuns * stayActiveIds.length;
    const allAdded = [...new Set([...deltaSets.angles, ...deltaSets.symmetricSolverAngles, ...deltaSets.negativeAngles])];
    const existingAtAdded = (await asDb(db).execute(sql`
      SELECT state, count(*)::int AS n
      FROM sim_campaign_points
      WHERE campaign_id = ${campaignId}
        AND condition_id = ANY(${pgUuidArray(stayActiveIds)}::uuid[])
        AND aoa_deg = ANY(${pgFloatArray(allAdded)}::float8[])
      GROUP BY state
    `)) as unknown as Array<{ state: string; n: number }>;
    for (const row of existingAtAdded) {
      if (row.state === "released") {
        reactivatedPoints += Number(row.n);
        addedPoints -= Number(row.n);
      } else {
        addedPoints -= Number(row.n);
      }
    }
    addedPoints = Math.max(0, addedPoints);
  }

  // Real counts for the acknowledge dialog: pending deletions + running work
  // on the exact released cell set.
  let pendingResultDeletes = 0;
  let runningOnRemoved = 0;
  if (releasedCellAoas.length > 0) {
    const [pendingRow] = (await asDb(db).execute(sql`
      SELECT count(*)::int AS n
      FROM results r
      JOIN sim_campaign_points p ON ${POINT_CELL_JOIN}
      JOIN unnest(${pgUuidArray(releasedCellConditionIds)}::uuid[], ${pgFloatArray(releasedCellAoas)}::float8[], ${pgBoolArray(releasedCellDerived)}::boolean[]) AS cell(cid, aoa, derived)
        ON cell.cid = p.condition_id AND cell.aoa = p.aoa_deg AND cell.derived = p.derived_by_symmetry
      WHERE p.campaign_id = ${campaignId}
        AND NOT p.derived_by_symmetry
        AND r.status = 'pending'
        AND r.sim_job_id IS NULL
    `)) as unknown as Array<{ n: number }>;
    pendingResultDeletes = Number(pendingRow?.n ?? 0);
    const [runningRow] = (await asDb(db).execute(sql`
      SELECT count(*)::int AS n
      FROM results r
      JOIN sim_campaign_points p ON ${POINT_CELL_JOIN}
      JOIN unnest(${pgUuidArray(releasedCellConditionIds)}::uuid[], ${pgFloatArray(releasedCellAoas)}::float8[], ${pgBoolArray(releasedCellDerived)}::boolean[]) AS cell(cid, aoa, derived)
        ON cell.cid = p.condition_id AND cell.aoa = p.aoa_deg AND cell.derived = p.derived_by_symmetry
      WHERE p.campaign_id = ${campaignId}
        AND NOT p.derived_by_symmetry
        AND r.status IN ('queued', 'running')
    `)) as unknown as Array<{ n: number }>;
    runningOnRemoved = Number(runningRow?.n ?? 0);
  }

  const objectiveDeltas: PlanChangeObjectiveDelta[] = [];
  for (const objective of CAMPAIGN_OBJECTIVES) {
    const oldObj = currentPlan.objectives[objective.id];
    const newObj = newPlan.objectives[objective.id];
    const changes: PlanChangeObjectiveDelta["changes"] = [];
    if (!oldObj.enabled && newObj.enabled) changes.push("enabled");
    if (oldObj.enabled && !newObj.enabled) changes.push("disabled");
    if (Number(newObj.toleranceDeg) < Number(oldObj.toleranceDeg)) changes.push("tolerance_tightened");
    if (Number(newObj.toleranceDeg) > Number(oldObj.toleranceDeg)) changes.push("tolerance_loosened");
    if (newObj.maxRounds !== oldObj.maxRounds) changes.push("rounds_changed");
    if (changes.length > 0) objectiveDeltas.push({ objective: objective.key, changes, toleranceDeg: newObj.toleranceDeg });
  }

  const valueDiffs = {
    ambients: axisDiff(currentPlan.ambients.map((a) => a.join("|")), newPlan.ambients.map((a) => a.join("|"))),
    speedsMps: axisDiff(currentPlan.speedsMps, newPlan.speedsMps),
    chordsM: axisDiff(currentPlan.chordsM, newPlan.chordsM),
    excludedConditions: axisDiff(
      currentPlan.excludedConditions.map((x) => x.join("|")),
      newPlan.excludedConditions.map((x) => x.join("|")),
    ),
  };

  const cancelledPoints =
    releasedConditions.reduce((sum, c) => sum + c.releasedPoints, 0) +
    keptConditions.reduce((sum, c) => sum + c.releasedPoints, 0) +
    removedAngleReleasedPoints;

  const hashPayload = {
    basePlanRevisionNumber: revision.revisionNumber,
    plan: newPlan,
    addedConditions: addedCombos.map((c) => c.comboKey),
    reactivated: reactivated.map((r) => r.comboKey).sort(),
    kept: keptConditions.map((c) => ({ key: c.comboKey, solvedAngles: c.solvedAngles, releasedPoints: c.releasedPoints })),
    released: releasedConditions.map((c) => ({ key: c.comboKey, releasedPoints: c.releasedPoints })),
    addedAngles,
    removedAngles,
    removedAngleKeptCells,
    removedAngleReleasedPoints,
    addedPoints,
    reactivatedPoints,
    cancelledPoints,
    pendingResultDeletes,
    objectiveDeltas,
  };

  const classification: PlanChangeClassification = {
    basePlanRevisionNumber: revision.revisionNumber,
    newPlan,
    diffHash: campaignDiffHash(hashPayload),
    addedConditions: addedCombos.map((c) => ({
      comboKey: c.comboKey,
      temperatureK: c.temperatureK,
      pressurePa: c.pressurePa,
      speedMps: c.speedMps,
      chordM: c.chordM,
    })),
    reactivatedConditions: reactivated.map((r) => ({ conditionId: r.condition.id, comboKey: r.comboKey, previousStatus: r.condition.status })),
    keptConditions,
    releasedConditions,
    addedAngles,
    removedAngles,
    removedAngleKeptCells,
    removedAngleReleasedPoints,
    addedPoints,
    addedSolverRuns,
    reactivatedPoints,
    cancelledPoints,
    pendingResultDeletes,
    runningOnRemoved,
    objectiveDeltas,
    valueDiffs,
    internal: {
      stayActiveConditionIds: stayActiveIds,
      reactivatedConditionIds: reactivatedIds,
      keptConditionIds: keptConditions.map((c) => c.conditionId),
      releasedConditionIds: releasedConditions.map((c) => c.conditionId),
      releasedCellConditionIds,
      releasedCellAoas,
      releasedCellDerived,
      newSets,
      deltaSets,
      addedCombos,
      maxOrd: condRows.reduce((max, r) => Math.max(max, r.condition.ord), -1),
    },
  };
  return { campaign, currentPlan, currentRevisionNumber: revision.revisionNumber, classification };
}

export type PlanEditResult =
  | { status: "conflict"; currentPlanRevisionNumber: number }
  | { status: "stale_diff"; diff: PlanChangeClassification }
  | {
      status: "applied";
      planRevisionNumber: number;
      addedPoints: number;
      reactivatedPoints: number;
      cancelledPoints: number;
      pendingResultDeletes: number;
      totals: CampaignProgressTotals;
    };

async function applyPlanEditCore(
  tx: CampaignTx,
  campaign: typeof simCampaigns.$inferSelect,
  currentRevisionNumber: number,
  cls: PlanChangeClassification,
  kind: "edit" | "force_release",
  createdBy: string | null | undefined,
  extraSummary: Record<string, unknown> = {},
): Promise<Extract<PlanEditResult, { status: "applied" }>> {
  const nextRevisionNumber = currentRevisionNumber + 1;
  const [planRevision] = await asDb(tx)
    .insert(simCampaignPlanRevisions)
    .values({
      campaignId: campaign.id,
      revisionNumber: nextRevisionNumber,
      kind,
      plan: cls.newPlan as unknown as Record<string, unknown>,
      summary: {
        addedConditions: cls.addedConditions.length + cls.reactivatedConditions.length,
        keptConditions: cls.keptConditions.length,
        releasedConditions: cls.releasedConditions.length,
        addedPoints: cls.addedPoints,
        cancelledPoints: cls.cancelledPoints,
        valueDiffs: cls.valueDiffs,
        objectiveDeltas: cls.objectiveDeltas,
        // Rate-projection baseline marker (no schema change in this phase):
        // consumers read the latest plan revision createdAt / this field.
        rateBaselineAt: new Date().toISOString(),
        ...extraSummary,
      },
      createdBy: createdBy ?? null,
    })
    .returning();
  await asDb(tx).update(simCampaigns).set({ currentPlanRevisionId: planRevision.id }).where(eq(simCampaigns.id, campaign.id));

  // New conditions (value-level find-or-create + physics pinning, §5 machinery).
  if (cls.internal.addedCombos.length > 0) {
    const combos = cls.internal.addedCombos.map((combo, i) => ({ ...combo, ord: cls.internal.maxOrd + 1 + i }));
    const setups = await resolveConditionSetups(tx, {
      campaignId: campaign.id,
      campaignName: campaign.name,
      campaignSlug: campaign.slug,
      plan: cls.newPlan,
      combos,
    });
    const presetIds = [...new Set(setups.map((s) => s.presetId))];
    for (const presetId of presetIds) await syncLegacyBoundaryConditionForPreset(tx, presetId);
    await asDb(tx)
      .insert(simCampaignConditions)
      .values(
        setups.map((s) => ({
          campaignId: campaign.id,
          ord: s.combo.ord,
          flowConditionId: s.flowConditionId,
          referenceGeometryProfileId: s.referenceGeometryProfileId,
          presetId: s.presetId,
          simulationPresetRevisionId: s.revisionId,
          reynolds: s.reynolds,
          mach: s.mach,
          status: "active",
          introducedInPlanRevisionId: planRevision.id,
        })),
      )
      .onConflictDoNothing();
  }

  // Re-adds re-activate original condition rows (same pinned revision).
  if (cls.internal.reactivatedConditionIds.length > 0) {
    await asDb(tx)
      .update(simCampaignConditions)
      .set({ status: "active", statusChangedInPlanRevisionId: planRevision.id })
      .where(inArray(simCampaignConditions.id, cls.internal.reactivatedConditionIds));
  }
  if (cls.internal.keptConditionIds.length > 0) {
    await asDb(tx)
      .update(simCampaignConditions)
      .set({ status: "kept", statusChangedInPlanRevisionId: planRevision.id })
      .where(inArray(simCampaignConditions.id, cls.internal.keptConditionIds));
  }
  if (cls.internal.releasedConditionIds.length > 0) {
    await asDb(tx)
      .update(simCampaignConditions)
      .set({ status: "released", statusChangedInPlanRevisionId: planRevision.id })
      .where(inArray(simCampaignConditions.id, cls.internal.releasedConditionIds));
  }

  // Release the classified cells, then drop campaign-claimed pending rows of
  // released work (running rows untouched, spec §6.1).
  if (cls.internal.releasedCellAoas.length > 0) {
    await asDb(tx).execute(sql`
      UPDATE sim_campaign_points p
      SET state = 'released', "updatedAt" = now()
      FROM unnest(${pgUuidArray(cls.internal.releasedCellConditionIds)}::uuid[], ${pgFloatArray(cls.internal.releasedCellAoas)}::float8[], ${pgBoolArray(cls.internal.releasedCellDerived)}::boolean[]) AS cell(cid, aoa, derived)
      WHERE p.campaign_id = ${campaign.id}
        AND p.condition_id = cell.cid
        AND p.aoa_deg = cell.aoa
        AND p.derived_by_symmetry = cell.derived
        AND p.state = 'requested'
    `);
    await deleteReleasedPendingResults(tx, campaign.id);
  }

  // Upserts for added work: full grid on new + reactivated conditions, the
  // added-angle delta on conditions that stayed active; re-adds re-activate
  // previously released rows first (evidence continuity).
  const fullTargets = [...new Set([...cls.internal.reactivatedConditionIds])];
  const newConditionIds =
    cls.internal.addedCombos.length > 0
      ? ((await asDb(tx)
          .select({ id: simCampaignConditions.id })
          .from(simCampaignConditions)
          .where(and(eq(simCampaignConditions.campaignId, campaign.id), eq(simCampaignConditions.introducedInPlanRevisionId, planRevision.id)))) as Array<{ id: string }>)
          .map((r) => r.id)
      : [];
  await reactivateReleasedPoints(tx, campaign.id, nextRevisionNumber, cls.internal.newSets, [
    ...fullTargets,
    ...cls.internal.stayActiveConditionIds,
  ]);
  if (fullTargets.length + newConditionIds.length > 0) {
    await insertCampaignPoints(tx, campaign.id, nextRevisionNumber, cls.internal.newSets, {
      conditionIds: [...fullTargets, ...newConditionIds],
    });
  }
  if (cls.internal.stayActiveConditionIds.length > 0 && cls.internal.deltaSets.angles.length + cls.internal.deltaSets.symmetricSolverAngles.length > 0) {
    await insertCampaignPoints(tx, campaign.id, nextRevisionNumber, cls.internal.deltaSets, {
      conditionIds: cls.internal.stayActiveConditionIds,
    });
  }
  await linkPresolvedEvidence(tx, campaign.id);

  // Lane updates for objective toggles / tolerance edits (spec §6.1/§8.7).
  await ensureCampaignLanes(tx, campaign.id, cls.newPlan);
  for (const delta of cls.objectiveDeltas) {
    if (!delta.changes.includes("tolerance_tightened")) continue;
    const tolerance = Number(delta.toleranceDeg);
    await asDb(tx).execute(sql`
      UPDATE sim_campaign_lanes l
      SET state = 'iterating', "updatedAt" = now()
      FROM sim_campaign_conditions cc
      WHERE l.campaign_id = ${campaign.id}
        AND l.objective = ${delta.objective}
        AND cc.id = l.condition_id
        AND l.state IN ('converged_provisional', 'converged_final', 'converged_window', 'converged_stale')
        AND l.current_target_alpha IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM result_classifications c
          WHERE c.airfoil_id = l.airfoil_id
            AND c.simulation_preset_revision_id = cc.simulation_preset_revision_id
            AND c.state = 'accepted'
            AND abs(c.aoa_deg - l.current_target_alpha) <= ${tolerance}
        )
    `);
  }

  await recomputeCampaignProgress(tx, campaign.id);
  const totals = await refreshCampaignCompletion(tx, campaign.id);
  return {
    status: "applied",
    planRevisionNumber: nextRevisionNumber,
    addedPoints: cls.addedPoints,
    reactivatedPoints: cls.reactivatedPoints,
    cancelledPoints: cls.cancelledPoints,
    pendingResultDeletes: cls.pendingResultDeletes,
    totals,
  };
}

/** §6.1 acknowledge: SELECT FOR UPDATE, 409 on revision advance, re-classify,
 *  rollback with the refreshed diff on material drift, else apply atomically. */
export async function applyPlanEdit(
  db: DB,
  args: { campaignId: string; basePlanRevisionNumber: number; diffHash: string; newPlan: CampaignPlanInput; createdBy?: string | null },
): Promise<PlanEditResult> {
  return db.transaction(async (tx) => {
    const { campaign, revision } = await loadCampaignWithCurrentPlan(tx, args.campaignId, { forUpdate: true });
    if (!["active", "paused", "attention", "completed"].includes(campaign.status)) {
      throw new CampaignError("invalid_state", `campaign is ${campaign.status} — plan edits are not allowed`);
    }
    if (revision.revisionNumber !== args.basePlanRevisionNumber) {
      return { status: "conflict" as const, currentPlanRevisionNumber: revision.revisionNumber };
    }
    const { classification } = await classifyPlanChange(tx, args.campaignId, args.newPlan);
    if (classification.diffHash !== args.diffHash) {
      return { status: "stale_diff" as const, diff: classification };
    }
    return applyPlanEditCore(tx, campaign, revision.revisionNumber, classification, "edit", args.createdBy);
  });
}

// ---------------------------------------------------------------------------
// §6.2 — Add airfoils (preview + apply, same exactly-once protocol)
// ---------------------------------------------------------------------------
export interface AddAirfoilsPreview {
  diffHash: string;
  newAirfoilIds: string[];
  alreadyIncluded: string[];
  addedPoints: number;
  addedSolverRuns: number;
  perCondition: Array<{ conditionId: string; status: string; cellCount: number }>;
}

export type AddAirfoilsResult =
  | { status: "applied"; addedAirfoils: number; addedPoints: number; totals: CampaignProgressTotals }
  | { status: "stale_diff"; preview: AddAirfoilsPreview };

async function buildAddAirfoilsPreview(db: DbTx, campaignId: string, airfoilIds: string[]): Promise<AddAirfoilsPreview> {
  await loadCampaignWithCurrentPlan(db, campaignId);
  const candidates = await validateCampaignAirfoils(db, airfoilIds);
  const existing = await asDb(db)
    .select({ airfoilId: simCampaignAirfoils.airfoilId })
    .from(simCampaignAirfoils)
    .where(eq(simCampaignAirfoils.campaignId, campaignId));
  const existingSet = new Set(existing.map((r) => r.airfoilId));
  const newAirfoils = candidates.filter((a) => !existingSet.has(a.id));
  const alreadyIncluded = candidates.filter((a) => existingSet.has(a.id)).map((a) => a.id);

  // Inherited work = the campaign's obligated cell set: active conditions'
  // full requested cells AND kept conditions' remaining (solved-angle) cells.
  const cellRows = (await asDb(db).execute(sql`
    SELECT p.condition_id, cc.status, p.aoa_deg::float8 AS aoa
    FROM sim_campaign_points p
    JOIN sim_campaign_conditions cc ON cc.id = p.condition_id
    WHERE p.campaign_id = ${campaignId} AND p.state <> 'released' AND cc.status IN ('active', 'kept')
    GROUP BY p.condition_id, cc.status, p.aoa_deg
  `)) as unknown as Array<{ condition_id: string; status: string; aoa: number }>;
  const cellsByCondition = new Map<string, { status: string; angles: number[] }>();
  for (const row of cellRows) {
    const bucket = cellsByCondition.get(row.condition_id) ?? { status: row.status, angles: [] };
    bucket.angles.push(canonicalAoa(Number(row.aoa)));
    cellsByCondition.set(row.condition_id, bucket);
  }

  const nSym = newAirfoils.filter((a) => a.isSymmetric).length;
  const nAsym = newAirfoils.length - nSym;
  let addedPoints = 0;
  let addedSolverRuns = 0;
  const perCondition: AddAirfoilsPreview["perCondition"] = [];
  for (const [conditionId, bucket] of cellsByCondition) {
    const sets = angleSetsFromAngles(bucket.angles);
    const arithmetic = campaignPointArithmetic(sets, nAsym, nSym);
    addedPoints += arithmetic.points;
    addedSolverRuns += arithmetic.solverRuns;
    perCondition.push({ conditionId, status: bucket.status, cellCount: bucket.angles.length });
  }
  perCondition.sort((a, b) => a.conditionId.localeCompare(b.conditionId));

  const diffHash = campaignDiffHash({
    campaignId,
    airfoilIds: newAirfoils.map((a) => a.id).sort(),
    perCondition,
    addedPoints,
  });
  return {
    diffHash,
    newAirfoilIds: newAirfoils.map((a) => a.id),
    alreadyIncluded,
    addedPoints,
    addedSolverRuns,
    perCondition,
  };
}

export async function previewAddCampaignAirfoils(db: DB, campaignId: string, airfoilIds: string[]): Promise<AddAirfoilsPreview> {
  return buildAddAirfoilsPreview(db, campaignId, airfoilIds);
}

/** Junction inserts + points for active AND kept work (kept = only its
 *  remaining solved-angle set) + counters + reopen completed → active. */
export async function addCampaignAirfoils(db: DB, campaignId: string, airfoilIds: string[], diffHash: string): Promise<AddAirfoilsResult> {
  return db.transaction(async (tx) => {
    const { campaign, revision, plan } = await loadCampaignWithCurrentPlan(tx, campaignId, { forUpdate: true });
    if (!["active", "paused", "attention", "completed"].includes(campaign.status)) {
      throw new CampaignError("invalid_state", `campaign is ${campaign.status} — airfoils cannot be added`);
    }
    const preview = await buildAddAirfoilsPreview(tx, campaignId, airfoilIds);
    if (preview.diffHash !== diffHash) return { status: "stale_diff" as const, preview };
    if (preview.newAirfoilIds.length === 0) {
      const totals = await campaignProgressTotals(tx, campaignId);
      return { status: "applied" as const, addedAirfoils: 0, addedPoints: 0, totals };
    }

    await asDb(tx)
      .insert(simCampaignAirfoils)
      .values(preview.newAirfoilIds.map((airfoilId) => ({ campaignId, airfoilId })))
      .onConflictDoNothing();

    // Inherit the campaign's obligated cells; symmetric airfoils get solver
    // cells at |α| plus derived rows for the negative side (spec §9.2).
    const newIds = preview.newAirfoilIds;
    await asDb(tx).execute(sql`
      INSERT INTO sim_campaign_points
        (campaign_id, condition_id, airfoil_id, aoa_deg, revision_id, plan_revision_number, state, derived_by_symmetry)
      SELECT DISTINCT p.campaign_id, p.condition_id, af.id, p.aoa_deg, p.revision_id, ${revision.revisionNumber},
        'requested', (af.is_symmetric AND p.aoa_deg < 0)
      FROM sim_campaign_points p
      JOIN sim_campaign_conditions cc ON cc.id = p.condition_id AND cc.status IN ('active', 'kept')
      CROSS JOIN airfoils af
      WHERE p.campaign_id = ${campaignId}
        AND p.state <> 'released'
        AND af.id = ANY(${pgUuidArray(newIds)}::uuid[])
      ON CONFLICT (campaign_id, condition_id, airfoil_id, aoa_deg) DO NOTHING
    `);
    await asDb(tx).execute(sql`
      INSERT INTO sim_campaign_points
        (campaign_id, condition_id, airfoil_id, aoa_deg, revision_id, plan_revision_number, state, derived_by_symmetry)
      SELECT DISTINCT p.campaign_id, p.condition_id, af.id, abs(p.aoa_deg), p.revision_id, ${revision.revisionNumber}, 'requested', false
      FROM sim_campaign_points p
      JOIN sim_campaign_conditions cc ON cc.id = p.condition_id AND cc.status IN ('active', 'kept')
      CROSS JOIN airfoils af
      WHERE p.campaign_id = ${campaignId}
        AND p.state <> 'released'
        AND p.aoa_deg < 0
        AND af.id = ANY(${pgUuidArray(newIds)}::uuid[])
        AND af.is_symmetric
      ON CONFLICT (campaign_id, condition_id, airfoil_id, aoa_deg) DO NOTHING
    `);

    await linkPresolvedEvidence(tx, campaignId);
    await ensureCampaignLanes(tx, campaignId, plan, { airfoilIds: newIds });
    await recomputeCampaignProgress(tx, campaignId);
    // Growth on a completed campaign reopens it (spec §6.2).
    const totals = await refreshCampaignCompletion(tx, campaignId);
    return { status: "applied" as const, addedAirfoils: newIds.length, addedPoints: preview.addedPoints, totals };
  });
}

// ---------------------------------------------------------------------------
// §6.4 — Lifecycle verbs
// ---------------------------------------------------------------------------
async function requireCampaign(db: DbTx, campaignId: string) {
  const [campaign] = await asDb(db).select().from(simCampaigns).where(eq(simCampaigns.id, campaignId)).limit(1);
  if (!campaign) throw new CampaignError("not_found", "campaign not found");
  return campaign;
}

export async function pauseCampaign(db: DB, campaignId: string) {
  return db.transaction(async (tx) => {
    const campaign = await requireCampaign(tx, campaignId);
    if (!["active", "attention"].includes(campaign.status)) {
      throw new CampaignError("invalid_state", `only active/attention campaigns can be paused (status: ${campaign.status})`);
    }
    const [row] = await asDb(tx).update(simCampaigns).set({ status: "paused" }).where(eq(simCampaigns.id, campaignId)).returning();
    const [running] = (await asDb(tx).execute(sql`
      SELECT count(*)::int AS n FROM sim_jobs WHERE campaign_id = ${campaignId} AND status IN ('submitted', 'running', 'ingesting')
    `)) as unknown as Array<{ n: number }>;
    return { campaign: row, runningJobs: Number(running?.n ?? 0) };
  });
}

export async function resumeCampaign(db: DB, campaignId: string) {
  return db.transaction(async (tx) => {
    const campaign = await requireCampaign(tx, campaignId);
    if (campaign.status !== "paused") {
      throw new CampaignError("invalid_state", `only paused campaigns can be resumed (status: ${campaign.status})`);
    }
    await asDb(tx).update(simCampaigns).set({ status: "active" }).where(eq(simCampaigns.id, campaignId));
    await refreshCampaignCompletion(tx, campaignId);
    return requireCampaign(tx, campaignId);
  });
}

/** CANCEL (terminal): in-flight jobs finish and ingest; campaign-claimed
 *  pending/queued-unsubmitted results rows are deleted (or staled when
 *  attempts reference them); all evidence retained; orphaned origin='campaign'
 *  presets with zero references are GC'd. */
export async function cancelCampaign(db: DB, campaignId: string) {
  return db.transaction(async (tx) => {
    const campaign = await requireCampaign(tx, campaignId);
    if (!["active", "paused", "attention"].includes(campaign.status)) {
      throw new CampaignError("invalid_state", `campaign is already ${campaign.status}`);
    }
    // Release all open work first, then reuse the shared claimed-row cleanup.
    const releasedRows = (await asDb(tx).execute(sql`
      UPDATE sim_campaign_points SET state = 'released', "updatedAt" = now()
      WHERE campaign_id = ${campaignId} AND state = 'requested'
      RETURNING aoa_deg
    `)) as unknown as unknown[];
    const cleanup = await deleteReleasedPendingResults(tx, campaignId);
    const [running] = (await asDb(tx).execute(sql`
      SELECT count(*)::int AS n FROM sim_jobs WHERE campaign_id = ${campaignId} AND status IN ('submitted', 'running', 'ingesting')
    `)) as unknown as Array<{ n: number }>;
    await asDb(tx).update(simCampaigns).set({ status: "cancelled", completedAt: null }).where(eq(simCampaigns.id, campaignId));
    await recomputeCampaignProgress(tx, campaignId);
    const gcCount = await gcOrphanedCampaignPresets(tx);
    return {
      campaign: await requireCampaign(tx, campaignId),
      releasedPoints: releasedRows.length,
      deletedPendingResults: cleanup.deleted,
      staledPendingResults: cleanup.staled,
      runningJobsFinishing: Number(running?.n ?? 0),
      gcedPresets: gcCount,
    };
  });
}

/** GC origin='campaign' presets with zero results and zero condition/job/sync
 *  references across all their revisions (spec §6.4). FK-safe by construction:
 *  the NOT EXISTS guards mirror every non-cascading reference. */
async function gcOrphanedCampaignPresets(tx: CampaignTx): Promise<number> {
  const rows = (await asDb(tx).execute(sql`
    DELETE FROM simulation_presets sp
    WHERE sp.origin = 'campaign'
      AND NOT EXISTS (SELECT 1 FROM sim_campaign_conditions cc WHERE cc.preset_id = sp.id)
      AND NOT EXISTS (
        SELECT 1 FROM simulation_preset_revisions rev
        WHERE rev.preset_id = sp.id AND (
          EXISTS (SELECT 1 FROM results r WHERE r.simulation_preset_revision_id = rev.id)
          OR EXISTS (SELECT 1 FROM result_attempts ra WHERE ra.simulation_preset_revision_id = rev.id)
          OR EXISTS (SELECT 1 FROM sim_jobs j WHERE j.simulation_preset_revision_id = rev.id)
          OR EXISTS (SELECT 1 FROM sim_campaign_conditions cc2 WHERE cc2.simulation_preset_revision_id = rev.id)
          OR EXISTS (SELECT 1 FROM sync_sweep_promises pr WHERE pr.simulation_preset_revision_id = rev.id)
        )
      )
    RETURNING sp.id
  `)) as unknown as unknown[];
  return rows.length;
}

export async function closeCampaignWithFailures(db: DB, campaignId: string) {
  return db.transaction(async (tx) => {
    const campaign = await requireCampaign(tx, campaignId);
    if (campaign.status !== "attention") {
      throw new CampaignError("invalid_state", `only attention campaigns can be closed with failures (status: ${campaign.status})`);
    }
    const totals = await campaignProgressTotals(tx, campaignId);
    // Record BOTH review buckets: attention fires on failed>0 OR rejected>0,
    // so a rejected-only close must not book "closed with 0 failed points".
    const [row] = await asDb(tx)
      .update(simCampaigns)
      .set({ status: "completed", closedWithFailedCount: totals.failed, closedWithRejectedCount: totals.rejected, completedAt: new Date() })
      .where(eq(simCampaigns.id, campaignId))
      .returning();
    return { campaign: row, closedWithFailedCount: totals.failed, closedWithRejectedCount: totals.rejected };
  });
}

export async function archiveCampaign(db: DB, campaignId: string, unarchive = false) {
  return db.transaction(async (tx) => {
    const campaign = await requireCampaign(tx, campaignId);
    if (unarchive) {
      if (campaign.status !== "archived") throw new CampaignError("invalid_state", "campaign is not archived");
      const restored = campaign.completedAt ? "completed" : "cancelled";
      const [row] = await asDb(tx).update(simCampaigns).set({ status: restored }).where(eq(simCampaigns.id, campaignId)).returning();
      return { campaign: row };
    }
    if (!["completed", "cancelled"].includes(campaign.status)) {
      throw new CampaignError("invalid_state", `only completed/cancelled campaigns can be archived (status: ${campaign.status})`);
    }
    const [row] = await asDb(tx).update(simCampaigns).set({ status: "archived" }).where(eq(simCampaigns.id, campaignId)).returning();
    return { campaign: row };
  });
}

/** Force-release a blocked `kept` condition (spec §6.3): explicit, recorded as
 *  a force_release plan revision; solved evidence kept; pending deleted. */
export async function forceReleaseCondition(db: DB, campaignId: string, conditionId: string, expectedCancelledPoints?: number) {
  return db.transaction(async (tx) => {
    const { campaign, revision, plan } = await loadCampaignWithCurrentPlan(tx, campaignId, { forUpdate: true });
    const [condition] = await asDb(tx)
      .select()
      .from(simCampaignConditions)
      .where(and(eq(simCampaignConditions.id, conditionId), eq(simCampaignConditions.campaignId, campaignId)))
      .limit(1);
    if (!condition) throw new CampaignError("not_found", "condition not found");
    if (condition.status !== "kept") {
      throw new CampaignError("invalid_state", `only kept conditions can be force-released (status: ${condition.status})`);
    }
    const [openRow] = (await asDb(tx).execute(sql`
      SELECT count(*)::int AS n FROM sim_campaign_points WHERE campaign_id = ${campaignId} AND condition_id = ${conditionId} AND state = 'requested'
    `)) as unknown as Array<{ n: number }>;
    const cancelledPoints = Number(openRow?.n ?? 0);
    if (expectedCancelledPoints != null && expectedCancelledPoints !== cancelledPoints) {
      throw new CampaignError("drift", `expected ${expectedCancelledPoints} cancellable points but found ${cancelledPoints} — refresh and confirm again`, {
        expected: expectedCancelledPoints,
        actual: cancelledPoints,
      });
    }
    const [planRevision] = await asDb(tx)
      .insert(simCampaignPlanRevisions)
      .values({
        campaignId,
        revisionNumber: revision.revisionNumber + 1,
        kind: "force_release",
        plan: plan as unknown as Record<string, unknown>,
        summary: {
          addedConditions: 0,
          keptConditions: 0,
          releasedConditions: 1,
          addedPoints: 0,
          cancelledPoints,
          forceReleasedConditionId: conditionId,
          valueDiffs: null,
          rateBaselineAt: new Date().toISOString(),
        },
      })
      .returning();
    await asDb(tx).update(simCampaigns).set({ currentPlanRevisionId: planRevision.id }).where(eq(simCampaigns.id, campaign.id));
    await asDb(tx)
      .update(simCampaignConditions)
      .set({ status: "released", statusChangedInPlanRevisionId: planRevision.id })
      .where(eq(simCampaignConditions.id, conditionId));
    await asDb(tx).execute(sql`
      UPDATE sim_campaign_points SET state = 'released', "updatedAt" = now()
      WHERE campaign_id = ${campaignId} AND condition_id = ${conditionId} AND state = 'requested'
    `);
    await deleteReleasedPendingResults(tx, campaignId);
    await recomputeCampaignProgress(tx, campaignId);
    const totals = await refreshCampaignCompletion(tx, campaignId);
    return { planRevisionNumber: planRevision.revisionNumber, cancelledPoints, totals };
  });
}

/** Restore a released condition through the normal plan-edit path: the combo's
 *  values are ensured in the envelope and every OTHER combo that would newly
 *  appear is excluded, so exactly this condition re-activates (spec §6.3). */
export async function restoreCondition(db: DB, campaignId: string, conditionId: string, createdBy?: string | null) {
  return db.transaction(async (tx) => {
    const { campaign, revision, plan } = await loadCampaignWithCurrentPlan(tx, campaignId, { forUpdate: true });
    const condRows = await loadCampaignConditionCombos(tx, campaignId);
    const target = condRows.find((r) => r.condition.id === conditionId);
    if (!target) throw new CampaignError("not_found", "condition not found");
    if (target.condition.status === "active") throw new CampaignError("invalid_state", "condition is already active");

    const [t, p, speed, chord] = target.comboKey.split("|") as [string, string, string, string];
    const activeKeys = new Set(condRows.filter((r) => r.condition.status === "active").map((r) => r.comboKey));
    const draft: CampaignPlan = {
      ...plan,
      ambients: dedupeSorted(
        [...plan.ambients, [t, p] as [string, string]],
        (a) => `${a[0]}|${a[1]}`,
        (a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]),
      ),
      speedsMps: dedupeSorted([...plan.speedsMps, speed], (x) => x, (a, b) => Number(a) - Number(b)),
      chordsM: dedupeSorted([...plan.chordsM, chord], (x) => x, (a, b) => Number(a) - Number(b)),
      excludedConditions: plan.excludedConditions.filter((x) => x.join("|") !== target.comboKey),
    };
    // Exclude every combo the widened envelope would introduce except the
    // restored one and combos already active.
    const wouldBe = conditionCombosFromPlan(draft);
    const extraExclusions = wouldBe
      .filter((c) => c.comboKey !== target.comboKey && !activeKeys.has(c.comboKey))
      .map((c) => [c.temperatureK, c.pressurePa, c.speedMps, c.chordM] as [string, string, string, string]);
    const newPlanInput: CampaignPlanInput = {
      ...draft,
      excludedConditions: dedupeSorted(
        [...draft.excludedConditions, ...extraExclusions],
        (x) => x.join("|"),
        (a, b) => a.join("|").localeCompare(b.join("|")),
      ),
    };
    const { classification } = await classifyPlanChange(tx, campaignId, newPlanInput);
    return applyPlanEditCore(tx, campaign, revision.revisionNumber, classification, "edit", createdBy, {
      restoredConditionId: conditionId,
    });
  });
}

export async function continueLane(
  db: DB,
  campaignId: string,
  laneKey: { airfoilId: string; conditionId: string; objective: CampaignObjectiveKey },
  extraRounds: number,
) {
  if (!(Number.isInteger(extraRounds) && extraRounds >= 1 && extraRounds <= 50)) {
    throw new CampaignError("validation", "extraRounds must be an integer 1..50");
  }
  const [lane] = await db
    .update(simCampaignLanes)
    .set({
      extraRoundsGranted: sql`${simCampaignLanes.extraRoundsGranted} + ${extraRounds}`,
      state: sql`CASE WHEN ${simCampaignLanes.state} = 'stalled' THEN 'iterating' ELSE ${simCampaignLanes.state} END`,
    })
    .where(
      and(
        eq(simCampaignLanes.campaignId, campaignId),
        eq(simCampaignLanes.airfoilId, laneKey.airfoilId),
        eq(simCampaignLanes.conditionId, laneKey.conditionId),
        eq(simCampaignLanes.objective, laneKey.objective),
      ),
    )
    .returning();
  if (!lane) throw new CampaignError("not_found", "lane not found");
  return lane;
}

// ---------------------------------------------------------------------------
// Failures + scoped requeue (spec §10)
// ---------------------------------------------------------------------------
export const CAMPAIGN_ERROR_CLASSES = ["mesh", "diverged", "timeout", "engine", "cancelled", "solver", "unknown"] as const;
export type CampaignErrorClass = (typeof CAMPAIGN_ERROR_CLASSES)[number];

/** Deterministic error-class bucket, shared by the failures view, the scoped
 *  requeue, AND the point-history explorer so counts always agree. */
export const ERROR_CLASS_SQL = sql`CASE
  WHEN r.error IS NULL OR btrim(r.error) = '' THEN 'unknown'
  WHEN r.error ILIKE '%mesh%' THEN 'mesh'
  WHEN r.error ILIKE '%diverg%' OR r.error ILIKE '%residual%' OR r.error ILIKE '% nan%' THEN 'diverged'
  WHEN r.error ILIKE '%timeout%' OR r.error ILIKE '%timed out%' THEN 'timeout'
  WHEN r.error ILIKE '%cancel%' THEN 'cancelled'
  WHEN r.error ILIKE '%connect%' OR r.error ILIKE '%unreachable%' OR r.error ILIKE '%engine%' OR r.error ILIKE '%econn%' THEN 'engine'
  ELSE 'solver'
END`;

// A failed campaign point is TERMINAL with its authoritative results row
// (r.id = p.result_id) at status='failed' — NOT state='requested' with a
// cell-key join. Failed points are terminal-linked at ingest (onResultIngested
// sets state='terminal', result_id=<failed result>), so the failures list,
// counters, and requeue must all match on the terminal model and join by
// result_id. Callers MUST join `results r ON r.id = p.result_id`.
function failedResultsWhere(campaignId: string, filters: { conditionId?: string; airfoilId?: string }) {
  return sql`
    p.campaign_id = ${campaignId}
    AND p.state = 'terminal'
    AND NOT p.derived_by_symmetry
    AND r.id = p.result_id
    AND r.status = 'failed'
    ${filters.conditionId ? sql`AND p.condition_id = ${filters.conditionId}` : sql``}
    ${filters.airfoilId ? sql`AND p.airfoil_id = ${filters.airfoilId}` : sql``}
  `;
}

// A rejected campaign point is TERMINAL with its authoritative results row
// DONE but classified 'rejected' (physics-invalid evidence) — the same
// terminal+result_id model as failedResultsWhere, with the classification
// join matching the canonical counter (rc.result_id = p.result_id,
// rc.state='rejected'). Callers MUST join `results r ON r.id = p.result_id`.
function rejectedResultsWhere(campaignId: string, filters: { conditionId?: string; airfoilId?: string }) {
  return sql`
    p.campaign_id = ${campaignId}
    AND p.state = 'terminal'
    AND NOT p.derived_by_symmetry
    AND r.id = p.result_id
    AND r.status = 'done'
    AND EXISTS (SELECT 1 FROM result_classifications rc WHERE rc.result_id = r.id AND rc.state = 'rejected')
    ${filters.conditionId ? sql`AND p.condition_id = ${filters.conditionId}` : sql``}
    ${filters.airfoilId ? sql`AND p.airfoil_id = ${filters.airfoilId}` : sql``}
  `;
}

export interface CampaignRejectedSample {
  resultId: string;
  conditionId: string;
  airfoilId: string;
  airfoilSlug: string;
  airfoilName: string;
  aoaDeg: number;
  reasons: string[];
  attempts: number;
}

/** Rejected (done-but-physics-rejected) points in scope, for the requeue
 *  dialog: exact total plus bounded samples. Shares rejectedResultsWhere with
 *  requeueCampaignFailed so the dialog count and the requeue predicate can
 *  never disagree (same coherence rule as failures/requeue). */
export async function campaignRejected(
  db: DB,
  campaignId: string,
  filters: { conditionId?: string; airfoilId?: string } = {},
): Promise<{ total: number; samples: CampaignRejectedSample[] }> {
  await requireCampaign(db, campaignId);
  const rows = (await db.execute(sql`
    SELECT * FROM (
      SELECT
        r.id AS result_id,
        p.condition_id,
        p.airfoil_id,
        af.slug AS airfoil_slug,
        af.name AS airfoil_name,
        p.aoa_deg::float8 AS aoa_deg,
        rc.reasons,
        (SELECT count(*)::int FROM result_attempts ra WHERE ra.result_id = r.id) AS attempts,
        count(*) OVER ()::int AS total,
        row_number() OVER (ORDER BY r."updatedAt" DESC) AS rn
      FROM results r
      JOIN sim_campaign_points p ON p.result_id = r.id
      JOIN airfoils af ON af.id = p.airfoil_id
      JOIN result_classifications rc ON rc.result_id = r.id
      WHERE ${rejectedResultsWhere(campaignId, filters)}
    ) ranked
    WHERE rn <= 20
    ORDER BY rn ASC
  `)) as unknown as Array<{
    result_id: string;
    condition_id: string;
    airfoil_id: string;
    airfoil_slug: string;
    airfoil_name: string;
    aoa_deg: number;
    reasons: string[] | null;
    attempts: number;
    total: number;
    rn: number;
  }>;
  return {
    total: rows.length > 0 ? Number(rows[0].total) : 0,
    samples: rows.map((row) => ({
      resultId: row.result_id,
      conditionId: row.condition_id,
      airfoilId: row.airfoil_id,
      airfoilSlug: row.airfoil_slug,
      airfoilName: row.airfoil_name,
      aoaDeg: Number(row.aoa_deg),
      reasons: row.reasons ?? [],
      attempts: Number(row.attempts),
    })),
  };
}

export interface CampaignFailureGroup {
  errorClass: CampaignErrorClass;
  count: number;
  samples: Array<{
    resultId: string;
    conditionId: string;
    airfoilId: string;
    airfoilSlug: string;
    airfoilName: string;
    aoaDeg: number;
    error: string | null;
    attempts: number;
  }>;
}

export async function campaignFailures(
  db: DB,
  campaignId: string,
  filters: { conditionId?: string; airfoilId?: string } = {},
): Promise<{ total: number; groups: CampaignFailureGroup[] }> {
  await requireCampaign(db, campaignId);
  const rows = (await db.execute(sql`
    SELECT * FROM (
      SELECT
        ${ERROR_CLASS_SQL} AS error_class,
        r.id AS result_id,
        p.condition_id,
        p.airfoil_id,
        af.slug AS airfoil_slug,
        af.name AS airfoil_name,
        p.aoa_deg::float8 AS aoa_deg,
        r.error,
        (SELECT count(*)::int FROM result_attempts ra WHERE ra.result_id = r.id) AS attempts,
        count(*) OVER (PARTITION BY ${ERROR_CLASS_SQL})::int AS class_count,
        row_number() OVER (PARTITION BY ${ERROR_CLASS_SQL} ORDER BY r."updatedAt" DESC) AS rn
      FROM results r
      JOIN sim_campaign_points p ON p.result_id = r.id
      JOIN airfoils af ON af.id = p.airfoil_id
      WHERE ${failedResultsWhere(campaignId, filters)}
    ) ranked
    WHERE rn <= 20
    ORDER BY class_count DESC, error_class ASC, rn ASC
  `)) as unknown as Array<{
    error_class: CampaignErrorClass;
    result_id: string;
    condition_id: string;
    airfoil_id: string;
    airfoil_slug: string;
    airfoil_name: string;
    aoa_deg: number;
    error: string | null;
    attempts: number;
    class_count: number;
    rn: number;
  }>;
  const groups = new Map<CampaignErrorClass, CampaignFailureGroup>();
  let total = 0;
  for (const row of rows) {
    let group = groups.get(row.error_class);
    if (!group) {
      group = { errorClass: row.error_class, count: Number(row.class_count), samples: [] };
      groups.set(row.error_class, group);
      total += Number(row.class_count);
    }
    group.samples.push({
      resultId: row.result_id,
      conditionId: row.condition_id,
      airfoilId: row.airfoil_id,
      airfoilSlug: row.airfoil_slug,
      airfoilName: row.airfoil_name,
      aoaDeg: Number(row.aoa_deg),
      error: row.error,
      attempts: Number(row.attempts),
    });
  }
  return { total, groups: [...groups.values()] };
}

/** Scoped requeue with exact expected-count verification (409 on drift).
 *  Covers BOTH review buckets: terminal-FAILED points (always) and, when
 *  includeRejected is set, terminal-DONE points whose classification is
 *  'rejected' (physics-invalid evidence that should re-solve, e.g. on a fixed
 *  engine build). Each bucket carries its own expected count so a stale dialog
 *  can never silently requeue more (or fewer) points than the admin confirmed. */
export async function requeueCampaignFailed(
  db: DB,
  campaignId: string,
  args: {
    errorClasses?: CampaignErrorClass[];
    conditionId?: string;
    airfoilId?: string;
    expectedCount: number;
    includeRejected?: boolean;
    expectedRejectedCount?: number;
  },
): Promise<{ requeued: number; requeuedFailed: number; requeuedRejected: number; totals: CampaignProgressTotals }> {
  return db.transaction(async (tx) => {
    await requireCampaign(tx, campaignId);
    const classFilter =
      args.errorClasses && args.errorClasses.length > 0
        ? sql`AND ${ERROR_CLASS_SQL} = ANY(${pgTextArray(args.errorClasses)}::text[])`
        : sql``;
    const matching = (await asDb(tx).execute(sql`
      SELECT r.id
      FROM results r
      JOIN sim_campaign_points p ON p.result_id = r.id
      WHERE ${failedResultsWhere(campaignId, { conditionId: args.conditionId, airfoilId: args.airfoilId })}
        ${classFilter}
      FOR UPDATE OF r
    `)) as unknown as Array<{ id: string }>;
    if (matching.length !== args.expectedCount) {
      throw new CampaignError("drift", `expected ${args.expectedCount} failed points but found ${matching.length} — refresh and confirm again`, {
        expected: args.expectedCount,
        actual: matching.length,
      });
    }
    let matchingRejected: Array<{ id: string }> = [];
    if (args.includeRejected) {
      matchingRejected = (await asDb(tx).execute(sql`
        SELECT r.id
        FROM results r
        JOIN sim_campaign_points p ON p.result_id = r.id
        WHERE ${rejectedResultsWhere(campaignId, { conditionId: args.conditionId, airfoilId: args.airfoilId })}
        FOR UPDATE OF r
      `)) as unknown as Array<{ id: string }>;
      const expectedRejected = args.expectedRejectedCount ?? 0;
      if (matchingRejected.length !== expectedRejected) {
        throw new CampaignError(
          "drift",
          `expected ${expectedRejected} rejected points but found ${matchingRejected.length} — refresh and confirm again`,
          { expected: expectedRejected, actual: matchingRejected.length },
        );
      }
    }
    const ids = [...matching.map((m) => m.id), ...matchingRejected.map((m) => m.id)];
    if (ids.length > 0) {
      // Reset the failed/rejected evidence rows to re-claimable pending work.
      // (A rejected row was status='done'; flipping it to 'pending' keeps its
      // attempts/evidence history and lets the re-solve overwrite in place —
      // the still-'rejected' classification row is re-verdicted by the polar
      // cache refresh after the new evidence lands.)
      await asDb(tx).update(results).set({ status: "pending", simJobId: null }).where(inArray(results.id, ids));
      // Flip the terminal points back to 'requested' so the campaign sweeper
      // branch (which schedules only state='requested' points) will actually
      // reschedule them. Without this the point would be a terminal orphan
      // pointing at a pending result that never gets re-solved. The result_id
      // is left intact: onResultIngested re-terminal-links this same cell by
      // (airfoil, revision, aoa) when the re-solve lands, and the pending
      // result is now re-claimable by the gap query (r.status='pending').
      await asDb(tx).execute(sql`
        UPDATE sim_campaign_points
        SET state = 'requested', "updatedAt" = now()
        WHERE campaign_id = ${campaignId}
          AND result_id = ANY(${pgUuidArray(ids)}::uuid[])
          AND state = 'terminal'
          AND NOT derived_by_symmetry
      `);
    }
    await recomputeCampaignProgress(tx, campaignId);
    const totals = await refreshCampaignCompletion(tx, campaignId);
    return {
      requeued: ids.length,
      requeuedFailed: matching.length,
      requeuedRejected: matchingRejected.length,
      totals,
    };
  });
}

// ---------------------------------------------------------------------------
// Bounded reads (spec §10)
// ---------------------------------------------------------------------------
export interface CampaignListItem {
  id: string;
  slug: string;
  name: string;
  status: string;
  priority: number;
  notes: string | null;
  closedWithFailedCount: number | null;
  closedWithRejectedCount: number | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  conditionCount: number;
  airfoilCount: number;
  totals: CampaignProgressTotals;
}

const isoOf = (v: Date | string | null): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : v);

export async function listCampaigns(
  db: DB,
  opts: { statuses?: string[]; limit?: number; offset?: number } = {},
): Promise<{ items: CampaignListItem[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const statusFilter = opts.statuses && opts.statuses.length > 0 ? sql`WHERE c.status = ANY(${pgTextArray(opts.statuses)}::text[])` : sql``;
  const rows = (await db.execute(sql`
    SELECT
      c.id, c.slug, c.name, c.status, c.priority, c.notes,
      c.closed_with_failed_count, c.closed_with_rejected_count, c."completedAt" AS completed_at, c."createdAt" AS created_at, c."updatedAt" AS updated_at,
      (SELECT count(*)::int FROM sim_campaign_conditions cc WHERE cc.campaign_id = c.id) AS condition_count,
      (SELECT count(*)::int FROM sim_campaign_airfoils ca WHERE ca.campaign_id = c.id) AS airfoil_count,
      COALESCE(pr.requested, 0)::int AS requested,
      COALESCE(pr.solved, 0)::int AS solved,
      COALESCE(pr.failed, 0)::int AS failed,
      COALESCE(pr.running, 0)::int AS running,
      COALESCE(pr.superseded, 0)::int AS superseded,
      COALESCE(pr.derived, 0)::int AS derived,
      COALESCE(pr.rejected, 0)::int AS rejected,
      count(*) OVER ()::int AS total
    FROM sim_campaigns c
    LEFT JOIN (
      SELECT campaign_id, sum(requested) AS requested, sum(solved) AS solved, sum(failed) AS failed,
             sum(running) AS running, sum(superseded) AS superseded, sum(derived) AS derived, sum(rejected) AS rejected
      FROM sim_campaign_progress GROUP BY campaign_id
    ) pr ON pr.campaign_id = c.id
    ${statusFilter}
    ORDER BY (c.status = 'attention') DESC, c."updatedAt" DESC
    LIMIT ${limit} OFFSET ${offset}
  `)) as unknown as Array<Record<string, unknown>>;
  const total = Number(rows[0]?.total ?? 0);
  return {
    total,
    items: rows.map((r) => ({
      id: String(r.id),
      slug: String(r.slug),
      name: String(r.name),
      status: String(r.status),
      priority: Number(r.priority),
      notes: (r.notes as string | null) ?? null,
      closedWithFailedCount: r.closed_with_failed_count == null ? null : Number(r.closed_with_failed_count),
      closedWithRejectedCount: r.closed_with_rejected_count == null ? null : Number(r.closed_with_rejected_count),
      completedAt: isoOf(r.completed_at as Date | string | null),
      createdAt: isoOf(r.created_at as Date | string | null)!,
      updatedAt: isoOf(r.updated_at as Date | string | null)!,
      conditionCount: Number(r.condition_count),
      airfoilCount: Number(r.airfoil_count),
      totals: {
        requested: Number(r.requested),
        solved: Number(r.solved),
        failed: Number(r.failed),
        running: Number(r.running),
        superseded: Number(r.superseded),
        derived: Number(r.derived),
        rejected: Number(r.rejected),
        remaining: Math.max(0, Number(r.requested) - Number(r.solved) - Number(r.derived) - Number(r.failed) - Number(r.rejected)),
      },
    })),
  };
}

export interface CampaignConditionSummary {
  id: string;
  ord: number;
  status: string;
  flowConditionId: string;
  referenceGeometryProfileId: string;
  presetId: string;
  presetSlug: string;
  presetName: string;
  presetOrigin: string;
  revisionId: string;
  revisionNumber: number;
  reynolds: number;
  mach: number | null;
  temperatureK: number | null;
  pressurePa: number | null;
  speedMps: number | null;
  chordM: number | null;
  drift: boolean;
  gainedEvidenceAfterRelease: boolean;
  counters: CampaignProgressTotals;
}

export interface CampaignSummary {
  campaign: {
    id: string;
    slug: string;
    name: string;
    notes: string | null;
    status: string;
    priority: number;
    idempotencyKey: string;
    closedWithFailedCount: number | null;
    closedWithRejectedCount: number | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
    planRevisionNumber: number;
    plan: CampaignPlan;
    rateBaselineAt: string | null;
  };
  totals: CampaignProgressTotals;
  airfoilCount: number;
  conditions: CampaignConditionSummary[];
  lanesSummary: Record<string, Record<string, number>>;
}

/** Bounded summary for the 10 s poll: O(conditions), counters only. */
export async function campaignSummary(db: DB, campaignId: string): Promise<CampaignSummary> {
  const { campaign, revision, plan } = await loadCampaignWithCurrentPlan(db, campaignId);
  const totals = await campaignProgressTotals(db, campaignId);
  const [airfoilCountRow] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM sim_campaign_airfoils WHERE campaign_id = ${campaignId}`,
  )) as unknown as Array<{ n: number }>;
  const conditionRows = (await db.execute(sql`
    SELECT
      cc.id, cc.ord, cc.status,
      cc.flow_condition_id, cc.reference_geometry_profile_id, cc.preset_id, cc.simulation_preset_revision_id,
      cc.reynolds::float8 AS reynolds, cc.mach::float8 AS mach,
      p.slug AS preset_slug, p.name AS preset_name, p.origin AS preset_origin,
      rev.revision_number,
      (rev.snapshot->'flowState'->>'temperatureK')::float8 AS temperature_k,
      (rev.snapshot->'flowState'->>'pressurePa')::float8 AS pressure_pa,
      (rev.snapshot->'flowState'->>'speedMps')::float8 AS speed_mps,
      (rev.snapshot->'referenceGeometry'->>'referenceLengthM')::float8 AS chord_m,
      EXISTS (
        SELECT 1 FROM simulation_preset_revisions newer
        WHERE newer.preset_id = cc.preset_id AND newer.revision_number > rev.revision_number
      ) AS drift,
      (cc.status = 'released' AND EXISTS (
        SELECT 1 FROM sim_campaign_points pt
        JOIN results r ON r.airfoil_id = pt.airfoil_id AND r.simulation_preset_revision_id = pt.revision_id AND r.aoa_deg = pt.aoa_deg
        WHERE pt.condition_id = cc.id AND pt.state = 'released' AND NOT pt.derived_by_symmetry
          AND r.status = 'done' AND r.source = 'solved'
      )) AS gained_evidence,
      COALESCE(pr.requested, 0)::int AS requested,
      COALESCE(pr.solved, 0)::int AS solved,
      COALESCE(pr.failed, 0)::int AS failed,
      COALESCE(pr.running, 0)::int AS running,
      COALESCE(pr.superseded, 0)::int AS superseded,
      COALESCE(pr.derived, 0)::int AS derived,
      COALESCE(pr.rejected, 0)::int AS rejected
    FROM sim_campaign_conditions cc
    JOIN simulation_presets p ON p.id = cc.preset_id
    JOIN simulation_preset_revisions rev ON rev.id = cc.simulation_preset_revision_id
    LEFT JOIN (
      SELECT condition_id, sum(requested) AS requested, sum(solved) AS solved, sum(failed) AS failed,
             sum(running) AS running, sum(superseded) AS superseded, sum(derived) AS derived, sum(rejected) AS rejected
      FROM sim_campaign_progress WHERE campaign_id = ${campaignId} GROUP BY condition_id
    ) pr ON pr.condition_id = cc.id
    WHERE cc.campaign_id = ${campaignId}
    ORDER BY cc.ord ASC
  `)) as unknown as Array<Record<string, unknown>>;
  const laneRows = (await db.execute(sql`
    SELECT objective, state, count(*)::int AS n FROM sim_campaign_lanes WHERE campaign_id = ${campaignId} GROUP BY objective, state
  `)) as unknown as Array<{ objective: string; state: string; n: number }>;
  const lanesSummary: Record<string, Record<string, number>> = {};
  for (const row of laneRows) {
    lanesSummary[row.objective] = { ...(lanesSummary[row.objective] ?? {}), [row.state]: Number(row.n) };
  }
  const summaryRateBaseline = (revision.summary as Record<string, unknown> | null)?.rateBaselineAt;
  return {
    campaign: {
      id: campaign.id,
      slug: campaign.slug,
      name: campaign.name,
      notes: campaign.notes,
      status: campaign.status,
      priority: campaign.priority,
      idempotencyKey: campaign.idempotencyKey,
      closedWithFailedCount: campaign.closedWithFailedCount,
      closedWithRejectedCount: campaign.closedWithRejectedCount,
      completedAt: isoOf(campaign.completedAt),
      createdAt: isoOf(campaign.createdAt)!,
      updatedAt: isoOf(campaign.updatedAt)!,
      planRevisionNumber: revision.revisionNumber,
      plan,
      rateBaselineAt: typeof summaryRateBaseline === "string" ? summaryRateBaseline : isoOf(revision.createdAt),
    },
    totals,
    airfoilCount: Number(airfoilCountRow?.n ?? 0),
    conditions: conditionRows.map((r) => ({
      id: String(r.id),
      ord: Number(r.ord),
      status: String(r.status),
      flowConditionId: String(r.flow_condition_id),
      referenceGeometryProfileId: String(r.reference_geometry_profile_id),
      presetId: String(r.preset_id),
      presetSlug: String(r.preset_slug),
      presetName: String(r.preset_name),
      presetOrigin: String(r.preset_origin),
      revisionId: String(r.simulation_preset_revision_id),
      revisionNumber: Number(r.revision_number),
      reynolds: Number(r.reynolds),
      mach: r.mach == null ? null : Number(r.mach),
      temperatureK: r.temperature_k == null ? null : Number(r.temperature_k),
      pressurePa: r.pressure_pa == null ? null : Number(r.pressure_pa),
      speedMps: r.speed_mps == null ? null : Number(r.speed_mps),
      chordM: r.chord_m == null ? null : Number(r.chord_m),
      drift: Boolean(r.drift),
      gainedEvidenceAfterRelease: Boolean(r.gained_evidence),
      counters: {
        requested: Number(r.requested),
        solved: Number(r.solved),
        failed: Number(r.failed),
        running: Number(r.running),
        superseded: Number(r.superseded),
        derived: Number(r.derived),
        rejected: Number(r.rejected),
        remaining: Math.max(0, Number(r.requested) - Number(r.solved) - Number(r.derived) - Number(r.failed) - Number(r.rejected)),
      },
    })),
    lanesSummary,
  };
}

export interface CampaignAirfoilRow {
  airfoilId: string;
  slug: string;
  name: string;
  isSymmetric: boolean;
  perCondition: Array<{ conditionId: string } & CampaignProgressTotals>;
}

/** Keyset matrix rows by airfoil slug (spec §10, cursor = last slug). */
export async function campaignAirfoilRows(
  db: DB,
  campaignId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<{ items: CampaignAirfoilRow[]; nextCursor: string | null }> {
  await requireCampaign(db, campaignId);
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const cursorFilter = opts.cursor ? sql`AND af.slug > ${opts.cursor}` : sql``;
  const airfoilRowsPage = (await db.execute(sql`
    SELECT af.id, af.slug, af.name, af.is_symmetric
    FROM sim_campaign_airfoils ca
    JOIN airfoils af ON af.id = ca.airfoil_id
    WHERE ca.campaign_id = ${campaignId} ${cursorFilter}
    ORDER BY af.slug ASC
    LIMIT ${limit + 1}
  `)) as unknown as Array<{ id: string; slug: string; name: string; is_symmetric: boolean }>;
  const page = airfoilRowsPage.slice(0, limit);
  const nextCursor = airfoilRowsPage.length > limit ? page[page.length - 1]?.slug ?? null : null;
  if (page.length === 0) return { items: [], nextCursor: null };
  const ids = page.map((r) => r.id);
  const progressRows = await db
    .select()
    .from(simCampaignProgress)
    .where(and(eq(simCampaignProgress.campaignId, campaignId), inArray(simCampaignProgress.airfoilId, ids)));
  const byAirfoil = new Map<string, CampaignAirfoilRow["perCondition"]>();
  for (const row of progressRows) {
    const bucket = byAirfoil.get(row.airfoilId) ?? [];
    bucket.push({
      conditionId: row.conditionId,
      requested: row.requested,
      solved: row.solved,
      failed: row.failed,
      running: row.running,
      superseded: row.superseded,
      derived: row.derived,
      rejected: row.rejected,
      remaining: Math.max(0, row.requested - row.solved - row.derived - row.failed - row.rejected),
    });
    byAirfoil.set(row.airfoilId, bucket);
  }
  return {
    items: page.map((r) => ({
      airfoilId: r.id,
      slug: r.slug,
      name: r.name,
      isSymmetric: Boolean(r.is_symmetric),
      perCondition: byAirfoil.get(r.id) ?? [],
    })),
    nextCursor,
  };
}

export interface CampaignLaneRow {
  campaignId: string;
  airfoilId: string;
  airfoilSlug: string;
  airfoilName: string;
  conditionId: string;
  conditionOrd: number;
  conditionStatus: string;
  reynolds: number;
  objective: string;
  state: string;
  currentTargetAlpha: number | null;
  iterationCount: number;
  extraRoundsGranted: number;
  witnessFitSetId: string | null;
  updatedAt: string;
}

export async function campaignLanes(
  db: DB,
  campaignId: string,
  opts: { objective?: CampaignObjectiveKey; state?: string; cursor?: string | null; limit?: number } = {},
): Promise<{ items: CampaignLaneRow[]; nextCursor: string | null }> {
  await requireCampaign(db, campaignId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  let cursorFilter = sql``;
  if (opts.cursor) {
    const [slug, ordRaw, objective] = opts.cursor.split("~");
    const ord = Number(ordRaw);
    if (slug && Number.isFinite(ord) && objective) {
      cursorFilter = sql`AND (af.slug, cc.ord, l.objective) > (${slug}, ${ord}::int, ${objective})`;
    }
  }
  const rows = (await db.execute(sql`
    SELECT
      l.campaign_id, l.airfoil_id, l.condition_id, l.objective, l.state,
      l.current_target_alpha::float8 AS current_target_alpha,
      l.iteration_count, l.extra_rounds_granted, l.witness_fit_set_id, l."updatedAt" AS updated_at,
      af.slug AS airfoil_slug, af.name AS airfoil_name,
      cc.ord AS condition_ord, cc.status AS condition_status, cc.reynolds::float8 AS reynolds
    FROM sim_campaign_lanes l
    JOIN airfoils af ON af.id = l.airfoil_id
    JOIN sim_campaign_conditions cc ON cc.id = l.condition_id
    WHERE l.campaign_id = ${campaignId}
      ${opts.objective ? sql`AND l.objective = ${opts.objective}` : sql``}
      ${opts.state ? sql`AND l.state = ${opts.state}` : sql``}
      ${cursorFilter}
    ORDER BY af.slug ASC, cc.ord ASC, l.objective ASC
    LIMIT ${limit + 1}
  `)) as unknown as Array<Record<string, unknown>>;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? `${last.airfoil_slug}~${last.condition_ord}~${last.objective}` : null;
  return {
    items: page.map((r) => ({
      campaignId: String(r.campaign_id),
      airfoilId: String(r.airfoil_id),
      airfoilSlug: String(r.airfoil_slug),
      airfoilName: String(r.airfoil_name),
      conditionId: String(r.condition_id),
      conditionOrd: Number(r.condition_ord),
      conditionStatus: String(r.condition_status),
      reynolds: Number(r.reynolds),
      objective: String(r.objective),
      state: String(r.state),
      currentTargetAlpha: r.current_target_alpha == null ? null : Number(r.current_target_alpha),
      iterationCount: Number(r.iteration_count),
      extraRoundsGranted: Number(r.extra_rounds_granted),
      witnessFitSetId: (r.witness_fit_set_id as string | null) ?? null,
      updatedAt: isoOf(r.updated_at as Date | string | null)!,
    })),
    nextCursor,
  };
}

export async function campaignLaneDetail(
  db: DB,
  campaignId: string,
  laneKey: { airfoilId: string; conditionId: string; objective: CampaignObjectiveKey },
) {
  const [lane] = await db
    .select()
    .from(simCampaignLanes)
    .where(
      and(
        eq(simCampaignLanes.campaignId, campaignId),
        eq(simCampaignLanes.airfoilId, laneKey.airfoilId),
        eq(simCampaignLanes.conditionId, laneKey.conditionId),
        eq(simCampaignLanes.objective, laneKey.objective),
      ),
    )
    .limit(1);
  if (!lane) throw new CampaignError("not_found", "lane not found");
  const steps = (await db.execute(sql`
    SELECT
      s.iteration, s.predicted_alpha::float8 AS predicted_alpha, s.fit_set_id, s.solved_result_id, s.outcome, s."createdAt" AS created_at,
      r.aoa_deg::float8 AS solved_aoa, r.cl::float8 AS solved_cl, r.cd::float8 AS solved_cd, r.status AS solved_status
    FROM sim_campaign_lane_steps s
    LEFT JOIN results r ON r.id = s.solved_result_id
    WHERE s.campaign_id = ${campaignId} AND s.airfoil_id = ${laneKey.airfoilId}
      AND s.condition_id = ${laneKey.conditionId} AND s.objective = ${laneKey.objective}
    ORDER BY s.iteration ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return {
    lane,
    steps: steps.map((s) => ({
      iteration: Number(s.iteration),
      predictedAlpha: Number(s.predicted_alpha),
      fitSetId: String(s.fit_set_id),
      solvedResultId: (s.solved_result_id as string | null) ?? null,
      outcome: String(s.outcome),
      createdAt: isoOf(s.created_at as Date | string | null)!,
      solved:
        s.solved_result_id == null
          ? null
          : {
              aoaDeg: s.solved_aoa == null ? null : Number(s.solved_aoa),
              cl: s.solved_cl == null ? null : Number(s.solved_cl),
              cd: s.solved_cd == null ? null : Number(s.solved_cd),
              status: (s.solved_status as string | null) ?? null,
            },
    })),
  };
}

export interface CampaignRate {
  pointsLast24h: number;
  windowHours: 24;
  baselineAt: string | null;
  measuredSince: string;
  remainingPoints: number;
}

/** Measured ingest rate (spec §12): trailing 24 h of solvedAt on campaign
 *  solver cells, window reset to the latest plan-revision baseline. Returns
 *  null (suppressed) unless the campaign is active and ≥50 points landed. */
export async function campaignRate(db: DB, campaignId: string, baselineAt: string | null, remainingPoints: number): Promise<CampaignRate | null> {
  const baselineIso = baselineAt ?? new Date(0).toISOString();
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n, min(r."solvedAt") AS since
    FROM results r
    JOIN sim_campaign_points p ON ${POINT_CELL_JOIN}
    WHERE p.campaign_id = ${campaignId}
      AND NOT p.derived_by_symmetry
      AND r.status = 'done'
      AND r."solvedAt" IS NOT NULL
      AND r."solvedAt" > GREATEST(${baselineIso}::timestamptz, now() - interval '24 hours')
  `)) as unknown as Array<{ n: number; since: Date | string | null }>;
  const pointsLast24h = Number(row?.n ?? 0);
  if (pointsLast24h < 50) return null;
  return {
    pointsLast24h,
    windowHours: 24,
    baselineAt,
    measuredSince: isoOf(row?.since ?? null) ?? new Date().toISOString(),
    remainingPoints,
  };
}

export interface CampaignBacklogStripEntry {
  id: string;
  slug: string;
  name: string;
  status: string;
  priority: number;
  remainingPoints: number;
  failedPoints: number;
  runningPoints: number;
}

/** Queue-page backlog strip: per-non-terminal-campaign remaining work from the
 *  counters table only (no point scans). */
export async function campaignBacklogStrip(db: DB): Promise<CampaignBacklogStripEntry[]> {
  const rows = (await db.execute(sql`
    SELECT c.id, c.slug, c.name, c.status, c.priority,
      COALESCE(sum(pr.requested - pr.solved - pr.derived - pr.failed - pr.rejected), 0)::int AS remaining,
      COALESCE(sum(pr.failed), 0)::int AS failed,
      COALESCE(sum(pr.running), 0)::int AS running
    FROM sim_campaigns c
    LEFT JOIN sim_campaign_progress pr ON pr.campaign_id = c.id
    WHERE c.status IN ('active', 'paused', 'attention')
    GROUP BY c.id
    ORDER BY c.priority DESC, c."createdAt" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    status: String(r.status),
    priority: Number(r.priority),
    remainingPoints: Math.max(0, Number(r.remaining)),
    failedPoints: Number(r.failed),
    runningPoints: Number(r.running),
  }));
}

/** Duplicate → wizard prefill payload; creates nothing (spec §10). */
export async function campaignDuplicatePrefill(db: DB, campaignId: string) {
  const { campaign, plan } = await loadCampaignWithCurrentPlan(db, campaignId);
  const airfoilRows = await db
    .select({ airfoilId: simCampaignAirfoils.airfoilId })
    .from(simCampaignAirfoils)
    .where(eq(simCampaignAirfoils.campaignId, campaignId));
  return {
    name: `${campaign.name} copy`,
    notes: campaign.notes,
    priority: campaign.priority,
    airfoilIds: airfoilRows.map((r) => r.airfoilId),
    plan,
  };
}
