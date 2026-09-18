import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { eq, sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import {
  analysisContentHash,
  acknowledgeProgressiveCfdExecutionStop,
  storeProgressiveRemoteReport,
  type ProgressiveRemoteReport,
  progressiveRemotePointProjection,
  resolveProgressiveRemoteEvidence,
  resultAttempts,
  results,
  type DB,
  type Sql,
  type ProgressiveRemoteEvidenceDelivery,
} from "@aerodb/db";
import { registerSyncRoutes, type importPolarPush } from "../src/sync-routes";
import { verifyProgressivePolarArchiveImport } from "./progressive-polar-archive-fixture";
import { assembleSim } from "../src/services/sim";
import { verifyAdoptedEvidenceAccess } from "./progressive-adopted-evidence-fixture";

const isolated = vi.hoisted(() => ({
  connection: null as DB | null,
  advisorySql: null as Sql | null,
}));

vi.mock("../src/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        if (!isolated.connection)
          throw new Error("Isolated API database is not assigned");
        const value = Reflect.get(isolated.connection, property);
        return typeof value === "function"
          ? value.bind(isolated.connection)
          : value;
      },
    },
  ),
  advisoryLockSql: {
    reserve: () => {
      if (!isolated.advisorySql)
        throw new Error("Isolated advisory database is not assigned");
      return isolated.advisorySql.reserve();
    },
  },
}));

export async function verifyProgressivePolarImport(
  db: DB,
  delivery: ProgressiveRemoteEvidenceDelivery,
  advisorySql: Sql,
) {
  if (isolated.connection)
    throw new Error("Isolated API fixture is already active");
  isolated.connection = db;
  isolated.advisorySql = advisorySql;
  const source = await resolveProgressiveRemoteEvidence(db, delivery);
  if (!source) throw new Error("Missing isolated polar import source");
  const projection = progressiveRemotePointProjection(source);
  const [job] =
    await db.execute(sql`SELECT engine_job_id, campaign_id, airfoil_id, simulation_preset_revision_id
    FROM sim_jobs WHERE id = ${delivery.engineJobId}::uuid`);
  const [campaign] = await db.execute(
    sql`SELECT status FROM sim_campaigns WHERE id = ${job.campaign_id}::uuid`,
  );
  const [existing] =
    await db.execute(sql`SELECT id FROM results WHERE airfoil_id = ${job.airfoil_id}::uuid
    AND simulation_preset_revision_id = ${job.simulation_preset_revision_id}::uuid AND aoa_deg = ${delivery.aoaDeg}`);
  const [solver] = await db.execute(
    sql`SELECT instance_id, auth_token_hash FROM registered_remote_solvers WHERE id = ${delivery.solverId}::uuid`,
  );
  const [promise] = await db.execute(
    sql`SELECT source_instance_id, request_payload FROM sync_sweep_promises WHERE id = ${delivery.promiseId}::uuid`,
  );
  const app = Fastify({ logger: false });
  await app.register(multipart);
  await registerSyncRoutes(app);
  await app.inject({ method: "GET", url: "/api/sync/v1/status" });
  const [settings] = await db.execute(
    sql`SELECT enabled FROM sync_api_settings WHERE id = 1`,
  );
  const [permission] = await db.execute(
    sql`SELECT can_push FROM sync_api_permissions WHERE data_type = 'polars'`,
  );
  const token = `isolated-progressive-http-${randomUUID()}`;
  const push: typeof importPolarPush = async (input) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/sync/v1/polars",
      headers: { "x-xfoilfoam-solver-token": token },
      payload: input,
    });
    const body = response.json();
    if (response.statusCode >= 400) {
      expect(response.statusCode, response.body).toBe(409);
      throw new Error(body.error);
    }
    expect(response.statusCode).toBe(200);
    return body;
  };
  const payload: Parameters<typeof importPolarPush>[0] = {
    promiseId: delivery.promiseId,
    sourceInstanceId: String(solver.instance_id),
    fieldColorScales: [],
    results: [
      {
        ...projection,
        engine: undefined,
        cl: 99,
        converged: true,
        error: null,
        status: "done",
        source: "solved",
        remoteResultId: delivery.remoteResultId,
        remoteResultAttemptId: delivery.remoteResultAttemptId,
        progressiveEvidence: delivery.progressiveEvidence,
        fieldExtents: [],
        evidenceArtifacts: [],
        media: [],
      },
    ],
  };
  let createdResultId: string | null = null;
  try {
    await db.execute(
      sql`UPDATE sync_api_settings SET enabled = true WHERE id = 1`,
    );
    await db.execute(
      sql`UPDATE sync_api_permissions SET can_push = true WHERE data_type = 'polars'`,
    );
    await db.execute(
      sql`UPDATE registered_remote_solvers SET auth_token_hash = ${createHash("sha256").update(token).digest("hex")} WHERE id = ${delivery.solverId}::uuid`,
    );
    await db.execute(sql`UPDATE sync_sweep_promises SET source_instance_id = ${solver.instance_id},
      request_payload = coalesce(request_payload, '{}'::jsonb) || ${JSON.stringify({ solverId: delivery.solverId, executionContract: "progressive-cfd-v1" })}::jsonb
      WHERE id = ${delivery.promiseId}::uuid`);
    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/sync/v1/polars",
      headers: { "x-xfoilfoam-solver-token": "isolated-wrong-credential" },
      payload,
    });
    expect(unauthorized.statusCode).toBe(401);
    const foreignInstance = await app.inject({
      method: "POST",
      url: "/api/sync/v1/polars",
      headers: { "x-xfoilfoam-solver-token": token },
      payload: { ...payload, sourceInstanceId: randomUUID() },
    });
    expect(foreignInstance.statusCode).toBe(403);
    await db.execute(
      sql`UPDATE sim_jobs SET engine_job_id = id::text WHERE id = ${delivery.engineJobId}::uuid`,
    );
    await expect(
      push(
        {
          ...payload,
          results: [{ ...payload.results[0], progressiveEvidence: undefined }],
        },
        new Map(),
      ),
    ).rejects.toThrow("exact report");
    await expect(
      push(
        {
          ...payload,
          results: [{ ...payload.results[0], engineJobId: randomUUID() }],
        },
        new Map(),
      ),
    ).rejects.toThrow("own this execution");
    await expect(
      push(
        {
          ...payload,
          results: [{ ...payload.results[0], progressiveArchiveOnly: true }],
        },
        new Map(),
      ),
    ).rejects.toThrow("previously retained progressive source");
    const storageRollback = new Error(
      "Rollback isolated stopped storage import",
    );
    try {
      await db.transaction(async (transaction) => {
        const scoped = transaction as unknown as DB;
        isolated.connection = scoped;
        const [latest] =
          await scoped.execute(sql`SELECT report FROM progressive_remote_reports
          WHERE sim_job_id=${delivery.engineJobId}::uuid ORDER BY sequence DESC LIMIT 1`);
        let terminal = latest.report as ProgressiveRemoteReport;
        if (!terminal.stopProof) {
          terminal = {
            ...terminal,
            sequence: terminal.sequence + 1,
            status: {
              ...terminal.status,
              state: "completed",
              completed_cases: terminal.status.total_cases,
            },
            result: { ...terminal.result!, state: "completed" },
            stopProof: {
              version: 1,
              job_id: delivery.engineJobId,
              execution_stopped: true,
              producer_stopped: true,
              namespace_verified: true,
              remaining: [],
              observed_at: new Date().toISOString(),
              error: null,
              fence: "terminal_result",
            },
          };
          await storeProgressiveRemoteReport(scoped, {
            solverId: delivery.solverId,
            promiseId: delivery.promiseId,
            executionId: delivery.engineJobId,
            report: terminal,
          });
        }
        await acknowledgeProgressiveCfdExecutionStop(scoped, {
          simJobId: delivery.engineJobId,
          proof: terminal.stopProof!,
        });
        await scoped.execute(
          sql`UPDATE sync_sweep_promises SET status='cancelled' WHERE id=${delivery.promiseId}::uuid`,
        );
        await scoped.execute(
          sql`UPDATE sync_sweep_promise_points SET status='cancelled' WHERE promise_id=${delivery.promiseId}::uuid`,
        );
        await scoped.execute(
          sql`UPDATE sim_jobs SET status='cancelled' WHERE id=${delivery.engineJobId}::uuid`,
        );
        await scoped.execute(
          sql`UPDATE progressive_cfd_attempts SET outcome='cancelled' WHERE sim_job_id=${delivery.engineJobId}::uuid`,
        );
        const [before] = await scoped.execute(
          sql`SELECT to_jsonb(canonical) AS row FROM results canonical WHERE id=${existing.id}::uuid`,
        );
        const scopesBefore =
          await scoped.execute(sql`SELECT unit.id,unit.state,unit.active_seconds FROM progressive_cfd_units unit
          JOIN progressive_cfd_attempts attempt ON attempt.unit_id=unit.id WHERE attempt.sim_job_id=${delivery.engineJobId}::uuid ORDER BY unit.id`);
        const storage = (body = payload, credential = token) =>
          app.inject({
            method: "POST",
            url: "/api/sync/v1/retained-progressive-evidence",
            headers: { "x-xfoilfoam-solver-token": credential },
            payload: body,
          });
        expect((await storage(payload, "wrong-credential")).statusCode).toBe(
          401,
        );
        for (const mutation of [
          sql`DELETE FROM progressive_cfd_execution_stops WHERE sim_job_id=${delivery.engineJobId}::uuid`,
          sql`UPDATE registered_remote_solvers SET revoked_at=clock_timestamp() WHERE id=${delivery.solverId}::uuid`,
          sql`UPDATE sim_jobs SET engine_job_id=${randomUUID()} WHERE id=${delivery.engineJobId}::uuid`,
          sql`UPDATE sim_jobs SET status='ingesting' WHERE id=${delivery.engineJobId}::uuid`,
          sql`UPDATE sim_jobs SET ingest_lease_token=${randomUUID()}::uuid,ingest_lease_expires_at=clock_timestamp()+interval '1 minute'
            WHERE id=${delivery.engineJobId}::uuid`,
          sql`UPDATE progressive_cfd_attempts SET outcome='running' WHERE sim_job_id=${delivery.engineJobId}::uuid`,
          sql`UPDATE sync_sweep_promises SET status='active' WHERE id=${delivery.promiseId}::uuid`,
        ]) {
          const rollbackRejection = new Error(
            "Rollback stopped-storage rejection fixture",
          );
          try {
            await scoped.transaction(async (nested) => {
              isolated.connection = nested as unknown as DB;
              await nested.execute(mutation);
              const rejected = await storage();
              expect([401, 409], rejected.body).toContain(rejected.statusCode);
              throw rollbackRejection;
            });
          } catch (error) {
            if (error !== rollbackRejection) throw error;
          } finally {
            isolated.connection = scoped;
          }
        }
        expect(
          (
            await storage({
              ...payload,
              results: [
                {
                  ...payload.results[0],
                  progressiveEvidence: {
                    ...delivery.progressiveEvidence,
                    pointContentSignature: "0".repeat(64),
                  },
                },
              ],
            })
          ).statusCode,
        ).toBe(409);
        await expect(push(payload, new Map())).rejects.toThrow(
          "promise is not active",
        );
        await scoped.execute(
          sql`UPDATE sim_jobs SET status='running' WHERE id=${delivery.engineJobId}::uuid`,
        );
        expect((await storage()).statusCode).toBe(409);
        await scoped.execute(
          sql`UPDATE sim_jobs SET status='cancelled' WHERE id=${delivery.engineJobId}::uuid`,
        );
        const retained = await storage();
        expect(retained.statusCode, retained.body).toBe(200);
        expect(retained.json().conflictIds).toEqual([]);
        expect(retained.json().fulfilledAoas).toEqual([]);
        expect(retained.json().progressiveEvidenceReceipts).toMatchObject([
          { storageOnly: true },
        ]);
        const replay = await storage();
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json().progressiveEvidenceReceipts).toEqual(
          retained.json().progressiveEvidenceReceipts,
        );
        await verifyProgressivePolarArchiveImport({
          db: scoped,
          app,
          token,
          payload,
          delivery,
          retained: {
            resultId: retained.json().progressiveEvidenceReceipts[0].resultId,
            resultAttemptId:
              retained.json().progressiveEvidenceReceipts[0].resultAttemptId,
          },
          storageOnly: true,
          setConnection: (connection) => {
            isolated.connection = connection;
          },
        });
        const [after] = await scoped.execute(
          sql`SELECT to_jsonb(canonical) AS row FROM results canonical WHERE id=${existing.id}::uuid`,
        );
        expect(after).toEqual(before);
        expect(
          await scoped.execute(sql`SELECT unit.id,unit.state,unit.active_seconds FROM progressive_cfd_units unit
          JOIN progressive_cfd_attempts attempt ON attempt.unit_id=unit.id WHERE attempt.sim_job_id=${delivery.engineJobId}::uuid ORDER BY unit.id`),
        ).toEqual(scopesBefore);
        expect(
          await scoped.execute(
            sql`SELECT result_attempt_id FROM progressive_cfd_evidence WHERE result_attempt_id=${retained.json().progressiveEvidenceReceipts[0].resultAttemptId}::uuid`,
          ),
        ).toEqual([]);
        const [closed] = await scoped.execute(
          sql`SELECT status FROM sync_sweep_promises WHERE id=${delivery.promiseId}::uuid`,
        );
        expect(closed.status).toBe("cancelled");
        throw storageRollback;
      });
    } catch (error) {
      if (error !== storageRollback) throw error;
    } finally {
      isolated.connection = db;
    }
    const imported = await push(payload, new Map());
    expect(imported.conflictIds).toEqual([]);
    expect(imported.attempts).toBe(1);
    expect(imported.fulfilledAoas).toEqual([]);
    expect(imported.bindingReceipts).toEqual([]);
    expect(imported.progressiveArchiveReceipts).toEqual([]);
    expect(imported.progressiveEvidenceReceipts).toHaveLength(1);
    const receipt = imported.progressiveEvidenceReceipts[0];
    if (!existing) createdResultId = receipt.resultId;
    await verifyProgressivePolarArchiveImport({
      db,
      app,
      token,
      payload,
      delivery,
      retained: {
        resultId: receipt.resultId,
        resultAttemptId: receipt.resultAttemptId,
      },
      setConnection: (connection) => {
        isolated.connection = connection;
      },
    });
    const [attempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.id, receipt.resultAttemptId));
    expect(attempt.simJobId).toBe(delivery.engineJobId);
    expect(attempt.engineJobId).toBe(delivery.engineJobId);
    expect(attempt.cl).toBe(projection.cl);
    expect(attempt.converged).toBe(projection.converged);
    expect(attempt.validForPolar).toBe(Boolean(projection.converged));
    expect(analysisContentHash(attempt.evidencePayload)).toBe(
      analysisContentHash(projection.evidencePayload),
    );
    const [canonical] = await db
      .select()
      .from(results)
      .where(eq(results.id, receipt.resultId));
    expect(canonical.currentResultAttemptId).not.toBe(attempt.id);
    expect(canonical.cl).toBeNull();
    const [profile] = await db.execute(
      sql`SELECT slug FROM airfoils WHERE id = ${job.airfoil_id}::uuid`,
    );
    const observed = await assembleSim(
      String(profile.slug),
      undefined,
      undefined,
      receipt.resultId,
      receipt.resultAttemptId,
    );
    expect(observed).toMatchObject({
      resultId: receipt.resultId,
      resultAttemptId: receipt.resultAttemptId,
      status: "evidence",
      observation: { converged: projection.converged === true },
    });
    await verifyAdoptedEvidenceAccess(
      db,
      {
        executionId: delivery.engineJobId,
        slug: String(profile.slug),
        resultId: receipt.resultId,
        attemptId: receipt.resultAttemptId,
      },
      (connection) => {
        isolated.connection = connection;
      },
    );
    expect(
      await assembleSim(
        String(profile.slug),
        undefined,
        undefined,
        randomUUID(),
        receipt.resultAttemptId,
      ),
    ).toBeNull();
    expect(
      await assembleSim(
        "unrelated-profile",
        undefined,
        undefined,
        receipt.resultId,
        receipt.resultAttemptId,
      ),
    ).toBeNull();
    expect(
      await assembleSim(
        String(profile.slug),
        undefined,
        undefined,
        receipt.resultId,
        randomUUID(),
      ),
    ).toBeNull();
    const replay = await push(payload, new Map());
    expect(replay.attempts).toBe(0);
    expect(replay.progressiveEvidenceReceipts).toEqual(
      imported.progressiveEvidenceReceipts,
    );
    await db.execute(
      sql`UPDATE sim_campaigns SET status = 'cancelled' WHERE id = ${job.campaign_id}::uuid`,
    );
    const cancelledReplay = await push(payload, new Map());
    expect(
      await assembleSim(
        String(profile.slug),
        undefined,
        undefined,
        receipt.resultId,
        receipt.resultAttemptId,
      ),
    ).toBeNull();
    expect(cancelledReplay.progressiveEvidenceReceipts).toEqual(
      imported.progressiveEvidenceReceipts,
    );
    expect(cancelledReplay.fulfilledAoas).toEqual([]);
    await expect(
      push(
        {
          ...payload,
          results: [
            { ...payload.results[0], remoteResultAttemptId: randomUUID() },
          ],
        },
        new Map(),
      ),
    ).rejects.toThrow("immutable remote evidence identity");
    await db.execute(
      sql`DELETE FROM progressive_remote_evidence_receipts WHERE sim_job_id = ${delivery.engineJobId}::uuid`,
    );
    await expect(push(payload, new Map())).rejects.toThrow(
      "Campaign no longer accepts CFD evidence",
    );
    const [retained] = await db.execute(
      sql`SELECT count(*)::integer AS count FROM result_attempts WHERE sim_job_id = ${delivery.engineJobId}::uuid`,
    );
    expect(retained.count).toBe(1);
    const [legacy] = await db.execute(
      sql`SELECT count(*)::integer AS count FROM sim_jobs WHERE parent_job_id = ${delivery.engineJobId}::uuid`,
    );
    expect(legacy.count).toBe(0);
  } finally {
    await app.close();
    await db.execute(
      sql`UPDATE sync_api_settings SET enabled = ${settings.enabled} WHERE id = 1`,
    );
    await db.execute(
      sql`UPDATE sync_api_permissions SET can_push = ${permission.can_push} WHERE data_type = 'polars'`,
    );
    await db.execute(
      sql`UPDATE registered_remote_solvers SET auth_token_hash = ${solver.auth_token_hash} WHERE id = ${delivery.solverId}::uuid`,
    );
    await db.execute(sql`UPDATE sync_sweep_promises SET source_instance_id = ${promise.source_instance_id},
      request_payload = ${promise.request_payload == null ? null : JSON.stringify(promise.request_payload)}::jsonb WHERE id = ${delivery.promiseId}::uuid`);
    await db.execute(
      sql`UPDATE sim_campaigns SET status = ${campaign.status} WHERE id = ${job.campaign_id}::uuid`,
    );
    await db.execute(
      sql`UPDATE sim_jobs SET engine_job_id = ${job.engine_job_id} WHERE id = ${delivery.engineJobId}::uuid`,
    );
    await db
      .delete(resultAttempts)
      .where(eq(resultAttempts.simJobId, delivery.engineJobId));
    if (createdResultId)
      await db.delete(results).where(eq(results.id, createdResultId));
    isolated.connection = null;
    isolated.advisorySql = null;
  }
}
