import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "../src/env";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, "../migrations");
const runId = `${process.pid}_${Date.now()}`;
const upgradeDbName = `aerodb_ra0051_${runId}_ok`;
const divergentDbName = `aerodb_ra0051_${runId}_bad`;
const ambiguousDbName = `aerodb_ra0051_${runId}_ambiguous`;
const classificationDivergentDbName = `aerodb_ra0051_${runId}_classification`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";

const ID = {
  category: "51000000-0000-0000-0000-000000000001",
  airfoil: "51000000-0000-0000-0000-000000000002",
  medium: "51000000-0000-0000-0000-000000000003",
  flow: "51000000-0000-0000-0000-000000000004",
  geometry: "51000000-0000-0000-0000-000000000005",
  boundary: "51000000-0000-0000-0000-000000000006",
  mesh: "51000000-0000-0000-0000-000000000007",
  solver: "51000000-0000-0000-0000-000000000008",
  scheduling: "51000000-0000-0000-0000-000000000009",
  output: "51000000-0000-0000-0000-00000000000a",
  sweep: "51000000-0000-0000-0000-00000000000b",
  bc: "51000000-0000-0000-0000-00000000000c",
  preset: "51000000-0000-0000-0000-00000000000d",
  revision: "51000000-0000-0000-0000-00000000000e",
  result: "51000000-0000-0000-0000-00000000000f",
  promise: "51000000-0000-0000-0000-000000000010",
  promisePoint: "51000000-0000-0000-0000-000000000011",
  obligation: "51000000-0000-0000-0000-000000000012",
  obligationAttempt: "51000000-0000-0000-0000-000000000013",
  remoteReference: "51000000-0000-0000-0000-000000000014",
  classification: "51000000-0000-0000-0000-000000000015",
  campaign: "51000000-0000-0000-0000-000000000016",
  campaignPlan: "51000000-0000-0000-0000-000000000017",
  campaignCondition: "51000000-0000-0000-0000-000000000018",
} as const;

const rawEngineJobId = "remote-job-42";
const sourceInstanceId = "remote-prod-01";
const namespacedEngineJobId =
  `sync:${sourceInstanceId}:${rawEngineJobId}` as const;

function attemptId(ordinal: number): string {
  return `52000000-0000-0000-0000-${ordinal.toString(16).padStart(12, "0")}`;
}

function artifactId(ordinal: number): string {
  return `53000000-0000-0000-0000-${ordinal.toString(16).padStart(12, "0")}`;
}

const keeperAttemptId = attemptId(13);

function targetUrl(dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function makeBaselineFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "aerodb-migrations-0050-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= 50);
  for (const entry of entries) {
    cpSync(join(migrations, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return dir;
}

const setupSql = `
INSERT INTO categories (id, slug, name, path) VALUES
  ('${ID.category}', 'remote-attempt-upgrade', 'remote attempt upgrade', 'remote-attempt-upgrade');
INSERT INTO airfoils (id, slug, name, category_id, points, is_symmetric) VALUES
  ('${ID.airfoil}', 'remote-attempt-foil', 'remote attempt foil', '${ID.category}',
   '[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]'::jsonb, false);
INSERT INTO mediums
  (id, slug, name, phase, density, viscosity_model,
   constant_dynamic_viscosity, dynamic_viscosity, kinematic_viscosity, speed_of_sound)
VALUES ('${ID.medium}', 'remote-attempt-air', 'remote attempt air', 'gas', 1.225, 'constant',
        0.00001789, 0.00001789, 0.000014604, 340.3);
INSERT INTO flow_conditions
  (id, slug, name, medium_id, speed_mps, density, dynamic_viscosity, kinematic_viscosity)
VALUES ('${ID.flow}', 'remote-attempt-flow', 'remote attempt flow', '${ID.medium}', 20, 1.225,
        0.00001789, 0.000014604);
INSERT INTO reference_geometry_profiles (id, slug, name, reference_length_m)
VALUES ('${ID.geometry}', 'remote-attempt-geo', 'remote attempt geo', 1);
INSERT INTO boundary_profiles (id, slug, name) VALUES
  ('${ID.boundary}', 'remote-attempt-boundary', 'remote attempt boundary');
INSERT INTO mesh_profiles (id, slug, name) VALUES
  ('${ID.mesh}', 'remote-attempt-mesh', 'remote attempt mesh');
INSERT INTO solver_profiles (id, slug, name) VALUES
  ('${ID.solver}', 'remote-attempt-solver', 'remote attempt solver');
INSERT INTO scheduling_profiles (id, slug, name) VALUES
  ('${ID.scheduling}', 'remote-attempt-scheduling', 'remote attempt scheduling');
INSERT INTO output_profiles (id, slug, name) VALUES
  ('${ID.output}', 'remote-attempt-output', 'remote attempt output');
INSERT INTO sweep_definitions (id, slug, name, aoa_list) VALUES
  ('${ID.sweep}', 'remote-attempt-sweep', 'remote attempt sweep', '[4]'::jsonb);
INSERT INTO boundary_conditions
  (id, slug, name, medium_id, reynolds, reference_chord_m, speed_mps,
   density, dynamic_viscosity, kinematic_viscosity)
VALUES ('${ID.bc}', 'remote-attempt-bc', 'remote attempt bc', '${ID.medium}', 1369491, 1, 20,
        1.225, 0.00001789, 0.000014604);
INSERT INTO simulation_presets
  (id, slug, name, flow_condition_id, reference_geometry_profile_id,
   boundary_profile_id, mesh_profile_id, solver_profile_id,
   scheduling_profile_id, output_profile_id, sweep_definition_id,
   legacy_boundary_condition_id)
VALUES ('${ID.preset}', 'remote-attempt-preset', 'remote attempt preset', '${ID.flow}', '${ID.geometry}',
        '${ID.boundary}', '${ID.mesh}', '${ID.solver}', '${ID.scheduling}',
        '${ID.output}', '${ID.sweep}', '${ID.bc}');
INSERT INTO simulation_preset_revisions
  (id, preset_id, revision_number, signature_hash, reynolds,
   reference_length_m, snapshot)
VALUES ('${ID.revision}', '${ID.preset}', 1, 'remote-attempt-signature', 1369491, 1, '{}'::jsonb);

INSERT INTO results
  (id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg, status,
   source, regime, fidelity, engine_job_id, engine_case_slug, cl, cd, cm,
   cl_cd, cl_std, cd_std, cm_std, converged, unsteady, stalled, n_cells,
   quality_warnings, "solvedAt")
VALUES
  ('${ID.result}', '${ID.airfoil}', '${ID.bc}', '${ID.revision}', 4, 'done',
   'solved', 'urans', 'urans_precalc', '${rawEngineJobId}', 'aoa-4', 0.7, 0.02, -0.03,
   35, 0.01, 0.001, 0.002, true, true, false, 42000,
   ARRAY[]::text[], TIMESTAMPTZ '2026-07-11 01:00:00+00');
INSERT INTO sync_sweep_promises
  (id, source_instance_id, source_instance_name, status, airfoil_id,
   simulation_preset_revision_id, aoa_count, "expiresAt", "fulfilledAt")
VALUES
  ('${ID.promise}', '${sourceInstanceId}', 'Remote production solver', 'fulfilled',
   '${ID.airfoil}', '${ID.revision}', 1,
   TIMESTAMPTZ '2026-07-12 00:00:00+00', TIMESTAMPTZ '2026-07-11 01:01:00+00');
INSERT INTO sync_sweep_promise_points
  (id, promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
   status, result_id, "updatedAt")
VALUES
  ('${ID.promisePoint}', '${ID.promise}', '${ID.airfoil}', '${ID.revision}', 4,
   'fulfilled', '${ID.result}', TIMESTAMPTZ '2026-07-11 01:01:00+00');
`;

function attemptsSql(divergent: boolean): string {
  const values = Array.from({ length: 13 }, (_, index) => {
    const ordinal = index + 1;
    const cl = divergent && ordinal === 7 ? "0.71" : "0.7";
    const minute = ordinal.toString().padStart(2, "0");
    return `
      ('${attemptId(ordinal)}', '${ID.result}', '${ID.airfoil}', '${ID.bc}', '${ID.revision}', 4,
       NULL, '${rawEngineJobId}', 'aoa-4', 'done', 'solved', 'urans', true,
       ${cl}, 0.02, -0.03, 35, 0.01, 0.001, 0.002, false, true, true, 42000,
       ARRAY[]::text[], '{"fidelity":"urans_precalc","frame_track":{"sampleCount":40}}'::jsonb,
       TIMESTAMPTZ '2026-07-11 01:00:00+00', TIMESTAMPTZ '2026-07-11 00:${minute}:00+00')`;
  });

  return `
INSERT INTO result_attempts
  (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg,
   sim_job_id, engine_job_id, engine_case_slug, status, source, regime,
   valid_for_polar, cl, cd, cm, cl_cd, cl_std, cd_std, cm_std, stalled,
   unsteady, converged, n_cells, quality_warnings, evidence_payload,
   "solvedAt", "createdAt")
VALUES ${values.join(",")};
`;
}

const durableReferenceSql = `
-- The oldest classification must move to the keeper.
INSERT INTO result_classifications
  (id, result_attempt_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
   regime, classifier_version, state, reasons)
VALUES
  ('${ID.classification}', '${attemptId(1)}', '${ID.airfoil}', '${ID.revision}', 4,
   'urans', 'remote-upgrade-v1', 'accepted', ARRAY['accepted remote evidence']);

INSERT INTO sim_campaigns
  (id, slug, name, status, priority, idempotency_key)
VALUES
  ('${ID.campaign}', 'remote-attempt-campaign', 'remote attempt campaign',
   'active', 5, 'remote-attempt-campaign-key');
INSERT INTO sim_campaign_plan_revisions
  (id, campaign_id, revision_number, kind, plan, summary)
VALUES
  ('${ID.campaignPlan}', '${ID.campaign}', 1, 'initial', '{}'::jsonb, '{}'::jsonb);
UPDATE sim_campaigns
SET current_plan_revision_id = '${ID.campaignPlan}'
WHERE id = '${ID.campaign}';
INSERT INTO sim_campaign_airfoils (campaign_id, airfoil_id)
VALUES ('${ID.campaign}', '${ID.airfoil}');
INSERT INTO sim_campaign_conditions
  (id, campaign_id, ord, flow_condition_id, reference_geometry_profile_id,
   preset_id, simulation_preset_revision_id, reynolds, status,
   introduced_in_plan_revision_id)
VALUES
  ('${ID.campaignCondition}', '${ID.campaign}', 0, '${ID.flow}', '${ID.geometry}',
   '${ID.preset}', '${ID.revision}', 1369491, 'active', '${ID.campaignPlan}');
INSERT INTO sim_campaign_points
  (campaign_id, condition_id, airfoil_id, aoa_deg, revision_id,
   plan_revision_number, state, result_id, result_attempt_id)
VALUES
  ('${ID.campaign}', '${ID.campaignCondition}', '${ID.airfoil}', 4,
   '${ID.revision}', 1, 'terminal', '${ID.result}', '${attemptId(6)}');

-- Exercise every durable result_attempt foreign key from a duplicate owner.
INSERT INTO sim_precalc_obligations
  (id, airfoil_id, revision_id, aoa_deg, source_result_id,
   source_result_attempt_id, state, attempt_count, last_outcome, completed_at)
VALUES
  ('${ID.obligation}', '${ID.airfoil}', '${ID.revision}', 4, '${ID.result}',
   '${attemptId(2)}', 'satisfied', 1, 'accepted', TIMESTAMPTZ '2026-07-11 01:02:00+00');
INSERT INTO sim_precalc_obligation_attempts
  (id, obligation_id, attempt_number, state, outcome, result_attempt_id,
   submitted_at, completed_at)
VALUES
  ('${ID.obligationAttempt}', '${ID.obligation}', 1, 'accepted', 'accepted',
   '${attemptId(3)}', TIMESTAMPTZ '2026-07-11 00:59:00+00',
   TIMESTAMPTZ '2026-07-11 01:02:00+00');
INSERT INTO remote_asset_references
  (id, local_kind, local_storage_key, result_id, result_attempt_id,
   source_instance_id, remote_artifact_id, remote_download_url, sha256,
   byte_size, mime_type)
VALUES
  ('${ID.remoteReference}', 'solver_evidence_artifact', 'migration-0051/remote-reference',
   '${ID.result}', '${attemptId(4)}', '${sourceInstanceId}', 'remote-artifact-1',
   'https://remote.example.test/evidence/1', 'remote-sha-1', 101, 'application/gzip');

-- One artifact starts on an older duplicate; five artifacts make the newest
-- attempt the unambiguous evidence-bearing keeper.
INSERT INTO solver_evidence_artifacts
  (id, result_id, result_attempt_id, airfoil_id, engine_job_id,
   engine_case_slug, aoa_deg, kind, role, storage_key, mime_type, sha256,
   byte_size)
VALUES
  ('${artifactId(1)}', '${ID.result}', '${attemptId(5)}', '${ID.airfoil}',
   '${rawEngineJobId}', 'aoa-4', 4, 'manifest', 'manifest',
   'migration-0051/artifact-1.json', 'application/json', 'artifact-sha-1', 101),
  ('${artifactId(2)}', '${ID.result}', '${keeperAttemptId}', '${ID.airfoil}',
   '${rawEngineJobId}', 'aoa-4', 4, 'force_coefficients', 'history',
   'migration-0051/artifact-2.csv', 'text/csv', 'artifact-sha-2', 102),
  ('${artifactId(3)}', '${ID.result}', '${keeperAttemptId}', '${ID.airfoil}',
   '${rawEngineJobId}', 'aoa-4', 4, 'mesh', 'mesh',
   'migration-0051/artifact-3.tar', 'application/x-tar', 'artifact-sha-3', 103),
  ('${artifactId(4)}', '${ID.result}', '${keeperAttemptId}', '${ID.airfoil}',
   '${rawEngineJobId}', 'aoa-4', 4, 'dictionary', 'solver',
   'migration-0051/artifact-4.tar', 'application/x-tar', 'artifact-sha-4', 104),
  ('${artifactId(5)}', '${ID.result}', '${keeperAttemptId}', '${ID.airfoil}',
   '${rawEngineJobId}', 'aoa-4', 4, 'log', 'stdout',
   'migration-0051/artifact-5.log', 'text/plain', 'artifact-sha-5', 105),
  ('${artifactId(6)}', '${ID.result}', '${keeperAttemptId}', '${ID.airfoil}',
   '${rawEngineJobId}', 'aoa-4', 4, 'vtk_window', 'window',
   'migration-0051/artifact-6.tar', 'application/x-tar', 'artifact-sha-6', 106);
`;

async function seedProductionShape(
  sql: ReturnType<typeof postgres>,
  options: { divergent: boolean },
): Promise<void> {
  await sql.unsafe(setupSql);
  await sql.unsafe(attemptsSql(options.divergent));
  await sql.unsafe(durableReferenceSql);
}

let admin: ReturnType<typeof postgres> | null = null;
let upgradeClient: ReturnType<typeof postgres> | null = null;
let divergentClient: ReturnType<typeof postgres> | null = null;
let ambiguousClient: ReturnType<typeof postgres> | null = null;
let classificationDivergentClient: ReturnType<typeof postgres> | null = null;
let baselineDir = "";

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  baselineDir = makeBaselineFolder();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${upgradeDbName}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${upgradeDbName}"`);
  upgradeClient = postgres(targetUrl(upgradeDbName), { max: 1 });
  const db = drizzle(upgradeClient);
  await migrate(db, { migrationsFolder: baselineDir });
  await seedProductionShape(upgradeClient, { divergent: false });
  await migrate(db, { migrationsFolder: migrations });
}, 180_000);

afterAll(async () => {
  if (upgradeClient) await upgradeClient.end();
  if (divergentClient) await divergentClient.end();
  if (ambiguousClient) await ambiguousClient.end();
  if (classificationDivergentClient) await classificationDivergentClient.end();
  if (admin) {
    await admin.unsafe(
      `DROP DATABASE IF EXISTS "${upgradeDbName}" WITH (FORCE)`,
    );
    await admin.unsafe(
      `DROP DATABASE IF EXISTS "${divergentDbName}" WITH (FORCE)`,
    );
    await admin.unsafe(
      `DROP DATABASE IF EXISTS "${ambiguousDbName}" WITH (FORCE)`,
    );
    await admin.unsafe(
      `DROP DATABASE IF EXISTS "${classificationDivergentDbName}" WITH (FORCE)`,
    );
    await admin.end();
  }
  if (baselineDir) rmSync(baselineDir, { recursive: true, force: true });
});

describe("0051 remote-attempt identity populated upgrade", () => {
  it("namespaces attributable evidence and preserves every durable reference on one keeper", async () => {
    const attempts = (await upgradeClient!.unsafe(`
      SELECT id, engine_job_id, regime
      FROM result_attempts
      WHERE result_id = '${ID.result}'
      ORDER BY id
    `)) as unknown as Array<{
      id: string;
      engine_job_id: string;
      regime: string;
    }>;
    expect(attempts).toEqual([
      {
        id: keeperAttemptId,
        engine_job_id: namespacedEngineJobId,
        regime: "urans",
      },
    ]);

    const results = (await upgradeClient!.unsafe(`
      SELECT id, engine_job_id FROM results WHERE id = '${ID.result}'
    `)) as unknown as Array<{ id: string; engine_job_id: string }>;
    expect(results).toEqual([
      { id: ID.result, engine_job_id: namespacedEngineJobId },
    ]);

    const artifacts = (await upgradeClient!.unsafe(`
      SELECT id, result_attempt_id, engine_job_id
      FROM solver_evidence_artifacts
      WHERE result_id = '${ID.result}'
      ORDER BY id
    `)) as unknown as Array<{
      id: string;
      result_attempt_id: string;
      engine_job_id: string;
    }>;
    expect(artifacts).toHaveLength(6);
    expect(artifacts.map((artifact) => artifact.id)).toEqual(
      Array.from({ length: 6 }, (_, index) => artifactId(index + 1)),
    );
    expect(
      new Set(artifacts.map((artifact) => artifact.result_attempt_id)),
    ).toEqual(new Set([keeperAttemptId]));
    expect(
      new Set(artifacts.map((artifact) => artifact.engine_job_id)),
    ).toEqual(new Set([namespacedEngineJobId]));

    const classifications = (await upgradeClient!.unsafe(`
      SELECT id, result_attempt_id, state, reasons
      FROM result_classifications
      WHERE result_attempt_id = '${keeperAttemptId}'
    `)) as unknown as Array<{
      id: string;
      result_attempt_id: string;
      state: string;
      reasons: string[];
    }>;
    expect(classifications).toEqual([
      {
        id: ID.classification,
        result_attempt_id: keeperAttemptId,
        state: "accepted",
        reasons: ["accepted remote evidence"],
      },
    ]);

    const durableReferences = (await upgradeClient!.unsafe(`
      SELECT
        (SELECT source_result_attempt_id FROM sim_precalc_obligations
         WHERE id = '${ID.obligation}') AS obligation_attempt_id,
        (SELECT result_attempt_id FROM sim_precalc_obligation_attempts
         WHERE id = '${ID.obligationAttempt}') AS obligation_audit_attempt_id,
        (SELECT result_attempt_id FROM remote_asset_references
         WHERE id = '${ID.remoteReference}') AS remote_reference_attempt_id,
        (SELECT result_attempt_id FROM sim_campaign_points
         WHERE campaign_id = '${ID.campaign}'
           AND condition_id = '${ID.campaignCondition}'
           AND airfoil_id = '${ID.airfoil}'
           AND aoa_deg = 4) AS campaign_point_attempt_id
    `)) as unknown as Array<{
      obligation_attempt_id: string;
      obligation_audit_attempt_id: string;
      remote_reference_attempt_id: string;
      campaign_point_attempt_id: string;
    }>;
    expect(durableReferences).toEqual([
      {
        obligation_attempt_id: keeperAttemptId,
        obligation_audit_attempt_id: keeperAttemptId,
        remote_reference_attempt_id: keeperAttemptId,
        campaign_point_attempt_id: keeperAttemptId,
      },
    ]);

    const attemptForeignKeys = (await upgradeClient!.unsafe(`
      SELECT constraint_row.conname AS constraint_name,
             owner.relname AS owner_table,
             attribute.attname AS owner_column,
             constraint_row.confdeltype AS delete_action
      FROM pg_constraint constraint_row
      JOIN pg_class owner ON owner.oid = constraint_row.conrelid
      JOIN pg_attribute attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = constraint_row.conkey[1]
      WHERE constraint_row.contype = 'f'
        AND constraint_row.confrelid = 'result_attempts'::regclass
        AND constraint_row.conname IN (
          'remote_asset_references_attempt_id_attempts_id_fk',
          'result_classifications_result_attempt_id_result_attempts_id_fk',
          'sim_campaign_points_result_attempt_id_fkey',
          'sim_precalc_obligation_attempts_result_attempt_id_fkey',
          'sim_precalc_obligations_source_result_attempt_id_fkey',
          'solver_evidence_artifacts_result_attempt_id_result_attempts_id_'
        )
      ORDER BY constraint_row.conname
    `)) as unknown as Array<{
      constraint_name: string;
      owner_table: string;
      owner_column: string;
      delete_action: string;
    }>;
    expect(attemptForeignKeys).toEqual([
      {
        constraint_name: "remote_asset_references_attempt_id_attempts_id_fk",
        owner_table: "remote_asset_references",
        owner_column: "result_attempt_id",
        delete_action: "n",
      },
      {
        constraint_name:
          "result_classifications_result_attempt_id_result_attempts_id_fk",
        owner_table: "result_classifications",
        owner_column: "result_attempt_id",
        delete_action: "c",
      },
      {
        constraint_name: "sim_campaign_points_result_attempt_id_fkey",
        owner_table: "sim_campaign_points",
        owner_column: "result_attempt_id",
        delete_action: "n",
      },
      {
        constraint_name:
          "sim_precalc_obligation_attempts_result_attempt_id_fkey",
        owner_table: "sim_precalc_obligation_attempts",
        owner_column: "result_attempt_id",
        delete_action: "n",
      },
      {
        constraint_name:
          "sim_precalc_obligations_source_result_attempt_id_fkey",
        owner_table: "sim_precalc_obligations",
        owner_column: "source_result_attempt_id",
        delete_action: "n",
      },
      {
        constraint_name:
          "solver_evidence_artifacts_result_attempt_id_result_attempts_id_",
        owner_table: "solver_evidence_artifacts",
        owner_column: "result_attempt_id",
        delete_action: "c",
      },
    ]);

    const indexes = (await upgradeClient!.unsafe(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'result_attempts_remote_engine_aoa_regime_uq'
    `)) as unknown as Array<{ indexname: string }>;
    expect(indexes).toEqual([
      { indexname: "result_attempts_remote_engine_aoa_regime_uq" },
    ]);

    await expect(
      upgradeClient!.unsafe(`
        INSERT INTO result_attempts
          (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id,
           aoa_deg, sim_job_id, engine_job_id, engine_case_slug, status,
           source, regime, valid_for_polar, cl, cd, cm, converged, unsteady,
           stalled, evidence_payload)
        VALUES
          ('54000000-0000-0000-0000-000000000001', '${ID.result}',
           '${ID.airfoil}', '${ID.bc}', '${ID.revision}', 4, NULL,
           '${namespacedEngineJobId}', 'duplicate', 'done', 'solved', 'urans',
           true, 0.7, 0.02, -0.03, true, true, false,
           '{"fidelity":"urans_precalc"}'::jsonb)
      `),
    ).rejects.toThrow(/result_attempts_remote_engine_aoa_regime_uq/);

    await expect(
      upgradeClient!.unsafe(`
        INSERT INTO result_attempts
          (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id,
           aoa_deg, sim_job_id, engine_job_id, engine_case_slug, status,
           source, regime, valid_for_polar)
        VALUES
          ('54000000-0000-0000-0000-000000000002', '${ID.result}',
           '${ID.airfoil}', '${ID.bc}', '${ID.revision}', 5, NULL,
           'sync:${sourceInstanceId}:other-job', 'missing-regime', 'done',
           'solved', NULL, false)
      `),
    ).rejects.toThrow(/result_attempts_remote_regime_required_check/);
  }, 60_000);

  it("aborts instead of collapsing divergent immutable evidence", async () => {
    await admin!.unsafe(
      `DROP DATABASE IF EXISTS "${divergentDbName}" WITH (FORCE)`,
    );
    await admin!.unsafe(`CREATE DATABASE "${divergentDbName}"`);
    divergentClient = postgres(targetUrl(divergentDbName), { max: 1 });
    const db = drizzle(divergentClient);
    await migrate(db, { migrationsFolder: baselineDir });
    await seedProductionShape(divergentClient, { divergent: true });

    await expect(migrate(db, { migrationsFolder: migrations })).rejects.toThrow(
      /0051 refuses to collapse divergent remote result attempts/,
    );

    const rollbackEvidence = (await divergentClient.unsafe(`
      SELECT count(*)::int AS attempt_count,
             count(*) FILTER (WHERE engine_job_id = '${rawEngineJobId}')::int AS raw_count,
             count(*) FILTER (WHERE engine_job_id LIKE 'sync:%')::int AS namespaced_count
      FROM result_attempts
      WHERE result_id = '${ID.result}'
    `)) as unknown as Array<{
      attempt_count: number;
      raw_count: number;
      namespaced_count: number;
    }>;
    expect(rollbackEvidence).toEqual([
      { attempt_count: 13, raw_count: 13, namespaced_count: 0 },
    ]);

    const resultRows = (await divergentClient.unsafe(`
      SELECT engine_job_id FROM results WHERE id = '${ID.result}'
    `)) as unknown as Array<{ engine_job_id: string }>;
    expect(resultRows).toEqual([{ engine_job_id: rawEngineJobId }]);

    const campaignPointRows = (await divergentClient.unsafe(`
      SELECT result_attempt_id
      FROM sim_campaign_points
      WHERE campaign_id = '${ID.campaign}'
        AND condition_id = '${ID.campaignCondition}'
        AND airfoil_id = '${ID.airfoil}'
        AND aoa_deg = 4
    `)) as unknown as Array<{ result_attempt_id: string }>;
    expect(campaignPointRows).toEqual([{ result_attempt_id: attemptId(6) }]);
  }, 180_000);

  it("aborts when one result is attributed to more than one remote source", async () => {
    await admin!.unsafe(
      `DROP DATABASE IF EXISTS "${ambiguousDbName}" WITH (FORCE)`,
    );
    await admin!.unsafe(`CREATE DATABASE "${ambiguousDbName}"`);
    ambiguousClient = postgres(targetUrl(ambiguousDbName), { max: 1 });
    const db = drizzle(ambiguousClient);
    await migrate(db, { migrationsFolder: baselineDir });
    await seedProductionShape(ambiguousClient, { divergent: false });
    await ambiguousClient.unsafe(`
      INSERT INTO sync_sweep_promises
        (id, source_instance_id, source_instance_name, status, airfoil_id,
         simulation_preset_revision_id, aoa_count, "expiresAt", "fulfilledAt")
      VALUES
        ('55000000-0000-0000-0000-000000000001', 'other-remote-prod',
         'Other remote production solver', 'fulfilled', '${ID.airfoil}',
         '${ID.revision}', 1, TIMESTAMPTZ '2026-07-12 00:00:00+00',
         TIMESTAMPTZ '2026-07-11 01:03:00+00');
      INSERT INTO sync_sweep_promise_points
        (id, promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
         status, result_id, "updatedAt")
      VALUES
        ('55000000-0000-0000-0000-000000000002',
         '55000000-0000-0000-0000-000000000001', '${ID.airfoil}',
         '${ID.revision}', 4, 'fulfilled', '${ID.result}',
         TIMESTAMPTZ '2026-07-11 01:03:00+00');
    `);

    await expect(migrate(db, { migrationsFolder: migrations })).rejects.toThrow(
      /0051 refuses ambiguous remote result provenance/,
    );

    const rollbackRows = (await ambiguousClient.unsafe(`
      SELECT count(*)::int AS attempt_count,
             count(*) FILTER (WHERE engine_job_id = '${rawEngineJobId}')::int AS raw_count
      FROM result_attempts
      WHERE result_id = '${ID.result}'
    `)) as unknown as Array<{ attempt_count: number; raw_count: number }>;
    expect(rollbackRows).toEqual([{ attempt_count: 13, raw_count: 13 }]);
  }, 180_000);

  it("aborts instead of selecting among divergent stored classifications", async () => {
    await admin!.unsafe(
      `DROP DATABASE IF EXISTS "${classificationDivergentDbName}" WITH (FORCE)`,
    );
    await admin!.unsafe(`CREATE DATABASE "${classificationDivergentDbName}"`);
    classificationDivergentClient = postgres(
      targetUrl(classificationDivergentDbName),
      { max: 1 },
    );
    const db = drizzle(classificationDivergentClient);
    await migrate(db, { migrationsFolder: baselineDir });
    await seedProductionShape(classificationDivergentClient, {
      divergent: false,
    });
    await classificationDivergentClient.unsafe(`
      INSERT INTO result_classifications
        (id, result_attempt_id, airfoil_id, simulation_preset_revision_id,
         aoa_deg, regime, classifier_version, state, region, confidence,
         reasons)
      VALUES
        ('56000000-0000-0000-0000-000000000001', '${attemptId(2)}',
         '${ID.airfoil}', '${ID.revision}', 4, 'urans', 'remote-upgrade-v2',
         'rejected', 'post_stall', 0.25, ARRAY['divergent verdict']);
    `);

    await expect(migrate(db, { migrationsFolder: migrations })).rejects.toThrow(
      /0051 refuses to collapse divergent remote attempt classifications/,
    );

    const rollbackRows = (await classificationDivergentClient.unsafe(`
      SELECT count(*)::int AS attempt_count,
             count(*) FILTER (WHERE engine_job_id = '${rawEngineJobId}')::int AS raw_count
      FROM result_attempts
      WHERE result_id = '${ID.result}'
    `)) as unknown as Array<{ attempt_count: number; raw_count: number }>;
    expect(rollbackRows).toEqual([{ attempt_count: 13, raw_count: 13 }]);
  }, 180_000);
});
