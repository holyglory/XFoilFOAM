import {
  canonicalRemoteHubBaseUrl,
  progressiveSolverIsTransient,
} from "@aerodb/core";
import {
  canonicalAnalysisJson,
  simJobs,
  simulationPresetRevisions,
  syncApiSettings,
  verifyProgressiveRemoteExecution,
  validateProgressiveRemoteReport,
  type DB,
} from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import type { JobResult } from "@aerodb/engine-client";
import { eq, sql } from "drizzle-orm";
import {
  admissionCpuSlotsForRequest,
  engineIdentityForSetup,
  solverImplementationIdForSetup,
} from "./build-request";
import { requireExecutionPoolForSetup } from "./engine-pool";

export async function assertProgressiveWorkerEvidenceJob(
  db: DB,
  input: {
    simJobId: string;
    engineJobId: string;
    result: JobResult;
    reportSequence?: number;
  },
): Promise<boolean> {
  const [job] =
    await db.execute(sql`SELECT job.request_payload, job.engine_job_id, promise.id AS promise_id,
    promise.registered_solver_id AS owner_id, promise.source_base_url,
    settings.remote_solver_registered_id AS registered_id, settings.upstream_base_url,
    intent.assignment_signature AS intent_signature
    FROM sim_jobs job LEFT JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    LEFT JOIN sync_api_settings settings ON settings.id = 1
    LEFT JOIN progressive_worker_submission_intents intent ON intent.sim_job_id = job.id
    WHERE job.id = ${input.simJobId}::uuid`);
  if (!job) throw new Error("Worker evidence has no stored execution");
  const payload = (job.request_payload ?? {}) as Record<string, unknown>;
  if (payload.remoteProgressiveExecution == null) {
    if (input.reportSequence !== undefined)
      throw new Error("Worker report cannot bind an ordinary solver job");
    return false;
  }
  if (
    payload.remoteSolver !== true ||
    input.engineJobId !== input.simJobId ||
    (job.engine_job_id !== null && job.engine_job_id !== input.simJobId) ||
    !job.registered_id ||
    job.owner_id !== job.registered_id ||
    !job.upstream_base_url ||
    !Number.isSafeInteger(input.reportSequence) ||
    Number(input.reportSequence) < 1
  )
    throw new Error(
      "Assigned worker evidence requires its exact owned report and execution",
    );
  const upstream = canonicalRemoteHubBaseUrl(String(job.upstream_base_url));
  if (job.source_base_url !== upstream || payload.upstreamBaseUrl !== upstream)
    throw new Error("Worker evidence belongs to another configured upstream");
  const envelope = verifyProgressiveRemoteExecution(
    payload.remoteProgressiveExecution,
    {
      solverId: String(job.registered_id),
      promiseId: String(job.promise_id),
      executionId: input.simJobId,
      contentSignature: String(job.intent_signature ?? ""),
    },
  );
  if (
    canonicalAnalysisJson(payload.engineRequest) !==
    canonicalAnalysisJson(envelope.request)
  )
    throw new Error(
      "Worker evidence request differs from its immutable assignment",
    );
  const [stored] =
    await db.execute(sql`SELECT report, content_signature FROM progressive_worker_reports
    WHERE sim_job_id = ${input.simJobId}::uuid AND sequence = ${input.reportSequence!}`);
  if (!stored) throw new Error("Worker evidence report is missing");
  const validated = validateProgressiveRemoteReport(stored.report, envelope);
  if (
    validated.contentSignature !== stored.content_signature ||
    validated.report.result === null ||
    canonicalAnalysisJson(validated.report.result) !==
      canonicalAnalysisJson(input.result)
  )
    throw new Error("Worker evidence does not match its stored report bytes");
  return true;
}

export async function mirrorProgressiveRemoteJob(
  db: DB,
  input: {
    envelope: unknown;
    assignment: {
      solverId: string;
      promiseId: string;
      executionId: string;
      contentSignature: string;
    };
  },
) {
  const envelope = verifyProgressiveRemoteExecution(
    input.envelope,
    input.assignment,
  );
  const speed = envelope.request.speeds?.[0];
  const chord = envelope.request.chord_lengths?.[0];
  if (speed === undefined || chord === undefined)
    throw new Error("The assigned execution has no exact physical condition");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [settings] = await connection
      .select()
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    if (
      settings?.remoteSolverRegisteredId !== envelope.solverId ||
      !settings.remoteSolverAuthToken ||
      !settings.upstreamBaseUrl
    )
      throw new Error(
        "Progressive assignment does not belong to this registered worker",
      );
    const baseUrl = canonicalRemoteHubBaseUrl(settings.upstreamBaseUrl);
    const [promise] = await connection.execute(sql`
      SELECT id, airfoil_id, simulation_preset_revision_id, request_payload
      FROM sync_sweep_promises WHERE id = ${envelope.promiseId}::uuid
        AND registered_solver_id = ${envelope.solverId}::uuid AND source_base_url = ${baseUrl}
        AND request_payload->>'remoteSolver' = 'true' FOR UPDATE
    `);
    if (!promise)
      throw new Error("Progressive assignment has no exact mirrored promise");
    const [existing] = await connection
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, envelope.scope.executionId));
    if (existing) {
      const payload = existing.requestPayload as Record<string, unknown>;
      if (
        existing.airfoilId !== promise.airfoil_id ||
        existing.simulationPresetRevisionId !==
          promise.simulation_preset_revision_id ||
        payload.remoteSolver !== true ||
        payload.syncPromiseId !== envelope.promiseId ||
        payload.upstreamBaseUrl !== baseUrl ||
        canonicalAnalysisJson(payload.remoteProgressiveExecution) !==
          canonicalAnalysisJson(envelope) ||
        canonicalAnalysisJson(payload.engineRequest) !==
          canonicalAnalysisJson(envelope.request)
      )
        throw new Error(
          "Progressive worker job conflicts with its immutable assignment",
        );
      return { jobId: existing.id, request: envelope.request, replayed: true };
    }
    const [competing] = await connection.execute(sql`
      SELECT id FROM sim_jobs WHERE request_payload->>'syncPromiseId' = ${envelope.promiseId} LIMIT 1
    `);
    if (competing)
      throw new Error(
        "The mirrored promise already belongs to another execution",
      );
    const [revision] = await connection
      .select()
      .from(simulationPresetRevisions)
      .where(
        eq(
          simulationPresetRevisions.id,
          String(promise.simulation_preset_revision_id),
        ),
      );
    if (!revision) throw new Error("The mirrored execution setup is missing");
    const setup = revision.snapshot as unknown as SimulationSetupSnapshot;
    const pool = await requireExecutionPoolForSetup(connection, setup);
    const family = setup.solver.flowSolverFamily;
    const boundaryId = setup.preset.legacyBoundaryConditionId;
    if (
      !boundaryId ||
      canonicalAnalysisJson(engineIdentityForSetup(setup)) !==
        canonicalAnalysisJson(envelope.request.expected_engine) ||
      !family ||
      family !== envelope.request.solver?.flow_solver_family ||
      pool.routingKey !== envelope.request.expected_execution_pool ||
      setup.referenceGeometry.referenceLengthM !== chord ||
      setup.flowState.speedMps !== speed
    )
      throw new Error(
        "The local setup or engine pool differs from the exact assigned request",
      );
    const points = await connection.execute(sql`
      SELECT aoa_deg FROM sync_sweep_promise_points WHERE promise_id = ${envelope.promiseId}::uuid ORDER BY aoa_deg
    `);
    const angles = envelope.scope.units
      .map((unit) => unit.alpha)
      .sort((left, right) => left - right);
    if (
      canonicalAnalysisJson(points.map((point) => Number(point.aoa_deg))) !==
      canonicalAnalysisJson(angles)
    )
      throw new Error("The mirrored promise changes the assigned angle list");
    const transient = progressiveSolverIsTransient(
      family,
      setup.solver.timeCoordinate,
    );
    if (envelope.request.solver?.force_transient !== transient)
      throw new Error(
        "The assigned request changes the immutable numerical time coordinate",
      );
    const slots = admissionCpuSlotsForRequest(envelope.request);
    if (slots !== (envelope.request.resources?.solver_processes ?? 1))
      throw new Error(
        "The assigned CPU reservation does not match the exact marched execution",
      );
    await connection.insert(simJobs).values({
      id: envelope.scope.executionId,
      airfoilId: String(promise.airfoil_id),
      simulationPresetRevisionId: revision.id,
      solverImplementationId: solverImplementationIdForSetup(setup),
      solverExecutionPoolId: pool.id,
      bcIds: [boundaryId],
      referenceChordM: setup.referenceGeometry.referenceLengthM,
      methodKey: transient ? "openfoam.urans" : "openfoam.rans",
      wave: transient ? 2 : 1,
      jobKind: angles.length > 1 ? "sweep" : "targeted",
      status: "pending",
      admissionCpuSlots: slots,
      totalCases: angles.length,
      requestPayload: {
        remoteSolver: true,
        solverId: envelope.solverId,
        syncPromiseId: envelope.promiseId,
        upstreamBaseUrl: baseUrl,
        remoteProgressiveExecution: envelope,
        engineRequest: envelope.request,
        resources: envelope.request.resources,
        aoas: angles,
        speedMap: [
          {
            speed,
            bcId: boundaryId,
            presetRevisionId: revision.id,
            mach: setup.flowState.mach,
          },
        ],
        setupSnapshot: setup,
        meshRecoveryVersion: envelope.request.expected_mesh_recovery_version,
      },
    });
    await connection.execute(sql`
      UPDATE sync_sweep_promises SET request_payload = request_payload || ${JSON.stringify(
        {
          progressiveExecutionId: envelope.scope.executionId,
          executionContract: "progressive-cfd-v1",
        },
      )}::jsonb WHERE id = ${envelope.promiseId}::uuid
    `);
    return {
      jobId: envelope.scope.executionId,
      request: envelope.request,
      replayed: false,
    };
  });
}
