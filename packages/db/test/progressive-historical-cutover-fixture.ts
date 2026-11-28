import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { DB } from "../src/client";
import { analysisContentHash } from "../src/analysis-target";
import { sealProgressiveRemoteExecution } from "../src/progressive-remote-execution";
import { acknowledgeProgressiveWorkerReport } from "../src/progressive-worker-reports";
import { simJobs, progressiveWorkerSubmissionIntents } from "../src/schema";
import { mirrorProgressiveRemoteJob } from "../../../apps/sweeper/src/progressive-remote-jobs";
import { submitProgressiveRemoteJob } from "../../../apps/sweeper/src/progressive-remote-submission";
import { observeProgressiveRemoteJob } from "../../../apps/sweeper/src/progressive-remote-observation";
import { receiveProgressiveCampaignAssignments } from "../../../apps/sweeper/src/remote-solver";
import { periodicPoint } from "../test-support/periodic-urans-point";
import { withRegisteredRoundDatabases } from "./registered-replacement-db-fixture";
import { EngineError, type EngineClient, type EngineExecutionStopProof, type PolarRequest } from "../../engine-client/src";

// The registered HTTP server and normal catalogue/revision importer define the
// wire contract. No assignment document is fabricated from receiver assumptions.
export async function verifyHistoricalWorkerCutover(
  source: DB, sourceJobId: string, request: PolarRequest,
  proof: (id: string) => EngineExecutionStopProof,
) {
  await withRegisteredRoundDatabases(source, async (hub, worker, base, requests) => {
    const solverId = randomUUID(), promiseId = randomUUID(), instance = randomUUID();
    const executionId = sourceJobId, credential = randomUUID() + randomUUID();
    const digest = createHash("sha256").update(credential).digest("hex");
    const [job] = await hub.sql`SELECT * FROM sim_jobs WHERE id=${executionId}`;
    const scope = (job.request_payload as { progressive: unknown }).progressive;
    const envelope = sealProgressiveRemoteExecution({ solverId, promiseId, scope, request });
    const assignment = { solverId, promiseId, executionId, contentSignature: envelope.contentSignature };
    await hub.sql`INSERT INTO registered_remote_solvers(id,instance_id,instance_name,cpu_capacity,cpu_budget,auth_token_hash,credential_version)
      VALUES(${solverId},${instance},'historical HTTP cutover',96,96,${digest},1)`;
    await hub.sql`INSERT INTO sync_sweep_promises(id,registered_solver_id,source_instance_id,airfoil_id,simulation_preset_revision_id,
      aoa_count,"expiresAt",request_payload,status) VALUES(${promiseId},${solverId},${instance},${job.airfoil_id},${job.simulation_preset_revision_id},
      ${envelope.scope.units.length},clock_timestamp()+interval '1 hour','{}'::jsonb,'active')`;
    for (const unit of envelope.scope.units)
      await hub.sql`INSERT INTO sync_sweep_promise_points(promise_id,airfoil_id,simulation_preset_revision_id,aoa_deg)
        VALUES(${promiseId},${job.airfoil_id},${job.simulation_preset_revision_id},${unit.alpha})`;
    await hub.sql`INSERT INTO progressive_remote_dispatches(sim_job_id,promise_id,solver_id,cpu_slots,content_signature,envelope)
      VALUES(${executionId},${promiseId},${solverId},1,${envelope.contentSignature},${JSON.stringify(envelope)}::jsonb)`;
    await hub.sql`UPDATE sync_api_settings SET enabled=true WHERE id=1`;
    await hub.sql`INSERT INTO sync_api_permissions(data_type,can_fetch,can_push) VALUES('sweeps',true,false),('polars',false,true)
      ON CONFLICT(data_type) DO UPDATE SET can_fetch=excluded.can_fetch,can_push=excluded.can_push`;
    await worker.sql.begin(async tx => {
      await tx`SET LOCAL client_min_messages=warning`;
      await tx`TRUNCATE airfoils CASCADE`;
    });
    await worker.sql`UPDATE sync_api_settings SET instance_id=${instance},enabled=true,remote_solver_enabled=true,
      remote_solver_transfer_paused=false,remote_solver_registered_id=${solverId},remote_solver_auth_token=${credential},upstream_base_url=${base} WHERE id=1`;
    await worker.sql`UPDATE solver_execution_pools SET enabled=(routing_key=${request.expected_execution_pool!})`;
    const engine = { submitPolar: vi.fn(), cancelJob: vi.fn(), getExecutionStopProof: vi.fn(), getJob: vi.fn(), getResult: vi.fn() };
    const active = await receiveProgressiveCampaignAssignments(worker.db, engine as unknown as EngineClient, fetch);
    expect(active.errors.some(item => item.error.includes("exact assigned request"))).toBe(true);
    expect(await worker.sql`SELECT id FROM sim_jobs WHERE id=${executionId}`).toEqual([]);
    expect(engine.submitPolar).not.toHaveBeenCalled();
    expect(engine.cancelJob).not.toHaveBeenCalled();
    const endpoint = `${base}/progressive-executions/${executionId}`;
    const headers = { "x-xfoilfoam-solver-token": credential };
    const response = await fetch(endpoint, { headers, redirect: "error" });
    expect(response.status).toBe(200);
    const document = await response.json();
    expect(Object.keys(document).sort()).toEqual(["assignment", "continuation"]);
    expect(document.assignment.promise.airfoil.points[0]).toHaveProperty("x");
    expect(Array.isArray(document.assignment.envelope.request.airfoil.points[0])).toBe(true);
    const [local] = await worker.sql`SELECT promise.airfoil_id,promise.simulation_preset_revision_id,revision.snapshot,
      revision.solver_implementation_id FROM sync_sweep_promises promise JOIN simulation_preset_revisions revision
        ON revision.id=promise.simulation_preset_revision_id WHERE promise.id=${promiseId}`;
    expect(local.airfoil_id).not.toBe(document.assignment.promise.airfoil.id);
    expect(local.simulation_preset_revision_id).not.toBe(document.assignment.promise.setupRevision.id);
    await worker.sql`UPDATE sync_sweep_promises SET status='expired',"expiresAt"=clock_timestamp()-interval '1 hour' WHERE id=${promiseId}`;
    const mirror = (fetcher: typeof fetch = fetch, candidate = envelope) => mirrorProgressiveRemoteJob(worker.db, {
      envelope: candidate, assignment: { ...assignment, contentSignature: candidate.contentSignature }, fetcher });
    // A stale local expiry cannot override a renewed, authenticated hub promise.
    await expect(mirror()).rejects.toThrow("no longer expired");
    await hub.sql`UPDATE sync_sweep_promises SET status='expired',"expiresAt"=clock_timestamp()-interval '1 hour' WHERE id=${promiseId}`;
    await expect(mirror((url, init) => fetch(url, { ...init, headers: { "x-xfoilfoam-solver-token": "wrong-fixture-token" } })))
      .rejects.toThrow("freshly verified");
    const points = document.assignment.promise.airfoil.points as { x: number; y: number }[];
    const changedPoints = points.map((point, index) => index === 1 ? { ...point, y: point.y + 0.001 } : point);
    await hub.sql`UPDATE airfoils SET points=${JSON.stringify(changedPoints)}::jsonb WHERE id=${job.airfoil_id}`;
    await expect(mirror()).rejects.toThrow("changed");
    await hub.sql`UPDATE airfoils SET points=${JSON.stringify(points)}::jsonb WHERE id=${job.airfoil_id}`;
    const changed = sealProgressiveRemoteExecution({ solverId, promiseId, scope, request: {
      ...request, solver: { ...request.solver, n_iterations: request.solver!.n_iterations! + 1 } } });
    await expect(mirror(fetch, changed)).rejects.toThrow("original numerical setup");
    expect(await worker.sql`SELECT id FROM sim_jobs WHERE id=${executionId}`).toEqual([]);
    let attempt = 0;
    const transient503: typeof fetch = async (url, init) => {
      if (attempt++ === 0) return new Response("retry", { status: 503, headers: { "retry-after": "0" } });
      return fetch(url, init);
    };
    expect(await mirror(transient503)).toMatchObject({ jobId: executionId, replayed: false });
    expect(attempt).toBe(2);
    const [stopOnly] = await worker.sql`SELECT request_payload FROM sim_jobs WHERE id=${executionId}`;
    expect(stopOnly.request_payload).toMatchObject({ progressiveStopOnly: {
      assignmentSignature: envelope.contentSignature, sourceRevisionId: document.assignment.promise.setupRevision.id } });
    await worker.sql`UPDATE sync_sweep_promises SET status='active',"expiresAt"=clock_timestamp()+interval '1 hour' WHERE id=${promiseId}`;
    expect(await submitProgressiveRemoteJob(worker.db, engine as unknown as EngineClient, executionId))
      .toMatchObject({ kind: "stop_required" });
    let fenced = false;
    const fenceEngine = {
      getExecutionStopProof: vi.fn(async () => {
        if (!fenced) throw new EngineError("unregistered execution", 404);
        return { ...proof(executionId), ownership_basis: "never_started_cancellation_fence" as const, fence: "cancel_marker" as const };
      }),
      cancelJob: vi.fn(async (id: string, route: unknown) => {
        expect(id).toBe(executionId);
        expect(route).toMatchObject({ unregisteredExecution: {
          expected_engine: request.expected_engine, expected_execution_pool: request.expected_execution_pool } });
        fenced = true;
        return { job_id: id, cancelled: true };
      }).mockRejectedValueOnce(new EngineError("native namespace unavailable", 503)),
      getJob: vi.fn(async () => ({ job_id: executionId, state: "cancelled" as const, completed_cases: 0, total_cases: 0 })),
      getResult: vi.fn(),
    };
    await expect(observeProgressiveRemoteJob(worker.db, fenceEngine, executionId, { stop: true }))
      .rejects.toThrow("native namespace unavailable");
    expect(await worker.sql`SELECT sim_job_id FROM progressive_worker_reports WHERE sim_job_id=${executionId}`).toEqual([]);
    expect(await observeProgressiveRemoteJob(worker.db, fenceEngine, executionId, { stop: true }))
      .toMatchObject({ stopped: true, completedCases: 0 });
    expect(fenceEngine.cancelJob).toHaveBeenCalledTimes(2);
    expect(fenceEngine.getResult).not.toHaveBeenCalled();
    expect(await worker.sql`SELECT sim_job_id FROM progressive_worker_submission_intents WHERE sim_job_id=${executionId}`).toEqual([]);
    expect(await worker.sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}`).toEqual([]);
    await worker.sql`DELETE FROM progressive_worker_reports WHERE sim_job_id=${executionId}`;
    await worker.sql`DELETE FROM sim_jobs WHERE id=${executionId}`;
    // Seed an already-running historical mirror, then run the current receiver
    // and normal durable reporting/acknowledgement path over those stored bytes.
    const [pool] = await worker.sql`SELECT id FROM solver_execution_pools WHERE routing_key=${request.expected_execution_pool!}`;
    const payload = { remoteSolver: true, solverId, syncPromiseId: promiseId, upstreamBaseUrl: base,
      remoteProgressiveExecution: envelope, engineRequest: envelope.request, resources: request.resources };
    await worker.db.insert(simJobs).values({ id: executionId, airfoilId: String(local.airfoil_id),
      bcIds: [local.snapshot.preset.legacyBoundaryConditionId], simulationPresetRevisionId: String(local.simulation_preset_revision_id),
      solverImplementationId: String(local.solver_implementation_id), solverExecutionPoolId: String(pool.id),
      referenceChordM: request.chord_lengths![0], status: "running", engineJobId: executionId,
      wave: 2, methodKey: "openfoam.urans", requestPayload: payload, totalCases: envelope.scope.units.length, admissionCpuSlots: 1 });
    await worker.db.insert(progressiveWorkerSubmissionIntents).values({ simJobId: executionId, token: randomUUID(),
      assignmentSignature: envelope.contentSignature, authorization: { kind: "authorized", executionId, contentSignature: envelope.contentSignature } });
    expect(await mirror()).toEqual({ jobId: executionId, request: envelope.request, replayed: true });
    expect(await submitProgressiveRemoteJob(worker.db, engine as unknown as EngineClient, executionId)).toMatchObject({ kind: "observe" });
    const runtime = { ...request.expected_engine!, build_id: "historical-cutover-fixture", application_source_sha256: analysisContentHash({ fixture: executionId }) };
    const completed = {
      getJob: vi.fn(async () => ({ job_id: executionId, state: "completed" as const, completed_cases: envelope.scope.units.length,
        total_cases: envelope.scope.units.length, engine: runtime })),
      getResult: vi.fn(async () => ({ job_id: executionId, state: "completed" as const, engine: runtime,
        execution_pool: request.expected_execution_pool, urans_recovery_version: request.expected_urans_recovery_version,
        mesh_recovery_version: request.expected_mesh_recovery_version, polars: [{ speed: request.speeds![0], chord: request.chord_lengths![0],
          reynolds: request.speeds![0] * request.chord_lengths![0] / request.fluid!.kinematic_viscosity!, points: [],
          attempts: envelope.scope.units.map(unit => ({ ...periodicPoint(unit.alpha, 20, true), fidelity: "urans_full", engine: runtime })) }] })),
      getExecutionStopProof: vi.fn(async () => proof(executionId)), cancelJob: vi.fn(),
    };
    const observed = await observeProgressiveRemoteJob(worker.db, completed, executionId);
    expect(observed).toMatchObject({ stopped: true, completedCases: envelope.scope.units.length });
    await acknowledgeProgressiveWorkerReport(worker.db, { executionId, solverId, sequence: observed.sequence, contentSignature: observed.contentSignature });
    completed.getJob.mockClear(); completed.getResult.mockClear();
    expect(await observeProgressiveRemoteJob(worker.db, completed, executionId, { stop: true })).toMatchObject({ stopped: true, replayed: true });
    expect(completed.getJob).not.toHaveBeenCalled(); expect(completed.getResult).not.toHaveBeenCalled();
    const [retained] = await worker.sql`SELECT request_payload,wave,method_key FROM sim_jobs WHERE id=${executionId}`;
    expect(retained.request_payload.engineRequest).toEqual(envelope.request);
    expect(retained.request_payload.remoteProgressiveExecution).toEqual(envelope);
    expect(retained).toMatchObject({ wave: 2, method_key: "openfoam.urans" });
    expect(engine.submitPolar).not.toHaveBeenCalled();
    expect(requests.some(item => item.path.endsWith("/start"))).toBe(false);
  });
}
