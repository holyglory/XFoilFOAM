import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { analysisContentHash } from "../src/analysis-target";
import { createClient, type DB } from "../src/client";
import { reuseInformativeProgressiveCfdEvidence } from "../src/progressive-cfd-reuse";
import { SOURCE_GEOMETRY_POLICY_VERSION } from "../src/progressive-evidence-geometry";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("reuses only a completed stage-2 source with a verified informative contributor", async () => {
  const epochId = randomUUID();
  const campaignId = randomUUID();
  const generationId = randomUUID();
  const sourceGenerationId = randomUUID();
  const revisionId = randomUUID();
  const executionRevisionId = randomUUID();
  const recipe = { solver: "rhoSimpleFoam", cfl_target: 0.4 };
  const recipeId = analysisContentHash({
    sourceRevisionId: revisionId,
    recipe,
  });
  const proof = {
    version: 1,
    job_id: "stopped-engine",
    execution_stopped: true,
    producer_stopped: true,
    namespace_verified: true,
    remaining: [],
    error: null,
    fence: "terminal_result",
    observed_at: "2026-10-23T00:00:00Z",
  };
  const variants = [
    "eligible",
    "stage3",
    "pending-source",
    "failed-source",
    "unfitted",
    "no-contributor",
    "changed-recipe",
    "divergent",
    "startup-only",
    "incompatible",
  ];

  await client.db.transaction(async (transaction) => {
    const db = transaction as unknown as DB;
    await transaction.execute(sql`CREATE TEMP TABLE reuse_fixture ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id, variant,
        md5(variant || '-target')::text AS target_id,
        md5(variant || '-airfoil')::uuid AS airfoil_id,
        md5(variant || '-successor-work')::uuid AS successor_work_id,
        md5(variant || '-source-work')::uuid AS source_work_id,
        md5(variant || '-successor-unit')::uuid AS successor_unit_id,
        md5(variant || '-source-unit')::uuid AS source_unit_id,
        md5(variant || '-result')::uuid AS result_id,
        md5(variant || '-job')::uuid AS job_id,
        md5(variant || '-prediction')::text AS prediction_id,
        ('model-' || variant)::text AS model_id
      FROM unnest(ARRAY[${sql.join(
        variants.map((variant) => sql`${variant}`),
        sql`, `,
      )}]::text[])
        AS fixture(variant)`);
    await transaction.execute(sql`CREATE TEMP TABLE calculation_epochs ON COMMIT DROP AS
      SELECT ${epochId}::uuid AS id, true AS current`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_campaigns ON COMMIT DROP AS
      SELECT ${campaignId}::uuid AS id, 'paused'::text AS status,
        ${revisionId}::uuid AS current_plan_revision_id`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_generations ON COMMIT DROP AS
      SELECT ${generationId}::uuid AS id, ${campaignId}::uuid AS campaign_id,
        ${epochId}::uuid AS epoch_id, 'active'::text AS status,
        ${revisionId}::uuid AS plan_revision_id
      UNION ALL
      SELECT ${sourceGenerationId}::uuid, ${campaignId}::uuid, ${epochId}::uuid,
        'cancelled'::text, ${revisionId}::uuid`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_work ON COMMIT DROP AS
      SELECT successor_work_id AS id, ${generationId}::uuid AS generation_id,
        target_id, CASE WHEN variant = 'stage3' THEN 3 ELSE 2 END AS stage,
        'pending'::text AS state
      FROM reuse_fixture
      UNION ALL
      SELECT source_work_id, ${sourceGenerationId}::uuid, target_id,
        CASE WHEN variant = 'stage3' THEN 3 ELSE 2 END, 'complete'::text
      FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_generation_targets ON COMMIT DROP AS
      SELECT ${generationId}::uuid AS generation_id, target_id,
        ${revisionId}::uuid AS revision_id FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE polar_analysis_targets ON COMMIT DROP AS
      SELECT target_id AS id, airfoil_id,
        jsonb_build_object(
          'geometry', jsonb_build_array(jsonb_build_array(0, 0), jsonb_build_array(1, 0), jsonb_build_array(0, 0)),
          'reference', jsonb_build_object('referenceLengthM', 1.0),
          'flow', jsonb_build_object('speedMps', 10.0)
        ) AS physical
      FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_units ON COMMIT DROP AS
      SELECT successor_unit_id AS id, successor_work_id AS work_id, 0.0::double precision AS aoa_deg,
        0 AS ordinal,
        CASE WHEN variant = 'changed-recipe'
          THEN '{"solver":"rhoSimpleFoam","cfl_target":0.5}'::jsonb
          ELSE ${JSON.stringify(recipe)}::jsonb END AS recipe,
        'initial'::text AS purpose, 1.0::double precision AS active_budget_seconds,
        'pending'::text AS state, NULL::text AS error, NULL::uuid AS lease_token,
        NULL::text AS lease_owner, NULL::timestamptz AS lease_until
      FROM reuse_fixture
      UNION ALL
      SELECT source_unit_id, source_work_id, 0.0, 0, ${JSON.stringify(recipe)}::jsonb,
        'initial', 1.0,
        CASE WHEN variant = 'pending-source' THEN 'pending' ELSE 'complete' END,
        NULL::text, NULL, NULL, NULL
      FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_attempts ON COMMIT DROP AS
      SELECT source_unit_id AS unit_id, source_unit_id AS token, job_id AS sim_job_id,
        ${recipeId}::text AS execution_recipe_id,
        CASE WHEN variant = 'failed-source' THEN 'failed' ELSE 'complete' END AS outcome,
        clock_timestamp() AS finished_at
      FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_execution_recipes ON COMMIT DROP AS
      SELECT ${recipeId}::text AS id, ${revisionId}::uuid AS source_revision_id,
        ${JSON.stringify(recipe)}::jsonb AS recipe,
        ${executionRevisionId}::uuid AS execution_revision_id`);
    await transaction.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS
      SELECT result_id AS id, result_id, airfoil_id, ${executionRevisionId}::uuid AS simulation_preset_revision_id,
        0.0::double precision AS aoa_deg, job_id AS sim_job_id,
        ('engine-' || variant)::text AS engine_job_id, 'failed'::text AS status,
        CASE
          WHEN variant = 'divergent' THEN jsonb_build_object('converged', false, 'error', 'FOAM FATAL ERROR: solver diverged')
          WHEN variant = 'startup-only' THEN jsonb_build_object('converged', false, 'force_history', jsonb_build_object('t', jsonb_build_array(0.0, 0.01, 0.02, 0.03), 'source_start_time', 0.0, 'window_start', 0.0, 'window_end', 0.03))
          WHEN variant = 'incompatible' THEN jsonb_build_object('converged', false, 'failure_disposition', 'incompatible')
          ELSE jsonb_build_object('converged', true, 'cl', 0.7, 'cd', 0.025, 'cm', -0.03)
        END AS evidence_payload,
        0.7::double precision AS cl, 0.025::double precision AS cd, -0.03::double precision AS cm
      FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_evidence (
      attempt_token uuid, result_attempt_id uuid, evidence_signature text,
      solver_active_seconds double precision
    ) ON COMMIT DROP`);
    const rawRows =
      await transaction.execute(sql`SELECT raw.id, raw.evidence_payload, fixture.source_unit_id
      FROM result_attempts raw JOIN reuse_fixture fixture ON fixture.result_id = raw.id`);
    for (const row of rawRows)
      await transaction.execute(sql`INSERT INTO progressive_cfd_evidence VALUES (
        ${row.source_unit_id}::uuid, ${row.id}::uuid, ${analysisContentHash(row.evidence_payload)}, 60)`);
    await transaction.execute(sql`CREATE TEMP TABLE result_classifications (
      result_attempt_id uuid, state text
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE result_review_verdicts (
      id uuid, result_id uuid, verdict text, "revokedAt" timestamptz, "createdAt" timestamptz
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT job_id AS id, ('engine-' || variant)::text AS engine_job_id,
        'done'::text AS status, clock_timestamp() AS "ingestedAt",
        NULL::timestamptz AS ingest_lease_expires_at FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_execution_stops ON COMMIT DROP AS
      SELECT job_id AS sim_job_id, ('engine-' || variant)::text AS engine_job_id,
        ${epochId}::uuid AS epoch_id, ${JSON.stringify(proof)}::jsonb AS proof,
        ${analysisContentHash(proof)}::text AS proof_signature FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE neuralfoil_predictions ON COMMIT DROP AS
      SELECT prediction_id AS id, target_id, ${epochId}::uuid AS epoch_id,
        clock_timestamp() AS created_at FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_polar_fit_work ON COMMIT DROP AS
      SELECT prediction_id, model_id,
        CASE WHEN variant = 'unfitted' THEN 'pending' ELSE 'ready' END AS state
      FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_polar_models ON COMMIT DROP AS
      SELECT model_id AS id, prediction_id,
        jsonb_build_object('estimate', jsonb_build_object('contributors',
          CASE WHEN variant IN ('no-contributor', 'divergent', 'startup-only', 'incompatible') THEN '[]'::jsonb
            ELSE jsonb_build_array(jsonb_build_object(
              'attempt_id', result_id::text, 'result_id', result_id::text,
              'method', 'openfoam_fast')) END)) AS response
      FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_polar_geometry_verifications ON COMMIT DROP AS
      SELECT model_id, ${SOURCE_GEOMETRY_POLICY_VERSION}::integer AS policy_version,
        true AS source_geometry_compatible FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_polar_model_evidence ON COMMIT DROP AS
      SELECT model_id, source_unit_id AS attempt_token, result_id AS result_attempt_id
      FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_dispatches (
      sim_job_id uuid, promise_id uuid
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises (
      id uuid, status text
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_evidence_reuses (
      successor_unit_id uuid PRIMARY KEY, source_attempt_token uuid,
      source_result_attempt_id uuid, source_evidence_signature text,
      source_generation_id uuid, source_execution_recipe_id text
    ) ON COMMIT DROP`);

    const before =
      await transaction.execute(sql`SELECT variant, state FROM progressive_cfd_units
      JOIN reuse_fixture ON reuse_fixture.source_unit_id = progressive_cfd_units.id
      ORDER BY variant, state`);
    expect(
      await reuseInformativeProgressiveCfdEvidence(
        db,
        generationId,
        [sourceGenerationId],
        epochId,
      ),
    ).toBe(1);
    expect(
      await transaction.execute(sql`SELECT fixture.variant, unit.state
        FROM progressive_cfd_units unit JOIN reuse_fixture fixture ON fixture.successor_unit_id = unit.id
        WHERE unit.state = 'complete' ORDER BY fixture.variant`),
    ).toEqual([{ variant: "eligible", state: "complete" }]);
    expect(
      await transaction.execute(sql`SELECT variant, state FROM progressive_cfd_units
      JOIN reuse_fixture ON reuse_fixture.source_unit_id = progressive_cfd_units.id
      ORDER BY variant, state`),
    ).toEqual(before);
    expect(
      await reuseInformativeProgressiveCfdEvidence(
        db,
        generationId,
        [sourceGenerationId],
        epochId,
      ),
    ).toBe(0);
  });
});
