import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import {
  validateProgressiveRemoteReport,
  type ProgressiveRemoteReport,
} from "../src/progressive-remote-report";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import {
  signProgressiveEvidenceCustodyReceipt,
  type ProgressiveEvidenceCustodyReceipt,
} from "../src/progressive-evidence-custody";
import { recordProgressiveWorkerArchiveCustody } from "../../../apps/sweeper/src/progressive-worker-archive-custody";
import { progressiveWorkerEvidenceReference } from "../../../apps/sweeper/src/progressive-worker-evidence-delivery";

export async function verifyProgressiveWorkerArchiveCustody(
  db: DB,
  executionId: string,
) {
  const [owned] = await db.execute(sql`
    SELECT source.result_attempt_id, attempt.result_id, attempt.aoa_deg, attempt.engine_case_slug,
      source.receipt, settings.remote_solver_auth_token, settings.remote_solver_registered_id,
      job.request_payload->>'syncPromiseId' AS promise_id
    FROM progressive_worker_hub_receipts source
    JOIN result_attempts attempt ON attempt.id = source.result_attempt_id
    JOIN sim_jobs job ON job.id = source.sim_job_id
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE source.sim_job_id = ${executionId}::uuid LIMIT 1
  `);
  const raw = owned.receipt as { resultId: string; resultAttemptId: string };
  const reference = await progressiveWorkerEvidenceReference(
    db,
    executionId,
    String(owned.result_attempt_id),
  );
  const rollbackReference = new Error(
    "Rollback isolated out-of-order report reference",
  );
  try {
    await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const [stored] =
        await connection.execute(sql`SELECT report.report, job.request_payload,
        (SELECT max(sequence) + 1 FROM progressive_worker_reports WHERE sim_job_id = ${executionId}::uuid) AS next_sequence
        FROM progressive_worker_reports report JOIN sim_jobs job ON job.id = report.sim_job_id
        WHERE report.sim_job_id = ${executionId}::uuid AND report.sequence = ${reference.sequence}`);
      const later = {
        ...(stored.report as unknown as ProgressiveRemoteReport),
        sequence: Number(stored.next_sequence),
      };
      const envelope = (
        stored.request_payload as {
          remoteProgressiveExecution: ProgressiveRemoteExecutionEnvelope;
        }
      ).remoteProgressiveExecution;
      const validated = validateProgressiveRemoteReport(later, envelope);
      await connection.execute(sql`INSERT INTO progressive_worker_reports(sim_job_id, sequence, content_signature, report, acknowledged_at)
        VALUES (${executionId}::uuid, ${later.sequence}, ${validated.contentSignature}, ${JSON.stringify(later)}::jsonb, clock_timestamp())`);
      await connection.execute(sql`INSERT INTO progressive_worker_evidence_receipts(sim_job_id, sequence, content_signature)
        VALUES (${executionId}::uuid, ${later.sequence}, ${validated.contentSignature})`);
      await connection.execute(sql`INSERT INTO progressive_worker_evidence_attempts(sim_job_id, sequence, result_attempt_id, point_content_signature)
        VALUES (${executionId}::uuid, ${later.sequence}, ${owned.result_attempt_id}::uuid, ${reference.pointContentSignature})`);
      await connection.execute(
        sql`DELETE FROM progressive_worker_hub_receipts WHERE sim_job_id = ${executionId}::uuid AND point_content_signature = ${reference.pointContentSignature}`,
      );
      await connection.execute(sql`INSERT INTO progressive_worker_hub_receipts(sim_job_id, sequence, result_attempt_id, point_content_signature, receipt)
        VALUES (${executionId}::uuid, ${later.sequence}, ${owned.result_attempt_id}::uuid, ${reference.pointContentSignature},
          ${JSON.stringify({ ...(owned.receipt as object), sequence: later.sequence })}::jsonb)`);
      expect(
        await progressiveWorkerEvidenceReference(
          connection,
          executionId,
          String(owned.result_attempt_id),
        ),
      ).toEqual({
        sequence: later.sequence,
        reportContentSignature: validated.contentSignature,
        pointContentSignature: reference.pointContentSignature,
      });
      throw rollbackReference;
    });
  } catch (error) {
    if (error !== rollbackReference) throw error;
  }
  const receipt: ProgressiveEvidenceCustodyReceipt = {
    schemaVersion: 1,
    kind: "hub-progressive-evidence-custody",
    source: {
      solverId: String(owned.remote_solver_registered_id),
      promiseId: String(owned.promise_id),
      engineJobId: executionId,
      aoaDeg: Number(owned.aoa_deg),
      engineCaseSlug:
        owned.engine_case_slug == null ? null : String(owned.engine_case_slug),
      remoteResultId: String(owned.result_id),
      remoteResultAttemptId: String(owned.result_attempt_id),
      progressiveEvidence: reference,
    },
    brokeredUploadId: randomUUID(),
    remote: {
      bucket: "isolated-custody-worker",
      objectKey: `solver-evidence/v1/sha256/cc/${"c".repeat(64)}.tar.zst`,
      generation: "9007199254740993123",
      crc32c: "ImIEBA==",
      storedSha256: "c".repeat(64),
      storedByteSize: 500,
      tarSha256: "d".repeat(64),
      tarByteSize: 1500,
      manifestSha256: "a".repeat(64),
      manifestByteSize: 100,
      zstdLevel: 3,
      bundledFileCount: 1,
    },
    canonical: {
      resultId: raw.resultId,
      resultAttemptId: raw.resultAttemptId,
      artifactId: randomUUID(),
      archiveId: randomUUID(),
    },
    boundAt: new Date().toISOString(),
  };
  const sign = (value: ProgressiveEvidenceCustodyReceipt) =>
    signProgressiveEvidenceCustodyReceipt(
      value,
      String(owned.remote_solver_auth_token),
    );
  await expect(
    recordProgressiveWorkerArchiveCustody(db, {}, receipt),
  ).rejects.toThrow("exact delivery");
  await expect(
    recordProgressiveWorkerArchiveCustody(
      db,
      sign({
        ...receipt,
        canonical: { ...receipt.canonical, resultAttemptId: randomUUID() },
      }),
      receipt,
    ),
  ).rejects.toThrow("retained-attempt identity");
  await expect(
    recordProgressiveWorkerArchiveCustody(db, sign(receipt), {
      ...receipt,
      source: { ...receipt.source, remoteResultId: randomUUID() },
    }),
  ).rejects.toThrow("owned retained-attempt");
  const [empty] = await db.execute(
    sql`SELECT count(*)::integer AS count FROM progressive_worker_archive_receipts WHERE sim_job_id = ${executionId}::uuid`,
  );
  expect(empty.count).toBe(0);
  const signed = sign(receipt);
  expect(
    await Promise.all([
      recordProgressiveWorkerArchiveCustody(db, signed, receipt),
      recordProgressiveWorkerArchiveCustody(db, signed, receipt),
    ]),
  ).toEqual([receipt, receipt]);
  const stored = await db.execute(
    sql`SELECT receipt FROM progressive_worker_archive_receipts WHERE sim_job_id = ${executionId}::uuid`,
  );
  expect(stored.map((entry) => entry.receipt)).toEqual([signed]);
  const rotatedToken = `isolated-rotated-custody-${randomUUID()}`;
  try {
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_auth_token = ${rotatedToken} WHERE id = 1`,
    );
    expect(
      await recordProgressiveWorkerArchiveCustody(
        db,
        signProgressiveEvidenceCustodyReceipt(receipt, rotatedToken),
        receipt,
      ),
    ).toEqual(receipt);
    await expect(
      recordProgressiveWorkerArchiveCustody(db, signed, receipt),
    ).rejects.toThrow("signature");
    const unchanged = await db.execute(
      sql`SELECT receipt FROM progressive_worker_archive_receipts WHERE sim_job_id = ${executionId}::uuid`,
    );
    expect(unchanged.map((entry) => entry.receipt)).toEqual([signed]);
  } finally {
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_auth_token = ${owned.remote_solver_auth_token} WHERE id = 1`,
    );
  }
  await expect(
    recordProgressiveWorkerArchiveCustody(
      db,
      sign({
        ...receipt,
        canonical: { ...receipt.canonical, archiveId: randomUUID() },
      }),
      receipt,
    ),
  ).rejects.toThrow("immutable receipt");
  await expect(
    db.execute(
      sql`UPDATE progressive_worker_archive_receipts SET receipt = '{}'::jsonb WHERE sim_job_id = ${executionId}::uuid`,
    ),
  ).rejects.toThrow("immutable");
  const [job] = await db.execute(sql`SELECT job.status,
    (SELECT count(*)::integer FROM sync_remote_result_deliveries delivery WHERE delivery.sim_job_id = job.id AND delivery.state = 'delivered') AS accepted_deliveries,
    (SELECT count(*)::integer FROM sync_sweep_promise_points point WHERE point.promise_id::text = job.request_payload->>'syncPromiseId' AND point.status = 'fulfilled') AS fulfilled_points
    FROM sim_jobs job WHERE job.id = ${executionId}::uuid`);
  expect(job).toMatchObject({
    status: "cancelled",
    accepted_deliveries: 0,
    fulfilled_points: 0,
  });
}
