import { sql } from "drizzle-orm";
import { polarEvidencePublicationRank } from "@aerodb/core";
import {
  acknowledgeProgressiveCfdExecutionStop,
  canonicalAnalysisJson,
  recordProgressiveCfdRecoveryPlans,
  settleProgressiveCfdExecution,
  verifyProgressiveRemoteExecution,
  validateProgressiveRemoteReport,
  progressiveReportedPointSources,
  type DB,
  type ProgressiveRemoteExecutionEnvelope,
  type ProgressiveRansPromotion,
} from "@aerodb/db";
import { readProgressiveRemoteRetention } from "@aerodb/db/progressive-remote-retention";
import { releaseResultClaimsForJob } from "@aerodb/db/result-claim-lifecycle";
import { retireSettledProgressivePromise } from "./progressive-remote-lease-retirement";

async function settleCancelledUndeliveredExecution(
  db: DB,
  executionId: string,
  promiseId: string,
) {
  const [promise] = await db.execute(sql`SELECT status FROM sync_sweep_promises
    WHERE id = ${promiseId}::uuid FOR UPDATE`);
  if (promise?.status !== "cancelled") return null;
  const [stopped] =
    await db.execute(sql`SELECT proof FROM progressive_cfd_execution_stops
    WHERE sim_job_id = ${executionId}::uuid`);
  if (!stopped) return null;
  await acknowledgeProgressiveCfdExecutionStop(db, {
    simJobId: executionId,
    proof: stopped.proof as Parameters<
      typeof acknowledgeProgressiveCfdExecutionStop
    >[1]["proof"],
  });
  const units =
    await db.execute(sql`SELECT attempt.token,unit.id,unit.state,unit.lease_token,unit.active_seconds,unit.active_budget_seconds
    FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
    WHERE attempt.sim_job_id=${executionId}::uuid AND attempt.outcome='running'
    ORDER BY unit.id FOR UPDATE OF unit,attempt`);
  if (
    units.some(
      (unit) =>
        !(
          (unit.state === "leased" && unit.lease_token === unit.token) ||
          (unit.state === "blocked" &&
            unit.lease_token === null &&
            Number(unit.active_seconds) >= Number(unit.active_budget_seconds))
        ),
    )
  )
    throw new Error(
      "Cancelled remote execution no longer owns its pending units",
    );
  for (const unit of units) {
    await db.execute(sql`UPDATE progressive_cfd_attempts SET outcome='cancelled',finished_at=clock_timestamp(),
      error='Scheduling promise cancelled before evidence delivery; retained reports remain unresolved'
      WHERE token=${unit.token}::uuid`);
    await db.execute(sql`UPDATE progressive_cfd_units SET state='gap',lease_token=NULL,lease_owner=NULL,lease_until=NULL,
      error='Cancelled remote delivery has unresolved evidence' WHERE id=${unit.id}::uuid`);
  }
  await db.execute(sql`UPDATE sim_jobs SET status='cancelled',"finishedAt"=coalesce("finishedAt",clock_timestamp()),
    error='Scheduling promise cancelled; evidence delivery remains unresolved'
    WHERE id=${executionId}::uuid`);
  await releaseResultClaimsForJob(db, executionId, ["queued", "running"]);
  return {
    kind: "settled" as const,
    counts: {
      complete: 0,
      retry: 0,
      gaps: units.length,
      cancelled: 0,
      waiting: 0,
    },
    evidencePending: true,
  };
}
import { validateRansPrecalcPromotionSignal } from "./ingest";

type RetainedExecution = Extract<
  Awaited<ReturnType<typeof readProgressiveRemoteRetention>>,
  { kind: "retained" }
>;

async function recoveryPromotions(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
  retained: RetainedExecution,
): Promise<ProgressiveRansPromotion[]> {
  const reports =
    await db.execute(sql`SELECT DISTINCT ON (report#>'{result,polars,0,rans_precalc_promotion}')
      report, content_signature FROM progressive_remote_reports
    WHERE sim_job_id = ${envelope.scope.executionId}::uuid
      AND report#>'{result,polars,0,rans_precalc_promotion}' IS NOT NULL
      AND report#>'{result,polars,0,rans_precalc_promotion}' <> 'null'::jsonb
    ORDER BY report#>'{result,polars,0,rans_precalc_promotion}', sequence LIMIT 2`);
  if (reports.length > 1)
    throw new Error("Remote execution has competing RANS promotion scopes");
  if (!reports.length) return [];
  const validated = validateProgressiveRemoteReport(
    reports[0].report,
    envelope,
  );
  if (validated.contentSignature !== reports[0].content_signature)
    throw new Error("Remote RANS promotion has changed report bytes");
  const polar = validated.report.result!.polars[0];
  const promotion = polar.rans_precalc_promotion!;
  const attempts = new Map(
    (polar.attempts ?? []).map((point) => [point.aoa_deg, point]),
  );
  const trigger = attempts.get(promotion.trigger_aoa_deg);
  const scope = validateRansPrecalcPromotionSignal({
    promotion,
    stagedAttemptAoas: [...attempts.keys()],
    triggerFailureDisposition: trigger?.failure_disposition ?? null,
    jobAoas: envelope.request.aoa?.angles ?? [],
  });
  if (!trigger || !scope)
    throw new Error(
      "Remote RANS promotion changed its exact attempt and omission scope",
    );
  const [source] = progressiveReportedPointSources({
    ...validated.report.result!,
    polars: [{ ...polar, points: [], attempts: [trigger] }],
  });
  const receipt = retained.sources.find(
    (item) =>
      item.delivery.progressiveEvidence.pointContentSignature ===
      source.contentSignature,
  );
  if (!receipt)
    throw new Error("Remote RANS promotion has no retained exact trigger");
  const [revision] =
    await db.execute(sql`SELECT simulation_preset_revision_id FROM result_attempts
    WHERE id = ${receipt.resultAttemptId}::uuid AND sim_job_id = ${envelope.scope.executionId}::uuid`);
  if (!revision?.simulation_preset_revision_id)
    throw new Error("Remote RANS promotion has no executed setup revision");
  return [
    {
      revisionId: String(revision.simulation_preset_revision_id),
      triggerResultAttemptId: receipt.resultAttemptId,
      triggerAoaDeg: promotion.trigger_aoa_deg,
      ...scope,
    },
  ];
}

export async function settleProgressiveRemoteJob(db: DB, executionId: string) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [dispatch] =
      await connection.execute(sql`SELECT envelope, solver_id, promise_id, content_signature
      FROM progressive_remote_dispatches WHERE sim_job_id = ${executionId}::uuid`);
    if (!dispatch) throw new Error("Remote settlement has no exact dispatch");
    const envelope = verifyProgressiveRemoteExecution(dispatch.envelope, {
      executionId,
      solverId: String(dispatch.solver_id),
      promiseId: String(dispatch.promise_id),
      contentSignature: String(dispatch.content_signature),
    });
    await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE id = ${envelope.scope.epochId}::uuid FOR SHARE`,
    );
    await connection.execute(sql`SELECT campaign.id FROM sim_campaigns campaign JOIN sim_jobs job ON job.campaign_id = campaign.id
      WHERE job.id = ${executionId}::uuid FOR UPDATE OF campaign`);
    const [job] =
      await connection.execute(sql`SELECT engine_job_id, request_payload, status, "ingestedAt",
        ingest_lease_expires_at > clock_timestamp() AS ingestion_owned
      FROM sim_jobs WHERE id = ${executionId}::uuid FOR UPDATE`);
    if (
      !job ||
      job.engine_job_id !== executionId ||
      canonicalAnalysisJson(
        (job.request_payload as Record<string, unknown>).engineRequest,
      ) !== canonicalAnalysisJson(envelope.request) ||
      canonicalAnalysisJson(
        (job.request_payload as Record<string, unknown>).progressive,
      ) !== canonicalAnalysisJson(envelope.scope)
    )
      throw new Error(
        "Remote settlement differs from immutable execution ownership",
      );
    if (job.ingestion_owned)
      return { kind: "waiting" as const, reason: "ingestion_owner" };
    const [pending] =
      await connection.execute(sql`SELECT sequence FROM progressive_remote_reports report
      WHERE sim_job_id = ${executionId}::uuid AND NOT EXISTS (SELECT 1 FROM progressive_remote_progress_receipts receipt
        WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence) LIMIT 1`);
    if (pending) return { kind: "waiting" as const, reason: "report_progress" };
    const [stop] = await connection.execute(
      sql`SELECT sim_job_id FROM progressive_cfd_execution_stops WHERE sim_job_id = ${executionId}::uuid`,
    );
    if (!stop) return { kind: "waiting" as const, reason: "physical_stop" };
    if (job.ingestedAt) {
      await retireSettledProgressivePromise(connection, executionId);
      return {
        kind: "settled" as const,
        counts: await settleProgressiveCfdExecution(connection, executionId),
      };
    }
    const [scope] = await connection.execute(sql`SELECT EXISTS (
      SELECT 1 FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
      JOIN progressive_work work ON work.id = unit.work_id JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      WHERE attempt.sim_job_id = ${executionId}::uuid AND epoch.current AND generation.status = 'active' AND generation.stage = work.stage
        AND generation.plan_revision_id = campaign.current_plan_revision_id AND campaign.status IN ('active', 'attention', 'paused')
      ) AS current_scope`);
    if (!scope.current_scope) {
      await connection.execute(sql`UPDATE sim_jobs SET status = 'cancelled', "finishedAt" = coalesce("finishedAt", clock_timestamp())
        WHERE id = ${executionId}::uuid`);
      await releaseResultClaimsForJob(connection, executionId, [
        "queued",
        "running",
      ]);
      await retireSettledProgressivePromise(connection, executionId);
      return {
        kind: "settled" as const,
        counts: await settleProgressiveCfdExecution(connection, executionId),
      };
    }
    const retained = await readProgressiveRemoteRetention(
      connection,
      executionId,
    );
    if (retained.kind === "waiting") {
      if (retained.reason === "raw_evidence") {
        const cancelled = await settleCancelledUndeliveredExecution(
          connection,
          executionId,
          String(dispatch.promise_id),
        );
        if (cancelled) return cancelled;
      }
      return retained;
    }
    const result = retained.report.result;
    const finalPoints = new Set(
      result
        ? progressiveReportedPointSources({
            ...result,
            polars: result.polars.map((polar) => ({ ...polar, attempts: [] })),
          }).map((source) => source.contentSignature)
        : [],
    );
    const finalAttemptIds = retained.sources
      .filter((source) =>
        finalPoints.has(
          source.delivery.progressiveEvidence.pointContentSignature,
        ),
      )
      .map((source) => source.resultAttemptId);
    if (finalAttemptIds.length) {
      const unpublished =
        await connection.execute(sql`SELECT raw.id, raw.regime, raw.evidence_payload->>'fidelity' AS fidelity,
          selected.regime AS selected_regime, selected.evidence_payload->>'fidelity' AS selected_fidelity,
          (selected.status = 'done' AND selected.valid_for_polar AND selected_class.state = 'accepted') AS selected_accepted
        FROM result_attempts raw
        JOIN result_classifications classification ON classification.result_attempt_id = raw.id
        JOIN results result ON result.id = raw.result_id
        LEFT JOIN result_attempts selected ON selected.id = result.current_result_attempt_id AND selected.result_id = result.id
        LEFT JOIN result_classifications selected_class ON selected_class.result_attempt_id = selected.id
        WHERE raw.id IN (${sql.join(
          finalAttemptIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          AND raw.status = 'done' AND raw.valid_for_polar AND classification.state = 'accepted'
          AND coalesce((SELECT review.verdict FROM result_review_verdicts review WHERE review.result_id = result.id
            AND review."revokedAt" IS NULL ORDER BY review."createdAt" DESC, review.id DESC LIMIT 1), '') NOT IN ('exclude', 'defer')
          AND result.current_result_attempt_id IS DISTINCT FROM raw.id`);
      if (
        unpublished.some(
          (source) =>
            source.selected_accepted !== true ||
            polarEvidencePublicationRank(
              "accepted",
              source.selected_fidelity as string | null,
              source.selected_regime as "rans" | "urans" | null,
            ) <=
              polarEvidencePublicationRank(
                "accepted",
                source.fidelity as string | null,
                source.regime as "rans" | "urans" | null,
              ),
        )
      )
        return {
          kind: "waiting" as const,
          reason: "accepted_point_publication",
        };
    }
    await acknowledgeProgressiveCfdExecutionStop(connection, {
      simJobId: executionId,
      proof: retained.report.stopProof!,
    });
    await recordProgressiveCfdRecoveryPlans(
      connection,
      executionId,
      await recoveryPromotions(connection, envelope, retained),
    );
    const status = retained.report.status;
    await connection.execute(sql`UPDATE sim_jobs SET status = CASE WHEN status = 'cancelled' THEN status
        ELSE ${status.state === "completed" ? "done" : status.state === "cancelled" ? "cancelled" : "failed"}::sim_job_status END,
      engine_state = ${status.state}, completed_cases = ${status.completed_cases}, total_cases = ${status.total_cases},
      "ingestedAt" = clock_timestamp(), "finishedAt" = clock_timestamp(), "updatedAt" = clock_timestamp(),
      error = ${status.state === "completed" ? null : (status.message ?? "Remote execution stopped")},
      ingest_lease_token = NULL, ingest_lease_claimed_at = NULL, ingest_lease_expires_at = NULL
      WHERE id = ${executionId}::uuid`);
    await releaseResultClaimsForJob(connection, executionId, [
      "queued",
      "running",
    ]);
    await retireSettledProgressivePromise(connection, executionId);
    return {
      kind: "settled" as const,
      counts: await settleProgressiveCfdExecution(connection, executionId),
    };
  });
}
