import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { DB } from "../src/client";
import { claimProgressiveCfdBatch } from "../src/progressive-cfd";
import { composeProgressiveCfdJob } from "../../../apps/sweeper/src/progressive-cfd-jobs";
import { admitProgressiveCfdBatch } from "../../../apps/sweeper/src/progressive-admission";
import { prepareProgressiveRemoteDispatch } from "../../../apps/sweeper/src/progressive-remote-admission";
import {
  deferProgressiveClaim,
  ProgressiveEvidenceCellOwned,
} from "../../../apps/sweeper/src/progressive-claim-deferral";
import type { EngineClient } from "../../engine-client/src";

export async function verifyProgressiveClaimDeferral(
  db: DB,
  scope: { campaignId: string; generationId: string },
  mode: "local" | "remote",
) {
  const leases = await claimProgressiveCfdBatch(db, {
    owner: "isolated-prior-cell-owner",
    leaseSeconds: 120,
    solverBudgetVersion: 2,
  });
  expect(leases.length).toBeGreaterThan(0);
  const composed = await composeProgressiveCfdJob(db, leases, {
    cpuSlots: 1,
    meshRecoveryVersion: 1,
    solverBudgetVersion: 2,
  });
  const tokenList = sql.join(
    leases.map((lease) => sql`${lease.token}::uuid`),
    sql`, `,
  );
  const unitList = sql.join(
    leases.map((lease) => sql`${lease.id}::uuid`),
    sql`, `,
  );
  await db.execute(
    sql`UPDATE progressive_cfd_attempts SET outcome='cancelled',finished_at=clock_timestamp() WHERE token IN (${tokenList})`,
  );
  await db.execute(
    sql`UPDATE progressive_cfd_units SET state='pending',lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE id IN (${unitList})`,
  );
  const before = await db.execute(
    sql`SELECT id,attempts,active_seconds FROM progressive_cfd_units WHERE id IN (${unitList}) ORDER BY id`,
  );
  const cells = await db.execute(
    sql`SELECT id,sim_job_id,status,source FROM results WHERE sim_job_id=${composed.jobId}::uuid ORDER BY id`,
  );
  const [jobCount] = await db.execute(
    sql`SELECT count(*)::int AS count FROM sim_jobs WHERE campaign_id=${scope.campaignId}::uuid`,
  );
  const solverId = randomUUID();
  const [settings] = await db.execute(
    sql`SELECT enabled,remote_solver_enabled FROM sync_api_settings WHERE id=1`,
  );
  const [permission] = await db.execute(
    sql`SELECT can_fetch FROM sync_api_permissions WHERE data_type='sweeps'`,
  );
  const submit = vi.fn();
  try {
    if (mode === "remote") {
      const capability = {
        version: 1,
        solverBudgetVersion: 2,
        meshRecoveryVersion: 1,
        uransRecoveryVersion: 14,
        engine: composed.request.expected_engine,
        executionPools: [composed.request.expected_execution_pool],
      };
      await db.execute(
        sql`UPDATE sync_api_settings SET enabled=true,remote_solver_enabled=false WHERE id=1`,
      );
      await db.execute(
        sql`UPDATE sync_api_permissions SET can_fetch=true WHERE data_type='sweeps'`,
      );
      await db.execute(sql`INSERT INTO registered_remote_solvers(id,instance_id,instance_name,cpu_capacity,cpu_budget,max_active_polar_promises,
        auth_token_hash,credential_version,last_heartbeat_at,metadata)
        VALUES(${solverId}::uuid,${randomUUID()},'isolated contention worker',2,2,4,${"a".repeat(64)},1,clock_timestamp(),
          ${JSON.stringify({ progressiveExecution: capability, progressiveExecutionObservedAt: new Date().toISOString() })}::jsonb)`);
      expect(
        await prepareProgressiveRemoteDispatch(db, solverId),
      ).toMatchObject({ kind: "waiting", deferredUnits: leases.length });
    } else {
      expect(
        await admitProgressiveCfdBatch(
          db,
          { submitPolar: submit } as unknown as EngineClient,
          {
            meshRecoveryVersion: 1,
            uransRecoveryVersion: 14,
            solverBudgetVersion: 2,
          },
        ),
      ).toEqual({ kind: "deferred", units: leases.length });
    }
    expect(submit).not.toHaveBeenCalled();
    expect(
      await db.execute(
        sql`SELECT id,sim_job_id,status,source FROM results WHERE sim_job_id=${composed.jobId}::uuid ORDER BY id`,
      ),
    ).toEqual(cells);
    expect(
      await db.execute(
        sql`SELECT id,attempts,active_seconds FROM progressive_cfd_units WHERE id IN (${unitList}) ORDER BY id`,
      ),
    ).toEqual(before);
    const [after] = await db.execute(
      sql`SELECT count(*)::int AS count FROM sim_jobs WHERE campaign_id=${scope.campaignId}::uuid`,
    );
    expect(after.count).toBe(jobCount.count);
    const deferred = await db.execute(
      sql`SELECT state,lease_token,retry_after>clock_timestamp() AS deferred FROM progressive_cfd_units WHERE id IN (${unitList})`,
    );
    expect(
      deferred.every(
        (row) =>
          row.state === "pending" &&
          row.lease_token === null &&
          row.deferred === true,
      ),
    ).toBe(true);
    const other = await claimProgressiveCfdBatch(db, {
      owner: "isolated-other-target",
      leaseSeconds: 120,
      solverBudgetVersion: 2,
    });
    expect(other.length).toBeGreaterThan(0);
    expect(other[0].targetId).not.toBe(leases[0].targetId);
    expect(
      await deferProgressiveClaim(db, new ProgressiveEvidenceCellOwned(other)),
    ).toBe(0);
    const otherJob = await composeProgressiveCfdJob(db, other, {
      cpuSlots: 1,
      meshRecoveryVersion: 1,
      solverBudgetVersion: 2,
    });
    expect(otherJob.jobId).not.toBe(composed.jobId);
    const missingTokens = leases.map((lease) => ({
      ...lease,
      token: randomUUID(),
    }));
    const rollback = new Error("Rollback isolated inactive claim deferral");
    for (const state of ["paused", "cancelled"] as const) {
      await expect(
        db.transaction(async (transaction) => {
          await transaction.execute(
            sql`UPDATE sim_campaigns SET status=${state} WHERE id=${scope.campaignId}::uuid`,
          );
          expect(
            await deferProgressiveClaim(
              transaction as unknown as DB,
              new ProgressiveEvidenceCellOwned(missingTokens),
            ),
          ).toBe(0);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
    await expect(
      db.transaction(async (transaction) => {
        await transaction.execute(
          sql`UPDATE progressive_generations SET status='cancelled' WHERE id=${scope.generationId}::uuid`,
        );
        expect(
          await deferProgressiveClaim(
            transaction as unknown as DB,
            new ProgressiveEvidenceCellOwned(missingTokens),
          ),
        ).toBe(0);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    await db.execute(
      sql`UPDATE progressive_cfd_units SET retry_after=clock_timestamp()-interval '1 second' WHERE id IN (${unitList})`,
    );
    const retried = await claimProgressiveCfdBatch(db, {
      owner: "isolated-expired-deferral",
      leaseSeconds: 120,
      solverBudgetVersion: 2,
    });
    expect(retried.map((lease) => lease.id).sort()).toEqual(
      leases.map((lease) => lease.id).sort(),
    );
    const retry = await db.execute(
      sql`SELECT retry_after,error,attempts FROM progressive_cfd_units WHERE id IN (${unitList}) ORDER BY id`,
    );
    expect(
      retry.every(
        (row, index) =>
          row.retry_after === null &&
          row.error === null &&
          row.attempts === Number(before[index].attempts) + 1,
      ),
    ).toBe(true);
    expect(
      await deferProgressiveClaim(
        db,
        new ProgressiveEvidenceCellOwned(retried),
      ),
    ).toBe(0);
  } finally {
    if (mode === "remote") {
      await db.execute(
        sql`DELETE FROM progressive_remote_dispatches WHERE solver_id=${solverId}::uuid`,
      );
      await db.execute(
        sql`DELETE FROM sync_sweep_promises WHERE registered_solver_id=${solverId}::uuid`,
      );
      await db.execute(
        sql`DELETE FROM registered_remote_solvers WHERE id=${solverId}::uuid`,
      );
      await db.execute(
        sql`UPDATE sync_api_settings SET enabled=${settings.enabled},remote_solver_enabled=${settings.remote_solver_enabled} WHERE id=1`,
      );
      if (permission)
        await db.execute(
          sql`UPDATE sync_api_permissions SET can_fetch=${permission.can_fetch} WHERE data_type='sweeps'`,
        );
    }
  }
}
