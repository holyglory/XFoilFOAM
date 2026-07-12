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
let through56Dir = "";

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
  otherRevision: id(15),
  otherAirfoil: id(16),
  projectionRevision: id(17),
  projectionAirfoil: id(18),
  rejectedResult: id(101),
  acceptedResult: id(102),
  ambiguousResult: id(103),
  post56DriftResult: id(104),
  missingForceResult: id(105),
  projectionAcceptedResult: id(106),
  projectionNeedsResult: id(107),
  projectionSupersededResult: id(108),
  projectionRejectedResult: id(109),
  projectionBothResult: id(110),
  rejectedAttempt: id(201),
  acceptedAttempt: id(202),
  ambiguousAttempt: id(203),
  post56DriftAttempt: id(204),
  missingForceAttempt: id(205),
  projectionBothAttempt: id(206),
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
INSERT INTO airfoils (id, slug, name, category_id, points)
VALUES ('${ID.otherAirfoil}', 'exact-0057-unrelated', 'exact 0057 unrelated', '${ID.category}',
        '[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]'::jsonb);
INSERT INTO airfoils (id, slug, name, category_id, points)
VALUES ('${ID.projectionAirfoil}', 'exact-0057-pointerless', 'exact 0057 pointerless', '${ID.category}',
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
   reference_length_m, snapshot, physics_hash)
VALUES
  ('${ID.revision}', '${ID.preset}', 1, 'exact-0056-signature', 1369491, 1,
   '{}'::jsonb, 'stale-hash'),
  ('${ID.otherRevision}', '${ID.preset}', 2, 'exact-0057-unrelated-signature',
   1369491, 1, '{}'::jsonb, 'unrelated-hash'),
  ('${ID.projectionRevision}', '${ID.preset}', 3, 'exact-0057-pointerless-signature',
   1369491, 1, '{}'::jsonb, 'pointerless-hash');

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
   'solved','urans','urans_precalc',0.6,0.03,-0.02,true,true,'ambiguous-engine','a2',now()),
  ('${ID.post56DriftResult}','${ID.airfoil}','${ID.bc}','${ID.revision}',3,'done',
   'solved','urans','urans_precalc',0.7,0.035,-0.02,true,true,'post56-engine','a3',now()),
  ('${ID.missingForceResult}','${ID.airfoil}','${ID.bc}','${ID.revision}',4,'done',
   'solved','urans','urans_precalc',0.8,0.04,-0.02,true,true,'missing-force-engine','a4',now()),
  ('${ID.projectionAcceptedResult}','${ID.projectionAirfoil}','${ID.bc}','${ID.projectionRevision}',10,'done',
   'solved','rans','rans',0.9,0.04,-0.02,true,false,'pointerless-accepted','a10',now()),
  ('${ID.projectionNeedsResult}','${ID.projectionAirfoil}','${ID.bc}','${ID.projectionRevision}',11,'done',
   'solved','rans','rans',0.9,0.04,-0.02,true,false,'pointerless-needs','a11',now()),
  ('${ID.projectionSupersededResult}','${ID.projectionAirfoil}','${ID.bc}','${ID.projectionRevision}',12,'done',
   'solved','rans','rans',0.9,0.04,-0.02,true,false,'pointerless-superseded','a12',now()),
  ('${ID.projectionRejectedResult}','${ID.projectionAirfoil}','${ID.bc}','${ID.projectionRevision}',13,'done',
   'solved','rans','rans',0.9,0.04,-0.02,true,false,'pointerless-rejected','a13',now()),
  ('${ID.projectionBothResult}','${ID.projectionAirfoil}','${ID.bc}','${ID.projectionRevision}',14,'done',
   'solved','rans','rans',0.9,0.04,-0.02,true,false,'pointerless-both','a14',now());
INSERT INTO result_attempts
  (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg,
   engine_job_id, engine_case_slug, status, source, regime, converged, unsteady,
   evidence_payload, "solvedAt")
VALUES
  ('${ID.rejectedAttempt}','${ID.rejectedResult}','${ID.airfoil}','${ID.bc}',
   '${ID.revision}',0,'repair-engine','a0','done','solved','urans',true,true,
   '{"fidelity":"urans_precalc","force_history":{"t":[0,1],"cl":[0.3,0.4],"cd":[0.02,0.02]}}'::jsonb,now()),
  ('${ID.acceptedAttempt}','${ID.acceptedResult}','${ID.airfoil}','${ID.bc}',
   '${ID.revision}',1,'accepted-engine','a1','done','solved','rans',true,false,
   '{"fidelity":"rans"}'::jsonb,now()),
  ('${ID.ambiguousAttempt}','${ID.ambiguousResult}','${ID.airfoil}','${ID.bc}',
   '${ID.revision}',2,'ambiguous-engine','a2','done','solved','urans',true,true,
   '{"fidelity":"urans_precalc"}'::jsonb,now()),
  ('${ID.post56DriftAttempt}','${ID.post56DriftResult}','${ID.airfoil}','${ID.bc}',
   '${ID.revision}',3,'post56-engine','a3','done','solved','urans',true,true,
   '{"fidelity":"urans_precalc","force_history":{"t":[0,1],"cl":[0.6,0.7],"cd":[0.03,0.035]}}'::jsonb,now()),
  ('${ID.missingForceAttempt}','${ID.missingForceResult}','${ID.airfoil}','${ID.bc}',
   '${ID.revision}',4,'missing-force-engine','a4','done','solved','urans',true,true,
   '{"fidelity":"urans_precalc"}'::jsonb,now()),
  ('${ID.projectionBothAttempt}','${ID.projectionBothResult}','${ID.projectionAirfoil}','${ID.bc}',
   '${ID.projectionRevision}',14,'pointerless-both','a14','done','solved','rans',true,false,
   '{"fidelity":"rans"}'::jsonb,now());
UPDATE results SET current_result_attempt_id = '${ID.rejectedAttempt}'
WHERE id = '${ID.rejectedResult}';
UPDATE results SET current_result_attempt_id = '${ID.acceptedAttempt}'
WHERE id = '${ID.acceptedResult}';
UPDATE results SET current_result_attempt_id = '${ID.post56DriftAttempt}'
WHERE id = '${ID.post56DriftResult}';
UPDATE results SET current_result_attempt_id = '${ID.missingForceAttempt}'
WHERE id = '${ID.missingForceResult}';

INSERT INTO result_classifications
  (result_attempt_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
   regime, classifier_version, state, reasons)
VALUES
  ('${ID.rejectedAttempt}','${ID.airfoil}','${ID.revision}',0,'urans',
   'exact-0056-v1','rejected',ARRAY['missing-urans-video']),
  ('${ID.acceptedAttempt}','${ID.airfoil}','${ID.revision}',1,'rans',
   'exact-0056-v1','accepted',ARRAY[]::text[]),
  ('${ID.post56DriftAttempt}','${ID.airfoil}','${ID.revision}',3,'urans',
   'exact-0056-v1','accepted',ARRAY[]::text[]),
  ('${ID.missingForceAttempt}','${ID.airfoil}','${ID.revision}',4,'urans',
   'exact-0056-v1','accepted',ARRAY[]::text[]);
INSERT INTO result_classifications
  (result_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
   regime, classifier_version, state, reasons)
VALUES
  ('${ID.acceptedResult}','${ID.airfoil}','${ID.revision}',1,'rans',
   'exact-0056-result-v1','accepted',ARRAY[]::text[]),
  ('${ID.ambiguousResult}','${ID.airfoil}','${ID.revision}',2,'urans',
   'exact-0056-result-v1','accepted',ARRAY[]::text[]),
  ('${ID.post56DriftResult}','${ID.airfoil}','${ID.revision}',3,'urans',
   'exact-0056-result-v1','accepted',ARRAY[]::text[]),
  ('${ID.missingForceResult}','${ID.airfoil}','${ID.revision}',4,'urans',
   'exact-0056-result-v1','accepted',ARRAY[]::text[]),
  ('${ID.projectionAcceptedResult}','${ID.projectionAirfoil}','${ID.projectionRevision}',10,'rans',
   'legacy-pointerless-v1','accepted',ARRAY[]::text[]),
  ('${ID.projectionNeedsResult}','${ID.projectionAirfoil}','${ID.projectionRevision}',11,'rans',
   'legacy-pointerless-v1','needs_urans',ARRAY['post-stall-shape']::text[]),
  ('${ID.projectionSupersededResult}','${ID.projectionAirfoil}','${ID.projectionRevision}',12,'rans',
   'legacy-pointerless-v1','superseded_by_urans',ARRAY['urans-replacement']::text[]),
  ('${ID.projectionRejectedResult}','${ID.projectionAirfoil}','${ID.projectionRevision}',13,'rans',
   'legacy-pointerless-v1','rejected',ARRAY['not-converged']::text[]);
INSERT INTO result_classifications
  (result_id, result_attempt_id, airfoil_id, simulation_preset_revision_id,
   aoa_deg, regime, classifier_version, state, reasons)
VALUES
  ('${ID.projectionBothResult}','${ID.projectionBothAttempt}',
   '${ID.projectionAirfoil}','${ID.projectionRevision}',14,'rans',
   'legacy-pointerless-both-v1','needs_urans',ARRAY['post-stall-shape']::text[]);

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
   '${"4".repeat(64)}',128),
  ('${ID.post56DriftResult}','${ID.post56DriftAttempt}','${ID.airfoil}',
   'post56-engine','a3',3,'manifest','post56/manifest.json','application/json',
   '${"5".repeat(64)}',128),
  ('${ID.missingForceResult}','${ID.missingForceAttempt}','${ID.airfoil}',
   'missing-force-engine','a4',4,'manifest','missing-force/manifest.json','application/json',
   '${"6".repeat(64)}',128);

-- Isolate the exact force-history gate: this selected URANS attempt has a
-- valid exact video and must still be withdrawn solely for missing force.
INSERT INTO result_media
  (result_id, result_attempt_id, kind, field, role, storage_key, mime_type,
   render_profile_key, evidence_sha256, sha256, byte_size)
VALUES
  ('${ID.missingForceResult}','${ID.missingForceAttempt}','video',
   'velocity_magnitude','instantaneous','missing-force/video.mp4','video/mp4',
   'default:v1:zoom2','${"6".repeat(64)}','${"7".repeat(64)}',128);

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
VALUES
  ('${ID.airfoil}','${ID.revision}','stale-v1','stale-revision','provisional',true),
  ('${ID.projectionAirfoil}','${ID.projectionRevision}','pointerless-v1','pointerless-revision','provisional',true),
  ('${ID.otherAirfoil}','${ID.otherRevision}','unrelated-v1','unrelated-revision','final',true);
INSERT INTO polar_compatibility_fit_sets
  (airfoil_id, compatibility_version, compatibility_hash, fit_version,
   evidence_signature, status, is_current)
VALUES
  ('${ID.airfoil}','stale-compat-v1','stale-hash','stale-fit-v1',
   'stale-compatible','provisional',true),
  ('${ID.projectionAirfoil}','pointerless-compat-v1','pointerless-hash','pointerless-fit-v1',
   'pointerless-compatible','provisional',true),
  ('${ID.otherAirfoil}','unrelated-compat-v1','unrelated-hash','unrelated-fit-v1',
   'unrelated-compatible','final',true);

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
  through56Dir = makeMigrationFolder(56);
  await migrate(drizzle(client), { migrationsFolder: baselineDir });
  await client.unsafe(fixtureSql);
  await migrate(drizzle(client), { migrationsFolder: through56Dir });
  const [post56] = await client.unsafe<
    Array<{
      current_result_attempt_id: string | null;
      state: string;
      repair_count: number;
    }>
  >(`
    SELECT result.current_result_attempt_id,
           classification.state::text,
           (SELECT count(*)::int FROM result_media_repairs repair
            WHERE repair.result_id = result.id) AS repair_count
    FROM results result
    JOIN result_classifications classification
      ON classification.result_attempt_id = result.current_result_attempt_id
    WHERE result.id = '${ID.post56DriftResult}'
  `);
  expect(post56).toEqual({
    current_result_attempt_id: ID.post56DriftAttempt,
    state: "accepted",
    repair_count: 0,
  });
  const [stalePointerlessProjection] = await client.unsafe<
    Array<{ state: string; current_result_attempt_id: string | null }>
  >(`
    SELECT classification.state::text, result.current_result_attempt_id
    FROM result_classifications classification
    JOIN results result ON result.id = classification.result_id
    WHERE classification.result_id = '${ID.ambiguousResult}'
      AND classification.result_attempt_id IS NULL
  `);
  expect(stalePointerlessProjection).toEqual({
    state: "accepted",
    current_result_attempt_id: null,
  });
  const pointerlessProjectionStates = await client.unsafe<
    Array<{ state: string }>
  >(`
    SELECT classification.state::text
    FROM result_classifications classification
    JOIN results result ON result.id = classification.result_id
    WHERE result.airfoil_id = '${ID.projectionAirfoil}'
      AND result.current_result_attempt_id IS NULL
      AND classification.result_attempt_id IS NULL
    ORDER BY classification.state::text
  `);
  expect(pointerlessProjectionStates).toEqual([
    { state: "accepted" },
    { state: "needs_urans" },
    { state: "rejected" },
    { state: "superseded_by_urans" },
  ]);
  const [pointerlessBothOwner] = await client.unsafe<
    Array<{
      result_id: string;
      result_attempt_id: string;
      state: string;
      current_result_attempt_id: string | null;
    }>
  >(`
    SELECT classification.result_id, classification.result_attempt_id,
           classification.state::text, result.current_result_attempt_id
    FROM result_classifications classification
    JOIN results result ON result.id = classification.result_id
    WHERE classification.result_attempt_id = '${ID.projectionBothAttempt}'
  `);
  expect(pointerlessBothOwner).toEqual({
    result_id: ID.projectionBothResult,
    result_attempt_id: ID.projectionBothAttempt,
    state: "needs_urans",
    current_result_attempt_id: null,
  });
  // Simulate normal cache publication after 0056 but before the later physical
  // media drift is detected. Migration 0057 must retire both read models.
  await client.unsafe(`
    UPDATE polar_fit_sets SET is_current = true;
    UPDATE polar_compatibility_fit_sets SET is_current = true;
  `);
  await migrate(drizzle(client), { migrationsFolder: migrations });
}, 180_000);

afterAll(async () => {
  if (client) await client.end();
  if (admin) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  }
  if (baselineDir) rmSync(baselineDir, { recursive: true, force: true });
  if (through56Dir) rmSync(through56Dir, { recursive: true, force: true });
});

describe("0056-0057 exact repair, verification, and selected-generation cleanup", () => {
  it("captures exact repair attempts, withdraws post-0056 physical media drift, and retires stale fit caches", async () => {
    const repairs = await client!.unsafe<
      Array<{
        result_id: string;
        result_attempt_id: string;
        evidence_signature: string;
      }>
    >(`
      SELECT result_id, result_attempt_id, evidence_signature
      FROM result_media_repairs
      ORDER BY result_id
    `);
    expect(repairs).toEqual([
      {
        result_id: ID.rejectedResult,
        result_attempt_id: ID.rejectedAttempt,
        evidence_signature: `repair-engine:a0:${"1".repeat(64)}`,
      },
      {
        result_id: ID.post56DriftResult,
        result_attempt_id: ID.post56DriftAttempt,
        evidence_signature: `post56-engine:a3:${"5".repeat(64)}`,
      },
    ]);

    const pointers = await client!.unsafe<
      Array<{ id: string; current_result_attempt_id: string | null }>
    >(`
      SELECT id, current_result_attempt_id
      FROM results
      WHERE id IN (
        '${ID.rejectedResult}', '${ID.acceptedResult}',
        '${ID.post56DriftResult}', '${ID.missingForceResult}'
      )
      ORDER BY id
    `);
    expect(pointers).toEqual([
      { id: ID.rejectedResult, current_result_attempt_id: null },
      {
        id: ID.acceptedResult,
        current_result_attempt_id: ID.acceptedAttempt,
      },
      { id: ID.post56DriftResult, current_result_attempt_id: null },
      { id: ID.missingForceResult, current_result_attempt_id: null },
    ]);

    const [post56Classification] = await client!.unsafe<
      Array<{ state: string; reasons: string[]; classifier_version: string }>
    >(`
      SELECT state::text, reasons, classifier_version
      FROM result_classifications
      WHERE result_attempt_id = '${ID.post56DriftAttempt}'
    `);
    expect(post56Classification).toEqual({
      state: "rejected",
      reasons: ["missing-urans-video"],
      classifier_version: "0057-exact-video-gate-v1",
    });
    const [missingForceClassification] = await client!.unsafe<
      Array<{ state: string; reasons: string[]; classifier_version: string }>
    >(`
      SELECT state::text, reasons, classifier_version
      FROM result_classifications
      WHERE result_attempt_id = '${ID.missingForceAttempt}'
    `);
    expect(missingForceClassification).toEqual({
      state: "rejected",
      reasons: ["missing-force-history"],
      classifier_version: "0057-exact-force-gate-v1",
    });
    const resultLevelClassifications = await client!.unsafe<
      Array<{ result_id: string; state: string }>
    >(`
      SELECT result_id, state::text
      FROM result_classifications
      WHERE result_attempt_id IS NULL
        AND result_id IN (
          '${ID.acceptedResult}', '${ID.ambiguousResult}',
          '${ID.post56DriftResult}', '${ID.missingForceResult}',
          '${ID.projectionAcceptedResult}', '${ID.projectionNeedsResult}',
          '${ID.projectionSupersededResult}', '${ID.projectionRejectedResult}',
          '${ID.projectionBothResult}'
        )
      ORDER BY result_id
    `);
    expect(resultLevelClassifications).toEqual([
      { result_id: ID.acceptedResult, state: "accepted" },
      { result_id: ID.projectionRejectedResult, state: "rejected" },
    ]);
    const [detachedBothOwner] = await client!.unsafe<
      Array<{
        result_id: string | null;
        result_attempt_id: string;
        state: string;
      }>
    >(`
      SELECT result_id, result_attempt_id, state::text
      FROM result_classifications
      WHERE result_attempt_id = '${ID.projectionBothAttempt}'
    `);
    expect(detachedBothOwner).toEqual({
      result_id: null,
      result_attempt_id: ID.projectionBothAttempt,
      state: "needs_urans",
    });

    const [cacheState] = await client!.unsafe<
      Array<{
        revision_current: number;
        compatibility_current: number;
        pointerless_revision_current: number;
        pointerless_compatibility_current: number;
        unrelated_revision_current: number;
        unrelated_compatibility_current: number;
      }>
    >(`
      SELECT
        (SELECT count(*)::int FROM polar_fit_sets
         WHERE airfoil_id = '${ID.airfoil}'
           AND simulation_preset_revision_id = '${ID.revision}'
           AND is_current) AS revision_current,
        (SELECT count(*)::int FROM polar_compatibility_fit_sets
         WHERE airfoil_id = '${ID.airfoil}'
           AND compatibility_hash = 'stale-hash'
           AND is_current) AS compatibility_current,
        (SELECT count(*)::int FROM polar_fit_sets
         WHERE airfoil_id = '${ID.projectionAirfoil}'
           AND simulation_preset_revision_id = '${ID.projectionRevision}'
           AND is_current) AS pointerless_revision_current,
        (SELECT count(*)::int FROM polar_compatibility_fit_sets
         WHERE airfoil_id = '${ID.projectionAirfoil}'
           AND compatibility_hash = 'pointerless-hash'
           AND is_current) AS pointerless_compatibility_current,
        (SELECT count(*)::int FROM polar_fit_sets
         WHERE airfoil_id = '${ID.otherAirfoil}'
           AND simulation_preset_revision_id = '${ID.otherRevision}'
           AND is_current) AS unrelated_revision_current,
        (SELECT count(*)::int FROM polar_compatibility_fit_sets
         WHERE airfoil_id = '${ID.otherAirfoil}'
           AND compatibility_hash = 'unrelated-hash'
           AND is_current) AS unrelated_compatibility_current
    `);
    expect(cacheState).toEqual({
      revision_current: 0,
      compatibility_current: 0,
      pointerless_revision_current: 0,
      pointerless_compatibility_current: 0,
      unrelated_revision_current: 1,
      unrelated_compatibility_current: 1,
    });
  });

  it("is idempotent without resetting an existing repair budget or clearing an eligible pointer", async () => {
    await client!.unsafe(`
      UPDATE result_media_repairs
      SET state = 'retry_wait', attempt_count = 2,
          last_error = 'preserve bounded retry state'
      WHERE result_id = '${ID.post56DriftResult}'
    `);
    await client!.unsafe(
      readFileSync(
        join(migrations, "0057_reassert_exact_result_selection.sql"),
        "utf8",
      ),
    );
    const [repair] = await client!.unsafe<
      Array<{ state: string; attempt_count: number; last_error: string | null }>
    >(`
      SELECT state::text, attempt_count, last_error
      FROM result_media_repairs
      WHERE result_id = '${ID.post56DriftResult}'
    `);
    expect(repair).toEqual({
      state: "retry_wait",
      attempt_count: 2,
      last_error: "preserve bounded retry state",
    });
    const [eligible] = await client!.unsafe<
      Array<{ current_result_attempt_id: string | null }>
    >(`
      SELECT current_result_attempt_id
      FROM results
      WHERE id = '${ID.acceptedResult}'
    `);
    expect(eligible.current_result_attempt_id).toBe(ID.acceptedAttempt);
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
