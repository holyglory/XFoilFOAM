import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OPENCFD_2606_ENGINE } from "../../engine-client/src/engine-identity";
import type { ProgressiveExecutionScope } from "../../engine-client/src/progressive-execution";
import type { PolarRequest } from "../../engine-client/src/types";
import { sealProgressiveRemoteExecution } from "../src/progressive-remote-execution";
import { progressiveRemoteReportInventory } from "../src/progressive-remote-inventory";
import {
  isFinalProgressiveRemoteReport,
  validateProgressiveRemoteReportOrder,
  validateProgressiveRemoteReport,
  resolveProgressiveReportedPoint,
  type ProgressiveRemoteReport,
} from "../src/progressive-remote-report";

function fixture() {
  const units = [0, 5].map((alpha) => ({
    unitId: randomUUID(),
    token: randomUUID(),
    alpha,
    activeBudgetSeconds: 900,
  }));
  const scope: ProgressiveExecutionScope = {
    executionContract: "progressive-cfd-v1",
    executionId: randomUUID(),
    epochId: randomUUID(),
    generationId: randomUUID(),
    targetId: "a".repeat(64),
    recipeId: "b".repeat(64),
    stage: 2,
    tokens: units.map((unit) => unit.token),
    units,
  };
  const request: PolarRequest = {
    execution_id: scope.executionId,
    expected_engine: { ...OPENCFD_2606_ENGINE },
    expected_execution_pool: "test-pool",
    expected_solver_budget_version: 2,
    expected_mesh_recovery_version: 1,
    airfoil: { name: "isolated-report-fixture" },
    chord_lengths: [1],
    speeds: [30],
    aoa: { angles: [0, 5] },
    solver: { warm_start: true },
    resources: { case_concurrency: 1, case_solver_budget_seconds: 900 },
  };
  const assignment = sealProgressiveRemoteExecution({
    solverId: randomUUID(),
    promiseId: randomUUID(),
    scope,
    request,
  });
  const runtime = {
    ...OPENCFD_2606_ENGINE,
    build_id: "isolated-test-build",
    application_source_sha256: "c".repeat(64),
  };
  const report: ProgressiveRemoteReport = {
    version: 1,
    solverId: assignment.solverId,
    promiseId: assignment.promiseId,
    executionId: scope.executionId,
    assignmentSignature: assignment.contentSignature,
    sequence: 1,
    status: {
      job_id: scope.executionId,
      state: "running",
      total_cases: 2,
      completed_cases: 1,
      engine: runtime,
      solver_budget_progress: {
        version: 1,
        job_id: scope.executionId,
        observed_at: "2026-09-07T09:00:00Z",
        cases: [
          {
            chord: 1,
            speed: 30,
            aoa_deg: 0,
            solver_active_seconds: 48,
            limit_seconds: 900,
            solver_running: false,
          },
        ],
      },
    },
    result: {
      job_id: scope.executionId,
      state: "running",
      engine: runtime,
      execution_pool: "test-pool",
      polars: [
        {
          chord: 1,
          speed: 30,
          reynolds: 2_000_000,
          points: [],
          attempts: [
            {
              aoa_deg: 0,
              cl: 0.4,
              cd: 0.03,
              unsteady: false,
              converged: false,
              first_order_fallback: false,
              images: {},
              engine: runtime,
              error: "isolated unconverged attempt",
              failure_disposition: "hard_solver",
              solver_active_seconds: 48,
              solver_budget: {
                version: 1,
                scope: "physical_case_v1",
                limit_seconds: 900,
                exhausted: false,
              },
            },
          ],
        },
      ],
    },
    stopProof: null,
  };
  return { assignment, report };
}

describe("remote progressive incremental report validation", () => {
  it("inventories all exact raw generations without inventing evidence for empty reports", () => {
    const { report } = fixture();
    const first = progressiveRemoteReportInventory(report);
    expect(first.sources).toHaveLength(1);
    expect(first.sources[0]).toMatchObject({ aoa_deg: 0, case_slug: null });
    report.result!.polars[0].points.push(
      structuredClone(report.result!.polars[0].attempts![0]),
    );
    expect(progressiveRemoteReportInventory(report).sources).toEqual(
      first.sources,
    );
    report.result!.polars[0].points[0].cl = 0.45;
    const competing = progressiveRemoteReportInventory(report);
    expect(competing.sources).toHaveLength(2);
    expect(competing.sources).toContainEqual(first.sources[0]);
    expect(competing.inventorySignature).not.toBe(first.inventorySignature);
    const empty = progressiveRemoteReportInventory({
      ...report,
      sequence: 2,
      result: null,
    });
    expect(empty.sources).toEqual([]);
    expect(empty.inventorySignature).not.toBe(first.inventorySignature);
    expect(
      progressiveRemoteReportInventory({ ...report, sequence: 3, result: null })
        .inventorySignature,
    ).not.toBe(empty.inventorySignature);
  });

  it("binds a point to its exact physical cell and immutable raw source, without confusing duplicate listings with competing generations", () => {
    const { report } = fixture();
    const input = { alpha: 0, speed: 30, chord: 1, caseSlug: null };
    const original = resolveProgressiveReportedPoint(report.result!, input);
    expect(original.point).toEqual(report.result!.polars[0].attempts![0]);
    expect(original.contentSignature).toMatch(/^[a-f0-9]{64}$/);
    report.result!.polars[0].points.push(structuredClone(original.point));
    expect(
      resolveProgressiveReportedPoint(report.result!, input).contentSignature,
    ).toBe(original.contentSignature);
    expect(() =>
      resolveProgressiveReportedPoint(report.result!, {
        ...input,
        speed: 30.001,
      }),
    ).toThrow("missing");
    expect(() =>
      resolveProgressiveReportedPoint(report.result!, {
        ...input,
        caseSlug: "foreign-case",
      }),
    ).toThrow("missing");
    expect(() =>
      resolveProgressiveReportedPoint(report.result!, {
        ...input,
        alpha: Number.NaN,
      }),
    ).toThrow("finite physical cell");
    report.result!.polars[0].points[0].cl = 0.5;
    expect(() =>
      resolveProgressiveReportedPoint(report.result!, input),
    ).toThrow("competing source generations");
    report.result!.polars[0].attempts = [];
    expect(
      resolveProgressiveReportedPoint(report.result!, input).contentSignature,
    ).not.toBe(original.contentSignature);
  });
  it("preserves a measured zero-case never-started cancellation without fabricating the requested case count", () => {
    const { assignment, report } = fixture();
    report.status = {
      job_id: report.executionId,
      state: "cancelled",
      total_cases: 0,
      completed_cases: 0,
    };
    report.result = null;
    report.stopProof = {
      version: 1,
      job_id: report.executionId,
      execution_stopped: true,
      producer_stopped: true,
      namespace_verified: true,
      remaining: [],
      observed_at: "2026-09-07T09:00:00Z",
      error: null,
      fence: "cancel_marker",
      ownership_basis: "never_started_cancellation_fence",
    };
    expect(
      validateProgressiveRemoteReport(report, assignment).report.status
        .total_cases,
    ).toBe(0);
    report.stopProof.namespace_verified = false;
    expect(() => validateProgressiveRemoteReport(report, assignment)).toThrow(
      "verified execution-stop proof",
    );
    report.stopProof.namespace_verified = true;
    report.stopProof.ownership_basis = "recorded_execution_namespace";
    expect(() => validateProgressiveRemoteReport(report, assignment)).toThrow(
      "execution progress",
    );
    report.stopProof = null;
    expect(() => validateProgressiveRemoteReport(report, assignment)).toThrow(
      "execution progress",
    );
  });

  it("retains unpublished attempts and measured progress without making a valid polar claim", () => {
    const { assignment, report } = fixture();
    const validated = validateProgressiveRemoteReport(report, assignment);
    expect(validated.report).toEqual(report);
    expect(validated.contentSignature).toMatch(/^[a-f0-9]{64}$/);
    expect(validated.report.result!.polars[0].points).toEqual([]);
    expect(validated.report.result!.polars[0].attempts![0].converged).toBe(
      false,
    );
    report.result!.polars[0].attempts![0].cl = 999;
    expect(validated.report.result!.polars[0].attempts![0].cl).toBe(0.4);
  });

  it("allows overrun measurements but never increases the granted allocation", () => {
    const { assignment, report } = fixture();
    report.status.solver_budget_progress!.cases[0].solver_active_seconds = 901;
    const point = report.result!.polars[0].attempts![0];
    point.solver_active_seconds = 901;
    point.solver_budget!.exhausted = true;
    expect(validateProgressiveRemoteReport(report, assignment).report).toEqual(
      report,
    );
    point.solver_budget!.limit_seconds = 901;
    expect(() => validateProgressiveRemoteReport(report, assignment)).toThrow(
      "budget",
    );
  });

  it("requires a terminal exact namespace proof, not merely a completed label", () => {
    const { assignment, report } = fixture();
    report.status.state = "failed";
    report.result!.state = "failed";
    report.stopProof = {
      version: 1,
      job_id: report.executionId,
      execution_stopped: true,
      producer_stopped: true,
      namespace_verified: true,
      remaining: [],
      observed_at: "2026-09-07T09:01:00Z",
      error: null,
      fence: "terminal_result",
      ownership_basis: "recorded_execution_namespace",
    };
    expect(
      validateProgressiveRemoteReport(report, assignment).report.stopProof,
    ).toEqual(report.stopProof);
    expect(isFinalProgressiveRemoteReport(report)).toBe(true);
    const next = structuredClone(report);
    next.sequence += 1;
    next.status.solver_budget_progress!.cases.forEach((item) => {
      item.solver_running = false;
    });
    next.stopProof!.observed_at = "2026-09-07T09:02:00Z";
    expect(() =>
      validateProgressiveRemoteReportOrder(next, report),
    ).not.toThrow();
    for (const changed of [
      { ...next, result: null },
      { ...next, result: { ...next.result!, polars: [] } },
      { ...next, result: { ...next.result!, state: "running" as const } },
      {
        ...next,
        status: {
          ...next.status,
          completed_cases: next.status.completed_cases + 1,
        },
      },
    ])
      expect(() =>
        validateProgressiveRemoteReportOrder(changed, report),
      ).toThrow("Final remote execution evidence cannot change");
    const partial = {
      ...report,
      result: { ...report.result!, state: "running" as const },
    };
    expect(isFinalProgressiveRemoteReport(partial)).toBe(false);
    expect(isFinalProgressiveRemoteReport({ ...report, result: null })).toBe(
      false,
    );
    expect(isFinalProgressiveRemoteReport({ ...report, stopProof: null })).toBe(
      false,
    );
    expect(() =>
      validateProgressiveRemoteReportOrder(next, partial),
    ).not.toThrow();
    report.stopProof.remaining = [12345];
    expect(() => validateProgressiveRemoteReport(report, assignment)).toThrow(
      "execution-stop",
    );
  });

  it.each([
    [
      "foreign execution",
      (input) => {
        input.report.executionId = randomUUID();
      },
    ],
    [
      "foreign worker",
      (input) => {
        input.report.solverId = randomUUID();
      },
    ],
    [
      "foreign promise",
      (input) => {
        input.report.promiseId = randomUUID();
      },
    ],
    [
      "changed assignment",
      (input) => {
        input.report.assignmentSignature = "d".repeat(64);
      },
    ],
    [
      "missing sequence",
      (input) => {
        input.report.sequence = 0;
      },
    ],
    [
      "foreign status",
      (input) => {
        input.report.status.job_id = randomUUID();
      },
    ],
    [
      "invented case count",
      (input) => {
        input.report.status.total_cases = 3;
      },
    ],
    [
      "impossible completion",
      (input) => {
        input.report.status.completed_cases = 3;
      },
    ],
    [
      "foreign result",
      (input) => {
        input.report.result!.job_id = randomUUID();
      },
    ],
    [
      "foreign physical condition",
      (input) => {
        input.report.result!.polars[0].speed += 1e-9;
      },
    ],
    [
      "foreign angle",
      (input) => {
        input.report.result!.polars[0].attempts![0].aoa_deg = 1;
      },
    ],
    [
      "missing runtime provenance",
      (input) => {
        input.report.result!.polars[0].attempts![0].engine = null;
      },
    ],
    [
      "missing measured time",
      (input) => {
        input.report.result!.polars[0].attempts![0].solver_active_seconds =
          null;
      },
    ],
    [
      "foreign live accounting",
      (input) => {
        input.report.status.solver_budget_progress!.job_id = randomUUID();
      },
    ],
    [
      "duplicate live accounting",
      (input) => {
        input.report.status.solver_budget_progress!.cases.push(
          input.report.status.solver_budget_progress!.cases[0],
        );
      },
    ],
    [
      "NaN coefficient",
      (input) => {
        input.report.result!.polars[0].attempts![0].cl = NaN;
      },
    ],
  ] satisfies Array<[string, (input: ReturnType<typeof fixture>) => void]>)(
    "rejects %s before accepting a report",
    (_name, mutate) => {
      const input = fixture();
      mutate(input);
      expect(() =>
        validateProgressiveRemoteReport(input.report, input.assignment),
      ).toThrow();
    },
  );
});
