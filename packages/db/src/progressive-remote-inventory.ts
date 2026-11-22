import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import {
  progressiveReportedPointSources,
  validateProgressiveRemoteReport,
  type ProgressiveRemoteReport,
} from "./progressive-remote-report";

export function progressiveRemoteReportInventory(
  report: ProgressiveRemoteReport,
) {
  return buildInventory(report, analysisContentHash(report));
}

function buildInventory(
  report: ProgressiveRemoteReport,
  reportContentSignature: string,
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
  return writeInventory(db, input.report, inventory);
}

/** Seal both proofs from the validated report before taking a dispatch lock. */
export function prepareProgressiveReportPublication(
  value: unknown,
  assignment: Parameters<typeof validateProgressiveRemoteReport>[1],
) {
  const { report, contentSignature } = validateProgressiveRemoteReport(
    value,
    assignment,
  );
  const inventory = buildInventory(report, contentSignature);
  return {
    report,
    contentSignature,
    inventory,
    index: (db: DB) => writeInventory(db, report, inventory),
  };
}

async function writeInventory(
  db: DB,
  report: ProgressiveRemoteReport,
  inventory: ReturnType<typeof buildInventory>,
) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [stored] =
      await connection.execute(sql`SELECT content_signature FROM progressive_remote_reports
      WHERE sim_job_id = ${report.executionId}::uuid AND sequence = ${report.sequence} FOR SHARE`);
    if (stored?.content_signature !== inventory.reportContentSignature)
      throw new Error("Remote inventory has no matching stored report");
    await connection.execute(sql`INSERT INTO progressive_remote_report_inventories
      (sim_job_id, sequence, report_content_signature, inventory_signature, source_count)
      VALUES (${report.executionId}::uuid, ${report.sequence}, ${inventory.reportContentSignature},
        ${inventory.inventorySignature}, ${inventory.sources.length}) ON CONFLICT DO NOTHING`);
    const [existing] =
      await connection.execute(sql`SELECT report_content_signature, inventory_signature, source_count
      FROM progressive_remote_report_inventories WHERE sim_job_id = ${report.executionId}::uuid
        AND sequence = ${report.sequence} FOR UPDATE`);
    if (
      existing?.report_content_signature !== inventory.reportContentSignature ||
      existing.inventory_signature !== inventory.inventorySignature ||
      Number(existing.source_count) !== inventory.sources.length
    )
      throw new Error("Remote inventory replay changed its exact source set");
    await connection.execute(sql`INSERT INTO progressive_remote_report_sources
      (sim_job_id, sequence, point_content_signature, aoa_deg, case_slug)
      SELECT ${report.executionId}::uuid, ${report.sequence}, source.point_content_signature, source.aoa_deg, source.case_slug
      FROM jsonb_to_recordset(${JSON.stringify(inventory.sources)}::jsonb)
        AS source(point_content_signature text, aoa_deg double precision, case_slug text)
      ON CONFLICT DO NOTHING`);
    const storedSources =
      await connection.execute(sql`SELECT point_content_signature, aoa_deg, case_slug
      FROM progressive_remote_report_sources WHERE sim_job_id = ${report.executionId}::uuid
        AND sequence = ${report.sequence} ORDER BY point_content_signature`);
    if (
      canonicalAnalysisJson([...storedSources]) !==
      canonicalAnalysisJson(inventory.sources)
    )
      throw new Error(
        "Remote inventory source rows differ from their sealed report",
      );
    return {
      executionId: report.executionId,
      sequence: report.sequence,
      sourceCount: inventory.sources.length,
    };
  });
}
