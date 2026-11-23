import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import type { ProgressiveRemoteExecutionEnvelope } from "./progressive-remote-execution";
import {
  validateProgressiveRemoteReport,
  type ProgressiveRemoteReport,
} from "./progressive-remote-report";
import {
  ProgressiveRemoteReportConflict,
  storeProgressiveRemoteReport,
} from "./progressive-remote-reports";
import {
  MAX_PROGRESSIVE_PUBLICATION_REPORTS,
  progressiveRepeatedReportSigner,
  sameLiveProgressStatus,
  type ProgressiveReportStatusUpdate,
} from "./progressive-report-publication-batch";

export class ProgressiveReportBatchUnavailable extends Error {}

/** The anchor gets the ordinary, fully verified v1 receipt. Its successors reuse
 * only that exact owned numerical source; their immutable report signatures,
 * inventories and receipts are exactly those of individual full v1 requests. */
export async function storeProgressiveRemoteReportBatch(
  db: DB,
  input: Parameters<typeof storeProgressiveRemoteReport>[1],
  updates: readonly ProgressiveReportStatusUpdate<unknown>[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!updates.length || updates.length >= MAX_PROGRESSIVE_PUBLICATION_REPORTS)
    throw new ProgressiveRemoteReportConflict(
      "Invalid report publication batch length",
    );
  const receipt = await storeProgressiveRemoteReport(db, input);
  signal?.throwIfAborted();
  const anchor = input.report as ProgressiveRemoteReport;
  const owner = sql`d.sim_job_id=${input.executionId}::uuid AND d.promise_id=${input.promiseId}::uuid
    AND d.solver_id=${input.solverId}::uuid AND d.content_signature=${anchor.assignmentSignature}
    AND registered.revoked_at IS NULL`;
  const [dispatch] =
    await db.execute(sql`SELECT d.envelope FROM progressive_remote_dispatches d
    JOIN registered_remote_solvers registered ON registered.id=d.solver_id WHERE ${owner}`);
  if (!dispatch)
    throw new ProgressiveRemoteReportConflict(
      "Remote report sender does not own the immutable dispatch",
    );
  const envelope =
    dispatch.envelope as unknown as ProgressiveRemoteExecutionEnvelope;
  signal?.throwIfAborted();
  const prepare = () => {
    const sign = progressiveRepeatedReportSigner(anchor);
    if (sign(anchor) !== receipt.contentSignature)
      throw new Error("Report batch source differs from its immutable receipt");
    return updates.map((update, index) => {
      if (
        update.sequence !== receipt.sequence + index + 1 ||
        !Number.isSafeInteger(update.sequence)
      )
        throw new Error(
          "Remote reports must arrive in their durable publication order",
        );
      const { report: statusReport } = validateProgressiveRemoteReport(
        {
          ...anchor,
          result: null,
          sequence: update.sequence,
          status: update.status,
        },
        envelope,
      );
      if (!sameLiveProgressStatus(anchor.status, statusReport.status))
        throw new Error("Report batch changed its live status scope");
      if (sign(statusReport) !== update.contentSignature)
        throw new Error(
          "Report batch differs from its complete original signature",
        );
      return { statusReport, signature: update.contentSignature };
    });
  };
  let following: ReturnType<typeof prepare>;
  try {
    following = prepare();
  } catch (error) {
    throw new ProgressiveRemoteReportConflict(
      error instanceof Error ? error.message : "Invalid report batch",
    );
  }

  return db.transaction(async (tx) => {
    signal?.throwIfAborted();
    const [locked] =
      await tx.execute(sql`SELECT d.sim_job_id FROM progressive_remote_dispatches d
      JOIN registered_remote_solvers registered ON registered.id=d.solver_id WHERE ${owner} FOR UPDATE OF d`);
    if (!locked)
      throw new ProgressiveRemoteReportConflict(
        "Remote report sender does not own the immutable dispatch",
      );
    signal?.throwIfAborted();
    const [source] = await tx.execute(sql`
      SELECT r.result_payload_hash,CASE WHEN r.result_payload_hash IS NOT NULL THEN r.report->'result' END AS header,
        i.inventory_signature,i.source_count
      FROM progressive_remote_reports r JOIN progressive_remote_report_inventories i
        ON i.sim_job_id=r.sim_job_id AND i.sequence=r.sequence AND i.report_content_signature=r.content_signature
      WHERE r.sim_job_id=${input.executionId}::uuid AND r.sequence=${receipt.sequence}
        AND r.content_signature=${receipt.contentSignature}
    `);
    if (!source)
      throw new ProgressiveRemoteReportConflict(
        "The signed report source inventory changed",
      );
    const sources = [
      ...(await tx.execute(sql`SELECT point_content_signature,aoa_deg,case_slug
      FROM progressive_remote_report_sources WHERE sim_job_id=${input.executionId}::uuid
        AND sequence=${receipt.sequence} ORDER BY point_content_signature`)),
    ];
    const inventorySignature = (
      sequence: number,
      reportContentSignature: string,
    ) =>
      analysisContentHash({
        kind: "progressive-remote-report-inventory-v1",
        executionId: input.executionId,
        sequence,
        reportContentSignature,
        sources,
      });
    if (
      sources.length !== Number(source.source_count) ||
      inventorySignature(receipt.sequence, receipt.contentSignature) !==
        source.inventory_signature
    )
      throw new ProgressiveRemoteReportConflict(
        "The signed report source inventory changed",
      );
    const last = following[following.length - 1]!.statusReport.sequence;
    const rows =
      await tx.execute(sql`SELECT sequence,content_signature FROM progressive_remote_reports
      WHERE sim_job_id=${input.executionId}::uuid AND sequence>${receipt.sequence} AND sequence<=${last}`);
    const existing = new Map(
      rows.map((row) => [Number(row.sequence), row.content_signature]),
    );
    for (const { statusReport, signature } of following) {
      if (
        existing.has(statusReport.sequence) &&
        existing.get(statusReport.sequence) !== signature
      )
        throw new ProgressiveRemoteReportConflict(
          "Remote report replay changed immutable content",
        );
    }
    const fresh = following.filter(
      (entry) => !existing.has(entry.statusReport.sequence),
    );
    if (fresh.length) {
      const [head] =
        await tx.execute(sql`SELECT sequence FROM progressive_remote_reports
        WHERE sim_job_id=${input.executionId}::uuid ORDER BY sequence DESC LIMIT 1`);
      if (Number(head?.sequence) + 1 !== fresh[0]!.statusReport.sequence)
        throw new ProgressiveRemoteReportConflict(
          "Remote reports must arrive in their durable publication order",
        );
      if (typeof source.result_payload_hash !== "string" || !source.header)
        throw new ProgressiveReportBatchUnavailable(
          "The original report needs single-report publication",
        );
      const headers = fresh.map(({ statusReport, signature }) => ({
        sequence: statusReport.sequence,
        signature,
        report: { ...statusReport, result: source.header },
      }));
      await tx.execute(sql`INSERT INTO progressive_remote_reports (sim_job_id,sequence,content_signature,report,result_payload_hash)
        SELECT ${input.executionId}::uuid,v.sequence,v.signature,v.report,${source.result_payload_hash}::text
        FROM jsonb_to_recordset(${JSON.stringify(headers)}::jsonb) AS v(sequence bigint,signature text,report jsonb)
        ORDER BY v.sequence`);
    }
    const inventories = following.map(({ statusReport, signature }) => ({
      sequence: statusReport.sequence,
      signature,
      inventory: inventorySignature(statusReport.sequence, signature),
    }));
    await tx.execute(sql`INSERT INTO progressive_remote_report_inventories
        (sim_job_id,sequence,report_content_signature,inventory_signature,source_count)
      SELECT ${input.executionId}::uuid,v.sequence,v.signature,v.inventory,${sources.length}
      FROM jsonb_to_recordset(${JSON.stringify(inventories)}::jsonb) AS v(sequence bigint,signature text,inventory text)
      ORDER BY v.sequence ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO progressive_remote_report_sources (sim_job_id,sequence,point_content_signature,aoa_deg,case_slug)
      SELECT s.sim_job_id,seq,s.point_content_signature,s.aoa_deg,s.case_slug FROM progressive_remote_report_sources s
      CROSS JOIN generate_series(${receipt.sequence + 1}::bigint,${last}::bigint) seq
      WHERE s.sim_job_id=${input.executionId}::uuid AND s.sequence=${receipt.sequence}
      ORDER BY seq,s.point_content_signature ON CONFLICT DO NOTHING`);
    const indexed =
      await tx.execute(sql`SELECT i.sequence,i.report_content_signature,i.inventory_signature,i.source_count,
        coalesce(jsonb_agg(jsonb_build_object('point_content_signature',s.point_content_signature,'aoa_deg',s.aoa_deg,'case_slug',s.case_slug)
          ORDER BY s.point_content_signature) FILTER(WHERE s.point_content_signature IS NOT NULL),'[]'::jsonb) AS sources
      FROM progressive_remote_report_inventories i LEFT JOIN progressive_remote_report_sources s USING(sim_job_id,sequence)
      WHERE i.sim_job_id=${input.executionId}::uuid AND i.sequence>${receipt.sequence} AND i.sequence<=${last}
      GROUP BY i.sim_job_id,i.sequence ORDER BY i.sequence`);
    const actualSources = canonicalAnalysisJson(sources);
    if (
      indexed.length !== inventories.length ||
      indexed.some((row, index) => {
        const expected = inventories[index]!;
        return (
          Number(row.sequence) !== expected.sequence ||
          row.report_content_signature !== expected.signature ||
          row.inventory_signature !== expected.inventory ||
          Number(row.source_count) !== sources.length ||
          canonicalAnalysisJson(row.sources) !== actualSources
        );
      })
    )
      throw new ProgressiveRemoteReportConflict(
        "Remote inventory replay changed its exact source set",
      );
    signal?.throwIfAborted();
    if (fresh.length)
      await tx.execute(
        sql`SELECT pg_notify('progressive_remote_report_changed',${input.executionId})`,
      );
    return [
      receipt,
      ...following.map(({ statusReport, signature }) => ({
        executionId: input.executionId,
        sequence: statusReport.sequence,
        contentSignature: signature,
        replayed: existing.has(statusReport.sequence),
      })),
    ];
  });
}
