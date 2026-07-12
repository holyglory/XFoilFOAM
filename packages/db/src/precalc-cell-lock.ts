import { canonicalAoa } from "@aerodb/core";
import { sql } from "drizzle-orm";

import type { DB } from "./client";

export interface PrecalcCellLockKey {
  airfoilId: string;
  revisionId: string;
  aoaDeg: number;
}

type CellLockClient = Pick<DB, "execute">;

/**
 * Serialize every operation which can move a natural solver cell between the
 * ordinary RANS queue and the physical PRECALC ledger. Callers must already be
 * inside the transaction that performs the subsequent recheck/mutation.
 *
 * Keys are deduplicated and sorted before acquisition. The recursive CTE makes
 * the lock order explicit for batches, avoiding two bulk operations taking the
 * same cell set in opposite orders.
 */
export async function lockPrecalcCells(
  tx: CellLockClient,
  cells: PrecalcCellLockKey[],
): Promise<void> {
  const keys = [
    ...new Set(
      cells.map(
        (cell) =>
          `precalc-cell:${cell.airfoilId}:${cell.revisionId}:${canonicalAoa(cell.aoaDeg)}`,
      ),
    ),
  ].sort();
  if (!keys.length) return;
  const keyArray = sql`ARRAY[${sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `,
  )}]::text[]`;
  await tx.execute(sql`
    WITH RECURSIVE ordered AS (
      SELECT row_number() OVER (ORDER BY cell_key)::int AS n, cell_key
      FROM unnest(${keyArray}) AS cell_key
    ), acquired AS (
      SELECT ordered.n,
             pg_advisory_xact_lock(hashtextextended(ordered.cell_key, 0)) AS locked
      FROM ordered
      WHERE ordered.n = 1
      UNION ALL
      SELECT ordered.n,
             pg_advisory_xact_lock(hashtextextended(ordered.cell_key, 0)) AS locked
      FROM acquired
      JOIN ordered ON ordered.n = acquired.n + 1
    )
    SELECT count(*) FROM acquired
  `);
}
