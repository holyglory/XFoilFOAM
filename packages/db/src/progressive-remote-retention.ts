import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash } from "./analysis-target";
import { readProgressiveEvidenceCustodyReceipt } from "./progressive-evidence-custody";
import { resolveProgressiveRemoteEvidence } from "./progressive-remote-evidence";
import type { ProgressiveRemoteEvidenceDelivery } from "./progressive-remote-evidence-receipts";
import {
  isFinalProgressiveRemoteReport,
  validateProgressiveRemoteReport,
} from "./progressive-remote-report";
import type { ProgressiveRemoteExecutionEnvelope } from "./progressive-remote-execution";

export async function readProgressiveRemoteRetention(
  db: DB,
  executionId: string,
) {
  const [latest] =
    await db.execute(sql`SELECT report.report, report.sequence, report.content_signature,
      dispatch.envelope FROM progressive_remote_dispatches dispatch
    JOIN LATERAL (SELECT report, sequence, content_signature FROM progressive_remote_reports
      WHERE sim_job_id = dispatch.sim_job_id ORDER BY sequence DESC LIMIT 1) report ON true
    WHERE dispatch.sim_job_id = ${executionId}::uuid`);
  if (!latest)
    return { kind: "waiting" as const, reason: "final_report" as const };
  const { report, contentSignature } = validateProgressiveRemoteReport(
    latest.report,
    latest.envelope as ProgressiveRemoteExecutionEnvelope,
  );
  if (contentSignature !== latest.content_signature)
    throw new Error("Remote retention has changed final report bytes");
  if (!isFinalProgressiveRemoteReport(report))
    return { kind: "waiting" as const, reason: "final_report" as const };
  const [missingInventory] =
    await db.execute(sql`SELECT report.sequence FROM progressive_remote_reports report
    LEFT JOIN progressive_remote_report_inventories inventory USING (sim_job_id, sequence)
    WHERE report.sim_job_id = ${executionId}::uuid AND report.sequence <= ${report.sequence}
      AND (inventory.sequence IS NULL OR inventory.report_content_signature <> report.content_signature
        OR inventory.source_count <> (SELECT count(*) FROM progressive_remote_report_sources source
          WHERE source.sim_job_id = inventory.sim_job_id AND source.sequence = inventory.sequence)) LIMIT 1`);
  if (missingInventory)
    return { kind: "waiting" as const, reason: "source_inventory" as const };
  const sources =
    await db.execute(sql`SELECT DISTINCT source.point_content_signature, source.aoa_deg, source.case_slug,
      receipt.sequence, receipt.remote_result_id, receipt.remote_result_attempt_id, receipt.result_attempt_id,
      owned_report.content_signature AS report_content_signature, raw.evidence_payload, evidence.evidence_signature
    FROM progressive_remote_report_sources source
    LEFT JOIN progressive_remote_evidence_receipts receipt
      ON receipt.sim_job_id = source.sim_job_id AND receipt.point_content_signature = source.point_content_signature
    LEFT JOIN progressive_remote_reports owned_report ON owned_report.sim_job_id = receipt.sim_job_id
      AND owned_report.sequence = receipt.sequence
    LEFT JOIN result_attempts raw ON raw.id = receipt.result_attempt_id
    LEFT JOIN progressive_cfd_evidence evidence ON evidence.result_attempt_id = raw.id
    WHERE source.sim_job_id = ${executionId}::uuid AND source.sequence <= ${report.sequence}
    ORDER BY source.point_content_signature LIMIT 2049`);
  if (sources.length > 2048)
    throw new Error(
      "Remote retention exceeds the bounded source-attempt inventory",
    );
  const missingEvidence = sources.filter(
    (source) => source.result_attempt_id == null,
  ).length;
  if (missingEvidence)
    return {
      kind: "waiting" as const,
      reason: "raw_evidence" as const,
      sourceCount: sources.length,
      pendingCount: missingEvidence,
    };
  const retained: Array<{
    delivery: ProgressiveRemoteEvidenceDelivery;
    resultAttemptId: string;
    archived: boolean;
  }> = [];
  let pendingArchives = 0;
  for (const source of sources) {
    if (
      !source.evidence_signature ||
      analysisContentHash(source.evidence_payload) !== source.evidence_signature
    )
      throw new Error(
        "Remote retention differs from its immutable CFD evidence receipt",
      );
    const delivery: ProgressiveRemoteEvidenceDelivery = {
      solverId: report.solverId,
      promiseId: report.promiseId,
      engineJobId: executionId,
      aoaDeg: Number(source.aoa_deg),
      engineCaseSlug:
        source.case_slug == null ? null : String(source.case_slug),
      remoteResultId: String(source.remote_result_id),
      remoteResultAttemptId: String(source.remote_result_attempt_id),
      progressiveEvidence: {
        sequence: Number(source.sequence),
        reportContentSignature: String(source.report_content_signature),
        pointContentSignature: String(source.point_content_signature),
      },
    };
    const reported = await resolveProgressiveRemoteEvidence(db, delivery);
    if (!reported)
      throw new Error("Remote retention has no exact source report");
    const hasManifest =
      reported.point.evidence_artifacts?.some(
        (artifact) => artifact.kind === "manifest",
      ) ?? false;
    if (hasManifest) {
      const [upload] =
        await db.execute(sql`SELECT upload.id FROM sync_brokered_evidence_uploads upload
        WHERE upload.engine_job_id = ${executionId} AND upload.solver_id = ${report.solverId}::uuid
          AND upload.promise_id = ${report.promiseId}::uuid
          AND upload.canonical_result_attempt_id = ${source.result_attempt_id}::uuid AND upload.state = 'bound'
          AND EXISTS (SELECT 1 FROM solver_evidence_archives archive WHERE archive.result_attempt_id = upload.canonical_result_attempt_id
            AND archive.source_artifact_id = upload.canonical_artifact_id AND archive.state = 'current')
        ORDER BY upload.bound_at DESC, upload.id LIMIT 1`);
      if (!upload) {
        pendingArchives += 1;
        continue;
      }
      await readProgressiveEvidenceCustodyReceipt(
        db,
        delivery,
        String(upload.id),
      );
    }
    retained.push({
      delivery,
      resultAttemptId: String(source.result_attempt_id),
      archived: hasManifest,
    });
  }
  if (pendingArchives)
    return {
      kind: "waiting" as const,
      reason: "archives" as const,
      sourceCount: sources.length,
      pendingCount: pendingArchives,
    };
  return { kind: "retained" as const, report, sources: retained };
}
