import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { resultAttempts, resultClassifications, type DB } from "@aerodb/db";
import { settleProgressiveRemoteJob } from "../../sweeper/src/progressive-remote-settlement";
import { refreshPolarCacheForRevision } from "@aerodb/db/polar-cache";

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
  const expectedCache = async (connection: DB, count: number) => {
    expect(
      await connection.execute(sql`SELECT accepted_point_count FROM polar_fit_sets
      WHERE airfoil_id = ${attempt.airfoilId}::uuid
        AND simulation_preset_revision_id = ${attempt.simulationPresetRevisionId}::uuid
        AND is_current`),
    ).toEqual([{ accepted_point_count: count }]);
  };
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
  for (const ingested of [false, true]) {
    const rollback = new Error("Rollback exact accepted publication");
    await expect(
      db.transaction(async (raw) => {
        const connection = raw as unknown as DB;
        await connection.execute(sql`UPDATE results
        SET current_result_attempt_id = NULL
        WHERE id = ${attempt.resultId}::uuid`);
        if (ingested) {
          await connection.execute(sql`UPDATE sim_jobs
          SET status = 'done', engine_state = 'completed',
            "ingestedAt" = clock_timestamp(), "finishedAt" = clock_timestamp()
          WHERE id = ${executionId}::uuid`);
          await connection.execute(sql`UPDATE sync_sweep_promises SET status = 'expired'
          WHERE id = (SELECT promise_id FROM progressive_remote_dispatches
            WHERE sim_job_id = ${executionId}::uuid)`);
        }
        await refreshPolarCacheForRevision(
          connection,
          attempt.airfoilId,
          attempt.simulationPresetRevisionId!,
        );
        await expectedCache(connection, 0);
        const original = await connection
          .select()
          .from(resultAttempts)
          .where(eq(resultAttempts.id, resultAttemptId));
        expect(
          await settleProgressiveRemoteJob(connection, executionId),
        ).toMatchObject({ kind: "settled" });
        expect(
          await connection.execute(
            sql`SELECT current_result_attempt_id FROM results WHERE id = ${attempt.resultId}::uuid`,
          ),
        ).toEqual([{ current_result_attempt_id: resultAttemptId }]);
        await expectedCache(connection, 1);
        expect(
          await settleProgressiveRemoteJob(connection, executionId),
        ).toMatchObject({ kind: "settled" });
        await expectedCache(connection, 1);
        expect(
          await connection
            .select()
            .from(resultAttempts)
            .where(eq(resultAttempts.id, resultAttemptId)),
        ).toEqual(original);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  }
  for (const unavailable of ["archive", "excluded", "deferred"] as const) {
    const rollback = new Error(
      `Rollback unavailable publication ${unavailable}`,
    );
    await expect(
      db.transaction(async (raw) => {
        const connection = raw as unknown as DB;
        if (unavailable === "archive")
          await connection.execute(sql`DELETE FROM solver_evidence_archives
          WHERE result_attempt_id = ${resultAttemptId}::uuid`);
        else
          await connection.execute(sql`INSERT INTO result_review_verdicts(result_id, verdict, note, reviewer)
          VALUES (${attempt.resultId}::uuid, ${unavailable === "excluded" ? "exclude" : "defer"},
            'isolated publication guard', 'fixture')`);
        await settleProgressiveRemoteJob(connection, executionId);
        expect(
          await connection.execute(
            sql`SELECT current_result_attempt_id FROM results WHERE id = ${attempt.resultId}::uuid`,
          ),
        ).toEqual([{ current_result_attempt_id: null }]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  }
}
