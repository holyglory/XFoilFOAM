import type { SolverCaseAllocation } from "./types";

export type SolverBudgetCase = Pick<
  SolverCaseAllocation,
  "chord" | "speed" | "aoa_deg"
>;

export function solverBudgetCaseKey(physical: SolverBudgetCase): string {
  if (
    ![physical.chord, physical.speed, physical.aoa_deg].every(
      Number.isFinite,
    ) ||
    physical.chord <= 0 ||
    physical.speed <= 0
  )
    throw new Error("Solver allocation requires a finite physical case");
  return JSON.stringify([physical.chord, physical.speed, physical.aoa_deg]);
}

export function resolveSolverCaseAllocations(
  resources: unknown,
  cases: readonly SolverBudgetCase[],
  expectedVersion?: unknown,
): Map<string, number> {
  if (!resources || typeof resources !== "object" || Array.isArray(resources))
    throw new Error("Solver allocation resources are missing");
  if (expectedVersion != null && expectedVersion !== 2)
    throw new Error(
      "Solver allocation contract version differs from version two",
    );
  const scope = new Set(cases.map(solverBudgetCaseKey));
  if (!scope.size || scope.size > 512 || scope.size !== cases.length)
    throw new Error(
      "Solver allocation scope must contain one to 512 unique physical cases",
    );
  const values = resources as Record<string, unknown>;
  const shared = values.case_solver_budget_seconds;
  const allocations = values.case_solver_allocations;
  const validLimit = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 43200;
  if (allocations == null) {
    if (!validLimit(shared))
      throw new Error("A finite positive shared solver allocation is required");
    return new Map([...scope].map((key) => [key, shared]));
  }
  if (
    shared != null ||
    expectedVersion !== 2 ||
    !Array.isArray(allocations) ||
    allocations.length !== scope.size
  )
    throw new Error(
      "Exact solver allocations require version two and complete exclusive scope",
    );
  const resolved = new Map<string, number>();
  for (const value of allocations) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Malformed solver case allocation");
    const allocation = value as SolverCaseAllocation;
    const key = solverBudgetCaseKey(allocation);
    if (
      !scope.has(key) ||
      resolved.has(key) ||
      !validLimit(allocation.limit_seconds)
    )
      throw new Error(
        "Solver allocation differs from its exact physical case scope",
      );
    resolved.set(key, allocation.limit_seconds);
  }
  return resolved;
}
