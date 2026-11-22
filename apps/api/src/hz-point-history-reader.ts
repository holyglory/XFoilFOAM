import { hasExactHzHistoryReceipt } from "@aerodb/db/hz-point-history-storage";
import type { DB } from "@aerodb/db/client";
import { sql } from "drizzle-orm";
import {
  readPointHistoryWorkingCopy,
  type PointHistoryIdentity,
} from "@aerodb/core/point-history-working-copy";
/** Used by both existing API readers and the operator's pre-compaction probe.
 * This role never constructs a GCS client or follows an upstream fetch URL. */
export async function readHzPointHistory(
  db: DB,
  identity: PointHistoryIdentity,
) {
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver")
    throw new Error("Expected HZ API reader role");
  const [settings] = await db.execute(
    sql`SELECT instance_id::text AS id FROM sync_api_settings WHERE id=1`,
  );
  if (
    settings?.id !== identity.sourceInstance &&
    !(await hasExactHzHistoryReceipt(db, identity))
  )
    throw new Error("History working copy belongs to another instance");
  try {
    return await readPointHistoryWorkingCopy(identity);
  } catch {
    throw Object.assign(
      new Error(
        "Stored point history working copy is unavailable or failed verification",
      ),
      { statusCode: 503 },
    );
  }
}
