import { randomUUID } from "node:crypto";
import { eq, sql as dsql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createClient, solverProfiles } from "../src";
import { createPointCorrection } from "../src/point-corrections";

const { db, sql } = createClient({ max: 1 });
const createdIds: string[] = [];

afterAll(async () => {
  for (const id of createdIds) {
    await db.delete(solverProfiles).where(eq(solverProfiles.id, id));
  }
  await sql.end();
});

describe("immutable point-scoped URANS initialization", () => {
  it("defaults to null and enforces an explicit 50..20000 iteration limit", async () => {
    const columns = await db.execute(dsql`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'solver_profiles'
        AND column_name = 'urans_initialization_iterations'
    `);
    expect([...columns]).toEqual([
      { is_nullable: "YES", column_default: null },
    ]);
    for (const iterations of [null, 50, 1200, 20_000]) {
      const [row] = await db
        .insert(solverProfiles)
        .values({
          slug: `init-migration-${randomUUID()}`,
          name: "Initialization migration fixture",
          uransInitializationIterations: iterations,
        })
        .returning();
      createdIds.push(row.id);
      expect(row.uransInitializationIterations).toBe(iterations);
      expect(row.nIterations).toBe(3000);
    }
    for (const invalid of [49, 20_001]) {
      await expect(
        db.insert(solverProfiles).values({
          slug: `init-migration-invalid-${randomUUID()}`,
          name: "Invalid initialization migration fixture",
          uransInitializationIterations: invalid,
        }),
      ).rejects.toThrow(
        /solver_profiles_urans_initialization_iterations_check/,
      );
    }
  });

  it.each([49, 20_001, 1200.5, Number.NaN])(
    "rejects direct correction input %s before reading source evidence",
    async (iterations) => {
      await expect(
        createPointCorrection(db, {
          resultId: randomUUID(),
          resultAttemptId: randomUUID(),
          fidelity: "precalc",
          mesh: {
            mesher: "blockmesh-cgrid",
            farfieldRadiusChords: 15,
            wakeLengthChords: 12,
            nSurface: 98,
            nRadial: 60,
            nWake: 45,
            targetYPlus: 26.6666666667,
            spanChords: 0.1,
          },
          solver: {
            turbulenceModel: "kOmegaSST",
            nIterations: 3000,
            uransInitializationIterations: iterations,
            convergenceTolerance: 1e-5,
            momentumScheme: "linearUpwind",
            transientCycles: 20,
            transientDiscardFraction: 0.4,
            transientMaxCourant: 0.5,
          },
        }),
      ).rejects.toThrow(/URANS initialization must be an integer/);
    },
  );
});
