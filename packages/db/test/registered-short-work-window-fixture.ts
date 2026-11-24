import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import { createClient, type DB } from "../src/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { SimulationSetupSnapshot } from "../src/simulation-setup";
import { analysisContentHash } from "../src/analysis-target";
import { claimProgressiveCfdBatch } from "../src/progressive-cfd";
import { materializeProgressiveCfdExecution } from "../src/progressive-cfd-execution";
import { composeProgressiveCfdJob } from "../../../apps/sweeper/src/progressive-cfd-jobs";
import { prepareProgressiveRemoteDispatch } from "../../../apps/sweeper/src/progressive-remote-admission";
import {
  admissionCpuSlotsForRequest,
  engineIdentityForSetup,
} from "../../../apps/sweeper/src/build-request";
import {
  enableShortWork,
  endShortWork,
  previewShortWork,
  shortWorkStatus,
} from "../../../apps/sweeper/src/short-work-window";

const exec = promisify(execFile);

async function rollback<T>(db: DB, run: (tx: DB) => Promise<T>): Promise<T> {
  const sentinel = new Error("restore isolated admission fixture");
  let result: T;
  try {
    await db.transaction(async (connection) => {
      result = await run(connection as unknown as DB);
      throw sentinel;
    });
  } catch (err) {
    if (err !== sentinel) throw err;
  }
  return result!;
}

export async function verifyRegisteredShortWork(
  db: DB,
  generationId: string,
  poolId: string,
  databaseUrl: string,
) {
  const solverId = randomUUID();
  const [setting] = await db.execute(
    sql`SELECT enabled FROM sync_api_settings WHERE id=1`,
  );
  const [permission] = await db.execute(
    sql`SELECT can_fetch FROM sync_api_permissions WHERE data_type='sweeps'`,
  );
  const [routing] = await db.execute(
    sql`SELECT routing_key FROM solver_execution_pools WHERE id=${poolId}::uuid`,
  );
  const pool = String(routing.routing_key);
  const [revision] =
    await db.execute(sql`SELECT r.snapshot FROM progressive_generation_targets s JOIN simulation_preset_revisions r ON r.id=s.revision_id
    WHERE s.generation_id=${generationId}::uuid LIMIT 1`);
  const capability = {
    version: 1,
    meshRecoveryVersion: 1,
    solverBudgetVersion: 2,
    uransRecoveryVersion: 14,
    localTimeStepVersion: 1,
    executionPools: [pool],
    engine: engineIdentityForSetup(
      revision.snapshot as SimulationSetupSnapshot,
    ),
  };
  const oldRole = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
  process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
  const cli = async (args: string[]) => {
    const path = fileURLToPath(
      new URL(
        "../../../apps/sweeper/src/short-work-window-cli.ts",
        import.meta.url,
      ),
    );
    const cliRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const { stdout } = await exec(
      process.execPath,
      ["--import", "tsx", path, ...args],
      {
        cwd: cliRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          AIRFOILFOAM_DEPLOYMENT_ROLE: "hub",
        },
        timeout: 20_000,
      },
    );
    return JSON.parse(stdout);
  };
  const otherClient = createClient({ url: databaseUrl, max: 1 });
  const claim = {
    owner: "registered-short-work-fixture",
    leaseSeconds: 900,
    remoteSolverId: solverId,
    solverBudgetVersion: 2,
    localTimeStepVersion: 1,
    allowPhysicalTime: true,
  };
  try {
    await db.execute(sql`UPDATE sync_api_settings SET enabled=true WHERE id=1`);
    await db.execute(
      sql`INSERT INTO sync_api_permissions (data_type,can_fetch) VALUES ('sweeps',true) ON CONFLICT(data_type) DO UPDATE SET can_fetch=true`,
    );
    await db.execute(sql`INSERT INTO registered_remote_solvers (id,instance_id,instance_name,cpu_capacity,cpu_budget,max_active_polar_promises,
      auth_token_hash,credential_version,last_heartbeat_at,metadata)
      VALUES (${solverId}::uuid,${solverId},'short-work fixture',96,96,96,${"c".repeat(64)},1,clock_timestamp(),
      jsonb_build_object('progressiveExecution',${JSON.stringify(capability)}::jsonb,'progressiveExecutionObservedAt',clock_timestamp()))`);
    await expect(
      claimProgressiveCfdBatch(db, { ...claim, preferredWorkId: "" }),
    ).rejects.toThrow("exact work id");
    const [normalHead] = await rollback(db, (c) =>
      claimProgressiveCfdBatch(c, claim),
    );
    if (!normalHead) throw new Error("missing ordinary runnable head");
    const [other] =
      await db.execute(sql`SELECT id FROM progressive_work WHERE generation_id=${generationId}::uuid AND stage=${normalHead.stage}
        AND state='pending' AND id<>${normalHead.workId}::uuid ORDER BY id LIMIT 1`);
    const workId = String(other.id);
    const materialization = await claimProgressiveCfdBatch(db, {
      ...claim,
      preferredWorkId: workId,
    });
    expect(materialization.length).toBeGreaterThan(1);
    expect(materialization.every((l) => l.workId === workId)).toBe(true);
    await materializeProgressiveCfdExecution(db, materialization[0]!);
    // Keep the materialized execution revision in the disposable database.
    // Seed distinct already-spent solver seconds for the next complete march.
    for (const [ordinal, l] of materialization.entries()) {
      await db.execute(
        sql`DELETE FROM progressive_cfd_attempts WHERE token=${l.token}::uuid AND unit_id=${l.id}::uuid AND sim_job_id IS NULL`,
      );
      await db.execute(sql`UPDATE progressive_cfd_units SET state='pending', attempts=attempts-1, active_seconds=${1.25 + ordinal * 0.75}, lease_owner=NULL, lease_token=NULL, lease_until=NULL
          WHERE id=${l.id}::uuid AND lease_token=${l.token}::uuid`);
    }
    // The ordinary composer for this very same full target supplies an
    // independent baseline for every solver, mesh, budget and march field.
    const reference = await rollback(db, async (c) => {
      await c.execute(sql`UPDATE progressive_cfd_units u SET retry_after=clock_timestamp()+interval '1 hour'
          FROM progressive_work w WHERE w.id=u.work_id AND w.generation_id=${generationId}::uuid AND w.id<>${workId}::uuid AND u.state='pending'`);
      const group = await claimProgressiveCfdBatch(c, claim);
      expect(group.map((l) => l.id)).toEqual(materialization.map((l) => l.id));
      return composeProgressiveCfdJob(c, group, {
        cpuSlots: 96,
        meshRecoveryVersion: 1,
        uransRecoveryVersion: 14,
        solverBudgetVersion: 2,
        localTimeStepVersion: 1,
      });
    });
    expect(reference.request.resources?.case_solver_allocations?.length).toBe(
      materialization.length,
    );
    const slots = admissionCpuSlotsForRequest(reference.request);
    const selection = { solverId, workId, pool, slots, maxActiveSeconds: 3600 };
    const counters = async (c: DB) =>
      c.execute(sql`SELECT
        (SELECT count(*)::int FROM progressive_cfd_attempts a JOIN progressive_cfd_units u ON u.id=a.unit_id JOIN progressive_work w ON w.id=u.work_id WHERE w.generation_id=${generationId}::uuid) attempts,
        (SELECT count(*)::int FROM progressive_remote_dispatches WHERE solver_id=${solverId}::uuid) dispatches,
        (SELECT count(*)::int FROM sync_sweep_promises WHERE registered_solver_id=${solverId}::uuid) promises`);
    const initial = await counters(db);
    const updateHealth = (reserved: number) =>
      db.execute(sql`UPDATE registered_remote_solvers SET last_heartbeat_at=clock_timestamp(),
        metadata=metadata||jsonb_build_object('progressiveExecutionObservedAt',clock_timestamp(),'health',jsonb_build_object('sampledAt',clock_timestamp(),
        'execution',jsonb_build_object('capacityCpuSlots',96,'reservedCpuSlots',${reserved}::int),'storage',jsonb_build_object('admissionBlocked',false))) WHERE id=${solverId}::uuid`);
    await updateHealth(96);
    const preview = await previewShortWork(db, selection);
    if (!preview)
      throw new Error("the complete reference group must be available");
    expect(preview.units.map((u) => u.id)).toEqual(
      materialization.map((l) => l.id),
    );
    expect(
      await previewShortWork(db, { ...selection, pool: "other-worker-pool" }),
    ).toBeNull();
    expect(
      await previewShortWork(db, { ...selection, maxActiveSeconds: 1 }),
    ).toBeNull();
    expect(
      await previewShortWork(db, { ...selection, slots: slots + 1 }),
    ).toBeNull();
    expect(
      await previewShortWork(db, { ...selection, slots: undefined }),
    ).toEqual(preview);
    expect(preview.solverProcesses).toBe(
      reference.request.resources?.solver_processes ?? null,
    );
    const digest = analysisContentHash(preview);
    const until = new Date(Date.now() + 45 * 60_000);
    await expect(
      rollback(db, (c) => enableShortWork(c, selection, "0".repeat(64), until)),
    ).rejects.toThrow("preview");
    await expect(
      rollback(db, (c) =>
        enableShortWork(
          c,
          selection,
          digest,
          new Date(Date.now() + 61 * 60_000),
        ),
      ),
    ).rejects.toThrow("next hour");
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
    await expect(enableShortWork(db, selection, digest, until)).rejects.toThrow(
      "hub role",
    );
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
    await rollback(db, async (c) => {
      const prior = await prepareProgressiveRemoteDispatch(c, solverId);
      if (prior.kind !== "prepared") throw new Error(prior.reason);
      expect(prior.envelope.scope.units.map((u) => u.unitId)).toContain(
        normalHead.id,
      );
      await enableShortWork(c, selection, digest, until);
      const occupied = await counters(c);
      for (let call = 0; call < 3; call++) {
        expect(
          await prepareProgressiveRemoteDispatch(c, solverId),
        ).toMatchObject({
          kind: "waiting",
          reason: expect.stringContaining("awaiting its worker start"),
        });
      }
      expect((await shortWorkStatus(c, solverId))?.issued_job_id).toBeNull();
      expect(await counters(c)).toEqual(occupied);
    });
    const args = [
      "--solver",
      solverId,
      "--work",
      workId,
      "--pool",
      pool,
      "--slots",
      String(slots),
      "--max-active-seconds",
      "3600",
    ];
    expect((await cli(["preview", ...args])).planSha256).toEqual(digest);
    const [window, concurrentReplay] = await Promise.all([
      cli([
        "enable",
        ...args,
        "--expect-sha256",
        digest,
        "--until",
        until.toISOString(),
      ]),
      enableShortWork(otherClient.db, selection, digest, until),
    ]);
    expect(window.id).toBe(concurrentReplay.id);
    expect((await enableShortWork(db, selection, digest, until)).id).toBe(
      window.id,
    );
    await expect(
      rollback(db, (c) =>
        enableShortWork(c, selection, digest, new Date(until.getTime() + 1)),
      ),
    ).rejects.toThrow("already has");
    expect(await prepareProgressiveRemoteDispatch(db, solverId)).toMatchObject({
      kind: "waiting",
      reason: expect.stringContaining("vacant"),
    });
    expect(await counters(db)).toEqual(initial);
    await updateHealth(96 - slots);
    await rollback(db, async (c) => {
      await c.execute(
        sql`UPDATE registered_remote_solvers SET credential_version=credential_version+1 WHERE id=${solverId}::uuid`,
      );
      const current = await previewShortWork(c, selection);
      expect(current?.credentialVersion).toBe(preview.credentialVersion + 1);
      expect(analysisContentHash(current)).not.toBe(digest);
      const fallback = await prepareProgressiveRemoteDispatch(c, solverId);
      if (fallback.kind !== "prepared") throw new Error(fallback.reason);
      expect(fallback.envelope.scope.units.map((u) => u.unitId)).toContain(
        normalHead.id,
      );
      expect((await shortWorkStatus(c, solverId))?.issued_job_id).toBeNull();
    });
    // If any pinned member changes, leave the whole stale group untouched
    // and fall back to the ordinary head within this same invocation.
    await rollback(db, async (c) => {
      await c.execute(
        sql`UPDATE progressive_cfd_units SET active_seconds=active_seconds+0.5 WHERE id=${preview.units[0]!.id}::uuid`,
      );
      const ordinary = await prepareProgressiveRemoteDispatch(c, solverId);
      expect(ordinary.kind).toBe("prepared");
      if (ordinary.kind === "prepared")
        expect(ordinary.envelope.scope.units.map((u) => u.unitId)).toContain(
          normalHead.id,
        );
      expect((await shortWorkStatus(c, solverId))?.issued_job_id).toBeNull();
    });
    // Expiry after the preferred units were actually claimed and composed
    // rolls the entire offer back, then selects the unrestricted head once.
    await rollback(db, async (c) => {
      await c.execute(sql`UPDATE registered_short_work_windows SET opened_at=clock_timestamp()-interval '1 minute',
          expires_at=clock_timestamp()+interval '1 hour'-interval '2 minutes' WHERE id=${window.id}::uuid`);
      await c.execute(sql`CREATE FUNCTION pg_temp.expire_short_preference_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            UPDATE registered_short_work_windows SET expires_at=clock_timestamp()-interval '1 millisecond'
              WHERE ended_at IS NULL AND issued_job_id IS NULL;
            RETURN NEW;
          END $$`);
      await c.execute(sql`CREATE TRIGGER expire_fixture_after_binding AFTER INSERT ON progressive_remote_dispatches
          FOR EACH ROW EXECUTE FUNCTION pg_temp.expire_short_preference_fixture()`);
      const ordinary = await prepareProgressiveRemoteDispatch(c, solverId);
      if (ordinary.kind !== "prepared") throw new Error(ordinary.reason);
      expect(ordinary.envelope.scope.units.map((u) => u.unitId)).toContain(
        normalHead.id,
      );
      expect((await shortWorkStatus(c, solverId))?.issued_job_id).toBeNull();
      const [history] = await c.execute(
        sql`SELECT count(*)::int AS n FROM progressive_cfd_attempts a JOIN progressive_cfd_units u ON u.id=a.unit_id WHERE u.work_id=${workId}::uuid`,
      );
      expect(history.n).toBe(0);
    });
    const competition = await Promise.all([
      prepareProgressiveRemoteDispatch(db, solverId),
      prepareProgressiveRemoteDispatch(otherClient.db, solverId),
    ]);
    expect(competition.map((r) => r.kind).sort()).toEqual([
      "prepared",
      "waiting",
    ]);
    const preferred = competition.find((r) => r.kind === "prepared")!;
    if (preferred.kind !== "prepared")
      throw new Error("missing registered offer");
    expect(preferred.envelope.scope.units.map((u) => u.unitId)).toEqual(
      preview.units.map((u) => u.id),
    );
    expect({
      ...preferred.envelope.request,
      execution_id: reference.request.execution_id,
    }).toEqual(reference.request);
    const execution = preferred.envelope.scope.executionId;
    expect(
      (await shortWorkStatus(otherClient.db, solverId))?.issued_job_id,
    ).toBe(execution);
    expect((await cli(["status", "--solver", solverId])).issued_job_id).toBe(
      execution,
    );
    const after = await counters(db);
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(
        await prepareProgressiveRemoteDispatch(db, solverId),
      ).toMatchObject({
        kind: "waiting",
        reason: expect.stringContaining("awaiting its worker start"),
      });
    }
    expect(await counters(db)).toEqual(after);
    // The original case lease can expire before a worker starts it. Ordinary
    // sibling admission can then proceed; the one spent preference stays spent.
    await rollback(db, async (c) => {
      await c.execute(sql`UPDATE progressive_cfd_units u SET lease_until=clock_timestamp()-interval '1 second'
        FROM progressive_cfd_attempts a WHERE a.sim_job_id=${execution}::uuid AND u.id=a.unit_id AND u.lease_token=a.token`);
      const sibling = await prepareProgressiveRemoteDispatch(c, solverId);
      if (sibling.kind !== "prepared") throw new Error(sibling.reason);
      expect(sibling.envelope.scope.units.map((u) => u.unitId)).toContain(
        normalHead.id,
      );
      expect((await shortWorkStatus(c, solverId))?.issued_job_id).toBe(
        execution,
      );
      const afterSibling = await counters(c);
      expect(await prepareProgressiveRemoteDispatch(c, solverId)).toMatchObject(
        {
          kind: "waiting",
          reason: expect.stringContaining("awaiting its worker start"),
        },
      );
      expect(await counters(c)).toEqual(afterSibling);
    });
    const otherActor = await prepareProgressiveRemoteDispatch(
      otherClient.db,
      solverId,
    );
    expect(otherActor.kind).toBe("waiting");
    await expect(
      endShortWork(db, randomUUID(), String(window.id)),
    ).rejects.toThrow("No matching");
    const [before] =
      await db.execute(sql`SELECT d.content_signature,p.status,p."expiresAt",j.status AS job FROM progressive_remote_dispatches d
        JOIN sync_sweep_promises p ON p.id=d.promise_id JOIN sim_jobs j ON j.id=d.sim_job_id WHERE d.sim_job_id=${execution}::uuid`);
    await rollback(db, async (c) => {
      await c.execute(sql`UPDATE registered_short_work_windows SET opened_at=clock_timestamp()-interval '2 minutes',
          expires_at=clock_timestamp()-interval '1 second' WHERE id=${window.id}::uuid`);
      expect((await shortWorkStatus(c, solverId))?.current).toBe(false);
      expect((await prepareProgressiveRemoteDispatch(c, solverId)).kind).toBe(
        "prepared",
      );
    });
    expect(
      (await cli(["end", "--solver", solverId, "--window", String(window.id)]))
        .issued_job_id,
    ).toBe(execution);
    expect(
      (await enableShortWork(db, selection, digest, until)).issued_job_id,
    ).toBe(execution);
    expect((await shortWorkStatus(db, solverId))?.current).toBe(false);
    const [afterEnd] =
      await db.execute(sql`SELECT d.content_signature,p.status,p."expiresAt",j.status AS job FROM progressive_remote_dispatches d
        JOIN sync_sweep_promises p ON p.id=d.promise_id JOIN sim_jobs j ON j.id=d.sim_job_id WHERE d.sim_job_id=${execution}::uuid`);
    expect(afterEnd).toEqual(before);
  } finally {
    await otherClient.sql.end({ timeout: 5 });
    await db.execute(
      sql`DELETE FROM progressive_remote_dispatches WHERE solver_id=${solverId}::uuid`,
    );
    await db.execute(
      sql`DELETE FROM sync_sweep_promises WHERE registered_solver_id=${solverId}::uuid`,
    );
    await db.execute(
      sql`DELETE FROM registered_remote_solvers WHERE id=${solverId}::uuid`,
    );
    if (setting)
      await db.execute(
        sql`UPDATE sync_api_settings SET enabled=${setting.enabled} WHERE id=1`,
      );
    if (permission)
      await db.execute(
        sql`UPDATE sync_api_permissions SET can_fetch=${permission.can_fetch} WHERE data_type='sweeps'`,
      );
    else
      await db.execute(
        sql`DELETE FROM sync_api_permissions WHERE data_type='sweeps'`,
      );
    if (oldRole === undefined) delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
    else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = oldRole;
  }
}
