import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { canonicalAnalysisJson } from "./analysis-target";
import { prepareProgressiveReportPublication } from "./progressive-remote-inventory";
import type { ProgressiveRemoteExecutionEnvelope } from "./progressive-remote-execution";
import {
  validateProgressiveReportProgress,
  validateProgressiveRemoteReportOrder,
  type ProgressiveRemoteReport,
} from "./progressive-remote-report";
import {
  resolveStoredProgressiveReport,
  recheckRemoteReportMember,
  verifiedProgressiveReportMember,
} from "./progressive-report-reader";

export class ProgressiveRemoteReportConflict extends Error {}

interface RemoteReportInput {
  solverId: string;
  promiseId: string;
  executionId: string;
  report: unknown;
}

type RunningPredecessor = {
  sequence: number;
  completedCases: number;
  signature: string;
  tupleVersion: string;
};

/** Check a nonfinal predecessor outside the lock. Reading the normalized payload
 * header is permitted only after the indexed FK lookup. The legacy row form
 * also works on inline-only storage. Neither path returns any prior samples. */
export async function prepareRunningReportOrder(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
  sequence: number,
): Promise<RunningPredecessor | null> {
  if (sequence < 1) return null;
  const [prior] = await db.execute<RunningPredecessor>(sql`
    WITH prior AS MATERIALIZED (
      SELECT r.sequence,r.content_signature AS signature,
        concat_ws(':',r.tableoid,r.xmin,r.ctid) AS version,to_jsonb(r.*) AS stored
      FROM progressive_remote_reports r
      WHERE r.sim_job_id=${envelope.scope.executionId}::uuid AND r.sequence=${sequence}
    ), candidate AS MATERIALIZED (
      SELECT sequence,signature,version,stored->>'result_payload_hash' AS hash,stored#>'{report,result}' AS result,
        CASE WHEN jsonb_typeof(stored#>'{report,status,completed_cases}')='number'
          THEN (stored#>>'{report,status,completed_cases}')::numeric END AS done
      FROM prior WHERE stored->>'archived_at' IS NULL AND stored->>'archive_bundle_id' IS NULL
        AND NOT ((stored->'report') ? 'archivedReport')
        AND stored->'report' @> jsonb_build_object('version',1,'executionId',${envelope.scope.executionId}::text,
          'solverId',${envelope.solverId}::text,'promiseId',${envelope.promiseId}::text,
          'assignmentSignature',${envelope.contentSignature}::text,'sequence',sequence,'stopProof',NULL,
          'status',jsonb_build_object('job_id',${envelope.scope.executionId}::text,'state','running','total_cases',${envelope.scope.units.length}::integer))
    )
    SELECT sequence::double precision,done::double precision AS "completedCases",signature,version AS "tupleVersion"
    FROM candidate c LEFT JOIN LATERAL (
      SELECT p.result FROM public.progressive_report_result_payloads p WHERE p.content_hash=c.hash LIMIT 1
    ) body ON true
    WHERE done BETWEEN 0 AND ${envelope.scope.units.length}::integer AND done=trunc(done)
      AND CASE WHEN c.hash IS NULL THEN c.result='null'::jsonb OR c.result @>
        jsonb_build_object('state','running','job_id',${envelope.scope.executionId}::text,'polars','[]'::jsonb)
      ELSE c.result='{"state":"running"}'::jsonb AND body.result @>
        jsonb_build_object('state','running','job_id',${envelope.scope.executionId}::text,'polars','[]'::jsonb) END
  `);
  return prior ?? null;
}

/** Compare the actual latest heap tuple after acquiring dispatch ownership.
 * An UPDATE (including storage-only compaction) changes the tuple version.
 * A different row takes the existing signature-pinned full read outside SQL locks. */
export async function readLatestReportForOrder(
  db: DB,
  executionId: string,
  prepared: RunningPredecessor | null,
) {
  const [row] = await db.execute<{
    sequence: string;
    running: boolean;
    content_signature: string | null;
  }>(sql`
    WITH latest AS MATERIALIZED (
      SELECT r.sequence,r.content_signature,${
        prepared
          ? sql`
        r.sequence=${prepared.sequence} AND r.content_signature=${prepared.signature} AND
        concat_ws(':',r.tableoid,r.xmin,r.ctid)=${prepared.tupleVersion}`
          : sql`false`
      } AS running
      FROM progressive_remote_reports r WHERE r.sim_job_id=${executionId}::uuid ORDER BY r.sequence DESC LIMIT 1
    ) SELECT sequence,running,CASE WHEN NOT running THEN content_signature END AS content_signature FROM latest`);
  return row;
}

export async function storeProgressiveRemoteReport(
  db: DB,
  input: RemoteReportInput,
) {
  const owner = sql`FROM progressive_remote_dispatches d JOIN registered_remote_solvers solver
    ON solver.id=d.solver_id AND solver.revoked_at IS NULL WHERE d.sim_job_id=${input.executionId}::uuid
    AND d.solver_id=${input.solverId}::uuid AND d.promise_id=${input.promiseId}::uuid`;
  const [dispatch] = await db.execute(
    sql`SELECT d.envelope,d.content_signature ${owner}`,
  );
  if (!dispatch)
    throw new ProgressiveRemoteReportConflict(
      "Remote report sender does not own the immutable dispatch",
    );
  const envelope = dispatch.envelope as ProgressiveRemoteExecutionEnvelope;
  let publication: ReturnType<typeof prepareProgressiveReportPublication>;
  try {
    publication = prepareProgressiveReportPublication(input.report, envelope);
  } catch (error) {
    throw new ProgressiveRemoteReportConflict(
      error instanceof Error
        ? error.message
        : "Malformed remote execution report",
    );
  }
  const { report, contentSignature, inventory } = publication;
  const receipt = {
    executionId: input.executionId,
    sequence: report.sequence,
    contentSignature,
  };

  async function replay(connection: DB, repair: boolean) {
    const [stored] =
      await connection.execute(sql`SELECT r.content_signature,i.report_content_signature,i.inventory_signature,i.source_count,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('point_content_signature',s.point_content_signature,'aoa_deg',s.aoa_deg,'case_slug',s.case_slug)
        ORDER BY s.point_content_signature),'[]'::jsonb) FROM progressive_remote_report_sources s WHERE s.sim_job_id=r.sim_job_id AND s.sequence=r.sequence) AS sources
      FROM progressive_remote_reports r LEFT JOIN progressive_remote_report_inventories i USING(sim_job_id,sequence)
      WHERE r.sim_job_id=${input.executionId}::uuid AND r.sequence=${report.sequence}
        AND EXISTS(SELECT 1 ${owner} AND d.content_signature=${dispatch.content_signature})`);
    if (!stored) return null;
    if (stored.content_signature !== contentSignature)
      throw new ProgressiveRemoteReportConflict(
        "Remote report replay changed immutable content",
      );
    // A pre-inventory row takes the existing repair path. A fully indexed
    // replay verifies its membership without touching any row or waiting on a writer.
    if (
      stored.report_content_signature !== contentSignature ||
      stored.inventory_signature !== inventory.inventorySignature ||
      Number(stored.source_count) !== inventory.sources.length ||
      canonicalAnalysisJson(stored.sources) !==
        canonicalAnalysisJson(inventory.sources)
    ) {
      if (!repair) return null;
      await publication.index(connection);
    }
    return { ...receipt, replayed: true };
  }
  const existing = await replay(db, false);
  if (existing) return existing;

  // Immutable predecessors can be prepared outside the dispatch transaction.
  // A concurrently arriving successor is resolved by the locked sequence check.
  let previous:
    | { sequence: number; signature: string; full: ProgressiveRemoteReport }
    | undefined;
  const running = await prepareRunningReportOrder(
    db,
    envelope,
    report.sequence - 1,
  );
  const encoded = JSON.stringify(report);
  for (;;) {
    const outcome = await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const [locked] = await connection.execute(sql`SELECT d.sim_job_id ${owner}
        AND d.content_signature=${dispatch.content_signature} FOR UPDATE OF d`);
      if (!locked)
        throw new ProgressiveRemoteReportConflict(
          "Remote report sender does not own the immutable dispatch",
        );
      const duplicate = await replay(connection, true);
      if (duplicate) return { receipt: duplicate };

      const latest = await readLatestReportForOrder(
        connection,
        input.executionId,
        running,
      );
      try {
        if (!latest) validateProgressiveRemoteReportOrder(report, null);
        else if (running && latest.running)
          validateProgressiveReportProgress(
            report,
            running.sequence,
            running.completedCases,
          );
        else {
          if (report.sequence !== Number(latest.sequence) + 1)
            throw new Error(
              "Remote reports must arrive in their durable publication order",
            );
          if (!previous)
            return {
              need: {
                sequence: Number(latest.sequence),
                signature: String(latest.content_signature),
              },
            };
          if (
            previous.sequence !== Number(latest.sequence) ||
            previous.signature !== latest.content_signature
          )
            throw new Error(
              "Remote report predecessor changed before publication",
            );
          const pin = verifiedProgressiveReportMember(previous.full);
          if (pin && !(await recheckRemoteReportMember(connection, pin)))
            throw new Error("Archived predecessor changed before publication");
          validateProgressiveRemoteReportOrder(report, previous.full);
        }
      } catch (error) {
        throw new ProgressiveRemoteReportConflict(
          error instanceof Error
            ? error.message
            : "Invalid remote report order",
        );
      }
      await connection.execute(sql`INSERT INTO progressive_remote_reports (sim_job_id,sequence,content_signature,report)
        VALUES (${input.executionId}::uuid,${report.sequence},${contentSignature},${encoded}::jsonb)`);
      await publication.index(connection);
      await connection.execute(
        sql`SELECT pg_notify('progressive_remote_report_changed',${input.executionId})`,
      );
      return { receipt: { ...receipt, replayed: false } };
    });
    if (outcome.receipt) return outcome.receipt;
    const need = outcome.need!;
    const [stored] =
      await db.execute(sql`SELECT content_signature,resolve_progressive_report(to_jsonb(r.*)) AS report
      FROM progressive_remote_reports r WHERE sim_job_id=${input.executionId}::uuid AND sequence=${need.sequence}
      AND content_signature=${need.signature}`);
    if (!stored)
      throw new ProgressiveRemoteReportConflict(
        "Remote report predecessor changed before publication",
      );
    try {
      const full = await resolveStoredProgressiveReport(
        db,
        "remote",
        stored,
        input.executionId,
      );
      previous = { ...need, full };
    } catch (error) {
      throw new ProgressiveRemoteReportConflict(
        error instanceof Error ? error.message : "Invalid remote report order",
      );
    }
  }
}
