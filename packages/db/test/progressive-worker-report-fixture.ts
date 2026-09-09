import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { DB } from "../src/client";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import type { ProgressiveRemoteReport } from "../src/progressive-remote-report";
import { storeProgressiveRemoteReport } from "../src/progressive-remote-reports";
import {
  acknowledgeProgressiveWorkerReport,
  enqueueProgressiveWorkerReport,
  readPendingProgressiveWorkerReport,
  settleProgressiveWorkerFinalReport,
} from "../src/progressive-worker-reports";
import {
  publishProgressiveWorkerReport,
  publishNextProgressiveWorkerReport,
} from "../../../apps/sweeper/src/progressive-remote-publication";

export async function verifyProgressiveWorkerReportDelivery(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
  reports: ProgressiveRemoteReport[],
) {
  const executionId = envelope.scope.executionId;
  const [settings] = await db.execute(sql`
    SELECT remote_solver_enabled, remote_solver_registered_id, remote_solver_auth_token, upstream_base_url,
      remote_solver_transfer_paused FROM sync_api_settings WHERE id = 1
  `);
  const [job] = await db.execute(
    sql`SELECT request_payload, to_jsonb(sim_jobs) AS original_state FROM sim_jobs WHERE id = ${executionId}::uuid`,
  );
  const [promise] = await db.execute(
    sql`SELECT source_base_url FROM sync_sweep_promises WHERE id = ${envelope.promiseId}::uuid`,
  );
  const baseUrl = "https://progressive-fixture.invalid/api/sync/v1";
  const capture = (report: ProgressiveRemoteReport) => {
    const { version: _version, sequence: _sequence, ...input } = report;
    return enqueueProgressiveWorkerReport(db, input);
  };
  try {
    await db.execute(sql`
      INSERT INTO sync_api_settings (id, remote_solver_enabled, remote_solver_registered_id, remote_solver_auth_token, upstream_base_url)
      VALUES (1, true, ${envelope.solverId}::uuid, 'isolated-fixture-credential', ${baseUrl})
      ON CONFLICT (id) DO UPDATE SET remote_solver_enabled = true,
        remote_solver_registered_id = EXCLUDED.remote_solver_registered_id,
        remote_solver_auth_token = EXCLUDED.remote_solver_auth_token, upstream_base_url = EXCLUDED.upstream_base_url
    `);
    await db.execute(
      sql`UPDATE sync_sweep_promises SET source_base_url = ${baseUrl} WHERE id = ${envelope.promiseId}::uuid`,
    );
    await db.execute(sql`
      UPDATE sim_jobs SET request_payload = ${JSON.stringify({
        ...(job.request_payload as Record<string, unknown>),
        remoteSolver: true,
        upstreamBaseUrl: baseUrl,
        syncPromiseId: envelope.promiseId,
        remoteProgressiveExecution: envelope,
      })}::jsonb WHERE id = ${executionId}::uuid
    `);
    await expect(
      capture({ ...reports[0], solverId: randomUUID() }),
    ).rejects.toThrow("owned local");
    const initial = await Promise.all([
      capture(reports[0]),
      capture(reports[0]),
    ]);
    expect(initial.map((receipt) => receipt.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(initial[0].contentSignature).toBe(initial[1].contentSignature);
    expect(await settleProgressiveWorkerFinalReport(db, executionId)).toBe(
      false,
    );
    const second = await capture(reports[1]);
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_enabled = false WHERE id = 1`,
    );
    const third = await capture(reports[2]);
    const expectedState =
      reports[2].status.state === "completed"
        ? "done"
        : reports[2].status.state;
    const checkProjection = async () => {
      const [projected] = await db.execute(
        sql`SELECT status, engine_state, total_cases, completed_cases, "ingestedAt" FROM sim_jobs WHERE id = ${executionId}::uuid`,
      );
      expect(projected).toMatchObject({
        status: expectedState,
        engine_state: reports[2].status.state,
        total_cases: reports[2].status.total_cases,
        completed_cases: reports[2].status.completed_cases,
      });
      expect(projected.ingestedAt).toBeNull();
    };
    await checkProjection();
    await db.execute(
      sql`UPDATE sim_jobs SET status = 'submitted', engine_state = 'pending' WHERE id = ${executionId}::uuid`,
    );
    expect(await settleProgressiveWorkerFinalReport(db, executionId)).toBe(
      true,
    );
    await checkProjection();
    await db.execute(
      sql`UPDATE sim_jobs SET engine_job_id = ${randomUUID()} WHERE id = ${executionId}::uuid`,
    );
    await expect(
      settleProgressiveWorkerFinalReport(db, executionId),
    ).rejects.toThrow("foreign engine identity");
    await db.execute(
      sql`UPDATE sim_jobs SET engine_job_id = ${(job.original_state as Record<string, unknown>).engine_job_id ?? null} WHERE id = ${executionId}::uuid`,
    );
    const corruptRead = {
      transaction: (callback: (connection: DB) => Promise<unknown>) =>
        db.transaction(async (transaction) =>
          callback({
            execute: async (statement: Parameters<DB["execute"]>[0]) => {
              const rows = await transaction.execute(statement);
              return rows.map((row) =>
                row.content_signature
                  ? { ...row, content_signature: "0".repeat(64) }
                  : row,
              );
            },
          } as unknown as DB),
        ),
    } as unknown as DB;
    await expect(
      settleProgressiveWorkerFinalReport(corruptRead, executionId),
    ).rejects.toThrow("content signature changed");
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_registered_id = ${randomUUID()}::uuid WHERE id = 1`,
    );
    expect(await settleProgressiveWorkerFinalReport(db, executionId)).toBe(
      false,
    );
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_registered_id = ${envelope.solverId}::uuid WHERE id = 1`,
    );
    await db.execute(
      sql`UPDATE sync_api_settings SET upstream_base_url = 'https://other-worker-authority.invalid/api/sync/v1' WHERE id = 1`,
    );
    expect(await settleProgressiveWorkerFinalReport(db, executionId)).toBe(
      false,
    );
    await db.execute(
      sql`UPDATE sync_api_settings SET upstream_base_url = ${baseUrl} WHERE id = 1`,
    );
    await checkProjection();
    expect([initial[0].sequence, second.sequence, third.sequence]).toEqual([
      1, 2, 3,
    ]);
    await expect(capture(reports[1])).rejects.toThrow("cannot resume");
    await expect(
      acknowledgeProgressiveWorkerReport(db, {
        ...second,
        solverId: envelope.solverId,
      }),
    ).rejects.toThrow("next durable");
    await expect(
      db.execute(
        sql`UPDATE progressive_worker_reports SET report = '{}'::jsonb WHERE sim_job_id = ${executionId}::uuid`,
      ),
    ).rejects.toThrow("immutable");
    const pending = () =>
      readPendingProgressiveWorkerReport(db, {
        executionId,
        solverId: envelope.solverId,
      });
    expect((await pending())?.sequence).toBe(1);
    expect(
      await readPendingProgressiveWorkerReport(db, {
        executionId,
        solverId: randomUUID(),
      }),
    ).toBeNull();
    const unreachable = vi.fn(async () => {
      throw new Error("isolated network failure");
    });
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused = true WHERE id = 1`,
    );
    expect(
      await publishProgressiveWorkerReport(db, executionId, unreachable),
    ).toEqual({ kind: "paused" });
    expect(unreachable).not.toHaveBeenCalled();
    expect(await publishNextProgressiveWorkerReport(db, unreachable)).toBe(
      false,
    );
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused = false WHERE id = 1`,
    );
    await expect(
      publishProgressiveWorkerReport(db, executionId, unreachable),
    ).rejects.toThrow("network failure");
    expect((await pending())?.sequence).toBe(1);
    const wrongReceipt = vi.fn(async () =>
      Response.json({
        received: true,
        receipt: { ...initial[0], contentSignature: "0".repeat(64) },
      }),
    );
    await expect(
      publishProgressiveWorkerReport(db, executionId, wrongReceipt),
    ).rejects.toThrow("exact durable report");
    expect((await pending())?.sequence).toBe(1);
    await db.execute(
      sql`UPDATE sync_api_settings SET upstream_base_url = 'https://changed-fixture.invalid/api/sync/v1' WHERE id = 1`,
    );
    unreachable.mockClear();
    await expect(
      publishProgressiveWorkerReport(db, executionId, unreachable),
    ).rejects.toThrow("assigned upstream");
    expect(unreachable).not.toHaveBeenCalled();
    await db.execute(
      sql`UPDATE sync_api_settings SET upstream_base_url = ${baseUrl} WHERE id = 1`,
    );
    const receive = async (
      url: string | URL | Request,
      options?: RequestInit,
    ) => {
      expect(url).toBe(
        `${baseUrl}/progressive-executions/${executionId}/reports`,
      );
      expect(options?.redirect).toBe("error");
      expect(options?.headers).toEqual({
        "content-type": "application/json",
        "x-xfoilfoam-solver-token": "isolated-fixture-credential",
      });
      const body = JSON.parse(String(options?.body));
      return storeProgressiveRemoteReport(db, {
        solverId: envelope.solverId,
        promiseId: body.promiseId,
        executionId,
        report: body.report,
      });
    };
    const lostAcknowledgement: typeof fetch = async (url, options) => {
      await receive(url, options);
      throw new Error("isolated lost hub response");
    };
    await expect(
      publishProgressiveWorkerReport(db, executionId, lostAcknowledgement),
    ).rejects.toThrow("lost hub response");
    expect((await pending())?.sequence).toBe(1);
    const successful: typeof fetch = async (url, options) =>
      Response.json({ received: true, receipt: await receive(url, options) });
    for (const sequence of [1, 2, 3]) {
      expect((await pending())?.sequence).toBe(sequence);
      expect(await publishNextProgressiveWorkerReport(db, successful)).toBe(
        true,
      );
    }
    expect(await pending()).toBeNull();
    expect(
      await publishProgressiveWorkerReport(db, executionId, unreachable),
    ).toEqual({ kind: "idle" });
    expect(unreachable).not.toHaveBeenCalled();
    expect(await capture(reports[2])).toMatchObject({
      sequence: 3,
      replayed: true,
    });
    await acknowledgeProgressiveWorkerReport(db, {
      ...initial[0],
      solverId: envelope.solverId,
    });
    await expect(
      db.execute(
        sql`UPDATE progressive_worker_reports SET acknowledged_at = NULL WHERE sim_job_id = ${executionId}::uuid`,
      ),
    ).rejects.toThrow("immutable");
  } finally {
    await db.execute(
      sql`DELETE FROM progressive_worker_reports WHERE sim_job_id = ${executionId}::uuid`,
    );
    await db.execute(
      sql`UPDATE sim_jobs SET request_payload = ${JSON.stringify(job.request_payload)}::jsonb,
        status = (saved->>'status')::sim_job_status, engine_state = saved->>'engine_state',
        engine_job_id = saved->>'engine_job_id', error = saved->>'error',
        total_cases = (saved->>'total_cases')::integer, completed_cases = (saved->>'completed_cases')::integer,
        "finishedAt" = (saved->>'finishedAt')::timestamptz, "updatedAt" = (saved->>'updatedAt')::timestamptz
      FROM (SELECT ${JSON.stringify(job.original_state)}::jsonb AS saved) original WHERE id = ${executionId}::uuid`,
    );
    await db.execute(
      sql`UPDATE sync_sweep_promises SET source_base_url = ${promise.source_base_url} WHERE id = ${envelope.promiseId}::uuid`,
    );
    if (settings)
      await db.execute(sql`UPDATE sync_api_settings SET remote_solver_enabled = ${settings.remote_solver_enabled},
        remote_solver_registered_id = ${settings.remote_solver_registered_id}::uuid,
        remote_solver_auth_token = ${settings.remote_solver_auth_token}, upstream_base_url = ${settings.upstream_base_url},
        remote_solver_transfer_paused = ${settings.remote_solver_transfer_paused} WHERE id = 1`);
    else await db.execute(sql`DELETE FROM sync_api_settings WHERE id = 1`);
  }
}
