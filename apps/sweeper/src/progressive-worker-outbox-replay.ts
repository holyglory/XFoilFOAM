import { resolveStoredProgressiveReport } from "@aerodb/db/progressive-report-reader";
import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import {
  analysisContentHash,
  canonicalAnalysisJson,
  isFinalProgressiveRemoteReport,
  progressiveRemotePointProjection,
  resolveProgressiveReportedPoint,
  validateProgressiveRemoteReport,
  verifyProgressiveRemoteExecution,
  type DB,
} from "@aerodb/db";
import { sql } from "drizzle-orm";
import { configuredDeploymentRole } from "./config";
import { loadAttemptSourcePins, prepareAttemptSources, assertAttemptSourcePins } from "@aerodb/db/attempt-receipt-source";
import { sweeperAttemptArchiveReader } from "./attempt-evidence-consumer-reader";
import { workerEvidenceStorageColumns } from "./progressive-delivery-selection";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SIGNATURE = /^[a-f0-9]{64}$/;
const SCOPE_CLOSED =
  /^(?:Progressive evidence|Stopped progressive storage) delivery failed \(409\): progressive_scope_closed(?: |$)/;

export class ProgressiveWorkerOutboxReplayRefused extends Error {}
export class ProgressiveWorkerReplayNeedsFinalReport extends ProgressiveWorkerOutboxReplayRefused {}
export class ProgressiveWorkerTransferPaused extends ProgressiveWorkerOutboxReplayRefused {}

export interface ProgressiveWorkerOutboxReplayPoint {
  pointContentSignature: string;
  resultAttemptId: string;
  sequence: number;
}

export interface ProgressiveWorkerOutboxReplayInput {
  executionId: string;
  points: ProgressiveWorkerOutboxReplayPoint[];
  expectedCount?: number;
  manifestSignature?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseProgressiveWorkerOutboxReplayInput(
  value: unknown,
): ProgressiveWorkerOutboxReplayInput {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "executionId",
          "points",
          "expectedCount",
          "manifestSignature",
        ].includes(key),
    ) ||
    typeof value.executionId !== "string" ||
    !UUID.test(value.executionId) ||
    !Array.isArray(value.points) ||
    value.points.length < 1 ||
    value.points.length > 64 ||
    (value.expectedCount === undefined && value.manifestSignature === undefined)
  )
    throw new ProgressiveWorkerOutboxReplayRefused(
      "Replay requires an exact execution, 1..64 points, and expectedCount or manifestSignature",
    );
  if (
    value.expectedCount !== undefined &&
    value.expectedCount !== value.points.length
  )
    throw new ProgressiveWorkerOutboxReplayRefused(
      "Replay expectedCount differs from the exact selection",
    );
  if (
    value.manifestSignature !== undefined &&
    (typeof value.manifestSignature !== "string" ||
      !SIGNATURE.test(value.manifestSignature))
  )
    throw new ProgressiveWorkerOutboxReplayRefused(
      "Replay manifestSignature must be a SHA-256 signature",
    );
  const signatures = new Set<string>();
  const attempts = new Set<string>();
  const points = value.points.map((point) => {
    if (
      !record(point) ||
      Object.keys(point).length !== 3 ||
      typeof point.pointContentSignature !== "string" ||
      !SIGNATURE.test(point.pointContentSignature) ||
      typeof point.resultAttemptId !== "string" ||
      !UUID.test(point.resultAttemptId) ||
      !Number.isSafeInteger(point.sequence) ||
      Number(point.sequence) < 1 ||
      signatures.has(point.pointContentSignature) ||
      attempts.has(point.resultAttemptId)
    )
      throw new ProgressiveWorkerOutboxReplayRefused(
        "Replay points require unique exact signatures, attempt IDs, and positive safe sequences",
      );
    signatures.add(point.pointContentSignature);
    attempts.add(point.resultAttemptId);
    return {
      pointContentSignature: point.pointContentSignature,
      resultAttemptId: point.resultAttemptId,
      sequence: Number(point.sequence),
    };
  });
  return {
    executionId: value.executionId,
    points: points.sort((left, right) =>
      left.pointContentSignature.localeCompare(right.pointContentSignature),
    ),
    ...(value.expectedCount === undefined
      ? {}
      : { expectedCount: Number(value.expectedCount) }),
    ...(value.manifestSignature === undefined
      ? {}
      : { manifestSignature: String(value.manifestSignature) }),
  };
}

export async function replayProgressiveWorkerOutbox(
  db: DB,
  supplied: ProgressiveWorkerOutboxReplayInput,
  options: { apply?: boolean } = {},
) {
  const input = parseProgressiveWorkerOutboxReplayInput(supplied);
  if (configuredDeploymentRole() !== "remote-solver")
    throw new ProgressiveWorkerOutboxReplayRefused(
      "Worker outbox replay requires the current remote-solver deployment role",
    );
  const manifestSignature = analysisContentHash({
    version: 1,
    kind: "progressive-worker-outbox-replay",
    executionId: input.executionId,
    points: input.points,
  });
  if (
    input.manifestSignature !== undefined &&
    input.manifestSignature !== manifestSignature
  )
    throw new ProgressiveWorkerOutboxReplayRefused(
      "Replay manifest signature differs from the exact selection",
    );

  const selectedIds = sql.join(input.points.map((p) => sql`${p.resultAttemptId}::uuid`),sql`,`);
  const columns = await workerEvidenceStorageColumns(db);
  const cold = columns.attempts ? await db.execute(sql`SELECT id FROM result_attempts WHERE id IN (${selectedIds})
    AND sim_job_id=${input.executionId}::uuid AND engine_job_id=${input.executionId}
    AND evidence_archive_id IS NOT NULL`) : [];
  const pins = await loadAttemptSourcePins(db,cold.map((row) => String(row.id)));
  const prepared = await prepareAttemptSources(db,sweeperAttemptArchiveReader(),[...pins.values()],{signal:AbortSignal.timeout(30_000)});
  const archivedReports = columns.reports ? await db.execute(sql`SELECT r.sequence,r.report,r.content_signature FROM progressive_worker_reports r
    WHERE r.sim_job_id=${input.executionId}::uuid AND r.sequence IN (${sql.join(input.points.map(p=>sql`${p.sequence}::bigint`),sql`,`)})
    AND r.archived_at IS NOT NULL AND r.acknowledged_at IS NOT NULL`) : [];
  const reports = new Map<string,Awaited<ReturnType<typeof resolveStoredProgressiveReport>>>();
  for (const row of archivedReports) reports.set(String(row.content_signature),await resolveStoredProgressiveReport(db,"worker",row,input.executionId));
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await connection.execute(sql`SET LOCAL statement_timeout = '10s'`);
    const [owner] = await connection.execute(sql`
      SELECT settings.remote_solver_registered_id, settings.upstream_base_url, settings.remote_solver_transfer_paused AS paused,
        job.request_payload, job.airfoil_id, job.bc_ids, job.simulation_preset_revision_id,
        job.engine_job_id, promise.id AS promise_id, intent.assignment_signature,
        intent.authorization,
        (job.ingest_lease_token IS NOT NULL AND
          (job.ingest_lease_expires_at IS NULL OR job.ingest_lease_expires_at > clock_timestamp())) AS ingest_claim_active
      FROM sync_api_settings settings
      JOIN registered_remote_solvers solver ON solver.id = settings.remote_solver_registered_id
        AND solver.instance_id = settings.instance_id::text AND solver.revoked_at IS NULL
      JOIN sim_jobs job ON job.id = ${input.executionId}::uuid
      JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
        AND promise.registered_solver_id = solver.id
        AND promise.source_base_url = settings.upstream_base_url
        AND promise.airfoil_id = job.airfoil_id
        AND promise.simulation_preset_revision_id = job.simulation_preset_revision_id
      JOIN progressive_worker_submission_intents intent ON intent.sim_job_id = job.id
      WHERE settings.id = 1 AND settings.remote_solver_enabled
        AND btrim(settings.remote_solver_auth_token) <> ''
        AND job.request_payload->>'remoteSolver' = 'true'
        AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
        AND jsonb_typeof(job.bc_ids) = 'array'
        AND jsonb_array_length(job.bc_ids) = 1
        AND jsonb_typeof(job.bc_ids->0) = 'string'
      FOR SHARE OF settings, solver, promise, intent
      FOR UPDATE OF job
    `);
    if (
      !owner ||
      owner.ingest_claim_active ||
      owner.engine_job_id !== input.executionId
    )
      throw new ProgressiveWorkerOutboxReplayRefused(
        "Replay has no exact current worker owner or has an active ingest claim",
      );
    const payload = owner.request_payload as Record<string, unknown>;
    if (
      !Array.isArray(owner.bc_ids) ||
      owner.bc_ids.length !== 1 ||
      typeof owner.bc_ids[0] !== "string" ||
      !UUID.test(owner.bc_ids[0])
    )
      throw new ProgressiveWorkerOutboxReplayRefused(
        "Replay requires exactly one valid owned boundary condition",
      );
    const boundaryConditionId = owner.bc_ids[0];
    if (
      canonicalRemoteHubBaseUrl(String(owner.upstream_base_url)) !==
      owner.upstream_base_url
    )
      throw new ProgressiveWorkerOutboxReplayRefused(
        "Replay upstream differs from the original canonical hub",
      );
    const envelope = verifyProgressiveRemoteExecution(
      payload.remoteProgressiveExecution,
      {
        solverId: String(owner.remote_solver_registered_id),
        promiseId: String(owner.promise_id),
        executionId: input.executionId,
        contentSignature: String(owner.assignment_signature),
      },
    );
    if (
      canonicalAnalysisJson(payload.engineRequest) !==
        canonicalAnalysisJson(envelope.request) ||
      !record(owner.authorization) ||
      owner.authorization.kind !== "authorized" ||
      owner.authorization.executionId !== input.executionId ||
      owner.authorization.contentSignature !== envelope.contentSignature
    )
      throw new ProgressiveWorkerOutboxReplayRefused(
        "Replay request differs from its immutable submission authorization",
      );

    if (owner.paused === true)
      throw new ProgressiveWorkerTransferPaused("Worker transfers are paused");
    if (owner.paused !== false)
      throw new ProgressiveWorkerOutboxReplayRefused("Worker transfer state unavailable");

    const points: (ProgressiveWorkerOutboxReplayPoint & {
      outcome: "would_requeue" | "requeued" | "already_delivered";
    })[] = [];
    for (const point of input.points) {
      const [source] = await connection.execute(sql`
        SELECT resolve_progressive_report(to_jsonb(report.*)) AS report, report.content_signature,${columns.reports ? sql`report.archived_at` : sql`NULL::timestamptz`} AS archived_at,
          staged.content_signature AS staged_signature,
          ${columns.attempts ? sql`attempt.evidence_archive_id,attempt.evidence_storage_event_id` : sql`NULL::uuid AS evidence_archive_id,NULL::uuid AS evidence_storage_event_id`},attempt.evidence_payload,
          jsonb_build_object('result_id',attempt.result_id,'airfoil_id',attempt.airfoil_id,
            'bc_id',attempt.bc_id,'simulation_preset_revision_id',attempt.simulation_preset_revision_id,
            'aoa_deg',attempt.aoa_deg,'engine_case_slug',attempt.engine_case_slug,'cl',attempt.cl,'cd',attempt.cd,
            'cm',attempt.cm,'converged',attempt.converged,'unsteady',attempt.unsteady) AS attempt,
          jsonb_build_object('airfoil_id',result.airfoil_id,'bc_id',result.bc_id,
            'simulation_preset_revision_id',result.simulation_preset_revision_id,'aoa_deg',result.aoa_deg,
            'reynolds',result.reynolds,'speed',result.speed,'chord',result.chord,'mach',result.mach) AS result
        FROM progressive_worker_evidence_attempts association
        JOIN progressive_worker_reports report ON report.sim_job_id = association.sim_job_id
          AND report.sequence = association.sequence AND report.acknowledged_at IS NOT NULL
        JOIN progressive_worker_evidence_receipts staged ON staged.sim_job_id = association.sim_job_id
          AND staged.sequence = association.sequence
        JOIN result_attempts attempt ON attempt.id = association.result_attempt_id
          AND attempt.sim_job_id = association.sim_job_id AND attempt.engine_job_id = association.sim_job_id::text
        JOIN results result ON result.id = attempt.result_id
        WHERE association.sim_job_id = ${input.executionId}::uuid AND association.sequence = ${point.sequence}
          AND association.result_attempt_id = ${point.resultAttemptId}::uuid
          AND association.point_content_signature = ${point.pointContentSignature}
          AND NOT EXISTS (SELECT 1 FROM progressive_worker_report_conflicts conflict
            WHERE conflict.sim_job_id = association.sim_job_id AND conflict.sequence = association.sequence)
        FOR UPDATE OF association
        FOR SHARE OF report, staged, attempt, result
      `);
      if (!source)
        throw new ProgressiveWorkerOutboxReplayRefused(
          "Replay has no acknowledged exact stored source association",
        );
      const body = source.archived_at ? reports.get(String(source.content_signature))
        : await resolveStoredProgressiveReport(connection, "worker", source, input.executionId);
      if (!body) throw new ProgressiveWorkerOutboxReplayRefused("Worker report storage changed during replay preparation");
      const validated = validateProgressiveRemoteReport(body, envelope);
      const report = validated.report;
      if (
        report.sequence !== point.sequence ||
        validated.contentSignature !== source.content_signature ||
        validated.contentSignature !== source.staged_signature ||
        report.result === null
      )
        throw new ProgressiveWorkerOutboxReplayRefused(
          "Replay requires its unchanged acknowledged final report and staging receipt",
        );
      if (!isFinalProgressiveRemoteReport(report))
        throw new ProgressiveWorkerReplayNeedsFinalReport(
          "Replay requires its unchanged acknowledged final report and staging receipt",
        );
      const attempt = source.attempt as Record<string, unknown>;
      const result = source.result as Record<string, unknown>;
      const full = prepared.get(point.resultAttemptId);
      if ((source.evidence_archive_id ?? null) !== (full?.pin.archiveId ?? null) ||
          (full && source.evidence_storage_event_id !== full.pin.storageEventId))
        throw new ProgressiveWorkerOutboxReplayRefused("Worker attempt storage changed during replay preparation");
      if (full) await assertAttemptSourcePins(connection, [full.pin]);
      const reported = resolveProgressiveReportedPoint(report.result, {
        alpha: Number(attempt.aoa_deg),
        caseSlug: attempt.engine_case_slug as string | null,
        speed: envelope.request.speeds![0],
        chord: envelope.request.chord_lengths![0],
      });
      const projection = progressiveRemotePointProjection({
        ...reported,
        envelope,
        report,
      });
      if (
        reported.contentSignature !== point.pointContentSignature ||
        analysisContentHash(projection.evidencePayload) !==
          analysisContentHash(full ? full.payload : source.evidence_payload) ||
        [attempt, result].some(
          (row) =>
            row.airfoil_id !== owner.airfoil_id ||
            row.bc_id !== boundaryConditionId ||
            row.simulation_preset_revision_id !==
              owner.simulation_preset_revision_id ||
            row.aoa_deg !== projection.aoaDeg,
        ) ||
        Number(result.reynolds) !== Math.round(projection.reynolds) ||
        result.speed !== projection.speed ||
        result.chord !== projection.chord ||
        (projection.mach !== null && result.mach !== projection.mach) ||
        attempt.cl !== projection.cl ||
        attempt.cd !== projection.cd ||
        attempt.cm !== projection.cm ||
        attempt.converged !== projection.converged ||
        attempt.unsteady !== projection.unsteady
      )
        throw new ProgressiveWorkerOutboxReplayRefused(
          "Replay local attempt or physical source differs from its immutable reported point",
        );

      const claims = await connection.execute(sql`
        SELECT claim_token, claim_expires_at,
          (claim_expires_at IS NULL OR claim_expires_at > clock_timestamp()) AS active
        FROM progressive_worker_evidence_delivery_claims
        WHERE sim_job_id = ${input.executionId}::uuid AND point_content_signature = ${point.pointContentSignature}
        FOR UPDATE
      `);
      if (claims.some((claim) => claim.active))
        throw new ProgressiveWorkerOutboxReplayRefused(
          "Replay point has an active delivery claim",
        );
      const [receipt] = await connection.execute(sql`
        SELECT sequence, result_attempt_id, receipt FROM progressive_worker_hub_receipts
        WHERE sim_job_id = ${input.executionId}::uuid AND point_content_signature = ${point.pointContentSignature}
        FOR SHARE
      `);
      if (receipt) {
        const retained = receipt.receipt;
        if (
          Number(receipt.sequence) !== point.sequence ||
          receipt.result_attempt_id !== point.resultAttemptId ||
          !record(retained) ||
          retained.version !== 1 ||
          retained.kind !== "retained-progressive-attempt" ||
          retained.executionId !== input.executionId ||
          retained.sequence !== point.sequence ||
          retained.pointContentSignature !== point.pointContentSignature ||
          retained.remoteResultId !== attempt.result_id ||
          retained.remoteResultAttemptId !== point.resultAttemptId ||
          typeof retained.resultId !== "string" ||
          !UUID.test(retained.resultId) ||
          typeof retained.resultAttemptId !== "string" ||
          !UUID.test(retained.resultAttemptId) ||
          typeof retained.receivedAt !== "string" ||
          !Number.isFinite(Date.parse(retained.receivedAt))
        )
          throw new ProgressiveWorkerOutboxReplayRefused(
            "Replay hub receipt differs from the selected immutable source",
          );
        points.push({ ...point, outcome: "already_delivered" });
        continue;
      }
      const [failure] = await connection.execute(sql`
        SELECT sequence, result_attempt_id, state, attempt_count, last_http_status, last_error, remote_conflict_ids
        FROM progressive_worker_delivery_failures
        WHERE sim_job_id = ${input.executionId}::uuid AND point_content_signature = ${point.pointContentSignature}
        FOR UPDATE
      `);
      const staleFailure = failure && Number(failure.sequence) < point.sequence;
      const exactFailure =
        failure &&
        Number(failure.sequence) === point.sequence &&
        failure.result_attempt_id === point.resultAttemptId;
      if (
        !failure ||
        (!exactFailure && !staleFailure) ||
        failure.state !== "conflict" ||
        failure.last_http_status !== 409 ||
        !SCOPE_CLOSED.test(String(failure.last_error)) ||
        !Array.isArray(failure.remote_conflict_ids) ||
        failure.remote_conflict_ids.length !== 0
      )
        throw new ProgressiveWorkerOutboxReplayRefused(
          "Replay requires an exact 409 progressive_scope_closed conflict without import conflicts",
        );
      points.push({
        ...point,
        outcome: options.apply === true ? "requeued" : "would_requeue",
      });
    }
    if (options.apply === true) {
      for (const point of points.filter(
        (selected) => selected.outcome === "requeued",
      )) {
        const updated = await connection.execute(sql`
          UPDATE progressive_worker_delivery_failures
          SET sequence = ${point.sequence}, result_attempt_id = ${point.resultAttemptId}::uuid,
            state = 'retry', retry_after = clock_timestamp()
          WHERE sim_job_id = ${input.executionId}::uuid
            AND point_content_signature = ${point.pointContentSignature}
            AND state = 'conflict'
            AND (sequence = ${point.sequence} AND result_attempt_id = ${point.resultAttemptId}::uuid
              OR sequence < ${point.sequence})
          RETURNING point_content_signature
        `);
        if (updated.length !== 1)
          throw new ProgressiveWorkerOutboxReplayRefused(
            "Replay selection changed before requeue",
          );
      }
    }
    return {
      executionId: input.executionId,
      mode: options.apply === true ? "apply" : "dry-run",
      manifestSignature,
      selectedCount: points.length,
      requeuedCount: points.filter((point) => point.outcome === "requeued")
        .length,
      points,
    };
  });
}
