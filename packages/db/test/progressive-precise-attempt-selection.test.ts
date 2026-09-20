import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";
import { progressiveCfdPreciseVerificationAvailableSql } from "../src/progressive-attempt-budget";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("preserves only unused precise allowances and exact never-started claims", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_units ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id,variant FROM unnest(ARRAY['missing','preliminary','unused','running',
        'cancelled-zero','cancelled-time','cancelled-evidence','cancelled-no-proof','cancelled-wrong-proof','settling']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_recovery_plans ON COMMIT DROP AS
      SELECT id,id AS unit_id,CASE WHEN variant='preliminary' THEN 1 ELSE 2 END AS ordinal
      FROM fixture_units WHERE variant<>'missing'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_attempts ON COMMIT DROP AS
      SELECT id AS token,id AS sim_job_id,CASE WHEN variant LIKE 'cancelled-%' THEN 'cancelled' ELSE 'running' END AS outcome,
        CASE WHEN variant='cancelled-time' THEN 1 ELSE 0 END::double precision AS active_seconds FROM fixture_units`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_recovery_claims ON COMMIT DROP AS
      SELECT id AS recovery_plan_id,id AS attempt_token FROM fixture_units WHERE variant NOT IN ('missing','unused','preliminary')`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_execution_stops ON COMMIT DROP AS
      SELECT id AS sim_job_id,jsonb_build_object('ownership_basis',
        CASE WHEN variant='cancelled-wrong-proof' THEN 'recorded_execution_namespace' ELSE 'never_started_cancellation_fence' END) AS proof
      FROM fixture_units WHERE variant<>'cancelled-no-proof'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_evidence ON COMMIT DROP AS
      SELECT id AS attempt_token FROM fixture_units WHERE variant='cancelled-evidence'`);
    const records = await transaction.execute(sql`
      SELECT unit.variant,${progressiveCfdPreciseVerificationAvailableSql()} AS available
      FROM fixture_units unit ORDER BY variant
    `);
    expect(records).toEqual([
      { variant: "cancelled-evidence", available: false },
      { variant: "cancelled-no-proof", available: false },
      { variant: "cancelled-time", available: false },
      { variant: "cancelled-wrong-proof", available: false },
      { variant: "cancelled-zero", available: true },
      { variant: "missing", available: false },
      { variant: "preliminary", available: false },
      { variant: "running", available: false },
      { variant: "settling", available: false },
      { variant: "unused", available: true },
    ]);
    const settling = await transaction.execute(sql`
      SELECT unit.variant,${progressiveCfdPreciseVerificationAvailableSql("unit", "attempt")} AS available
      FROM fixture_units unit JOIN progressive_cfd_attempts attempt ON attempt.token=unit.id
      WHERE unit.variant IN ('settling','cancelled-time','cancelled-evidence','cancelled-no-proof','cancelled-wrong-proof') ORDER BY variant
    `);
    expect(settling).toEqual([
      { variant: "cancelled-evidence", available: false },
      { variant: "cancelled-no-proof", available: false },
      { variant: "cancelled-time", available: false },
      { variant: "cancelled-wrong-proof", available: false },
      { variant: "settling", available: true },
    ]);
  });
});
