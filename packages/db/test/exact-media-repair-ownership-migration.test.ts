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
const dbName = `aerodb_exact0056_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let baselineDir = "";

function id(value: number): string {
  return `56000000-0000-0000-0000-${value.toString(16).padStart(12, "0")}`;
}

const ID = {
  category: id(1),
  airfoil: id(2),
  medium: id(3),
  flow: id(4),
  geometry: id(5),
  boundary: id(6),
  mesh: id(7),
  solver: id(8),
  scheduling: id(9),
  output: id(10),
  sweep: id(11),
  bc: id(12),
  preset: id(13),
  revision: id(14),
  rejectedResult: id(101),
  acceptedResult: id(102),
  ambiguousResult: id(103),
  rejectedAttempt: id(201),
  acceptedAttempt: id(202),
  ambiguousAttempt: id(203),
  repairRejected: id(301),
  repairAmbiguous: id(302),
  verifyExact: id(401),
  verifyAmbiguous: id(402),
  jobExact: id(501),
  jobAmbiguousA: id(502),
  jobAmbiguousB: id(503),
} as const;

function makeMigrationFolder(upTo: number): string {
  const dir = mkdtempSync(join(tmpdir(), `aerodb-migrations-00${upTo}-`));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= upTo);
  for (const entry of entries) {
    cpSync(join(migrations, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return dir;
}

const fixtureSql = `
INSERT INTO categories (id, slug, name, path)
VALUES ('${ID.category}', 'exact-0056', 'exact 0056', 'exact-0056');
INSERT INTO airfoils (id, slug, name, category_id, points)
VALUES ('${ID.airfoil}', 'exact-0056-foil', 'exact 0056 foil', '${ID.category}',
        '[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]'::jsonb);
INSERT INTO mediums
  (id, slug, name, phase, density, viscosity_model,
   constant_dynamic_viscosity, dynamic_viscosity, kinematic_viscosity, speed_of_sound)
VALUES ('${ID.medium}', 'exact-0056-air', 'exact 0056 air', 'gas', 1.225, 'constant',
        0.00001789, 0.00001789, 0.000014604, 340.3);
INSERT INTO flow_conditions
  (id, slug, name, medium_id, speed_mps, density, dynamic_viscosity, kinematic_viscosity)
VALUES ('${ID.flow}', 'exact-0056-flow', 'exact 0056 flow', '${ID.medium}', 20,
        1.225, 0.00001789, 0.000014604);
INSERT INTO reference_geometry_profiles (id, slug, name, reference_length_m)
VALUES ('${ID.geometry}', 'exact-0056-geo', 'exact 0056 geo', 1);
INSERT INTO boundary_profiles (id, slug, name)
VALUES ('${ID.boundary}', 'exact-0056-boundary', 'exact 0056 boundary');
INSERT INTO mesh_profiles (id, slug, name)
VALUES ('${ID.mesh}', 'exact-0056-mesh', 'exact 0056 mesh');
INSERT INTO solver_profiles (id, slug, name)
VALUES ('${ID.solver}', 'exact-0056-solver', 'exact 0056 solver');
INSERT INTO scheduling_profiles (id, slug, name)
VALUES ('${ID.scheduling}', 'exact-0056-scheduling', 'exact 0056 scheduling');
INSERT INTO output_profiles (id, slug, name)
VALUES ('${ID.output}', 'exact-0056-output', 'exact 0056 output');
INSERT INTO sweep_definitions (id, slug, name, aoa_list)
VALUES ('${ID.sweep}', 'exact-0056-sweep', 'exact 0056 sweep', '[0,1,2]'::jsonb);
INSERT INTO boundary_conditions
  (id, slug, name, medium_id, reynolds, reference_chord_m, speed_mps,
   density, dynamic_viscosity, kinematic_viscosity)
VALUES ('${ID.bc}', 'exact-0056-bc', 'exact 0056 bc', '${ID.medium}', 1369491,
        1, 20, 1.225, 0.00001789, 0.000014604);
INSERT INTO simulation_presets
  (id, slug, name, flow_condition_id, reference_geometry_profile_id,
   boundary_profile_id, mesh_profile_id, solver_profile_id,
   scheduling_profile_id, output_profile_id, sweep_definition_id,
   legacy_boundary_condition_id)
VALUES ('${ID.preset}', 'exact-0056-preset', 'exact 0056 preset', '${ID.flow}',
        '${ID.geometry}', '${ID.boundary}', '${ID.mesh}', '${ID.solver}',
        '${ID.scheduling}', '${ID.output}', '${ID.sweep}', '${ID.bc}');
INSERT INTO simulation_preset_revisions
  (id, preset_id, revision_number, signature_hash, reynolds,
   reference_length_m, snapshot)
VALUES ('${ID.revision}', '${ID.preset}', 1, 'exact-0056-signature', 1369491, 1,
        '{}'::jsonb);

INSERT INTO results
  (id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg, status,
   source, regime, fidelity, cl, cd, cm, converged, unsteady, engine_job_id,
   engine_case_slug, "solvedAt")
VALUES
  ('${ID.rejectedResult}','${ID.airfoil}','${ID.bc}','${ID.revision}',0,'done',
   'solved','urans','urans_precalc',0.4,0.02,-0.02,true,true,'repair-engine','a0',now()),
  ('${ID.acceptedResult}','${ID.airfoil}','${ID.bc}','${ID.revision}',1,'done',
   'solved','rans','rans',0.5,0.02,-0.02,true,false,'accepted-engine','a1',now()),
  ('${ID.ambiguousResult}','${ID.airfoil}','${ID.bc}','${ID.revision}',2,'done',
   'solved','urans','urans_precalc',0.6,0.03,-0.02,true,true,'ambiguous-engine','a2',now());
INSERT INTO result_attempts
  (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg,
   engine_job_id, engine_case_slug, status, source, regime, converged, unsteady,
   evidence_payload, "solvedAt")
VALUES
  ('${ID.rejectedAttempt}','${ID.rejectedResult}','${ID.airfoil}','${ID.bc}',
   '${ID.revision}',0,'repair-engine','a0','done','solved','urans',true,true,
   '{"fidelity":"urans_precalc"}'::jsonb,now()),
  ('${ID.acceptedAttempt}','${ID.acceptedResult}','${ID.airfoil}','${ID.bc}',
   '${ID.revision}',1,'accepted-engine','a1','done','solved','rans',true,false,
   '{"fidelity":"rans"}'::jsonb,now()),
  ('${ID.ambiguousAttempt}','${ID.ambiguousResult}','${ID.airfoil}','${ID.bc}',
   '${ID.revision}',2,'ambiguous-engine','a2','done','solved','urans',true,true,
   '{"fidelity":"urans_precalc"}'::jsonb,now());
UPDATE results SET current_result_attempt_id = '${ID.rejectedAttempt}'
WHERE id = '${ID.rejectedResult}';
UPDATE results SET current_result_attempt_id = '${ID.acceptedAttempt}'
WHERE id = '${ID.acceptedResult}';

INSERT INTO result_classifications
  (result_attempt_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
   regime, classifier_version, state, reasons)
VALUES
  ('${ID.rejectedAttempt}','${ID.airfoil}','${ID.revision}',0,'urans',
   'exact-0056-v1','rejected',ARRAY['missing-urans-video']),
  ('${ID.acceptedAttempt}','${ID.airfoil}','${ID.revision}',1,'rans',
   'exact-0056-v1','accepted',ARRAY[]::text[]);

INSERT INTO solver_evidence_artifacts
  (result_id, result_attempt_id, airfoil_id, engine_job_id, engine_case_slug,
   aoa_deg, kind, storage_key, mime_type, sha256, byte_size)
VALUES
  ('${ID.rejectedResult}','${ID.rejectedAttempt}','${ID.airfoil}',
   'repair-engine','a0',0,'manifest','repair/manifest.json','application/json',
   '${"1".repeat(64)}',128),
  ('${ID.acceptedResult}','${ID.acceptedAttempt}','${ID.airfoil}',
   'accepted-engine','a1',1,'manifest','accepted/manifest.json','application/json',
   '${"2".repeat(64)}',128),
  ('${ID.ambiguousResult}','${ID.ambiguousAttempt}','${ID.airfoil}',
   'ambiguous-engine','a2',2,'manifest','ambiguous/manifest-a.json','application/json',
   '${"3".repeat(64)}',128),
  ('${ID.ambiguousResult}','${ID.ambiguousAttempt}','${ID.airfoil}',
   'ambiguous-engine','a2',2,'manifest','ambiguous/manifest-b.json','application/json',
   '${"4".repeat(64)}',128);

INSERT INTO result_media_repairs
  (id, result_id, state, evidence_signature, background_owner, attempt_count,
   max_attempts, next_attempt_at)
VALUES
  ('${ID.repairRejected}','${ID.rejectedResult}','pending',
   'repair-engine:a0:${"1".repeat(64)}',false,0,3,now()),
  ('${ID.repairAmbiguous}','${ID.ambiguousResult}','pending',
   'ambiguous-engine:a2:${"3".repeat(64)}',false,0,3,now());

INSERT INTO polar_fit_sets
  (airfoil_id, simulation_preset_revision_id, fit_version, evidence_signature,
   status, is_current)
VALUES ('${ID.airfoil}','${ID.revision}','stale-v1','stale-revision','provisional',true);
INSERT INTO polar_compatibility_fit_sets
  (airfoil_id, compatibility_version, compatibility_hash, fit_version,
   evidence_signature, status, is_current)
VALUES ('${ID.airfoil}','stale-compat-v1','stale-hash','stale-fit-v1',
        'stale-compatible','provisional',true);

INSERT INTO sim_urans_verify_queue
  (id, airfoil_id, revision_id, aoa_deg, background_owner, state,
   precalc_result_id)
VALUES
  ('${ID.verifyExact}','${ID.airfoil}','${ID.revision}',1,true,'running',
   '${ID.acceptedResult}'),
  ('${ID.verifyAmbiguous}','${ID.airfoil}','${ID.revision}',2,true,'running',
   '${ID.ambiguousResult}');
INSERT INTO sim_jobs
  (id, engine_job_id, airfoil_id, bc_ids, simulation_preset_revision_id,
   job_kind, reference_chord_m, wave, status, total_cases, request_payload)
VALUES
  ('${ID.jobExact}','verify-exact','${ID.airfoil}','["${ID.bc}"]',
   '${ID.revision}','verify',1,2,'running',1,
   '{"verifyQueueItemId":"${ID.verifyExact}"}'::jsonb),
  ('${ID.jobAmbiguousA}','verify-ambiguous-a','${ID.airfoil}','["${ID.bc}"]',
   '${ID.revision}','verify',1,2,'submitted',1,
   '{"verifyQueueItemId":"${ID.verifyAmbiguous}"}'::jsonb),
  ('${ID.jobAmbiguousB}','verify-ambiguous-b','${ID.airfoil}','["${ID.bc}"]',
   '${ID.revision}','verify',1,2,'running',1,
   '{"verifyQueueItemId":"${ID.verifyAmbiguous}"}'::jsonb);
`;

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  client = postgres(targetUrl.toString(), { max: 1 });
  baselineDir = makeMigrationFolder(55);
  await migrate(drizzle(client), { migrationsFolder: baselineDir });
  await client.unsafe(fixtureSql);
  await migrate(drizzle(client), { migrationsFolder: migrations });
}, 180_000);

afterAll(async () => {
  if (client) await client.end();
  if (admin) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  }
  if (baselineDir) rmSync(baselineDir, { recursive: true, force: true });
});

describe("0056 exact repair and verification ownership", () => {
  it("captures the exact repair attempt, clears only the rejected pointer, and retires stale fit caches", async () => {
    const repairs = await client!.unsafe<
      Array<{ id: string; result_attempt_id: string }>
    >(`SELECT id, result_attempt_id FROM result_media_repairs ORDER BY id`);
    expect(repairs).toEqual([
      { id: ID.repairRejected, result_attempt_id: ID.rejectedAttempt },
    ]);

    const pointers = await client!.unsafe<
      Array<{ id: string; current_result_attempt_id: string | null }>
    >(`
      SELECT id, current_result_attempt_id
      FROM results
      WHERE id IN ('${ID.rejectedResult}', '${ID.acceptedResult}')
      ORDER BY id
    `);
    expect(pointers).toEqual([
      { id: ID.rejectedResult, current_result_attempt_id: null },
      {
        id: ID.acceptedResult,
        current_result_attempt_id: ID.acceptedAttempt,
      },
    ]);

    const [cacheState] = await client!.unsafe<
      Array<{ revision_current: number; compatibility_current: number }>
    >(`
      SELECT
        (SELECT count(*)::int FROM polar_fit_sets WHERE is_current) AS revision_current,
        (SELECT count(*)::int FROM polar_compatibility_fit_sets WHERE is_current) AS compatibility_current
    `);
    expect(cacheState).toEqual({
      revision_current: 0,
      compatibility_current: 0,
    });
  });

  it("backfills only one unambiguous running verification owner", async () => {
    const rows = await client!.unsafe<
      Array<{ id: string; sim_job_id: string | null }>
    >(`
      SELECT id, sim_job_id
      FROM sim_urans_verify_queue
      WHERE id IN ('${ID.verifyExact}', '${ID.verifyAmbiguous}')
      ORDER BY id
    `);
    expect(rows).toEqual([
      { id: ID.verifyExact, sim_job_id: ID.jobExact },
      { id: ID.verifyAmbiguous, sim_job_id: null },
    ]);
  });

  it("rejects a repair row whose attempt belongs to another result", async () => {
    await expect(
      client!.unsafe(`
        INSERT INTO result_media_repairs
          (result_id, result_attempt_id, state, evidence_signature,
           background_owner, attempt_count, max_attempts, next_attempt_at)
        VALUES ('${ID.acceptedResult}', '${ID.rejectedAttempt}', 'pending',
                'cross-result', false, 0, 3, now())
      `),
    ).rejects.toThrow(/result_media_repairs_attempt_owner_fk/);
  });
});
