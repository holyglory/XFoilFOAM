import { type DB, results } from "@aerodb/db";
import { sql } from "drizzle-orm";

/**
 * Claim AoA points for a job before submitting. A fresh insert always claims;
 * an existing row is claimed only if pending/stale (the ON CONFLICT WHERE
 * guard) — rows already queued/running/done/failed are left in place until an
 * admin explicitly requeues failed evidence back to pending.
 * Returns the AoAs actually claimed.
 */
export async function claimAoas(
  db: DB,
  airfoilId: string,
  bcId: string,
  presetRevisionId: string,
  aoas: number[],
  simJobId: string,
): Promise<number[]> {
  const claimed: number[] = [];
  for (const aoa of aoas) {
    const rows = await db
      .insert(results)
      .values({ airfoilId, bcId, simulationPresetRevisionId: presetRevisionId, aoaDeg: aoa, status: "queued", source: "queued", simJobId })
      .onConflictDoUpdate({
        target: [results.airfoilId, results.simulationPresetRevisionId, results.aoaDeg],
        set: { status: "queued", source: "queued", simJobId },
        setWhere: sql`${results.status} in ('pending','stale')`,
      })
      .returning({ id: results.id });
    if (rows.length) claimed.push(aoa);
  }
  return claimed;
}
