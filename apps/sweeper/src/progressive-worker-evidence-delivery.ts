import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import {
  analysisContentHash,
  progressiveRemotePointProjection,
  progressiveReportedPointSources,
  resolveProgressiveReportedPoint,
  verifyProgressiveRemoteExecution,
  type DB,
  type ProgressiveRemoteReport,
  type ProgressiveRemoteEvidenceReference,
} from "@aerodb/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { assertProgressiveWorkerEvidenceJob } from "./progressive-remote-jobs";
import { progressiveDeliverySelectionSql } from "./progressive-delivery-selection";
import { recordInactiveStoppedPromise } from "./progressive-inactive-promise";
import {
  progressiveStoppedStorageEligible,
  requeueStoppedProgressiveStorage,
} from "./progressive-stopped-storage";
import { fetchProgressiveRemote } from "./progressive-remote-http";
import { progressiveReportedDiagnosticFailureKind } from "@aerodb/db/progressive-remote-retention";

const REMOTE_EVIDENCE_DELIVERY_TIMEOUT_MS = Number(
  process.env.REMOTE_EVIDENCE_DELIVERY_TIMEOUT_MS ?? 120_000,
);
const STALE_REMOTE_OWNER_ERROR =
  "remote solver does not own this exact promise payload";

const DELIVERY_CLAIM_TIMEOUT_MS = 30_000;

async function claimNextProgressiveWorkerDelivery(
  db: DB,
  preferActive: boolean,
  claimToken: string,
) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [previous] = await connection.execute(sql`
      SELECT current_setting('statement_timeout') AS value, setting::integer AS milliseconds
      FROM pg_settings WHERE name = 'statement_timeout'
    `);
    const timeout = Math.min(Number(previous.milliseconds) || DELIVERY_CLAIM_TIMEOUT_MS, DELIVERY_CLAIM_TIMEOUT_MS);
    await connection.execute(sql`SELECT set_config('statement_timeout', ${`${timeout}ms`}, true)`);
    const rows = await connection.execute(progressiveDeliverySelectionSql(preferActive, claimToken));
    // Successful nested calls must restore their caller's setting. A failure
    // rolls back this transaction/savepoint, including its local GUC and claim.
    await connection.execute(sql`SELECT set_config('statement_timeout', ${String(previous.value)}, true)`);
    return rows;
  });
}

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
  const diagnostic = receipt?.kind === "retained-progressive-diagnostic";
  if (
    !receipt ||
    (receipt.version !== 1 && !(diagnostic && receipt.version === 2)) ||
    (diagnostic && receipt.version === 2 && !["infrastructure", "hard_solver"].includes(String(receipt.failureKind))) ||
    (!diagnostic && receipt.kind !== "retained-progressive-attempt") ||
    receipt.executionId !== expected.executionId ||
    !Number.isSafeInteger(receipt.sequence) ||
    Number(receipt.sequence) < 1 ||
    receipt.pointContentSignature !== expected.pointContentSignature ||
    (!diagnostic && (receipt.remoteResultId !== expected.resultId ||
      receipt.remoteResultAttemptId !== expected.resultAttemptId)) ||
    (diagnostic ? typeof receipt.reportContentSignature !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt.reportContentSignature) ||
      "resultId" in receipt || "resultAttemptId" in receipt
      : typeof receipt.resultId !== "string" || !uuid.test(receipt.resultId) ||
        typeof receipt.resultAttemptId !== "string" || !uuid.test(receipt.resultAttemptId)) ||
    typeof receipt.receivedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.receivedAt))
  )
    throw new Error("Hub did not retain the exact progressive source attempt");
  const sequence = Number(receipt.sequence);
  await db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [source] = await connection.execute(sql`
      SELECT association.sequence,report.report,report.content_signature,attempt.evidence_payload,job.request_payload,
        EXISTS (SELECT 1 FROM progressive_worker_reports stopped
          WHERE stopped.sim_job_id=job.id AND stopped.stopped_engine_job_id=job.id::text
            AND stopped.assignment_signature=report.assignment_signature AND stopped.acknowledged_at IS NOT NULL) AS stopped
      FROM progressive_worker_evidence_attempts association
      JOIN progressive_worker_reports report ON report.sim_job_id=association.sim_job_id AND report.sequence=association.sequence
      JOIN result_attempts attempt ON attempt.id=association.result_attempt_id
        AND attempt.sim_job_id=association.sim_job_id AND attempt.engine_job_id=association.sim_job_id::text
      JOIN sim_jobs job ON job.id=association.sim_job_id
      WHERE association.sim_job_id=${expected.executionId}::uuid AND (${diagnostic} OR association.sequence=${sequence})
        AND association.result_attempt_id=${expected.resultAttemptId}::uuid
        AND association.point_content_signature=${expected.pointContentSignature}
        AND attempt.result_id=${expected.resultId}::uuid AND report.acknowledged_at IS NOT NULL
      ORDER BY CASE WHEN association.sequence=${sequence} THEN 0 ELSE 1 END,association.sequence LIMIT 1
    `);
    if (!source)
      throw new Error(
        "Hub receipt has no acknowledged exact source association",
      );
    await assertProgressiveWorkerEvidenceJob(connection, {
      simJobId: expected.executionId,
      engineJobId: expected.executionId,
      reportSequence: Number(source.sequence),
      result: (source.report as unknown as ProgressiveRemoteReport).result!,
    });
    if (diagnostic) {
      const report = source.report as unknown as ProgressiveRemoteReport;
      const envelope = verifyProgressiveRemoteExecution((source.request_payload as Record<string, unknown>).remoteProgressiveExecution, {
        executionId: expected.executionId, solverId: report.solverId, promiseId: report.promiseId,
        contentSignature: report.assignmentSignature,
      });
      const point = progressiveReportedPointSources(report.result!).find((entry) => entry.contentSignature === expected.pointContentSignature);
      const [anchor] = await connection.execute(sql`SELECT report,content_signature FROM progressive_worker_reports
        WHERE sim_job_id=${expected.executionId}::uuid AND sequence=${sequence} AND acknowledged_at IS NOT NULL`);
      if (!anchor) throw new Error("Hub diagnostic receipt has no acknowledged source report");
      await assertProgressiveWorkerEvidenceJob(connection, {
        simJobId: expected.executionId, engineJobId: expected.executionId, reportSequence: sequence,
        result: (anchor.report as unknown as ProgressiveRemoteReport).result!,
      });
      if (!source.stopped || anchor.content_signature !== receipt.reportContentSignature ||
        !progressiveReportedPointSources((anchor.report as unknown as ProgressiveRemoteReport).result!)
          .some((entry) => entry.contentSignature === expected.pointContentSignature) || !point ||
        (receipt.version === 1 ? point.point.failure_disposition !== "material_domain" || point.point.converged !== false ||
          [point.point.cl,point.point.cd,point.point.cm].some((value) => value != null) ||
          (point.point.evidence_artifacts?.length ?? 0) > 0
          : progressiveReportedDiagnosticFailureKind(point.point) !== receipt.failureKind) ||
        analysisContentHash(progressiveRemotePointProjection({ ...point, envelope, report }).evidencePayload) !==
          analysisContentHash(source.evidence_payload))
        throw new Error("Hub diagnostic receipt differs from the exact stopped metadata-only source");
    }
    await connection.execute(sql`
      INSERT INTO progressive_worker_hub_receipts (sim_job_id, sequence, result_attempt_id, point_content_signature, receipt)
      VALUES (${expected.executionId}::uuid, ${Number(source.sequence)}, ${expected.resultAttemptId}::uuid,
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
    await connection.execute(sql`
      DELETE FROM progressive_worker_evidence_delivery_claims
      WHERE sim_job_id=${expected.executionId}::uuid
        AND point_content_signature=${expected.pointContentSignature}
    `);
  });
  return receipt;
}

export async function deliverNextProgressiveWorkerEvidence(
  db: DB,
  fetcher: typeof fetch = fetch,
  selection: { preferActive?: boolean } = {},
): Promise<boolean> {
  await requeueStoppedProgressiveStorage(db, { retryStoppedStorage: true });
  const claimToken = randomUUID();
  // The claim commits before any HTTP request. A server-side deadline releases
  // the shared evidence connection even if a future planner choice regresses.
  const [pending] = await claimNextProgressiveWorkerDelivery(
    db, selection.preferActive === true, claimToken,
  );
  if (!pending) return false;
  const executionId = String(pending.sim_job_id);
  const sequence = Number(pending.sequence);
  const report = pending.report as unknown as ProgressiveRemoteReport;
  let responseStatus: number | null = null;
  let importConflictIds: string[] = [];
  let stoppedStorage = false;
  let retryStoppedStorage = false;
  let rejected: { code?: unknown; error?: unknown } | null = null;
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
    const requestBody = JSON.stringify({
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
    });
    const post = (route: "polars" | "retained-progressive-evidence") =>
      fetchProgressiveRemote(
        fetcher,
        `${canonicalRemoteHubBaseUrl(String(pending.upstream_base_url))}/${route}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-xfoilfoam-solver-token": String(
              pending.remote_solver_auth_token,
            ),
          },
          redirect: "error",
          signal: AbortSignal.timeout(REMOTE_EVIDENCE_DELIVERY_TIMEOUT_MS),
          body: requestBody,
        },
      );
    const diagnostic = progressiveReportedDiagnosticFailureKind(source.point) !== null;
    let response = diagnostic ? await fetchProgressiveRemote(fetcher,
      `${canonicalRemoteHubBaseUrl(String(pending.upstream_base_url))}/progressive-executions/${executionId}/reports`, {
        method: "POST", headers: {
          "content-type": "application/json", "x-xfoilfoam-solver-token": String(pending.remote_solver_auth_token),
        }, redirect: "error", signal: AbortSignal.timeout(REMOTE_EVIDENCE_DELIVERY_TIMEOUT_MS),
        body: JSON.stringify({ promiseId: pending.promise_id, report, diagnostic: {
          aoaDeg: source.point.aoa_deg, engineCaseSlug: source.point.case_slug ?? null,
          remoteResultId: pending.result_id, remoteResultAttemptId: pending.result_attempt_id,
          pointContentSignature: source.contentSignature,
        } }),
      }) : await post("polars");
    responseStatus = response.status;
    if (!response.ok) {
      rejected = (await response.json().catch(() => null)) as {
        code?: unknown;
        error?: unknown;
      } | null;
      const closedScope =
        rejected?.code === "promise_inactive" ||
        rejected?.code === "progressive_scope_closed";
      if (!diagnostic && response.status === 409 && closedScope) {
        stoppedStorage = await progressiveStoppedStorageEligible(
          db,
          executionId,
        );
        if (!stoppedStorage && projection.status === "failed")
          stoppedStorage = await progressiveStoppedStorageEligible(db, executionId, {
            resultAttemptId: String(pending.result_attempt_id), pointContentSignature: source.contentSignature, sequence,
          });
        if (stoppedStorage) {
          response = await post("retained-progressive-evidence");
          responseStatus = response.status;
          rejected = response.ok
            ? null
            : ((await response.json().catch(() => null)) as {
                code?: unknown;
                error?: unknown;
              } | null);
        }
      }
    }
    if (!response.ok) {
      const responseFailureText = [rejected?.code, rejected?.error]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => String(value))
        .join(" ");
      if (response.status === 409 && !stoppedStorage) {
        retryStoppedStorage =
          !stoppedStorage && rejected?.code === "promise_inactive";
        await recordInactiveStoppedPromise(
          db,
          {
            executionId,
            promiseId: String(pending.promise_id),
            solverId: String(pending.remote_solver_registered_id),
            upstreamBaseUrl: String(pending.upstream_base_url),
            token: String(pending.remote_solver_auth_token),
          },
          { status: response.status, error: rejected?.error },
        );
      }
      throw new Error(
        `${stoppedStorage ? "Stopped progressive storage" : "Progressive evidence"} delivery failed (${response.status})${responseFailureText ? `: ${responseFailureText}` : ""}`,
      );
    }
    const responseBody = (await response.json()) as {
      progressiveEvidenceReceipts?: unknown;
      diagnosticReceipt?: unknown;
      received?: unknown;
      receipt?: { executionId?: unknown; sequence?: unknown; contentSignature?: unknown };
      conflictIds?: unknown;
    } | null;
    if (responseBody?.conflictIds !== undefined) {
      const uuid =
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
      if (
        !Array.isArray(responseBody.conflictIds) ||
        responseBody.conflictIds.length > 128 ||
        responseBody.conflictIds.some(
          (value) => typeof value !== "string" || !uuid.test(value),
        )
      )
        throw new Error(
          "Hub returned malformed progressive import conflict references",
        );
      importConflictIds = [...new Set(responseBody.conflictIds as string[])];
      if (importConflictIds.length)
        throw new Error(
          "Progressive evidence delivery requires import conflict review",
        );
    }
    const receipts = responseBody?.progressiveEvidenceReceipts;
    const retainedAttempt = Array.isArray(receipts) && receipts.length === 1
      ? (receipts[0] as Record<string, unknown> | null) : null;
    const receipt = diagnostic ? responseBody?.diagnosticReceipt ?? retainedAttempt : retainedAttempt;
    if (diagnostic && (responseBody?.received !== true || responseBody.receipt?.executionId !== executionId ||
      responseBody.receipt.sequence !== sequence || responseBody.receipt.contentSignature !== pending.report_signature ||
      !["retained-progressive-diagnostic", "retained-progressive-attempt"].includes(String((receipt as Record<string, unknown> | null)?.kind))))
      throw new Error("Hub did not acknowledge the exact retained diagnostic report and source");
    await recordProgressiveWorkerEvidenceReceipt(db, receipt, {
      executionId,
      pointContentSignature: source.contentSignature,
      resultId: String(pending.result_id),
      resultAttemptId: String(pending.result_attempt_id),
    });
    return true;
  } catch (error) {
    const responseFailureText = [rejected?.code, rejected?.error]
      .filter((value) => value !== undefined && value !== null)
      .map((value) => String(value))
      .join(" ");
    const transientTransportFailure =
      error instanceof Error &&
      (error.name === "AbortError" ||
        /aborted|timeout|timed out/i.test(error.message));
    const transientResponseFailure = /aborted|timeout|timed out/i.test(
      responseFailureText,
    );
    const conflict =
      (responseStatus === 409 &&
        !retryStoppedStorage &&
        !transientTransportFailure &&
        !transientResponseFailure) ||
      (responseStatus === 403 &&
        rejected?.error === STALE_REMOTE_OWNER_ERROR) ||
      importConflictIds.length > 0;
    await db.execute(sql`
      INSERT INTO progressive_worker_delivery_failures
        (sim_job_id, sequence, result_attempt_id, point_content_signature, state, attempt_count, retry_after, last_http_status, last_error, remote_conflict_ids)
      VALUES (${executionId}::uuid, ${sequence}, ${pending.result_attempt_id}::uuid, ${pending.point_content_signature},
        ${conflict ? "conflict" : "retry"}, 1, ${conflict ? sql`NULL` : sql`clock_timestamp() + interval '2 seconds'`},
        ${responseStatus}, ${error instanceof Error ? error.message : String(error)}, ${JSON.stringify(importConflictIds)}::jsonb)
      ON CONFLICT (sim_job_id, point_content_signature) DO UPDATE SET
        state = excluded.state, attempt_count = progressive_worker_delivery_failures.attempt_count + 1,
        retry_after = CASE WHEN excluded.state = 'conflict' THEN NULL
          ELSE clock_timestamp() + make_interval(secs => LEAST(60, power(2, LEAST(5, progressive_worker_delivery_failures.attempt_count + 1)))::double precision) END,
        last_http_status = excluded.last_http_status, last_error = excluded.last_error,
        remote_conflict_ids = excluded.remote_conflict_ids, updated_at = clock_timestamp()
    `);
    await db.execute(sql`
      DELETE FROM progressive_worker_evidence_delivery_claims
      WHERE sim_job_id=${executionId}::uuid
        AND point_content_signature=${pending.point_content_signature}
        AND claim_token=${claimToken}::uuid
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
