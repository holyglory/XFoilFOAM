import { sql } from "drizzle-orm";
import type { DB } from "./client";
import type { AttemptEvidenceProjection } from "./attempt-evidence-projection";

interface StoredProjection {
  result_attempt_id: string;
  archive_id: string;
  projection: AttemptEvidenceProjection | { shortFacts: unknown };
}

/** Ordinary stored projections need no second lookup. Resolve only the exact
 * compact pairs, using the same native 0207 owner checked at insert. */
export async function readAttemptProjections(
  db: DB,
  pairs: readonly { attemptId: string; archiveId: string }[],
): Promise<Map<string, AttemptEvidenceProjection>> {
  const result = new Map<string, AttemptEvidenceProjection>();
  if (!pairs.length) return result;
  const requested = (ids: typeof pairs) =>
    sql.join(
      ids.map((p) => sql`(${p.attemptId}::uuid,${p.archiveId}::uuid)`),
      sql`,`,
    );
  const rows = await db.execute<StoredProjection & Record<string, unknown>>(sql`
    SELECT result_attempt_id,archive_id,projection FROM attempt_evidence_history_projections
    WHERE (result_attempt_id,archive_id) IN (${requested(pairs)})`);
  const short: { attemptId: string; archiveId: string }[] = [];
  for (const row of rows) {
    if (!row.projection || typeof row.projection !== "object") continue;
    if ("shortFacts" in row.projection)
      short.push({
        attemptId: row.result_attempt_id,
        archiveId: row.archive_id,
      });
    else
      result.set(`${row.result_attempt_id}:${row.archive_id}`, row.projection);
  }
  if (short.length) {
    const expanded = await db.execute<{
      result_attempt_id: string;
      archive_id: string;
      projection: AttemptEvidenceProjection;
    }>(sql`
      SELECT result_attempt_id,archive_id,projection FROM attempt_evidence_read_projections
      WHERE (result_attempt_id,archive_id) IN (${requested(short)})`);
    for (const row of expanded)
      result.set(`${row.result_attempt_id}:${row.archive_id}`, row.projection);
  }
  return result;
}

/** The warm path retains the live native scope. A cold scope is always the
 * original immutable event's, including when its receipt uses the short format. */
export async function readAttemptWorkerReplayScope(
  db: DB,
  attemptId: string,
): Promise<unknown> {
  const [own] =
    await db.execute(sql`SELECT CASE WHEN a.evidence_archive_id IS NULL THEN attempt_evidence_hz_scope(a.id)
      ELSE e.verification#>'{dependencies,workerScope}' END AS scope,
      CASE WHEN e.verification?'shortReceipt' THEN e.id END AS short_event
    FROM result_attempts a LEFT JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id
      AND e.result_attempt_id=a.id AND e.archive_id=a.evidence_archive_id WHERE a.id=${attemptId}::uuid`);
  if (!own?.short_event) return own?.scope;
  const [expanded] =
    await db.execute(sql`SELECT e.verification#>'{dependencies,workerScope}' AS scope
    FROM result_attempts a JOIN attempt_evidence_read_events e ON e.id=a.evidence_storage_event_id AND e.archive_id=a.evidence_archive_id
      AND e.result_attempt_id=a.id WHERE a.id=${attemptId}::uuid AND e.id=${own.short_event}::uuid`);
  return expanded?.scope;
}

export async function readAttemptEventDependencies(
  db: DB,
  eventId: string,
  attemptId: string,
  archiveId: string,
) {
  const owner = sql`e.id=${eventId}::uuid AND e.result_attempt_id=${attemptId}::uuid AND e.archive_id=${archiveId}::uuid`;
  const [stored] =
    await db.execute(sql`SELECT e.verification->'dependencies' AS deps,e.verification?'shortReceipt' AS short
    FROM attempt_evidence_storage_events e WHERE ${owner}`);
  if (stored?.short !== true) return stored?.deps;
  const [full] = await db.execute(
    sql`SELECT e.verification->'dependencies' AS deps FROM attempt_evidence_read_events e WHERE ${owner}`,
  );
  return full?.deps;
}
