// Simulation-campaign domain module (spec: docs/simulation-campaigns-spec.md
// §5 launch, §6 plan editing/closure/lifecycle, §10 bounded reads).
//
// Framework-free and drizzle-only: the API routes and (later) the sweeper both
// import this module, so it must not reach into Fastify, env, or app state.
// Every write path is transactional and set-based; angle grids are ALWAYS
// generated in TS via @aerodb/core expandAngleGrid (never SQL generate_series).

import { createHash } from "node:crypto";

import {
  AUTO_PRECALC_CONTINUATION_BUDGET_S,
  AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
  DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER,
  DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER,
  MISSING_URANS_VIDEO_REASON,
  URANS_BUDGET_STOP_MARKER,
  URANS_CONTINUATION_REQUIRED_MARKER,
  canonicalAoa,
  canonicalSiString,
  deriveFlowConditionState,
  expandAngleGrid,
  type MediumStateInput,
  type ViscositySpec,
} from "@aerodb/core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import {
  recomputeProgressForCampaign,
  USER_TERMINAL_CAMPAIGN_RESULT_SQL,
} from "./campaign-execution";
import type { DB } from "./client";
import { lockPrecalcCells } from "./precalc-cell-lock";
import {
  solverIncidentSummary,
  type SolverIncidentSummary,
} from "./solver-incidents";
import {
  campaignOpenTierCounts,
  type CampaignPhase,
  campaignReviewBucketRows,
  type CampaignReviewBuckets,
  type CampaignTierCounts,
  deriveCampaignPhase,
  reviewBucketsByCampaign,
} from "./urans-ladder";
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
  simCampaignLifecycleEvents,
  simCampaignLanes,
  simCampaignPlanRevisions,
  simCampaignPoints,
  simCampaignProgress,
  simCampaigns,
  simJobs,
  simPrecalcObligationCampaigns,
  simPrecalcObligations,
  simUransRequestCampaigns,
  simUransRequests,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
  simulationPresetRevisions,
  simulationPresets,
  solverImplementations,
  solverProfiles,
  sweepDefinitions,
} from "./schema";
import {
  ensureSimulationPresetRevision,
  flowConditionCanonicalKey,
  methodCompatibilityHashForSnapshot,
  physicsHashForSnapshot,
  referenceGeometryCanonicalKey,
  resolveSimulationPresetSnapshot,
  type SimulationSetupSnapshot,
} from "./simulation-setup";
import { METHOD_COMPATIBILITY_HASH_VERSION } from "./solver-implementations";

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
export type CampaignErrorCode =
  | "validation"
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "drift";

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
export type CampaignObjectiveId = "ldMax" | "clZero" | "clMax";
export type CampaignObjectiveKey = "ld_max" | "cl_zero" | "cl_max";

export const CAMPAIGN_OBJECTIVES: ReadonlyArray<{
  id: CampaignObjectiveId;
  key: CampaignObjectiveKey;
}> = [
  { id: "ldMax", key: "ld_max" },
  { id: "clZero", key: "cl_zero" },
  { id: "clMax", key: "cl_max" },
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
  objectives: {
    ldMax: CampaignObjectivePlan;
    clZero: CampaignObjectivePlan;
    clMax: CampaignObjectivePlan;
  };
  numerics: {
    boundaryProfileId: string;
    meshProfileId: string;
    uransMeshProfileId: string | null;
    uransPrecalcMeshProfileId: string | null;
    solverProfileId: string;
    outputProfileId: string;
  };
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
  baseSweep: {
    fromDeg?: NumberLike | null;
    toDeg?: NumberLike | null;
    stepDeg?: NumberLike | null;
    listDeg?: NumberLike[] | null;
  };
  objectives: {
    ldMax: { enabled: boolean; toleranceDeg: NumberLike; maxRounds: number };
    clZero: { enabled: boolean; toleranceDeg: NumberLike; maxRounds: number };
    /** Optional for pre-clMax callers/plans: absent means disabled (defaults). */
    clMax?: { enabled: boolean; toleranceDeg: NumberLike; maxRounds: number };
  };
  numerics: {
    boundaryProfileId: string;
    meshProfileId: string;
    uransMeshProfileId?: string | null;
    uransPrecalcMeshProfileId?: string | null;
    solverProfileId: string;
    outputProfileId: string;
  };
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
  if (!Number.isFinite(n) || n <= 0)
    throw new CampaignError(
      "validation",
      `objective tolerance must be > 0 (got ${v})`,
    );
  return n.toFixed(2);
}

/** Canonicalize + structurally validate a plan document. Throws
 *  CampaignError("validation") with an issue list on any failure. */
export function normalizeCampaignPlan(input: CampaignPlanInput): CampaignPlan {
  const issues: CampaignPlanIssue[] = [];
  const push = (path: string, message: string) =>
    issues.push({ path, message });

  if (!input.mediumId || typeof input.mediumId !== "string")
    push("mediumId", "medium is required");

  const ambientPairs = (input.ambients ?? []).map(([t, p]) => {
    const tN = num(t);
    const pN = num(p);
    if (!(Number.isFinite(tN) && tN > 0))
      push("ambients", `temperature must be > 0 K (got ${t})`);
    if (!(Number.isFinite(pN) && pN > 0))
      push("ambients", `pressure must be > 0 Pa (got ${p})`);
    return [
      canonicalSiString("temperatureK", tN),
      canonicalSiString("pressurePa", pN),
    ] as [string, string];
  });
  const ambients = dedupeSorted(
    ambientPairs,
    (a) => `${a[0]}|${a[1]}`,
    (a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]),
  );
  if (ambients.length === 0)
    push("ambients", "at least one ambient (T, P) is required");
  if (ambients.length > CAMPAIGN_MAX_VALUES_PER_AXIS)
    push("ambients", `at most ${CAMPAIGN_MAX_VALUES_PER_AXIS} ambients`);

  const speeds = canonicalAxis(input.speedsMps ?? [], "speedMps", (m) =>
    push("speedsMps", m),
  );
  const chords = canonicalAxis(input.chordsM ?? [], "chordM", (m) =>
    push("chordsM", m),
  );

  const spanN = num(input.spanM);
  if (!(Number.isFinite(spanN) && spanN > 0))
    push("spanM", "span must be > 0 m");
  const spanM = canonicalSiString(
    "spanM",
    Number.isFinite(spanN) && spanN > 0 ? spanN : 1,
  );

  const areaMode = input.areaMode ?? "derived";
  let areaM2: string | null = null;
  if (areaMode === "explicit") {
    if (chords.length > 1)
      push(
        "areaMode",
        "explicit reference area is only allowed while a single chord is selected",
      );
    const areaN = num(input.areaM2 ?? NaN);
    if (!(Number.isFinite(areaN) && areaN > 0))
      push("areaM2", "explicit area mode requires areaM2 > 0");
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
      if (list.length === 0)
        push("baseSweep.listDeg", "angle list must contain at least one angle");
      angleCount = list.length;
      baseSweep = {
        fromDeg: null,
        toDeg: null,
        stepDeg: null,
        listDeg: list.map((a) => a.toFixed(4)),
      };
    } else {
      const grid = expandAngleGrid({
        fromDeg: num(rawSweep.fromDeg ?? NaN),
        toDeg: num(rawSweep.toDeg ?? NaN),
        stepDeg: num(rawSweep.stepDeg ?? NaN),
      });
      if (grid.length === 0)
        push("baseSweep", "base sweep expands to zero angles");
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
    ldMax: normalizeObjective(
      input.objectives?.ldMax,
      "objectives.ldMax",
      push,
    ),
    clZero: normalizeObjective(
      input.objectives?.clZero,
      "objectives.clZero",
      push,
    ),
    // clMax joined the plan shape later: absence is a valid disabled block so
    // pre-clMax clients and replayed payloads keep normalizing byte-stably.
    clMax: input.objectives?.clMax
      ? normalizeObjective(input.objectives.clMax, "objectives.clMax", push)
      : DISABLED_CLMAX_OBJECTIVE,
  };
  if (
    (objectives.ldMax.enabled ||
      objectives.clZero.enabled ||
      objectives.clMax.enabled) &&
    angleCount < 3
  ) {
    push(
      "objectives",
      "refinement objectives require a base sweep of at least 3 angles",
    );
  }

  const numerics = input.numerics ?? ({} as CampaignPlanInput["numerics"]);
  for (const slot of [
    "boundaryProfileId",
    "meshProfileId",
    "solverProfileId",
    "outputProfileId",
  ] as const) {
    if (!numerics?.[slot])
      push(`numerics.${slot}`, "numerics profile is required");
  }
  const optionalNumericProfileId = (
    slot: "uransMeshProfileId" | "uransPrecalcMeshProfileId",
  ): string | null => {
    const value = numerics?.[slot];
    if (value == null) return null;
    if (typeof value !== "string" || value.trim().length === 0) {
      push(
        `numerics.${slot}`,
        "optional numerics profile id must be a non-empty string when set",
      );
      return null;
    }
    return value;
  };
  const uransMeshProfileId = optionalNumericProfileId("uransMeshProfileId");
  const uransPrecalcMeshProfileId = optionalNumericProfileId(
    "uransPrecalcMeshProfileId",
  );

  const comboCount =
    ambients.length * speeds.length * chords.length -
    countApplicableExclusions(ambients, speeds, chords, excluded);
  if (comboCount <= 0)
    push(
      "excludedConditions",
      "every condition combination is excluded — nothing to run",
    );
  if (comboCount > CAMPAIGN_MAX_CONDITIONS)
    push(
      "conditions",
      `plan expands to ${comboCount} conditions (max ${CAMPAIGN_MAX_CONDITIONS})`,
    );

  if (issues.length > 0)
    throw new CampaignError("validation", "campaign plan is invalid", {
      issues,
    });

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
      uransMeshProfileId,
      uransPrecalcMeshProfileId,
      solverProfileId: numerics.solverProfileId,
      outputProfileId: numerics.outputProfileId,
    },
  };
}

/** Canonical disabled Cl_max block (spec §3.1 defaults: ±0.10°, 8 rounds) —
 *  substituted when a plan input predates the third objective. */
const DISABLED_CLMAX_OBJECTIVE: CampaignObjectivePlan = {
  enabled: false,
  toleranceDeg: "0.10",
  maxRounds: 8,
};

function normalizeObjective(
  input:
    | { enabled: boolean; toleranceDeg: NumberLike; maxRounds: number }
    | undefined,
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
  if (!(Number.isInteger(maxRounds) && maxRounds >= 1 && maxRounds <= 50))
    push(`${path}.maxRounds`, "maxRounds must be an integer 1..50");
  return {
    enabled: Boolean(input.enabled),
    toleranceDeg,
    maxRounds: Number.isInteger(maxRounds) ? maxRounds : 8,
  };
}

function canonicalAxis(
  values: NumberLike[],
  kind: "speedMps" | "chordM",
  push: (message: string) => void,
): string[] {
  const canon = values.map((v) => {
    const n = num(v);
    if (!(Number.isFinite(n) && n > 0))
      push(`values must be finite and > 0 (got ${v})`);
    return canonicalSiString(kind, Number.isFinite(n) && n > 0 ? n : 1);
  });
  const out = dedupeSorted(
    canon,
    (x) => x,
    (a, b) => Number(a) - Number(b),
  );
  if (out.length === 0) push("at least one value is required");
  if (out.length > CAMPAIGN_MAX_VALUES_PER_AXIS)
    push(`at most ${CAMPAIGN_MAX_VALUES_PER_AXIS} values per axis`);
  return out;
}

function dedupeSorted<T>(
  items: T[],
  key: (t: T) => string,
  cmp: (a: T, b: T) => number,
): T[] {
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

export function campaignComboKey(
  temperatureK: string,
  pressurePa: string,
  speedMps: string,
  chordM: string,
): string {
  return `${temperatureK}|${pressurePa}|${speedMps}|${chordM}`;
}

/** Ordered (ambient × speed × chord) minus exclusions (spec §3.1/§5). */
export function conditionCombosFromPlan(
  plan: CampaignPlan,
): CampaignConditionCombo[] {
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
    fromDeg:
      plan.baseSweep.fromDeg == null
        ? undefined
        : Number(plan.baseSweep.fromDeg),
    toDeg:
      plan.baseSweep.toDeg == null ? undefined : Number(plan.baseSweep.toDeg),
    stepDeg:
      plan.baseSweep.stepDeg == null
        ? undefined
        : Number(plan.baseSweep.stepDeg),
    listDeg:
      plan.baseSweep.listDeg == null
        ? null
        : plan.baseSweep.listDeg.map(Number),
  });
  return angleSetsFromAngles(angles);
}

export function angleSetsFromAngles(angles: number[]): CampaignAngleSets {
  const canonical = [...new Set(angles.map(canonicalAoa))].sort(
    (a, b) => a - b,
  );
  const negativeAngles = canonical.filter((a) => a < 0);
  const symmetricSolverAngles = [
    ...new Set(canonical.map((a) => canonicalAoa(Math.abs(a)))),
  ].sort((a, b) => a - b);
  return { angles: canonical, negativeAngles, symmetricSolverAngles };
}

/** Per-airfoil obligation sizes for one condition given the angle sets. */
export function campaignPointArithmetic(
  sets: CampaignAngleSets,
  asymmetricCount: number,
  symmetricCount: number,
) {
  // Every requested angle is a point for every airfoil. Symmetric airfoils
  // additionally need mirrored solver cells for negative angles whose |α| is
  // not already in the grid (the derived cell needs a real +α source).
  const gridSet = new Set(sets.angles);
  const extraMirrored = sets.symmetricSolverAngles.filter(
    (a) => !gridSet.has(a),
  ).length;
  const points =
    (asymmetricCount + symmetricCount) * sets.angles.length +
    symmetricCount * extraMirrored;
  const solverRuns =
    asymmetricCount * sets.angles.length +
    symmetricCount * sets.symmetricSolverAngles.length;
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

async function uniqueLegacyBoundarySlug(
  db: DbTx,
  base: string,
): Promise<string> {
  let slug = base;
  let n = 2;
  for (let i = 0; i < 1000; i++) {
    const [exists] = await asDb(db)
      .select({ id: boundaryConditions.id })
      .from(boundaryConditions)
      .where(eq(boundaryConditions.slug, slug))
      .limit(1);
    if (!exists) return slug;
    slug = `${base}-${n++}`;
  }
  return `${base}-${Date.now()}`;
}

/** Sync (create/update) the deprecated boundary_conditions bridge row for a
 *  preset so results.bcId (NOT NULL) always has a target. Identical behavior
 *  to the pre-campaign admin-routes implementation, parameterized on db. */
export async function syncLegacyBoundaryConditionForPreset(
  db: DbTx,
  presetId: string,
): Promise<string | null> {
  const snapshot = await resolveSimulationPresetSnapshot(asDb(db), presetId);
  if (!snapshot) return null;
  const values = legacyBoundaryValuesFromSnapshot(snapshot);
  if (snapshot.preset.legacyBoundaryConditionId) {
    await asDb(db)
      .update(boundaryConditions)
      .set(values)
      .where(
        eq(boundaryConditions.id, snapshot.preset.legacyBoundaryConditionId),
      );
    return snapshot.preset.legacyBoundaryConditionId;
  }
  const slug = await uniqueLegacyBoundarySlug(
    db,
    slugifyCampaign(snapshot.preset.slug || snapshot.preset.name),
  );
  const [legacy] = await asDb(db)
    .insert(boundaryConditions)
    .values({ ...values, slug })
    .returning({ id: boundaryConditions.id });
  await asDb(db)
    .update(simulationPresets)
    .set({ legacyBoundaryConditionId: legacy.id })
    .where(eq(simulationPresets.id, presetId));
  return legacy.id;
}

// ---------------------------------------------------------------------------
// Medium state + value-level registry find-or-create (spec §5.3b)
// ---------------------------------------------------------------------------
interface MediumState {
  medium: Medium;
  stateInput: MediumStateInput;
}

async function loadMediumState(
  db: DbTx,
  mediumId: string,
): Promise<MediumState> {
  const [medium] = await asDb(db)
    .select()
    .from(mediums)
    .where(eq(mediums.id, mediumId))
    .limit(1);
  if (!medium) throw new CampaignError("not_found", "medium not found");
  let viscosity: ViscositySpec;
  if (medium.viscosityModel === "sutherland") {
    if (
      !(medium.sutherlandMuRef && medium.sutherlandTRef && medium.sutherlandS)
    ) {
      throw new CampaignError(
        "validation",
        `medium ${medium.slug} is missing Sutherland coefficients`,
      );
    }
    viscosity = {
      model: "sutherland",
      muRef: medium.sutherlandMuRef,
      tRef: medium.sutherlandTRef,
      s: medium.sutherlandS,
    };
  } else if (medium.viscosityModel === "table") {
    const rows = await asDb(db)
      .select()
      .from(mediumViscosityTablePoints)
      .where(eq(mediumViscosityTablePoints.mediumId, medium.id))
      .orderBy(
        asc(mediumViscosityTablePoints.sortOrder),
        asc(mediumViscosityTablePoints.temperatureK),
      );
    if (rows.length === 0)
      throw new CampaignError(
        "validation",
        `medium ${medium.slug} has an empty viscosity table`,
      );
    viscosity = {
      model: "table",
      tempsK: rows.map((r) => r.temperatureK),
      mu: rows.map((r) => r.dynamicViscosity),
    };
  } else {
    if (
      !(medium.constantDynamicViscosity && medium.constantDynamicViscosity > 0)
    ) {
      throw new CampaignError(
        "validation",
        `medium ${medium.slug} is missing a constant dynamic viscosity`,
      );
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

async function uniqueSlug(
  db: DbTx,
  table:
    | "flow_conditions"
    | "reference_geometry_profiles"
    | "simulation_presets"
    | "sweep_definitions"
    | "scheduling_profiles"
    | "sim_campaigns",
  base: string,
): Promise<string> {
  let slug = base || "item";
  let n = 2;
  for (let i = 0; i < 1000; i++) {
    const rows = (await asDb(db).execute(
      sql`SELECT id FROM ${sql.raw(table)} WHERE slug = ${slug} LIMIT 1`,
    )) as unknown as unknown[];
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
  const canonicalKey = flowConditionCanonicalKey({
    mediumId: mediumState.medium.id,
    temperatureK,
    pressurePa,
    speedMps,
  });
  const [existing] = await asDb(tx)
    .select()
    .from(flowConditions)
    .where(eq(flowConditions.canonicalKey, canonicalKey))
    .limit(1);
  if (existing) return { row: existing, created: false };
  const derived = deriveFlowConditionState(mediumState.stateInput, {
    temperatureK,
    pressurePa,
    speedMps,
  });
  const slug = await uniqueSlug(
    tx,
    "flow_conditions",
    slugifyCampaign(
      `${mediumState.medium.slug}-t${combo.temperatureK}k-p${combo.pressurePa}pa-v${combo.speedMps}ms`,
    ),
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
  const [row] = await asDb(tx)
    .select()
    .from(flowConditions)
    .where(eq(flowConditions.canonicalKey, canonicalKey))
    .limit(1);
  if (!row)
    throw new CampaignError(
      "conflict",
      "flow condition insert race could not be resolved",
    );
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
  const [existing] = await asDb(tx)
    .select()
    .from(referenceGeometryProfiles)
    .where(eq(referenceGeometryProfiles.canonicalKey, canonicalKey))
    .limit(1);
  if (existing) return { row: existing, created: false };
  const slug = await uniqueSlug(
    tx,
    "reference_geometry_profiles",
    slugifyCampaign(
      `chord-${combo.chordM}m-span-${combo.spanM}m${combo.areaM2 ? `-area-${combo.areaM2}m2` : ""}`,
    ),
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
  const [row] = await asDb(tx)
    .select()
    .from(referenceGeometryProfiles)
    .where(eq(referenceGeometryProfiles.canonicalKey, canonicalKey))
    .limit(1);
  if (!row)
    throw new CampaignError(
      "conflict",
      "reference geometry insert race could not be resolved",
    );
  return { row, created: false };
}

// ---------------------------------------------------------------------------
// Physics-hash revision reuse (spec §3.2/§5.3c)
// ---------------------------------------------------------------------------
interface NumericsRows {
  boundary: typeof boundaryProfiles.$inferSelect;
  mesh: typeof meshProfiles.$inferSelect;
  uransMesh: typeof meshProfiles.$inferSelect | null;
  uransPrecalcMesh: typeof meshProfiles.$inferSelect | null;
  solver: typeof solverProfiles.$inferSelect;
  solverImplementation: typeof solverImplementations.$inferSelect;
  output: typeof outputProfiles.$inferSelect;
}

export async function loadNumericsRows(
  db: DbTx,
  numerics: CampaignPlan["numerics"],
): Promise<NumericsRows> {
  const [[boundary], [mesh], [solver], [output]] = await Promise.all([
    asDb(db)
      .select()
      .from(boundaryProfiles)
      .where(eq(boundaryProfiles.id, numerics.boundaryProfileId))
      .limit(1),
    asDb(db)
      .select()
      .from(meshProfiles)
      .where(eq(meshProfiles.id, numerics.meshProfileId))
      .limit(1),
    asDb(db)
      .select()
      .from(solverProfiles)
      .where(eq(solverProfiles.id, numerics.solverProfileId))
      .limit(1),
    asDb(db)
      .select()
      .from(outputProfiles)
      .where(eq(outputProfiles.id, numerics.outputProfileId))
      .limit(1),
  ]);
  if (!boundary)
    throw new CampaignError("not_found", "boundary profile not found");
  if (!mesh) throw new CampaignError("not_found", "mesh profile not found");
  if (!solver) throw new CampaignError("not_found", "solver profile not found");
  if (!output) throw new CampaignError("not_found", "output profile not found");
  const [solverImplementation] = await asDb(db)
    .select()
    .from(solverImplementations)
    .where(eq(solverImplementations.id, solver.solverImplementationId))
    .limit(1);
  if (!solverImplementation)
    throw new CampaignError(
      "not_found",
      "solver implementation for solver profile not found",
    );
  const uransMesh = numerics.uransMeshProfileId
    ? (
        await asDb(db)
          .select()
          .from(meshProfiles)
          .where(eq(meshProfiles.id, numerics.uransMeshProfileId))
          .limit(1)
      )[0]
    : null;
  if (numerics.uransMeshProfileId && !uransMesh)
    throw new CampaignError("not_found", "URANS mesh profile not found");
  const uransPrecalcMesh = numerics.uransPrecalcMeshProfileId
    ? (
        await asDb(db)
          .select()
          .from(meshProfiles)
          .where(eq(meshProfiles.id, numerics.uransPrecalcMeshProfileId))
          .limit(1)
      )[0]
    : null;
  if (numerics.uransPrecalcMeshProfileId && !uransPrecalcMesh)
    throw new CampaignError(
      "not_found",
      "URANS precalc mesh profile not found",
    );
  return {
    boundary,
    mesh,
    uransMesh,
    uransPrecalcMesh,
    solver,
    solverImplementation,
    output,
  };
}

function stripRowMeta<
  T extends { createdAt: Date; updatedAt: Date; isSeeded: boolean },
>(row: T) {
  const { createdAt: _c, updatedAt: _u, isSeeded: _s, ...rest } = row;
  return rest;
}

function stripSolverRowMeta(row: typeof solverProfiles.$inferSelect) {
  const {
    createdAt: _c,
    updatedAt: _u,
    isSeeded: _s,
    solverImplementationId: _implementationId,
    ...rest
  } = row;
  return rest;
}

/** Build the physics-relevant snapshot subset for hashing. The mesh and
 *  optional per-tier URANS mesh blocks are real when present; preset /
 *  scheduling / output / sweep are placeholders that the hash provably ignores
 *  (see simulation-setup.ts). */
function buildPhysicsHashSnapshot(args: {
  flow: typeof flowConditions.$inferSelect;
  medium: Medium;
  geo: typeof referenceGeometryProfiles.$inferSelect;
  numerics: NumericsRows;
}): {
  snapshot: SimulationSetupSnapshot;
  reynolds: number;
  mach: number | null;
} {
  const { flow, medium, geo, numerics } = args;
  const reynolds = Math.round(
    (flow.speedMps * geo.referenceLengthM) / flow.kinematicViscosity,
  );
  const snapshot = {
    preset: {
      id: "",
      slug: "",
      name: "",
      enabled: false,
      legacyBoundaryConditionId: null,
    },
    engine: {
      implementationId: numerics.solverImplementation.id,
      key: numerics.solverImplementation.key,
      family: numerics.solverImplementation.family,
      distribution: numerics.solverImplementation.distribution,
      releaseVersion: numerics.solverImplementation.releaseVersion,
      methodFamily: numerics.solverImplementation.methodFamily,
      adapterContractVersion:
        numerics.solverImplementation.adapterContractVersion,
      numericsRevision: numerics.solverImplementation.numericsRevision,
    },
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
    uransMesh: numerics.uransMesh ? stripRowMeta(numerics.uransMesh) : null,
    uransPrecalcMesh: numerics.uransPrecalcMesh
      ? stripRowMeta(numerics.uransPrecalcMesh)
      : null,
    solver: stripSolverRowMeta(numerics.solver),
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
  methodCompatibilityHash: string;
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
async function ensureCampaignPresetSupport(
  tx: CampaignTx,
  campaignSlug: string,
  plan: CampaignPlan,
  schedulingProfileId?: string,
): Promise<CampaignPresetSupport> {
  let sched: { id: string } | undefined;
  if (schedulingProfileId) {
    [sched] = await asDb(tx)
      .select({ id: schedulingProfiles.id })
      .from(schedulingProfiles)
      .where(eq(schedulingProfiles.id, schedulingProfileId))
      .for("share")
      .limit(1);
    if (!sched)
      throw new CampaignError(
        "validation",
        `scheduling profile ${schedulingProfileId} is unavailable`,
      );
  } else {
    [sched] = await asDb(tx)
      .select({ id: schedulingProfiles.id })
      .from(schedulingProfiles)
      .where(eq(schedulingProfiles.isSeeded, true))
      .orderBy(asc(schedulingProfiles.createdAt))
      .limit(1);
    if (!sched) {
      [sched] = await asDb(tx)
        .select({ id: schedulingProfiles.id })
        .from(schedulingProfiles)
        .orderBy(asc(schedulingProfiles.createdAt))
        .limit(1);
    }
    if (!sched) {
      const slug = await uniqueSlug(tx, "scheduling_profiles", "campaign-auto");
      [sched] = await asDb(tx)
        .insert(schedulingProfiles)
        .values({
          slug,
          name: "Campaign auto scheduling",
          schedulingPolicy: "auto",
        })
        .returning({ id: schedulingProfiles.id });
    }
  }
  const sweepSlugBase = slugifyCampaign(`campaign-${campaignSlug}-sweep`);
  const [existingSweep] = await asDb(tx)
    .select({ id: sweepDefinitions.id })
    .from(sweepDefinitions)
    .where(eq(sweepDefinitions.slug, sweepSlugBase))
    .limit(1);
  if (existingSweep)
    return {
      schedulingProfileId: sched.id,
      sweepDefinitionId: existingSweep.id,
    };
  const list = plan.baseSweep.listDeg?.map(Number) ?? null;
  const [sweep] = await asDb(tx)
    .insert(sweepDefinitions)
    .values({
      slug: sweepSlugBase,
      name: `Campaign ${campaignSlug} base sweep`,
      aoaStart:
        plan.baseSweep.fromDeg != null
          ? Number(plan.baseSweep.fromDeg)
          : list && list.length
            ? Math.min(...list)
            : -8,
      aoaStop:
        plan.baseSweep.toDeg != null
          ? Number(plan.baseSweep.toDeg)
          : list && list.length
            ? Math.max(...list)
            : 20,
      aoaStep:
        plan.baseSweep.stepDeg != null ? Number(plan.baseSweep.stepDeg) : 1,
      aoaList: list,
    })
    .returning({ id: sweepDefinitions.id });
  return { schedulingProfileId: sched.id, sweepDefinitionId: sweep.id };
}

async function lookupRevisionByMethodCompatibilityHash(
  tx: CampaignTx,
  methodCompatibilityHash: string,
) {
  const [found] = await asDb(tx)
    .select({ revision: simulationPresetRevisions, preset: simulationPresets })
    .from(simulationPresetRevisions)
    .innerJoin(
      simulationPresets,
      eq(simulationPresets.id, simulationPresetRevisions.presetId),
    )
    .where(
      and(
        eq(
          simulationPresetRevisions.methodCompatibilityHashVersion,
          METHOD_COMPATIBILITY_HASH_VERSION,
        ),
        eq(
          simulationPresetRevisions.methodCompatibilityHash,
          methodCompatibilityHash,
        ),
      ),
    )
    .orderBy(
      desc(simulationPresetRevisions.isCanonicalMethod),
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
  const { snapshot, reynolds, mach } = buildPhysicsHashSnapshot({
    flow: args.flow,
    medium: args.medium,
    geo: args.geo,
    numerics: args.numerics,
  });
  const physicsHash = physicsHashForSnapshot(snapshot);
  const methodCompatibilityHash = methodCompatibilityHashForSnapshot(snapshot);
  const cached = args.cache.get(methodCompatibilityHash);
  if (cached) return cached;

  // Engine release/numerics identity is part of reuse. Same physical setup
  // solved by OpenCFD and Foundation must never collapse to one revision.
  await asDb(tx).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"campaign-method:" + methodCompatibilityHash}, 0))`,
  );
  // Preserve the legacy physics-canonical election as a compatibility index;
  // exactly one method may own it, while every method gets its own canonical.
  await asDb(tx).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"campaign-physics:" + physicsHash}, 0))`,
  );

  const found = await lookupRevisionByMethodCompatibilityHash(
    tx,
    methodCompatibilityHash,
  );
  if (found) {
    if (!found.revision.isCanonicalMethod) {
      await asDb(tx)
        .update(simulationPresetRevisions)
        .set({ isCanonicalMethod: true })
        .where(eq(simulationPresetRevisions.id, found.revision.id));
    }
    const resolved: ResolvedCampaignRevision = {
      presetId: found.preset.id,
      revisionId: found.revision.id,
      reynolds: found.revision.reynolds,
      mach: found.revision.mach,
      physicsHash,
      methodCompatibilityHash,
      presetCreated: false,
    };
    args.cache.set(methodCompatibilityHash, resolved);
    return resolved;
  }

  const support = await args.support();
  const presetSlug = await uniqueSlug(
    tx,
    "simulation_presets",
    slugifyCampaign(`campaign-${args.campaignSlug}-re${reynolds}`),
  );
  const [preset] = await asDb(tx)
    .insert(simulationPresets)
    .values({
      slug: presetSlug,
      name: `Campaign ${args.campaignName} · ${args.combo.temperatureK} K / ${args.combo.pressurePa} Pa · ${args.combo.speedMps} m/s · ${args.combo.chordM} m`,
      flowConditionId: args.flow.id,
      referenceGeometryProfileId: args.geo.id,
      boundaryProfileId: args.numerics.boundary.id,
      meshProfileId: args.numerics.mesh.id,
      uransMeshProfileId: args.numerics.uransMesh?.id ?? null,
      uransPrecalcMeshProfileId: args.numerics.uransPrecalcMesh?.id ?? null,
      solverProfileId: args.numerics.solver.id,
      schedulingProfileId: support.schedulingProfileId,
      outputProfileId: args.numerics.output.id,
      sweepDefinitionId: support.sweepDefinitionId,
      targetScope: "all",
      origin: "campaign",
      enabled: false,
    })
    .returning();
  const resolvedPreset = await ensureSimulationPresetRevision(
    asDb(tx),
    preset.id,
  );
  if (!resolvedPreset)
    throw new CampaignError(
      "conflict",
      "failed to materialize a preset revision for a campaign condition",
    );
  // Hash the authoritative resolved snapshot (identical inputs → identical
  // hash; recomputing guards against any drift between builders).
  const actualHash = physicsHashForSnapshot(resolvedPreset.snapshot);
  const actualMethodCompatibilityHash = methodCompatibilityHashForSnapshot(
    resolvedPreset.snapshot,
  );
  const [existingPhysicsCanonical] = await asDb(tx)
    .select({ id: simulationPresetRevisions.id })
    .from(simulationPresetRevisions)
    .where(
      and(
        eq(simulationPresetRevisions.physicsHash, actualHash),
        eq(simulationPresetRevisions.isCanonicalPhysics, true),
      ),
    )
    .limit(1);
  await asDb(tx)
    .update(simulationPresetRevisions)
    .set({
      solverImplementationId: resolvedPreset.snapshot.engine!.implementationId,
      physicsHash: actualHash,
      methodCompatibilityHashVersion: METHOD_COMPATIBILITY_HASH_VERSION,
      methodCompatibilityHash: actualMethodCompatibilityHash,
      isCanonicalPhysics: !existingPhysicsCanonical,
      isCanonicalMethod: true,
    })
    .where(eq(simulationPresetRevisions.id, resolvedPreset.revision.id));
  const resolved: ResolvedCampaignRevision = {
    presetId: preset.id,
    revisionId: resolvedPreset.revision.id,
    reynolds: resolvedPreset.revision.reynolds,
    mach: resolvedPreset.revision.mach,
    physicsHash: actualHash,
    methodCompatibilityHash: actualMethodCompatibilityHash,
    presetCreated: true,
  };
  args.cache.set(methodCompatibilityHash, resolved);
  if (actualMethodCompatibilityHash !== methodCompatibilityHash)
    args.cache.set(actualMethodCompatibilityHash, resolved);
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
  const airfoilFilter = opts.airfoilIds
    ? sql`AND ca.airfoil_id = ANY(${pgUuidArray(opts.airfoilIds)}::uuid[])`
    : sql``;
  const insertFor = async (
    angles: number[],
    symmetric: boolean,
    derived: boolean,
  ) => {
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
async function linkPresolvedEvidence(
  tx: CampaignTx,
  campaignId: string,
): Promise<{ linkedSolver: number; linkedDerived: number }> {
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

/** Reconcile fidelity-ladder ownership after launch/plan growth links existing
 * evidence into a campaign. Reused RANS evidence can originate from a
 * background or different campaign job, so it has no campaign parent for the
 * ordinary wave-2 retry scan. Attach any already-open physical work first,
 * then create exact fresh precalc requests for the remaining physical cells.
 *
 * The advisory lock key is identical to createUransRequest: whole-vs-exact
 * overlap and concurrent campaign launches are serialized per physical setup.
 * All writes are set-based and idempotent inside the launch transaction. */
async function reconcileLinkedCampaignLadderWork(
  tx: CampaignTx,
  campaignId: string,
): Promise<void> {
  const db = asDb(tx);
  const candidateSql = sql`
    SELECT p.airfoil_id, p.revision_id, p.aoa_deg::float8 AS aoa_deg, p.result_id
    FROM sim_campaign_points p
    JOIN results r ON r.id = p.result_id
    JOIN result_classifications rc ON rc.result_id = r.id
    WHERE p.campaign_id = ${campaignId}
      AND p.state = 'terminal'
      AND p.derived_by_symmetry = false
      AND r.status = 'done'
      AND (
        rc.state = 'needs_urans'
        OR (
          rc.state = 'rejected'
          AND (
            r.fidelity = 'rans'
            OR (r.fidelity IS NULL AND r.regime IS DISTINCT FROM 'urans')
          )
        )
      )
  `;
  const continuationCandidateSql = sql`
    SELECT p.airfoil_id, p.revision_id, p.aoa_deg::float8 AS aoa_deg,
           r.id AS result_id
    FROM sim_campaign_points p
    JOIN results r ON r.id = p.result_id
    JOIN result_classifications rc ON rc.result_id = r.id
    WHERE p.campaign_id = ${campaignId}
      AND p.state = 'terminal'
      AND p.derived_by_symmetry = false
      AND r.status = 'done'
      AND r.fidelity = 'urans_precalc'
      AND rc.state = 'rejected'
      AND COALESCE(rc.reasons, ARRAY[]::text[])
            <> ARRAY[${MISSING_URANS_VIDEO_REASON}]::text[]
      AND r.engine_job_id IS NOT NULL
      AND r.engine_case_slug IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM unnest(COALESCE(r.quality_warnings, ARRAY[]::text[])) warning
        WHERE warning LIKE ${"%" + URANS_BUDGET_STOP_MARKER + "%"}
           OR warning LIKE ${"%" + URANS_CONTINUATION_REQUIRED_MARKER + "%"}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_urans_requests prior
        LEFT JOIN sim_jobs prior_job ON prior_job.id = prior.sim_job_id
        WHERE prior.continue_from_result_id = r.id
          AND prior.state NOT IN ('pending', 'running')
          AND (
            prior.state = 'done'
            OR prior_job.engine_job_id IS NOT NULL
            OR prior_job."submittedAt" IS NOT NULL
          )
      )
  `;

  await db.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(lock_target.lock_key, 0))
    FROM (
      SELECT DISTINCT
        'urans-request:' || candidate.airfoil_id::text || ':' || candidate.revision_id::text || ':precalc' AS lock_key
      FROM (
        ${candidateSql}
        UNION ALL
        ${continuationCandidateSql}
      ) candidate
      ORDER BY lock_key
    ) lock_target
  `);

  await db.execute(sql`
    INSERT INTO sim_precalc_obligations (
      airfoil_id, revision_id, aoa_deg, source_result_id, state
    )
    SELECT DISTINCT candidate.airfoil_id, candidate.revision_id,
           candidate.aoa_deg, candidate.result_id, 'pending'
    FROM (${candidateSql}) candidate
    ON CONFLICT (airfoil_id, revision_id, aoa_deg) DO UPDATE
      SET source_result_id = COALESCE(sim_precalc_obligations.source_result_id, EXCLUDED.source_result_id),
          "updatedAt" = now()
  `);
  await db.execute(sql`
    INSERT INTO sim_precalc_obligation_campaigns (
      obligation_id, campaign_id, state, cancelled_at
    )
    SELECT DISTINCT obligation.id, ${campaignId}::uuid, 'active', NULL::timestamptz
    FROM (${candidateSql}) candidate
    JOIN sim_precalc_obligations obligation
      ON obligation.airfoil_id = candidate.airfoil_id
     AND obligation.revision_id = candidate.revision_id
     AND obligation.aoa_deg = candidate.aoa_deg
    ON CONFLICT (obligation_id, campaign_id) DO UPDATE
      SET state = 'active', cancelled_at = NULL, "updatedAt" = now()
  `);

  // Verification ownership and the pending-owner healer serialize on the
  // accepted preliminary result. enqueuePrecalcVerifications already takes
  // this same result lock; keep launch/plan-growth reconciliation on the same
  // boundary so a healer can never cancel a queue row between its discovery
  // here and the owner-association insert below.
  await db.execute(sql`
    SELECT r.id
    FROM sim_campaign_points p
    JOIN results r ON r.id = p.result_id
    JOIN result_classifications rc ON rc.result_id = r.id
    WHERE p.campaign_id = ${campaignId}
      AND p.state = 'terminal'
      AND p.derived_by_symmetry = false
      AND r.status = 'done'
      AND r.fidelity = 'urans_precalc'
      AND rc.state = 'accepted'
    ORDER BY r.id
    FOR UPDATE OF r
  `);

  // Contract 4 survives campaign churn: historical done/cancelled queue rows
  // do not satisfy a future campaign that newly links accepted preliminary
  // evidence. Create a fresh campaign-owned physical obligation whenever no
  // open row exists; the partial unique index is the final race guard.
  await db.execute(sql`
    INSERT INTO sim_urans_verify_queue (
      airfoil_id, revision_id, aoa_deg, background_owner, state,
      precalc_result_id
    )
    SELECT DISTINCT p.airfoil_id, p.revision_id, p.aoa_deg,
           false, 'pending', r.id
    FROM sim_campaign_points p
    JOIN results r ON r.id = p.result_id
    JOIN result_classifications rc ON rc.result_id = r.id
    WHERE p.campaign_id = ${campaignId}
      AND p.state = 'terminal'
      AND p.derived_by_symmetry = false
      AND r.status = 'done'
      AND r.fidelity = 'urans_precalc'
      AND rc.state = 'accepted'
      AND NOT EXISTS (
        SELECT 1
        FROM sim_urans_verify_queue open_queue
        WHERE open_queue.airfoil_id = p.airfoil_id
          AND open_queue.revision_id = p.revision_id
          AND open_queue.aoa_deg = p.aoa_deg
          AND open_queue.state IN ('pending', 'running')
      )
    ON CONFLICT (airfoil_id, revision_id, aoa_deg)
      WHERE state IN ('pending', 'running') DO NOTHING
  `);

  // A verification may already exist for a preliminary result linked during
  // plan growth. Attach the campaign instead of creating a duplicate owner.
  await db.execute(sql`
    INSERT INTO sim_urans_verify_queue_campaigns (queue_id, campaign_id, state, cancelled_at)
    SELECT DISTINCT q.id, owner_campaign.id, 'active', NULL::timestamptz
    FROM sim_urans_verify_queue q
    JOIN sim_campaign_points trigger_point
      ON trigger_point.campaign_id = ${campaignId}
     AND trigger_point.airfoil_id = q.airfoil_id
     AND trigger_point.revision_id = q.revision_id
     AND trigger_point.aoa_deg = q.aoa_deg
     AND trigger_point.derived_by_symmetry = false
    JOIN sim_campaign_points owner_point
      ON owner_point.airfoil_id = q.airfoil_id
     AND owner_point.revision_id = q.revision_id
     AND owner_point.aoa_deg = q.aoa_deg
     AND owner_point.state = 'terminal'
     AND owner_point.derived_by_symmetry = false
    JOIN sim_campaigns owner_campaign
      ON owner_campaign.id = owner_point.campaign_id
     AND (
       owner_campaign.status IN ('active', 'attention', 'paused')
       OR (
         owner_campaign.id = ${campaignId}
         AND owner_campaign.status = 'completed'
       )
     )
    WHERE q.state IN ('pending', 'running')
    ON CONFLICT (queue_id, campaign_id) DO UPDATE
      SET state = 'active', cancelled_at = NULL, "updatedAt" = now()
  `);

  // Reused RANS rows with their own campaign wave-1 parent stay on the normal
  // retry path. Only parentless reused evidence needs a fresh exact request.
  await db.execute(sql`
    INSERT INTO sim_urans_requests (
      airfoil_id, revision_id, aoa_deg, fidelity, state, requested_by
    )
    SELECT DISTINCT candidate.airfoil_id, candidate.revision_id,
           candidate.aoa_deg, 'precalc', 'pending',
           ${AUTO_PRECALC_CONTINUATION_REQUESTED_BY}
    FROM (${candidateSql}) candidate
    JOIN sim_precalc_obligations obligation
      ON obligation.airfoil_id = candidate.airfoil_id
     AND obligation.revision_id = candidate.revision_id
     AND obligation.aoa_deg = candidate.aoa_deg
    WHERE NOT EXISTS (
      SELECT 1
      FROM sim_jobs campaign_parent
      WHERE campaign_parent.campaign_id = ${campaignId}
        AND campaign_parent.id = (
          SELECT source_result.sim_job_id
          FROM results source_result
          WHERE source_result.id = candidate.result_id
        )
        AND campaign_parent.wave = 1
    )
      AND obligation.state = 'pending'
      AND obligation.attempt_count < obligation.max_attempts
      AND NOT EXISTS (
        SELECT 1
        FROM sim_urans_requests open_request
        WHERE open_request.airfoil_id = candidate.airfoil_id
          AND open_request.revision_id = candidate.revision_id
          AND open_request.fidelity = 'precalc'
          AND open_request.state IN ('pending', 'running')
          AND (open_request.aoa_deg IS NULL OR open_request.aoa_deg = candidate.aoa_deg)
      )
    ON CONFLICT DO NOTHING
  `);

  // Reused preliminary evidence may owe the same one bounded continuation as
  // an in-place campaign result. A cancelled pre-submit composition did not
  // spend it; a completed or engine-submitted attempt did, globally.
  await db.execute(sql`
    INSERT INTO sim_urans_requests (
      airfoil_id, revision_id, aoa_deg, fidelity, state, requested_by,
      continue_from_result_id, budget_override_s
    )
    SELECT DISTINCT candidate.airfoil_id, candidate.revision_id,
           candidate.aoa_deg, 'precalc', 'pending',
           ${AUTO_PRECALC_CONTINUATION_REQUESTED_BY}, candidate.result_id,
           ${AUTO_PRECALC_CONTINUATION_BUDGET_S}::int
    FROM (${continuationCandidateSql}) candidate
    WHERE NOT EXISTS (
      SELECT 1
      FROM sim_urans_requests open_request
      WHERE open_request.airfoil_id = candidate.airfoil_id
        AND open_request.revision_id = candidate.revision_id
        AND open_request.fidelity = 'precalc'
        AND open_request.state IN ('pending', 'running')
        AND (open_request.aoa_deg IS NULL OR open_request.aoa_deg = candidate.aoa_deg)
    )
    ON CONFLICT DO NOTHING
  `);

  // Both reused and newly-created covering requests become campaign-owned.
  // A pre-existing manual whole request remains independently runnable; its
  // association only records that this campaign is waiting on its coverage.
  await db.execute(sql`
    INSERT INTO sim_urans_request_campaigns (request_id, campaign_id, state, cancelled_at)
    SELECT DISTINCT open_request.id, owner_campaign.id, 'active', NULL::timestamptz
    FROM (${candidateSql}) candidate
    JOIN sim_urans_requests open_request
      ON open_request.airfoil_id = candidate.airfoil_id
     AND open_request.revision_id = candidate.revision_id
     AND open_request.fidelity = 'precalc'
     AND open_request.state IN ('pending', 'running')
     AND (open_request.aoa_deg IS NULL OR open_request.aoa_deg = candidate.aoa_deg)
    JOIN sim_campaign_points owner_point
      ON owner_point.airfoil_id = candidate.airfoil_id
     AND owner_point.revision_id = candidate.revision_id
     AND owner_point.aoa_deg = candidate.aoa_deg
     AND owner_point.state = 'terminal'
     AND owner_point.derived_by_symmetry = false
    JOIN sim_campaigns owner_campaign
      ON owner_campaign.id = owner_point.campaign_id
     AND (
       owner_campaign.status IN ('active', 'attention', 'paused')
       OR (
         owner_campaign.id = ${campaignId}
         AND owner_campaign.status = 'completed'
       )
     )
    ON CONFLICT (request_id, campaign_id) DO UPDATE
      SET state = 'active', cancelled_at = NULL, "updatedAt" = now()
  `);

  // A campaign launched while a bounded same-result continuation is already
  // open must join that physical request even though its source fidelity is
  // preliminary URANS rather than RANS.
  await db.execute(sql`
    INSERT INTO sim_urans_request_campaigns (request_id, campaign_id, state, cancelled_at)
    SELECT DISTINCT open_request.id, owner_campaign.id, 'active', NULL::timestamptz
    FROM (${continuationCandidateSql}) candidate
    JOIN sim_urans_requests open_request
      ON open_request.airfoil_id = candidate.airfoil_id
     AND open_request.revision_id = candidate.revision_id
     AND open_request.fidelity = 'precalc'
     AND open_request.state IN ('pending', 'running')
     AND (open_request.aoa_deg IS NULL OR open_request.aoa_deg = candidate.aoa_deg)
    JOIN sim_campaign_points owner_point
      ON owner_point.result_id = candidate.result_id
     AND owner_point.state = 'terminal'
     AND owner_point.derived_by_symmetry = false
    JOIN sim_campaigns owner_campaign
      ON owner_campaign.id = owner_point.campaign_id
     AND (
       owner_campaign.status IN ('active', 'attention', 'paused')
       OR (
         owner_campaign.id = ${campaignId}
         AND owner_campaign.status = 'completed'
       )
     )
    ON CONFLICT (request_id, campaign_id) DO UPDATE
      SET state = 'active', cancelled_at = NULL, "updatedAt" = now()
  `);
}

/** §5.4 "mark reused points stale & re-solve": flip matching solved results to
 *  stale so the campaign branch treats them as gaps. */
async function markReusedResultsStale(
  tx: CampaignTx,
  campaignId: string,
): Promise<number> {
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
  /** Terminal machine-owned PRECALC obligations whose bounded attempts are
   *  exhausted or deterministically blocked. Disjoint from failed/rejected. */
  blocked: number;
  remaining: number;
}

export type CampaignRemediationReason =
  | "mesh_quality"
  | "precalc_attempts_exhausted"
  | "engine_submit_rejected"
  | "other_unavailable";

export interface CampaignRemediationGroup {
  reason: CampaignRemediationReason;
  state: "repairing" | "blocked";
  /** The system owns both open recovery and terminal unavailability. A
   * terminal automatic outcome is not a request for an operator to change an
   * internal setup. The payload deliberately exposes no raw error or id. */
  owner: "system";
  points: number;
}

export interface CampaignRemediationSummary {
  /** Open deterministic mesh recovery. Excluded from totals.blocked. */
  repairing: number;
  /** Exact sum of every terminal group; conserved with totals.blocked. */
  blocked: number;
  /** Bounded to five stable, user-facing groups and omits zero-count groups. */
  groups: CampaignRemediationGroup[];
}

export interface CampaignRemediationCounters {
  precalcMeshRepairing: number;
  blockedMeshQuality: number;
  blockedPrecalcExhausted: number;
  blockedEngineSubmit: number;
  blockedOther: number;
}

/** Pure wire-model builder shared by list/detail reads and unit tests. Raw
 * errors, result ids, obligation ids, and batch internals never cross this
 * boundary. */
export function buildCampaignRemediationSummary(
  counters: CampaignRemediationCounters,
): CampaignRemediationSummary {
  const entries: Array<CampaignRemediationGroup> = [
    {
      reason: "mesh_quality",
      state: "repairing",
      owner: "system",
      points: counters.precalcMeshRepairing,
    },
    {
      reason: "mesh_quality",
      state: "blocked",
      owner: "system",
      points: counters.blockedMeshQuality,
    },
    {
      reason: "precalc_attempts_exhausted",
      state: "blocked",
      owner: "system",
      points: counters.blockedPrecalcExhausted,
    },
    {
      reason: "engine_submit_rejected",
      state: "blocked",
      owner: "system",
      points: counters.blockedEngineSubmit,
    },
    {
      reason: "other_unavailable",
      state: "blocked",
      owner: "system",
      points: counters.blockedOther,
    },
  ];
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.points) || entry.points < 0) {
      throw new Error(
        `invalid campaign remediation count for ${entry.state}:${entry.reason}`,
      );
    }
  }
  return {
    repairing: counters.precalcMeshRepairing,
    blocked:
      counters.blockedMeshQuality +
      counters.blockedPrecalcExhausted +
      counters.blockedEngineSubmit +
      counters.blockedOther,
    groups: entries.filter((entry) => entry.points > 0),
  };
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
 *                AND classification is explicitly accepted/needs_urans/
 *                superseded_by_urans
 *   - rejected:  state = 'terminal' AND NOT derived AND result.status = 'done'
 *                AND result_classifications.state = 'rejected'
 *   - failed:    state = 'terminal' AND NOT derived AND result.status = 'failed'
 *                for terminal URANS evidence only; rejected/failed steady RANS
 *                remains unfinished automatic-handoff work
 *                (a failed source's mirror is counted in `derived`, NOT here —
 *                counting it in both double-books the cell in the remaining
 *                arithmetic and makes the failed chip exceed its Points-tab
 *                click-through list, which lists source rows only)
 *   - running:   state = 'requested' AND live-cell result.status IN (queued, running)
 *                with a submitted/running/ingesting owning sim_job; ownerless
 *                or terminal-job queue residue remains waiting work
 *   - superseded: result_classifications.state = 'superseded_by_urans'
 *   - derived:   terminal mirror only when its linked source classification
 *                is explicitly usable and its source obligation is not blocked
 *   - blocked:   blocked PRECALC cells and their mirrors, plus terminal
 *                unclassified/unrecognized evidence and unavailable mirrors;
 *                takes precedence over failed/rejected
 *                remaining = requested - solved - derived - failed - rejected
 *                            - blocked
 *                stays balanced
 *  (result joined ON r.id = p.result_id; live joined ON the cell key.)
 *
 *  This wrapper additionally DELETEs the campaign's progress rows first so that
 *  (condition, airfoil) keys whose points were removed by a plan edit lose their
 *  stale counter row — the transactional launch/plan-edit callers rely on this
 *  DELETE-then-recompute cleanup (the reconciler prunes vanished rows out of
 *  band; here we must prune synchronously). The delegate's INSERT...ON CONFLICT
 *  then repopulates every surviving key from scratch. */
export async function recomputeCampaignProgress(
  tx: CampaignTx,
  campaignId: string,
): Promise<void> {
  await asDb(tx).execute(
    sql`DELETE FROM sim_campaign_progress WHERE campaign_id = ${campaignId}`,
  );
  await recomputeProgressForCampaign(asDb(tx), campaignId);
}

interface CampaignProgressSnapshot {
  totals: CampaignProgressTotals;
  remediation: CampaignRemediationSummary;
}

async function campaignProgressSnapshot(
  db: DbTx,
  campaignId: string,
): Promise<CampaignProgressSnapshot> {
  const [row] = (await asDb(db).execute(sql`
    SELECT
      COALESCE(sum(requested), 0)::int AS requested,
      COALESCE(sum(solved), 0)::int AS solved,
      COALESCE(sum(failed), 0)::int AS failed,
      COALESCE(sum(running), 0)::int AS running,
      COALESCE(sum(superseded), 0)::int AS superseded,
      COALESCE(sum(derived), 0)::int AS derived,
      COALESCE(sum(rejected), 0)::int AS rejected,
      COALESCE(sum(blocked), 0)::int AS blocked,
      COALESCE(sum(precalc_mesh_repairing), 0)::int AS precalc_mesh_repairing,
      COALESCE(sum(blocked_mesh_quality), 0)::int AS blocked_mesh_quality,
      COALESCE(sum(blocked_precalc_exhausted), 0)::int AS blocked_precalc_exhausted,
      COALESCE(sum(blocked_engine_submit), 0)::int AS blocked_engine_submit,
      COALESCE(sum(blocked_other), 0)::int AS blocked_other
    FROM sim_campaign_progress progress
    JOIN sim_campaign_conditions condition ON condition.id = progress.condition_id
    JOIN sim_campaigns campaign ON campaign.id = progress.campaign_id
    WHERE progress.campaign_id = ${campaignId}
      AND condition.generation = campaign.current_condition_generation
  `)) as unknown as Array<
    Omit<CampaignProgressTotals, "remaining"> & {
      precalc_mesh_repairing: number;
      blocked_mesh_quality: number;
      blocked_precalc_exhausted: number;
      blocked_engine_submit: number;
      blocked_other: number;
    }
  >;
  const totals = row ?? {
    requested: 0,
    solved: 0,
    failed: 0,
    running: 0,
    superseded: 0,
    derived: 0,
    rejected: 0,
    blocked: 0,
    precalc_mesh_repairing: 0,
    blocked_mesh_quality: 0,
    blocked_precalc_exhausted: 0,
    blocked_engine_submit: 0,
    blocked_other: 0,
  };
  const normalizedTotals: CampaignProgressTotals = {
    requested: Number(totals.requested),
    solved: Number(totals.solved),
    failed: Number(totals.failed),
    running: Number(totals.running),
    superseded: Number(totals.superseded),
    derived: Number(totals.derived),
    rejected: Number(totals.rejected),
    blocked: Number(totals.blocked),
    remaining: Math.max(
      0,
      Number(totals.requested) -
        Number(totals.solved) -
        Number(totals.derived) -
        Number(totals.failed) -
        Number(totals.rejected) -
        Number(totals.blocked),
    ),
  };
  const remediation = buildCampaignRemediationSummary({
    precalcMeshRepairing: Number(totals.precalc_mesh_repairing),
    blockedMeshQuality: Number(totals.blocked_mesh_quality),
    blockedPrecalcExhausted: Number(totals.blocked_precalc_exhausted),
    blockedEngineSubmit: Number(totals.blocked_engine_submit),
    blockedOther: Number(totals.blocked_other),
  });
  if (remediation.blocked !== normalizedTotals.blocked) {
    throw new Error(
      `campaign ${campaignId} blocked remediation counters do not conserve the headline total`,
    );
  }
  return { totals: normalizedTotals, remediation };
}

export async function campaignProgressTotals(
  db: DbTx,
  campaignId: string,
): Promise<CampaignProgressTotals> {
  return (await campaignProgressSnapshot(db, campaignId)).totals;
}

/** Completion-state derivation (spec §6.4): every obligated cell settled and
 *  zero failed/rejected/blocked → completed; settled with failures,
 *  physics-rejected evidence, or machine-blocked PRECALC work
 *  points → attention (a rejected point is settled but NOT solved work); else
 *  active. */
export function deriveCampaignCompletion(
  totals: CampaignProgressTotals,
): "active" | "attention" | "completed" {
  if (totals.requested > 0 && totals.remaining <= 0)
    return totals.failed > 0 || totals.rejected > 0 || totals.blocked > 0
      ? "attention"
      : "completed";
  return "active";
}

/** Re-derive campaign status from counters. Only transitions between
 *  active/attention/completed; paused/cancelled/archived are verb-owned. */
export async function refreshCampaignCompletion(
  tx: CampaignTx,
  campaignId: string,
): Promise<CampaignProgressTotals> {
  const totals = await campaignProgressTotals(tx, campaignId);
  const [campaign] = await asDb(tx)
    .select()
    .from(simCampaigns)
    .where(eq(simCampaigns.id, campaignId))
    .limit(1);
  if (!campaign) return totals;
  if (!["active", "attention", "completed"].includes(campaign.status))
    return totals;
  let next = deriveCampaignCompletion(totals);
  if (next !== "active") {
    // Fidelity ladder (contract 7): completion flips only when ALL THREE tiers
    // are terminal — open precalc obligations (needs_urans verdicts / live
    // wave-2 re-solves) or open verify-queue items keep the campaign active,
    // matching probeCampaignCompletion's early return.
    const tiers = await campaignOpenTierCounts(asDb(tx), campaignId);
    if (tiers.precalcOpen > 0 || tiers.verifyOpen > 0) next = "active";
  }
  if (
    next !== campaign.status ||
    (next === "completed") !== Boolean(campaign.completedAt)
  ) {
    await asDb(tx)
      .update(simCampaigns)
      .set({
        status: next,
        completedAt:
          next === "completed" ? (campaign.completedAt ?? new Date()) : null,
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
  const conditionFilter = opts.conditionIds
    ? sql`AND cc.id = ANY(${pgUuidArray(opts.conditionIds)}::uuid[])`
    : sql`AND cc.status = 'active'`;
  const airfoilFilter = opts.airfoilIds
    ? sql`AND ca.airfoil_id = ANY(${pgUuidArray(opts.airfoilIds)}::uuid[])`
    : sql``;
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
async function deleteReleasedPendingResults(
  tx: CampaignTx,
  campaignId: string,
): Promise<{ deleted: number; staled: number }> {
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
      OR (
        r.status = 'queued'
        AND r.sim_job_id IS NULL
        AND (
          (r.fidelity = 'urans_precalc' AND r.auto_retried_at IS NOT NULL)
          OR (
            r.fidelity = 'rans'
            AND EXISTS (
              SELECT 1 FROM result_classifications routed_rc
              WHERE routed_rc.result_id = r.id
                AND routed_rc.state IN ('needs_urans', 'rejected')
            )
          )
        )
      )
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
  /** Explicit execution-support row; excluded from the physical plan. */
  schedulingProfileId?: string;
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
    schedulingProfileId?: string;
  },
): Promise<ResolvedConditionSetup[]> {
  const mediumState = await loadMediumState(tx, args.plan.mediumId);
  const numerics = await loadNumericsRows(tx, args.plan.numerics);
  const cache = new Map<string, ResolvedCampaignRevision>();
  let support: CampaignPresetSupport | null = null;
  const supportLoader = async () => {
    if (!support)
      support = await ensureCampaignPresetSupport(
        tx,
        args.campaignSlug,
        args.plan,
        args.schedulingProfileId,
      );
    return support;
  };
  const out: ResolvedConditionSetup[] = [];
  for (const combo of args.combos) {
    const flow = await findOrCreateFlowCondition(
      tx,
      args.campaignId,
      mediumState,
      combo,
    );
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

async function validateCampaignAirfoils(
  db: DbTx,
  airfoilIds: string[],
): Promise<Array<{ id: string; isSymmetric: boolean }>> {
  const unique = [...new Set(airfoilIds)];
  if (unique.length === 0)
    throw new CampaignError("validation", "at least one airfoil is required");
  const rows = await asDb(db)
    .select({ id: airfoils.id, isSymmetric: airfoils.isSymmetric })
    .from(airfoils)
    .where(
      and(inArray(airfoils.id, unique), sql`${airfoils.deletedAt} IS NULL`),
    );
  if (rows.length !== unique.length) {
    throw new CampaignError(
      "validation",
      `one or more airfoils are unavailable (${rows.length}/${unique.length} found)`,
    );
  }
  return rows;
}

/** The §5 launch transaction. Idempotent by idempotencyKey (replay returns the
 *  existing campaign). */
export async function materializeCampaignLaunch(
  db: DB,
  input: CampaignLaunchInput,
): Promise<CampaignLaunchResult> {
  const plan = normalizeCampaignPlan(input.plan);
  if (!input.idempotencyKey || input.idempotencyKey.length < 8) {
    throw new CampaignError(
      "validation",
      "idempotencyKey is required (min 8 chars)",
    );
  }
  if (
    !(
      Number.isInteger(input.priority) &&
      input.priority >= 0 &&
      input.priority <= 9
    )
  ) {
    throw new CampaignError("validation", "priority must be an integer 0..9");
  }
  if (!input.name?.trim())
    throw new CampaignError("validation", "name is required");

  return db.transaction(async (tx) => {
    // Serialize launches: replay-safe idempotency, slug allocation, and
    // canonical-physics election all become race-free (launches are rare
    // admin operations; one lock is cheaper than per-row conflict recovery).
    await asDb(tx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('sim-campaign-launch', 0))`,
    );

    const [existing] = await asDb(tx)
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (existing) {
      const totals = await campaignProgressTotals(tx, existing.id);
      const [conditionCount] = (await asDb(tx).execute(
        sql`SELECT count(*)::int AS n FROM sim_campaign_conditions WHERE campaign_id = ${existing.id} AND generation = ${existing.currentConditionGeneration}`,
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
    const slug = await uniqueSlug(
      tx,
      "sim_campaigns",
      slugifyCampaign(input.name),
    );
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
      schedulingProfileId: input.schedulingProfileId,
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
    await asDb(tx)
      .update(simCampaigns)
      .set({ currentPlanRevisionId: planRevision.id })
      .where(eq(simCampaigns.id, campaign.id));

    await asDb(tx)
      .insert(simCampaignAirfoils)
      .values(
        airfoilRows.map((a) => ({ campaignId: campaign.id, airfoilId: a.id })),
      )
      .onConflictDoNothing();

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
    await reconcileLinkedCampaignLadderWork(tx, campaign.id);

    await recomputeCampaignProgress(tx, campaign.id);
    await ensureCampaignLanes(tx, campaign.id, plan);
    const totals = await refreshCampaignCompletion(tx, campaign.id);

    const [finalCampaign] = await asDb(tx)
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaign.id))
      .limit(1);
    return {
      campaign: finalCampaign,
      replayed: false,
      totals,
      conditionCount: setups.length,
      presetsCreated: setups.filter((s) => s.presetCreated).length,
      presetsReused:
        presetIds.length -
        new Set(setups.filter((s) => s.presetCreated).map((s) => s.presetId))
          .size,
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
export async function previewCampaignReuse(
  db: DB,
  input: CampaignReusePreviewInput,
): Promise<CampaignReusePreview> {
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
      const combosByRevision = new Map<
        string,
        CampaignReusePreviewCondition[]
      >();
      for (const combo of combos) {
        const temperatureK = Number(combo.temperatureK);
        const pressurePa = Number(combo.pressurePa);
        const speedMps = Number(combo.speedMps);
        const chordM = Number(combo.chordM);
        const flowKey = flowConditionCanonicalKey({
          mediumId: plan.mediumId,
          temperatureK,
          pressurePa,
          speedMps,
        });
        const geoKey = referenceGeometryCanonicalKey({
          geometryType: "airfoil_2d",
          referenceLengthKind: "chord",
          referenceLengthM: chordM,
          spanM: Number(combo.spanM),
          referenceAreaM2: combo.areaM2 == null ? null : Number(combo.areaM2),
        });
        const [flowRow] = await asDb(tx)
          .select()
          .from(flowConditions)
          .where(eq(flowConditions.canonicalKey, flowKey))
          .limit(1);
        const [geoRow] = await asDb(tx)
          .select()
          .from(referenceGeometryProfiles)
          .where(eq(referenceGeometryProfiles.canonicalKey, geoKey))
          .limit(1);
        const derived = deriveFlowConditionState(mediumState.stateInput, {
          temperatureK,
          pressurePa,
          speedMps,
        });
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
        const { snapshot, reynolds } = buildPhysicsHashSnapshot({
          flow,
          medium: mediumState.medium,
          geo,
          numerics,
        });
        const hash = methodCompatibilityHashForSnapshot(snapshot);
        const found = await lookupRevisionByMethodCompatibilityHash(tx, hash);
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
            for (const a of sets.symmetricSolverAngles)
              if (solved.has(a)) solvedForRevision++;
            for (const a of sets.negativeAngles)
              if (solved.has(canonicalAoa(-a))) solvedForRevision++;
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
    if (
      (e as { code?: string }).code === "57014" ||
      /statement timeout/i.test((e as Error).message ?? "")
    ) {
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
  changes: Array<
    | "enabled"
    | "disabled"
    | "tolerance_tightened"
    | "tolerance_loosened"
    | "rounds_changed"
  >;
  toleranceDeg: string;
}

export interface PlanChangeClassification {
  basePlanRevisionNumber: number;
  newPlan: CampaignPlan;
  diffHash: string;
  addedConditions: Array<{
    comboKey: string;
    temperatureK: string;
    pressurePa: string;
    speedMps: string;
    chordM: string;
  }>;
  reactivatedConditions: Array<{
    conditionId: string;
    comboKey: string;
    previousStatus: string;
  }>;
  keptConditions: Array<{
    conditionId: string;
    comboKey: string;
    solvedAngles: number[];
    releasedPoints: number;
    keptOpenPoints: number;
  }>;
  releasedConditions: Array<{
    conditionId: string;
    comboKey: string;
    releasedPoints: number;
  }>;
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
    .select({
      cc: simCampaignConditions,
      flow: flowConditions,
      geo: referenceGeometryProfiles,
    })
    .from(simCampaignConditions)
    .innerJoin(
      flowConditions,
      eq(flowConditions.id, simCampaignConditions.flowConditionId),
    )
    .innerJoin(
      referenceGeometryProfiles,
      eq(
        referenceGeometryProfiles.id,
        simCampaignConditions.referenceGeometryProfileId,
      ),
    )
    .innerJoin(
      simCampaigns,
      eq(simCampaigns.id, simCampaignConditions.campaignId),
    )
    .where(
      and(
        eq(simCampaignConditions.campaignId, campaignId),
        eq(
          simCampaignConditions.generation,
          simCampaigns.currentConditionGeneration,
        ),
      ),
    )
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

async function loadCampaignWithCurrentPlan(
  db: DbTx,
  campaignId: string,
  opts: { forUpdate?: boolean } = {},
) {
  const campaignQuery = asDb(db)
    .select()
    .from(simCampaigns)
    .where(eq(simCampaigns.id, campaignId))
    .limit(1);
  const [campaign] = opts.forUpdate
    ? await campaignQuery.for("update")
    : await campaignQuery;
  if (!campaign) throw new CampaignError("not_found", "campaign not found");
  if (!campaign.currentPlanRevisionId)
    throw new CampaignError("invalid_state", "campaign has no plan revision");
  const [revision] = await asDb(db)
    .select()
    .from(simCampaignPlanRevisions)
    .where(eq(simCampaignPlanRevisions.id, campaign.currentPlanRevisionId))
    .limit(1);
  if (!revision)
    throw new CampaignError(
      "invalid_state",
      "campaign plan revision is missing",
    );
  return { campaign, revision, plan: revision.plan as unknown as CampaignPlan };
}

function axisDiff(
  oldValues: string[],
  newValues: string[],
): { added: string[]; removed: string[] } {
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
): Promise<{
  campaign: typeof simCampaigns.$inferSelect;
  currentPlan: CampaignPlan;
  currentRevisionNumber: number;
  classification: PlanChangeClassification;
}> {
  const {
    campaign,
    revision,
    plan: currentPlan,
  } = await loadCampaignWithCurrentPlan(db, campaignId);
  const newPlan = normalizeCampaignPlan(newPlanInput);
  if (newPlan.mediumId !== currentPlan.mediumId) {
    throw new CampaignError(
      "validation",
      "the medium is fixed once launched — duplicate this campaign to change it",
    );
  }

  const condRows = await loadCampaignConditionCombos(db, campaignId);
  const byKey = new Map(condRows.map((r) => [r.comboKey, r]));
  const newCombos = conditionCombosFromPlan(newPlan);
  const newKeys = new Set(newCombos.map((c) => c.comboKey));

  const addedCombos = newCombos.filter((c) => !byKey.has(c.comboKey));
  const reactivated = condRows.filter(
    (r) => r.condition.status !== "active" && newKeys.has(r.comboKey),
  );
  const stayActive = condRows.filter(
    (r) => r.condition.status === "active" && newKeys.has(r.comboKey),
  );
  const removedActive = condRows.filter(
    (r) => r.condition.status === "active" && !newKeys.has(r.comboKey),
  );

  const oldSets = campaignAngleSets(currentPlan);
  const newSets = campaignAngleSets(newPlan);
  const oldAngleSet = new Set(oldSets.angles);
  const newAngleSet = new Set(newSets.angles);
  const addedAngles = newSets.angles.filter((a) => !oldAngleSet.has(a));
  const removedAngles = oldSets.angles.filter((a) => !newAngleSet.has(a));
  const deltaSets: CampaignAngleSets = {
    angles: addedAngles,
    negativeAngles: newSets.negativeAngles.filter(
      (a) => !new Set(oldSets.negativeAngles).has(a),
    ),
    symmetricSolverAngles: newSets.symmetricSolverAngles.filter(
      (a) => !new Set(oldSets.symmetricSolverAngles).has(a),
    ),
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
  const cellCovered = (
    solved: Set<number> | undefined,
    aoa: number,
    derived: boolean,
  ): boolean => {
    if (!solved) return false;
    return derived ? solved.has(canonicalAoa(-aoa)) : solved.has(aoa);
  };

  const keptConditions: PlanChangeClassification["keptConditions"] = [];
  const releasedConditions: PlanChangeClassification["releasedConditions"] = [];
  const releasedCellConditionIds: string[] = [];
  const releasedCellAoas: number[] = [];
  const releasedCellDerived: boolean[] = [];
  const pushReleasedCell = (
    conditionId: string,
    aoa: number,
    derived: boolean,
  ) => {
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
      releasedConditions.push({
        conditionId: row.condition.id,
        comboKey: row.comboKey,
        releasedPoints,
      });
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
      if (row.state === "released")
        releasedByCondition.set(row.condition_id, Number(row.n));
      else
        nonReleasedByCondition.set(
          row.condition_id,
          (nonReleasedByCondition.get(row.condition_id) ?? 0) + Number(row.n),
        );
    }
    for (const id of reactivatedIds) {
      const target = fullPerCondition.points;
      const nonReleased = nonReleasedByCondition.get(id) ?? 0;
      const released = releasedByCondition.get(id) ?? 0;
      reactivatedPoints += Math.min(
        released,
        Math.max(0, target - nonReleased),
      );
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
    const allAdded = [
      ...new Set([
        ...deltaSets.angles,
        ...deltaSets.symmetricSolverAngles,
        ...deltaSets.negativeAngles,
      ]),
    ];
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
    // Stored plan revisions that predate the clMax objective have no block for
    // it — semantically identical to a disabled block with the defaults.
    const oldObj =
      currentPlan.objectives[objective.id] ?? DISABLED_CLMAX_OBJECTIVE;
    const newObj = newPlan.objectives[objective.id];
    const changes: PlanChangeObjectiveDelta["changes"] = [];
    if (!oldObj.enabled && newObj.enabled) changes.push("enabled");
    if (oldObj.enabled && !newObj.enabled) changes.push("disabled");
    if (Number(newObj.toleranceDeg) < Number(oldObj.toleranceDeg))
      changes.push("tolerance_tightened");
    if (Number(newObj.toleranceDeg) > Number(oldObj.toleranceDeg))
      changes.push("tolerance_loosened");
    if (newObj.maxRounds !== oldObj.maxRounds) changes.push("rounds_changed");
    if (changes.length > 0)
      objectiveDeltas.push({
        objective: objective.key,
        changes,
        toleranceDeg: newObj.toleranceDeg,
      });
  }

  const valueDiffs = {
    ambients: axisDiff(
      currentPlan.ambients.map((a) => a.join("|")),
      newPlan.ambients.map((a) => a.join("|")),
    ),
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
    kept: keptConditions.map((c) => ({
      key: c.comboKey,
      solvedAngles: c.solvedAngles,
      releasedPoints: c.releasedPoints,
    })),
    released: releasedConditions.map((c) => ({
      key: c.comboKey,
      releasedPoints: c.releasedPoints,
    })),
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
    reactivatedConditions: reactivated.map((r) => ({
      conditionId: r.condition.id,
      comboKey: r.comboKey,
      previousStatus: r.condition.status,
    })),
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
  return {
    campaign,
    currentPlan,
    currentRevisionNumber: revision.revisionNumber,
    classification,
  };
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
        addedConditions:
          cls.addedConditions.length + cls.reactivatedConditions.length,
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
  await asDb(tx)
    .update(simCampaigns)
    .set({ currentPlanRevisionId: planRevision.id })
    .where(eq(simCampaigns.id, campaign.id));

  // New conditions (value-level find-or-create + physics pinning, §5 machinery).
  if (cls.internal.addedCombos.length > 0) {
    const combos = cls.internal.addedCombos.map((combo, i) => ({
      ...combo,
      ord: cls.internal.maxOrd + 1 + i,
    }));
    const setups = await resolveConditionSetups(tx, {
      campaignId: campaign.id,
      campaignName: campaign.name,
      campaignSlug: campaign.slug,
      plan: cls.newPlan,
      combos,
    });
    const presetIds = [...new Set(setups.map((s) => s.presetId))];
    for (const presetId of presetIds)
      await syncLegacyBoundaryConditionForPreset(tx, presetId);
    await asDb(tx)
      .insert(simCampaignConditions)
      .values(
        setups.map((s) => ({
          campaignId: campaign.id,
          ord: s.combo.ord,
          generation: campaign.currentConditionGeneration,
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
      .where(
        inArray(simCampaignConditions.id, cls.internal.reactivatedConditionIds),
      );
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
      .set({
        status: "released",
        statusChangedInPlanRevisionId: planRevision.id,
      })
      .where(
        inArray(simCampaignConditions.id, cls.internal.releasedConditionIds),
      );
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
      ? (
          (await asDb(tx)
            .select({ id: simCampaignConditions.id })
            .from(simCampaignConditions)
            .where(
              and(
                eq(simCampaignConditions.campaignId, campaign.id),
                eq(
                  simCampaignConditions.introducedInPlanRevisionId,
                  planRevision.id,
                ),
              ),
            )) as Array<{ id: string }>
        ).map((r) => r.id)
      : [];
  await reactivateReleasedPoints(
    tx,
    campaign.id,
    nextRevisionNumber,
    cls.internal.newSets,
    [...fullTargets, ...cls.internal.stayActiveConditionIds],
  );
  if (fullTargets.length + newConditionIds.length > 0) {
    await insertCampaignPoints(
      tx,
      campaign.id,
      nextRevisionNumber,
      cls.internal.newSets,
      {
        conditionIds: [...fullTargets, ...newConditionIds],
      },
    );
  }
  if (
    cls.internal.stayActiveConditionIds.length > 0 &&
    cls.internal.deltaSets.angles.length +
      cls.internal.deltaSets.symmetricSolverAngles.length >
      0
  ) {
    await insertCampaignPoints(
      tx,
      campaign.id,
      nextRevisionNumber,
      cls.internal.deltaSets,
      {
        conditionIds: cls.internal.stayActiveConditionIds,
      },
    );
  }
  await linkPresolvedEvidence(tx, campaign.id);
  await reconcileLinkedCampaignLadderWork(tx, campaign.id);

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
        AND cc.generation = ${campaign.currentConditionGeneration}
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
  args: {
    campaignId: string;
    basePlanRevisionNumber: number;
    diffHash: string;
    newPlan: CampaignPlanInput;
    createdBy?: string | null;
  },
): Promise<PlanEditResult> {
  return db.transaction(async (tx) => {
    const { campaign, revision } = await loadCampaignWithCurrentPlan(
      tx,
      args.campaignId,
      { forUpdate: true },
    );
    if (
      !["active", "paused", "attention", "completed"].includes(campaign.status)
    ) {
      throw new CampaignError(
        "invalid_state",
        `campaign is ${campaign.status} — plan edits are not allowed`,
      );
    }
    if (revision.revisionNumber !== args.basePlanRevisionNumber) {
      return {
        status: "conflict" as const,
        currentPlanRevisionNumber: revision.revisionNumber,
      };
    }
    const { classification } = await classifyPlanChange(
      tx,
      args.campaignId,
      args.newPlan,
    );
    if (classification.diffHash !== args.diffHash) {
      return { status: "stale_diff" as const, diff: classification };
    }
    return applyPlanEditCore(
      tx,
      campaign,
      revision.revisionNumber,
      classification,
      "edit",
      args.createdBy,
    );
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
  perCondition: Array<{
    conditionId: string;
    status: string;
    cellCount: number;
  }>;
}

export type AddAirfoilsResult =
  | {
      status: "applied";
      addedAirfoils: number;
      addedPoints: number;
      totals: CampaignProgressTotals;
    }
  | { status: "stale_diff"; preview: AddAirfoilsPreview };

async function buildAddAirfoilsPreview(
  db: DbTx,
  campaignId: string,
  airfoilIds: string[],
): Promise<AddAirfoilsPreview> {
  await loadCampaignWithCurrentPlan(db, campaignId);
  const candidates = await validateCampaignAirfoils(db, airfoilIds);
  const existing = await asDb(db)
    .select({ airfoilId: simCampaignAirfoils.airfoilId })
    .from(simCampaignAirfoils)
    .where(eq(simCampaignAirfoils.campaignId, campaignId));
  const existingSet = new Set(existing.map((r) => r.airfoilId));
  const newAirfoils = candidates.filter((a) => !existingSet.has(a.id));
  const alreadyIncluded = candidates
    .filter((a) => existingSet.has(a.id))
    .map((a) => a.id);

  // Inherited work = the campaign's obligated cell set: active conditions'
  // full requested cells AND kept conditions' remaining (solved-angle) cells.
  const cellRows = (await asDb(db).execute(sql`
    SELECT p.condition_id, cc.status, p.aoa_deg::float8 AS aoa
    FROM sim_campaign_points p
    JOIN sim_campaign_conditions cc ON cc.id = p.condition_id
    WHERE p.campaign_id = ${campaignId} AND p.state <> 'released' AND cc.status IN ('active', 'kept')
    GROUP BY p.condition_id, cc.status, p.aoa_deg
  `)) as unknown as Array<{
    condition_id: string;
    status: string;
    aoa: number;
  }>;
  const cellsByCondition = new Map<
    string,
    { status: string; angles: number[] }
  >();
  for (const row of cellRows) {
    const bucket = cellsByCondition.get(row.condition_id) ?? {
      status: row.status,
      angles: [],
    };
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
    perCondition.push({
      conditionId,
      status: bucket.status,
      cellCount: bucket.angles.length,
    });
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

export async function previewAddCampaignAirfoils(
  db: DB,
  campaignId: string,
  airfoilIds: string[],
): Promise<AddAirfoilsPreview> {
  return buildAddAirfoilsPreview(db, campaignId, airfoilIds);
}

/** Junction inserts + points for active AND kept work (kept = only its
 *  remaining solved-angle set) + counters + reopen completed → active. */
export async function addCampaignAirfoils(
  db: DB,
  campaignId: string,
  airfoilIds: string[],
  diffHash: string,
): Promise<AddAirfoilsResult> {
  return db.transaction(async (tx) => {
    const { campaign, revision, plan } = await loadCampaignWithCurrentPlan(
      tx,
      campaignId,
      { forUpdate: true },
    );
    if (
      !["active", "paused", "attention", "completed"].includes(campaign.status)
    ) {
      throw new CampaignError(
        "invalid_state",
        `campaign is ${campaign.status} — airfoils cannot be added`,
      );
    }
    const preview = await buildAddAirfoilsPreview(tx, campaignId, airfoilIds);
    if (preview.diffHash !== diffHash)
      return { status: "stale_diff" as const, preview };
    if (preview.newAirfoilIds.length === 0) {
      const totals = await campaignProgressTotals(tx, campaignId);
      return {
        status: "applied" as const,
        addedAirfoils: 0,
        addedPoints: 0,
        totals,
      };
    }

    await asDb(tx)
      .insert(simCampaignAirfoils)
      .values(
        preview.newAirfoilIds.map((airfoilId) => ({ campaignId, airfoilId })),
      )
      .onConflictDoNothing();

    // Inherit the campaign's obligated cells; symmetric airfoils get solver
    // cells at |α| plus derived rows for the negative side (spec §9.2).
    const newIds = preview.newAirfoilIds;
    await asDb(tx).execute(sql`
      INSERT INTO sim_campaign_points
        (campaign_id, condition_id, airfoil_id, aoa_deg, revision_id, plan_revision_number, state, derived_by_symmetry)
      SELECT DISTINCT p.campaign_id, p.condition_id, af.id, p.aoa_deg, p.revision_id, ${revision.revisionNumber}::int,
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
      SELECT DISTINCT p.campaign_id, p.condition_id, af.id, abs(p.aoa_deg), p.revision_id, ${revision.revisionNumber}::int, 'requested', false
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
    await reconcileLinkedCampaignLadderWork(tx, campaignId);
    await ensureCampaignLanes(tx, campaignId, plan, { airfoilIds: newIds });
    await recomputeCampaignProgress(tx, campaignId);
    // Growth on a completed campaign reopens it (spec §6.2).
    const totals = await refreshCampaignCompletion(tx, campaignId);
    return {
      status: "applied" as const,
      addedAirfoils: newIds.length,
      addedPoints: preview.addedPoints,
      totals,
    };
  });
}

// ---------------------------------------------------------------------------
// §6.4 — Lifecycle verbs
// ---------------------------------------------------------------------------
async function requireCampaign(db: DbTx, campaignId: string) {
  const [campaign] = await asDb(db)
    .select()
    .from(simCampaigns)
    .where(eq(simCampaigns.id, campaignId))
    .limit(1);
  if (!campaign) throw new CampaignError("not_found", "campaign not found");
  return campaign;
}

/** Serialize lifecycle changes by the shared physical ladder rows they own.
 * Locking only each campaign row is insufficient: two concurrent final-owner
 * cancellations can each observe the other's association as still active and
 * both leave one pending request/verify/job ownerless. Physical-row locks make
 * the second transaction re-evaluate after the first commits. All callers use
 * verify-then-request and UUID order, preventing cross-item lock inversion. */
async function lockCampaignSharedLadderItems(
  tx: CampaignTx,
  campaignId: string,
): Promise<void> {
  await asDb(tx).execute(sql`
    SELECT q.id
    FROM sim_urans_verify_queue q
    WHERE q.state IN ('pending', 'running')
      AND (
        EXISTS (
          SELECT 1
          FROM sim_urans_verify_queue_campaigns ownership
          WHERE ownership.queue_id = q.id
            AND ownership.campaign_id = ${campaignId}
            AND ownership.state = 'active'
        )
        OR EXISTS (
          SELECT 1
          FROM sim_urans_verify_queue_requests coverage
          JOIN sim_urans_requests request_owner
            ON request_owner.id = coverage.request_id
           AND request_owner.fidelity = 'full'
           AND request_owner.state IN ('pending', 'running')
          JOIN sim_urans_request_campaigns ownership
            ON ownership.request_id = request_owner.id
          WHERE coverage.queue_id = q.id
            AND ownership.campaign_id = ${campaignId}
            AND ownership.state = 'active'
        )
      )
    ORDER BY q.id
    FOR UPDATE OF q
  `);
  await asDb(tx).execute(sql`
    SELECT req.id
    FROM sim_urans_requests req
    JOIN sim_urans_request_campaigns ownership ON ownership.request_id = req.id
    WHERE ownership.campaign_id = ${campaignId}
      AND ownership.state = 'active'
      AND req.state IN ('pending', 'running')
    ORDER BY req.id
    FOR UPDATE OF req
  `);
  await asDb(tx).execute(sql`
    SELECT obligation.id
    FROM sim_precalc_obligations obligation
    JOIN sim_precalc_obligation_campaigns ownership
      ON ownership.obligation_id = obligation.id
    WHERE ownership.campaign_id = ${campaignId}
      AND ownership.state = 'active'
      AND obligation.state IN ('pending', 'running')
    ORDER BY obligation.id
    FOR UPDATE OF obligation
  `);
}

/** Cancel compositions that have not crossed the durable engine-submission
 * boundary, then release only the claims owned by the rows whose pending→
 * cancelled transition this transaction won. Submitted/in-flight jobs are
 * deliberately untouched and retain the documented finish-and-ingest rule. */
async function cancelPendingCampaignCompositions(
  tx: CampaignTx,
  campaignId: string,
  reason: string,
  releaseMode: "pause" | "cancel",
): Promise<number> {
  const stopped = await asDb(tx)
    .update(simJobs)
    .set({
      status: "cancelled",
      engineState: "cancelled",
      error: reason,
      finishedAt: new Date(),
    })
    .where(
      and(eq(simJobs.campaignId, campaignId), eq(simJobs.status, "pending")),
    )
    .returning({ id: simJobs.id });
  if (!stopped.length) return 0;
  await asDb(tx)
    .update(results)
    .set({
      // Paused wave-2 precalc work stays a wave-2 obligation. `queued` with
      // no owner is the existing durable ladder route; converting it to
      // pending would let the generic campaign gap finder redo wave-1 RANS.
      // Terminal cancellation cleaned these rows above while their pending
      // job link was still present, so its remaining ordinary claims reopen.
      status:
        releaseMode === "pause"
          ? sql`CASE WHEN EXISTS (
              SELECT 1 FROM sim_jobs stopped_job
              WHERE stopped_job.id = ${results.simJobId}
                AND stopped_job.wave = 2
                AND stopped_job.request_payload ->> 'uransFidelity' = 'precalc'
            ) THEN 'queued'::result_status ELSE 'pending'::result_status END`
          : "pending",
      source: "queued",
      simJobId: null,
      engineJobId: null,
      engineCaseSlug: null,
    })
    .where(
      and(
        inArray(
          results.simJobId,
          stopped.map((job) => job.id),
        ),
        inArray(results.status, ["queued", "running"]),
      ),
    );
  return stopped.length;
}

/** Cancel a global ladder composition only when this lifecycle change removed
 * its last currently-runnable owner. A paused survivor freezes the physical
 * item back to pending; an active/attention survivor keeps the already-built
 * composition, and a background/manual owner remains fully independent. */
async function cancelStoppedSharedLadderCompositions(
  tx: CampaignTx,
  verifyQueueIds: string[],
  requestIds: string[],
  precalcObligationIds: string[],
  reason: string,
): Promise<number> {
  if (
    !verifyQueueIds.length &&
    !requestIds.length &&
    !precalcObligationIds.length
  )
    return 0;
  const verifyFilter = verifyQueueIds.length
    ? sql`(
        j.request_payload ->> 'verifyQueueItemId' = ANY(${pgUuidArray(verifyQueueIds)}::text[])
        AND EXISTS (
          SELECT 1 FROM sim_urans_verify_queue q
          WHERE q.id::text = j.request_payload ->> 'verifyQueueItemId'
            AND q.background_owner = false
            AND NOT EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue_campaigns ownership
              JOIN sim_campaigns owner_campaign ON owner_campaign.id = ownership.campaign_id
              WHERE ownership.queue_id = q.id
                AND ownership.state = 'active'
                AND owner_campaign.status IN ('active', 'attention')
            )
            AND NOT EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue_requests coverage
              JOIN sim_urans_requests request_owner
                ON request_owner.id = coverage.request_id
               AND request_owner.fidelity = 'full'
               AND request_owner.state IN ('pending', 'running')
              WHERE coverage.queue_id = q.id
                AND (
                  request_owner.background_owner
                  OR EXISTS (
                    SELECT 1
                    FROM sim_urans_request_campaigns ownership
                    JOIN sim_campaigns owner_campaign
                      ON owner_campaign.id = ownership.campaign_id
                    WHERE ownership.request_id = request_owner.id
                      AND ownership.state = 'active'
                      AND owner_campaign.status IN ('active', 'attention')
                  )
                )
            )
        )
      )`
    : sql`false`;
  const requestFilter = requestIds.length
    ? sql`(
        j.request_payload ->> 'uransRequestId' = ANY(${pgUuidArray(requestIds)}::text[])
        AND EXISTS (
          SELECT 1 FROM sim_urans_requests req
          WHERE req.id::text = j.request_payload ->> 'uransRequestId'
            AND req.background_owner = false
            AND NOT EXISTS (
              SELECT 1
              FROM sim_urans_request_campaigns ownership
              JOIN sim_campaigns owner_campaign ON owner_campaign.id = ownership.campaign_id
              WHERE ownership.request_id = req.id
                AND ownership.state = 'active'
                AND owner_campaign.status IN ('active', 'attention')
            )
        )
      )`
    : sql`false`;
  const precalcFilter = precalcObligationIds.length
    ? sql`(
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(j.request_payload -> 'precalcObligationIds') = 'array'
              THEN j.request_payload -> 'precalcObligationIds'
              ELSE '[]'::jsonb
            END
          ) payload_obligation(id)
          WHERE payload_obligation.id::uuid = ANY(${pgUuidArray(precalcObligationIds)}::uuid[])
        )
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(j.request_payload -> 'precalcObligationIds') = 'array'
              THEN j.request_payload -> 'precalcObligationIds'
              ELSE '[]'::jsonb
            END
          ) payload_obligation(id)
          JOIN sim_precalc_obligations obligation
            ON obligation.id = payload_obligation.id::uuid
          WHERE obligation.state <> 'pending'
             OR NOT (
               obligation.background_owner
               OR EXISTS (
                 SELECT 1
                 FROM sim_precalc_obligation_campaigns ownership
                 JOIN sim_campaigns owner_campaign
                   ON owner_campaign.id = ownership.campaign_id
                 WHERE ownership.obligation_id = obligation.id
                   AND ownership.state = 'active'
                   AND owner_campaign.status IN ('active', 'attention')
               )
               OR EXISTS (
                 SELECT 1
                 FROM sim_precalc_obligation_requests coverage
                 JOIN sim_urans_requests request_owner
                   ON request_owner.id = coverage.request_id
                 WHERE coverage.obligation_id = obligation.id
                   AND request_owner.background_owner
                   AND request_owner.state IN ('pending', 'running')
               )
             )
        )
      )`
    : sql`false`;
  const stopped = (await asDb(tx).execute(sql`
    UPDATE sim_jobs j
    SET status = 'cancelled', engine_state = 'cancelled', error = ${reason},
        "finishedAt" = now(), "updatedAt" = now()
    WHERE j.campaign_id IS NULL
      AND j.status = 'pending'
      AND (${verifyFilter} OR ${requestFilter} OR ${precalcFilter})
    RETURNING j.id,
      j.request_payload ->> 'verifyQueueItemId' AS verify_queue_id,
      j.request_payload ->> 'uransRequestId' AS request_id
  `)) as unknown as Array<{
    id: string;
    verify_queue_id: string | null;
    request_id: string | null;
  }>;
  if (!stopped.length) return 0;

  const stoppedJobIds = stopped.map((row) => row.id);
  await asDb(tx)
    .update(results)
    .set({
      status: sql`CASE WHEN EXISTS (
        SELECT 1 FROM sim_jobs stopped_job
        WHERE stopped_job.id = ${results.simJobId}
          AND stopped_job.wave = 2
          AND stopped_job.request_payload ->> 'uransFidelity' = 'precalc'
      ) THEN 'queued'::result_status ELSE 'pending'::result_status END`,
      source: "queued",
      simJobId: null,
      engineJobId: null,
      engineCaseSlug: null,
    })
    .where(
      and(
        inArray(results.simJobId, stoppedJobIds),
        inArray(results.status, ["queued", "running"]),
      ),
    );

  const stoppedVerifyIds = stopped
    .map((row) => row.verify_queue_id)
    .filter((id): id is string => Boolean(id));
  if (stoppedVerifyIds.length) {
    await asDb(tx).execute(sql`
      UPDATE sim_urans_verify_queue q
      SET state = CASE
            WHEN q.background_owner OR EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue_campaigns ownership
              JOIN sim_campaigns owner_campaign ON owner_campaign.id = ownership.campaign_id
              WHERE ownership.queue_id = q.id
                AND ownership.state = 'active'
                AND owner_campaign.status IN ('active', 'attention', 'paused')
            ) OR EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue_requests coverage
              JOIN sim_urans_requests request_owner
                ON request_owner.id = coverage.request_id
               AND request_owner.fidelity = 'full'
               AND request_owner.state IN ('pending', 'running')
              WHERE coverage.queue_id = q.id
                AND (
                  request_owner.background_owner
                  OR EXISTS (
                    SELECT 1
                    FROM sim_urans_request_campaigns ownership
                    JOIN sim_campaigns owner_campaign
                      ON owner_campaign.id = ownership.campaign_id
                    WHERE ownership.request_id = request_owner.id
                      AND ownership.state = 'active'
                      AND owner_campaign.status IN (
                        'active', 'attention', 'paused'
                      )
                  )
                )
            ) THEN 'pending'
            ELSE 'cancelled'
          END,
          sim_job_id = NULL,
          "updatedAt" = now()
      WHERE q.id::text = ANY(${sql`ARRAY[${sql.join(
        stoppedVerifyIds.map((id) => sql`${id}`),
        sql`, `,
      )}]`}::text[])
        AND q.state = 'running'
    `);
  }

  const stoppedRequestIds = stopped
    .map((row) => row.request_id)
    .filter((id): id is string => Boolean(id));
  if (stoppedRequestIds.length) {
    await asDb(tx).execute(sql`
      UPDATE sim_urans_requests req
      SET state = CASE WHEN req.background_owner OR EXISTS (
            SELECT 1
            FROM sim_urans_request_campaigns ownership
            JOIN sim_campaigns owner_campaign ON owner_campaign.id = ownership.campaign_id
            WHERE ownership.request_id = req.id
              AND ownership.state = 'active'
              AND owner_campaign.status IN ('active', 'attention', 'paused')
          ) THEN 'pending' ELSE 'cancelled' END,
          sim_job_id = NULL,
          "updatedAt" = now()
      WHERE req.id::text = ANY(${sql`ARRAY[${sql.join(
        stoppedRequestIds.map((id) => sql`${id}`),
        sql`, `,
      )}]`}::text[])
        AND req.state = 'running'
    `);
  }
  return stopped.length;
}

export interface CampaignLifecycleContext {
  actor?: string | null;
  reason?: string | null;
}

function normalizedLifecycleText(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export async function pauseCampaign(
  db: DB,
  campaignId: string,
  context: CampaignLifecycleContext = {},
) {
  return db.transaction(async (tx) => {
    // Lifecycle changes and scheduler composition serialize on this row. The
    // scheduler inserts its sim_job and claims in one transaction while
    // holding the same lock, so pause can never miss a half-composed job.
    await asDb(tx).execute(sql`
      SELECT id FROM sim_campaigns WHERE id = ${campaignId} FOR UPDATE
    `);
    const campaign = await requireCampaign(tx, campaignId);
    if (!["active", "attention"].includes(campaign.status)) {
      throw new CampaignError(
        "invalid_state",
        `only active/attention campaigns can be paused (status: ${campaign.status})`,
      );
    }
    await lockCampaignSharedLadderItems(tx, campaignId);
    const [row] = await asDb(tx)
      .update(simCampaigns)
      .set({ status: "paused" })
      .where(eq(simCampaigns.id, campaignId))
      .returning();
    await asDb(tx)
      .insert(simCampaignLifecycleEvents)
      .values({
        campaignId,
        action: "pause",
        fromStatus: campaign.status,
        toStatus: "paused",
        actor: normalizedLifecycleText(context.actor),
        reason: normalizedLifecycleText(context.reason),
      });
    const verifyOwners = (await asDb(tx).execute(sql`
      SELECT queue.id
      FROM sim_urans_verify_queue queue
      WHERE EXISTS (
        SELECT 1
        FROM sim_urans_verify_queue_campaigns ownership
        WHERE ownership.queue_id = queue.id
          AND ownership.campaign_id = ${campaignId}
          AND ownership.state = 'active'
      )
      OR EXISTS (
        SELECT 1
        FROM sim_urans_verify_queue_requests coverage
        JOIN sim_urans_requests request_owner
          ON request_owner.id = coverage.request_id
         AND request_owner.fidelity = 'full'
         AND request_owner.state IN ('pending', 'running')
        JOIN sim_urans_request_campaigns ownership
          ON ownership.request_id = request_owner.id
        WHERE coverage.queue_id = queue.id
          AND ownership.campaign_id = ${campaignId}
          AND ownership.state = 'active'
      )
      ORDER BY queue.id
    `)) as unknown as Array<{ id: string }>;
    const requestOwners = await asDb(tx)
      .select({ id: simUransRequestCampaigns.requestId })
      .from(simUransRequestCampaigns)
      .where(
        and(
          eq(simUransRequestCampaigns.campaignId, campaignId),
          eq(simUransRequestCampaigns.state, "active"),
        ),
      );
    const precalcOwners = await asDb(tx)
      .select({ id: simPrecalcObligationCampaigns.obligationId })
      .from(simPrecalcObligationCampaigns)
      .where(
        and(
          eq(simPrecalcObligationCampaigns.campaignId, campaignId),
          eq(simPrecalcObligationCampaigns.state, "active"),
        ),
      );
    const cancelledSharedPendingJobs =
      await cancelStoppedSharedLadderCompositions(
        tx,
        verifyOwners.map((owner) => owner.id),
        requestOwners.map((owner) => owner.id),
        precalcOwners.map((owner) => owner.id),
        "all runnable campaign owners paused before engine submission",
      );
    const cancelledCampaignPendingJobs =
      await cancelPendingCampaignCompositions(
        tx,
        campaignId,
        "campaign paused before engine submission",
        "pause",
      );
    const cancelledPendingJobs =
      cancelledSharedPendingJobs + cancelledCampaignPendingJobs;
    const [running] = (await asDb(tx).execute(sql`
      SELECT count(*)::int AS n
      FROM sim_jobs job
      WHERE job.status IN ('submitted', 'running', 'ingesting')
        AND (
          job.campaign_id = ${campaignId}
          OR EXISTS (
            SELECT 1 FROM sim_urans_request_campaigns ownership
            WHERE ownership.campaign_id = ${campaignId}
              AND ownership.request_id::text = job.request_payload ->> 'uransRequestId'
          )
          OR EXISTS (
            SELECT 1 FROM sim_urans_verify_queue_campaigns ownership
            WHERE ownership.campaign_id = ${campaignId}
              AND ownership.queue_id::text = job.request_payload ->> 'verifyQueueItemId'
          )
          OR EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_requests coverage
            JOIN sim_urans_request_campaigns ownership
              ON ownership.request_id = coverage.request_id
            WHERE ownership.campaign_id = ${campaignId}
              AND coverage.queue_id::text =
                job.request_payload ->> 'verifyQueueItemId'
          )
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(job.request_payload -> 'precalcObligationIds') = 'array'
                THEN job.request_payload -> 'precalcObligationIds'
                ELSE '[]'::jsonb
              END
            ) payload_obligation(id)
            JOIN sim_precalc_obligation_campaigns ownership
              ON ownership.obligation_id = payload_obligation.id::uuid
            WHERE ownership.campaign_id = ${campaignId}
          )
        )
    `)) as unknown as Array<{ n: number }>;
    return {
      campaign: row,
      runningJobs: Number(running?.n ?? 0),
      cancelledPendingJobs,
    };
  });
}

export async function resumeCampaign(
  db: DB,
  campaignId: string,
  context: CampaignLifecycleContext = {},
) {
  return db.transaction(async (tx) => {
    // Match pause/cancel's lifecycle boundary: a concurrent terminal action
    // must commit before this read, not between a stale validation and an
    // unconditional status write that could resurrect a cancelled campaign.
    await asDb(tx).execute(sql`
      SELECT id FROM sim_campaigns WHERE id = ${campaignId} FOR UPDATE
    `);
    const campaign = await requireCampaign(tx, campaignId);
    if (campaign.status !== "paused") {
      throw new CampaignError(
        "invalid_state",
        `only paused campaigns can be resumed (status: ${campaign.status})`,
      );
    }
    const [resumed] = await asDb(tx)
      .update(simCampaigns)
      .set({ status: "active" })
      .where(
        and(eq(simCampaigns.id, campaignId), eq(simCampaigns.status, "paused")),
      )
      .returning({ id: simCampaigns.id });
    if (!resumed) {
      throw new CampaignError(
        "invalid_state",
        "campaign changed state while resume was being applied",
      );
    }
    await asDb(tx)
      .insert(simCampaignLifecycleEvents)
      .values({
        campaignId,
        action: "resume",
        fromStatus: "paused",
        toStatus: "active",
        actor: normalizedLifecycleText(context.actor),
        reason: normalizedLifecycleText(context.reason),
      });
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
    // Acquire the lifecycle lock before released-point and pending-job cleanup.
    // Without this early lock a composer could insert after cleanup but before
    // the final cancelled status update, escaping terminal settlement.
    await asDb(tx).execute(sql`
      SELECT id FROM sim_campaigns WHERE id = ${campaignId} FOR UPDATE
    `);
    const campaign = await requireCampaign(tx, campaignId);
    if (!["active", "paused", "attention"].includes(campaign.status)) {
      throw new CampaignError(
        "invalid_state",
        `campaign is already ${campaign.status}`,
      );
    }
    await lockCampaignSharedLadderItems(tx, campaignId);
    // Release all open work first, then reuse the shared claimed-row cleanup.
    const releasedRows = (await asDb(tx).execute(sql`
      UPDATE sim_campaign_points SET state = 'released', "updatedAt" = now()
      WHERE campaign_id = ${campaignId} AND state = 'requested'
      RETURNING aoa_deg
    `)) as unknown as unknown[];
    const cleanup = await deleteReleasedPendingResults(tx, campaignId);
    // Cancel only this campaign's ownership. A shared/background physical
    // item survives; an ownerless pending item terminates, while submitted
    // work retains the spec's finish-and-ingest semantics.
    const campaignVerifyRows = (await asDb(tx).execute(sql`
      SELECT queue.id
      FROM sim_urans_verify_queue queue
      WHERE EXISTS (
        SELECT 1
        FROM sim_urans_verify_queue_campaigns ownership
        WHERE ownership.queue_id = queue.id
          AND ownership.campaign_id = ${campaignId}
          AND ownership.state = 'active'
      )
      OR EXISTS (
        SELECT 1
        FROM sim_urans_verify_queue_requests coverage
        JOIN sim_urans_requests request_owner
          ON request_owner.id = coverage.request_id
         AND request_owner.fidelity = 'full'
         AND request_owner.state IN ('pending', 'running')
        JOIN sim_urans_request_campaigns ownership
          ON ownership.request_id = request_owner.id
        WHERE coverage.queue_id = queue.id
          AND ownership.campaign_id = ${campaignId}
          AND ownership.state = 'active'
      )
      ORDER BY queue.id
    `)) as unknown as Array<{ id: string }>;
    await asDb(tx)
      .update(simUransVerifyQueueCampaigns)
      .set({ state: "cancelled", cancelledAt: new Date() })
      .where(
        and(
          eq(simUransVerifyQueueCampaigns.campaignId, campaignId),
          eq(simUransVerifyQueueCampaigns.state, "active"),
        ),
      )
      .returning({ id: simUransVerifyQueueCampaigns.queueId });
    const cancelledRequestRows = await asDb(tx)
      .update(simUransRequestCampaigns)
      .set({ state: "cancelled", cancelledAt: new Date() })
      .where(
        and(
          eq(simUransRequestCampaigns.campaignId, campaignId),
          eq(simUransRequestCampaigns.state, "active"),
        ),
      )
      .returning({ id: simUransRequestCampaigns.requestId });
    if (cancelledRequestRows.length) {
      await asDb(tx).execute(sql`
        UPDATE sim_urans_requests req
        SET state = 'cancelled', sim_job_id = NULL, "updatedAt" = now()
        WHERE req.id = ANY(${sql`ARRAY[${sql.join(
          cancelledRequestRows.map((row) => sql`${row.id}::uuid`),
          sql`, `,
        )}]`})
          AND (
            req.state = 'pending'
            OR (
              req.fidelity = 'full'
              AND req.state = 'running'
              AND req.sim_job_id IS NULL
            )
          )
          AND req.background_owner = false
          AND NOT EXISTS (
            SELECT 1
            FROM sim_urans_request_campaigns owner
            JOIN sim_campaigns owner_campaign
              ON owner_campaign.id = owner.campaign_id
            WHERE owner.request_id = req.id
              AND owner.state = 'active'
              AND owner_campaign.status IN ('active', 'attention', 'paused')
          )
      `);
      await asDb(tx).execute(sql`
        DELETE FROM sim_ladder_submit_retries retry
        USING sim_urans_requests req
        WHERE retry.urans_request_id = req.id
          AND req.id = ANY(${sql`ARRAY[${sql.join(
            cancelledRequestRows.map((row) => sql`${row.id}::uuid`),
            sql`, `,
          )}]`})
          AND req.state = 'cancelled'
      `);
    }
    if (campaignVerifyRows.length) {
      await asDb(tx).execute(sql`
        UPDATE sim_urans_verify_queue q
        SET state = 'cancelled', "updatedAt" = now()
        WHERE q.id = ANY(${sql`ARRAY[${sql.join(
          campaignVerifyRows.map((row) => sql`${row.id}::uuid`),
          sql`, `,
        )}]`})
          AND q.state = 'pending'
          AND q.background_owner = false
          AND NOT EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_campaigns owner
            JOIN sim_campaigns owner_campaign
              ON owner_campaign.id = owner.campaign_id
            WHERE owner.queue_id = q.id
              AND owner.state = 'active'
              AND owner_campaign.status IN ('active', 'attention', 'paused')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_requests coverage
            JOIN sim_urans_requests request_owner
              ON request_owner.id = coverage.request_id
             AND request_owner.fidelity = 'full'
             AND request_owner.state IN ('pending', 'running')
            WHERE coverage.queue_id = q.id
              AND (
                request_owner.background_owner
                OR EXISTS (
                  SELECT 1
                  FROM sim_urans_request_campaigns owner
                  JOIN sim_campaigns owner_campaign
                    ON owner_campaign.id = owner.campaign_id
                  WHERE owner.request_id = request_owner.id
                    AND owner.state = 'active'
                    AND owner_campaign.status IN (
                      'active', 'attention', 'paused'
                    )
                )
              )
          )
      `);
      await asDb(tx).execute(sql`
        DELETE FROM sim_ladder_submit_retries retry
        USING sim_urans_verify_queue q
        WHERE retry.verify_queue_id = q.id
          AND q.id = ANY(${sql`ARRAY[${sql.join(
            campaignVerifyRows.map((row) => sql`${row.id}::uuid`),
            sql`, `,
          )}]`})
          AND q.state = 'cancelled'
      `);
    }
    const cancelledPrecalcRows = await asDb(tx)
      .update(simPrecalcObligationCampaigns)
      .set({ state: "cancelled", cancelledAt: new Date() })
      .where(
        and(
          eq(simPrecalcObligationCampaigns.campaignId, campaignId),
          eq(simPrecalcObligationCampaigns.state, "active"),
        ),
      )
      .returning({ id: simPrecalcObligationCampaigns.obligationId });
    if (cancelledPrecalcRows.length) {
      await asDb(tx).execute(sql`
        UPDATE sim_precalc_obligations obligation
        SET state = 'cancelled', completed_at = now(), "updatedAt" = now()
        WHERE obligation.id = ANY(${sql`ARRAY[${sql.join(
          cancelledPrecalcRows.map((row) => sql`${row.id}::uuid`),
          sql`, `,
        )}]`})
          AND obligation.state = 'pending'
          AND obligation.background_owner = false
          AND NOT EXISTS (
            SELECT 1 FROM sim_jobs accepted_job
            WHERE accepted_job.id = obligation.latest_sim_job_id
              AND (
                accepted_job.engine_job_id IS NOT NULL
                OR accepted_job."submittedAt" IS NOT NULL
                OR accepted_job.status IN ('submitted', 'running', 'ingesting')
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM sim_precalc_obligation_campaigns owner
            JOIN sim_campaigns owner_campaign
              ON owner_campaign.id = owner.campaign_id
            WHERE owner.obligation_id = obligation.id
              AND owner.state = 'active'
              AND owner_campaign.status IN ('active', 'attention', 'paused')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM sim_precalc_obligation_requests coverage
            JOIN sim_urans_requests request_owner
              ON request_owner.id = coverage.request_id
            WHERE coverage.obligation_id = obligation.id
              AND request_owner.background_owner
              AND request_owner.state IN ('pending', 'running')
          )
      `);
    }
    const cancelledSharedPendingJobs =
      await cancelStoppedSharedLadderCompositions(
        tx,
        campaignVerifyRows.map((row) => row.id),
        cancelledRequestRows.map((row) => row.id),
        cancelledPrecalcRows.map((row) => row.id),
        "last runnable campaign owner cancelled before engine submission",
      );
    const cancelledCampaignPendingJobs =
      await cancelPendingCampaignCompositions(
        tx,
        campaignId,
        "campaign cancelled before engine submission",
        "cancel",
      );
    // A running retry owner can become physically cancelled only after its
    // pending composition is stopped above. Remove scheduling-only retry state
    // then; shared/background survivors remain pending/running and retain it.
    if (campaignVerifyRows.length) {
      await asDb(tx).execute(sql`
        DELETE FROM sim_ladder_submit_retries retry
        USING sim_urans_verify_queue verify_item
        WHERE retry.verify_queue_id = verify_item.id
          AND verify_item.id = ANY(${sql`ARRAY[${sql.join(
            campaignVerifyRows.map((row) => sql`${row.id}::uuid`),
            sql`, `,
          )}]`})
          AND verify_item.state = 'cancelled'
      `);
    }
    await asDb(tx).execute(sql`
      DELETE FROM sim_ladder_submit_retries retry
      USING sim_urans_requests request_item,
            sim_urans_request_campaigns ownership
      WHERE retry.urans_request_id = request_item.id
        AND ownership.request_id = request_item.id
        AND ownership.campaign_id = ${campaignId}
        AND request_item.state = 'cancelled'
    `);
    const cancelledPendingJobs =
      cancelledSharedPendingJobs + cancelledCampaignPendingJobs;
    const [running] = (await asDb(tx).execute(sql`
      SELECT count(*)::int AS n
      FROM sim_jobs job
      WHERE job.status IN ('submitted', 'running', 'ingesting')
        AND (
          job.campaign_id = ${campaignId}
          OR EXISTS (
            SELECT 1 FROM sim_urans_request_campaigns ownership
            WHERE ownership.campaign_id = ${campaignId}
              AND ownership.request_id::text = job.request_payload ->> 'uransRequestId'
          )
          OR EXISTS (
            SELECT 1 FROM sim_urans_verify_queue_campaigns ownership
            WHERE ownership.campaign_id = ${campaignId}
              AND ownership.queue_id::text = job.request_payload ->> 'verifyQueueItemId'
          )
          OR EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_requests coverage
            JOIN sim_urans_request_campaigns ownership
              ON ownership.request_id = coverage.request_id
            WHERE ownership.campaign_id = ${campaignId}
              AND coverage.queue_id::text =
                job.request_payload ->> 'verifyQueueItemId'
          )
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(job.request_payload -> 'precalcObligationIds') = 'array'
                THEN job.request_payload -> 'precalcObligationIds'
                ELSE '[]'::jsonb
              END
            ) payload_obligation(id)
            JOIN sim_precalc_obligation_campaigns ownership
              ON ownership.obligation_id = payload_obligation.id::uuid
            WHERE ownership.campaign_id = ${campaignId}
          )
        )
    `)) as unknown as Array<{ n: number }>;
    await asDb(tx)
      .update(simCampaigns)
      .set({ status: "cancelled", completedAt: null })
      .where(eq(simCampaigns.id, campaignId));
    await recomputeCampaignProgress(tx, campaignId);
    const gcCount = await gcOrphanedCampaignPresets(tx);
    return {
      campaign: await requireCampaign(tx, campaignId),
      releasedPoints: releasedRows.length,
      deletedPendingResults: cleanup.deleted,
      staledPendingResults: cleanup.staled,
      cancelledPendingVerifications: campaignVerifyRows.length,
      cancelledPendingUransRequests: cancelledRequestRows.length,
      cancelledPendingPrecalcObligations: cancelledPrecalcRows.length,
      cancelledPendingJobs,
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
    await asDb(tx).execute(sql`
      SELECT id FROM sim_campaigns WHERE id = ${campaignId} FOR UPDATE
    `);
    const campaign = await requireCampaign(tx, campaignId);
    if (campaign.status !== "attention") {
      throw new CampaignError(
        "invalid_state",
        `only attention campaigns can be closed with failures (status: ${campaign.status})`,
      );
    }
    const totals = await campaignProgressTotals(tx, campaignId);
    // Historical close columns retain failed/rejected snapshots. Blocked is
    // kept as an explicit current counter in the read model (there is no
    // human-review close bucket for machine-owned unavailable work).
    const [row] = await asDb(tx)
      .update(simCampaigns)
      .set({
        status: "completed",
        closedWithFailedCount: totals.failed,
        closedWithRejectedCount: totals.rejected,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(simCampaigns.id, campaignId),
          eq(simCampaigns.status, "attention"),
        ),
      )
      .returning();
    if (!row) {
      throw new CampaignError(
        "invalid_state",
        "campaign changed state while close was being applied",
      );
    }
    return {
      campaign: row,
      closedWithFailedCount: totals.failed,
      closedWithRejectedCount: totals.rejected,
      blockedCount: totals.blocked,
    };
  });
}

export async function archiveCampaign(
  db: DB,
  campaignId: string,
  unarchive = false,
) {
  return db.transaction(async (tx) => {
    await asDb(tx).execute(sql`
      SELECT id FROM sim_campaigns WHERE id = ${campaignId} FOR UPDATE
    `);
    const campaign = await requireCampaign(tx, campaignId);
    if (unarchive) {
      if (campaign.status !== "archived")
        throw new CampaignError("invalid_state", "campaign is not archived");
      const restored = campaign.completedAt ? "completed" : "cancelled";
      const [row] = await asDb(tx)
        .update(simCampaigns)
        .set({ status: restored })
        .where(
          and(
            eq(simCampaigns.id, campaignId),
            eq(simCampaigns.status, "archived"),
          ),
        )
        .returning();
      if (!row) {
        throw new CampaignError(
          "invalid_state",
          "campaign changed state while unarchive was being applied",
        );
      }
      return { campaign: row };
    }
    if (!["completed", "cancelled"].includes(campaign.status)) {
      throw new CampaignError(
        "invalid_state",
        `only completed/cancelled campaigns can be archived (status: ${campaign.status})`,
      );
    }
    const [row] = await asDb(tx)
      .update(simCampaigns)
      .set({ status: "archived" })
      .where(
        and(
          eq(simCampaigns.id, campaignId),
          inArray(simCampaigns.status, ["completed", "cancelled"]),
        ),
      )
      .returning();
    if (!row) {
      throw new CampaignError(
        "invalid_state",
        "campaign changed state while archive was being applied",
      );
    }
    return { campaign: row };
  });
}

/** Force-release a blocked `kept` condition (spec §6.3): explicit, recorded as
 *  a force_release plan revision; solved evidence kept; pending deleted. */
export async function forceReleaseCondition(
  db: DB,
  campaignId: string,
  conditionId: string,
  expectedCancelledPoints?: number,
) {
  return db.transaction(async (tx) => {
    const { campaign, revision, plan } = await loadCampaignWithCurrentPlan(
      tx,
      campaignId,
      { forUpdate: true },
    );
    const [condition] = await asDb(tx)
      .select()
      .from(simCampaignConditions)
      .where(
        and(
          eq(simCampaignConditions.id, conditionId),
          eq(simCampaignConditions.campaignId, campaignId),
          eq(
            simCampaignConditions.generation,
            campaign.currentConditionGeneration,
          ),
        ),
      )
      .limit(1);
    if (!condition) throw new CampaignError("not_found", "condition not found");
    if (condition.status !== "kept") {
      throw new CampaignError(
        "invalid_state",
        `only kept conditions can be force-released (status: ${condition.status})`,
      );
    }
    const [openRow] = (await asDb(tx).execute(sql`
      SELECT count(*)::int AS n FROM sim_campaign_points WHERE campaign_id = ${campaignId} AND condition_id = ${conditionId} AND state = 'requested'
    `)) as unknown as Array<{ n: number }>;
    const cancelledPoints = Number(openRow?.n ?? 0);
    if (
      expectedCancelledPoints != null &&
      expectedCancelledPoints !== cancelledPoints
    ) {
      throw new CampaignError(
        "drift",
        `expected ${expectedCancelledPoints} cancellable points but found ${cancelledPoints} — refresh and confirm again`,
        {
          expected: expectedCancelledPoints,
          actual: cancelledPoints,
        },
      );
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
    await asDb(tx)
      .update(simCampaigns)
      .set({ currentPlanRevisionId: planRevision.id })
      .where(eq(simCampaigns.id, campaign.id));
    await asDb(tx)
      .update(simCampaignConditions)
      .set({
        status: "released",
        statusChangedInPlanRevisionId: planRevision.id,
      })
      .where(eq(simCampaignConditions.id, conditionId));
    await asDb(tx).execute(sql`
      UPDATE sim_campaign_points SET state = 'released', "updatedAt" = now()
      WHERE campaign_id = ${campaignId} AND condition_id = ${conditionId} AND state = 'requested'
    `);
    await deleteReleasedPendingResults(tx, campaignId);
    await recomputeCampaignProgress(tx, campaignId);
    const totals = await refreshCampaignCompletion(tx, campaignId);
    return {
      planRevisionNumber: planRevision.revisionNumber,
      cancelledPoints,
      totals,
    };
  });
}

/** Restore a released condition through the normal plan-edit path: the combo's
 *  values are ensured in the envelope and every OTHER combo that would newly
 *  appear is excluded, so exactly this condition re-activates (spec §6.3). */
export async function restoreCondition(
  db: DB,
  campaignId: string,
  conditionId: string,
  createdBy?: string | null,
) {
  return db.transaction(async (tx) => {
    const { campaign, revision, plan } = await loadCampaignWithCurrentPlan(
      tx,
      campaignId,
      { forUpdate: true },
    );
    const condRows = await loadCampaignConditionCombos(tx, campaignId);
    const target = condRows.find((r) => r.condition.id === conditionId);
    if (!target) throw new CampaignError("not_found", "condition not found");
    if (target.condition.status !== "released")
      throw new CampaignError(
        "invalid_state",
        `only released conditions in the current generation can be restored (status: ${target.condition.status})`,
      );

    const [t, p, speed, chord] = target.comboKey.split("|") as [
      string,
      string,
      string,
      string,
    ];
    const activeKeys = new Set(
      condRows
        .filter((r) => r.condition.status === "active")
        .map((r) => r.comboKey),
    );
    const draft: CampaignPlan = {
      ...plan,
      ambients: dedupeSorted(
        [...plan.ambients, [t, p] as [string, string]],
        (a) => `${a[0]}|${a[1]}`,
        (a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]),
      ),
      speedsMps: dedupeSorted(
        [...plan.speedsMps, speed],
        (x) => x,
        (a, b) => Number(a) - Number(b),
      ),
      chordsM: dedupeSorted(
        [...plan.chordsM, chord],
        (x) => x,
        (a, b) => Number(a) - Number(b),
      ),
      excludedConditions: plan.excludedConditions.filter(
        (x) => x.join("|") !== target.comboKey,
      ),
    };
    // Exclude every combo the widened envelope would introduce except the
    // restored one and combos already active.
    const wouldBe = conditionCombosFromPlan(draft);
    const extraExclusions = wouldBe
      .filter(
        (c) => c.comboKey !== target.comboKey && !activeKeys.has(c.comboKey),
      )
      .map(
        (c) =>
          [c.temperatureK, c.pressurePa, c.speedMps, c.chordM] as [
            string,
            string,
            string,
            string,
          ],
      );
    const newPlanInput: CampaignPlanInput = {
      ...draft,
      excludedConditions: dedupeSorted(
        [...draft.excludedConditions, ...extraExclusions],
        (x) => x.join("|"),
        (a, b) => a.join("|").localeCompare(b.join("|")),
      ),
    };
    const { classification } = await classifyPlanChange(
      tx,
      campaignId,
      newPlanInput,
    );
    return applyPlanEditCore(
      tx,
      campaign,
      revision.revisionNumber,
      classification,
      "edit",
      createdBy,
      {
        restoredConditionId: conditionId,
      },
    );
  });
}

export async function continueLane(
  db: DB,
  campaignId: string,
  laneKey: {
    airfoilId: string;
    conditionId: string;
    objective: CampaignObjectiveKey;
  },
  extraRounds: number,
) {
  if (
    !(Number.isInteger(extraRounds) && extraRounds >= 1 && extraRounds <= 50)
  ) {
    throw new CampaignError(
      "validation",
      "extraRounds must be an integer 1..50",
    );
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
        sql`EXISTS (
          SELECT 1
          FROM sim_campaign_conditions actionable_condition
          JOIN sim_campaigns actionable_campaign
            ON actionable_campaign.id = actionable_condition.campaign_id
          WHERE actionable_condition.id = ${simCampaignLanes.conditionId}
            AND actionable_condition.campaign_id = ${simCampaignLanes.campaignId}
            AND actionable_condition.generation = actionable_campaign.current_condition_generation
            AND actionable_condition.status IN ('active', 'kept')
        )`,
      ),
    )
    .returning();
  if (!lane)
    throw new CampaignError(
      "invalid_state",
      "lane is not actionable in the campaign's current solver generation",
    );
  return lane;
}

// ---------------------------------------------------------------------------
// Failures + scoped requeue (spec §10)
// ---------------------------------------------------------------------------
export const CAMPAIGN_ERROR_CLASSES = [
  "mesh",
  "diverged",
  "timeout",
  "engine",
  "cancelled",
  "solver",
  "unknown",
] as const;
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

// A user-visible failed campaign point is TERMINAL URANS evidence with its
// authoritative results row (r.id = p.result_id) at status='failed'. RANS
// rejection/non-convergence is automatic ladder input, not a failure drawer or
// manual requeue item. The shared predicate also excludes machine-owned open or
// blocked PRECALC cells so list/count/progress remain exactly coherent.
// Callers MUST join `results r ON r.id = p.result_id`.
function failedResultsWhere(
  campaignId: string,
  filters: { conditionId?: string; airfoilId?: string },
) {
  return sql`
    p.campaign_id = ${campaignId}
    AND p.state = 'terminal'
    AND NOT p.derived_by_symmetry
    AND r.id = p.result_id
    AND r.status = 'failed'
    AND ${USER_TERMINAL_CAMPAIGN_RESULT_SQL}
    AND EXISTS (
      SELECT 1
      FROM sim_campaign_conditions actionable_condition
      JOIN sim_campaigns actionable_campaign
        ON actionable_campaign.id = actionable_condition.campaign_id
      WHERE actionable_condition.id = p.condition_id
        AND actionable_condition.campaign_id = p.campaign_id
        AND actionable_condition.generation = actionable_campaign.current_condition_generation
        AND actionable_condition.status IN ('active', 'kept')
    )
    ${filters.conditionId ? sql`AND p.condition_id = ${filters.conditionId}` : sql``}
    ${filters.airfoilId ? sql`AND p.airfoil_id = ${filters.airfoilId}` : sql``}
  `;
}

const DETERMINISTIC_MESH_BLOCKER_SQL = sql`(
  position(${DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER} in lower(COALESCE(r.error, ''))) > 0
  AND position(${DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER} in lower(COALESCE(r.error, ''))) > 0
)`;

/** Generic retry is deliberately RANS-only. Once a physical cell has any
 * PRECALC obligation row, every state (including satisfied/cancelled) remains
 * durable evidence that the fidelity ladder owns that cell; ordinary campaign
 * requeue must never downgrade it back to a wave-1 solve. */
const GENERIC_RANS_REQUEUE_ELIGIBLE_SQL = sql`(
  r.regime IS DISTINCT FROM 'urans'
  AND COALESCE(r.fidelity::text, '') NOT LIKE 'urans%'
  AND NOT EXISTS (
    SELECT 1 FROM sim_precalc_obligations obligation
    WHERE obligation.airfoil_id = p.airfoil_id
      AND obligation.revision_id = p.revision_id
      AND obligation.aoa_deg = p.aoa_deg
  )
)`;

// A user-visible rejected campaign point is terminal URANS evidence classified
// physics-invalid. Rejected RANS remains automatic-handoff work, matching the
// canonical progress counter and never entering the manual requeue surface.
function rejectedResultsWhere(
  campaignId: string,
  filters: { conditionId?: string; airfoilId?: string },
) {
  return sql`
    p.campaign_id = ${campaignId}
    AND p.state = 'terminal'
    AND NOT p.derived_by_symmetry
    AND r.id = p.result_id
    AND r.status = 'done'
    AND ${USER_TERMINAL_CAMPAIGN_RESULT_SQL}
    AND EXISTS (SELECT 1 FROM result_classifications rc WHERE rc.result_id = r.id AND rc.state = 'rejected')
    AND EXISTS (
      SELECT 1
      FROM sim_campaign_conditions actionable_condition
      JOIN sim_campaigns actionable_campaign
        ON actionable_campaign.id = actionable_condition.campaign_id
      WHERE actionable_condition.id = p.condition_id
        AND actionable_condition.campaign_id = p.campaign_id
        AND actionable_condition.generation = actionable_campaign.current_condition_generation
        AND actionable_condition.status IN ('active', 'kept')
    )
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

/** Critical rejected (done-but-physics-rejected) URANS points in scope:
 *  exact total plus bounded diagnostic samples. This is an outcome read model,
 *  not a promise that the legacy ordinary-RANS requeue endpoint may downgrade
 *  these cells back to wave 1. */
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
  /** Failed rows safe to repeat without first changing the immutable setup. */
  retryableCount: number;
  samples: Array<{
    resultId: string;
    conditionId: string;
    airfoilId: string;
    airfoilSlug: string;
    airfoilName: string;
    aoaDeg: number;
    error: string | null;
    attempts: number;
    retryable: boolean;
  }>;
}

export async function campaignFailures(
  db: DB,
  campaignId: string,
  filters: { conditionId?: string; airfoilId?: string } = {},
): Promise<{
  total: number;
  retryableTotal: number;
  groups: CampaignFailureGroup[];
}> {
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
        (NOT (${DETERMINISTIC_MESH_BLOCKER_SQL}) AND ${GENERIC_RANS_REQUEUE_ELIGIBLE_SQL}) AS retryable,
        (SELECT count(*)::int FROM result_attempts ra WHERE ra.result_id = r.id) AS attempts,
        count(*) OVER (PARTITION BY ${ERROR_CLASS_SQL})::int AS class_count,
        count(*) FILTER (WHERE NOT (${DETERMINISTIC_MESH_BLOCKER_SQL}) AND ${GENERIC_RANS_REQUEUE_ELIGIBLE_SQL})
          OVER (PARTITION BY ${ERROR_CLASS_SQL})::int AS retryable_count,
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
    retryable: boolean;
    attempts: number;
    class_count: number;
    retryable_count: number;
    rn: number;
  }>;
  const groups = new Map<CampaignErrorClass, CampaignFailureGroup>();
  let total = 0;
  let retryableTotal = 0;
  for (const row of rows) {
    let group = groups.get(row.error_class);
    if (!group) {
      group = {
        errorClass: row.error_class,
        count: Number(row.class_count),
        retryableCount: Number(row.retryable_count),
        samples: [],
      };
      groups.set(row.error_class, group);
      total += Number(row.class_count);
      retryableTotal += Number(row.retryable_count);
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
      retryable: Boolean(row.retryable),
    });
  }
  return { total, retryableTotal, groups: [...groups.values()] };
}

export type CampaignPreliminaryOutcomeKind =
  | "accepted"
  | "recovering"
  | "evidence_unavailable"
  | "continuation_unavailable"
  | "mesh_unavailable"
  | "submit_unavailable"
  | "recovery_unavailable";

export type CampaignPreliminaryFastState =
  | "not_started"
  | "queued"
  | "running"
  | "accepted"
  | "critical";

export type CampaignPreliminaryRansStage =
  | "screened"
  | "polar_handoff"
  | "skipped"
  | "not_started";

export type CampaignPreliminaryFinalState =
  | "not_started"
  | "queued"
  | "running"
  | "accepted"
  | "critical";

export type CampaignPreliminaryFinalActivityState =
  | "queued"
  | "running"
  | "critical";

export type CampaignPreliminaryFinalComparison =
  | "within_tolerance"
  | "disagreed";

export type CampaignPreliminaryFinalSource = "verify" | "full_request";

export interface CampaignPreliminaryOutcome {
  /** Requested campaign point shown by this row. */
  aoaDeg: number;
  /** Exact solver/source angle. It differs from aoaDeg only for a
   * symmetry-derived campaign point. */
  sourceAoaDeg: number;
  derivedBySymmetry: boolean;
  affectedAoaDegs: number[];
  affectedPointCount: number;
  state: "pending" | "running" | "satisfied" | "blocked";
  outcome: CampaignPreliminaryOutcomeKind;
  ransStage: CampaignPreliminaryRansStage;
  fastState: CampaignPreliminaryFastState;
  finalState: CampaignPreliminaryFinalState;
  finalActivityState: CampaignPreliminaryFinalActivityState | null;
  finalComparison: CampaignPreliminaryFinalComparison | null;
  finalDeltaCl: number | null;
  finalDeltaCd: number | null;
  finalDeltaCm: number | null;
  finalSource: CampaignPreliminaryFinalSource | null;
  criticalStage: "preflight" | "fast" | "final" | null;
  fastResultId: string | null;
  fastResultAttemptId: string | null;
  finalResultId: string | null;
  finalResultAttemptId: string | null;
  finalEvidenceReasons: string[];
  finalSubmitError: string | null;
  finalSubmitHttpStatus: number | null;
  physicalAttemptsUsed: number;
  physicalAttemptsMax: number;
  recoverySubmissions: number;
  nonPhysicalSubmissions: number;
  interruptedPhysicalRuns: number;
  ransEvidenceRuns: number;
  preliminaryEvidenceRuns: number;
  fullUransEvidenceRuns: number;
  legacyUransEvidenceRuns: number;
  evidenceReasons: string[];
  updatedAt: string;
}

/**
 * Bounded cell-level read model for machine-owned preliminary URANS work.
 *
 * This is deliberately separate from campaignFailures(): an ordinary RANS
 * failure that can be requeued and a terminal PRECALC obligation whose
 * automatic physical budget is exhausted are different domain outcomes. The
 * latter must never be relabeled as a failed RANS point or a user review task.
 */
export async function campaignPreliminaryOutcomes(
  db: DB,
  campaignId: string,
  scope: { conditionId: string; airfoilId: string },
): Promise<{
  total: number;
  recovering: number;
  critical: number;
  unavailable: number;
  verified: number;
  items: CampaignPreliminaryOutcome[];
}> {
  await requireCampaign(db, campaignId);
  const rows = (await db.execute(sql`
    SELECT
      obligation.aoa_deg::float8 AS aoa_deg,
      obligation.state,
      obligation.source_result_id,
      obligation.source_result_attempt_id,
      obligation.attempt_count,
      obligation.max_attempts,
      obligation.last_outcome,
      obligation."updatedAt" AS updated_at,
      promotion_origin.promotion_id,
      source_rans_attempt.id AS source_rans_attempt_id,
      lineage_rans_attempt.id AS lineage_rans_attempt_id,
      fast_evidence.result_id AS fast_result_id,
      fast_evidence.result_attempt_id AS fast_result_attempt_id,
      latest_verify.id AS verify_id,
      latest_verify.state AS verify_state,
      latest_verify.sim_job_id AS verify_sim_job_id,
      latest_verify.verify_result_id,
      latest_verify.delta_cl::float8 AS verify_delta_cl,
      latest_verify.delta_cd::float8 AS verify_delta_cd,
      latest_verify.delta_cm::float8 AS verify_delta_cm,
      latest_verify.classification_reasons AS verify_latest_evidence_reasons,
      latest_verify.submit_error AS verify_submit_error,
      latest_verify.submit_http_status AS verify_submit_http_status,
      latest_verify."createdAt" AS verify_created_at,
      latest_verify."updatedAt" AS verify_updated_at,
      verify_evidence.result_id AS verify_final_result_id,
      verify_evidence.result_attempt_id AS verify_final_result_attempt_id,
      verify_evidence.classification_state AS verify_final_classification_state,
      verify_evidence.classification_reasons AS verify_final_classification_reasons,
      verify_evidence.attempt_created_at AS verify_final_created_at,
      verify_evidence.owner_id AS verify_final_owner_id,
      verify_evidence.owner_state AS verify_final_owner_state,
      verify_evidence.owner_created_at AS verify_final_owner_created_at,
      verify_evidence.delta_cl::float8 AS verify_final_delta_cl,
      verify_evidence.delta_cd::float8 AS verify_final_delta_cd,
      verify_evidence.delta_cm::float8 AS verify_final_delta_cm,
      latest_full_request.id AS full_request_id,
      latest_full_request.state AS full_request_state,
      latest_full_request.sim_job_id AS full_request_sim_job_id,
      latest_full_request.classification_reasons AS request_latest_evidence_reasons,
      latest_full_request.submit_error AS full_request_submit_error,
      latest_full_request.submit_http_status AS full_request_submit_http_status,
      latest_full_request."createdAt" AS full_request_created_at,
      latest_full_request."updatedAt" AS full_request_updated_at,
      request_evidence.result_id AS request_final_result_id,
      request_evidence.result_attempt_id AS request_final_result_attempt_id,
      request_evidence.classification_state AS request_final_classification_state,
      request_evidence.classification_reasons AS request_final_classification_reasons,
      request_evidence.attempt_created_at AS request_final_created_at,
      request_evidence.owner_id AS request_final_owner_id,
      request_evidence.owner_state AS request_final_owner_state,
      request_evidence.owner_created_at AS request_final_owner_created_at,
      ARRAY(
        SELECT point.aoa_deg::float8
        FROM sim_campaign_points point
        LEFT JOIN results source_result ON source_result.id = point.result_id
        WHERE point.campaign_id = ${campaignId}
          AND point.condition_id = ${scope.conditionId}
          AND point.airfoil_id = obligation.airfoil_id
          AND point.state <> 'released'
          AND CASE
                WHEN point.derived_by_symmetry THEN source_result.aoa_deg
                ELSE point.aoa_deg
              END = obligation.aoa_deg
        ORDER BY point.aoa_deg ASC
      ) AS affected_aoa_degs,
      (
        SELECT count(*)::int
        FROM sim_precalc_obligation_attempts submission
        WHERE submission.obligation_id = obligation.id
      ) AS recovery_submissions,
      (
        SELECT count(*)::int
        FROM sim_precalc_obligation_attempts submission
        WHERE submission.obligation_id = obligation.id
          AND NOT submission.consumes_solver_attempt
      ) AS non_physical_submissions,
      (
        SELECT count(*)::int
        FROM sim_precalc_obligation_attempts submission
        WHERE submission.obligation_id = obligation.id
          AND submission.consumes_solver_attempt
          AND submission.result_attempt_id IS NULL
          AND submission.state IN ('rejected', 'failed', 'cancelled')
      ) AS interrupted_physical_runs,
      COALESCE((
        SELECT (
          latest_submission.result_attempt_id IS NULL
          AND latest_submission.state IN ('rejected', 'failed', 'cancelled')
          AND EXISTS (
            SELECT 1
            FROM sim_precalc_obligation_attempts earlier_submission
            JOIN result_attempts earlier_attempt
              ON earlier_attempt.id = earlier_submission.result_attempt_id
            JOIN result_classifications earlier_classification
              ON earlier_classification.result_attempt_id = earlier_attempt.id
            WHERE earlier_submission.obligation_id = obligation.id
              AND earlier_submission.consumes_solver_attempt
              AND earlier_submission.attempt_number < latest_submission.attempt_number
              AND earlier_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
              AND 'incomplete-urans-integration' = ANY(
                COALESCE(
                  earlier_classification.reasons,
                  ARRAY[]::text[]
                )
              )
          )
        )
        FROM sim_precalc_obligation_attempts latest_submission
        WHERE latest_submission.obligation_id = obligation.id
          AND latest_submission.consumes_solver_attempt
        ORDER BY latest_submission.attempt_number DESC
        LIMIT 1
      ), false) AS continuation_interrupted,
      (
        SELECT count(*)::int
        FROM result_attempts attempt
        WHERE attempt.airfoil_id = obligation.airfoil_id
          AND attempt.simulation_preset_revision_id = obligation.revision_id
          AND attempt.aoa_deg = obligation.aoa_deg
          AND (
            attempt.id = source_rans_attempt.id
            OR attempt.sim_job_id = promotion_origin.parent_job_id
            OR attempt.sim_job_id IN (
              SELECT child.parent_job_id
              FROM sim_precalc_obligation_attempts submission
              JOIN sim_jobs child ON child.id = submission.sim_job_id
              WHERE submission.obligation_id = obligation.id
                AND child.parent_job_id IS NOT NULL
            )
          )
          AND (
            attempt.evidence_payload ->> 'fidelity' = 'rans'
            OR (
              attempt.regime = 'rans'
              AND COALESCE(attempt.evidence_payload ->> 'fidelity', '') NOT LIKE 'urans%'
            )
          )
      ) AS rans_evidence_runs,
      (
        SELECT count(*)::int
        FROM sim_precalc_obligation_attempts submission
        JOIN result_attempts attempt
          ON attempt.id = submission.result_attempt_id
        WHERE submission.obligation_id = obligation.id
          AND attempt.airfoil_id = obligation.airfoil_id
          AND attempt.simulation_preset_revision_id = obligation.revision_id
          AND attempt.aoa_deg = obligation.aoa_deg
          AND attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
      ) AS preliminary_evidence_runs,
      (
        SELECT count(DISTINCT attempt.id)::int
        FROM result_attempts attempt
        WHERE attempt.airfoil_id = obligation.airfoil_id
          AND attempt.simulation_preset_revision_id = obligation.revision_id
          AND attempt.aoa_deg = obligation.aoa_deg
          AND attempt.evidence_payload ->> 'fidelity' = 'urans_full'
          AND (
            EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue queue
              WHERE queue.airfoil_id = obligation.airfoil_id
                AND queue.revision_id = obligation.revision_id
                AND queue.aoa_deg = obligation.aoa_deg
                AND queue.sim_job_id = attempt.sim_job_id
                AND (
                  EXISTS (
                    SELECT 1
                    FROM sim_urans_verify_queue_campaigns queue_owner
                    WHERE queue_owner.queue_id = queue.id
                      AND queue_owner.campaign_id = ${campaignId}
                      AND queue_owner.state = 'active'
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM sim_urans_verify_queue_requests coverage
                    JOIN sim_urans_request_campaigns request_owner
                      ON request_owner.request_id = coverage.request_id
                    WHERE coverage.queue_id = queue.id
                      AND request_owner.campaign_id = ${campaignId}
                      AND request_owner.state = 'active'
                  )
                )
            )
            OR EXISTS (
              SELECT 1
              FROM sim_urans_requests request
              JOIN sim_urans_request_campaigns request_owner
                ON request_owner.request_id = request.id
               AND request_owner.campaign_id = ${campaignId}
               AND request_owner.state = 'active'
              WHERE request.airfoil_id = obligation.airfoil_id
                AND request.revision_id = obligation.revision_id
                AND request.fidelity = 'full'
                AND (
                  request.aoa_deg = obligation.aoa_deg
                  OR request.aoa_deg IS NULL
                )
                AND request.sim_job_id = attempt.sim_job_id
            )
          )
      ) AS full_urans_evidence_runs,
      (
        SELECT count(*)::int
        FROM sim_precalc_obligation_attempts submission
        JOIN result_attempts attempt
          ON attempt.id = submission.result_attempt_id
        WHERE submission.obligation_id = obligation.id
          AND attempt.airfoil_id = obligation.airfoil_id
          AND attempt.simulation_preset_revision_id = obligation.revision_id
          AND attempt.aoa_deg = obligation.aoa_deg
          AND attempt.regime = 'urans'
          AND COALESCE(attempt.evidence_payload ->> 'fidelity', '')
            NOT IN ('rans', 'urans_precalc', 'urans_full')
      ) AS legacy_urans_evidence_runs,
      ARRAY(
        SELECT DISTINCT reason
        FROM sim_precalc_obligation_attempts submission
        JOIN result_attempts attempt
          ON attempt.id = submission.result_attempt_id
        JOIN result_classifications classification
          ON classification.result_attempt_id = attempt.id
         AND classification.airfoil_id = attempt.airfoil_id
         AND classification.simulation_preset_revision_id =
             attempt.simulation_preset_revision_id
         AND classification.aoa_deg = attempt.aoa_deg
         AND classification.regime IS NOT DISTINCT FROM attempt.regime
        CROSS JOIN LATERAL unnest(
          COALESCE(classification.reasons, ARRAY[]::text[])
        ) reason
        WHERE submission.obligation_id = obligation.id
          AND attempt.airfoil_id = obligation.airfoil_id
          AND attempt.simulation_preset_revision_id = obligation.revision_id
          AND attempt.aoa_deg = obligation.aoa_deg
          AND attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
        ORDER BY reason
      ) AS evidence_reasons
    FROM sim_precalc_obligations obligation
    JOIN sim_precalc_obligation_campaigns ownership
      ON ownership.obligation_id = obligation.id
     AND ownership.campaign_id = ${campaignId}
     AND ownership.state = 'active'
    JOIN sim_campaign_conditions condition
      ON condition.id = ${scope.conditionId}
     AND condition.campaign_id = ${campaignId}
     AND condition.simulation_preset_revision_id = obligation.revision_id
    LEFT JOIN result_attempts source_rans_attempt
      ON source_rans_attempt.id = obligation.source_result_attempt_id
     AND source_rans_attempt.result_id = obligation.source_result_id
     AND source_rans_attempt.airfoil_id = obligation.airfoil_id
     AND source_rans_attempt.simulation_preset_revision_id = obligation.revision_id
     AND source_rans_attempt.aoa_deg = obligation.aoa_deg
     AND (
       source_rans_attempt.evidence_payload ->> 'fidelity' = 'rans'
       OR (
         source_rans_attempt.regime = 'rans'
         AND COALESCE(
           source_rans_attempt.evidence_payload ->> 'fidelity',
           ''
         ) NOT LIKE 'urans%'
       )
     )
    LEFT JOIN LATERAL (
      SELECT
        promotion.id AS promotion_id,
        promotion.parent_job_id
      FROM sim_rans_polar_promotion_points promotion_point
      JOIN sim_rans_polar_promotions promotion
        ON promotion.id = promotion_point.promotion_id
       AND promotion.owner_kind = 'campaign'
       AND promotion.campaign_id = ${campaignId}
       AND promotion.airfoil_id = obligation.airfoil_id
       AND promotion.revision_id = obligation.revision_id
      WHERE promotion_point.obligation_id = obligation.id
      ORDER BY promotion."createdAt" DESC, promotion.id DESC
      LIMIT 1
    ) promotion_origin ON TRUE
    LEFT JOIN LATERAL (
      SELECT parent_attempt.id
      FROM sim_precalc_obligation_attempts submission
      JOIN sim_jobs child
        ON child.id = submission.sim_job_id
       AND child.parent_job_id IS NOT NULL
      JOIN result_attempts parent_attempt
        ON parent_attempt.sim_job_id = child.parent_job_id
       AND parent_attempt.airfoil_id = obligation.airfoil_id
       AND parent_attempt.simulation_preset_revision_id = obligation.revision_id
       AND parent_attempt.aoa_deg = obligation.aoa_deg
       AND (
         parent_attempt.evidence_payload ->> 'fidelity' = 'rans'
         OR (
           parent_attempt.regime = 'rans'
           AND COALESCE(
             parent_attempt.evidence_payload ->> 'fidelity',
             ''
           ) NOT LIKE 'urans%'
         )
       )
      WHERE submission.obligation_id = obligation.id
      ORDER BY submission.attempt_number ASC, parent_attempt."createdAt" ASC
      LIMIT 1
    ) lineage_rans_attempt ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        queue.id,
        queue.state,
        queue.sim_job_id,
        queue.verify_result_id,
        queue.delta_cl,
        queue.delta_cd,
        queue.delta_cm,
        latest_attempt.classification_reasons,
        submit_retry.last_error AS submit_error,
        submit_retry.last_http_status AS submit_http_status,
        queue."createdAt",
        queue."updatedAt"
      FROM sim_urans_verify_queue queue
      LEFT JOIN sim_ladder_submit_retries submit_retry
        ON submit_retry.verify_queue_id = queue.id
      LEFT JOIN LATERAL (
        SELECT classification.reasons AS classification_reasons
        FROM result_attempts attempt
        JOIN result_classifications classification
          ON classification.result_attempt_id = attempt.id
         AND classification.airfoil_id = attempt.airfoil_id
         AND classification.simulation_preset_revision_id =
             attempt.simulation_preset_revision_id
         AND classification.aoa_deg = attempt.aoa_deg
         AND classification.regime IS NOT DISTINCT FROM attempt.regime
        WHERE queue.sim_job_id IS NOT NULL
          AND attempt.sim_job_id = queue.sim_job_id
          AND attempt.airfoil_id = queue.airfoil_id
          AND attempt.simulation_preset_revision_id = queue.revision_id
          AND attempt.aoa_deg = queue.aoa_deg
          AND attempt.evidence_payload ->> 'fidelity' = 'urans_full'
        ORDER BY
          COALESCE(attempt."solvedAt", attempt."createdAt") DESC,
          attempt.id DESC
        LIMIT 1
      ) latest_attempt ON TRUE
      WHERE queue.airfoil_id = obligation.airfoil_id
        AND queue.revision_id = obligation.revision_id
        AND queue.aoa_deg = obligation.aoa_deg
        AND (
          EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_campaigns queue_owner
            WHERE queue_owner.queue_id = queue.id
              AND queue_owner.campaign_id = ${campaignId}
              AND queue_owner.state = 'active'
          )
          OR EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_requests coverage
            JOIN sim_urans_request_campaigns request_owner
              ON request_owner.request_id = coverage.request_id
            WHERE coverage.queue_id = queue.id
              AND request_owner.campaign_id = ${campaignId}
              AND request_owner.state = 'active'
          )
        )
      ORDER BY queue."createdAt" DESC, queue.id DESC
      LIMIT 1
    ) latest_verify ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        attempt.result_id,
        attempt.id AS result_attempt_id
      FROM result_attempts attempt
      JOIN result_classifications classification
        ON classification.result_attempt_id = attempt.id
       AND classification.airfoil_id = attempt.airfoil_id
       AND classification.simulation_preset_revision_id =
           attempt.simulation_preset_revision_id
       AND classification.aoa_deg = attempt.aoa_deg
       AND classification.regime IS NOT DISTINCT FROM attempt.regime
       AND classification.state IN ('accepted', 'superseded_by_urans')
      WHERE obligation.state = 'satisfied'
        AND attempt.airfoil_id = obligation.airfoil_id
        AND attempt.simulation_preset_revision_id = obligation.revision_id
        AND attempt.aoa_deg = obligation.aoa_deg
        AND attempt.status = 'done'
        AND attempt.source = 'solved'
        AND attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
        AND obligation.source_result_attempt_id IS NOT NULL
        AND attempt.id = obligation.source_result_attempt_id
      LIMIT 1
    ) fast_evidence ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        request.id,
        request.state,
        request.sim_job_id,
        latest_attempt.classification_reasons,
        submit_retry.last_error AS submit_error,
        submit_retry.last_http_status AS submit_http_status,
        request."createdAt",
        request."updatedAt"
      FROM sim_urans_requests request
      JOIN sim_urans_request_campaigns request_owner
        ON request_owner.request_id = request.id
       AND request_owner.campaign_id = ${campaignId}
       AND request_owner.state = 'active'
      LEFT JOIN sim_ladder_submit_retries submit_retry
        ON submit_retry.urans_request_id = request.id
      LEFT JOIN LATERAL (
        SELECT classification.reasons AS classification_reasons
        FROM result_attempts attempt
        JOIN result_classifications classification
          ON classification.result_attempt_id = attempt.id
         AND classification.airfoil_id = attempt.airfoil_id
         AND classification.simulation_preset_revision_id =
             attempt.simulation_preset_revision_id
         AND classification.aoa_deg = attempt.aoa_deg
         AND classification.regime IS NOT DISTINCT FROM attempt.regime
        WHERE request.sim_job_id IS NOT NULL
          AND attempt.sim_job_id = request.sim_job_id
          AND attempt.airfoil_id = request.airfoil_id
          AND attempt.simulation_preset_revision_id = request.revision_id
          AND attempt.aoa_deg = obligation.aoa_deg
          AND attempt.evidence_payload ->> 'fidelity' = 'urans_full'
        ORDER BY
          COALESCE(attempt."solvedAt", attempt."createdAt") DESC,
          attempt.id DESC
        LIMIT 1
      ) latest_attempt ON TRUE
      WHERE request.airfoil_id = obligation.airfoil_id
        AND request.revision_id = obligation.revision_id
        AND request.fidelity = 'full'
        AND (
          request.aoa_deg = obligation.aoa_deg
          OR request.aoa_deg IS NULL
        )
      ORDER BY
        request."createdAt" DESC,
        (request.aoa_deg IS NOT NULL) DESC,
        request.id DESC
      LIMIT 1
    ) latest_full_request ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        attempt.result_id,
        attempt.id AS result_attempt_id,
        classification.state AS classification_state,
        classification.reasons AS classification_reasons,
        attempt."createdAt" AS attempt_created_at,
        queue.id AS owner_id,
        queue.state AS owner_state,
        queue."createdAt" AS owner_created_at,
        queue.delta_cl,
        queue.delta_cd,
        queue.delta_cm
      FROM sim_urans_verify_queue queue
      JOIN result_attempts attempt
        ON attempt.sim_job_id = queue.sim_job_id
       AND attempt.airfoil_id = obligation.airfoil_id
       AND attempt.simulation_preset_revision_id = obligation.revision_id
       AND attempt.aoa_deg = obligation.aoa_deg
      JOIN result_classifications classification
        ON classification.result_attempt_id = attempt.id
       AND classification.airfoil_id = attempt.airfoil_id
       AND classification.simulation_preset_revision_id =
           attempt.simulation_preset_revision_id
       AND classification.aoa_deg = attempt.aoa_deg
       AND classification.regime IS NOT DISTINCT FROM attempt.regime
       AND classification.state = 'accepted'
      WHERE queue.airfoil_id = obligation.airfoil_id
        AND queue.revision_id = obligation.revision_id
        AND queue.aoa_deg = obligation.aoa_deg
        AND (
          EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_campaigns queue_owner
            WHERE queue_owner.queue_id = queue.id
              AND queue_owner.campaign_id = ${campaignId}
              AND queue_owner.state = 'active'
          )
          OR EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_requests coverage
            JOIN sim_urans_request_campaigns request_owner
              ON request_owner.request_id = coverage.request_id
            WHERE coverage.queue_id = queue.id
              AND request_owner.campaign_id = ${campaignId}
              AND request_owner.state = 'active'
          )
        )
        AND queue.sim_job_id IS NOT NULL
        AND (
          queue.verify_result_id IS NULL
          OR queue.verify_result_id = attempt.result_id
        )
        AND attempt.status = 'done'
        AND attempt.source = 'solved'
        AND attempt.evidence_payload ->> 'fidelity' = 'urans_full'
      ORDER BY
        COALESCE(attempt."solvedAt", attempt."createdAt") DESC,
        attempt.id DESC
      LIMIT 1
    ) verify_evidence ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        attempt.result_id,
        attempt.id AS result_attempt_id,
        classification.state AS classification_state,
        classification.reasons AS classification_reasons,
        attempt."createdAt" AS attempt_created_at,
        request.id AS owner_id,
        request.state AS owner_state,
        request."createdAt" AS owner_created_at
      FROM sim_urans_requests request
      JOIN sim_urans_request_campaigns request_owner
        ON request_owner.request_id = request.id
       AND request_owner.campaign_id = ${campaignId}
       AND request_owner.state = 'active'
      JOIN result_attempts attempt
        ON attempt.sim_job_id = request.sim_job_id
       AND attempt.airfoil_id = obligation.airfoil_id
       AND attempt.simulation_preset_revision_id = obligation.revision_id
       AND attempt.aoa_deg = obligation.aoa_deg
      JOIN result_classifications classification
        ON classification.result_attempt_id = attempt.id
       AND classification.airfoil_id = attempt.airfoil_id
       AND classification.simulation_preset_revision_id =
           attempt.simulation_preset_revision_id
       AND classification.aoa_deg = attempt.aoa_deg
       AND classification.regime IS NOT DISTINCT FROM attempt.regime
       AND classification.state = 'accepted'
      WHERE request.airfoil_id = obligation.airfoil_id
        AND request.revision_id = obligation.revision_id
        AND request.fidelity = 'full'
        AND (
          request.aoa_deg = obligation.aoa_deg
          OR request.aoa_deg IS NULL
        )
        AND request.sim_job_id IS NOT NULL
        AND attempt.status = 'done'
        AND attempt.source = 'solved'
        AND attempt.evidence_payload ->> 'fidelity' = 'urans_full'
      ORDER BY
        COALESCE(attempt."solvedAt", attempt."createdAt") DESC,
        attempt.id DESC
      LIMIT 1
    ) request_evidence ON TRUE
    WHERE obligation.airfoil_id = ${scope.airfoilId}
      AND obligation.state IN ('pending', 'running', 'satisfied', 'blocked')
      AND EXISTS (
        SELECT 1
        FROM sim_campaign_points point
        LEFT JOIN results source_result ON source_result.id = point.result_id
        WHERE point.campaign_id = ${campaignId}
          AND point.condition_id = ${scope.conditionId}
          AND point.airfoil_id = obligation.airfoil_id
          AND point.state <> 'released'
          AND CASE
                WHEN point.derived_by_symmetry THEN source_result.aoa_deg
                ELSE point.aoa_deg
              END = obligation.aoa_deg
      )
    ORDER BY obligation.aoa_deg ASC
  `)) as unknown as Array<{
    aoa_deg: number;
    state: "pending" | "running" | "satisfied" | "blocked";
    source_result_id: string | null;
    source_result_attempt_id: string | null;
    attempt_count: number;
    max_attempts: number;
    last_outcome: string | null;
    updated_at: Date | string;
    promotion_id: string | null;
    source_rans_attempt_id: string | null;
    lineage_rans_attempt_id: string | null;
    fast_result_id: string | null;
    fast_result_attempt_id: string | null;
    verify_id: string | null;
    verify_state: string | null;
    verify_sim_job_id: string | null;
    verify_result_id: string | null;
    verify_delta_cl: number | null;
    verify_delta_cd: number | null;
    verify_delta_cm: number | null;
    verify_latest_evidence_reasons: string[] | null;
    verify_submit_error: string | null;
    verify_submit_http_status: number | null;
    verify_created_at: Date | string | null;
    verify_updated_at: Date | string | null;
    verify_final_result_id: string | null;
    verify_final_result_attempt_id: string | null;
    verify_final_classification_state: string | null;
    verify_final_classification_reasons: string[] | null;
    verify_final_created_at: Date | string | null;
    verify_final_owner_id: string | null;
    verify_final_owner_state: string | null;
    verify_final_owner_created_at: Date | string | null;
    verify_final_delta_cl: number | null;
    verify_final_delta_cd: number | null;
    verify_final_delta_cm: number | null;
    full_request_id: string | null;
    full_request_state: string | null;
    full_request_sim_job_id: string | null;
    request_latest_evidence_reasons: string[] | null;
    full_request_submit_error: string | null;
    full_request_submit_http_status: number | null;
    full_request_created_at: Date | string | null;
    full_request_updated_at: Date | string | null;
    request_final_result_id: string | null;
    request_final_result_attempt_id: string | null;
    request_final_classification_state: string | null;
    request_final_classification_reasons: string[] | null;
    request_final_created_at: Date | string | null;
    request_final_owner_id: string | null;
    request_final_owner_state: string | null;
    request_final_owner_created_at: Date | string | null;
    affected_aoa_degs: Array<number | string>;
    recovery_submissions: number;
    non_physical_submissions: number;
    interrupted_physical_runs: number;
    continuation_interrupted: boolean;
    rans_evidence_runs: number;
    preliminary_evidence_runs: number;
    full_urans_evidence_runs: number;
    legacy_urans_evidence_runs: number;
    evidence_reasons: string[] | null;
  }>;

  // A preflight incident has no PRECALC obligation by definition: automatic
  // mesh/runtime repair exhausted before aerodynamic RANS screening could
  // execute. Surface it in the same per-point journey model, but never label
  // it as RANS non-convergence or imply a fast-URANS physical-attempt budget.
  const ransIncidentRows = (await db.execute(sql`
    WITH latest_incident AS (
      SELECT DISTINCT ON (incident.result_id)
        incident.result_id,
        incident.reason,
        incident.metadata,
        incident."updatedAt" AS updated_at
      FROM sim_solver_incidents incident
      JOIN sim_solver_incident_campaigns incident_owner
        ON incident_owner.incident_id = incident.id
       AND incident_owner.campaign_id = ${campaignId}
      WHERE incident.stage = 'rans'
        AND incident.status = 'open'
        AND incident.severity = 'critical'
        AND incident.result_id IS NOT NULL
      ORDER BY
        incident.result_id,
        incident.occurred_at DESC,
        incident.id DESC
    )
    SELECT
      r.id AS result_id,
      r.aoa_deg::float8 AS aoa_deg,
      latest_incident.reason,
      latest_incident.metadata,
      latest_incident.updated_at,
      ARRAY(
        SELECT point.aoa_deg::float8
        FROM sim_campaign_points point
        WHERE point.campaign_id = ${campaignId}
          AND point.condition_id = ${scope.conditionId}
          AND point.airfoil_id = ${scope.airfoilId}
          AND point.result_id = r.id
          AND point.state = 'terminal'
        ORDER BY point.aoa_deg ASC
      ) AS affected_aoa_degs,
      (
        SELECT count(*)::int
        FROM result_attempts attempt
        WHERE attempt.result_id = r.id
          AND attempt.sim_job_id IS NOT DISTINCT FROM r.sim_job_id
          AND attempt.regime = 'rans'
      ) AS rans_evidence_runs
    FROM latest_incident
    JOIN results r ON r.id = latest_incident.result_id
    JOIN sim_campaigns campaign ON campaign.id = ${campaignId}
    JOIN sim_campaign_conditions scoped_condition
      ON scoped_condition.id = ${scope.conditionId}
     AND scoped_condition.campaign_id = campaign.id
    WHERE r.airfoil_id = ${scope.airfoilId}
      AND r.status = 'failed'
      AND scoped_condition.generation = campaign.current_condition_generation
      AND scoped_condition.status IN ('active', 'kept')
      AND EXISTS (
        SELECT 1
        FROM sim_campaign_points scoped_point
        WHERE scoped_point.campaign_id = campaign.id
          AND scoped_point.condition_id = scoped_condition.id
          AND scoped_point.airfoil_id = r.airfoil_id
          AND scoped_point.result_id = r.id
          AND scoped_point.state = 'terminal'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_precalc_obligations obligation
        WHERE obligation.airfoil_id = r.airfoil_id
          AND obligation.revision_id = r.simulation_preset_revision_id
          AND obligation.aoa_deg = r.aoa_deg
      )
    ORDER BY r.aoa_deg ASC
  `)) as unknown as Array<{
    result_id: string;
    aoa_deg: number;
    reason: string;
    metadata: Record<string, unknown> | null;
    updated_at: Date | string;
    affected_aoa_degs: Array<number | string>;
    rans_evidence_runs: number;
  }>;

  const timestampMs = (value: Date | string | null): number => {
    if (value instanceof Date) return value.getTime();
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const obligationItems = rows.map((row): CampaignPreliminaryOutcome => {
    const evidenceReasons = row.evidence_reasons ?? [];
    const affectedAoaDegs = row.affected_aoa_degs.map(Number);
    const ransStage: CampaignPreliminaryRansStage =
      row.source_rans_attempt_id !== null ||
      row.lineage_rans_attempt_id !== null
        ? "screened"
        : row.promotion_id !== null
          ? "polar_handoff"
          : "skipped";
    const hasAcceptedFastEvidence = Boolean(
      row.fast_result_id && row.fast_result_attempt_id,
    );
    const fastState: CampaignPreliminaryFastState =
      row.state === "pending"
        ? "queued"
        : row.state === "running"
          ? "running"
          : row.state === "satisfied" && hasAcceptedFastEvidence
            ? "accepted"
            : "critical";
    let outcome: CampaignPreliminaryOutcomeKind;
    if (row.state === "pending" || row.state === "running") {
      outcome = "recovering";
    } else if (row.state === "satisfied" && hasAcceptedFastEvidence) {
      outcome = "accepted";
    } else if (row.state === "satisfied") {
      // A mutable obligation flag alone cannot invent a publishable fast
      // result. Exact accepted/superseded attempt evidence is mandatory.
      outcome = "evidence_unavailable";
    } else if (row.last_outcome === "rejected_exhausted") {
      outcome = "evidence_unavailable";
    } else if (
      row.last_outcome === "continuation_permanent_failure" ||
      row.last_outcome === "continuation_no_progress_exhausted" ||
      row.last_outcome === "continuation_segment_exhausted" ||
      (row.last_outcome === "failed_exhausted" &&
        Boolean(row.continuation_interrupted))
    ) {
      outcome = "continuation_unavailable";
    } else if (row.last_outcome === "deterministic_failure") {
      outcome = "mesh_unavailable";
    } else if (row.last_outcome === "submit_blocked") {
      outcome = "submit_unavailable";
    } else {
      outcome = "recovery_unavailable";
    }

    type AcceptedFinalEvidence = {
      source: CampaignPreliminaryFinalSource;
      ownerId: string;
      ownerState: string | null;
      ownerCreatedAt: Date | string | null;
      resultId: string;
      resultAttemptId: string;
      reasons: string[];
      createdAt: Date | string | null;
      deltaCl: number | null;
      deltaCd: number | null;
      deltaCm: number | null;
    };
    const acceptedEvidenceCandidates: Array<AcceptedFinalEvidence | null> = [
      row.verify_final_result_id &&
      row.verify_final_result_attempt_id &&
      row.verify_final_owner_id &&
      row.verify_final_classification_state === "accepted"
        ? {
            source: "verify" as const,
            ownerId: row.verify_final_owner_id,
            ownerState: row.verify_final_owner_state,
            ownerCreatedAt: row.verify_final_owner_created_at,
            resultId: row.verify_final_result_id,
            resultAttemptId: row.verify_final_result_attempt_id,
            reasons: row.verify_final_classification_reasons ?? [],
            createdAt: row.verify_final_created_at,
            deltaCl: row.verify_final_delta_cl,
            deltaCd: row.verify_final_delta_cd,
            deltaCm: row.verify_final_delta_cm,
          }
        : null,
      row.request_final_result_id &&
      row.request_final_result_attempt_id &&
      row.request_final_owner_id &&
      row.request_final_classification_state === "accepted"
        ? {
            source: "full_request" as const,
            ownerId: row.request_final_owner_id,
            ownerState: row.request_final_owner_state,
            ownerCreatedAt: row.request_final_owner_created_at,
            resultId: row.request_final_result_id,
            resultAttemptId: row.request_final_result_attempt_id,
            reasons: row.request_final_classification_reasons ?? [],
            createdAt: row.request_final_created_at,
            deltaCl: null,
            deltaCd: null,
            deltaCm: null,
          }
        : null,
    ];
    const acceptedEvidence = acceptedEvidenceCandidates
      .filter(
        (candidate): candidate is AcceptedFinalEvidence => candidate !== null,
      )
      .sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt))[0];

    const finalWork = [
      row.verify_id
        ? {
            source: "verify" as const,
            ownerId: row.verify_id,
            state: row.verify_state,
            createdAt: row.verify_created_at,
            updatedAt: row.verify_updated_at,
            submitError: row.verify_submit_error,
            submitHttpStatus: row.verify_submit_http_status,
          }
        : null,
      row.full_request_id
        ? {
            source: "full_request" as const,
            ownerId: row.full_request_id,
            state: row.full_request_state,
            createdAt: row.full_request_created_at,
            updatedAt: row.full_request_updated_at,
            submitError: row.full_request_submit_error,
            submitHttpStatus: row.full_request_submit_http_status,
          }
        : null,
    ]
      .filter(
        (
          candidate,
        ): candidate is {
          source: CampaignPreliminaryFinalSource;
          ownerId: string;
          state: string | null;
          createdAt: Date | string | null;
          updatedAt: Date | string | null;
          submitError: string | null;
          submitHttpStatus: number | null;
        } => candidate !== null,
      )
      .sort(
        (a, b) =>
          timestampMs(b.createdAt) - timestampMs(a.createdAt) ||
          timestampMs(b.updatedAt) - timestampMs(a.updatedAt),
      )[0];

    let finalState: CampaignPreliminaryFinalState = "not_started";
    if (acceptedEvidence) {
      finalState = "accepted";
    } else if (finalWork?.state === "pending") {
      finalState = "queued";
    } else if (finalWork?.state === "running") {
      finalState = "running";
    } else if (finalWork) {
      // done/disagreed without an exact accepted selected full attempt is not
      // a final result. blocked/cancelled are terminal machine incidents too.
      finalState = "critical";
    }

    let finalActivityState: CampaignPreliminaryFinalActivityState | null = null;
    if (acceptedEvidence && finalWork) {
      const sameOwner =
        acceptedEvidence.source === finalWork.source &&
        acceptedEvidence.ownerId === finalWork.ownerId;
      const newerOwner =
        !sameOwner &&
        timestampMs(finalWork.createdAt) >=
          timestampMs(acceptedEvidence.ownerCreatedAt);
      if (sameOwner || newerOwner) {
        if (finalWork.state === "pending") {
          finalActivityState = "queued";
        } else if (finalWork.state === "running") {
          finalActivityState = "running";
        } else if (
          !sameOwner ||
          (finalWork.state !== "done" && finalWork.state !== "disagreed")
        ) {
          finalActivityState = "critical";
        }
      }
    }

    const finalComparison: CampaignPreliminaryFinalComparison | null =
      acceptedEvidence?.source === "verify"
        ? acceptedEvidence.ownerState === "disagreed"
          ? "disagreed"
          : acceptedEvidence.ownerState === "done"
            ? "within_tolerance"
            : null
        : null;
    const criticalStage =
      finalComparison === "disagreed" ||
      finalState === "critical" ||
      finalActivityState === "critical"
        ? ("final" as const)
        : fastState === "critical"
          ? ("fast" as const)
          : null;
    const selectedFinalReasons =
      finalState === "critical" || finalActivityState === "critical"
        ? finalWork?.source === "verify"
          ? (row.verify_latest_evidence_reasons ?? [])
          : finalWork?.source === "full_request"
            ? (row.request_latest_evidence_reasons ?? [])
            : []
        : (acceptedEvidence?.reasons ?? []);

    return {
      aoaDeg: Number(row.aoa_deg),
      sourceAoaDeg: Number(row.aoa_deg),
      derivedBySymmetry: false,
      affectedAoaDegs,
      affectedPointCount: affectedAoaDegs.length,
      state: row.state,
      outcome,
      ransStage,
      fastState,
      finalState,
      finalActivityState,
      finalComparison,
      finalDeltaCl: acceptedEvidence?.deltaCl ?? null,
      finalDeltaCd: acceptedEvidence?.deltaCd ?? null,
      finalDeltaCm: acceptedEvidence?.deltaCm ?? null,
      finalSource: acceptedEvidence?.source ?? finalWork?.source ?? null,
      criticalStage,
      fastResultId: row.fast_result_id,
      fastResultAttemptId: row.fast_result_attempt_id,
      finalResultId: acceptedEvidence?.resultId ?? null,
      finalResultAttemptId: acceptedEvidence?.resultAttemptId ?? null,
      finalEvidenceReasons: selectedFinalReasons,
      finalSubmitError: finalWork?.submitError ?? null,
      finalSubmitHttpStatus: finalWork?.submitHttpStatus ?? null,
      physicalAttemptsUsed: Number(row.attempt_count),
      physicalAttemptsMax: Number(row.max_attempts),
      recoverySubmissions: Number(row.recovery_submissions),
      nonPhysicalSubmissions: Number(row.non_physical_submissions),
      interruptedPhysicalRuns: Number(row.interrupted_physical_runs),
      ransEvidenceRuns: Number(row.rans_evidence_runs),
      preliminaryEvidenceRuns: Number(row.preliminary_evidence_runs),
      fullUransEvidenceRuns: Number(row.full_urans_evidence_runs),
      legacyUransEvidenceRuns: Number(row.legacy_urans_evidence_runs),
      evidenceReasons,
      updatedAt: isoOf(row.updated_at)!,
    };
  });
  const ransIncidentItems = ransIncidentRows.map(
    (row): CampaignPreliminaryOutcome => {
      const affectedAoaDegs = row.affected_aoa_degs.map(Number);
      const metadataReasons = Array.isArray(row.metadata?.classificationReasons)
        ? row.metadata.classificationReasons.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const evidenceReasons = [...new Set([row.reason, ...metadataReasons])];
      return {
        aoaDeg: Number(row.aoa_deg),
        sourceAoaDeg: Number(row.aoa_deg),
        derivedBySymmetry: false,
        affectedAoaDegs,
        affectedPointCount: affectedAoaDegs.length,
        state: "blocked",
        outcome:
          row.reason === "mesh-quality-failure"
            ? "mesh_unavailable"
            : "recovery_unavailable",
        ransStage: "not_started",
        fastState: "not_started",
        finalState: "not_started",
        finalActivityState: null,
        finalComparison: null,
        finalDeltaCl: null,
        finalDeltaCd: null,
        finalDeltaCm: null,
        finalSource: null,
        criticalStage: "preflight",
        fastResultId: null,
        fastResultAttemptId: null,
        finalResultId: null,
        finalResultAttemptId: null,
        finalEvidenceReasons: [],
        finalSubmitError: null,
        finalSubmitHttpStatus: null,
        physicalAttemptsUsed: 0,
        physicalAttemptsMax: 0,
        recoverySubmissions: 0,
        nonPhysicalSubmissions: 0,
        interruptedPhysicalRuns: 0,
        ransEvidenceRuns: Number(row.rans_evidence_runs),
        preliminaryEvidenceRuns: 0,
        fullUransEvidenceRuns: 0,
        legacyUransEvidenceRuns: 0,
        evidenceReasons,
        updatedAt: isoOf(row.updated_at)!,
      };
    },
  );
  // The list is conceptually per requested campaign point, not per shared
  // solver obligation. Symmetry may let ±AoA points share one immutable
  // source result, but each requested point still owns one visible row and one
  // count. Stable source ids and sourceAoaDeg preserve the exact evidence
  // relationship without collapsing the user-facing journey.
  const items = [...obligationItems, ...ransIncidentItems]
    .flatMap((item) => {
      const requestedAoaDegs = [
        ...new Set(
          (item.affectedAoaDegs.length
            ? item.affectedAoaDegs
            : [item.aoaDeg]
          ).map(Number),
        ),
      ].sort((left, right) => left - right);
      return requestedAoaDegs.map(
        (requestedAoaDeg): CampaignPreliminaryOutcome => ({
          ...item,
          aoaDeg: requestedAoaDeg,
          sourceAoaDeg: item.aoaDeg,
          derivedBySymmetry: requestedAoaDeg !== item.aoaDeg,
          affectedAoaDegs: [requestedAoaDeg],
          affectedPointCount: 1,
        }),
      );
    })
    .sort((left, right) => {
      const aoaOrder = left.aoaDeg - right.aoaDeg;
      if (aoaOrder !== 0) return aoaOrder;
      if (left.criticalStage === right.criticalStage) return 0;
      if (left.criticalStage === "preflight") return -1;
      if (right.criticalStage === "preflight") return 1;
      return 0;
    });
  return {
    total: items.reduce((sum, item) => sum + item.affectedPointCount, 0),
    recovering: items
      .filter(
        (item) =>
          item.fastState === "queued" ||
          item.fastState === "running" ||
          item.finalState === "queued" ||
          item.finalState === "running" ||
          item.finalActivityState === "queued" ||
          item.finalActivityState === "running",
      )
      .reduce((sum, item) => sum + item.affectedPointCount, 0),
    critical: items
      .filter((item) => item.criticalStage !== null)
      .reduce((sum, item) => sum + item.affectedPointCount, 0),
    unavailable: items
      .filter(
        (item) =>
          item.criticalStage === "preflight" ||
          item.fastState === "critical" ||
          item.finalState === "critical",
      )
      .reduce((sum, item) => sum + item.affectedPointCount, 0),
    verified: items
      .filter((item) => item.finalState === "accepted")
      .reduce((sum, item) => sum + item.affectedPointCount, 0),
    items,
  };
}

/** Legacy scoped maintenance endpoint with exact expected-count verification
 *  (409 on drift). Operator-facing failures/rejections are terminal URANS
 *  outcomes, while ordinary RANS trouble is owned by the automatic fidelity
 *  ladder; consequently neither class may be downgraded to a wave-1 retry here.
 *  The retained endpoint remains concurrency-safe for rolling clients and
 *  proves the confirmed eligible count is zero unless a future, explicitly
 *  modeled maintenance class is introduced. */
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
): Promise<{
  requeued: number;
  requeuedFailed: number;
  requeuedRejected: number;
  totals: CampaignProgressTotals;
}> {
  return db.transaction(async (tx) => {
    await asDb(tx).execute(
      sql`SELECT id FROM sim_campaigns WHERE id = ${campaignId} FOR UPDATE`,
    );
    await requireCampaign(tx, campaignId);
    const classFilter =
      args.errorClasses && args.errorClasses.length > 0
        ? sql`AND ${ERROR_CLASS_SQL} = ANY(${pgTextArray(args.errorClasses)}::text[])`
        : sql``;
    const lockRows = (await asDb(tx).execute(sql`
      SELECT DISTINCT candidate.airfoil_id, candidate.revision_id,
             candidate.aoa_deg::float8 AS aoa_deg
      FROM (
        SELECT p.airfoil_id, p.revision_id, p.aoa_deg
        FROM results r
        JOIN sim_campaign_points p ON p.result_id = r.id
        WHERE ${failedResultsWhere(campaignId, { conditionId: args.conditionId, airfoilId: args.airfoilId })}
          ${classFilter}
        ${
          args.includeRejected
            ? sql`
          UNION
          SELECT p.airfoil_id, p.revision_id, p.aoa_deg
          FROM results r
          JOIN sim_campaign_points p ON p.result_id = r.id
          WHERE ${rejectedResultsWhere(campaignId, { conditionId: args.conditionId, airfoilId: args.airfoilId })}
        `
            : sql``
        }
      ) candidate
      ORDER BY candidate.airfoil_id, candidate.revision_id, candidate.aoa_deg
    `)) as unknown as Array<{
      airfoil_id: string;
      revision_id: string;
      aoa_deg: number;
    }>;
    await lockPrecalcCells(
      asDb(tx),
      lockRows.map((row) => ({
        airfoilId: row.airfoil_id,
        revisionId: row.revision_id,
        aoaDeg: Number(row.aoa_deg),
      })),
    );
    const matching = (await asDb(tx).execute(sql`
      SELECT r.id
      FROM results r
      JOIN sim_campaign_points p ON p.result_id = r.id
      WHERE ${failedResultsWhere(campaignId, { conditionId: args.conditionId, airfoilId: args.airfoilId })}
        AND NOT (${DETERMINISTIC_MESH_BLOCKER_SQL})
        AND ${GENERIC_RANS_REQUEUE_ELIGIBLE_SQL}
        ${classFilter}
      FOR UPDATE OF r
    `)) as unknown as Array<{ id: string }>;
    if (matching.length !== args.expectedCount) {
      throw new CampaignError(
        "drift",
        `expected ${args.expectedCount} failed points but found ${matching.length} — refresh and confirm again`,
        {
          expected: args.expectedCount,
          actual: matching.length,
        },
      );
    }
    let matchingRejected: Array<{ id: string }> = [];
    if (args.includeRejected) {
      matchingRejected = (await asDb(tx).execute(sql`
        SELECT r.id
        FROM results r
        JOIN sim_campaign_points p ON p.result_id = r.id
        WHERE ${rejectedResultsWhere(campaignId, { conditionId: args.conditionId, airfoilId: args.airfoilId })}
          AND ${GENERIC_RANS_REQUEUE_ELIGIBLE_SQL}
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
    const ids = [
      ...matching.map((m) => m.id),
      ...matchingRejected.map((m) => m.id),
    ];
    if (ids.length > 0) {
      // Reset only eligible ordinary-RANS rows to re-claimable pending work.
      // A rejected row was status='done'; its evidence/attempt history remains
      // stored while the replacement result is produced. PRECALC/URANS rows
      // cannot enter this set because their machine-owned ladder is authoritative.
      await asDb(tx)
        .update(results)
        .set({ status: "pending", simJobId: null })
        .where(inArray(results.id, ids));
      // The admin-confirmed requeue is a new submit lifecycle. Clear any
      // prior answered-HTTP delay/block in the same transaction as the result
      // and campaign-point reset, or the UI can claim success while the
      // scheduler continues to exclude the cells.
      await asDb(tx).execute(sql`
        DELETE FROM sim_result_submit_retries
        WHERE result_id = ANY(${pgUuidArray(ids)}::uuid[])
      `);
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
  excludedAirfoilCount: number;
  totals: CampaignProgressTotals;
  remediation: CampaignRemediationSummary;
  /** Compatibility split retained for rolling clients. `awaitingUrans` is
   *  machine-owned stage-2 work. `needsReview` is a legacy wire field whose
   *  canonical predicate is now empty; unavailable machine outcomes are
   *  reported by failed/rejected/blocked totals instead. */
  reviewBuckets: CampaignReviewBuckets;
  automaticPrecalcOpen: number;
  latestLifecycleEvent: {
    action: string;
    actor: string | null;
    reason: string | null;
    createdAt: string;
  } | null;
}

const isoOf = (v: Date | string | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : v;

export async function listCampaigns(
  db: DB,
  opts: { statuses?: string[]; limit?: number; offset?: number } = {},
): Promise<{ items: CampaignListItem[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const statusFilter =
    opts.statuses && opts.statuses.length > 0
      ? sql`WHERE c.status = ANY(${pgTextArray(opts.statuses)}::text[])`
      : sql``;
  const rows = (await db.execute(sql`
    SELECT
      c.id, c.slug, c.name, c.status, c.priority, c.notes,
      c.closed_with_failed_count, c.closed_with_rejected_count, c."completedAt" AS completed_at, c."createdAt" AS created_at, c."updatedAt" AS updated_at,
      lifecycle.action AS lifecycle_action,
      lifecycle.actor AS lifecycle_actor,
      lifecycle.reason AS lifecycle_reason,
      lifecycle."createdAt" AS lifecycle_created_at,
      (SELECT count(*)::int FROM sim_campaign_conditions cc WHERE cc.campaign_id = c.id AND cc.generation = c.current_condition_generation) AS condition_count,
      (SELECT count(*)::int FROM sim_campaign_airfoils ca JOIN airfoils scoped_airfoil ON scoped_airfoil.id = ca.airfoil_id WHERE ca.campaign_id = c.id AND scoped_airfoil."archivedAt" IS NULL AND scoped_airfoil."deletedAt" IS NULL) AS airfoil_count,
      (SELECT count(*)::int FROM sim_campaign_airfoils ca JOIN airfoils scoped_airfoil ON scoped_airfoil.id = ca.airfoil_id WHERE ca.campaign_id = c.id AND (scoped_airfoil."archivedAt" IS NOT NULL OR scoped_airfoil."deletedAt" IS NOT NULL)) AS excluded_airfoil_count,
      COALESCE(pr.requested, 0)::int AS requested,
      COALESCE(pr.solved, 0)::int AS solved,
      COALESCE(pr.failed, 0)::int AS failed,
      COALESCE(pr.running, 0)::int AS running,
      COALESCE(pr.superseded, 0)::int AS superseded,
      COALESCE(pr.derived, 0)::int AS derived,
      COALESCE(pr.rejected, 0)::int AS rejected,
      COALESCE(pr.blocked, 0)::int AS blocked,
      COALESCE(pr.precalc_mesh_repairing, 0)::int AS precalc_mesh_repairing,
      COALESCE(pr.blocked_mesh_quality, 0)::int AS blocked_mesh_quality,
      COALESCE(pr.blocked_precalc_exhausted, 0)::int AS blocked_precalc_exhausted,
      COALESCE(pr.blocked_engine_submit, 0)::int AS blocked_engine_submit,
      COALESCE(pr.blocked_other, 0)::int AS blocked_other,
      (
        SELECT count(*)::int
        FROM (
          SELECT req.airfoil_id, req.revision_id, req.aoa_deg
          FROM sim_urans_request_campaigns ownership
          JOIN sim_urans_requests req ON req.id = ownership.request_id
          WHERE ownership.campaign_id = c.id
            AND ownership.state = 'active'
            AND req.state IN ('pending', 'running')
            AND req.fidelity = 'precalc'

          UNION

          SELECT obligation.airfoil_id, obligation.revision_id, obligation.aoa_deg
          FROM sim_precalc_obligations obligation
          WHERE obligation.state IN ('pending', 'running')
            AND (
              EXISTS (
                SELECT 1
                FROM sim_precalc_obligation_campaigns obligation_owner
                WHERE obligation_owner.obligation_id = obligation.id
                  AND obligation_owner.campaign_id = c.id
                  AND obligation_owner.state = 'active'
              )
              OR EXISTS (
                SELECT 1
                FROM sim_precalc_obligation_requests coverage
                JOIN sim_urans_request_campaigns request_owner
                  ON request_owner.request_id = coverage.request_id
                JOIN sim_urans_requests request
                  ON request.id = coverage.request_id
                 AND request.state IN ('pending', 'running')
                WHERE coverage.obligation_id = obligation.id
                  AND request_owner.campaign_id = c.id
                  AND request_owner.state = 'active'
              )
            )
        ) automatic_precalc_cells
      ) AS automatic_precalc_open,
      count(*) OVER ()::int AS total
    FROM sim_campaigns c
    LEFT JOIN (
      SELECT progress.campaign_id AS campaign_id, sum(requested) AS requested, sum(solved) AS solved, sum(failed) AS failed,
             sum(running) AS running, sum(superseded) AS superseded, sum(derived) AS derived,
             sum(rejected) AS rejected, sum(blocked) AS blocked,
             sum(precalc_mesh_repairing) AS precalc_mesh_repairing,
             sum(blocked_mesh_quality) AS blocked_mesh_quality,
             sum(blocked_precalc_exhausted) AS blocked_precalc_exhausted,
             sum(blocked_engine_submit) AS blocked_engine_submit,
             sum(blocked_other) AS blocked_other
      FROM sim_campaign_progress progress
      JOIN sim_campaign_conditions condition ON condition.id = progress.condition_id
      JOIN sim_campaigns progress_campaign ON progress_campaign.id = progress.campaign_id
      WHERE condition.generation = progress_campaign.current_condition_generation
      GROUP BY progress.campaign_id
    ) pr ON pr.campaign_id = c.id
    LEFT JOIN LATERAL (
      SELECT event.action, event.actor, event.reason, event."createdAt"
      FROM sim_campaign_lifecycle_events event
      WHERE event.campaign_id = c.id
      ORDER BY event."createdAt" DESC, event.id DESC
      LIMIT 1
    ) lifecycle ON true
    ${statusFilter}
    ORDER BY (c.status = 'attention') DESC, c."updatedAt" DESC
    LIMIT ${limit} OFFSET ${offset}
  `)) as unknown as Array<Record<string, unknown>>;
  const total = Number(rows[0]?.total ?? 0);
  const reviewBuckets = await reviewBucketsByCampaign(
    db,
    rows.map((r) => String(r.id)),
  );
  return {
    total,
    items: rows.map((r) => ({
      id: String(r.id),
      slug: String(r.slug),
      name: String(r.name),
      status: String(r.status),
      priority: Number(r.priority),
      notes: (r.notes as string | null) ?? null,
      closedWithFailedCount:
        r.closed_with_failed_count == null
          ? null
          : Number(r.closed_with_failed_count),
      closedWithRejectedCount:
        r.closed_with_rejected_count == null
          ? null
          : Number(r.closed_with_rejected_count),
      completedAt: isoOf(r.completed_at as Date | string | null),
      createdAt: isoOf(r.created_at as Date | string | null)!,
      updatedAt: isoOf(r.updated_at as Date | string | null)!,
      automaticPrecalcOpen: Number(r.automatic_precalc_open ?? 0),
      latestLifecycleEvent:
        r.lifecycle_action == null || r.lifecycle_created_at == null
          ? null
          : {
              action: String(r.lifecycle_action),
              actor: (r.lifecycle_actor as string | null) ?? null,
              reason: (r.lifecycle_reason as string | null) ?? null,
              createdAt: isoOf(r.lifecycle_created_at as Date | string | null)!,
            },
      conditionCount: Number(r.condition_count),
      airfoilCount: Number(r.airfoil_count),
      excludedAirfoilCount: Number(r.excluded_airfoil_count),
      totals: {
        requested: Number(r.requested),
        solved: Number(r.solved),
        failed: Number(r.failed),
        running: Number(r.running),
        superseded: Number(r.superseded),
        derived: Number(r.derived),
        rejected: Number(r.rejected),
        blocked: Number(r.blocked),
        remaining: Math.max(
          0,
          Number(r.requested) -
            Number(r.solved) -
            Number(r.derived) -
            Number(r.failed) -
            Number(r.rejected) -
            Number(r.blocked),
        ),
      },
      remediation: buildCampaignRemediationSummary({
        precalcMeshRepairing: Number(r.precalc_mesh_repairing),
        blockedMeshQuality: Number(r.blocked_mesh_quality),
        blockedPrecalcExhausted: Number(r.blocked_precalc_exhausted),
        blockedEngineSubmit: Number(r.blocked_engine_submit),
        blockedOther: Number(r.blocked_other),
      }),
      reviewBuckets: reviewBuckets.get(String(r.id)) ?? {
        awaitingUrans: 0,
        needsReview: 0,
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
  /** Per-condition rolling-compatibility ladder split; see CampaignListItem. */
  reviewBuckets: CampaignReviewBuckets;
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
  remediation: CampaignRemediationSummary;
  /** Rolling-compatibility ladder split. `needsReview` remains on the wire for
   *  old clients but has an empty canonical predicate; it must not promise a
   *  routine human adjudication workflow. */
  reviewBuckets: CampaignReviewBuckets;
  /** Fidelity ladder per-tier open counts (contract 7). */
  tierCounts: CampaignTierCounts;
  /** Derived ladder phase (contract 7): running_rans → running_precalc →
   *  running_refinement → completed; null for paused/cancelled/archived. */
  phase: CampaignPhase;
  /** Durable preliminary/final URANS recurrence and critical-exhaustion
   *  groups for this campaign. */
  solverIncidents: SolverIncidentSummary;
  airfoilCount: number;
  excludedAirfoilCount: number;
  latestLifecycleEvent: CampaignListItem["latestLifecycleEvent"];
  conditions: CampaignConditionSummary[];
  lanesSummary: Record<string, Record<string, number>>;
}

/** Bounded summary for the 10 s poll: O(conditions), counters only. */
export async function campaignSummary(
  db: DB,
  campaignId: string,
): Promise<CampaignSummary> {
  const { campaign, revision, plan } = await loadCampaignWithCurrentPlan(
    db,
    campaignId,
  );
  const progress = await campaignProgressSnapshot(db, campaignId);
  const totals = progress.totals;
  const tierCounts = await campaignOpenTierCounts(db, campaignId);
  const solverIncidents = await solverIncidentSummary(db, { campaignId });
  const reviewBucketRows = await campaignReviewBucketRows(db, campaignId);
  const reviewBuckets: CampaignReviewBuckets = reviewBucketRows.reduce(
    (acc, row) => ({
      awaitingUrans: acc.awaitingUrans + row.awaitingUrans,
      needsReview: acc.needsReview + row.needsReview,
    }),
    { awaitingUrans: 0, needsReview: 0 },
  );
  const reviewByCondition = new Map<string, CampaignReviewBuckets>();
  for (const row of reviewBucketRows) {
    const prev = reviewByCondition.get(row.conditionId) ?? {
      awaitingUrans: 0,
      needsReview: 0,
    };
    reviewByCondition.set(row.conditionId, {
      awaitingUrans: prev.awaitingUrans + row.awaitingUrans,
      needsReview: prev.needsReview + row.needsReview,
    });
  }
  const [scopeRow] = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE airfoil."archivedAt" IS NULL AND airfoil."deletedAt" IS NULL)::int AS active,
      count(*) FILTER (WHERE airfoil."archivedAt" IS NOT NULL OR airfoil."deletedAt" IS NOT NULL)::int AS excluded
    FROM sim_campaign_airfoils scope
    JOIN airfoils airfoil ON airfoil.id = scope.airfoil_id
    WHERE scope.campaign_id = ${campaignId}
  `)) as unknown as Array<{ active: number; excluded: number }>;
  const [lifecycleRow] = (await db.execute(sql`
    SELECT action, actor, reason, "createdAt" AS created_at
    FROM sim_campaign_lifecycle_events
    WHERE campaign_id = ${campaignId}
    ORDER BY "createdAt" DESC, id DESC
    LIMIT 1
  `)) as unknown as Array<{
    action: string;
    actor: string | null;
    reason: string | null;
    created_at: Date | string;
  }>;
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
      COALESCE(pr.rejected, 0)::int AS rejected,
      COALESCE(pr.blocked, 0)::int AS blocked
    FROM sim_campaign_conditions cc
    JOIN simulation_presets p ON p.id = cc.preset_id
    JOIN simulation_preset_revisions rev ON rev.id = cc.simulation_preset_revision_id
    LEFT JOIN (
      SELECT condition_id, sum(requested) AS requested, sum(solved) AS solved, sum(failed) AS failed,
             sum(running) AS running, sum(superseded) AS superseded, sum(derived) AS derived,
             sum(rejected) AS rejected, sum(blocked) AS blocked
      FROM sim_campaign_progress WHERE campaign_id = ${campaignId} GROUP BY condition_id
    ) pr ON pr.condition_id = cc.id
    WHERE cc.campaign_id = ${campaignId}
      AND cc.generation = ${campaign.currentConditionGeneration}
    ORDER BY cc.ord ASC
  `)) as unknown as Array<Record<string, unknown>>;
  const laneRows = (await db.execute(sql`
    SELECT lane.objective, lane.state, count(*)::int AS n
    FROM sim_campaign_lanes lane
    JOIN sim_campaign_conditions condition ON condition.id = lane.condition_id
    WHERE lane.campaign_id = ${campaignId}
      AND condition.generation = ${campaign.currentConditionGeneration}
    GROUP BY lane.objective, lane.state
  `)) as unknown as Array<{ objective: string; state: string; n: number }>;
  const lanesSummary: Record<string, Record<string, number>> = {};
  for (const row of laneRows) {
    lanesSummary[row.objective] = {
      ...(lanesSummary[row.objective] ?? {}),
      [row.state]: Number(row.n),
    };
  }
  const summaryRateBaseline = (
    revision.summary as Record<string, unknown> | null
  )?.rateBaselineAt;
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
      rateBaselineAt:
        typeof summaryRateBaseline === "string"
          ? summaryRateBaseline
          : isoOf(revision.createdAt),
    },
    totals,
    remediation: progress.remediation,
    reviewBuckets,
    tierCounts,
    phase: deriveCampaignPhase(campaign.status, tierCounts),
    solverIncidents,
    airfoilCount: Number(scopeRow?.active ?? 0),
    excludedAirfoilCount: Number(scopeRow?.excluded ?? 0),
    latestLifecycleEvent: lifecycleRow
      ? {
          action: lifecycleRow.action,
          actor: lifecycleRow.actor,
          reason: lifecycleRow.reason,
          createdAt: isoOf(lifecycleRow.created_at)!,
        }
      : null,
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
        blocked: Number(r.blocked),
        remaining: Math.max(
          0,
          Number(r.requested) -
            Number(r.solved) -
            Number(r.derived) -
            Number(r.failed) -
            Number(r.rejected) -
            Number(r.blocked),
        ),
      },
      reviewBuckets: reviewByCondition.get(String(r.id)) ?? {
        awaitingUrans: 0,
        needsReview: 0,
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
  perCondition: Array<
    { conditionId: string } & CampaignProgressTotals & CampaignReviewBuckets
  >;
}

/** Keyset matrix rows by airfoil slug (spec §10, cursor = last slug). */
export async function campaignAirfoilRows(
  db: DB,
  campaignId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<{ items: CampaignAirfoilRow[]; nextCursor: string | null }> {
  const campaign = await requireCampaign(db, campaignId);
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const cursorFilter = opts.cursor ? sql`AND af.slug > ${opts.cursor}` : sql``;
  const airfoilRowsPage = (await db.execute(sql`
    SELECT af.id, af.slug, af.name, af.is_symmetric
    FROM sim_campaign_airfoils ca
    JOIN airfoils af ON af.id = ca.airfoil_id
    WHERE ca.campaign_id = ${campaignId}
      AND af."archivedAt" IS NULL
      AND af."deletedAt" IS NULL
      ${cursorFilter}
    ORDER BY af.slug ASC
    LIMIT ${limit + 1}
  `)) as unknown as Array<{
    id: string;
    slug: string;
    name: string;
    is_symmetric: boolean;
  }>;
  const page = airfoilRowsPage.slice(0, limit);
  const nextCursor =
    airfoilRowsPage.length > limit
      ? (page[page.length - 1]?.slug ?? null)
      : null;
  if (page.length === 0) return { items: [], nextCursor: null };
  const ids = page.map((r) => r.id);
  const currentConditions = await db
    .select({ id: simCampaignConditions.id })
    .from(simCampaignConditions)
    .where(
      and(
        eq(simCampaignConditions.campaignId, campaignId),
        eq(
          simCampaignConditions.generation,
          campaign.currentConditionGeneration,
        ),
      ),
    );
  const currentConditionIds = currentConditions.map((row) => row.id);
  if (currentConditionIds.length === 0) {
    return {
      items: page.map((r) => ({
        airfoilId: r.id,
        slug: r.slug,
        name: r.name,
        isSymmetric: Boolean(r.is_symmetric),
        perCondition: [],
      })),
      nextCursor,
    };
  }
  const progressRows = await db
    .select()
    .from(simCampaignProgress)
    .where(
      and(
        eq(simCampaignProgress.campaignId, campaignId),
        inArray(simCampaignProgress.airfoilId, ids),
        inArray(simCampaignProgress.conditionId, currentConditionIds),
      ),
    );
  // Per-cell machine-owned awaiting-URANS work. The legacy needsReview field
  // remains for rolling compatibility but its canonical predicate is empty.
  const reviewRows = await campaignReviewBucketRows(db, campaignId, {
    airfoilIds: ids,
  });
  const reviewByCell = new Map<string, CampaignReviewBuckets>();
  for (const row of reviewRows) {
    reviewByCell.set(`${row.airfoilId}:${row.conditionId}`, {
      awaitingUrans: row.awaitingUrans,
      needsReview: row.needsReview,
    });
  }
  const byAirfoil = new Map<string, CampaignAirfoilRow["perCondition"]>();
  for (const row of progressRows) {
    const bucket = byAirfoil.get(row.airfoilId) ?? [];
    const review = reviewByCell.get(`${row.airfoilId}:${row.conditionId}`) ?? {
      awaitingUrans: 0,
      needsReview: 0,
    };
    bucket.push({
      conditionId: row.conditionId,
      requested: row.requested,
      solved: row.solved,
      failed: row.failed,
      running: row.running,
      superseded: row.superseded,
      derived: row.derived,
      rejected: row.rejected,
      blocked: row.blocked,
      remaining: Math.max(
        0,
        row.requested -
          row.solved -
          row.derived -
          row.failed -
          row.rejected -
          row.blocked,
      ),
      awaitingUrans: review.awaitingUrans,
      needsReview: review.needsReview,
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
  opts: {
    objective?: CampaignObjectiveKey;
    state?: string;
    cursor?: string | null;
    limit?: number;
  } = {},
): Promise<{ items: CampaignLaneRow[]; nextCursor: string | null }> {
  const campaign = await requireCampaign(db, campaignId);
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
      AND cc.generation = ${campaign.currentConditionGeneration}
      ${opts.objective ? sql`AND l.objective = ${opts.objective}` : sql``}
      ${opts.state ? sql`AND l.state = ${opts.state}` : sql``}
      ${cursorFilter}
    ORDER BY af.slug ASC, cc.ord ASC, l.objective ASC
    LIMIT ${limit + 1}
  `)) as unknown as Array<Record<string, unknown>>;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? `${last.airfoil_slug}~${last.condition_ord}~${last.objective}`
      : null;
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
      currentTargetAlpha:
        r.current_target_alpha == null ? null : Number(r.current_target_alpha),
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
  laneKey: {
    airfoilId: string;
    conditionId: string;
    objective: CampaignObjectiveKey;
  },
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
        sql`EXISTS (
          SELECT 1
          FROM sim_campaign_conditions visible_condition
          JOIN sim_campaigns visible_campaign
            ON visible_campaign.id = visible_condition.campaign_id
          WHERE visible_condition.id = ${simCampaignLanes.conditionId}
            AND visible_condition.campaign_id = ${simCampaignLanes.campaignId}
            AND visible_condition.generation = visible_campaign.current_condition_generation
            AND visible_condition.status IN ('active', 'kept')
        )`,
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
export async function campaignRate(
  db: DB,
  campaignId: string,
  baselineAt: string | null,
  remainingPoints: number,
): Promise<CampaignRate | null> {
  const baselineIso = baselineAt ?? new Date(0).toISOString();
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n, min(r."solvedAt") AS since
    FROM results r
    JOIN sim_campaign_points p ON ${POINT_CELL_JOIN}
    JOIN sim_campaign_conditions condition ON condition.id = p.condition_id
    JOIN sim_campaigns campaign ON campaign.id = p.campaign_id
    WHERE p.campaign_id = ${campaignId}
      AND condition.generation = campaign.current_condition_generation
      AND condition.status IN ('active', 'kept')
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
  blockedPoints: number;
  runningPoints: number;
}

/** Queue-page backlog strip: per-non-terminal-campaign remaining work from the
 *  counters table only (no point scans). */
export async function campaignBacklogStrip(
  db: DB,
): Promise<CampaignBacklogStripEntry[]> {
  const rows = (await db.execute(sql`
    SELECT c.id, c.slug, c.name, c.status, c.priority,
      COALESCE(sum(pr.requested - pr.solved - pr.derived - pr.failed - pr.rejected - pr.blocked), 0)::int AS remaining,
      COALESCE(sum(pr.failed), 0)::int AS failed,
      COALESCE(sum(pr.blocked), 0)::int AS blocked,
      COALESCE(sum(pr.running), 0)::int AS running
    FROM sim_campaigns c
    LEFT JOIN sim_campaign_progress pr
      ON pr.campaign_id = c.id
     AND EXISTS (
       SELECT 1 FROM sim_campaign_conditions progress_condition
       WHERE progress_condition.id = pr.condition_id
         AND progress_condition.generation = c.current_condition_generation
     )
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
    blockedPoints: Number(r.blocked),
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
