import { randomUUID } from "node:crypto";
import { verifyProgressiveWorkerArchiveCustody } from "./progressive-worker-archive-custody-fixture";
import { verifyProgressiveWorkerArchiveDelivery } from "./progressive-worker-archive-delivery-fixture";
import { nextProgressiveEvidenceWakeAt } from "../../../apps/sweeper/src/progressive-evidence-service";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { DB } from "../src/client";
import {
  deliverNextProgressiveWorkerEvidence,
  progressiveWorkerEvidenceReference,
  recordProgressiveWorkerEvidenceReceipt,
} from "../../../apps/sweeper/src/progressive-worker-evidence-delivery";

export async function verifyProgressiveWorkerEvidenceDelivery(
  db: DB,
  executionId: string,
) {
  const [original] = await db.execute(
    sql`SELECT remote_solver_enabled, remote_solver_transfer_paused FROM sync_api_settings WHERE id = 1`,
  );
  const [source] =
    await db.execute(sql`SELECT source.sequence, source.point_content_signature, source.result_attempt_id, attempt.result_id,
    report.content_signature AS report_signature, attempt.aoa_deg, attempt.engine_case_slug, job.status
    FROM progressive_worker_evidence_attempts source
    JOIN result_attempts attempt ON attempt.id = source.result_attempt_id
    JOIN sim_jobs job ON job.id = source.sim_job_id
    JOIN progressive_worker_reports report ON report.sim_job_id = source.sim_job_id AND report.sequence = source.sequence
    WHERE source.sim_job_id = ${executionId}::uuid ORDER BY source.sequence LIMIT 1`);
  const receipt = {
    version: 1,
    kind: "retained-progressive-attempt",
    executionId,
    sequence: Number(source.sequence),
    pointContentSignature: source.point_content_signature,
    remoteResultId: source.result_id,
    remoteResultAttemptId: source.result_attempt_id,
    resultId: randomUUID(),
    resultAttemptId: randomUUID(),
    receivedAt: new Date().toISOString(),
  };
  try {
    expect(
      await progressiveWorkerEvidenceReference(
        db,
        executionId,
        String(source.result_attempt_id),
      ),
    ).toEqual({
      sequence: Number(source.sequence),
      reportContentSignature: source.report_signature,
      pointContentSignature: source.point_content_signature,
    });
    await expect(
      progressiveWorkerEvidenceReference(db, executionId, randomUUID()),
    ).rejects.toThrow("exact report association");
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_enabled = false, remote_solver_transfer_paused = true WHERE id = 1`,
    );
    const unused = vi.fn();
    expect(await deliverNextProgressiveWorkerEvidence(db, unused)).toBe(false);
    expect(unused).not.toHaveBeenCalled();
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused = false WHERE id = 1`,
    );
    const offline = vi.fn(async () => {
      throw new Error("isolated unavailable hub");
    });
    await expect(
      deliverNextProgressiveWorkerEvidence(db, offline),
    ).rejects.toThrow("unavailable hub");
    const [retry] =
      await db.execute(sql`SELECT state, attempt_count, last_http_status,
      retry_after > clock_timestamp() AS delayed FROM progressive_worker_delivery_failures WHERE sim_job_id = ${executionId}::uuid`);
    expect(retry).toMatchObject({
      state: "retry",
      attempt_count: 1,
      last_http_status: null,
      delayed: true,
    });
    const retryAt = new Date(Date.now() + 10057);
    await db.execute(
      sql`UPDATE progressive_worker_delivery_failures SET retry_after = ${retryAt.toISOString()}::timestamptz WHERE sim_job_id = ${executionId}::uuid`,
    );
    expect(await nextProgressiveEvidenceWakeAt(db)).toEqual(retryAt);
    expect(await deliverNextProgressiveWorkerEvidence(db, unused)).toBe(false);
    expect(unused).not.toHaveBeenCalled();
    await db.execute(sql`UPDATE progressive_worker_delivery_failures SET retry_after = clock_timestamp() - interval '1 second'
      WHERE sim_job_id = ${executionId}::uuid`);
    const rejected = vi.fn(
      async () => new Response("conflict", { status: 409 }),
    );
    await expect(
      deliverNextProgressiveWorkerEvidence(db, rejected),
    ).rejects.toThrow("409");
    const [conflict] =
      await db.execute(sql`SELECT state, attempt_count, last_http_status, retry_after
      FROM progressive_worker_delivery_failures WHERE sim_job_id = ${executionId}::uuid`);
    expect(conflict).toMatchObject({
      state: "conflict",
      attempt_count: 2,
      last_http_status: 409,
      retry_after: null,
    });
    expect(await deliverNextProgressiveWorkerEvidence(db, unused)).toBe(false);
    expect(unused).not.toHaveBeenCalled();
    await db.execute(
      sql`DELETE FROM progressive_worker_delivery_failures WHERE sim_job_id = ${executionId}::uuid`,
    );
    const remoteConflictId = randomUUID();
    const importConflict = vi.fn(async () =>
      Response.json({
        conflictIds: [remoteConflictId, remoteConflictId],
        progressiveEvidenceReceipts: [],
      }),
    );
    await expect(
      deliverNextProgressiveWorkerEvidence(db, importConflict),
    ).rejects.toThrow("import conflict review");
    const [retainedConflict] =
      await db.execute(sql`SELECT state,last_http_status,retry_after,remote_conflict_ids
      FROM progressive_worker_delivery_failures WHERE sim_job_id=${executionId}::uuid`);
    expect(retainedConflict).toMatchObject({
      state: "conflict",
      last_http_status: 200,
      retry_after: null,
      remote_conflict_ids: [remoteConflictId],
    });
    expect(await deliverNextProgressiveWorkerEvidence(db, unused)).toBe(false);
    expect(importConflict).toHaveBeenCalledTimes(1);
    expect(unused).not.toHaveBeenCalled();
    await db.execute(
      sql`DELETE FROM progressive_worker_delivery_failures WHERE sim_job_id=${executionId}::uuid`,
    );
    for (const conflictIds of [
      null,
      "invalid",
      ["invalid"],
      Array.from({ length: 129 }, () => remoteConflictId),
    ]) {
      await expect(
        deliverNextProgressiveWorkerEvidence(db, async () =>
          Response.json({ conflictIds, progressiveEvidenceReceipts: [] }),
        ),
      ).rejects.toThrow("malformed progressive import conflict");
      const [malformed] =
        await db.execute(sql`SELECT state,last_http_status,remote_conflict_ids FROM progressive_worker_delivery_failures
        WHERE sim_job_id=${executionId}::uuid`);
      expect(malformed).toMatchObject({
        state: "retry",
        last_http_status: 200,
        remote_conflict_ids: [],
      });
      await db.execute(
        sql`DELETE FROM progressive_worker_delivery_failures WHERE sim_job_id=${executionId}::uuid`,
      );
    }
    const foreign = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            progressiveEvidenceReceipts: [
              { ...receipt, remoteResultAttemptId: randomUUID() },
            ],
          }),
        ),
    );
    await expect(
      deliverNextProgressiveWorkerEvidence(db, foreign),
    ).rejects.toThrow("exact progressive source attempt");
    await db.execute(sql`UPDATE progressive_worker_delivery_failures SET retry_after = clock_timestamp() - interval '1 second'
      WHERE sim_job_id = ${executionId}::uuid`);
    const noReceipt = await db.execute(
      sql`SELECT * FROM progressive_worker_hub_receipts WHERE sim_job_id = ${executionId}::uuid`,
    );
    expect(noReceipt).toHaveLength(0);
    const expected = {
      executionId,
      pointContentSignature: String(source.point_content_signature),
      resultId: String(source.result_id),
      resultAttemptId: String(source.result_attempt_id),
    };
    for (const sequence of [0, -1, 1.5, "1", null]) {
      await expect(
        recordProgressiveWorkerEvidenceReceipt(
          db,
          { ...receipt, sequence },
          expected,
        ),
      ).rejects.toThrow("exact progressive source attempt");
    }
    const delivered = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(String(_url)).toMatch(/\/polars$/);
        expect(init?.redirect).toBe("error");
        expect(init?.headers).toMatchObject({
          "content-type": "application/json",
        });
        const body = JSON.parse(String(init?.body));
        expect(body.results).toEqual([
          {
            aoaDeg: Number(source.aoa_deg),
            engineJobId: executionId,
            engineCaseSlug: source.engine_case_slug,
            remoteResultId: source.result_id,
            remoteResultAttemptId: source.result_attempt_id,
            progressiveEvidence: {
              sequence: Number(source.sequence),
              reportContentSignature: source.report_signature,
              pointContentSignature: source.point_content_signature,
            },
          },
        ]);
        return new Response(
          JSON.stringify({
            progressiveEvidenceReceipts: [receipt],
            fulfilledAoas: [],
          }),
        );
      },
    );
    expect(await deliverNextProgressiveWorkerEvidence(db, delivered)).toBe(
      true,
    );
    expect(await deliverNextProgressiveWorkerEvidence(db, unused)).toBe(false);
    expect(unused).not.toHaveBeenCalled();
    const [stored] = await db.execute(
      sql`SELECT receipt FROM progressive_worker_hub_receipts WHERE sim_job_id = ${executionId}::uuid`,
    );
    expect(stored.receipt).toEqual(receipt);
    const failures = await db.execute(
      sql`SELECT * FROM progressive_worker_delivery_failures WHERE sim_job_id = ${executionId}::uuid`,
    );
    expect(failures).toHaveLength(0);
    await verifyProgressiveWorkerArchiveDelivery(db, executionId);
    await verifyProgressiveWorkerArchiveCustody(db, executionId);
    const [unchanged] = await db.execute(
      sql`SELECT status FROM sim_jobs WHERE id = ${executionId}::uuid`,
    );
    expect(unchanged.status).toBe(source.status);
    const [attempt] = await db.execute(
      sql`SELECT valid_for_polar FROM result_attempts WHERE id = ${source.result_attempt_id}::uuid`,
    );
    expect(attempt.valid_for_polar).toBe(false);
    await expect(
      db.execute(
        sql`UPDATE progressive_worker_hub_receipts SET receipt = '{}'::jsonb WHERE sim_job_id = ${executionId}::uuid`,
      ),
    ).rejects.toThrow();
  } finally {
    await db.execute(sql`UPDATE sync_api_settings SET remote_solver_enabled = ${original.remote_solver_enabled},
      remote_solver_transfer_paused = ${original.remote_solver_transfer_paused} WHERE id = 1`);
  }
}
