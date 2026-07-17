/** Test-only evidence fixtures shared by DB-backed integration suites.
 * Runtime code must never import this module. */
import { and, desc, eq, sql } from "drizzle-orm";

import type { DB } from "./client";
import { resultAttempts, resultClassifications, results } from "./schema";

/** Ensure a manual verify-queue fixture owns real immutable preliminary
 * attempt evidence. Legacy tests used to point only at the mutable results
 * container, which no longer represents a valid runnable verification. */
export async function createAcceptedPrecalcAttemptFixture(
  db: DB,
  resultId: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: resultAttempts.id })
    .from(resultAttempts)
    .innerJoin(
      resultClassifications,
      eq(resultClassifications.resultAttemptId, resultAttempts.id),
    )
    .where(
      and(
        eq(resultAttempts.resultId, resultId),
        eq(resultAttempts.status, "done"),
        eq(resultAttempts.source, "solved"),
        sql`${resultAttempts.evidencePayload} ->> 'fidelity' = 'urans_precalc'`,
        eq(resultClassifications.state, "accepted"),
      ),
    )
    .orderBy(desc(resultAttempts.createdAt), desc(resultAttempts.id))
    .limit(1);
  if (existing) return existing.id;

  const [result] = await db
    .select()
    .from(results)
    .where(eq(results.id, resultId))
    .limit(1);
  if (!result?.simulationPresetRevisionId) {
    throw new Error(
      `test preliminary attempt fixture requires revision-owned result ${resultId}`,
    );
  }
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: result.id,
      airfoilId: result.airfoilId,
      bcId: result.bcId,
      simulationPresetRevisionId: result.simulationPresetRevisionId,
      aoaDeg: result.aoaDeg,
      status: "done",
      source: "solved",
      regime: result.regime ?? "urans",
      validForPolar: true,
      cl: result.cl,
      cd: result.cd,
      cm: result.cm,
      clCd: result.clCd,
      clStd: result.clStd,
      cdStd: result.cdStd,
      cmStd: result.cmStd,
      converged: result.converged,
      unsteady: result.unsteady,
      evidencePayload: { fidelity: "urans_precalc", test_fixture: true },
      solvedAt: result.solvedAt ?? new Date(),
    })
    .returning({ id: resultAttempts.id });
  await db.insert(resultClassifications).values({
    resultId: null,
    resultAttemptId: attempt.id,
    airfoilId: result.airfoilId,
    simulationPresetRevisionId: result.simulationPresetRevisionId,
    aoaDeg: result.aoaDeg,
    regime: result.regime ?? "urans",
    classifierVersion: "test-fixture-exact-precalc-v1",
    state: "accepted",
    region: "unknown",
    confidence: 1,
    reasons: [],
  });
  return attempt.id;
}
