import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type {
  EngineClient,
  EngineExecutionStopProof,
  PolarRequest,
} from "../../engine-client/src";
import { analysisContentHash } from "../src/analysis-target";
import type { DB } from "../src/client";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import { verifyProgressiveWorkerObservation } from "./progressive-worker-observation-fixture";
import { solverQueuePressure } from "../../../apps/sweeper/src/submit-lifecycle";
import { submitProgressiveRemoteJob } from "../../../apps/sweeper/src/progressive-remote-submission";
import { admitRemoteSolverTick } from "../../../apps/sweeper/src/remote-solver";

export async function verifyProgressiveWorkerSubmission(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
  sourcePromiseId: string,
  stopProof: (executionId: string) => EngineExecutionStopProof,
  mode: "timeout" | "success",
) {
  const executionId = envelope.scope.executionId;
  const [settings] = await db.execute(
    sql`SELECT remote_solver_enabled, remote_solver_cpu_budget FROM sync_api_settings WHERE id = 1`,
  );
  const sourcePoints = await db.execute(
    sql`SELECT id, status FROM sync_sweep_promise_points WHERE promise_id = ${sourcePromiseId}::uuid`,
  );
  const engineSubmit = vi.fn(async (request: PolarRequest) => {
    if (mode === "timeout")
      throw new Error("isolated ambiguous engine timeout");
    return {
      job_id: executionId,
      state: "pending" as const,
      total_cases: envelope.scope.units.length,
      completed_cases: 0,
      engine: {
        ...request.expected_engine!,
        build_id: "isolated-progressive-worker-submit",
        application_source_sha256: analysisContentHash({
          fixture: executionId,
        }),
      },
    };
  });
  const engine = { submitPolar: engineSubmit } as unknown as EngineClient;
  const authorization: typeof fetch = async (url, options) => {
    expect(String(url)).toContain(
      `/progressive-executions/${executionId}/start`,
    );
    expect(JSON.parse(String(options?.body))).toEqual({
      contentSignature: envelope.contentSignature,
    });
    const now = Date.now();
    return Response.json({
      checkedAt: new Date(now).toISOString(),
      decision: {
        kind: "authorized",
        executionId,
        contentSignature: envelope.contentSignature,
        authorizedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 120000).toISOString(),
      },
    });
  };
  try {
    await db.execute(
      sql`UPDATE sync_sweep_promise_points SET status = 'expired' WHERE promise_id = ${sourcePromiseId}::uuid AND status = 'active'`,
    );
    await db.execute(
      sql`UPDATE sync_sweep_promise_points SET status = 'active' WHERE promise_id = ${envelope.promiseId}::uuid`,
    );
    await db.execute(
      sql`UPDATE sync_sweep_promises SET status = 'active', "expiresAt" = clock_timestamp() + interval '1 hour' WHERE id = ${envelope.promiseId}::uuid`,
    );
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_enabled = true, remote_solver_cpu_budget = 0 WHERE id = 1`,
    );
    expect(
      await submitProgressiveRemoteJob(db, engine, executionId, authorization),
    ).toMatchObject({ kind: "waiting" });
    expect(engineSubmit).not.toHaveBeenCalled();
    const [unreserved] = await db.execute(
      sql`SELECT count(*)::integer AS count FROM progressive_worker_submission_intents WHERE sim_job_id = ${executionId}::uuid`,
    );
    expect(unreserved.count).toBe(0);
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_cpu_budget = 1 WHERE id = 1`,
    );
    const expiredAuthorization: typeof fetch = async (url, options) => {
      const response = await authorization(url, options);
      const body = await response.json();
      body.decision.authorizedAt = new Date(
        Date.parse(body.checkedAt) - 120001,
      ).toISOString();
      body.decision.expiresAt = new Date(
        Date.parse(body.decision.authorizedAt) + 120000,
      ).toISOString();
      return Response.json(body);
    };
    expect(
      await submitProgressiveRemoteJob(
        db,
        engine,
        executionId,
        expiredAuthorization,
      ),
    ).toMatchObject({ kind: "stop_required" });
    for (const checkedAt of [
      undefined,
      "not-a-clock",
      new Date(0).toISOString(),
    ]) {
      const invalidClock: typeof fetch = async (url, options) => {
        const response = await authorization(url, options);
        return Response.json({ ...(await response.json()), checkedAt });
      };
      await expect(
        submitProgressiveRemoteJob(db, engine, executionId, invalidClock),
      ).rejects.toThrow("current authorization clock");
    }
    expect(engineSubmit).not.toHaveBeenCalled();
    const [stillUnreserved] = await db.execute(
      sql`SELECT count(*)::integer AS count FROM progressive_worker_submission_intents WHERE sim_job_id = ${executionId}::uuid`,
    );
    expect(stillUnreserved.count).toBe(0);
    if (mode === "success") {
      const previousToken = process.env.ENGINE_CONTROL_PLANE_TOKEN;
      const upstream = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(authorization);
      process.env.ENGINE_CONTROL_PLANE_TOKEN =
        "isolated-progressive-control-plane-token";
      try {
        const admissions = await Promise.all([
          admitRemoteSolverTick(db, engine, {
            kind: "allow",
            meshRecoveryVersion:
              envelope.request.expected_mesh_recovery_version!,
          }),
          admitRemoteSolverTick(db, engine, {
            kind: "allow",
            meshRecoveryVersion:
              envelope.request.expected_mesh_recovery_version!,
          }),
        ]);
        expect(admissions).toContain(true);
      } finally {
        upstream.mockRestore();
        if (previousToken === undefined)
          delete process.env.ENGINE_CONTROL_PLANE_TOKEN;
        else process.env.ENGINE_CONTROL_PLANE_TOKEN = previousToken;
      }
    } else {
      const submissions = await Promise.all([
        submitProgressiveRemoteJob(db, engine, executionId, authorization),
        submitProgressiveRemoteJob(db, engine, executionId, authorization),
      ]);
      expect(submissions.map((outcome) => outcome.kind)).toEqual([
        "observe",
        "observe",
      ]);
    }
    expect(engineSubmit).toHaveBeenCalledTimes(1);
    expect(engineSubmit.mock.calls[0]?.[0]).toEqual(envelope.request);
    expect(await solverQueuePressure(db, { jobIds: [executionId] })).toBe(1);
    await db.execute(
      sql`UPDATE sim_jobs SET status = 'cancelled', engine_state = 'cancelled' WHERE id = ${executionId}::uuid`,
    );
    await db.execute(
      sql`UPDATE sync_sweep_promises SET status = 'expired', "expiresAt" = clock_timestamp() - interval '1 second' WHERE id = ${envelope.promiseId}::uuid`,
    );
    expect(await solverQueuePressure(db, { jobIds: [executionId] })).toBe(1);
    await expect(
      db.execute(
        sql`UPDATE progressive_worker_submission_intents SET token = ${randomUUID()}::uuid WHERE sim_job_id = ${executionId}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`DELETE FROM sim_jobs WHERE id = ${executionId}::uuid`),
    ).rejects.toThrow();
    expect(
      await submitProgressiveRemoteJob(db, engine, executionId, authorization),
    ).toMatchObject({ kind: "observe" });
    expect(engineSubmit).toHaveBeenCalledTimes(1);
    await verifyProgressiveWorkerObservation(db, envelope, stopProof, mode);
  } finally {
    await db.execute(
      sql`DELETE FROM progressive_worker_reports WHERE sim_job_id = ${executionId}::uuid`,
    );
    await db.execute(
      sql`DELETE FROM progressive_worker_submission_intents WHERE sim_job_id = ${executionId}::uuid`,
    );
    await db.execute(
      sql`UPDATE sync_sweep_promise_points SET status = 'expired' WHERE promise_id = ${envelope.promiseId}::uuid`,
    );
    for (const point of sourcePoints)
      await db.execute(
        sql`UPDATE sync_sweep_promise_points SET status = ${point.status} WHERE id = ${point.id}::uuid`,
      );
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_enabled = ${settings.remote_solver_enabled}, remote_solver_cpu_budget = ${settings.remote_solver_cpu_budget} WHERE id = 1`,
    );
  }
}
