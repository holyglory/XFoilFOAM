import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PROGRESSIVE_COMPUTE_POLICY } from "@aerodb/core";
import { createClient, type DB } from "../src/client";
import { progressiveCfdOrdinaryAttemptCountSql } from "../src/progressive-attempt-budget";
import { recoverTerminalProgressiveNoEvidenceGaps } from "../src/progressive-cfd-recovery";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("counts only exact proven unstarted cancellations without scanning unrelated attempt history", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_units ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id,variant FROM unnest(ARRAY['fresh','valid-zero-work','missing-stop',
        'wrong-stop','had-time','has-evidence','failed','running','publication-correction','combined-correction']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_units ON COMMIT DROP AS
      SELECT id,CASE WHEN variant='fresh' THEN 0 ELSE 2 END AS attempts,0 AS ordinal FROM fixture_units`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_units_id_idx ON progressive_cfd_units(id)`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_attempts ON COMMIT DROP AS
      SELECT id AS token,id AS unit_id,id AS sim_job_id,
        CASE WHEN variant IN ('failed','running') THEN variant ELSE 'cancelled' END AS outcome,
        CASE WHEN variant='had-time' THEN 1 ELSE 0 END::double precision AS active_seconds
      FROM fixture_units WHERE variant NOT IN ('fresh','publication-correction')`);
    await transaction.execute(sql`CREATE UNIQUE INDEX fixture_attempt_job_unit_idx
      ON progressive_cfd_attempts(sim_job_id,unit_id) WHERE sim_job_id IS NOT NULL`);
    await transaction.execute(sql`CREATE UNIQUE INDEX fixture_attempt_running_idx
      ON progressive_cfd_attempts(unit_id) WHERE outcome='running'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_execution_stops ON COMMIT DROP AS
      SELECT id AS sim_job_id,jsonb_build_object('ownership_basis',
        CASE WHEN variant='wrong-stop' THEN 'execution_lock' ELSE 'never_started_cancellation_fence' END) AS proof
      FROM fixture_units WHERE variant<>'missing-stop'`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_stops_idx ON progressive_cfd_execution_stops(sim_job_id)`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_evidence ON COMMIT DROP AS
      SELECT id AS attempt_token FROM fixture_units WHERE variant='has-evidence'`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_evidence_idx ON progressive_cfd_evidence(attempt_token)`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE progressive_publication_recovery_claims ON COMMIT DROP AS
      SELECT id AS unit_id FROM fixture_units WHERE variant IN ('publication-correction','combined-correction')`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_publication_claims_idx ON progressive_publication_recovery_claims(unit_id)`,
    );
    const counts = () =>
      transaction.execute(sql`SELECT fixture.variant,${progressiveCfdOrdinaryAttemptCountSql()} AS ordinary
      FROM progressive_cfd_units unit JOIN fixture_units fixture ON fixture.id=unit.id ORDER BY fixture.variant`);
    const expected = [
      { variant: "combined-correction", ordinary: 0 },
      { variant: "failed", ordinary: 2 },
      { variant: "fresh", ordinary: 0 },
      { variant: "had-time", ordinary: 2 },
      { variant: "has-evidence", ordinary: 2 },
      { variant: "missing-stop", ordinary: 2 },
      { variant: "publication-correction", ordinary: 1 },
      { variant: "running", ordinary: 2 },
      { variant: "valid-zero-work", ordinary: 1 },
      { variant: "wrong-stop", ordinary: 2 },
    ];
    expect(await counts()).toEqual(expected);
    // The shortcut is valid even with publication and exact never-started
    // corrections: both subtract nonnegative values from the raw counter.
    // Exercise the real history subqueries over every counter through its cap.
    const equivalence = await transaction.execute(sql`
      SELECT fixture.variant, sample.attempts,
        sample.attempts - original.attempts + ${progressiveCfdOrdinaryAttemptCountSql()} AS ordinary,
        (sample.attempts < 4 AND
          sample.attempts - original.attempts + ${progressiveCfdOrdinaryAttemptCountSql()} < 2) AS original_available,
        CASE WHEN sample.attempts < 2 THEN true ELSE (sample.attempts < 4 AND
          sample.attempts - original.attempts + ${progressiveCfdOrdinaryAttemptCountSql()} < 2) END AS shortcut_available
      FROM progressive_cfd_units unit JOIN fixture_units fixture ON fixture.id=unit.id
      JOIN progressive_cfd_units original ON original.id=unit.id
      CROSS JOIN generate_series(0,5) sample(attempts)
      ORDER BY fixture.variant,sample.attempts
    `);
    expect(equivalence).toHaveLength(expected.length * 6);
    for (const row of equivalence) {
      expect(row.shortcut_available, `${row.variant}: raw ${row.attempts}, ordinary ${row.ordinary}`)
        .toBe(row.original_available);
      if (Number(row.attempts) < 2) expect(row.shortcut_available).toBe(true);
    }
    await transaction.execute(sql`INSERT INTO progressive_cfd_units(id,attempts,ordinal)
      SELECT md5('pending-'||ordinal)::uuid,0,0 FROM generate_series(1,64000) ordinal`);
    await transaction.execute(sql`INSERT INTO progressive_cfd_attempts(token,unit_id,sim_job_id,outcome,active_seconds)
      SELECT md5('history-'||ordinal)::uuid,md5('history-'||ordinal)::uuid,md5('job-'||ordinal)::uuid,
        CASE WHEN ordinal%3=0 THEN 'running' WHEN ordinal%3=1 THEN 'cancelled' ELSE 'failed' END,
        CASE WHEN ordinal%3=0 THEN 0 ELSE 1 END FROM generate_series(1,6000) ordinal`);
    await transaction.execute(sql`ANALYZE progressive_cfd_units,progressive_cfd_attempts,progressive_cfd_execution_stops,
      progressive_cfd_evidence,progressive_publication_recovery_claims,fixture_units`);
    const explain = async () => {
      const [explained] =
        await transaction.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
        SELECT unit.id FROM progressive_cfd_units unit WHERE ${progressiveCfdOrdinaryAttemptCountSql()}<2
        ORDER BY unit.ordinal,unit.id LIMIT 1`);
      return (explained["QUERY PLAN"] as Array<Record<string, unknown>>)[0];
    };
    const baseline = await explain();
    const [index] =
      await transaction.execute(sql`SELECT indisvalid,pg_get_indexdef(indexrelid) AS definition
      FROM pg_index WHERE indexrelid='public.progressive_cfd_attempts_unstarted_idx'::regclass`);
    expect(index.indisvalid).toBe(true);
    const definition = String(index.definition)
      .replace(
        "progressive_cfd_attempts_unstarted_idx",
        "fixture_unstarted_idx",
      )
      .replace("public.progressive_cfd_attempts", "progressive_cfd_attempts");
    await transaction.execute(sql.raw(definition));
    await transaction.execute(sql`ANALYZE progressive_cfd_attempts`);
    expect(await counts()).toEqual(expected);
    const indexed = await explain();
    const nodes: Array<Record<string, unknown>> = [];
    const visit = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>)
        visit(child);
    };
    visit(indexed.Plan as Record<string, unknown>);
    const lookup = nodes.find(
      (node) => node["Index Name"] === "fixture_unstarted_idx",
    );
    expect(lookup).toBeDefined();
    expect(
      nodes.some(
        (node) =>
          node["Relation Name"] === "progressive_cfd_attempts" &&
          node["Node Type"] === "Seq Scan",
      ),
    ).toBe(false);
    const baselineBuffers = Number(
      (baseline.Plan as Record<string, unknown>)["Local Hit Blocks"],
    );
    const indexedBuffers = Number(
      (indexed.Plan as Record<string, unknown>)["Local Hit Blocks"],
    );
    expect(indexedBuffers).toBeLessThan(baselineBuffers / 4);
    console.info(
      JSON.stringify({
        pendingUnits: 64010,
        storedAttempts: 6008,
        baselineMs: baseline["Execution Time"],
        indexedMs: indexed["Execution Time"],
        baselineBuffers,
        indexedBuffers,
        lookup: {
          type: lookup?.["Node Type"],
          rows: lookup?.["Actual Rows"],
          loops: lookup?.["Actual Loops"],
        },
      }),
    );
  });
}, 120000);

it("recovers actionable terminal gaps beyond a full page of pending and exhausted units without changing protected work", async () => {
  await client.db.transaction(async (transaction) => {
    const db = transaction as unknown as DB;
    const failure = "terminal execution has no measured case evidence";
    const retry =
      "Retrying after terminal execution without measurable case evidence";
    for (const table of [
      "progressive_cfd_budget_extensions",
      "progressive_cfd_recovery_plans",
      "progressive_cfd_recovery_claims",
      "progressive_publication_recoveries",
      "progressive_publication_recovery_claims",
      "registered_remote_solvers",
      "progressive_remote_reports",
      "progressive_remote_report_inventories",
      "progressive_remote_report_sources",
    ]) {
      await transaction.execute(
        sql.raw(`CREATE TEMP TABLE ${table}
        (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`),
      );
    }
    for (const definition of [
      "calculation_epochs (id uuid PRIMARY KEY, current boolean)",
      "sim_campaigns (id uuid PRIMARY KEY, status text, current_plan_revision_id uuid)",
      "campaign_progressive_execution_policies (campaign_id uuid, policy text)",
      "progressive_generations (id uuid PRIMARY KEY, campaign_id uuid, epoch_id uuid, plan_revision_id uuid, status text, stage integer)",
      "progressive_generation_cohorts (generation_id uuid, cohort text, stage integer)",
      "progressive_generation_cohort_targets (generation_id uuid, target_id text, cohort text)",
      "progressive_generation_targets (generation_id uuid, target_id text, recipes jsonb)",
      "progressive_work (id uuid PRIMARY KEY, generation_id uuid, target_id text, stage integer, state text, error text, completed_at timestamptz)",
      "progressive_cfd_units (id uuid PRIMARY KEY, work_id uuid, state text, error text, attempts integer, ordinal integer, aoa_deg double precision, purpose text, policy_version text, active_seconds double precision, active_budget_seconds double precision, lease_token uuid, lease_owner text, lease_until timestamptz, retry_after timestamptz, recipe jsonb)",
      'sim_jobs (id uuid PRIMARY KEY, campaign_id uuid, engine_job_id text, status text, engine_state text, request_payload jsonb, "updatedAt" timestamptz)',
      "progressive_cfd_attempts (token uuid PRIMARY KEY, unit_id uuid, sim_job_id uuid, outcome text, active_seconds double precision, error text, started_at timestamptz, finished_at timestamptz)",
      "progressive_cfd_execution_stops (sim_job_id uuid, engine_job_id text, proof jsonb)",
      "progressive_cfd_evidence (attempt_token uuid, result_attempt_id uuid)",
      "result_attempts (id uuid PRIMARY KEY, result_id uuid, cl double precision, cd double precision, cm double precision)",
      "result_classifications (result_attempt_id uuid, result_id uuid, state text)",
      "progressive_remote_dispatches (sim_job_id uuid, promise_id uuid, content_signature text)",
      "sync_sweep_promises (id uuid PRIMARY KEY, status text)",
    ]) {
      await transaction.execute(
        sql.raw(`CREATE TEMP TABLE ${definition} ON COMMIT DROP`),
      );
    }
    await transaction.execute(sql`CREATE TEMP TABLE recovery_fixture ON COMMIT DROP AS
      SELECT fixture.*,
        (lpad(category::text,8,'0') || '-0000-4000-8000-' || lpad(ordinal::text,12,'0'))::uuid AS id,
        md5(variant || ordinal || '-work')::uuid AS work_id,
        md5(variant || ordinal || '-generation')::uuid AS generation_id,
        variant || ordinal AS target_id
      FROM (
        SELECT 1 AS category,'pending-noop'::text AS variant,ordinal FROM generate_series(1,65) ordinal
        UNION ALL SELECT 2,'exhausted-gap',ordinal FROM generate_series(1,65) ordinal
        UNION ALL SELECT 99,'eligible-gap',ordinal FROM generate_series(1,66) ordinal
        UNION ALL SELECT 3,'pending-cleanup',1
        UNION ALL SELECT 4,'accepted-history',1
        UNION ALL SELECT 5,'new-owner',1
        UNION ALL SELECT 6,'missing-stop',1
        UNION ALL SELECT 7,'active-promise',1
        UNION ALL SELECT 8,'old-plan',1
        UNION ALL SELECT 9,'old-epoch',1
        UNION ALL SELECT 10,'wrong-cohort',1
        UNION ALL SELECT 11,'precise-live',1
      ) fixture`);
    await transaction.execute(sql`INSERT INTO calculation_epochs VALUES
      (md5('current-epoch')::uuid,true),(md5('old-epoch')::uuid,false)`);
    await transaction.execute(sql`INSERT INTO sim_campaigns VALUES
      (md5('recovery-campaign')::uuid,'active',md5('current-plan')::uuid)`);
    await transaction.execute(sql`INSERT INTO campaign_progressive_execution_policies VALUES
      (md5('recovery-campaign')::uuid,'subsonic-through-precise-v1')`);
    await transaction.execute(sql`INSERT INTO progressive_generations
      SELECT generation_id,md5('recovery-campaign')::uuid,
        md5(CASE WHEN variant='old-epoch' THEN 'old-epoch' ELSE 'current-epoch' END)::uuid,
        md5(CASE WHEN variant='old-plan' THEN 'old-plan' ELSE 'current-plan' END)::uuid,
        'active',2 FROM recovery_fixture`);
    await transaction.execute(sql`INSERT INTO progressive_generation_cohorts
      SELECT generation_id,'low',2 FROM recovery_fixture
      UNION ALL SELECT generation_id,'high',1 FROM recovery_fixture`);
    await transaction.execute(sql`INSERT INTO progressive_generation_cohort_targets
      SELECT generation_id,target_id,CASE WHEN variant='wrong-cohort' THEN 'high' ELSE 'low' END
      FROM recovery_fixture`);
    const recipes = {
      fast: { recipeId: "sealed-fast", solverProcesses: 2, cpuBudget: 8 },
      precise: { recipeId: "sealed-precise", solverProcesses: 4, maxCo: 0.4 },
    };
    await transaction.execute(sql`INSERT INTO progressive_generation_targets
      SELECT generation_id,target_id,${JSON.stringify(recipes)}::jsonb FROM recovery_fixture`);
    await transaction.execute(sql`INSERT INTO progressive_work
      SELECT work_id,generation_id,target_id,CASE WHEN variant='precise-live' THEN 3 ELSE 2 END,
        CASE WHEN variant IN ('pending-noop','pending-cleanup') THEN 'pending'
          WHEN variant IN ('new-owner','precise-live') THEN 'leased' ELSE 'gap' END,
        ${failure},NULL::timestamptz FROM recovery_fixture`);
    await transaction.execute(sql`INSERT INTO progressive_cfd_units
      SELECT fixture.id,work_id,work.state,
        CASE WHEN variant IN ('pending-noop','pending-cleanup') THEN ${retry} ELSE ${failure} END,
        1,ordinal,0.0,CASE WHEN variant='precise-live' THEN 'precise' ELSE 'initial' END,${PROGRESSIVE_COMPUTE_POLICY.version},
        CASE WHEN variant IN ('exhausted-gap','pending-cleanup') THEN 900.0 ELSE 107.0 END,900.0,
        CASE WHEN variant IN ('new-owner','precise-live') THEN fixture.id ELSE NULL::uuid END,
        CASE WHEN variant IN ('new-owner','precise-live') THEN 'live-owner' ELSE NULL::text END,
        CASE WHEN variant IN ('new-owner','precise-live') THEN clock_timestamp()+interval '1 hour' ELSE NULL::timestamptz END,
        NULL::timestamptz,
        ${JSON.stringify(recipes)}::jsonb->CASE WHEN variant='precise-live' THEN 'precise' ELSE 'fast' END
      FROM recovery_fixture fixture JOIN progressive_work work ON work.id=fixture.work_id`);
    await transaction.execute(sql`INSERT INTO sim_jobs
      SELECT fixture.id,md5('recovery-campaign')::uuid,fixture.id::text,
        CASE WHEN variant IN ('new-owner','precise-live') THEN 'running' ELSE 'cancelled' END,
        CASE WHEN variant IN ('new-owner','precise-live') THEN 'running' ELSE 'cancelled' END,
        jsonb_build_object('recipe',unit.recipe),clock_timestamp()-interval '1 hour'
      FROM recovery_fixture fixture JOIN progressive_cfd_units unit ON unit.id=fixture.id`);
    await transaction.execute(sql`INSERT INTO progressive_cfd_attempts
      SELECT id,id,id,CASE WHEN variant IN ('new-owner','precise-live') THEN 'running' ELSE 'failed' END,
        0,${failure},clock_timestamp()-interval '1 hour',
        CASE WHEN variant IN ('new-owner','precise-live') THEN NULL::timestamptz ELSE clock_timestamp() END
      FROM recovery_fixture`);
    await transaction.execute(sql`INSERT INTO progressive_cfd_execution_stops
      SELECT id,id::text,jsonb_build_object('version',1,'job_id',id::text,
        'execution_stopped',true,'producer_stopped',true,'namespace_verified',true,
        'remaining','[]'::jsonb,'error',NULL,'fence','cancel_marker',
        'ownership_basis','recorded_execution_namespace')
      FROM recovery_fixture WHERE variant NOT IN ('missing-stop','new-owner','precise-live')`);
    await transaction.execute(sql`INSERT INTO result_attempts
      SELECT id,id,0.1,0.02,0.0 FROM recovery_fixture WHERE variant='accepted-history'`);
    await transaction.execute(sql`INSERT INTO result_classifications
      SELECT id,id,'accepted' FROM recovery_fixture WHERE variant='accepted-history'`);
    await transaction.execute(sql`INSERT INTO progressive_cfd_attempts
      SELECT md5(id::text)::uuid,id,id,'complete',82,NULL,
        clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour'
      FROM recovery_fixture WHERE variant='accepted-history'`);
    await transaction.execute(sql`INSERT INTO progressive_cfd_evidence
      SELECT md5(id::text)::uuid,id FROM recovery_fixture WHERE variant='accepted-history'`);
    await transaction.execute(sql`INSERT INTO sync_sweep_promises
      SELECT id,'active' FROM recovery_fixture WHERE variant='active-promise'`);
    await transaction.execute(sql`INSERT INTO progressive_remote_dispatches
      SELECT id,id,repeat('a',64) FROM recovery_fixture WHERE variant='active-promise'`);
    const immutable = async () => ({
      protectedUnits: await transaction.execute(sql`SELECT unit.*
        FROM progressive_cfd_units unit JOIN recovery_fixture fixture ON fixture.id=unit.id
        WHERE fixture.variant NOT IN ('eligible-gap','pending-cleanup') ORDER BY unit.id`),
      protectedWork: await transaction.execute(sql`SELECT work.*
        FROM progressive_work work JOIN recovery_fixture fixture ON fixture.work_id=work.id
        WHERE fixture.variant NOT IN ('eligible-gap','pending-cleanup') ORDER BY work.id`),
      units:
        await transaction.execute(sql`SELECT id,attempts,active_seconds,active_budget_seconds,recipe
        FROM progressive_cfd_units ORDER BY id`),
      targets: await transaction.execute(
        sql`SELECT * FROM progressive_generation_targets ORDER BY generation_id`,
      ),
      attempts: await transaction.execute(
        sql`SELECT * FROM progressive_cfd_attempts ORDER BY token`,
      ),
      evidence: await transaction.execute(
        sql`SELECT * FROM progressive_cfd_evidence ORDER BY attempt_token`,
      ),
      coefficients: await transaction.execute(
        sql`SELECT * FROM result_attempts ORDER BY id`,
      ),
      classifications: await transaction.execute(
        sql`SELECT * FROM result_classifications ORDER BY result_attempt_id`,
      ),
      jobs: await transaction.execute(sql`SELECT * FROM sim_jobs ORDER BY id`),
      stops: await transaction.execute(
        sql`SELECT * FROM progressive_cfd_execution_stops ORDER BY sim_job_id`,
      ),
      promises: await transaction.execute(
        sql`SELECT * FROM sync_sweep_promises ORDER BY id`,
      ),
    });
    const before = await immutable();
    expect(await recoverTerminalProgressiveNoEvidenceGaps(db)).toBe(63);
    expect(await immutable()).toEqual(before);
    expect(await recoverTerminalProgressiveNoEvidenceGaps(db)).toBe(3);
    expect(await recoverTerminalProgressiveNoEvidenceGaps(db)).toBe(0);
    expect(await immutable()).toEqual(before);
    const changed =
      await transaction.execute(sql`SELECT fixture.variant,unit.state,unit.error,work.state AS work_state
      FROM progressive_cfd_units unit JOIN recovery_fixture fixture ON fixture.id=unit.id
      JOIN progressive_work work ON work.id=unit.work_id
      WHERE fixture.variant IN ('eligible-gap','pending-cleanup') ORDER BY unit.id`);
    expect(
      changed.filter((row) => row.variant === "eligible-gap"),
    ).toHaveLength(66);
    expect(
      changed
        .filter((row) => row.variant === "eligible-gap")
        .every(
          (row) =>
            row.state === "pending" &&
            row.error === retry &&
            row.work_state === "pending",
        ),
    ).toBe(true);
    expect(
      changed.find((row) => row.variant === "pending-cleanup"),
    ).toMatchObject({
      state: "gap",
      error: failure,
      work_state: "pending",
    });
  });
}, 120000);
