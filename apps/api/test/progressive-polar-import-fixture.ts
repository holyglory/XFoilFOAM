import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { eq, sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import {
  analysisContentHash,
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
