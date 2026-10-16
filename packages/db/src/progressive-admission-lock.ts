import { sql } from "drizzle-orm";
import type { DB } from "./client";

export async function tryProgressiveAdmissionLock(db: DB): Promise<boolean> {
  const [row] = await db.execute(sql`
    SELECT pg_try_advisory_xact_lock(
      hashtextextended('progressive-cfd-admission', 0)
    ) AS acquired
  `);
  return Boolean(row?.acquired);
}

export async function acquireProgressiveAdmissionLock(db: DB): Promise<void> {
  await db.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended('progressive-cfd-admission', 0)
    )
  `);
}
