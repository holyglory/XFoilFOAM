import { sql, type SQL } from "drizzle-orm";
import { analysisContentHash } from "./analysis-target";
import { archivedAttemptApplicationSha256Sql } from "./attempt-receipt-source";

/** Return the PG-verified archive digest for a cold source. Only consumers
 * which also inspect retained scalar fields need the compact JSON value. */
export function attemptDigestColumns(
  attempt: SQL,
  retainMetadata = false,
): SQL {
  const value = retainMetadata
    ? sql`${attempt}.evidence_payload`
    : sql`CASE WHEN ${attempt}.evidence_archive_id IS NULL THEN ${attempt}.evidence_payload END`;
  return sql`${value} AS evidence_payload, ${attempt}.evidence_archive_id,
    ${archivedAttemptApplicationSha256Sql(attempt)} AS archived_application_sha256`;
}

export function originalAttemptDigest(row: {
  evidence_payload?: unknown;
  evidence_archive_id?: unknown;
  archived_application_sha256?: unknown;
}): string | null {
  if (row.evidence_archive_id === null)
    return analysisContentHash(row.evidence_payload);
  return typeof row.evidence_archive_id === "string" &&
    typeof row.archived_application_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(row.archived_application_sha256)
    ? row.archived_application_sha256
    : null;
}

/** A missing candidate or missing archive proof cannot equal a missing receipt. */
export function matchesOriginalAttemptDigest(
  row: Parameters<typeof originalAttemptDigest>[0],
  expected: unknown,
): boolean {
  return (
    typeof expected === "string" &&
    /^[a-f0-9]{64}$/.test(expected) &&
    originalAttemptDigest(row) === expected
  );
}
