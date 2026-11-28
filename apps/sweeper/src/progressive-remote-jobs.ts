import { resolveStoredProgressiveReport } from "@aerodb/db/progressive-report-reader";
import {
  canonicalRemoteHubBaseUrl,
  progressiveSolverIsTransient,
  type ProgressiveSolverFamily,
} from "@aerodb/core";
import {
  canonicalAnalysisJson,
  simJobs,
  simulationPresetRevisions,
  syncApiSettings,
  verifyProgressiveRemoteExecution,
  validateProgressiveRemoteReport,
  type DB,
  type Airfoil,
} from "@aerodb/db";
import { simulationSetupSignature, type SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import type { JobResult } from "@aerodb/engine-client";
import { eq, sql } from "drizzle-orm";
import {
  admissionCpuSlotsForRequest,
  buildPolarRequest,
  engineIdentityForSetup,
  solverImplementationIdForSetup,
} from "./build-request";
import { fetchProgressiveRemote } from "./progressive-remote-http";

async function expiredLegacyStopOnly(
  setup: SimulationSetupSnapshot,
  sourceSignature: string,
  envelope: ReturnType<typeof verifyProgressiveRemoteExecution>,
  promise: Record<string, unknown>,
  authToken: string,
  baseUrl: string,
  fetcher: typeof fetch,
) {
  const family = setup.solver.flowSolverFamily;
  const requested = envelope.request.solver?.flow_solver_family;
  const coordinates = envelope.request.airfoil.points;
  if (envelope.scope.stage !== 3 || setup.solver.timeCoordinate !== undefined ||
      !((family === "simpleFoam" && requested === "pimpleFoam") ||
        (family === "rhoSimpleFoam" && requested === "rhoPimpleFoam")) ||
      envelope.request.solver?.force_transient !== true ||
      envelope.request.solver?.transient_fallback !== true ||
      envelope.request.solver?.urans_fidelity !== "full" ||
      promise.expired !== true || !["active", "expired"].includes(String(promise.status)))
    throw new Error("The local setup or engine pool differs from the exact assigned request");
  if (!coordinates || coordinates.length < 3)
    throw new Error("Expired legacy stop-only request has no exact source geometry");
  const expected = buildPolarRequest({
    airfoil: { name: envelope.request.airfoil.name, pointFormat: envelope.request.airfoil.format,
      points: coordinates.map(([x, y]) => ({ x, y })) } as Airfoil,
    setup: { ...setup, solver: { ...setup.solver, flowSolverFamily: requested, timeCoordinate: undefined } },
    aoaList: envelope.scope.units.map(unit => unit.alpha).sort((a, b) => a - b),
    wave: 2, uransFidelity: "full",
  }).request;
  expected.solver = { ...expected.solver, warm_start: true };
  for (const key of ["expected_engine", "airfoil", "fluid", "flow_state", "roughness",
    "mesh", "urans_mesh", "urans_precalc_mesh", "solver", "speeds", "chord_lengths"] as const)
    if (canonicalAnalysisJson(expected[key] ?? null) !== canonicalAnalysisJson(envelope.request[key] ?? null))
      throw new Error("Expired legacy stop-only request changes its original numerical setup");
  // Re-read the exact assignment over the authenticated upstream channel.
  // Local expiry or a caller-supplied absence flag is never a fence proof.
  const response = await fetchProgressiveRemote(fetcher,
    `${baseUrl}/progressive-executions/${envelope.scope.executionId}`, {
      headers: { "x-xfoilfoam-solver-token": authToken }, redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  if (!response.ok) throw new Error("Expired legacy stop-only assignment could not be freshly verified");
  const body = await response.json() as {
    assignment?: {
      envelope?: unknown;
      promise?: { id?: string; status?: string; expired?: boolean; expiresAt?: string;
        airfoil?: { points?: unknown; pointFormat?: string };
        setupRevision?: { id?: string; signatureHash?: string; snapshot?: unknown } };
    };
    continuation?: { kind?: string };
  };
  const fresh = body?.assignment;
  const remote = fresh?.promise;
  const catalogPoints = remote?.airfoil?.points;
  const remoteCoordinates = Array.isArray(catalogPoints) && catalogPoints.every(point =>
    point !== null && typeof point === "object" && !Array.isArray(point) &&
    typeof point.x === "number" && Number.isFinite(point.x) &&
    typeof point.y === "number" && Number.isFinite(point.y))
    ? catalogPoints.map(point => [point.x, point.y])
    : null;
  if (!fresh || body.continuation?.kind !== "stop" || !remote ||
      remote.id !== envelope.promiseId || remote.expired !== true ||
      !["active", "expired"].includes(String(remote.status)) ||
      !Number.isFinite(Date.parse(remote.expiresAt ?? "")) || Date.parse(remote.expiresAt!) > Date.now() ||
      remote.airfoil?.pointFormat !== envelope.request.airfoil.format ||
      canonicalAnalysisJson(remoteCoordinates) !== canonicalAnalysisJson(envelope.request.airfoil.points) ||
      typeof remote.setupRevision?.id !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(remote.setupRevision.id) ||
      remote.setupRevision.signatureHash !== sourceSignature || !remote.setupRevision.snapshot ||
      simulationSetupSignature(remote.setupRevision.snapshot as SimulationSetupSnapshot) !== sourceSignature ||
      canonicalAnalysisJson(fresh.envelope ?? null) !== canonicalAnalysisJson(envelope))
    throw new Error("Expired legacy stop-only assignment changed or is no longer expired");
  return { reason: "expired_7f04bf99_solver_mismatch", checkedAt: new Date().toISOString(),
    assignmentSignature: envelope.contentSignature, promiseExpiresAt: remote.expiresAt,
    sourceRevisionId: remote.setupRevision.id };
}
import { requireExecutionPoolForSetup } from "./engine-pool";

export function progressiveRemoteExecutionSolverFamily(
  configuredFamily: ProgressiveSolverFamily,
  requestedFamily: ProgressiveSolverFamily | undefined,
): ProgressiveSolverFamily {
  if (configuredFamily !== requestedFamily)
    throw new Error("The local setup or engine pool differs from the exact assigned request");
  return configuredFamily;
}

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
    await db.execute(sql`SELECT resolve_progressive_report(to_jsonb(progressive_worker_reports.*)) AS report, content_signature FROM progressive_worker_reports
    WHERE sim_job_id = ${input.simJobId}::uuid AND sequence = ${input.reportSequence!}`);
  if (!stored) throw new Error("Worker evidence report is missing");
  const validated = validateProgressiveRemoteReport(await resolveStoredProgressiveReport(db, "worker", stored, input.simJobId), envelope);
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
    fetcher?: typeof fetch;
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
      SELECT id, airfoil_id, simulation_preset_revision_id, request_payload,
        status, "expiresAt" <= clock_timestamp() AS expired
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
    if (!family)
      throw new Error("The local setup has no solver family");
    const stopOnly = family !== envelope.request.solver?.flow_solver_family
      ? await expiredLegacyStopOnly(setup, revision.signatureHash, envelope, promise,
          settings.remoteSolverAuthToken, baseUrl, input.fetcher ?? fetch)
      : undefined;
    const executionFamily = stopOnly
      ? envelope.request.solver!.flow_solver_family!
      : progressiveRemoteExecutionSolverFamily(family, envelope.request.solver?.flow_solver_family);
    const boundaryId = setup.preset.legacyBoundaryConditionId;
    if (
      !boundaryId ||
      canonicalAnalysisJson(engineIdentityForSetup(setup)) !==
        canonicalAnalysisJson(envelope.request.expected_engine) ||
      !family ||
      executionFamily !== envelope.request.solver?.flow_solver_family ||
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
      executionFamily,
      stopOnly ? undefined : setup.solver.timeCoordinate,
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
        ...(stopOnly ? { progressiveStopOnly: stopOnly } : {}),
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
