import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { analysisContentHash } from "../src/analysis-target";
import { createClient, type DB } from "../src/client";
import { reuseInformativeProgressiveCfdEvidence } from "../src/progressive-cfd-reuse";
import { SOURCE_GEOMETRY_POLICY_VERSION } from "../src/progressive-evidence-geometry";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("reuses only completed fast sources with exact current verified informative contributors", async () => {
  await client.db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const epochId = randomUUID();
    const campaignId = randomUUID();
    const generationId = randomUUID();
    const sourceGenerationId = randomUUID();
    const revisionId = randomUUID();
    const executionRevisionId = randomUUID();
    const recipe = { solver: { solver: "rhoSimpleFoam", cfl_target: 0.4 } };
    const recipeId = analysisContentHash({ sourceRevisionId: revisionId, recipe });
    const payload = { converged: true, cl: 0.7, cd: 0.025, cm: -0.03 };
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
    await transaction.execute(sql`CREATE TEMP TABLE reuse_fixture ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id, variant,
        md5(variant || '-source-unit')::uuid AS source_unit_id,
        md5(variant || '-source-work')::uuid AS source_work_id,
        md5(variant || '-successor-work')::uuid AS successor_work_id
      FROM unnest(ARRAY['eligible', 'precise', 'pending-source', 'gap-source', 'cancelled-source',
        'failed-attempt', 'unfitted', 'stale-fit', 'unverified-geometry', 'old-geometry-policy',
        'wrong-model-prediction', 'wrong-receipt-token', 'wrong-receipt-attempt',
        'wrong-contributor-attempt', 'wrong-contributor-result', 'wrong-contributor-method',
        'divergent', 'startup-only', 'incompatible', 'changed-cfl', 'changed-revision',
        'changed-target', 'changed-airfoil', 'changed-angle', 'changed-evidence', 'changed-recipe-id',
        'changed-proof', 'live-job', 'ingest-lease', 'live-attempt', 'live-promise', 'excluded-review']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE calculation_epochs ON COMMIT DROP AS
      SELECT ${epochId}::uuid AS id, true AS current`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_campaigns ON COMMIT DROP AS
      SELECT ${campaignId}::uuid AS id, 'paused'::text AS status, ${revisionId}::uuid AS current_plan_revision_id`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_generations ON COMMIT DROP AS
      SELECT ${generationId}::uuid AS id, ${campaignId}::uuid AS campaign_id, ${epochId}::uuid AS epoch_id,
        'active'::text AS status, ${revisionId}::uuid AS plan_revision_id
      UNION ALL SELECT ${sourceGenerationId}::uuid, ${campaignId}::uuid, ${epochId}::uuid, 'cancelled', ${revisionId}::uuid`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_work ON COMMIT DROP AS
      SELECT successor_work_id AS id, ${generationId}::uuid AS generation_id, id AS target_id,
        CASE WHEN variant = 'precise' THEN 3 ELSE 2 END AS stage, 'pending'::text AS state FROM reuse_fixture
      UNION ALL SELECT source_work_id, ${sourceGenerationId}::uuid,
        CASE WHEN variant = 'changed-target' THEN md5('foreign-target')::uuid ELSE id END,
        CASE WHEN variant = 'precise' THEN 3 ELSE 2 END, 'complete' FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_generation_targets ON COMMIT DROP AS
      SELECT ${generationId}::uuid AS generation_id, id AS target_id, ${revisionId}::uuid AS revision_id FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE polar_analysis_targets ON COMMIT DROP AS
      SELECT id, id AS airfoil_id FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_units ON COMMIT DROP AS
      SELECT id, successor_work_id AS work_id, 0::double precision AS aoa_deg,
        CASE WHEN variant = 'changed-cfl' THEN '{"solver":{"solver":"rhoSimpleFoam","cfl_target":0.5}}'::jsonb
          ELSE ${JSON.stringify(recipe)}::jsonb END AS recipe,
        'pending'::text AS state, NULL::uuid AS lease_token, NULL::text AS lease_owner,
        NULL::timestamptz AS lease_until, NULL::text AS error FROM reuse_fixture
      UNION ALL SELECT source_unit_id, source_work_id, 0, ${JSON.stringify(recipe)}::jsonb,
        CASE WHEN variant = 'pending-source' THEN 'pending' WHEN variant = 'gap-source' THEN 'gap'
          WHEN variant = 'cancelled-source' THEN 'cancelled' ELSE 'complete' END, NULL, NULL, NULL, NULL FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_attempts ON COMMIT DROP AS
      SELECT id AS token, source_unit_id AS unit_id, id AS sim_job_id,
        CASE WHEN variant = 'changed-recipe-id' THEN 'changed' ELSE ${recipeId} END AS execution_recipe_id,
        CASE WHEN variant = 'failed-attempt' THEN 'failed' WHEN variant = 'live-attempt' THEN 'running' ELSE 'complete' END AS outcome,
        clock_timestamp() AS finished_at FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_execution_recipes ON COMMIT DROP AS
      SELECT DISTINCT execution_recipe_id AS id, ${revisionId}::uuid AS source_revision_id,
        ${executionRevisionId}::uuid AS execution_revision_id, ${JSON.stringify(recipe)}::jsonb AS recipe
      FROM progressive_cfd_attempts`);
    await transaction.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS
      SELECT id, id AS result_id,
        CASE WHEN variant = 'changed-revision' THEN md5('foreign-revision')::uuid ELSE ${executionRevisionId}::uuid END AS simulation_preset_revision_id,
        CASE WHEN variant = 'changed-airfoil' THEN md5('foreign-airfoil')::uuid ELSE id END AS airfoil_id,
        CASE WHEN variant = 'changed-angle' THEN 1 ELSE 0 END::double precision AS aoa_deg,
        id AS sim_job_id, 'stopped-engine'::text AS engine_job_id, 'failed'::text AS status,
        CASE WHEN variant = 'divergent' THEN '{"error":"FOAM FATAL ERROR: solver diverged"}'::jsonb
          WHEN variant = 'startup-only' THEN '{"force_history":{"t":[0,0.01,0.02,0.03]}}'::jsonb
          WHEN variant = 'incompatible' THEN '{"mesh_recovery_version":1}'::jsonb
          ELSE ${JSON.stringify(payload)}::jsonb END AS evidence_payload,
        0.7::double precision AS cl, 0.025::double precision AS cd, -0.03::double precision AS cm
      FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_evidence (
      attempt_token uuid, result_attempt_id uuid, evidence_signature text, solver_active_seconds double precision
    ) ON COMMIT DROP`);
    const evidence = await transaction.execute(sql`SELECT raw.id, raw.evidence_payload, fixture.variant
      FROM result_attempts raw JOIN reuse_fixture fixture ON fixture.id = raw.id`);
    for (const row of evidence) {
      await transaction.execute(sql`INSERT INTO progressive_cfd_evidence VALUES (${row.id}::uuid, ${row.id}::uuid,
        ${row.variant === "changed-evidence" ? "changed" : analysisContentHash(row.evidence_payload)}, 60)`);
    }
    await transaction.execute(sql`CREATE TEMP TABLE result_classifications (
      result_attempt_id uuid, state text
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT id, 'stopped-engine'::text AS engine_job_id,
        CASE WHEN variant = 'live-job' THEN 'running' ELSE 'done' END AS status,
        clock_timestamp() AS "ingestedAt",
        CASE WHEN variant = 'ingest-lease' THEN clock_timestamp() + interval '1 day' END AS ingest_lease_expires_at
      FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_execution_stops ON COMMIT DROP AS
      SELECT id AS sim_job_id, 'stopped-engine'::text AS engine_job_id, ${epochId}::uuid AS epoch_id,
        ${JSON.stringify(proof)}::jsonb AS proof,
        CASE WHEN variant = 'changed-proof' THEN 'changed' ELSE ${analysisContentHash(proof)} END AS proof_signature
      FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE neuralfoil_predictions ON COMMIT DROP AS
      SELECT id::text AS id, id AS target_id, ${epochId}::uuid AS epoch_id, clock_timestamp() AS created_at FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_polar_fit_work ON COMMIT DROP AS
      SELECT id::text AS prediction_id, id::text AS model_id,
        CASE WHEN variant = 'stale-fit' THEN 'pending' ELSE 'ready' END AS state FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_polar_models ON COMMIT DROP AS
      SELECT id::text AS id,
        CASE WHEN variant = 'wrong-model-prediction' THEN 'foreign' ELSE id::text END AS prediction_id,
        jsonb_build_object('estimate', jsonb_build_object('contributors',
          CASE WHEN variant IN ('unfitted', 'divergent', 'startup-only', 'incompatible') THEN '[]'::jsonb
          ELSE jsonb_build_array(jsonb_build_object(
            'attempt_id', CASE WHEN variant = 'wrong-contributor-attempt' THEN 'foreign' ELSE id::text END,
            'result_id', CASE WHEN variant = 'wrong-contributor-result' THEN 'foreign' ELSE id::text END,
            'method', CASE WHEN variant = 'wrong-contributor-method' THEN 'openfoam_precise' ELSE 'openfoam_fast' END)) END)) AS response
      FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_polar_geometry_verifications ON COMMIT DROP AS
      SELECT id::text AS model_id,
        CASE WHEN variant = 'old-geometry-policy' THEN ${SOURCE_GEOMETRY_POLICY_VERSION + 1} ELSE ${SOURCE_GEOMETRY_POLICY_VERSION} END AS policy_version,
        variant <> 'unverified-geometry' AS source_geometry_compatible FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_polar_model_evidence ON COMMIT DROP AS
      SELECT id::text AS model_id,
        CASE WHEN variant = 'wrong-receipt-token' THEN md5('foreign-token')::uuid ELSE id END AS attempt_token,
        CASE WHEN variant = 'wrong-receipt-attempt' THEN md5('foreign-attempt')::uuid ELSE id END AS result_attempt_id
      FROM reuse_fixture`);
    await transaction.execute(sql`CREATE TEMP TABLE result_review_verdicts ON COMMIT DROP AS
      SELECT id, id AS result_id, 'exclude'::text AS verdict, NULL::timestamptz AS "revokedAt",
        clock_timestamp() AS "createdAt" FROM reuse_fixture WHERE variant = 'excluded-review'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_dispatches ON COMMIT DROP AS
      SELECT id AS sim_job_id, id AS promise_id FROM reuse_fixture WHERE variant = 'live-promise'`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id, 'active'::text AS status FROM reuse_fixture WHERE variant = 'live-promise'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_evidence_reuses (
      successor_unit_id uuid PRIMARY KEY, source_attempt_token uuid, source_result_attempt_id uuid,
      source_evidence_signature text, source_generation_id uuid, source_execution_recipe_id text
    ) ON COMMIT DROP`);
    const immutableState = () => transaction.execute(sql`
      SELECT to_jsonb(raw) AS raw, to_jsonb(receipt) AS receipt, to_jsonb(attempt) AS attempt,
        to_jsonb(source_unit) AS source_unit, to_jsonb(model) AS model, to_jsonb(stopped) AS stopped
      FROM result_attempts raw JOIN progressive_cfd_evidence receipt ON receipt.result_attempt_id = raw.id
      JOIN progressive_cfd_attempts attempt ON attempt.token = receipt.attempt_token
      JOIN progressive_cfd_units source_unit ON source_unit.id = attempt.unit_id
      JOIN progressive_polar_models model ON model.id = raw.id::text
      JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = raw.sim_job_id ORDER BY raw.id
    `);
    const before = await immutableState();
    expect(await reuseInformativeProgressiveCfdEvidence(connection, generationId, [sourceGenerationId], epochId)).toBe(1);
    expect(await reuseInformativeProgressiveCfdEvidence(connection, generationId, [sourceGenerationId], epochId)).toBe(0);
    expect(await immutableState()).toEqual(before);
    expect(await transaction.execute(sql`SELECT fixture.variant, unit.state
      FROM progressive_cfd_units unit JOIN reuse_fixture fixture ON fixture.id = unit.id
      WHERE unit.state <> 'pending'`)).toEqual([{ variant: "eligible", state: "complete" }]);
    expect(await transaction.execute(sql`SELECT reuse.* FROM progressive_cfd_evidence_reuses reuse`)).toEqual([{
      successor_unit_id: analysisFixtureId("eligible"),
      source_attempt_token: analysisFixtureId("eligible"),
      source_result_attempt_id: analysisFixtureId("eligible"),
      source_evidence_signature: analysisContentHash(payload),
      source_generation_id: sourceGenerationId,
      source_execution_recipe_id: recipeId,
    }]);
  });
});

function analysisFixtureId(value: string): string {
  return createHash("md5").update(value).digest("hex").replace(
    /^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/,
    "$1-$2-$3-$4-$5",
  );
}
