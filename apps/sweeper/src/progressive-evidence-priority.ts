import { sql } from "drizzle-orm";

export function progressiveEvidencePriority(preferActive: boolean) {
  return sql`CASE WHEN ${preferActive} AND promise.status='active'
    AND promise."expiresAt">clock_timestamp() THEN 0 ELSE 1 END`;
}
