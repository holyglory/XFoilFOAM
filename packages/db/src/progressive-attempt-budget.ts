import { sql } from "drizzle-orm";

export function progressiveCfdOrdinaryAttemptCountSql(alias = "unit") {
  const unit = sql.identifier(alias);
  return sql`(${unit}.attempts - CASE WHEN EXISTS (
    SELECT 1 FROM progressive_publication_recovery_claims correction WHERE correction.unit_id=${unit}.id
  ) THEN 1 ELSE 0 END)`;
}
