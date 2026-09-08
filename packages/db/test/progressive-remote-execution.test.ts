import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OPENCFD_2606_ENGINE } from "../../engine-client/src/engine-identity";
import type { PolarRequest } from "../../engine-client/src/types";
import type { ProgressiveExecutionScope } from "../../engine-client/src/progressive-execution";
import {
  sealProgressiveRemoteExecution,
  verifyProgressiveRemoteExecution,
} from "../src/progressive-remote-execution";

function fixture() {
  const token = randomUUID();
  const scope: ProgressiveExecutionScope = {
    executionContract: "progressive-cfd-v1",
    executionId: randomUUID(),
    epochId: randomUUID(),
    generationId: randomUUID(),
    targetId: "a".repeat(64),
    recipeId: "b".repeat(64),
    stage: 2,
    tokens: [token],
    units: [
      { unitId: randomUUID(), token, alpha: 0, activeBudgetSeconds: 720 },
    ],
  };
  const request: PolarRequest = {
    execution_id: scope.executionId,
    expected_engine: { ...OPENCFD_2606_ENGINE },
    expected_execution_pool: "isolated-test-pool",
    expected_mesh_recovery_version: 1,
    expected_solver_budget_version: 2,
    airfoil: { name: "isolated-transport-fixture" },
    chord_lengths: [1],
    speeds: [30],
    aoa: { angles: [0] },
    solver: {
      warm_start: true,
      flow_solver_family: "rhoSimpleFoam",
      convergence_tolerance: 1e-6,
    },
    resources: {
      case_concurrency: 1,
      cpu_budget: 2,
      case_solver_budget_seconds: 720,
    },
  };
  const envelope = sealProgressiveRemoteExecution({
    solverId: randomUUID(),
    promiseId: randomUUID(),
    scope,
    request,
  });
  const expected = {
    solverId: envelope.solverId,
    promiseId: envelope.promiseId,
    executionId: scope.executionId,
    contentSignature: envelope.contentSignature,
  };
  return { envelope, expected, request, scope };
}

describe("immutable remote progressive execution envelope", () => {
  it("round-trips the exact hub request without local numerical recomposition", () => {
    const { envelope, expected, request, scope } = fixture();
    const received = verifyProgressiveRemoteExecution(
      JSON.parse(JSON.stringify(envelope)),
      expected,
    );
    expect(received.request).toEqual(request);
    expect(received.scope).toEqual(scope);
    request.solver!.convergence_tolerance = 1e-2;
    scope.units[0].activeBudgetSeconds = 900;
    expect(received.request.solver!.convergence_tolerance).toBe(1e-6);
    expect(received.scope.units[0].activeBudgetSeconds).toBe(720);
    expect(verifyProgressiveRemoteExecution(envelope, expected)).toEqual(
      received,
    );
  });

  it("accepts only property-order changes that preserve the canonical request", () => {
    const { envelope, expected } = fixture();
    const reordered = Object.fromEntries(Object.entries(envelope).reverse());
    reordered.request = Object.fromEntries(
      Object.entries(envelope.request).reverse(),
    );
    expect(verifyProgressiveRemoteExecution(reordered, expected)).toEqual(
      envelope,
    );
  });

  it.each([
    [
      "another solver",
      (input) => {
        input.expected.solverId = randomUUID();
      },
    ],
    [
      "another promise",
      (input) => {
        input.expected.promiseId = randomUUID();
      },
    ],
    [
      "another execution",
      (input) => {
        input.expected.executionId = randomUUID();
      },
    ],
    [
      "changed numerical tolerance",
      (input) => {
        input.envelope.request.solver!.convergence_tolerance = 1e-5;
      },
    ],
    [
      "changed exact speed",
      (input) => {
        input.envelope.request.speeds![0] += 1e-9;
      },
    ],
    [
      "changed CPU allocation",
      (input) => {
        input.envelope.request.resources!.cpu_budget = 96;
      },
    ],
    [
      "changed physical target",
      (input) => {
        input.envelope.scope.targetId = "c".repeat(64);
      },
    ],
    [
      "changed generation",
      (input) => {
        input.envelope.scope.generationId = randomUUID();
      },
    ],
    [
      "changed epoch",
      (input) => {
        input.envelope.scope.epochId = randomUUID();
      },
    ],
    [
      "self-resigned substitution",
      (input) => {
        input.envelope.request.solver!.convergence_tolerance = 1e-2;
        input.envelope = sealProgressiveRemoteExecution(input.envelope);
      },
    ],
  ] satisfies Array<[string, (input: ReturnType<typeof fixture>) => void]>)(
    "rejects %s against the stored assignment",
    (_name, mutate) => {
      const input = fixture();
      mutate(input);
      expect(() =>
        verifyProgressiveRemoteExecution(input.envelope, input.expected),
      ).toThrow();
    },
  );

  it("refuses unsealed or contract-drift envelopes", () => {
    const { envelope, expected } = fixture();
    for (const value of [
      null,
      [],
      {},
      { ...envelope, version: 2 },
      { ...envelope, extra: true },
      { ...envelope, contentSignature: null },
    ])
      expect(() => verifyProgressiveRemoteExecution(value, expected)).toThrow();
  });
});
