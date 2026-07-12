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
const latestMigrationTimestamp = String(
  Math.max(
    ...(
      JSON.parse(
        readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
      ) as { entries: Array<{ when: number }> }
    ).entries.map((entry) => entry.when),
  ),
);
const runId = `${process.pid}_${Date.now()}`;
const dbName = `aerodb_rd0052_${runId}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

const ID = {
  category: "62000000-0000-0000-0000-000000000001",
  airfoil: "62000000-0000-0000-0000-000000000002",
  medium: "62000000-0000-0000-0000-000000000003",
  flow: "62000000-0000-0000-0000-000000000004",
  geometry: "62000000-0000-0000-0000-000000000005",
  boundary: "62000000-0000-0000-0000-000000000006",
  mesh: "62000000-0000-0000-0000-000000000007",
  solver: "62000000-0000-0000-0000-000000000008",
  scheduling: "62000000-0000-0000-0000-000000000009",
  output: "62000000-0000-0000-0000-00000000000a",
  sweep: "62000000-0000-0000-0000-00000000000b",
  bc: "62000000-0000-0000-0000-00000000000c",
  preset: "62000000-0000-0000-0000-00000000000d",
  revision: "62000000-0000-0000-0000-00000000000e",

  deliveryPromise: "62000000-0000-0000-0000-000000000101",
  exactPromise: "62000000-0000-0000-0000-000000000102",
  ambiguousPromise: "62000000-0000-0000-0000-000000000103",
  activeNoWorkPromise: "62000000-0000-0000-0000-000000000104",
  exactPoint: "62000000-0000-0000-0000-000000000111",
  ambiguousPoint: "62000000-0000-0000-0000-000000000112",
  activeNoWorkPointA: "62000000-0000-0000-0000-000000000113",
  activeNoWorkPointB: "62000000-0000-0000-0000-000000000114",

  emptyParentJob: "62000000-0000-0000-0000-000000000201",
  deliveryJob: "62000000-0000-0000-0000-000000000202",
  rejectedParentJob: "62000000-0000-0000-0000-000000000203",
  ambiguousSiblingJob: "62000000-0000-0000-0000-000000000204",

  deliveryResult: "62000000-0000-0000-0000-000000000301",
  exactResult: "62000000-0000-0000-0000-000000000302",
  ambiguousResult: "62000000-0000-0000-0000-000000000303",

  deliveryAttempt: "62000000-0000-0000-0000-000000000401",
  deliveryWrongRegimeAttempt: "62000000-0000-0000-0000-000000000407",
  deliveryRejectedParentAttempt: "62000000-0000-0000-0000-000000000402",
  exactAcceptedAttempt: "62000000-0000-0000-0000-000000000403",
  exactRejectedParentAttempt: "62000000-0000-0000-0000-000000000404",
  ambiguousNullJobAttempt: "62000000-0000-0000-0000-000000000405",
  ambiguousSiblingAttempt: "62000000-0000-0000-0000-000000000406",

  sharedArtifact: "62000000-0000-0000-0000-000000000501",
  conflictKeeper: "62000000-0000-0000-0000-000000000601",
  conflictDuplicate: "62000000-0000-0000-0000-000000000602",
  conflictResolved: "62000000-0000-0000-0000-000000000603",
} as const;

const sourceInstanceId = "remote-delivery-prod";
const sharedStorageKey = "migration-0052/shared-mesh.tar.zst";
const sharedSha256 = "shared-immutable-mesh-sha256";
const exactEngineJobId = `sync:${sourceInstanceId}:exact-current`;
const ambiguousEngineJobId = `sync:${sourceInstanceId}:ambiguous-current`;

function makeBaselineFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "aerodb-migrations-0051-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= 51);
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
  ('${ID.category}', 'remote-delivery-upgrade', 'remote delivery upgrade', 'remote-delivery-upgrade');
INSERT INTO airfoils (id, slug, name, category_id, points, is_symmetric) VALUES
  ('${ID.airfoil}', 'remote-delivery-foil', 'remote delivery foil', '${ID.category}',
   '[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]'::jsonb, false);
INSERT INTO mediums
  (id, slug, name, phase, density, viscosity_model,
   constant_dynamic_viscosity, dynamic_viscosity, kinematic_viscosity, speed_of_sound)
VALUES ('${ID.medium}', 'remote-delivery-air', 'remote delivery air', 'gas', 1.225, 'constant',
        0.00001789, 0.00001789, 0.000014604, 340.3);
INSERT INTO flow_conditions
  (id, slug, name, medium_id, speed_mps, density, dynamic_viscosity, kinematic_viscosity)
VALUES ('${ID.flow}', 'remote-delivery-flow', 'remote delivery flow', '${ID.medium}', 20,
        1.225, 0.00001789, 0.000014604);
INSERT INTO reference_geometry_profiles (id, slug, name, reference_length_m)
VALUES ('${ID.geometry}', 'remote-delivery-geo', 'remote delivery geo', 1);
INSERT INTO boundary_profiles (id, slug, name) VALUES
  ('${ID.boundary}', 'remote-delivery-boundary', 'remote delivery boundary');
INSERT INTO mesh_profiles (id, slug, name) VALUES
  ('${ID.mesh}', 'remote-delivery-mesh', 'remote delivery mesh');
INSERT INTO solver_profiles (id, slug, name) VALUES
  ('${ID.solver}', 'remote-delivery-solver', 'remote delivery solver');
INSERT INTO scheduling_profiles (id, slug, name) VALUES
  ('${ID.scheduling}', 'remote-delivery-scheduling', 'remote delivery scheduling');
INSERT INTO output_profiles (id, slug, name) VALUES
  ('${ID.output}', 'remote-delivery-output', 'remote delivery output');
INSERT INTO sweep_definitions (id, slug, name, aoa_list) VALUES
  ('${ID.sweep}', 'remote-delivery-sweep', 'remote delivery sweep', '[2,6,8]'::jsonb);
INSERT INTO boundary_conditions
  (id, slug, name, medium_id, reynolds, reference_chord_m, speed_mps,
   density, dynamic_viscosity, kinematic_viscosity)
VALUES ('${ID.bc}', 'remote-delivery-bc', 'remote delivery bc', '${ID.medium}', 1369491,
        1, 20, 1.225, 0.00001789, 0.000014604);
INSERT INTO simulation_presets
  (id, slug, name, flow_condition_id, reference_geometry_profile_id,
   boundary_profile_id, mesh_profile_id, solver_profile_id,
   scheduling_profile_id, output_profile_id, sweep_definition_id,
   legacy_boundary_condition_id)
VALUES ('${ID.preset}', 'remote-delivery-preset', 'remote delivery preset', '${ID.flow}',
        '${ID.geometry}', '${ID.boundary}', '${ID.mesh}', '${ID.solver}',
        '${ID.scheduling}', '${ID.output}', '${ID.sweep}', '${ID.bc}');
INSERT INTO simulation_preset_revisions
  (id, preset_id, revision_number, signature_hash, reynolds,
   reference_length_m, snapshot)
VALUES ('${ID.revision}', '${ID.preset}', 1, 'remote-delivery-signature', 1369491, 1,
        '{}'::jsonb);

INSERT INTO sync_sweep_promises
  (id, source_instance_id, source_instance_name, status, airfoil_id,
   simulation_preset_revision_id, aoa_count, "expiresAt", "fulfilledAt")
VALUES
  ('${ID.deliveryPromise}', '${sourceInstanceId}', 'Remote delivery production', 'fulfilled',
   '${ID.airfoil}', '${ID.revision}', 1, TIMESTAMPTZ '2026-07-12 00:00:00+00',
   TIMESTAMPTZ '2026-07-11 01:00:00+00'),
  ('${ID.exactPromise}', '${sourceInstanceId}', 'Remote delivery production', 'fulfilled',
   '${ID.airfoil}', '${ID.revision}', 1, TIMESTAMPTZ '2026-07-12 00:00:00+00',
   TIMESTAMPTZ '2026-07-11 01:00:00+00'),
  ('${ID.ambiguousPromise}', '${sourceInstanceId}', 'Remote delivery production', 'fulfilled',
   '${ID.airfoil}', '${ID.revision}', 1, TIMESTAMPTZ '2026-07-12 00:00:00+00',
   TIMESTAMPTZ '2026-07-11 01:00:00+00'),
  ('${ID.activeNoWorkPromise}', '${sourceInstanceId}', 'Remote delivery production', 'active',
   '${ID.airfoil}', '${ID.revision}', 2, TIMESTAMPTZ '2026-07-12 02:35:00+00',
   NULL);

INSERT INTO sim_jobs
  (id, engine_job_id, parent_job_id, airfoil_id, bc_ids,
   simulation_preset_revision_id, job_kind, reference_chord_m, wave, status,
   total_cases, completed_cases, request_payload, "submittedAt", "finishedAt")
VALUES
  ('${ID.emptyParentJob}', 'empty-parent-engine', NULL, '${ID.airfoil}',
   '["${ID.bc}"]'::jsonb, '${ID.revision}', 'sweep', 1, 1, 'done', 0, 0,
   '{"syncPromiseId":"${ID.deliveryPromise}","remotePushedAt":"2026-07-11T02:00:00.000Z"}'::jsonb,
   TIMESTAMPTZ '2026-07-11 01:00:00+00', TIMESTAMPTZ '2026-07-11 02:00:00+00'),
  ('${ID.deliveryJob}', 'legacy-delivery-engine', '${ID.emptyParentJob}', '${ID.airfoil}',
   '["${ID.bc}"]'::jsonb, '${ID.revision}', 'targeted', 1, 2, 'done', 1, 1,
   '{"syncPromiseId":"${ID.deliveryPromise}","remotePushedAt":"2026-07-11T02:01:00.000Z"}'::jsonb,
   TIMESTAMPTZ '2026-07-11 01:01:00+00', TIMESTAMPTZ '2026-07-11 02:01:00+00'),
  ('${ID.rejectedParentJob}', 'rejected-parent-engine', NULL, '${ID.airfoil}',
   '["${ID.bc}"]'::jsonb, '${ID.revision}', 'sweep', 1, 1, 'done', 2, 2,
   '{}'::jsonb, TIMESTAMPTZ '2026-07-11 01:02:00+00', TIMESTAMPTZ '2026-07-11 02:02:00+00'),
  ('${ID.ambiguousSiblingJob}', '${ambiguousEngineJobId}', NULL, '${ID.airfoil}',
   '["${ID.bc}"]'::jsonb, '${ID.revision}', 'targeted', 1, 2, 'done', 1, 1,
   '{}'::jsonb, TIMESTAMPTZ '2026-07-11 01:03:00+00', TIMESTAMPTZ '2026-07-11 02:03:00+00');

INSERT INTO results
  (id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg, status,
   source, regime, fidelity, sim_job_id, engine_job_id, engine_case_slug,
   cl, cd, cm, cl_cd, converged, unsteady, stalled, "solvedAt")
VALUES
  ('${ID.deliveryResult}', '${ID.airfoil}', '${ID.bc}', '${ID.revision}', 2, 'done',
   'solved', 'urans', 'urans_precalc', '${ID.deliveryJob}', 'legacy-delivery-engine',
   'aoa-2', 0.4, 0.02, -0.02, 20, true, true, false,
   TIMESTAMPTZ '2026-07-11 01:40:00+00'),
  ('${ID.exactResult}', '${ID.airfoil}', '${ID.bc}', '${ID.revision}', 6, 'done',
   'solved', 'urans', 'urans_precalc', NULL, '${exactEngineJobId}', 'aoa-6',
   0.8, 0.02, -0.02, 40, true, true, false,
   TIMESTAMPTZ '2026-07-11 01:41:00+00'),
  ('${ID.ambiguousResult}', '${ID.airfoil}', '${ID.bc}', '${ID.revision}', 8, 'done',
   'solved', 'urans', 'urans_precalc', NULL, '${ambiguousEngineJobId}', 'aoa-8',
   1.0, 0.025, -0.025, 40, true, true, false,
   TIMESTAMPTZ '2026-07-11 01:42:00+00');

INSERT INTO result_attempts
  (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg,
   sim_job_id, engine_job_id, engine_case_slug, status, source, regime,
   valid_for_polar, cl, cd, cm, cl_cd, converged, unsteady, stalled,
   evidence_payload, "solvedAt", "createdAt")
VALUES
  ('${ID.deliveryAttempt}', '${ID.deliveryResult}', '${ID.airfoil}', '${ID.bc}',
   '${ID.revision}', 2, '${ID.deliveryJob}', 'legacy-delivery-engine', 'aoa-2',
   'done', 'solved', 'urans', true, 0.4, 0.02, -0.02, 20, true, true, false,
   '{"fidelity":"urans_precalc"}'::jsonb, TIMESTAMPTZ '2026-07-11 01:40:00+00',
   TIMESTAMPTZ '2026-07-11 01:40:00+00'),
  ('${ID.deliveryWrongRegimeAttempt}', '${ID.deliveryResult}', '${ID.airfoil}', '${ID.bc}',
   '${ID.revision}', 2, '${ID.deliveryJob}', 'legacy-delivery-engine', 'aoa-2',
   'done', 'solved', 'rans', false, 0.4, 0.02, -0.02, 20, true, false, false,
   '{"fidelity":"rans"}'::jsonb, TIMESTAMPTZ '2026-07-11 01:45:00+00',
   TIMESTAMPTZ '2026-07-11 01:45:00+00'),
  ('${ID.deliveryRejectedParentAttempt}', '${ID.deliveryResult}', '${ID.airfoil}', '${ID.bc}',
   '${ID.revision}', 2, '${ID.emptyParentJob}', 'legacy-delivery-engine', 'aoa-2',
   'done', 'solved', 'urans', false, 0.39, 0.03, -0.02, 13, true, true, true,
   '{"fidelity":"urans_precalc"}'::jsonb, TIMESTAMPTZ '2026-07-11 01:35:00+00',
   TIMESTAMPTZ '2026-07-11 01:35:00+00'),
  ('${ID.exactAcceptedAttempt}', '${ID.exactResult}', '${ID.airfoil}', '${ID.bc}',
   '${ID.revision}', 6, NULL, '${exactEngineJobId}', 'aoa-6', 'done', 'solved',
   'urans', true, 0.8, 0.02, -0.02, 40, true, true, false,
   '{"fidelity":"urans_precalc"}'::jsonb, TIMESTAMPTZ '2026-07-11 01:41:00+00',
   TIMESTAMPTZ '2026-07-11 01:41:00+00'),
  ('${ID.exactRejectedParentAttempt}', '${ID.exactResult}', '${ID.airfoil}', '${ID.bc}',
   '${ID.revision}', 6, '${ID.rejectedParentJob}', '${exactEngineJobId}', 'aoa-6',
   'done', 'solved', 'urans', false, 0.78, 0.03, -0.02, 26, true, true, true,
   '{"fidelity":"urans_precalc"}'::jsonb, TIMESTAMPTZ '2026-07-11 01:38:00+00',
   TIMESTAMPTZ '2026-07-11 01:38:00+00'),
  ('${ID.ambiguousNullJobAttempt}', '${ID.ambiguousResult}', '${ID.airfoil}', '${ID.bc}',
   '${ID.revision}', 8, NULL, '${ambiguousEngineJobId}', 'aoa-8', 'done', 'solved',
   'urans', true, 1.0, 0.025, -0.025, 40, true, true, false,
   '{"fidelity":"urans_precalc"}'::jsonb, TIMESTAMPTZ '2026-07-11 01:42:00+00',
   TIMESTAMPTZ '2026-07-11 01:42:00+00'),
  ('${ID.ambiguousSiblingAttempt}', '${ID.ambiguousResult}', '${ID.airfoil}', '${ID.bc}',
   '${ID.revision}', 8, '${ID.ambiguousSiblingJob}', '${ambiguousEngineJobId}', 'aoa-8',
   'done', 'solved', 'urans', true, 1.0, 0.025, -0.025, 40, true, true, false,
   '{"fidelity":"urans_precalc"}'::jsonb, TIMESTAMPTZ '2026-07-11 01:42:00+00',
   TIMESTAMPTZ '2026-07-11 01:43:00+00');

INSERT INTO result_classifications
  (id, result_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
   regime, classifier_version, state, reasons)
VALUES
  ('62000000-0000-0000-0000-000000000701', '${ID.deliveryResult}', '${ID.airfoil}',
   '${ID.revision}', 2, 'urans', 'migration-0052-v1', 'accepted', ARRAY[]::text[]),
  ('62000000-0000-0000-0000-000000000702', '${ID.exactResult}', '${ID.airfoil}',
   '${ID.revision}', 6, 'urans', 'migration-0052-v1', 'accepted', ARRAY[]::text[]),
  ('62000000-0000-0000-0000-000000000703', '${ID.ambiguousResult}', '${ID.airfoil}',
   '${ID.revision}', 8, 'urans', 'migration-0052-v1', 'accepted', ARRAY[]::text[]);
INSERT INTO result_classifications
  (id, result_attempt_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
   regime, classifier_version, state, reasons)
VALUES
  ('62000000-0000-0000-0000-000000000711', '${ID.deliveryAttempt}', '${ID.airfoil}',
   '${ID.revision}', 2, 'urans', 'migration-0052-v1', 'accepted', ARRAY[]::text[]),
  ('62000000-0000-0000-0000-000000000712', '${ID.deliveryRejectedParentAttempt}', '${ID.airfoil}',
   '${ID.revision}', 2, 'urans', 'migration-0052-v1', 'rejected', ARRAY['rejected parent']),
  ('62000000-0000-0000-0000-000000000713', '${ID.exactAcceptedAttempt}', '${ID.airfoil}',
   '${ID.revision}', 6, 'urans', 'migration-0052-v1', 'accepted', ARRAY[]::text[]),
  ('62000000-0000-0000-0000-000000000714', '${ID.exactRejectedParentAttempt}', '${ID.airfoil}',
   '${ID.revision}', 6, 'urans', 'migration-0052-v1', 'rejected', ARRAY['rejected parent']),
  ('62000000-0000-0000-0000-000000000715', '${ID.ambiguousNullJobAttempt}', '${ID.airfoil}',
   '${ID.revision}', 8, 'urans', 'migration-0052-v1', 'accepted', ARRAY[]::text[]),
  ('62000000-0000-0000-0000-000000000716', '${ID.ambiguousSiblingAttempt}', '${ID.airfoil}',
   '${ID.revision}', 8, 'urans', 'migration-0052-v1', 'accepted', ARRAY[]::text[]);

INSERT INTO sync_sweep_promise_points
  (id, promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
   status, result_id, "createdAt", "updatedAt")
VALUES
  ('${ID.exactPoint}', '${ID.exactPromise}', '${ID.airfoil}', '${ID.revision}', 6,
   'fulfilled', '${ID.exactResult}', TIMESTAMPTZ '2026-07-11 01:50:00+00',
   TIMESTAMPTZ '2026-07-11 01:50:00+00'),
  ('${ID.ambiguousPoint}', '${ID.ambiguousPromise}', '${ID.airfoil}', '${ID.revision}', 8,
   'fulfilled', '${ID.ambiguousResult}', TIMESTAMPTZ '2026-07-11 01:51:00+00',
   TIMESTAMPTZ '2026-07-11 01:51:00+00'),
  ('${ID.activeNoWorkPointA}', '${ID.activeNoWorkPromise}', '${ID.airfoil}', '${ID.revision}', 20,
   'active', NULL, TIMESTAMPTZ '2026-07-11 02:00:00+00',
   TIMESTAMPTZ '2026-07-11 02:00:00+00'),
  ('${ID.activeNoWorkPointB}', '${ID.activeNoWorkPromise}', '${ID.airfoil}', '${ID.revision}', 24,
   'active', NULL, TIMESTAMPTZ '2026-07-11 02:00:00+00',
   TIMESTAMPTZ '2026-07-11 02:00:00+00');

INSERT INTO solver_evidence_artifacts
  (id, result_id, result_attempt_id, airfoil_id, engine_job_id,
   engine_case_slug, aoa_deg, kind, role, storage_key, mime_type, sha256,
   byte_size)
VALUES
  ('${ID.sharedArtifact}', '${ID.exactResult}', '${ID.exactAcceptedAttempt}',
   '${ID.airfoil}', '${exactEngineJobId}', 'aoa-6', 6, 'mesh', 'shared-mesh',
   '${sharedStorageKey}', 'application/zstd', '${sharedSha256}', 4096);

INSERT INTO sync_import_conflicts
  (id, data_type, natural_key, source_instance_id, source_instance_name,
   status, incoming_payload, local_snapshot, artifact_manifest,
   "createdAt", "updatedAt")
VALUES
  ('${ID.conflictKeeper}', 'polars', 'foil/revision/6', '${sourceInstanceId}',
   'Remote delivery production', 'pending',
   '{"z":3,"nested":{"b":2,"a":1},"arr":[2,1]}'::jsonb,
   '{"local":"keeper snapshot"}'::jsonb,
   '{"media":[{"sha256":"same","role":"history"}]}'::jsonb,
   TIMESTAMPTZ '2026-07-11 03:00:00+00', TIMESTAMPTZ '2026-07-11 03:00:00+00'),
  ('${ID.conflictDuplicate}', 'polars', 'foil/revision/6', '${sourceInstanceId}',
   'Renamed remote', 'pending',
   '{"arr":[2,1],"nested":{"a":1,"b":2},"z":3}'::jsonb,
   '{"local":"different non-identity snapshot"}'::jsonb,
   '{"media":[{"role":"history","sha256":"same"}]}'::jsonb,
   TIMESTAMPTZ '2026-07-11 03:01:00+00', TIMESTAMPTZ '2026-07-11 03:01:00+00'),
  ('${ID.conflictResolved}', 'polars', 'foil/revision/6', '${sourceInstanceId}',
   'Remote delivery production', 'archived',
   '{"z":3,"nested":{"b":2,"a":1},"arr":[2,1]}'::jsonb,
   NULL, '{"media":[{"sha256":"same","role":"history"}]}'::jsonb,
   TIMESTAMPTZ '2026-07-11 02:59:00+00', TIMESTAMPTZ '2026-07-11 02:59:00+00');
`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let baselineDir = "";

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  baselineDir = makeBaselineFolder();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  client = postgres(targetUrl.toString(), { max: 1 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: baselineDir });
  await client.unsafe(setupSql);
  await migrate(db, { migrationsFolder: migrations });
}, 180_000);

afterAll(async () => {
  if (client) await client.end();
  if (admin) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  }
  if (baselineDir) rmSync(baselineDir, { recursive: true, force: true });
});

describe("0051→0052 remote delivery and evidence-association upgrade", () => {
  it("migrates a populated 0051 database through 0052", async () => {
    const rows = (await client!.unsafe(`
      SELECT
        to_regclass('public.sync_remote_result_deliveries')::text AS delivery_table,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'sync_sweep_promise_points'
            AND column_name = 'result_attempt_id'
        ) AS point_attempt_column,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'sync_import_conflicts'
            AND column_name = 'fingerprint'
        ) AS conflict_fingerprint_column,
        (SELECT max(created_at)::text FROM drizzle.__drizzle_migrations) AS latest_migration
    `)) as unknown as Array<{
      delivery_table: string;
      point_attempt_column: boolean;
      conflict_fingerprint_column: boolean;
      latest_migration: string;
    }>;
    expect(rows).toEqual([
      {
        delivery_table: "sync_remote_result_deliveries",
        point_attempt_column: true,
        conflict_fingerprint_column: true,
        latest_migration: latestMigrationTimestamp,
      },
    ]);
  });

  it("allows one immutable blob to be associated with distinct owners but rejects an exact owner duplicate", async () => {
    const indexes = (await client!.unsafe(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'solver_evidence_artifacts_storage_uq',
          'solver_evidence_artifacts_blob_idx',
          'solver_evidence_artifacts_attempt_content_uq',
          'solver_evidence_artifacts_result_content_uq'
        )
      ORDER BY indexname
    `)) as unknown as Array<{ indexname: string; indexdef: string }>;
    expect(indexes.map((index) => index.indexname)).toEqual([
      "solver_evidence_artifacts_attempt_content_uq",
      "solver_evidence_artifacts_blob_idx",
      "solver_evidence_artifacts_result_content_uq",
    ]);
    expect(
      indexes.find(
        (index) =>
          index.indexname === "solver_evidence_artifacts_attempt_content_uq",
      )?.indexdef,
    ).toContain("WHERE (result_attempt_id IS NOT NULL)");
    expect(
      indexes.find(
        (index) =>
          index.indexname === "solver_evidence_artifacts_result_content_uq",
      )?.indexdef,
    ).toContain(
      "WHERE ((result_attempt_id IS NULL) AND (result_id IS NOT NULL))",
    );

    await client!.unsafe(`
      INSERT INTO solver_evidence_artifacts
        (id, result_id, result_attempt_id, airfoil_id, engine_job_id,
         engine_case_slug, aoa_deg, kind, role, storage_key, mime_type, sha256,
         byte_size)
      VALUES
        ('62000000-0000-0000-0000-000000000502', '${ID.deliveryResult}',
         '${ID.deliveryAttempt}', '${ID.airfoil}', 'legacy-delivery-engine',
         'aoa-2', 2, 'mesh', 'shared-mesh', '${sharedStorageKey}',
         'application/zstd', '${sharedSha256}', 4096),
        ('62000000-0000-0000-0000-000000000503', '${ID.ambiguousResult}',
         NULL, '${ID.airfoil}', '${ambiguousEngineJobId}', 'aoa-8', 8,
         'mesh', 'shared-mesh', '${sharedStorageKey}', 'application/zstd',
         '${sharedSha256}', 4096)
    `);

    const sharedRows = (await client!.unsafe(`
      SELECT result_id, result_attempt_id
      FROM solver_evidence_artifacts
      WHERE storage_key = '${sharedStorageKey}' AND sha256 = '${sharedSha256}'
      ORDER BY result_id, result_attempt_id NULLS LAST
    `)) as unknown as Array<{
      result_id: string;
      result_attempt_id: string | null;
    }>;
    expect(sharedRows).toHaveLength(3);
    expect(new Set(sharedRows.map((row) => row.result_id))).toEqual(
      new Set([ID.deliveryResult, ID.exactResult, ID.ambiguousResult]),
    );

    await expect(
      client!.unsafe(`
        INSERT INTO solver_evidence_artifacts
          (id, result_id, result_attempt_id, airfoil_id, engine_job_id,
           engine_case_slug, aoa_deg, kind, role, storage_key, mime_type,
           sha256, byte_size)
        VALUES
          ('62000000-0000-0000-0000-000000000504', '${ID.deliveryResult}',
           '${ID.deliveryAttempt}', '${ID.airfoil}', 'legacy-delivery-engine',
           'aoa-2', 2, 'mesh', 'shared-mesh', '${sharedStorageKey}',
           'application/zstd', '${sharedSha256}', 4096)
      `),
    ).rejects.toThrow(/solver_evidence_artifacts_attempt_content_uq/);

    await expect(
      client!.unsafe(`
        INSERT INTO solver_evidence_artifacts
          (id, result_id, result_attempt_id, airfoil_id, engine_job_id,
           engine_case_slug, aoa_deg, kind, role, storage_key, mime_type,
           sha256, byte_size)
        VALUES
          ('62000000-0000-0000-0000-000000000505', '${ID.ambiguousResult}',
           NULL, '${ID.airfoil}', '${ambiguousEngineJobId}', 'aoa-8', 8,
           'mesh', 'shared-mesh', '${sharedStorageKey}', 'application/zstd',
           '${sharedSha256}', 4096)
      `),
    ).rejects.toThrow(/solver_evidence_artifacts_result_content_uq/);
  });

  it("backfills one result delivery for a stamped solved child and one marker for its empty parent", async () => {
    const rows = (await client!.unsafe(`
      SELECT sim_job_id, result_id, result_attempt_id, aoa_deg::float8 AS aoa,
             generation_key, state, delivered_at
      FROM sync_remote_result_deliveries
      WHERE promise_id = '${ID.deliveryPromise}'
      ORDER BY sim_job_id, result_id NULLS FIRST
    `)) as unknown as Array<{
      sim_job_id: string;
      result_id: string | null;
      result_attempt_id: string | null;
      aoa: number | null;
      generation_key: string;
      state: string;
      delivered_at: Date;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sim_job_id: ID.deliveryJob,
          result_id: ID.deliveryResult,
          result_attempt_id: ID.deliveryAttempt,
          aoa: 2,
          generation_key: ID.deliveryAttempt,
          state: "delivered",
        }),
        expect.objectContaining({
          sim_job_id: ID.emptyParentJob,
          result_id: null,
          result_attempt_id: null,
          aoa: null,
          generation_key: `legacy-job:${ID.emptyParentJob}`,
          state: "delivered",
        }),
      ]),
    );
    expect(
      rows.filter(
        (row) => row.sim_job_id === ID.deliveryJob && row.result_id === null,
      ),
    ).toEqual([]);
    expect(
      rows.filter(
        (row) => row.sim_job_id === ID.emptyParentJob && row.result_id === null,
      ),
    ).toHaveLength(1);
  });

  it("leaves an active upstream promise with two unowned points untouched and creates no phantom delivery", async () => {
    const [promise] = (await client!.unsafe(`
      SELECT status, aoa_count, "fulfilledAt" AS fulfilled_at
      FROM sync_sweep_promises
      WHERE id = '${ID.activeNoWorkPromise}'
    `)) as unknown as Array<{
      status: string;
      aoa_count: number;
      fulfilled_at: Date | null;
    }>;
    expect(promise).toEqual({
      status: "active",
      aoa_count: 2,
      fulfilled_at: null,
    });
    const points = (await client!.unsafe(`
      SELECT status, result_id, result_attempt_id
      FROM sync_sweep_promise_points
      WHERE promise_id = '${ID.activeNoWorkPromise}'
      ORDER BY aoa_deg
    `)) as unknown as Array<{
      status: string;
      result_id: string | null;
      result_attempt_id: string | null;
    }>;
    expect(points).toEqual([
      { status: "active", result_id: null, result_attempt_id: null },
      { status: "active", result_id: null, result_attempt_id: null },
    ]);
    const deliveries = await client!.unsafe(`
      SELECT id FROM sync_remote_result_deliveries
      WHERE promise_id = '${ID.activeNoWorkPromise}'
    `);
    expect(deliveries).toEqual([]);
  });

  it("binds a fulfilled point only to one exact accepted attempt and leaves accepted ambiguity unbound", async () => {
    const candidates = (await client!.unsafe(`
      SELECT attempt.result_id, attempt.id, attempt.sim_job_id,
             classification.state
      FROM result_attempts attempt
      JOIN result_classifications classification
        ON classification.result_attempt_id = attempt.id
      WHERE attempt.result_id IN ('${ID.exactResult}', '${ID.ambiguousResult}')
      ORDER BY attempt.result_id, attempt.id
    `)) as unknown as Array<{
      result_id: string;
      id: string;
      sim_job_id: string | null;
      state: string;
    }>;
    expect(
      candidates.filter(
        (candidate) =>
          candidate.result_id === ID.exactResult &&
          candidate.state === "accepted",
      ),
    ).toHaveLength(1);
    expect(
      candidates.filter(
        (candidate) =>
          candidate.result_id === ID.ambiguousResult &&
          candidate.state === "accepted",
      ),
    ).toHaveLength(2);

    const points = (await client!.unsafe(`
      SELECT id, result_id, result_attempt_id
      FROM sync_sweep_promise_points
      WHERE id IN ('${ID.exactPoint}', '${ID.ambiguousPoint}')
      ORDER BY id
    `)) as unknown as Array<{
      id: string;
      result_id: string;
      result_attempt_id: string | null;
    }>;
    expect(points).toEqual([
      {
        id: ID.exactPoint,
        result_id: ID.exactResult,
        result_attempt_id: ID.exactAcceptedAttempt,
      },
      {
        id: ID.ambiguousPoint,
        result_id: ID.ambiguousResult,
        result_attempt_id: null,
      },
    ]);
  });

  it("fingerprints identical pending conflicts with the runtime SQL identity and archives duplicates", async () => {
    const rows = (await client!.unsafe(`
      SELECT id, status, fingerprint, resolution_note, "resolvedAt"
      FROM sync_import_conflicts
      WHERE id IN (
        '${ID.conflictKeeper}', '${ID.conflictDuplicate}', '${ID.conflictResolved}'
      )
      ORDER BY id
    `)) as unknown as Array<{
      id: string;
      status: string;
      fingerprint: string;
      resolution_note: string | null;
      resolvedAt: string | null;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      id: ID.conflictKeeper,
      status: "pending",
    });
    expect(rows[1]).toMatchObject({
      id: ID.conflictDuplicate,
      status: "archived",
      resolution_note: `deduplicated by migration 0052; pending keeper ${ID.conflictKeeper}`,
    });
    expect(rows[1]?.resolvedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(rows[1]!.resolvedAt!))).toBe(false);
    expect(rows[2]).toMatchObject({
      id: ID.conflictResolved,
      status: "archived",
      resolution_note: null,
    });
    expect(rows[0]?.fingerprint).toBe(rows[1]?.fingerprint);
    expect(rows[0]?.fingerprint).toBe(rows[2]?.fingerprint);

    // This is deliberately the same SQL expression and field order used by
    // createConflict at runtime. It protects against a migration/runtime
    // identity split caused by JSONB key ordering or nullable manifests.
    const runtimeFingerprint = (await client!.unsafe(`
      SELECT encode(sha256(convert_to(jsonb_build_object(
        'sourceInstanceId', '${sourceInstanceId}'::text,
        'dataType', 'polars'::text,
        'naturalKey', 'foil/revision/6'::text,
        'incomingPayload', '{"z":3,"nested":{"b":2,"a":1},"arr":[2,1]}'::jsonb,
        'artifactManifest', '{"media":[{"sha256":"same","role":"history"}]}'::jsonb
      )::text, 'UTF8')), 'hex') AS fingerprint
    `)) as unknown as Array<{ fingerprint: string }>;
    expect(rows[0]?.fingerprint).toBe(runtimeFingerprint[0]?.fingerprint);
    expect(rows[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const pending = (await client!.unsafe(`
      SELECT id FROM sync_import_conflicts
      WHERE status = 'pending' AND fingerprint = '${rows[0]?.fingerprint}'
    `)) as unknown as Array<{ id: string }>;
    expect(pending).toEqual([{ id: ID.conflictKeeper }]);
  });

  it("keeps result-attempt foreign-key delete actions aligned with their ownership semantics", async () => {
    const constraints = (await client!.unsafe(`
      SELECT owner.relname AS owner_table, constraint_row.confdeltype
      FROM pg_constraint constraint_row
      JOIN pg_class owner ON owner.oid = constraint_row.conrelid
      JOIN LATERAL unnest(constraint_row.conkey) AS key(attnum) ON true
      JOIN pg_attribute attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = key.attnum
      JOIN pg_class target ON target.oid = constraint_row.confrelid
      WHERE constraint_row.contype = 'f'
        AND attribute.attname = 'result_attempt_id'
        AND target.relname = 'result_attempts'
        AND owner.relname IN (
          'solver_evidence_artifacts',
          'sync_sweep_promise_points',
          'sync_remote_result_deliveries'
        )
      ORDER BY owner.relname
    `)) as unknown as Array<{
      owner_table: string;
      confdeltype: string;
    }>;
    expect(constraints).toEqual([
      {
        owner_table: "solver_evidence_artifacts",
        confdeltype: "c",
      },
      {
        owner_table: "solver_evidence_artifacts",
        confdeltype: "c",
      },
      {
        owner_table: "sync_remote_result_deliveries",
        confdeltype: "c",
      },
      {
        owner_table: "sync_remote_result_deliveries",
        confdeltype: "c",
      },
      {
        owner_table: "sync_sweep_promise_points",
        confdeltype: "n",
      },
      {
        owner_table: "sync_sweep_promise_points",
        confdeltype: "a",
      },
    ]);

    await client!.unsafe(`
      DELETE FROM result_attempts WHERE id = '${ID.deliveryAttempt}'
    `);
    const deliveryRows = (await client!.unsafe(`
      SELECT id FROM sync_remote_result_deliveries
      WHERE result_attempt_id = '${ID.deliveryAttempt}'
         OR result_id = '${ID.deliveryResult}'
    `)) as unknown as Array<{ id: string }>;
    expect(deliveryRows).toEqual([]);
    const resultRows = (await client!.unsafe(`
      SELECT id FROM results WHERE id = '${ID.deliveryResult}'
    `)) as unknown as Array<{ id: string }>;
    expect(resultRows).toEqual([{ id: ID.deliveryResult }]);

    await client!.unsafe(`
      DELETE FROM result_attempts WHERE id = '${ID.exactAcceptedAttempt}'
    `);
    const [promisePoint] = (await client!.unsafe(`
      SELECT result_id, result_attempt_id
      FROM sync_sweep_promise_points
      WHERE id = '${ID.exactPoint}'
    `)) as unknown as Array<{
      result_id: string | null;
      result_attempt_id: string | null;
    }>;
    expect(promisePoint).toEqual({
      result_id: ID.exactResult,
      result_attempt_id: null,
    });
  });
});
