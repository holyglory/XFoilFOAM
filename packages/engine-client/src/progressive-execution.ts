import { isEngineIdentity } from "./engine-identity";
import {
  resolveSolverCaseAllocations,
  solverBudgetCaseKey,
} from "./solver-budget";
import type { PolarRequest } from "./types";

export interface ProgressiveExecutionUnit {
  unitId: string;
  alpha: number;
  token: string;
  activeBudgetSeconds: number;
}

export interface ProgressiveExecutionScope {
  executionContract: "progressive-cfd-v1";
  executionId: string;
  epochId: string;
  generationId: string;
  targetId: string;
  stage: 2 | 3;
  recipeId: string;
  tokens: string[];
  units: ProgressiveExecutionUnit[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function validateProgressiveExecutionScope(
  request: PolarRequest,
  value: unknown,
): ProgressiveExecutionScope {
  if (
    !record(value) ||
    !exactKeys(value, [
      "executionContract",
      "executionId",
      "epochId",
      "generationId",
      "targetId",
      "stage",
      "recipeId",
      "tokens",
      "units",
    ]) ||
    value.executionContract !== "progressive-cfd-v1" ||
    !identifier(value.executionId, UUID) ||
    !identifier(value.epochId, UUID) ||
    !identifier(value.generationId, UUID) ||
    !identifier(value.targetId, HASH) ||
    !identifier(value.recipeId, HASH) ||
    ![2, 3].includes(value.stage as number)
  )
    throw new Error(
      "Progressive execution requires an exact versioned owner scope",
    );
  if (
    request.execution_id !== value.executionId ||
    request.expected_solver_budget_version !== 2
  )
    throw new Error(
      "Progressive request execution identity or budget version differs",
    );
  if (
    !isEngineIdentity(request.expected_engine) ||
    typeof request.expected_execution_pool !== "string" ||
    !request.expected_execution_pool.trim() ||
    !Number.isSafeInteger(request.expected_mesh_recovery_version) ||
    (request.expected_mesh_recovery_version ?? -1) < 0
  )
    throw new Error(
      "Progressive request requires an explicit engine, pool and mesh capability",
    );
  if (
    request.continue_from != null ||
    request.budget_override_s != null ||
    request.corrective_tail_periods != null
  )
    throw new Error(
      "Progressive execution cannot override its immutable case allocations",
    );
  if (
    request.resources?.case_concurrency !== 1 ||
    request.solver?.warm_start !== true
  )
    throw new Error(
      "Progressive execution must preserve its shared-mesh marched request",
    );
  if (
    !Array.isArray(value.units) ||
    value.units.length < 1 ||
    value.units.length > 512 ||
    !Array.isArray(value.tokens) ||
    value.tokens.length !== value.units.length
  )
    throw new Error(
      "Progressive execution requires a bounded complete unit scope",
    );
  const units = value.units.map((unit) => {
    if (
      !record(unit) ||
      !exactKeys(unit, ["unitId", "alpha", "token", "activeBudgetSeconds"]) ||
      !identifier(unit.unitId, UUID) ||
      !identifier(unit.token, UUID) ||
      typeof unit.alpha !== "number" ||
      !Number.isFinite(unit.alpha) ||
      typeof unit.activeBudgetSeconds !== "number" ||
      !Number.isFinite(unit.activeBudgetSeconds) ||
      unit.activeBudgetSeconds <= 0 ||
      unit.activeBudgetSeconds > (value.stage === 2 ? 900 : 43200)
    )
      throw new Error(
        "Progressive execution contains an invalid or unbounded unit",
      );
    return {
      unitId: unit.unitId,
      alpha: unit.alpha,
      token: unit.token,
      activeBudgetSeconds: unit.activeBudgetSeconds,
    };
  });
  const unitIds = new Set(units.map((unit) => unit.unitId));
  const tokens = new Set(units.map((unit) => unit.token));
  const angles = new Set(units.map((unit) => unit.alpha));
  if (
    unitIds.size !== units.length ||
    tokens.size !== units.length ||
    angles.size !== units.length ||
    new Set(value.tokens).size !== units.length ||
    value.tokens.some((token) => !identifier(token, UUID) || !tokens.has(token))
  )
    throw new Error(
      "Progressive execution unit, angle and attempt identities must be unique and complete",
    );
  const chord = request.chord_lengths?.[0];
  const speed = request.speeds?.[0];
  if (
    request.chord_lengths?.length !== 1 ||
    request.speeds?.length !== 1 ||
    typeof chord !== "number" ||
    !Number.isFinite(chord) ||
    chord <= 0 ||
    typeof speed !== "number" ||
    !Number.isFinite(speed) ||
    speed <= 0 ||
    !record(request.aoa) ||
    !exactKeys(request.aoa, ["angles"]) ||
    !Array.isArray(request.aoa.angles) ||
    request.aoa.angles.length !== units.length ||
    new Set(request.aoa.angles).size !== units.length ||
    request.aoa.angles.some((alpha) => !angles.has(alpha))
  )
    throw new Error(
      "Progressive request differs from its exact physical case scope",
    );
  const allocations = resolveSolverCaseAllocations(
    request.resources,
    units.map((unit) => ({ chord, speed, aoa_deg: unit.alpha })),
    request.expected_solver_budget_version,
  );
  for (const unit of units)
    if (
      allocations.get(
        solverBudgetCaseKey({ chord, speed, aoa_deg: unit.alpha }),
      ) !== unit.activeBudgetSeconds
    )
      throw new Error("Progressive request changed an owned case allocation");
  return {
    executionContract: "progressive-cfd-v1",
    executionId: value.executionId,
    epochId: value.epochId,
    generationId: value.generationId,
    targetId: value.targetId,
    stage: value.stage as 2 | 3,
    recipeId: value.recipeId,
    tokens: [...value.tokens] as string[],
    units,
  };
}
