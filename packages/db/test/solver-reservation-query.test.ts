import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";
import {
  solverCpuReservationSql,
  solverCpuReservedJobIdsSql,
} from "../src/solver-reservations";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("conserves every legacy, CFD and worker reservation across lifecycle and stop-proof combinations", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT md5(concat_ws(':',state,engine_state,owner,proof,engine_kind))::uuid AS id,
        state AS status,engine_state,owner,proof,engine_kind,
        CASE engine_kind WHEN 'none' THEN NULL WHEN 'foreign' THEN 'foreign-engine'
          ELSE md5(concat_ws(':',state,engine_state,owner,proof,engine_kind))::uuid::text END AS engine_job_id
      FROM unnest(ARRAY['pending','submitted','running','ingesting','done','failed','cancelled']) state
      CROSS JOIN unnest(ARRAY[NULL::text,'submitting','submission_cancel_pending','submission_identity_conflict','cancelling','cancel_pending','cancelled']) engine_state
      CROSS JOIN unnest(ARRAY['legacy','cfd','worker','both']) owner
      CROSS JOIN unnest(ARRAY['none','both','cfd','worker','wrong']) proof
      CROSS JOIN unnest(ARRAY['none','exact','foreign']) engine_kind`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_attempts ON COMMIT DROP AS
      SELECT id AS sim_job_id FROM sim_jobs WHERE owner IN ('cfd','both')
      UNION ALL SELECT id FROM sim_jobs WHERE owner='cfd'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_submission_intents ON COMMIT DROP AS
      SELECT id AS sim_job_id,'owned-signature'::text AS assignment_signature FROM sim_jobs WHERE owner IN ('worker','both')`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_execution_stops ON COMMIT DROP AS
      SELECT id AS sim_job_id,CASE WHEN proof='wrong' THEN 'unrelated-engine' ELSE engine_job_id END AS engine_job_id
      FROM sim_jobs WHERE proof IN ('both','cfd','wrong')`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_reports ON COMMIT DROP AS
      SELECT id AS sim_job_id,CASE WHEN proof='wrong' THEN 'unrelated-signature' ELSE 'owned-signature' END AS assignment_signature,
        id::text AS stopped_engine_job_id FROM sim_jobs WHERE proof IN ('both','worker','wrong')`);
    const rows = await transaction.execute(sql`SELECT job.*,
      ${solverCpuReservationSql("job")} AS original,
      job.id IN (${solverCpuReservedJobIdsSql()}) AS candidate FROM sim_jobs job`);
    expect(rows).toHaveLength(2940);
    for (const row of rows) {
      let expected: boolean;
      if (row.owner === "cfd" || row.owner === "both") {
        expected = !(
          row.engine_kind !== "none" &&
          ["both", "cfd"].includes(String(row.proof))
        );
      } else if (row.owner === "worker") {
        expected =
          row.engine_kind === "foreign" ||
          !["both", "worker"].includes(String(row.proof));
      } else {
        expected =
          ["submitted", "running", "ingesting"].includes(String(row.status)) ||
          (row.status === "pending" &&
            [
              "submitting",
              "submission_cancel_pending",
              "submission_identity_conflict",
            ].includes(String(row.engine_state))) ||
          (row.status === "cancelled" &&
            ["cancelling", "cancel_pending"].includes(
              String(row.engine_state),
            ));
      }
      expect(row.original === true, JSON.stringify(row)).toBe(expected);
      expect(row.candidate === true, JSON.stringify(row)).toBe(expected);
    }
    const [counts] =
      await transaction.execute(sql`WITH selected AS (${solverCpuReservedJobIdsSql()})
      SELECT count(*)::int AS total,count(DISTINCT id)::int AS unique FROM selected`);
    expect(counts.total).toBe(counts.unique);
    expect(Number(counts.total)).toBeGreaterThan(0);
    expect(Number(counts.total)).toBeLessThan(rows.length);
  });
});
