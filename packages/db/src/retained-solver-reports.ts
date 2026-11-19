import type { RetainedSolverReportPage } from "@aerodb/core";
import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash } from "./analysis-target";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import { validateProgressiveRemoteReport } from "./progressive-remote-report";
import {
  canonicalReportJson,
  parseReportJson,
  reportJsonObject,
  reportTextIdentity,
  reportValidationValue,
  type ProgressiveReportArchiveReadIdentity,
  type ReportJson,
} from "./progressive-report-archive";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SIGNATURE = /^[a-f0-9]{64}$/;

export class RetainedReportReadError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

export interface RetainedReportArchiveReader {
  /** Return exact PostgreSQL JSONB text, never a parsed JavaScript report. */
  read(identity: ProgressiveReportArchiveReadIdentity): Promise<string>;
}

function reportHash(value: ReportJson): string {
  return reportTextIdentity(canonicalReportJson(value)).sha256;
}

// Same inventory contract as progressiveRemoteReportInventory. The token tree
// retains numbers in point evidence that cannot survive a JS JSON round trip.
function retainedReportInventory(
  report: { [key: string]: ReportJson },
  signature: string,
) {
  const sources = new Map<string, { [key: string]: ReportJson }>();
  if (report.result !== null) {
    const result = reportJsonObject(report.result!);
    for (const item of result.polars as ReportJson[]) {
      const polar = reportJsonObject(item);
      for (const item of [
        ...(polar.points as ReportJson[]),
        ...((polar.attempts as ReportJson[]) ?? []),
      ]) {
        const point = reportJsonObject(item);
        const contentSignature = reportHash({
          kind: "progressive-reported-point-v1",
          executionId: result.job_id!,
          chord: polar.chord!,
          speed: polar.speed!,
          reynolds: polar.reynolds!,
          mach: polar.mach ?? null,
          point,
        });
        sources.set(contentSignature, {
          point_content_signature: contentSignature,
          aoa_deg: point.aoa_deg!,
          case_slug: point.case_slug ?? null,
        });
      }
    }
  }
  const sorted = [...sources.values()].sort((a, b) =>
    String(a.point_content_signature).localeCompare(
      String(b.point_content_signature),
    ),
  );
  return {
    sourceCount: sources.size,
    signature: reportHash({
      kind: "progressive-remote-report-inventory-v1",
      executionId: report.executionId!,
      sequence: report.sequence!,
      reportContentSignature: signature,
      sources: sorted,
    }),
  };
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
  options: { archiveReader?: RetainedReportArchiveReader } = {},
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
    await db.execute(sql`SELECT report.archive_bundle_id,archive.bucket AS archive_bucket,
    archive.object_key AS archive_object_key,archive.generation AS archive_generation,
    archive.mime_type AS archive_mime_type,archive.compression AS archive_compression,
    archive.archive_format AS archive_format,archive.stored_sha256 AS archive_stored_sha256,
    archive.stored_byte_size AS archive_stored_byte_size,archive.crc32c AS archive_crc32c,
    archive.member_count AS archive_member_count,archive.first_sequence AS archive_first_sequence,archive.last_sequence AS archive_last_sequence,
    member.report_sha256 AS archive_report_sha256,member.report_byte_size AS archive_report_byte_size,
    resolve_progressive_report(to_jsonb(report.*))::text AS resolved_report_text,report.content_signature,inventory.inventory_signature,inventory.source_count,
    dispatch.solver_id,dispatch.promise_id,dispatch.content_signature AS assignment_signature,dispatch.envelope,airfoil.slug
    FROM progressive_remote_reports report JOIN progressive_remote_report_inventories inventory USING(sim_job_id,sequence)
    JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=report.sim_job_id
    JOIN sim_jobs job ON job.id=report.sim_job_id JOIN airfoils airfoil ON airfoil.id=job.airfoil_id
    LEFT JOIN progressive_report_archive_bundles archive ON archive.id=report.archive_bundle_id
      AND archive.source_kind='remote' AND archive.sim_job_id=report.sim_job_id
    LEFT JOIN progressive_report_archive_members member ON member.bundle_id=archive.id
      AND member.source_kind='remote' AND member.sim_job_id=report.sim_job_id AND member.member_kind='report'
      AND member.sequence=report.sequence AND member.content_signature=report.content_signature
    WHERE report.sim_job_id=${reference.executionId}::uuid AND report.sequence=${reference.sequence}
      AND report.content_signature=${reference.signature} AND inventory.source_count>0
      AND EXISTS(SELECT 1 FROM progressive_cfd_execution_stops stopped WHERE stopped.sim_job_id=job.id AND stopped.engine_job_id=job.engine_job_id)`);
  if (!stored)
    throw new RetainedReportReadError(404, "Stored solver report not found");
  try {
    const text = stored.archive_bundle_id
      ? await (async () => {
          if (!options.archiveReader)
            throw new RetainedReportReadError(
              503,
              "Archived solver report storage is not configured",
            );
          return options.archiveReader.read({
            bucket: String(stored.archive_bucket),
            objectKey: String(stored.archive_object_key),
            generation: String(stored.archive_generation),
            mimeType: String(stored.archive_mime_type),
            compression: String(stored.archive_compression),
            archiveFormat: String(stored.archive_format),
            storedSha256: String(stored.archive_stored_sha256),
            storedByteSize: Number(stored.archive_stored_byte_size),
            crc32c: String(stored.archive_crc32c),
            memberCount: Number(stored.archive_member_count),
            firstSequence: Number(stored.archive_first_sequence),
            lastSequence: Number(stored.archive_last_sequence),
            sourceKind: "remote",
            memberKind: "report",
            executionId: reference.executionId,
            sequence: reference.sequence,
            signature: reference.signature,
            reportSha256: String(stored.archive_report_sha256),
            reportByteSize: Number(stored.archive_report_byte_size),
          });
        })()
      : stored.resolved_report_text;
    if (typeof text !== "string")
      throw new Error("Stored report has no exact JSONB text");
    if (stored.archive_bundle_id) {
      const proof = reportTextIdentity(text);
      if (
        proof.sha256 !== stored.archive_report_sha256 ||
        proof.byteSize !== Number(stored.archive_report_byte_size)
      )
        throw new Error("Stored report differs from its exact archive member");
    }
    const report = reportJsonObject(parseReportJson(text));
    const envelope = verifyProgressiveRemoteExecution(stored.envelope, {
      executionId: reference.executionId,
      solverId: String(stored.solver_id),
      promiseId: String(stored.promise_id),
      contentSignature: String(stored.assignment_signature),
    });
    const validated = validateProgressiveRemoteReport(
      reportValidationValue(report),
      envelope,
    );
    const content = canonicalReportJson(report);
    const signature = reportTextIdentity(content).sha256;
    const inventory = retainedReportInventory(report, signature);
    if (
      signature !== reference.signature ||
      canonicalReportJson(report.version!) !== "1" ||
      canonicalReportJson(report.sequence!) !== String(reference.sequence) ||
      validated.report.sequence !== reference.sequence ||
      inventory.signature !== stored.inventory_signature ||
      inventory.sourceCount !== Number(stored.source_count)
    )
      throw new Error("Stored report differs from its immutable inventory");
    return {
      content,
      signature,
      filename: `${String(stored.slug).replace(/[^a-zA-Z0-9._-]/g, "-")}-solver-report-${reference.sequence}.json`,
    };
  } catch (error) {
    if (error instanceof RetainedReportReadError) throw error;
    throw new RetainedReportReadError(
      409,
      "Stored solver report failed integrity verification",
    );
  }
}
