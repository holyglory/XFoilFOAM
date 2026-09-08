import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import {
  progressiveReportedPointSources,
  type ProgressiveRemoteReport,
} from "./progressive-remote-report";

export function progressiveRemoteReportInventory(
  report: ProgressiveRemoteReport,
) {
  const sources = (
    report.result ? progressiveReportedPointSources(report.result) : []
  )
    .map(({ point, contentSignature }) => ({
      point_content_signature: contentSignature,
      aoa_deg: point.aoa_deg,
      case_slug: point.case_slug ?? null,
    }))
    .sort((left, right) =>
      left.point_content_signature.localeCompare(right.point_content_signature),
    );
  const reportContentSignature = analysisContentHash(report);
  return {
    reportContentSignature,
    sources,
    inventorySignature: analysisContentHash({
      kind: "progressive-remote-report-inventory-v1",
      executionId: report.executionId,
      sequence: report.sequence,
      reportContentSignature,
      sources,
    }),
  };
}

export async function indexProgressiveRemoteReport(
  db: DB,
  input: {
    report: ProgressiveRemoteReport;
    reportContentSignature: string;
  },
) {
  const inventory = progressiveRemoteReportInventory(input.report);
  if (inventory.reportContentSignature !== input.reportContentSignature)
    throw new Error("Remote inventory differs from its immutable report");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [stored] =
      await connection.execute(sql`SELECT content_signature FROM progressive_remote_reports
      WHERE sim_job_id = ${input.report.executionId}::uuid AND sequence = ${input.report.sequence} FOR SHARE`);
    if (stored?.content_signature !== inventory.reportContentSignature)
      throw new Error("Remote inventory has no matching stored report");
    await connection.execute(sql`INSERT INTO progressive_remote_report_inventories
      (sim_job_id, sequence, report_content_signature, inventory_signature, source_count)
      VALUES (${input.report.executionId}::uuid, ${input.report.sequence}, ${inventory.reportContentSignature},
        ${inventory.inventorySignature}, ${inventory.sources.length}) ON CONFLICT DO NOTHING`);
    const [existing] =
      await connection.execute(sql`SELECT report_content_signature, inventory_signature, source_count
      FROM progressive_remote_report_inventories WHERE sim_job_id = ${input.report.executionId}::uuid
        AND sequence = ${input.report.sequence} FOR UPDATE`);
    if (
      existing?.report_content_signature !== inventory.reportContentSignature ||
      existing.inventory_signature !== inventory.inventorySignature ||
      Number(existing.source_count) !== inventory.sources.length
    )
      throw new Error("Remote inventory replay changed its exact source set");
    await connection.execute(sql`INSERT INTO progressive_remote_report_sources
      (sim_job_id, sequence, point_content_signature, aoa_deg, case_slug)
      SELECT ${input.report.executionId}::uuid, ${input.report.sequence}, source.point_content_signature, source.aoa_deg, source.case_slug
      FROM jsonb_to_recordset(${JSON.stringify(inventory.sources)}::jsonb)
        AS source(point_content_signature text, aoa_deg double precision, case_slug text)
      ON CONFLICT DO NOTHING`);
    const storedSources =
      await connection.execute(sql`SELECT point_content_signature, aoa_deg, case_slug
      FROM progressive_remote_report_sources WHERE sim_job_id = ${input.report.executionId}::uuid
        AND sequence = ${input.report.sequence} ORDER BY point_content_signature`);
    if (
      canonicalAnalysisJson([...storedSources]) !==
      canonicalAnalysisJson(inventory.sources)
    )
      throw new Error(
        "Remote inventory source rows differ from their sealed report",
      );
    return {
      executionId: input.report.executionId,
      sequence: input.report.sequence,
      sourceCount: inventory.sources.length,
    };
  });
}
