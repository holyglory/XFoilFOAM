import { sql } from "drizzle-orm";
import {
  canonicalAnalysisJson,
  enqueueProgressiveWorkerReport,
  validateProgressiveRemoteReport,
  validateProgressiveExecutionStopProof,
  verifyProgressiveRemoteExecution,
  type DB,
} from "@aerodb/db";
import {
  EngineError,
  type EngineClient,
  type JobResult,
  type JobStatus,
  type EngineExecutionStopProof,
} from "@aerodb/engine-client";

export class ProgressiveRemoteJobMissingError extends Error {
  constructor(executionId: string) {
    super(`The exact progressive engine job is missing: ${executionId}`);
    this.name = "ProgressiveRemoteJobMissingError";
  }
}

export async function observeProgressiveRemoteJob(
  db: DB,
  engine: Pick<
    EngineClient,
    "getJob" | "getResult" | "cancelJob" | "getExecutionStopProof"
  >,
  executionId: string,
  options: { stop?: boolean } = {},
) {
  const [owned] = await db.execute(sql`
    SELECT job.engine_job_id, job.request_payload,
      coalesce(intent.assignment_signature, job.request_payload#>>'{remoteProgressiveExecution,contentSignature}') AS assignment_signature,
      (SELECT report.report FROM progressive_worker_reports report
        WHERE report.sim_job_id = job.id
          AND report.acknowledged_at IS NOT NULL
          AND report.assignment_signature = coalesce(intent.assignment_signature, job.request_payload#>>'{remoteProgressiveExecution,contentSignature}')
          AND report.stopped_engine_job_id = job.id::text
        ORDER BY report.sequence DESC LIMIT 1) AS durable_final_report,
      (SELECT report.content_signature FROM progressive_worker_reports report
        WHERE report.sim_job_id = job.id
          AND report.acknowledged_at IS NOT NULL
          AND report.assignment_signature = coalesce(intent.assignment_signature, job.request_payload#>>'{remoteProgressiveExecution,contentSignature}')
          AND report.stopped_engine_job_id = job.id::text
        ORDER BY report.sequence DESC LIMIT 1) AS durable_final_content_signature,
      promise.id AS promise_id, promise.registered_solver_id AS solver_id
    FROM sim_jobs job
    LEFT JOIN progressive_worker_submission_intents intent ON intent.sim_job_id = job.id
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE job.id = ${executionId}::uuid AND job.request_payload->>'remoteSolver' = 'true'
      AND (intent.sim_job_id IS NOT NULL OR ${options.stop === true})
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND promise.source_base_url = job.request_payload->>'upstreamBaseUrl'
  `);
  if (!owned)
    throw new Error(
      "Progressive observation requires its durable owned submission intent",
    );
  if (owned.engine_job_id !== null && owned.engine_job_id !== executionId)
    throw new Error(
      "Foreign engine identity requires explicit reconciliation; CPU ownership is retained",
    );
  const payload = owned.request_payload as Record<string, unknown>;
  const envelope = verifyProgressiveRemoteExecution(
    payload.remoteProgressiveExecution,
    {
      solverId: String(owned.solver_id),
      promiseId: String(owned.promise_id),
      executionId,
      contentSignature: String(owned.assignment_signature),
    },
  );
  if (
    canonicalAnalysisJson(payload.engineRequest) !==
    canonicalAnalysisJson(envelope.request)
  )
    throw new Error(
      "Progressive observation differs from its immutable engine request",
    );
  if (options.stop && owned.durable_final_report) {
    const durable = validateProgressiveRemoteReport(
      owned.durable_final_report,
      envelope,
    );
    if (
      durable.contentSignature !== String(owned.durable_final_content_signature)
    )
      throw new Error("Durable progressive stop report content changed");
    if (!durable.report.stopProof)
      throw new Error("Durable progressive stop report lacks its proof");
    validateProgressiveExecutionStopProof(durable.report.stopProof);
    const replay = await enqueueProgressiveWorkerReport(db, {
      executionId,
      solverId: envelope.solverId,
      promiseId: envelope.promiseId,
      assignmentSignature: envelope.contentSignature,
      status: durable.report.status,
      result: durable.report.result,
      stopProof: durable.report.stopProof,
    });
    return {
      ...replay,
      stopped: true,
      completedCases: durable.report.status.completed_cases,
    };
  }
  const route = {
    expectedEngine: envelope.request.expected_engine!,
    expectedExecutionPool: envelope.request.expected_execution_pool,
    timeoutMs: 10_000,
  };
  let measuredStop: EngineExecutionStopProof | null = null;
  let cancellationRequested = false;
  if (options.stop) {
    try {
      measuredStop = await engine.getExecutionStopProof(executionId, route);
    } catch (error) {
      if (!(error instanceof EngineError && error.status === 404)) throw error;
    }
    if (measuredStop && measuredStop.job_id !== executionId)
      throw new Error("Engine returned a foreign execution-stop proof");
    if (measuredStop?.execution_stopped)
      validateProgressiveExecutionStopProof(measuredStop);
  }
  if (options.stop && !measuredStop?.execution_stopped) {
    const cancellation = await engine.cancelJob(executionId, {
      ...route,
      unregisteredExecution: {
        expected_engine: route.expectedEngine,
        expected_execution_pool: route.expectedExecutionPool,
      },
    });
    if (cancellation.job_id !== executionId || !cancellation.cancelled)
      throw new Error(
        "Engine did not acknowledge cancellation of the exact progressive execution",
      );
    cancellationRequested = true;
    measuredStop = await engine.getExecutionStopProof(executionId, route);
  }
  if (measuredStop && measuredStop.job_id !== executionId)
    throw new Error("Engine returned a foreign execution-stop proof");
  const neverStarted =
    measuredStop?.ownership_basis === "never_started_cancellation_fence" &&
    measuredStop.execution_stopped;
  if (neverStarted) validateProgressiveExecutionStopProof(measuredStop!);
  let status: JobStatus;
  try {
    status = await engine.getJob(
      executionId,
      neverStarted ? { timeoutMs: 10_000 } : route,
    );
  } catch (error) {
    if (error instanceof EngineError && error.status === 404)
      throw new ProgressiveRemoteJobMissingError(executionId);
    throw error;
  }
  if (status.job_id !== executionId)
    throw new Error("Engine returned a foreign job observation");
  const terminal = ["completed", "failed", "cancelled"].includes(status.state);
  let result: JobResult | null = null;
  if (
    !neverStarted &&
    (terminal || status.state === "running" || status.completed_cases > 0)
  ) {
    try {
      result = await engine.getResult(executionId, route);
    } catch (error) {
      const terminalWithoutCases =
        status.completed_cases === 0 &&
        ["failed", "cancelled"].includes(status.state);
      if (
        !(
          error instanceof EngineError &&
          (error.status === 404 ||
            (error.status === 409 && status.state === "running")) &&
          status.completed_cases === 0
        ) &&
        !(
          error instanceof EngineError &&
          error.status === 409 &&
          terminalWithoutCases
        )
      )
        throw error;
    }
  }
  const proof = terminal
    ? (measuredStop ?? (await engine.getExecutionStopProof(executionId, route)))
    : null;
  if (proof && proof.job_id !== executionId)
    throw new Error("Engine returned a foreign execution-stop proof");
  const stopProof = proof?.execution_stopped ? proof : null;
  if (stopProof && !neverStarted) {
    validateProgressiveExecutionStopProof(stopProof);
    status = await engine.getJob(executionId, route);
    try {
      result = await engine.getResult(executionId, route);
    } catch (error) {
      if (
        !(
          error instanceof EngineError &&
          status.completed_cases === 0 &&
          (error.status === 404 ||
            (error.status === 409 &&
              ["failed", "cancelled"].includes(status.state)))
        )
      )
        throw error;
      result = null;
    }
    if (
      status.state === "cancelled" &&
      result?.state === "running" &&
      !cancellationRequested
    ) {
      const cancellation = await engine.cancelJob(executionId, {
        ...route,
        unregisteredExecution: {
          expected_engine: route.expectedEngine,
          expected_execution_pool: route.expectedExecutionPool,
        },
      });
      if (cancellation.job_id !== executionId || !cancellation.cancelled)
        throw new Error(
          "Engine did not acknowledge cancellation of the exact progressive execution",
        );
      result = await engine.getResult(executionId, route);
    }
  }
  const receipt = await enqueueProgressiveWorkerReport(db, {
    executionId,
    solverId: envelope.solverId,
    promiseId: envelope.promiseId,
    assignmentSignature: envelope.contentSignature,
    status,
    result,
    stopProof,
  });
  return {
    ...receipt,
    stopped: stopProof !== null,
    completedCases: status.completed_cases,
  };
}
