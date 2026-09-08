import { describe, expect, it } from "vitest";
import {
  resolveSolverCaseAllocations,
  solverBudgetCaseKey,
} from "../src/solver-budget";

const cases = [
  { chord: 1, speed: 30, aoa_deg: 0 },
  { chord: 1, speed: 30, aoa_deg: 1 },
];
const allocations = cases.map((physical, index) => ({
  ...physical,
  limit_seconds: index ? 900 : 780,
}));

describe("exact physical-case solver allocations", () => {
  it("retains a distinct immutable allocation for each recovery case", () => {
    const source = structuredClone(allocations);
    const result = resolveSolverCaseAllocations(
      { case_solver_allocations: source },
      cases,
      2,
    );
    source[0].limit_seconds = 900;
    expect(result.get(solverBudgetCaseKey(cases[0]))).toBe(780);
    expect(result.get(solverBudgetCaseKey(cases[1]))).toBe(900);
    expect(solverBudgetCaseKey({ ...cases[0], speed: 30.000000001 })).not.toBe(
      solverBudgetCaseKey(cases[0]),
    );
  });

  it("preserves explicitly shared allocations for legacy uniform sweeps", () => {
    expect([
      ...resolveSolverCaseAllocations(
        { case_solver_budget_seconds: 900 },
        cases,
      ).values(),
    ]).toEqual([900, 900]);
  });

  it.each([undefined, null, 0, 1, 3, "2"])(
    "does not authorize a map using version %s",
    (version) => {
      expect(() =>
        resolveSolverCaseAllocations(
          { case_solver_allocations: allocations },
          cases,
          version,
        ),
      ).toThrow();
    },
  );

  it("rejects missing, duplicate, foreign, ambiguous and unbounded allocations", () => {
    for (const resources of [
      {},
      { case_solver_allocations: [] },
      { case_solver_allocations: [allocations[0]] },
      { case_solver_allocations: [allocations[0], allocations[0]] },
      {
        case_solver_allocations: [
          allocations[0],
          { ...allocations[1], speed: 31 },
        ],
      },
      { case_solver_allocations: allocations, case_solver_budget_seconds: 900 },
      {
        case_solver_allocations: [
          allocations[0],
          { ...allocations[1], limit_seconds: Infinity },
        ],
      },
      { case_solver_budget_seconds: true },
      { case_solver_budget_seconds: 43201 },
    ])
      expect(() => resolveSolverCaseAllocations(resources, cases, 2)).toThrow();
    expect(() =>
      resolveSolverCaseAllocations({ case_solver_budget_seconds: 900 }, [
        cases[0],
        cases[0],
      ]),
    ).toThrow();
    expect(() =>
      resolveSolverCaseAllocations({ case_solver_budget_seconds: 900 }, []),
    ).toThrow();
  });
});
