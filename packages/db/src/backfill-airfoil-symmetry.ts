import { isAirfoilSymmetric, type Point } from "@aerodb/core";
import { asc, eq } from "drizzle-orm";

import { createClient } from "./client";
import { airfoils } from "./schema";

// Backfills airfoils.isSymmetric + symmetryCheckedAt from the stored contour
// points (spec §9.1): a real geometric property computed by
// @aerodb/core isAirfoilSymmetric, never inferred from names.

const { db, sql } = createClient({ max: 1 });

let checked = 0;
let symmetric = 0;
let failed = 0;

try {
  const rows = await db
    .select({ id: airfoils.id, slug: airfoils.slug, points: airfoils.points })
    .from(airfoils)
    .orderBy(asc(airfoils.slug));

  for (const row of rows) {
    try {
      const result = isAirfoilSymmetric(row.points as Point[]);
      await db
        .update(airfoils)
        .set({ isSymmetric: result, symmetryCheckedAt: new Date() })
        .where(eq(airfoils.id, row.id));
      checked += 1;
      if (result) {
        symmetric += 1;
        console.log(`✓ ${row.slug}: symmetric`);
      }
    } catch (error) {
      failed += 1;
      console.error(`✗ ${row.slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`airfoil symmetry backfill complete: ${checked} checked, ${symmetric} symmetric, ${failed} failed`);
  if (failed) process.exitCode = 1;
} finally {
  await sql.end();
}
