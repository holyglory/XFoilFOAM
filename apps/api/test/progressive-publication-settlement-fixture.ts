import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { resultAttempts, resultClassifications, type DB } from "@aerodb/db";
import { settleProgressiveRemoteJob } from "../../sweeper/src/progressive-remote-settlement";

export async function verifyProgressivePublicationPrecedence(
  db: DB,
  executionId: string,
  resultAttemptId: string,
) {
  const [attempt] = await db
    .select()
    .from(resultAttempts)
    .where(eq(resultAttempts.id, resultAttemptId));
  const [classification] = await db
    .select()
    .from(resultClassifications)
    .where(eq(resultClassifications.resultAttemptId, resultAttemptId));
  expect(attempt.regime).toBe("rans");
  expect(classification.state).toBe("accepted");
  for (const scenario of [
    "same-rank",
    "provisional",
    "higher-accepted",
  ] as const) {
    const rollback = new Error(
      `Rollback isolated publication precedence ${scenario}`,
    );
    await expect(
      db.transaction(async (raw) => {
        const connection = raw as unknown as DB;
        const selectedId = randomUUID();
        const regime = scenario === "same-rank" ? "rans" : "urans";
        await connection.insert(resultAttempts).values({
          ...attempt,
          id: selectedId,
          simJobId: null,
          engineJobId: `isolated-precedence-${selectedId}`,
          regime,
          unsteady: regime === "urans",
          evidencePayload: {
            ...(attempt.evidencePayload as Record<string, unknown>),
            fidelity: regime === "urans" ? "urans_full" : "rans",
          },
        });
        await connection.insert(resultClassifications).values({
          ...classification,
          id: randomUUID(),
          resultId: null,
          resultAttemptId: selectedId,
          regime,
          state: scenario === "provisional" ? "needs_urans" : "accepted",
        });
        await connection.execute(sql`UPDATE results SET current_result_attempt_id = ${selectedId}::uuid
        WHERE id = ${attempt.resultId}::uuid`);
        const settlement = await settleProgressiveRemoteJob(
          connection,
          executionId,
        );
        expect(settlement).toMatchObject(
          scenario === "higher-accepted"
            ? { kind: "settled", counts: { complete: 1, waiting: 0 } }
            : { kind: "waiting", reason: "accepted_point_publication" },
        );
        const [selected] = await connection.execute(
          sql`SELECT current_result_attempt_id FROM results WHERE id = ${attempt.resultId}::uuid`,
        );
        expect(selected.current_result_attempt_id).toBe(selectedId);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  }
}
