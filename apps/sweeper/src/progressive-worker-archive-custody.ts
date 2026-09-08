import {
  analysisContentHash,
  verifyProgressiveEvidenceCustodyReceipt,
  type DB,
  type ProgressiveEvidenceCustodyReceipt,
} from "@aerodb/db";
import { sql } from "drizzle-orm";
import { progressiveWorkerEvidenceReference } from "./progressive-worker-evidence-delivery";

export async function recordProgressiveWorkerArchiveCustody(
  db: DB,
  signed: unknown,
  expected: Pick<
    ProgressiveEvidenceCustodyReceipt,
    "source" | "brokeredUploadId" | "remote"
  >,
) {
  const reference = await progressiveWorkerEvidenceReference(
    db,
    expected.source.engineJobId,
    expected.source.remoteResultAttemptId,
  );
  if (
    analysisContentHash(reference) !==
    analysisContentHash(expected.source.progressiveEvidence)
  )
    throw new Error(
      "Archive custody differs from the worker's acknowledged source report",
    );
  const [owned] = await db.execute(sql`
    SELECT retained.receipt, settings.remote_solver_auth_token, settings.remote_solver_registered_id,
      promise.id AS promise_id, attempt.result_id, attempt.aoa_deg, attempt.engine_case_slug
    FROM progressive_worker_hub_receipts retained
    JOIN result_attempts attempt ON attempt.id = retained.result_attempt_id AND attempt.sim_job_id = retained.sim_job_id
    JOIN sim_jobs job ON job.id = retained.sim_job_id
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE retained.sim_job_id = ${expected.source.engineJobId}::uuid
      AND retained.point_content_signature = ${reference.pointContentSignature}
      AND retained.result_attempt_id = ${expected.source.remoteResultAttemptId}::uuid
      AND promise.source_base_url = settings.upstream_base_url
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
  `);
  if (
    !owned ||
    !owned.remote_solver_auth_token ||
    owned.remote_solver_registered_id !== expected.source.solverId ||
    owned.promise_id !== expected.source.promiseId ||
    owned.result_id !== expected.source.remoteResultId ||
    Number(owned.aoa_deg) !== expected.source.aoaDeg ||
    owned.engine_case_slug !== expected.source.engineCaseSlug
  )
    throw new Error(
      "Archive custody requires the exact owned retained-attempt delivery",
    );
  const receipt = verifyProgressiveEvidenceCustodyReceipt(
    signed,
    String(owned.remote_solver_auth_token),
    expected,
  );
  const retained = owned.receipt as {
    resultId?: string;
    resultAttemptId?: string;
  };
  if (
    receipt.canonical.resultId !== retained.resultId ||
    receipt.canonical.resultAttemptId !== retained.resultAttemptId
  )
    throw new Error(
      "Archive custody changed the hub's retained-attempt identity",
    );
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`
      INSERT INTO progressive_worker_archive_receipts(sim_job_id, point_content_signature, brokered_upload_id, receipt)
      VALUES (${expected.source.engineJobId}::uuid, ${reference.pointContentSignature}, ${receipt.brokeredUploadId}::uuid, ${JSON.stringify(signed)}::jsonb)
      ON CONFLICT (sim_job_id, point_content_signature) DO NOTHING
    `);
    const [stored] = await transaction.execute(sql`
      SELECT receipt FROM progressive_worker_archive_receipts WHERE sim_job_id = ${expected.source.engineJobId}::uuid
        AND point_content_signature = ${reference.pointContentSignature}
    `);
    if (
      !stored ||
      analysisContentHash((stored.receipt as { receipt?: unknown }).receipt) !==
        analysisContentHash(receipt)
    )
      throw new Error("Archive custody replay changed its immutable receipt");
  });
  return receipt;
}
