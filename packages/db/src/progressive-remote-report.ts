import type {
  EngineExecutionStopProof,
  JobResult,
  JobStatus,
} from "../../engine-client/src/types";
import {
  isEngineRuntimeIdentity,
  isEngineIdentity,
  sameEngineIdentity,
} from "../../engine-client/src/engine-identity";
import {
  resolveSolverCaseAllocations,
  solverBudgetCaseKey,
} from "../../engine-client/src/solver-budget";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import { validateProgressiveExecutionStopProof } from "./progressive-cfd-settlement";
import {
  verifyProgressiveRemoteExecution,
  type ProgressiveRemoteExecutionEnvelope,
} from "./progressive-remote-execution";

export interface ProgressiveRemoteReport {
  version: 1;
  solverId: string;
  promiseId: string;
  executionId: string;
  assignmentSignature: string;
  sequence: number;
  status: JobStatus;
  result: JobResult | null;
  stopProof: EngineExecutionStopProof | null;
}

export function progressiveReportedPointSources(result: JobResult) {
  const candidates = result.polars.flatMap((polar) =>
    [...polar.points, ...(polar.attempts ?? [])].map((point) => ({
      point,
      polar,
      contentSignature: analysisContentHash({
        kind: "progressive-reported-point-v1",
        executionId: result.job_id,
        chord: polar.chord,
        speed: polar.speed,
        reynolds: polar.reynolds,
        mach: polar.mach ?? null,
        point,
      }),
    })),
  );
  return [
    ...new Map(
      candidates.map((source) => [source.contentSignature, source]),
    ).values(),
  ];
}

export function resolveProgressiveReportedPoint(
  result: JobResult,
  input: {
    alpha: number;
    speed: number;
    chord: number;
    caseSlug: string | null;
  },
) {
  if (
    ![input.alpha, input.speed, input.chord].every(Number.isFinite) ||
    input.chord <= 0 ||
    input.speed < 0
  )
    throw new Error("Reported point requires an exact finite physical cell");
  const candidates = progressiveReportedPointSources(result).filter(
    ({ polar, point }) =>
      polar.chord === input.chord &&
      polar.speed === input.speed &&
      point.aoa_deg === input.alpha &&
      (point.case_slug ?? null) === input.caseSlug,
  );
  const unique = new Map(
    candidates.map((candidate) => [candidate.contentSignature, candidate]),
  );
  if (unique.size !== 1)
    throw new Error(
      "Reported point is missing or has competing source generations",
    );
  return [...unique.values()][0];
}

export function isFinalProgressiveRemoteReport(
  report: ProgressiveRemoteReport,
): boolean {
  return (
    report.stopProof !== null &&
    ["completed", "failed", "cancelled"].includes(report.status.state) &&
    (report.stopProof.ownership_basis === "never_started_cancellation_fence" ||
      (report.result !== null &&
        ["completed", "failed", "cancelled"].includes(report.result.state)))
  );
}

export function validateProgressiveRemoteReportOrder(
  report: ProgressiveRemoteReport,
  previous: ProgressiveRemoteReport | null,
): void {
  if (report.sequence !== (previous?.sequence ?? 0) + 1)
    throw new Error(
      "Remote reports must arrive in their durable publication order",
    );
  if (!previous) return;
  if (report.status.completed_cases < previous.status.completed_cases)
    throw new Error("Remote report cannot forget previously completed cases");
  if (
    previous.stopProof !== null &&
    (report.stopProof === null ||
      !["completed", "failed", "cancelled"].includes(report.status.state) ||
      report.status.solver_budget_progress?.cases.some(
        (item) => item.solver_running,
      ))
  )
    throw new Error("An acknowledged stopped remote execution cannot resume");
  if (
    isFinalProgressiveRemoteReport(previous) &&
    (!isFinalProgressiveRemoteReport(report) ||
      canonicalAnalysisJson(report.result) !==
        canonicalAnalysisJson(previous.result) ||
      report.status.state !== previous.status.state ||
      report.status.total_cases !== previous.status.total_cases ||
      report.status.completed_cases !== previous.status.completed_cases)
  )
    throw new Error(
      "Final remote execution evidence cannot change after its stop fence",
    );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateProgressiveRemoteReport(
  value: unknown,
  assignment: ProgressiveRemoteExecutionEnvelope,
): { report: ProgressiveRemoteReport; contentSignature: string } {
  const envelope = verifyProgressiveRemoteExecution(assignment, {
    solverId: assignment.solverId,
    promiseId: assignment.promiseId,
    executionId: assignment.scope.executionId,
    contentSignature: assignment.contentSignature,
  });
  if (
    !record(value) ||
    Object.keys(value).length !== 9 ||
    ![
      "version",
      "solverId",
      "promiseId",
      "executionId",
      "assignmentSignature",
      "sequence",
      "status",
      "result",
      "stopProof",
    ].every((key) => Object.hasOwn(value, key)) ||
    value.version !== 1 ||
    value.solverId !== envelope.solverId ||
    value.promiseId !== envelope.promiseId ||
    value.executionId !== envelope.scope.executionId ||
    value.assignmentSignature !== envelope.contentSignature ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1
  )
    throw new Error(
      "Remote report does not identify its exact assigned execution and sequence",
    );
  const states = ["pending", "running", "completed", "failed", "cancelled"];
  const status = value.status;
  if (
    !record(status) ||
    status.job_id !== envelope.scope.executionId ||
    typeof status.state !== "string" ||
    !states.includes(status.state) ||
    (status.total_cases !== envelope.scope.units.length &&
      !(
        status.total_cases === 0 &&
        record(value.stopProof) &&
        value.stopProof.ownership_basis === "never_started_cancellation_fence"
      )) ||
    !Number.isSafeInteger(status.completed_cases) ||
    Number(status.completed_cases) < 0 ||
    Number(status.completed_cases) > envelope.scope.units.length
  )
    throw new Error("Remote report has invalid execution progress");
  const expectedEngine = envelope.request.expected_engine!;
  const expectedPool = envelope.request.expected_execution_pool;
  const validateProvenance = (
    item: Record<string, unknown>,
    required: boolean,
  ) => {
    if (
      (required || item.engine != null) &&
      (!isEngineRuntimeIdentity(item.engine) ||
        !sameEngineIdentity(item.engine, expectedEngine))
    )
      throw new Error("Remote report lacks matching real runtime provenance");
    if (
      (item.execution_pool != null && item.execution_pool !== expectedPool) ||
      (item.requested_execution_pool != null &&
        item.requested_execution_pool !== expectedPool)
    )
      throw new Error("Remote report changed its assigned execution pool");
    if (
      item.requested_engine != null &&
      (!isEngineIdentity(item.requested_engine) ||
        !sameEngineIdentity(item.requested_engine, expectedEngine))
    )
      throw new Error("Remote report changed its requested engine identity");
  };
  validateProvenance(status, false);
  const chord = envelope.request.chord_lengths![0];
  const speed = envelope.request.speeds![0];
  const allocations = resolveSolverCaseAllocations(
    envelope.request.resources,
    envelope.scope.units.map((unit) => ({ chord, speed, aoa_deg: unit.alpha })),
    2,
  );
  const validateCase = (
    physical: { chord: unknown; speed: unknown; aoa_deg: unknown },
    seconds: unknown,
    limit?: unknown,
  ) => {
    if (
      typeof physical.chord !== "number" ||
      typeof physical.speed !== "number" ||
      typeof physical.aoa_deg !== "number"
    )
      throw new Error("Remote report lacks exact physical case coordinates");
    const allocated = allocations.get(
      solverBudgetCaseKey({
        chord: physical.chord,
        speed: physical.speed,
        aoa_deg: physical.aoa_deg,
      }),
    );
    if (
      allocated === undefined ||
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      (limit !== undefined && limit !== allocated)
    )
      throw new Error(
        "Remote report changes an owned physical case or measured budget",
      );
  };
  if (status.solver_budget_progress != null) {
    const progress = status.solver_budget_progress;
    if (
      !record(progress) ||
      progress.version !== 1 ||
      progress.job_id !== envelope.scope.executionId ||
      typeof progress.observed_at !== "string" ||
      !Number.isFinite(Date.parse(progress.observed_at)) ||
      !Array.isArray(progress.cases) ||
      progress.cases.length > envelope.scope.units.length
    )
      throw new Error("Remote report has malformed live solver accounting");
    const seen = new Set<string>();
    for (const item of progress.cases) {
      if (!record(item) || typeof item.solver_running !== "boolean")
        throw new Error("Remote solver activity is not measured");
      if (typeof item.limit_seconds !== "number")
        throw new Error("Remote solver accounting omitted its granted budget");
      validateCase(
        { chord: item.chord, speed: item.speed, aoa_deg: item.aoa_deg },
        item.solver_active_seconds,
        item.limit_seconds,
      );
      const key = JSON.stringify([item.chord, item.speed, item.aoa_deg]);
      if (seen.has(key))
        throw new Error("Remote report repeats a live physical case");
      seen.add(key);
    }
  }
  if (value.result !== null) {
    const result = value.result;
    if (
      !record(result) ||
      result.job_id !== envelope.scope.executionId ||
      typeof result.state !== "string" ||
      !states.includes(result.state) ||
      !Array.isArray(result.polars) ||
      result.polars.length > 1
    )
      throw new Error("Remote report has invalid result ownership");
    validateProvenance(result, result.polars.length > 0);
    for (const polar of result.polars) {
      if (
        !record(polar) ||
        polar.chord !== chord ||
        polar.speed !== speed ||
        !Array.isArray(polar.points) ||
        polar.points.length > envelope.scope.units.length ||
        (polar.attempts != null &&
          (!Array.isArray(polar.attempts) || polar.attempts.length > 2048))
      )
        throw new Error("Remote result changes the assigned polar scope");
      for (const point of [
        ...polar.points,
        ...((polar.attempts as unknown[]) ?? []),
      ]) {
        if (!record(point))
          throw new Error("Remote result contains malformed attempt evidence");
        if (
          typeof point.converged !== "boolean" ||
          typeof point.unsteady !== "boolean"
        )
          throw new Error(
            "Remote result must retain actual convergence and unsteadiness state",
          );
        for (const coefficient of [point.cl, point.cd, point.cm])
          if (
            coefficient != null &&
            (typeof coefficient !== "number" || !Number.isFinite(coefficient))
          )
            throw new Error("Remote result contains a malformed coefficient");
        validateCase(
          { chord, speed, aoa_deg: point.aoa_deg },
          point.solver_active_seconds,
        );
        validateProvenance(point, true);
        if (point.solver_budget != null) {
          const guard = point.solver_budget;
          if (
            !record(guard) ||
            guard.version !== 1 ||
            guard.scope !== "physical_case_v1" ||
            typeof guard.exhausted !== "boolean" ||
            typeof guard.limit_seconds !== "number"
          )
            throw new Error(
              "Remote result has malformed budget-guard evidence",
            );
          validateCase(
            { chord, speed, aoa_deg: point.aoa_deg },
            point.solver_active_seconds,
            guard.limit_seconds,
          );
        }
      }
    }
  }
  if (value.stopProof !== null) {
    if (
      !record(value.stopProof) ||
      value.stopProof.job_id !== envelope.scope.executionId ||
      !["completed", "failed", "cancelled"].includes(String(status.state))
    )
      throw new Error(
        "Remote physical-stop proof belongs to a different or nonterminal execution",
      );
    validateProgressiveExecutionStopProof(
      value.stopProof as unknown as EngineExecutionStopProof,
    );
    if (
      value.stopProof.ownership_basis === "never_started_cancellation_fence" &&
      (Number(status.completed_cases) !== 0 ||
        (record(value.result) && (value.result.polars as unknown[]).length))
    )
      throw new Error(
        "A never-started remote execution cannot contain calculated evidence",
      );
  }
  const report = JSON.parse(
    canonicalAnalysisJson(value),
  ) as ProgressiveRemoteReport;
  return { report, contentSignature: analysisContentHash(report) };
}
