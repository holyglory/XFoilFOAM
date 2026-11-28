import { createHash, randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { DB } from "../src/client";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import { listProgressiveRemoteAssignments } from "../src/progressive-remote-delivery";
import { storeProgressiveRemoteReport } from "../src/progressive-remote-reports";
import { EngineError, type EngineClient } from "../../engine-client/src";
import { receiveProgressiveCampaignAssignments } from "../../../apps/sweeper/src/remote-solver";
import { publishProgressiveWorkerReport } from "../../../apps/sweeper/src/progressive-remote-publication";
import { applyProgressiveRemoteProgress } from "../../../apps/sweeper/src/progressive-remote-progress";
import { withRegisteredRoundDatabases } from "./registered-replacement-db-fixture";

// Extend the existing real dispatch journey with independent hub/worker stores
// and the registered HTTP API. The engine boundary is controlled; the real
// cancellation/namespace implementation is covered by the governed Python suite.
export async function verifyExpiredProgressiveIntake(
  source: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
) {
  await withRegisteredRoundDatabases(source, async (hub, worker, base) => {
    const { solverId, promiseId } = envelope;
    const executionId = envelope.scope.executionId;
    const credential = randomUUID() + randomUUID();
    const instance = randomUUID();
    const digest = createHash("sha256").update(credential).digest("hex");
    await hub.sql`UPDATE registered_remote_solvers SET instance_id=${instance},auth_token_hash=${digest},revoked_at=NULL WHERE id=${solverId}`;
    await hub.sql`UPDATE sync_sweep_promises SET source_instance_id=${instance} WHERE id=${promiseId}`;
    await hub.sql`UPDATE sync_api_settings SET enabled=true WHERE id=1`;
    await hub.sql`INSERT INTO sync_api_permissions(data_type,can_fetch,can_push) VALUES('sweeps',true,false),('polars',false,true)
      ON CONFLICT(data_type) DO UPDATE SET can_fetch=excluded.can_fetch,can_push=excluded.can_push`;
    await worker.sql`UPDATE sync_api_settings SET instance_id=${instance},enabled=true,remote_solver_enabled=true,remote_solver_transfer_paused=false,
      upstream_base_url=${base},remote_solver_registered_id=${solverId},remote_solver_auth_token=${credential} WHERE id=1`;
    const recovery = (db: DB) =>
      listProgressiveRemoteAssignments(db, { solverId, expiredPending: true });
    const headers = { "x-xfoilfoam-solver-token": credential };
    const feed = async (suffix = "?expiredPending=true", auth = headers) => {
      const response = await fetch(base + "/progressive-executions" + suffix, {
        headers: auth,
      });
      return { status: response.status, body: await response.json() };
    };
    expect((await feed()).body.items).toHaveLength(0);
    expect((await feed("?limit=50")).body.items).toHaveLength(1);
    expect((await feed("?expiredPending=true&limit=5")).status).toBe(400);
    expect((await feed("?expiredPending=false")).status).toBe(400);
    expect(
      (
        await feed("?expiredPending=true", {
          "x-xfoilfoam-solver-token": "wrong",
        })
      ).status,
    ).toBe(401);
    await hub.sql`UPDATE sync_sweep_promises SET status='expired',"expiresAt"=clock_timestamp()-interval '1 hour' WHERE id=${promiseId}`;
    expect((await feed()).body.items).toHaveLength(0); // still-owned fresh case leases
    await hub.sql`UPDATE progressive_cfd_units u SET lease_until=clock_timestamp()-interval '1 minute',active_seconds=17.25,attempts=2
      FROM progressive_cfd_attempts a WHERE a.unit_id=u.id AND a.sim_job_id=${executionId}`;
    await hub.sql`INSERT INTO progressive_cfd_attempts(token,unit_id,owner,lease_until,outcome,active_seconds,started_at,finished_at)
      SELECT gen_random_uuid(),unit_id,'retained-prior-work',clock_timestamp()-interval '2 hour','failed',17.25,
        clock_timestamp()-interval '3 hour',clock_timestamp()-interval '2 hour'
      FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}`;
    const conserve = async () => ({
      units:
        await hub.sql`SELECT u.id,u.attempts,u.active_seconds,u.active_budget_seconds,u.recipe
        FROM progressive_cfd_units u JOIN progressive_cfd_attempts a ON a.unit_id=u.id
        WHERE a.sim_job_id=${executionId} ORDER BY u.id`,
      prior:
        await hub.sql`SELECT * FROM progressive_cfd_attempts WHERE owner='retained-prior-work' ORDER BY token`,
      requests:
        await hub.sql`SELECT request_payload FROM sim_jobs WHERE id=${executionId}`,
      results: await hub.sql`SELECT * FROM result_attempts ORDER BY id`,
    });
    const before = await conserve();
    expect(
      (await feed()).body.items.map(
        (x: { executionId: string }) => x.executionId,
      ),
    ).toEqual([executionId]);
    expect((await feed("?limit=50")).body.items).toHaveLength(0);
    expect(
      (
        await listProgressiveRemoteAssignments(hub.db, {
          solverId: randomUUID(),
          expiredPending: true,
        })
      ).items,
    ).toHaveLength(0);
    const rollback = new Error("recovery selector guard rollback");
    const excluded = async (mutate: (db: DB) => Promise<unknown>) => {
      await expect(
        hub.db.transaction(async (tx) => {
          const db = tx as unknown as DB;
          await mutate(db);
          expect((await recovery(db)).items).toHaveLength(0);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    };
    await excluded((db) =>
      db.execute(
        sql`UPDATE sim_jobs SET status='running' WHERE id=${executionId}::uuid`,
      ),
    );
    await excluded((db) =>
      db.execute(
        sql`UPDATE sim_jobs SET engine_job_id=id::text WHERE id=${executionId}::uuid`,
      ),
    );
    await excluded((db) =>
      db.execute(
        sql`UPDATE progressive_cfd_attempts SET active_seconds=1 WHERE sim_job_id=${executionId}::uuid`,
      ),
    );
    await excluded((db) =>
      db.execute(
        sql`UPDATE progressive_cfd_units SET lease_token=gen_random_uuid() WHERE id=${envelope.scope.units[0]!.unitId}::uuid`,
      ),
    );
    await excluded((db) =>
      db.execute(
        sql`UPDATE registered_remote_solvers SET revoked_at=clock_timestamp() WHERE id=${solverId}::uuid`,
      ),
    );
    await excluded((db) =>
      db.execute(
        sql`UPDATE sync_sweep_promises SET status='cancelled' WHERE id=${promiseId}::uuid`,
      ),
    );
    await excluded((db) =>
      db.execute(sql`INSERT INTO progressive_cfd_runtime_progress(attempt_token,engine_job_id,observed_at,active_seconds,limit_seconds,solver_running,observation,observation_signature)
      VALUES(${envelope.scope.tokens[0]}::uuid,${executionId},clock_timestamp(),0,900,false,'{}'::jsonb,${"d".repeat(64)})`),
    );
    await excluded((db) =>
      storeProgressiveRemoteReport(db, {
        solverId,
        promiseId,
        executionId,
        report: {
          version: 1,
          solverId,
          promiseId,
          executionId,
          assignmentSignature: envelope.contentSignature,
          sequence: 1,
          status: {
            job_id: executionId,
            state: "pending",
            total_cases: envelope.scope.units.length,
            completed_cases: 0,
          },
          result: null,
          stopProof: null,
        },
      }),
    );

    const renewed = await receiveProgressiveCampaignAssignments(
      worker.db,
      {} as EngineClient,
      async (url, init) => {
        if (String(url).endsWith("/" + executionId))
          await hub.sql`UPDATE sync_sweep_promises SET status='active',"expiresAt"=clock_timestamp()+interval '1 hour' WHERE id=${promiseId}`;
        return fetch(url, init);
      },
      { expiredPending: true },
    );
    expect(renewed.errors[0]?.error).toContain("no longer expired");
    expect(
      await worker.sql`SELECT id FROM sim_jobs WHERE id=${executionId}`,
    ).toHaveLength(0);
    await hub.sql`UPDATE sync_sweep_promises SET status='expired',"expiresAt"=clock_timestamp()-interval '1 hour' WHERE id=${promiseId}`;

    const proof = {
      version: 1,
      job_id: executionId,
      execution_stopped: true,
      producer_stopped: true,
      namespace_verified: true,
      remaining: [],
      observed_at: new Date().toISOString(),
      error: null,
      fence: "cancel_marker" as const,
      ownership_basis: "never_started_cancellation_fence" as const,
    };
    let release!: () => void;
    let entered!: () => void;
    const reachedEngine = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const heldInspection = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fenced = false;
    const engine = {
      getExecutionStopProof: vi.fn(async () => {
        entered();
        await heldInspection;
        if (!fenced) throw new EngineError("not registered", 404);
        return proof;
      }),
      cancelJob: vi
        .fn(
          async (
            id: string,
            route: NonNullable<Parameters<EngineClient["cancelJob"]>[1]>,
          ) => {
            expect(id).toBe(executionId);
            expect(route.unregisteredExecution).toEqual({
              expected_engine: envelope.request.expected_engine,
              expected_execution_pool: envelope.request.expected_execution_pool,
            });
            fenced = true;
            return { job_id: id, cancelled: true };
          },
        )
        .mockRejectedValueOnce(
          new EngineError("worker namespace inspection unavailable", 503),
        ),
      getJob: vi.fn(async () => ({
        job_id: executionId,
        state: "cancelled",
        total_cases: 0,
        completed_cases: 0,
      })),
      getResult: vi.fn(),
      submitPolar: vi.fn(),
    } as unknown as EngineClient;
    const first = receiveProgressiveCampaignAssignments(
      worker.db,
      engine,
      fetch,
      { expiredPending: true },
    );
    await reachedEngine;
    try {
      expect(
        await receiveProgressiveCampaignAssignments(worker.db, engine),
      ).toMatchObject({ seen: 0, errors: [] });
      expect(
        await worker.sql`SELECT * FROM progressive_worker_assignment_cursors WHERE settings_id=1`,
      ).toHaveLength(1);
    } finally {
      release();
    }
    expect((await first).errors).toHaveLength(1);
    expect(
      await worker.sql`SELECT * FROM progressive_worker_reports WHERE sim_job_id=${executionId}`,
    ).toHaveLength(0);
    expect(
      await hub.sql`SELECT * FROM progressive_cfd_execution_stops WHERE sim_job_id=${executionId}`,
    ).toHaveLength(0);
    expect((await recovery(hub.db)).items).toHaveLength(1);
    await worker.sql`INSERT INTO progressive_worker_submission_intents(sim_job_id,token,assignment_signature,"authorization")
      VALUES(${executionId},gen_random_uuid(),${envelope.contentSignature},
        jsonb_build_object('kind','authorized','executionId',${executionId}::text,'contentSignature',${envelope.contentSignature}::text))`;
    const inspections = vi.mocked(engine.getExecutionStopProof).mock.calls
      .length;
    const started = await receiveProgressiveCampaignAssignments(
      worker.db,
      engine,
      fetch,
      { expiredPending: true },
    );
    expect(started.errors[0]?.error).toContain("ordinary observation path");
    expect(vi.mocked(engine.getExecutionStopProof).mock.calls).toHaveLength(
      inspections,
    );
    await worker.sql`DELETE FROM progressive_worker_submission_intents WHERE sim_job_id=${executionId}`;
    // A persisted mirror survives the refusal and is retried. Discovery alone
    // cannot release the hub's still-owned units or create a solver attempt.
    expect(
      await receiveProgressiveCampaignAssignments(worker.db, engine, fetch, {
        expiredPending: true,
      }),
    ).toMatchObject({ mirrored: 1, errors: [] });
    const [pending] =
      await worker.sql`SELECT report,acknowledged_at FROM progressive_worker_reports WHERE sim_job_id=${executionId}`;
    expect(pending.report).toMatchObject({
      result: null,
      stopProof: proof,
      status: { total_cases: 0, completed_cases: 0 },
    });
    expect(pending.acknowledged_at).toBeNull();
    expect(
      await hub.sql`SELECT * FROM progressive_cfd_execution_stops WHERE sim_job_id=${executionId}`,
    ).toHaveLength(0);
    expect(await conserve()).toEqual(before);
    const [mirror] =
      await worker.sql`SELECT request_payload FROM sim_jobs WHERE id=${executionId}`;
    expect(mirror.request_payload.engineRequest).toEqual(envelope.request);
    expect(
      await worker.sql`SELECT * FROM progressive_worker_submission_intents WHERE sim_job_id=${executionId}`,
    ).toHaveLength(0);
    expect(engine.submitPolar).not.toHaveBeenCalled();
    expect(engine.getResult).not.toHaveBeenCalled();
    await expect(
      publishProgressiveWorkerReport(
        worker.db,
        executionId,
        async (url, options) =>
          fetch(url, {
            ...options,
            headers: {
              ...options?.headers,
              "x-xfoilfoam-solver-token": "wrong",
            },
          }),
      ),
    ).rejects.toThrow();
    expect(
      await hub.sql`SELECT * FROM progressive_remote_reports WHERE sim_job_id=${executionId}`,
    ).toHaveLength(0);
    expect(
      await publishProgressiveWorkerReport(worker.db, executionId),
    ).toMatchObject({ kind: "published", sequence: 1 });
    expect(
      await hub.sql`SELECT * FROM progressive_cfd_execution_stops WHERE sim_job_id=${executionId}`,
    ).toHaveLength(0);
    expect(
      await applyProgressiveRemoteProgress(hub.db, executionId),
    ).toMatchObject({
      kind: "applied",
      stopped: true,
      settled: { retry: envelope.scope.units.length },
    });
    expect((await recovery(hub.db)).items).toHaveLength(0);
    expect(await conserve()).toEqual(before);
    const units =
      await hub.sql`SELECT u.state,u.lease_token FROM progressive_cfd_units u JOIN progressive_cfd_attempts a ON a.unit_id=u.id WHERE a.sim_job_id=${executionId}`;
    expect(
      units.every((u) => u.state === "pending" && u.lease_token === null),
    ).toBe(true);
    const attempts =
      await hub.sql`SELECT outcome,active_seconds FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}`;
    expect(
      attempts.every(
        (a) => a.outcome === "cancelled" && a.active_seconds === 0,
      ),
    ).toBe(true);
    expect(
      await publishProgressiveWorkerReport(worker.db, executionId),
    ).toMatchObject({ kind: "idle" });
    await applyProgressiveRemoteProgress(hub.db, executionId);
    expect(await conserve()).toEqual(before);
  });
}
