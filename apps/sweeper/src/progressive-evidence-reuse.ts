import {
  analysisContentHash,
  progressiveReportedPointSources,
  progressiveRemotePointProjection,
  resolveProgressiveReportedPoint,
  validateProgressiveRemoteReport,
  type DB,
  type ProgressiveRemoteExecutionEnvelope,
  type ProgressiveRemoteReport,
} from "@aerodb/db";
import { sql } from "drizzle-orm";

const fields = [
  "aoaDeg",
  "status",
  "source",
  "regime",
  "cl",
  "cd",
  "cm",
  "clCd",
  "clStd",
  "cdStd",
  "cmStd",
  "stalled",
  "unsteady",
  "converged",
  "finalResidual",
  "iterations",
  "yPlusAvg",
  "yPlusMax",
  "nCells",
  "firstOrderFallback",
  "strouhal",
  "error",
  "methodKey",
  "engineJobId",
  "engineCaseSlug",
] as const;

export async function existingProgressiveReportAttempts(
  db: DB,
  report: ProgressiveRemoteReport,
  envelope: ProgressiveRemoteExecutionEnvelope,
): Promise<string[] | null> {
  if (!report.result) return null;
  const sources = progressiveReportedPointSources(report.result);
  if (!sources.length || sources.length > 512) return null;
  const rows =
    await db.execute(sql`SELECT association.point_content_signature,association.result_attempt_id,
      original.report,original.content_signature,to_jsonb(attempt) AS attempt
    FROM progressive_worker_evidence_attempts association
    JOIN progressive_worker_evidence_receipts receipt ON receipt.sim_job_id=association.sim_job_id AND receipt.sequence=association.sequence
    JOIN progressive_worker_reports original ON original.sim_job_id=association.sim_job_id AND original.sequence=association.sequence
      AND original.content_signature=receipt.content_signature AND original.acknowledged_at IS NOT NULL
    JOIN result_attempts attempt ON attempt.id=association.result_attempt_id AND attempt.sim_job_id=association.sim_job_id
      AND attempt.engine_job_id=association.sim_job_id::text
    WHERE association.sim_job_id=${report.executionId}::uuid AND association.sequence<${report.sequence}
      AND association.point_content_signature IN (${sql.join(
        sources.map((source) => sql`${source.contentSignature}`),
        sql`, `,
      )})
    ORDER BY association.sequence DESC LIMIT 2049`);
  if (rows.length > 2048) return null;
  const attempts: string[] = [];
  for (const source of sources) {
    const candidates = rows.filter(
      (row) => row.point_content_signature === source.contentSignature,
    );
    if (
      !candidates.length ||
      new Set(candidates.map((row) => row.result_attempt_id)).size !== 1
    )
      return null;
    const candidate = candidates[0];
    const previous = validateProgressiveRemoteReport(
      candidate.report,
      envelope,
    );
    if (
      previous.contentSignature !== candidate.content_signature ||
      !previous.report.result
    )
      return null;
    const original = resolveProgressiveReportedPoint(previous.report.result, {
      alpha: source.point.aoa_deg,
      caseSlug: source.point.case_slug ?? null,
      speed: source.polar.speed,
      chord: source.polar.chord,
    });
    if (original.contentSignature !== source.contentSignature) return null;
    const projection = progressiveRemotePointProjection({
      ...source,
      report,
      envelope,
    });
    const oldProjection = progressiveRemotePointProjection({
      ...original,
      report: previous.report,
      envelope,
    });
    if (
      (Object.keys(projection) as Array<keyof typeof projection>).some(
        (key) =>
          analysisContentHash(projection[key] ?? null) !==
          analysisContentHash(oldProjection[key] ?? null),
      )
    )
      return null;
    const attempt = candidate.attempt as Record<string, unknown>;
    const expectedWarnings = projection.qualityWarnings ?? [];
    const storedWarnings = attempt.quality_warnings ?? [];
    if (
      !Array.isArray(storedWarnings) ||
      storedWarnings.some((value) => typeof value !== "string") ||
      analysisContentHash(storedWarnings.slice(0, expectedWarnings.length)) !==
        analysisContentHash(expectedWarnings) ||
      storedWarnings
        .slice(expectedWarnings.length)
        .some(
          (value) => !value.startsWith("released-cell failure quarantined: "),
        )
    )
      return null;
    if (
      !attempt.result_id ||
      analysisContentHash(attempt.evidence_payload) !==
        analysisContentHash(projection.evidencePayload)
    )
      return null;
    for (const field of fields) {
      const key = field.replace(
        /[A-Z]/g,
        (letter) => `_${letter.toLowerCase()}`,
      );
      if (
        analysisContentHash(attempt[key] ?? null) !==
        analysisContentHash(projection[field] ?? null)
      )
        return null;
    }
    attempts.push(String(candidate.result_attempt_id));
  }
  return new Set(attempts).size === attempts.length ? attempts : null;
}
