import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OPENCFD_2606_ENGINE } from "../src/engine-identity";
import {
  validateProgressiveExecutionScope,
  type ProgressiveExecutionScope,
} from "../src/progressive-execution";
import type { PolarRequest } from "../src/types";

function fixture() {
  const units = [0, 5].map((alpha, index) => ({
    unitId: randomUUID(),
    alpha,
    token: randomUUID(),
    activeBudgetSeconds: index ? 900 : 740,
  }));
  const scope: ProgressiveExecutionScope = {
    executionContract: "progressive-cfd-v1",
    executionId: randomUUID(),
    epochId: randomUUID(),
    generationId: randomUUID(),
    targetId: "a".repeat(64),
    stage: 2,
    recipeId: "b".repeat(64),
    tokens: units.map((unit) => unit.token),
    units,
  };
  const request: PolarRequest = {
    execution_id: scope.executionId,
    expected_engine: { ...OPENCFD_2606_ENGINE },
    expected_execution_pool: "test-pool",
    expected_solver_budget_version: 2,
    expected_mesh_recovery_version: 1,
    airfoil: { name: "isolated-controller-fixture" },
    chord_lengths: [0.1],
    speeds: [30],
    aoa: { angles: units.map((unit) => unit.alpha) },
    solver: { warm_start: true, flow_solver_family: "rhoSimpleFoam" },
    resources: {
      case_concurrency: 1,
      cpu_budget: 2,
      solver_processes: 2,
      case_solver_allocations: units.map((unit) => ({
        chord: 0.1,
        speed: 30,
        aoa_deg: unit.alpha,
        limit_seconds: unit.activeBudgetSeconds,
      })),
    },
  };
  return { request, scope };
}

describe("shared progressive execution ownership", () => {
  it("retains distinct case budgets and returns scope independent of mutable input", () => {
    const { request, scope } = fixture();
    const before = structuredClone(request);
    const validated = validateProgressiveExecutionScope(request, scope);
    expect(validated).toEqual(scope);
    scope.units[0].activeBudgetSeconds = 900;
    scope.tokens.reverse();
    expect(validated.units[0].activeBudgetSeconds).toBe(740);
    expect(validated.tokens[0]).toBe(validated.units[0].token);
    expect(request).toEqual(before);
  });

  it("preserves uniform precise allocations and all supported pressure conventions", () => {
    for (const family of [
      "simpleFoam",
      "rhoSimpleFoam",
      "pimpleFoam",
      "rhoPimpleFoam",
      "rhoCentralFoam",
    ] as const) {
      const { request, scope } = fixture();
      scope.stage = 3;
      scope.units.forEach((unit) => {
        unit.activeBudgetSeconds = 43000;
      });
      request.solver!.flow_solver_family = family;
      delete request.resources!.case_solver_allocations;
      request.resources!.case_solver_budget_seconds = 43000;
      expect(validateProgressiveExecutionScope(request, scope)).toEqual(scope);
    }
  });

  it.each([
    [
      "execution UUID",
      ({ request }) => {
        request.execution_id = randomUUID();
      },
    ],
    [
      "missing budget capability",
      ({ request }) => {
        delete request.expected_solver_budget_version;
      },
    ],
    [
      "unknown contract",
      ({ scope }) => {
        (scope as unknown as Record<string, unknown>).executionContract =
          "next";
      },
    ],
    [
      "missing epoch",
      ({ scope }) => {
        scope.epochId = "";
      },
    ],
    [
      "foreign target representation",
      ({ scope }) => {
        scope.targetId = randomUUID();
      },
    ],
    [
      "baseline stage",
      ({ scope }) => {
        (scope as unknown as Record<string, unknown>).stage = 1;
      },
    ],
    [
      "duplicate unit",
      ({ scope }) => {
        scope.units[1].unitId = scope.units[0].unitId;
      },
    ],
    [
      "duplicate attempt",
      ({ scope }) => {
        scope.units[1].token = scope.units[0].token;
      },
    ],
    [
      "foreign token",
      ({ scope }) => {
        scope.tokens[0] = randomUUID();
      },
    ],
    [
      "duplicate token list",
      ({ scope }) => {
        scope.tokens[1] = scope.tokens[0];
      },
    ],
    [
      "foreign angle",
      ({ request }) => {
        request.aoa.angles![0] = -2;
      },
    ],
    [
      "duplicate request angle",
      ({ request }) => {
        request.aoa.angles![1] = 0;
      },
    ],
    [
      "hidden angle range",
      ({ request }) => {
        request.aoa.start = -5;
      },
    ],
    [
      "extra physical condition",
      ({ request }) => {
        request.speeds!.push(90);
      },
    ],
    [
      "rounded physical condition",
      ({ request }) => {
        request.speeds![0] += 1e-9;
      },
    ],
    [
      "inflated allocation",
      ({ request }) => {
        request.resources!.case_solver_allocations![0].limit_seconds = 900;
      },
    ],
    [
      "overspent fast budget",
      ({ scope }) => {
        scope.units[0].activeBudgetSeconds = 901;
      },
    ],
    [
      "nonfinite allocation",
      ({ scope }) => {
        scope.units[0].activeBudgetSeconds = Infinity;
      },
    ],
    [
      "shared plus per-case allocation",
      ({ request }) => {
        request.resources!.case_solver_budget_seconds = 900;
      },
    ],
    [
      "unbound continuation",
      ({ request }) => {
        request.continue_from = {
          engine_job_id: randomUUID(),
          case_slug: "foreign-case",
        };
      },
    ],
    [
      "budget override",
      ({ request }) => {
        request.budget_override_s = 900;
      },
    ],
    [
      "mesh march disabled",
      ({ request }) => {
        request.solver!.warm_start = false;
      },
    ],
    [
      "concurrent angle rewrite",
      ({ request }) => {
        request.resources!.case_concurrency = 2;
      },
    ],
    [
      "missing pool",
      ({ request }) => {
        delete request.expected_execution_pool;
      },
    ],
    [
      "missing engine",
      ({ request }) => {
        delete request.expected_engine;
      },
    ],
    [
      "unknown mesh capability",
      ({ request }) => {
        request.expected_mesh_recovery_version = -1;
      },
    ],
  ] satisfies Array<[string, (input: ReturnType<typeof fixture>) => void]>)(
    "rejects %s before execution",
    (_name, mutate) => {
      const input = fixture();
      mutate(input);
      expect(() =>
        validateProgressiveExecutionScope(input.request, input.scope),
      ).toThrow();
    },
  );
});
