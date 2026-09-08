import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { DB } from "../src/client";
import {
  sealProgressiveRemoteExecution,
  type ProgressiveRemoteExecutionEnvelope,
} from "../src/progressive-remote-execution";
import { mirrorProgressiveRemoteJob } from "../../../apps/sweeper/src/progressive-remote-jobs";
import type { EngineExecutionStopProof } from "../../engine-client/src";
import type { EngineClient } from "../../engine-client/src";
import { verifyProgressiveWorkerSubmission } from "./progressive-worker-submission-fixture";
import { resetOrphans } from "../../../apps/sweeper/src/reconcile";
import { submitPendingJobWithLifecycleGuard } from "../../../apps/sweeper/src/submit-lifecycle";
import { solverDirectLifecycleSql } from "../src/solver-reservations";
import { observeProgressiveRemoteJob } from "../../../apps/sweeper/src/progressive-remote-observation";
import { EngineError } from "../../engine-client/src";
import { verifyProgressiveAssignmentIntake } from "./progressive-assignment-intake-fixture";

export async function verifyProgressiveWorkerJobMirror(
  db: DB,
  source: ProgressiveRemoteExecutionEnvelope,
  stopProof: (executionId: string) => EngineExecutionStopProof,
  submissionMode: "timeout" | "success" | "never-authorized" = "timeout",
) {
  const executionId = randomUUID();
  const promiseId = randomUUID();
  const envelope = sealProgressiveRemoteExecution({
    solverId: source.solverId,
    promiseId,
    scope: { ...source.scope, executionId },
    request: { ...source.request, execution_id: executionId },
  });
  const assignment = {
    solverId: envelope.solverId,
    promiseId,
    executionId,
    contentSignature: envelope.contentSignature,
  };
  const [settings] = await db.execute(
    sql`SELECT instance_id, remote_solver_registered_id, remote_solver_auth_token, upstream_base_url FROM sync_api_settings WHERE id = 1`,
  );
  const [owner] = await db.execute(
    sql`SELECT instance_id FROM registered_remote_solvers WHERE id = ${envelope.solverId}::uuid`,
  );
  const [sourceJob] = await db.execute(
    sql`SELECT airfoil_id, simulation_preset_revision_id FROM sim_jobs WHERE id = ${source.scope.executionId}::uuid`,
  );
  const baseUrl = "https://worker-mirror-fixture.invalid/api/sync/v1";
  try {
    await db.execute(sql`
      INSERT INTO sync_api_settings (id, remote_solver_registered_id, remote_solver_auth_token, upstream_base_url)
      VALUES (1, ${envelope.solverId}::uuid, 'isolated-mirror-fixture-credential', ${baseUrl})
      ON CONFLICT (id) DO UPDATE SET remote_solver_registered_id = EXCLUDED.remote_solver_registered_id,
        remote_solver_auth_token = EXCLUDED.remote_solver_auth_token, upstream_base_url = EXCLUDED.upstream_base_url
    `);
    await db.execute(
      sql`UPDATE sync_api_settings SET instance_id = ${owner.instance_id} WHERE id = 1`,
    );
    await db.execute(sql`
      INSERT INTO sync_sweep_promises (id, registered_solver_id, source_base_url, airfoil_id, simulation_preset_revision_id, aoa_count, "expiresAt", request_payload, status)
      VALUES (${promiseId}::uuid, ${envelope.solverId}::uuid, ${baseUrl}, ${sourceJob.airfoil_id}::uuid, ${sourceJob.simulation_preset_revision_id}::uuid,
        ${envelope.scope.units.length}, clock_timestamp() - interval '1 second', '{"remoteSolver":true}'::jsonb, 'expired')
    `);
    for (const unit of envelope.scope.units)
      await db.execute(sql`INSERT INTO sync_sweep_promise_points (promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg, status)
        VALUES (${promiseId}::uuid, ${sourceJob.airfoil_id}::uuid, ${sourceJob.simulation_preset_revision_id}::uuid, ${unit.alpha + 0.125}, 'expired')`);
    await expect(
      mirrorProgressiveRemoteJob(db, { envelope, assignment }),
    ).rejects.toThrow("angle list");
    await db.execute(
      sql`UPDATE sync_sweep_promise_points SET aoa_deg = aoa_deg - 0.125 WHERE promise_id = ${promiseId}::uuid`,
    );
    await expect(
      mirrorProgressiveRemoteJob(db, {
        envelope,
        assignment: { ...assignment, solverId: randomUUID() },
      }),
    ).rejects.toThrow("stored assignment");
    const foreignPool = sealProgressiveRemoteExecution({
      solverId: envelope.solverId,
      promiseId,
      scope: envelope.scope,
      request: {
        ...envelope.request,
        expected_execution_pool: "unavailable-mirror-pool",
      },
    });
    await expect(
      mirrorProgressiveRemoteJob(db, {
        envelope: foreignPool,
        assignment: {
          ...assignment,
          contentSignature: foreignPool.contentSignature,
        },
      }),
    ).rejects.toThrow("engine pool");
    const mirrors = await Promise.all([
      mirrorProgressiveRemoteJob(db, { envelope, assignment }),
      mirrorProgressiveRemoteJob(db, { envelope, assignment }),
    ]);
    expect(mirrors.map((mirror) => mirror.replayed).sort()).toEqual([
      false,
      true,
    ]);
    for (const mirror of mirrors) {
      expect(mirror.jobId).toBe(executionId);
      expect(mirror.request).toEqual(envelope.request);
    }
    const [job] = await db.execute(
      sql`SELECT status, engine_job_id, request_payload, admission_cpu_slots FROM sim_jobs WHERE id = ${executionId}::uuid`,
    );
    expect(job.status).toBe("pending");
    expect(job.engine_job_id).toBeNull();
    expect(job.admission_cpu_slots).toBe(
      envelope.request.resources?.solver_processes ?? 1,
    );
    const payload = job.request_payload as Record<string, unknown>;
    expect(payload.engineRequest).toEqual(envelope.request);
    expect(payload.remoteProgressiveExecution).toEqual(envelope);
    expect(payload.progressive).toBeUndefined();
    const [lifecycle] =
      await db.execute(sql`SELECT ${solverDirectLifecycleSql("job")} AS direct
      FROM sim_jobs job WHERE job.id = ${executionId}::uuid`);
    expect(lifecycle.direct).toBe(false);
    await expect(
      submitPendingJobWithLifecycleGuard({
        db,
        engine: {} as EngineClient,
        jobId: executionId,
        admissionLane: "remote",
        request: envelope.request,
        connectionErrorPrefix: "isolated: ",
        submitErrorPrefix: "isolated: ",
      }),
    ).rejects.toThrow("dedicated submission lifecycle");
    await resetOrphans(db, { jobIds: [executionId] });
    const [afterRecovery] = await db.execute(
      sql`SELECT status, engine_state FROM sim_jobs WHERE id = ${executionId}::uuid`,
    );
    expect(afterRecovery).toEqual({ status: "pending", engine_state: null });
    const [evidence] = await db.execute(sql`SELECT
      (SELECT count(*)::integer FROM results WHERE sim_job_id = ${executionId}::uuid) AS points,
      (SELECT count(*)::integer FROM progressive_cfd_attempts WHERE sim_job_id = ${executionId}::uuid) AS attempts`);
    expect(evidence).toMatchObject({ points: 0, attempts: 0 });
    if (submissionMode === "never-authorized")
      await verifyProgressiveAssignmentIntake(db, envelope);
    if (submissionMode === "never-authorized") {
      const proof = {
        ...stopProof(executionId),
        ownership_basis: "never_started_cancellation_fence" as const,
        fence: "cancel_marker" as const,
      };
      const engine = {
        getExecutionStopProof: vi
          .fn(async () => proof)
          .mockRejectedValueOnce(
            new EngineError("isolated execution never registered", 404),
          ),
        cancelJob: vi.fn(async () => ({
          job_id: executionId,
          cancelled: true,
        })),
        getJob: vi.fn(async () => ({
          job_id: executionId,
          state: "cancelled" as const,
          completed_cases: 0,
          total_cases: 0,
        })),
        getResult: vi.fn(async () => {
          throw new Error(
            "Never-started execution cannot have solver evidence",
          );
        }),
      };
      await expect(
        observeProgressiveRemoteJob(db, engine, executionId),
      ).rejects.toThrow("durable owned submission intent");
      expect(
        await observeProgressiveRemoteJob(db, engine, executionId, {
          stop: true,
        }),
      ).toMatchObject({ stopped: true, sequence: 1, completedCases: 0 });
      expect(engine.cancelJob).toHaveBeenCalledTimes(1);
      expect(engine.getResult).not.toHaveBeenCalled();
      const [intents] = await db.execute(
        sql`SELECT count(*)::integer AS count FROM progressive_worker_submission_intents WHERE sim_job_id = ${executionId}::uuid`,
      );
      expect(intents.count).toBe(0);
    } else
      await verifyProgressiveWorkerSubmission(
        db,
        envelope,
        source.promiseId,
        stopProof,
        submissionMode,
      );
    const [promise] = await db.execute(
      sql`SELECT request_payload FROM sync_sweep_promises WHERE id = ${promiseId}::uuid`,
    );
    expect(promise.request_payload).toMatchObject({
      executionContract: "progressive-cfd-v1",
      progressiveExecutionId: executionId,
    });
    await db.execute(
      sql`UPDATE sim_jobs SET request_payload = jsonb_set(request_payload, '{engineRequest,aoa,angles}', '[99]'::jsonb) WHERE id = ${executionId}::uuid`,
    );
    await expect(
      mirrorProgressiveRemoteJob(db, { envelope, assignment }),
    ).rejects.toThrow("immutable assignment");
  } finally {
    await db.execute(
      sql`DELETE FROM progressive_worker_reports WHERE sim_job_id = ${executionId}::uuid`,
    );
    await db.execute(sql`DELETE FROM sim_jobs WHERE id = ${executionId}::uuid`);
    await db.execute(
      sql`DELETE FROM sync_sweep_promises WHERE id = ${promiseId}::uuid`,
    );
    if (settings)
      await db.execute(sql`UPDATE sync_api_settings SET instance_id = ${settings.instance_id}, remote_solver_registered_id = ${settings.remote_solver_registered_id}::uuid,
        remote_solver_auth_token = ${settings.remote_solver_auth_token}, upstream_base_url = ${settings.upstream_base_url} WHERE id = 1`);
    else await db.execute(sql`DELETE FROM sync_api_settings WHERE id = 1`);
  }
}
