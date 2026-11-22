import { sql, type SQL } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import { readOriginalAttemptForProjection } from "./attempt-evidence-consumer-reader";

export interface PreparedPublicationHistory {
  id: string;
  archive_id: string;
  result_id: string;
  sim_job_id: string | null;
  original_text: string;
}

/** The caller runs this before opening a write transaction. Only cold rows
 * need an object read. The database checks the binding again at publication. */
export async function preparePublicationHistories(
  db: DB,
  where: SQL,
): Promise<PreparedPublicationHistory[]> {
  const rows = await db.execute<
    Omit<PreparedPublicationHistory, "original_text">
  >(sql`
    SELECT a.id, a.evidence_archive_id AS archive_id, a.result_id, a.sim_job_id
    FROM result_attempts a
    WHERE a.evidence_archive_id IS NOT NULL AND a.result_id IS NOT NULL AND (${where})
    ORDER BY a.id
  `);
  const documents: PreparedPublicationHistory[] = [];
  for (let start = 0; start < rows.length; start += 4) {
    const slice = rows.slice(start, start + 4);
    documents.push(
      ...(await Promise.all(
        slice.map(async (row) => ({
          ...row,
          original_text: await readOriginalAttemptForProjection(
            db,
            row.id,
            row.archive_id,
          ),
        })),
      )),
    );
  }
  return documents;
}

/** Joins at most one document to this exact attempt, job, result and archive. */
export function publicationHistoryJoin(
  attempt: SQL,
  documents: readonly PreparedPublicationHistory[],
): SQL {
  return sql`LEFT JOIN jsonb_to_recordset(${JSON.stringify(documents)}::jsonb)
    AS prepared_history(id uuid, archive_id uuid, result_id uuid, sim_job_id uuid, original_text text)
    ON prepared_history.id=${attempt}.id AND prepared_history.archive_id=${attempt}.evidence_archive_id
      AND prepared_history.result_id=${attempt}.result_id
      AND prepared_history.sim_job_id IS NOT DISTINCT FROM ${attempt}.sim_job_id`;
}

export function publicationHistoryPayload(attempt: SQL): SQL {
  return sql`CASE WHEN ${attempt}.evidence_archive_id IS NULL THEN ${attempt}.evidence_payload
    ELSE public.attempt_evidence_payload_for_publication(
      ${attempt}.id, prepared_history.archive_id, prepared_history.original_text
    ) END`;
}
