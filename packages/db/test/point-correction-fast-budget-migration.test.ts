import { randomUUID } from "node:crypto";

import { eq, sql as dsql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createClient, solverProfiles } from "../src";

const { db, sql } = createClient({ max: 1 });
const prefix = `fast-budget-migration-${process.pid}-${Date.now().toString(36)}`;
const createdIds: string[] = [];

afterAll(async () => {
  for (const id of createdIds) {
    await db.delete(solverProfiles).where(eq(solverProfiles.id, id));
  }
  await sql.end();
});

describe("migration 0102 experimental FAST budget", () => {
  it("defaults to null and enforces the immutable 4h..24h range", async () => {
    const columns = (await db.execute(dsql`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'solver_profiles'
        AND column_name = 'urans_precalc_budget_s'
    `)) as unknown as Array<{
      is_nullable: string;
      column_default: string | null;
    }>;
    expect(columns).toEqual([{ is_nullable: "YES", column_default: null }]);

    for (const budget of [null, 14_400, 86_400]) {
      const [row] = await db
        .insert(solverProfiles)
        .values({
          slug: `${prefix}-${budget ?? "default"}-${randomUUID()}`,
          name: `${prefix} ${budget ?? "default"}`,
          ...(budget == null ? {} : { uransPrecalcBudgetS: budget }),
        })
        .returning({
          id: solverProfiles.id,
          budget: solverProfiles.uransPrecalcBudgetS,
        });
      createdIds.push(row.id);
      expect(row.budget).toBe(budget);
    }

    for (const invalid of [14_399, 86_401]) {
      await expect(
        db.insert(solverProfiles).values({
          slug: `${prefix}-invalid-${invalid}-${randomUUID()}`,
          name: `${prefix} invalid ${invalid}`,
          uransPrecalcBudgetS: invalid,
        }),
      ).rejects.toThrow(/solver_profiles_urans_precalc_budget_s_check/);
    }
  });
});
