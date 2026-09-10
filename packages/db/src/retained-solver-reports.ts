import type { RetainedSolverReportPage } from "@aerodb/core";
import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import { validateProgressiveRemoteReport } from "./progressive-remote-report";
import { progressiveRemoteReportInventory } from "./progressive-remote-inventory";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SIGNATURE = /^[a-f0-9]{64}$/;

export class RetainedReportReadError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

interface ReportCursor {
  at: string;
  executionId: string;
  sequence: number;
  filter: string;
}

function finiteStoredNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readCursor(
  value: string | undefined,
  filter: string,
): ReportCursor | null {
  if (!value) return null;
  try {
    if (value.length > 1024 || !/^[a-zA-Z0-9_-]+$/.test(value))
      throw new Error();
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as ReportCursor;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.at) ||
      !Number.isFinite(Date.parse(parsed.at)) ||
      typeof parsed.executionId !== "string" ||
      !UUID.test(parsed.executionId) ||
      !Number.isSafeInteger(parsed.sequence) ||
      parsed.sequence < 1 ||
      parsed.filter !== filter
    )
      throw new Error();
    return parsed;
  } catch {
    throw new RetainedReportReadError(
      400,
      "Invalid retained-report cursor or changed filters",
    );
  }
}

export async function retainedSolverReports(
  db: DB,
  input: {
    airfoil?: string;
    campaignId?: string;
    cursor?: string;
    limit?: number;
    includeDelivered?: boolean;
  } = {},
): Promise<RetainedSolverReportPage> {
  const limit = input.limit ?? 25;
  const airfoil = input.airfoil?.trim() ?? "";
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    airfoil.length > 120 ||
    (input.campaignId !== undefined && !UUID.test(input.campaignId)) ||
    (input.includeDelivered !== undefined &&
      typeof input.includeDelivered !== "boolean")
  )
    throw new RetainedReportReadError(400, "Invalid retained-report filters");
  const filter = analysisContentHash({
    airfoil,
    campaignId: input.campaignId ?? null,
    includeDelivered: input.includeDelivered === true,
  });
  const cursor = readCursor(input.cursor, filter);
  const rows = await db.execute(sql`
    WITH selected AS MATERIALIZED (
      SELECT report.sim_job_id,report.sequence,report.content_signature,report.received_at,inventory.source_count,
        job.status,airfoil.slug,airfoil.name AS airfoil_name,campaign.id AS campaign_id,campaign.name AS campaign_name,
        revision.reynolds,revision.snapshot#>>'{flowState,mach}' AS mach
      FROM progressive_remote_reports report
      JOIN progressive_remote_report_inventories inventory USING(sim_job_id,sequence)
      JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=report.sim_job_id
      JOIN sim_jobs job ON job.id=report.sim_job_id
      JOIN airfoils airfoil ON airfoil.id=job.airfoil_id
      LEFT JOIN sim_campaigns campaign ON campaign.id=job.campaign_id
      LEFT JOIN simulation_preset_revisions revision ON revision.id=job.simulation_preset_revision_id
      WHERE inventory.report_content_signature=report.content_signature AND inventory.source_count>0
        AND EXISTS(SELECT 1 FROM progressive_cfd_execution_stops stopped
          WHERE stopped.sim_job_id=job.id AND stopped.engine_job_id=job.engine_job_id)
        ${airfoil ? sql`AND strpos(lower(airfoil.slug||' '||airfoil.name),lower(${airfoil}))>0` : sql``}
        ${input.campaignId ? sql`AND campaign.id=${input.campaignId}::uuid` : sql``}
        ${cursor ? sql`AND (report.received_at,report.sim_job_id,report.sequence)<(${cursor.at}::timestamptz,${cursor.executionId}::uuid,${cursor.sequence})` : sql``}
        ${
          input.includeDelivered
            ? sql``
            : sql`AND EXISTS(SELECT 1 FROM progressive_remote_report_sources source
          WHERE source.sim_job_id=report.sim_job_id AND source.sequence=report.sequence
            AND NOT EXISTS(SELECT 1 FROM progressive_remote_evidence_receipts receipt
              WHERE receipt.sim_job_id=source.sim_job_id AND receipt.point_content_signature=source.point_content_signature))`
        }
      ORDER BY report.received_at DESC,report.sim_job_id DESC,report.sequence DESC LIMIT ${limit + 1}
    ) SELECT selected.*,to_char(selected.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
      sources.angles,sources.received,
      (SELECT count(*)::integer FROM progressive_publication_recoveries recovery WHERE recovery.sim_job_id=selected.sim_job_id) AS recovery_angles,
      (SELECT count(*)::integer FROM progressive_publication_recoveries recovery
        JOIN progressive_publication_recovery_claims claim ON claim.unit_id=recovery.unit_id
        WHERE recovery.sim_job_id=selected.sim_job_id) AS recovery_claims
    FROM selected
    JOIN LATERAL(SELECT array_agg(DISTINCT source.aoa_deg ORDER BY source.aoa_deg) AS angles,
      count(*) FILTER(WHERE receipt.result_attempt_id IS NOT NULL)::integer AS received
      FROM progressive_remote_report_sources source LEFT JOIN progressive_remote_evidence_receipts receipt
        ON receipt.sim_job_id=source.sim_job_id AND receipt.point_content_signature=source.point_content_signature
      WHERE source.sim_job_id=selected.sim_job_id AND source.sequence=selected.sequence) sources ON true
    ORDER BY selected.received_at DESC,selected.sim_job_id DESC,selected.sequence DESC`);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      executionId: String(row.sim_job_id),
      sequence: Number(row.sequence),
      signature: String(row.content_signature),
      receivedAt: String(row.cursor_at),
      airfoilSlug: String(row.slug),
      airfoilName: String(row.airfoil_name),
      campaignId: row.campaign_id == null ? null : String(row.campaign_id),
      campaignName:
        row.campaign_name == null ? null : String(row.campaign_name),
      reynolds: finiteStoredNumber(row.reynolds),
      mach: finiteStoredNumber(row.mach),
      angles: (row.angles as number[] | null) ?? [],
      sourceCount: Number(row.source_count),
      receivedSourceCount: Number(row.received),
      jobStatus: String(row.status),
      recovery: {
        queuedAngles: Number(row.recovery_angles),
        claimedAngles: Number(row.recovery_claims),
      },
    })),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              at: String(last.cursor_at),
              executionId: String(last.sim_job_id),
              sequence: Number(last.sequence),
              filter,
            } satisfies ReportCursor),
          ).toString("base64url")
        : null,
  };
}

export async function retainedSolverReportDownload(
  db: DB,
  reference: { executionId: string; sequence: number; signature: string },
) {
  if (
    !UUID.test(reference.executionId) ||
    !Number.isSafeInteger(reference.sequence) ||
    reference.sequence < 1 ||
    !SIGNATURE.test(reference.signature)
  )
    throw new RetainedReportReadError(
      400,
      "Invalid exact retained-report reference",
    );
  const [stored] =
    await db.execute(sql`SELECT report.report,report.content_signature,inventory.inventory_signature,inventory.source_count,
    dispatch.solver_id,dispatch.promise_id,dispatch.content_signature AS assignment_signature,dispatch.envelope,airfoil.slug
    FROM progressive_remote_reports report JOIN progressive_remote_report_inventories inventory USING(sim_job_id,sequence)
    JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=report.sim_job_id
    JOIN sim_jobs job ON job.id=report.sim_job_id JOIN airfoils airfoil ON airfoil.id=job.airfoil_id
    WHERE report.sim_job_id=${reference.executionId}::uuid AND report.sequence=${reference.sequence}
      AND report.content_signature=${reference.signature} AND inventory.source_count>0
      AND EXISTS(SELECT 1 FROM progressive_cfd_execution_stops stopped WHERE stopped.sim_job_id=job.id AND stopped.engine_job_id=job.engine_job_id)`);
  if (!stored)
    throw new RetainedReportReadError(404, "Stored solver report not found");
  try {
    const envelope = verifyProgressiveRemoteExecution(stored.envelope, {
      executionId: reference.executionId,
      solverId: String(stored.solver_id),
      promiseId: String(stored.promise_id),
      contentSignature: String(stored.assignment_signature),
    });
    const validated = validateProgressiveRemoteReport(stored.report, envelope);
    const inventory = progressiveRemoteReportInventory(validated.report);
    if (
      validated.contentSignature !== reference.signature ||
      validated.report.sequence !== reference.sequence ||
      inventory.inventorySignature !== stored.inventory_signature ||
      inventory.sources.length !== Number(stored.source_count)
    )
      throw new Error("Stored report differs from its immutable inventory");
    return {
      content: canonicalAnalysisJson(validated.report),
      signature: validated.contentSignature,
      filename: `${String(stored.slug).replace(/[^a-zA-Z0-9._-]/g, "-")}-solver-report-${reference.sequence}.json`,
    };
  } catch {
    throw new RetainedReportReadError(
      409,
      "Stored solver report failed integrity verification",
    );
  }
}
