import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import {
  analysisContentHash,
  progressiveRemotePointProjection,
  resolveProgressiveReportedPoint,
  verifyProgressiveRemoteExecution,
  type DB,
  type ProgressiveRemoteReport,
  type ProgressiveRemoteEvidenceReference,
} from "@aerodb/db";
import { sql } from "drizzle-orm";
import { assertProgressiveWorkerEvidenceJob } from "./progressive-remote-jobs";
import { progressiveEvidencePriority } from "./progressive-evidence-priority";

export async function recordProgressiveWorkerEvidenceReceipt(
  db: DB,
  supplied: unknown,
  expected: {
    executionId: string;
    pointContentSignature: string;
    resultId: string;
    resultAttemptId: string;
  },
) {
  const receipt = supplied as Record<string, unknown> | null;
  const uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (
    !receipt ||
    receipt.version !== 1 ||
    receipt.kind !== "retained-progressive-attempt" ||
    receipt.executionId !== expected.executionId ||
    !Number.isSafeInteger(receipt.sequence) ||
    Number(receipt.sequence) < 1 ||
    receipt.pointContentSignature !== expected.pointContentSignature ||
    receipt.remoteResultId !== expected.resultId ||
    receipt.remoteResultAttemptId !== expected.resultAttemptId ||
    typeof receipt.resultId !== "string" ||
    !uuid.test(receipt.resultId) ||
    typeof receipt.resultAttemptId !== "string" ||
    !uuid.test(receipt.resultAttemptId) ||
    typeof receipt.receivedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.receivedAt))
  )
    throw new Error("Hub did not retain the exact progressive source attempt");
  const sequence = Number(receipt.sequence);
  await db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [source] = await connection.execute(sql`
      SELECT report.report FROM progressive_worker_evidence_attempts association
      JOIN progressive_worker_reports report ON report.sim_job_id=association.sim_job_id AND report.sequence=association.sequence
      JOIN result_attempts attempt ON attempt.id=association.result_attempt_id
        AND attempt.sim_job_id=association.sim_job_id AND attempt.engine_job_id=association.sim_job_id::text
      WHERE association.sim_job_id=${expected.executionId}::uuid AND association.sequence=${sequence}
        AND association.result_attempt_id=${expected.resultAttemptId}::uuid
        AND association.point_content_signature=${expected.pointContentSignature}
        AND attempt.result_id=${expected.resultId}::uuid AND report.acknowledged_at IS NOT NULL
    `);
    if (!source)
      throw new Error(
        "Hub receipt has no acknowledged exact source association",
      );
    await assertProgressiveWorkerEvidenceJob(connection, {
      simJobId: expected.executionId,
      engineJobId: expected.executionId,
      reportSequence: sequence,
      result: (source.report as unknown as ProgressiveRemoteReport).result!,
    });
    await connection.execute(sql`
      INSERT INTO progressive_worker_hub_receipts (sim_job_id, sequence, result_attempt_id, point_content_signature, receipt)
      VALUES (${expected.executionId}::uuid, ${sequence}, ${expected.resultAttemptId}::uuid,
        ${expected.pointContentSignature}, ${JSON.stringify(receipt)}::jsonb)
      ON CONFLICT (sim_job_id, point_content_signature) DO NOTHING
    `);
    const [stored] =
      await connection.execute(sql`SELECT receipt FROM progressive_worker_hub_receipts
      WHERE sim_job_id=${expected.executionId}::uuid AND point_content_signature=${expected.pointContentSignature}`);
    if (
      !stored ||
      analysisContentHash(stored.receipt) !== analysisContentHash(receipt)
    )
      throw new Error("Hub changed its immutable progressive attempt receipt");
    await connection.execute(sql`DELETE FROM progressive_worker_delivery_failures
      WHERE sim_job_id=${expected.executionId}::uuid AND point_content_signature=${expected.pointContentSignature}`);
  });
  return receipt;
}

export async function deliverNextProgressiveWorkerEvidence(
  db: DB,
  fetcher: typeof fetch = fetch,
  selection: { preferActive?: boolean } = {},
): Promise<boolean> {
  const [pending] = await db.execute(sql`
    SELECT source.sim_job_id, source.sequence, source.result_attempt_id, source.point_content_signature,
      report.content_signature AS report_signature, report.report,
      attempt.result_id, attempt.aoa_deg, attempt.engine_case_slug, attempt.evidence_payload,
      job.request_payload, settings.upstream_base_url, settings.remote_solver_auth_token,
      settings.remote_solver_registered_id, settings.instance_id, settings.instance_name,
      promise.id AS promise_id
    FROM progressive_worker_evidence_attempts source
    JOIN progressive_worker_reports report ON report.sim_job_id = source.sim_job_id AND report.sequence = source.sequence
    JOIN result_attempts attempt ON attempt.id = source.result_attempt_id AND attempt.sim_job_id = source.sim_job_id
      AND attempt.engine_job_id = source.sim_job_id::text
    JOIN sim_jobs job ON job.id = source.sim_job_id
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    LEFT JOIN progressive_worker_hub_receipts delivered ON delivered.sim_job_id = source.sim_job_id
      AND delivered.point_content_signature = source.point_content_signature
    LEFT JOIN progressive_worker_delivery_failures failure ON failure.sim_job_id = source.sim_job_id
      AND failure.point_content_signature = source.point_content_signature
    WHERE delivered.sim_job_id IS NULL AND report.acknowledged_at IS NOT NULL AND attempt.result_id IS NOT NULL
      AND (failure.sim_job_id IS NULL OR (failure.state = 'retry' AND failure.retry_after <= clock_timestamp()))
      AND NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token <> ''
      AND settings.upstream_base_url IS NOT NULL AND job.request_payload->>'remoteSolver' = 'true'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND promise.source_base_url = settings.upstream_base_url
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
    ORDER BY ${progressiveEvidencePriority(selection.preferActive === true)},
      report.created_at, source.sim_job_id, source.sequence, attempt.aoa_deg, source.result_attempt_id LIMIT 1
  `);
  if (!pending) return false;
  const executionId = String(pending.sim_job_id);
  const sequence = Number(pending.sequence);
  const report = pending.report as unknown as ProgressiveRemoteReport;
  let responseStatus: number | null = null;
  try {
    await assertProgressiveWorkerEvidenceJob(db, {
      simJobId: executionId,
      engineJobId: executionId,
      reportSequence: sequence,
      result: report.result!,
    });
    const envelope = verifyProgressiveRemoteExecution(
      (pending.request_payload as Record<string, unknown>)
        .remoteProgressiveExecution,
      {
        solverId: String(pending.remote_solver_registered_id),
        promiseId: String(pending.promise_id),
        executionId,
        contentSignature: report.assignmentSignature,
      },
    );
    const source = resolveProgressiveReportedPoint(report.result!, {
      alpha: Number(pending.aoa_deg),
      caseSlug:
        pending.engine_case_slug == null
          ? null
          : String(pending.engine_case_slug),
      speed: envelope.request.speeds![0],
      chord: envelope.request.chord_lengths![0],
    });
    const projection = progressiveRemotePointProjection({
      ...source,
      envelope,
      report,
    });
    if (
      source.contentSignature !== pending.point_content_signature ||
      analysisContentHash(projection.evidencePayload) !==
        analysisContentHash(pending.evidence_payload)
    )
      throw new Error(
        "Worker evidence delivery differs from its immutable reported source",
      );
    const response = await fetcher(
      `${canonicalRemoteHubBaseUrl(String(pending.upstream_base_url))}/polars`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-xfoilfoam-solver-token": String(pending.remote_solver_auth_token),
        },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          promiseId: pending.promise_id,
          sourceInstanceId: pending.instance_id,
          sourceInstanceName: pending.instance_name,
          results: [
            {
              aoaDeg: source.point.aoa_deg,
              engineJobId: executionId,
              engineCaseSlug: source.point.case_slug ?? null,
              remoteResultId: pending.result_id,
              remoteResultAttemptId: pending.result_attempt_id,
              progressiveEvidence: {
                sequence,
                reportContentSignature: pending.report_signature,
                pointContentSignature: source.contentSignature,
              },
            },
          ],
        }),
      },
    );
    responseStatus = response.status;
    if (!response.ok)
      throw new Error(
        `Progressive evidence delivery failed (${response.status})`,
      );
    const body = (await response.json()) as {
      progressiveEvidenceReceipts?: unknown;
    } | null;
    const receipts = body?.progressiveEvidenceReceipts;
    const receipt =
      Array.isArray(receipts) && receipts.length === 1
        ? (receipts[0] as Record<string, unknown> | null)
        : null;
    await recordProgressiveWorkerEvidenceReceipt(db, receipt, {
      executionId,
      pointContentSignature: source.contentSignature,
      resultId: String(pending.result_id),
      resultAttemptId: String(pending.result_attempt_id),
    });
    return true;
  } catch (error) {
    const conflict = responseStatus === 409;
    await db.execute(sql`
      INSERT INTO progressive_worker_delivery_failures
        (sim_job_id, sequence, result_attempt_id, point_content_signature, state, attempt_count, retry_after, last_http_status, last_error)
      VALUES (${executionId}::uuid, ${sequence}, ${pending.result_attempt_id}::uuid, ${pending.point_content_signature},
        ${conflict ? "conflict" : "retry"}, 1, ${conflict ? sql`NULL` : sql`clock_timestamp() + interval '2 seconds'`},
        ${responseStatus}, ${error instanceof Error ? error.message : String(error)})
      ON CONFLICT (sim_job_id, point_content_signature) DO UPDATE SET
        state = excluded.state, attempt_count = progressive_worker_delivery_failures.attempt_count + 1,
        retry_after = CASE WHEN excluded.state = 'conflict' THEN NULL
          ELSE clock_timestamp() + make_interval(secs => LEAST(60, power(2, LEAST(5, progressive_worker_delivery_failures.attempt_count + 1)))::double precision) END,
        last_http_status = excluded.last_http_status, last_error = excluded.last_error, updated_at = clock_timestamp()
    `);
    throw error;
  }
}

export async function progressiveWorkerEvidenceReference(
  db: DB,
  executionId: string,
  resultAttemptId: string,
  sequence?: number,
): Promise<ProgressiveRemoteEvidenceReference> {
  if (
    sequence !== undefined &&
    (!Number.isSafeInteger(sequence) || sequence < 1)
  )
    throw new Error(
      "Progressive source requires a positive exact report sequence",
    );
  const [source] = await db.execute(sql`
    SELECT association.sequence, association.point_content_signature, report.content_signature, report.report
    FROM progressive_worker_evidence_attempts association
    JOIN progressive_worker_reports report ON report.sim_job_id = association.sim_job_id AND report.sequence = association.sequence
    JOIN result_attempts attempt ON attempt.id = association.result_attempt_id
      AND attempt.sim_job_id = association.sim_job_id AND attempt.engine_job_id = association.sim_job_id::text
    LEFT JOIN progressive_worker_hub_receipts retained ON retained.sim_job_id = association.sim_job_id
      AND retained.point_content_signature = association.point_content_signature
    WHERE association.sim_job_id = ${executionId}::uuid AND association.result_attempt_id = ${resultAttemptId}::uuid
      AND report.acknowledged_at IS NOT NULL
      AND (${sequence === undefined} OR association.sequence = ${sequence ?? 0})
    ORDER BY CASE WHEN retained.sequence = association.sequence THEN 0 ELSE 1 END, association.sequence LIMIT 1
  `);
  if (!source)
    throw new Error(
      "Progressive archive has no acknowledged exact report association",
    );
  const report = source.report as unknown as ProgressiveRemoteReport;
  await assertProgressiveWorkerEvidenceJob(db, {
    simJobId: executionId,
    engineJobId: executionId,
    reportSequence: Number(source.sequence),
    result: report.result!,
  });
  return {
    sequence: Number(source.sequence),
    reportContentSignature: String(source.content_signature),
    pointContentSignature: String(source.point_content_signature),
  };
}
