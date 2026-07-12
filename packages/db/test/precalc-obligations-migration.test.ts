import {
  URANS_BUDGET_STOP_MARKER,
  URANS_CONTINUATION_REQUIRED_MARKER,
} from "@aerodb/core";
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
const dbName = `aerodb_precalc_upgrade_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let baselineDir = "";

const ID = {
  category: "10000000-0000-0000-0000-000000000001",
  airfoil: "10000000-0000-0000-0000-000000000002",
  medium: "10000000-0000-0000-0000-000000000003",
  flow: "10000000-0000-0000-0000-000000000004",
  releasedFlow: "10000000-0000-0000-0000-000000000015",
  geometry: "10000000-0000-0000-0000-000000000005",
  boundary: "10000000-0000-0000-0000-000000000006",
  mesh: "10000000-0000-0000-0000-000000000007",
  solver: "10000000-0000-0000-0000-000000000008",
  scheduling: "10000000-0000-0000-0000-000000000009",
  output: "10000000-0000-0000-0000-00000000000a",
  sweep: "10000000-0000-0000-0000-00000000000b",
  bc: "10000000-0000-0000-0000-00000000000c",
  preset: "10000000-0000-0000-0000-00000000000d",
  revision: "10000000-0000-0000-0000-00000000000e",
  campaign: "10000000-0000-0000-0000-000000000010",
  plan: "10000000-0000-0000-0000-000000000011",
  condition: "10000000-0000-0000-0000-000000000012",
  releasedCondition: "10000000-0000-0000-0000-000000000014",
  deletedCampaign: "10000000-0000-0000-0000-000000000013",
} as const;

function makeMigrationFolder(upTo: number): string {
  const dir = mkdtempSync(join(tmpdir(), `aerodb-migrations-00${upTo}-`));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= upTo);
  for (const entry of entries)
    cpSync(join(migrations, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return dir;
}

const fixtureSql = `
INSERT INTO categories (id, slug, name, path) VALUES
  ('${ID.category}', 'upgrade-fixture', 'upgrade fixture', 'upgrade-fixture');
INSERT INTO airfoils (id, slug, name, category_id, points, is_symmetric) VALUES
  ('${ID.airfoil}', 'upgrade-foil', 'upgrade foil', '${ID.category}',
   '[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]'::jsonb, false);
INSERT INTO mediums
  (id, slug, name, phase, density, viscosity_model,
   constant_dynamic_viscosity, dynamic_viscosity, kinematic_viscosity, speed_of_sound)
VALUES ('${ID.medium}', 'upgrade-air', 'upgrade air', 'gas', 1.225, 'constant',
        0.00001789, 0.00001789, 0.000014604, 340.3);
INSERT INTO flow_conditions
  (id, slug, name, medium_id, speed_mps, density, dynamic_viscosity, kinematic_viscosity)
VALUES ('${ID.flow}', 'upgrade-flow', 'upgrade flow', '${ID.medium}', 20, 1.225,
        0.00001789, 0.000014604),
       ('${ID.releasedFlow}', 'upgrade-released-flow', 'upgrade released flow', '${ID.medium}', 21, 1.225,
        0.00001789, 0.000014604);
INSERT INTO reference_geometry_profiles (id, slug, name, reference_length_m)
VALUES ('${ID.geometry}', 'upgrade-geo', 'upgrade geo', 1);
INSERT INTO boundary_profiles (id, slug, name) VALUES
  ('${ID.boundary}', 'upgrade-boundary', 'upgrade boundary');
INSERT INTO mesh_profiles (id, slug, name) VALUES
  ('${ID.mesh}', 'upgrade-mesh', 'upgrade mesh');
INSERT INTO solver_profiles (id, slug, name) VALUES
  ('${ID.solver}', 'upgrade-solver', 'upgrade solver');
INSERT INTO scheduling_profiles (id, slug, name) VALUES
  ('${ID.scheduling}', 'upgrade-scheduling', 'upgrade scheduling');
INSERT INTO output_profiles (id, slug, name) VALUES
  ('${ID.output}', 'upgrade-output', 'upgrade output');
INSERT INTO sweep_definitions (id, slug, name, aoa_list) VALUES
  ('${ID.sweep}', 'upgrade-sweep', 'upgrade sweep', '[0,1,2,3,4,5,6,7,8,9]'::jsonb);
INSERT INTO boundary_conditions
  (id, slug, name, medium_id, reynolds, reference_chord_m, speed_mps,
   density, dynamic_viscosity, kinematic_viscosity)
VALUES ('${ID.bc}', 'upgrade-bc', 'upgrade bc', '${ID.medium}', 1369491, 1, 20,
        1.225, 0.00001789, 0.000014604);
INSERT INTO simulation_presets
  (id, slug, name, flow_condition_id, reference_geometry_profile_id,
   boundary_profile_id, mesh_profile_id, solver_profile_id,
   scheduling_profile_id, output_profile_id, sweep_definition_id,
   legacy_boundary_condition_id)
VALUES ('${ID.preset}', 'upgrade-preset', 'upgrade preset', '${ID.flow}', '${ID.geometry}',
        '${ID.boundary}', '${ID.mesh}', '${ID.solver}', '${ID.scheduling}',
        '${ID.output}', '${ID.sweep}', '${ID.bc}');
INSERT INTO simulation_preset_revisions
  (id, preset_id, revision_number, signature_hash, reynolds,
   reference_length_m, snapshot)
VALUES ('${ID.revision}', '${ID.preset}', 1, 'upgrade-signature', 1369491, 1, '{}'::jsonb);

INSERT INTO sim_campaigns (id, slug, name, status, priority, idempotency_key) VALUES
  ('${ID.campaign}', 'upgrade-campaign', 'upgrade campaign', 'active', 5, 'upgrade-campaign-key'),
  ('${ID.deletedCampaign}', 'deleted-campaign', 'deleted campaign', 'active', 5, 'deleted-campaign-key');
INSERT INTO sim_campaign_plan_revisions
  (id, campaign_id, revision_number, kind, plan, summary)
VALUES ('${ID.plan}', '${ID.campaign}', 1, 'initial', '{}'::jsonb, '{}'::jsonb);
UPDATE sim_campaigns SET current_plan_revision_id = '${ID.plan}' WHERE id = '${ID.campaign}';
INSERT INTO sim_campaign_airfoils (campaign_id, airfoil_id)
VALUES ('${ID.campaign}', '${ID.airfoil}');
INSERT INTO sim_campaign_conditions
  (id, campaign_id, ord, flow_condition_id, reference_geometry_profile_id,
   preset_id, simulation_preset_revision_id, reynolds, status,
   introduced_in_plan_revision_id)
VALUES ('${ID.condition}', '${ID.campaign}', 0, '${ID.flow}', '${ID.geometry}',
        '${ID.preset}', '${ID.revision}', 1369491, 'active', '${ID.plan}'),
       ('${ID.releasedCondition}', '${ID.campaign}', 1, '${ID.releasedFlow}', '${ID.geometry}',
        '${ID.preset}', '${ID.revision}', 1369491, 'released', '${ID.plan}');

INSERT INTO sim_jobs
  (id, engine_job_id, parent_job_id, airfoil_id, bc_ids,
   simulation_preset_revision_id, campaign_id, job_kind, reference_chord_m,
   wave, status, total_cases, completed_cases, request_payload, "submittedAt", "finishedAt")
VALUES
  ('20000000-0000-0000-0000-000000000100','rans-job',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}','${ID.campaign}','sweep',1,1,'done',1,1,'{"aoas":[0]}'::jsonb,now(),now()),
  ('20000000-0000-0000-0000-000000000101','marker-job',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}',NULL,'targeted',1,2,'done',1,1,'{"aoas":[1],"uransFidelity":"precalc"}'::jsonb,now(),now()),
  ('20000000-0000-0000-0000-000000000102','two-job-1',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}',NULL,'targeted',1,2,'done',1,1,'{"aoas":[2],"uransFidelity":"precalc"}'::jsonb,now()-interval '2 hour',now()-interval '2 hour'),
  ('20000000-0000-0000-0000-000000000103','two-job-2',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}',NULL,'targeted',1,2,'done',1,1,'{"aoas":[2],"uransFidelity":"precalc"}'::jsonb,now()-interval '1 hour',now()-interval '1 hour'),
  ('20000000-0000-0000-0000-000000000104','accepted-job',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}',NULL,'targeted',1,2,'done',1,1,'{"aoas":[3],"uransFidelity":"precalc"}'::jsonb,now(),now()),
  ('20000000-0000-0000-0000-000000000105','full-prior-job',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}',NULL,'targeted',1,2,'done',1,1,'{"aoas":[4],"uransFidelity":"precalc"}'::jsonb,now(),now()),
  ('20000000-0000-0000-0000-000000000106','exact-running',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}',NULL,'targeted',1,2,'running',1,0,'{"aoas":[5],"uransFidelity":"precalc"}'::jsonb,now(),NULL),
  ('20000000-0000-0000-0000-000000000107',NULL,NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}',NULL,'targeted',1,2,'pending',1,0,'{"aoas":[6],"uransFidelity":"precalc"}'::jsonb,NULL,NULL),
  ('20000000-0000-0000-0000-000000000108','auto-parent',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}','${ID.campaign}','sweep',1,1,'done',1,1,'{"aoas":[7]}'::jsonb,now(),now()),
  ('20000000-0000-0000-0000-000000000109','auto-child','20000000-0000-0000-0000-000000000108','${ID.airfoil}','["${ID.bc}"]','${ID.revision}',NULL,'targeted',1,2,'running',1,0,'{"aoas":[7],"uransFidelity":"precalc"}'::jsonb,now(),NULL),
  ('20000000-0000-0000-0000-00000000010a','whole-running',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}',NULL,'targeted',1,2,'running',2,0,'{"aoas":[8,9],"uransFidelity":"precalc"}'::jsonb,now(),NULL),
  ('20000000-0000-0000-0000-00000000010b','orphan-marker-job',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}',NULL,'targeted',1,2,'done',1,1,'{"aoas":[10],"uransFidelity":"precalc"}'::jsonb,now(),now()),
  ('20000000-0000-0000-0000-00000000010c','canonical-marker-job',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}','${ID.campaign}','targeted',1,2,'done',1,1,'{"aoas":[11],"uransFidelity":"precalc"}'::jsonb,now(),now()),
  ('20000000-0000-0000-0000-00000000010d','ledger-only-1',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}','${ID.campaign}','targeted',1,2,'done',1,1,'{"aoas":[12],"uransFidelity":"precalc"}'::jsonb,now()-interval '2 hour',now()-interval '2 hour'),
  ('20000000-0000-0000-0000-00000000010e','ledger-only-2',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}','${ID.campaign}','targeted',1,2,'done',1,1,'{"aoas":[12],"uransFidelity":"precalc"}'::jsonb,now()-interval '1 hour',now()-interval '1 hour'),
  ('20000000-0000-0000-0000-00000000010f','duplicate-json-job',NULL,'${ID.airfoil}','["${ID.bc}"]','${ID.revision}','${ID.campaign}','targeted',1,2,'done',1,1,'{"aoas":[13,13],"uransFidelity":"precalc"}'::jsonb,now(),now());

INSERT INTO results
  (id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg, status,
   source, regime, fidelity, sim_job_id, engine_job_id, engine_case_slug,
   cl, cd, cm, converged, unsteady, stalled, quality_warnings, "solvedAt")
VALUES
  ('30000000-0000-0000-0000-000000000100','${ID.airfoil}','${ID.bc}','${ID.revision}',0,'done','solved','rans','rans','20000000-0000-0000-0000-000000000100','rans-job','a0',0.2,0.02,-0.02,false,false,true,NULL,now()),
  ('30000000-0000-0000-0000-000000000101','${ID.airfoil}','${ID.bc}','${ID.revision}',1,'done','solved','urans','urans_precalc','20000000-0000-0000-0000-000000000101','marker-job','a1',0.3,0.03,-0.02,true,true,true,ARRAY['URANS integration ${URANS_BUDGET_STOP_MARKER}: elapsed'],now()),
  ('30000000-0000-0000-0000-000000000102','${ID.airfoil}','${ID.bc}','${ID.revision}',2,'done','solved','urans','urans_precalc','20000000-0000-0000-0000-000000000103','two-job-2','a2',0.4,0.04,-0.02,true,true,true,ARRAY['URANS integration ${URANS_CONTINUATION_REQUIRED_MARKER}: elapsed'],now()),
  ('30000000-0000-0000-0000-000000000103','${ID.airfoil}','${ID.bc}','${ID.revision}',3,'done','solved','urans','urans_precalc','20000000-0000-0000-0000-000000000104','accepted-job','a3',0.5,0.05,-0.02,true,true,true,NULL,now()),
  ('30000000-0000-0000-0000-000000000104','${ID.airfoil}','${ID.bc}','${ID.revision}',4,'done','solved','urans','urans_full','20000000-0000-0000-0000-000000000105','full-prior-job','a4',0.6,0.06,-0.02,true,true,true,NULL,now()),
  ('30000000-0000-0000-0000-000000000105','${ID.airfoil}','${ID.bc}','${ID.revision}',14,'done','solved','urans','urans_precalc',NULL,NULL,NULL,0.7,0.07,-0.02,true,true,true,NULL,now()),
  ('30000000-0000-0000-0000-000000000106','${ID.airfoil}','${ID.bc}','${ID.revision}',15,'done','solved','urans','urans_precalc',NULL,NULL,NULL,0.8,0.08,-0.02,true,true,true,NULL,now()),
  ('30000000-0000-0000-0000-000000000107','${ID.airfoil}','${ID.bc}','${ID.revision}',10,'done','solved','urans','urans_precalc','20000000-0000-0000-0000-00000000010b','orphan-marker-job','a10',0.9,0.09,-0.02,true,true,true,ARRAY['URANS integration ${URANS_BUDGET_STOP_MARKER}: elapsed'],now()),
  ('30000000-0000-0000-0000-000000000108','${ID.airfoil}','${ID.bc}','${ID.revision}',11,'done','solved','urans','urans_precalc','20000000-0000-0000-0000-00000000010c','canonical-marker-job','a11',1.0,0.10,-0.02,true,true,true,ARRAY['URANS integration ${URANS_CONTINUATION_REQUIRED_MARKER}: elapsed'],now());

INSERT INTO result_attempts
  (id, result_id, airfoil_id, bc_id, simulation_preset_revision_id, aoa_deg,
   sim_job_id, engine_job_id, engine_case_slug, status, source, regime,
   valid_for_polar, converged, unsteady, stalled, quality_warnings,
   evidence_payload, "solvedAt", "createdAt")
VALUES
  ('40000000-0000-0000-0000-000000000100','30000000-0000-0000-0000-000000000100','${ID.airfoil}','${ID.bc}','${ID.revision}',0,'20000000-0000-0000-0000-000000000100','rans-job','a0','failed','solved','rans',false,false,false,true,NULL,'{"fidelity":"rans"}'::jsonb,now(),now()-interval '5 hour'),
  ('40000000-0000-0000-0000-000000000101','30000000-0000-0000-0000-000000000101','${ID.airfoil}','${ID.bc}','${ID.revision}',1,'20000000-0000-0000-0000-000000000101','marker-job','a1','done','solved','urans',false,true,true,true,ARRAY['URANS integration ${URANS_BUDGET_STOP_MARKER}: elapsed'],'{"fidelity":"urans_precalc"}'::jsonb,now(),now()-interval '4 hour'),
  ('40000000-0000-0000-0000-000000000102','30000000-0000-0000-0000-000000000102','${ID.airfoil}','${ID.bc}','${ID.revision}',2,'20000000-0000-0000-0000-000000000102','two-job-1','a2','done','solved','urans',false,true,true,true,ARRAY['URANS integration ${URANS_CONTINUATION_REQUIRED_MARKER}: elapsed'],'{"fidelity":"urans_precalc"}'::jsonb,now(),now()-interval '3 hour'),
  ('40000000-0000-0000-0000-000000000103','30000000-0000-0000-0000-000000000102','${ID.airfoil}','${ID.bc}','${ID.revision}',2,'20000000-0000-0000-0000-000000000103','two-job-2','a2b','done','solved','urans',false,true,true,true,ARRAY['URANS integration ${URANS_CONTINUATION_REQUIRED_MARKER}: elapsed'],'{"fidelity":"urans_precalc"}'::jsonb,now(),now()-interval '2 hour'),
  ('40000000-0000-0000-0000-000000000104','30000000-0000-0000-0000-000000000103','${ID.airfoil}','${ID.bc}','${ID.revision}',3,'20000000-0000-0000-0000-000000000104','accepted-job','a3','done','solved','urans',true,true,true,true,NULL,'{"fidelity":"urans_precalc"}'::jsonb,now(),now()-interval '1 hour'),
  ('40000000-0000-0000-0000-000000000105','30000000-0000-0000-0000-000000000104','${ID.airfoil}','${ID.bc}','${ID.revision}',4,'20000000-0000-0000-0000-000000000105','full-prior-job','a4','done','solved','urans',false,true,true,true,ARRAY['URANS integration ${URANS_BUDGET_STOP_MARKER}: elapsed'],'{"fidelity":"urans_precalc"}'::jsonb,now(),now()-interval '1 hour'),
  ('40000000-0000-0000-0000-000000000106','30000000-0000-0000-0000-000000000107','${ID.airfoil}','${ID.bc}','${ID.revision}',10,'20000000-0000-0000-0000-00000000010b','orphan-marker-job','a10','done','solved','urans',false,true,true,true,ARRAY['URANS integration ${URANS_BUDGET_STOP_MARKER}: elapsed'],'{"fidelity":"urans_precalc"}'::jsonb,now(),now());

INSERT INTO result_classifications
  (id, result_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
   regime, classifier_version, state, reasons)
VALUES
  ('50000000-0000-0000-0000-000000000100','30000000-0000-0000-0000-000000000100','${ID.airfoil}','${ID.revision}',0,'rans','upgrade-v1','needs_urans',ARRAY['needs URANS']),
  ('50000000-0000-0000-0000-000000000101','30000000-0000-0000-0000-000000000101','${ID.airfoil}','${ID.revision}',1,'urans','fidelity-ladder-v4','accepted',ARRAY[]::text[]),
  ('50000000-0000-0000-0000-000000000102','30000000-0000-0000-0000-000000000102','${ID.airfoil}','${ID.revision}',2,'urans','fidelity-ladder-v4','accepted',ARRAY[]::text[]),
  ('50000000-0000-0000-0000-000000000103','30000000-0000-0000-0000-000000000103','${ID.airfoil}','${ID.revision}',3,'urans','upgrade-v1','accepted',ARRAY[]::text[]),
  ('50000000-0000-0000-0000-000000000104','30000000-0000-0000-0000-000000000104','${ID.airfoil}','${ID.revision}',4,'urans','upgrade-v1','accepted',ARRAY[]::text[]),
  ('50000000-0000-0000-0000-000000000105','30000000-0000-0000-0000-000000000105','${ID.airfoil}','${ID.revision}',14,'urans','upgrade-v1','accepted',ARRAY[]::text[]),
  ('50000000-0000-0000-0000-000000000106','30000000-0000-0000-0000-000000000106','${ID.airfoil}','${ID.revision}',15,'urans','upgrade-v1','accepted',ARRAY[]::text[]),
  ('50000000-0000-0000-0000-000000000107','30000000-0000-0000-0000-000000000107','${ID.airfoil}','${ID.revision}',10,'urans','fidelity-ladder-v4','accepted',ARRAY[]::text[]),
  ('50000000-0000-0000-0000-000000000108','30000000-0000-0000-0000-000000000108','${ID.airfoil}','${ID.revision}',11,'urans','fidelity-ladder-v4','accepted',ARRAY[]::text[]);
INSERT INTO result_classifications
  (id, result_attempt_id, airfoil_id, simulation_preset_revision_id, aoa_deg,
   regime, classifier_version, state, reasons)
VALUES
  ('51000000-0000-0000-0000-000000000100','40000000-0000-0000-0000-000000000100','${ID.airfoil}','${ID.revision}',0,'rans','upgrade-v1','rejected',ARRAY['RANS failed']),
  ('51000000-0000-0000-0000-000000000101','40000000-0000-0000-0000-000000000101','${ID.airfoil}','${ID.revision}',1,'urans','fidelity-ladder-v4','accepted',ARRAY[]::text[]),
  ('51000000-0000-0000-0000-000000000102','40000000-0000-0000-0000-000000000102','${ID.airfoil}','${ID.revision}',2,'urans','fidelity-ladder-v4','accepted',ARRAY[]::text[]),
  ('51000000-0000-0000-0000-000000000103','40000000-0000-0000-0000-000000000103','${ID.airfoil}','${ID.revision}',2,'urans','fidelity-ladder-v4','accepted',ARRAY[]::text[]),
  ('51000000-0000-0000-0000-000000000104','40000000-0000-0000-0000-000000000104','${ID.airfoil}','${ID.revision}',3,'urans','upgrade-v1','accepted',ARRAY[]::text[]),
  ('51000000-0000-0000-0000-000000000105','40000000-0000-0000-0000-000000000105','${ID.airfoil}','${ID.revision}',4,'urans','upgrade-v1','rejected',ARRAY['budget']),
  ('51000000-0000-0000-0000-000000000106','40000000-0000-0000-0000-000000000106','${ID.airfoil}','${ID.revision}',10,'urans','fidelity-ladder-v4','accepted',ARRAY[]::text[]);

INSERT INTO sim_campaign_points
  (campaign_id, condition_id, airfoil_id, aoa_deg, revision_id,
   plan_revision_number, state, result_id, derived_by_symmetry)
VALUES
  ('${ID.campaign}','${ID.condition}','${ID.airfoil}',0,'${ID.revision}',1,'terminal','30000000-0000-0000-0000-000000000100',false),
  ('${ID.campaign}','${ID.condition}','${ID.airfoil}',1,'${ID.revision}',1,'terminal','30000000-0000-0000-0000-000000000101',false),
  ('${ID.campaign}','${ID.condition}','${ID.airfoil}',2,'${ID.revision}',1,'terminal','30000000-0000-0000-0000-000000000102',false),
  ('${ID.campaign}','${ID.condition}','${ID.airfoil}',11,'${ID.revision}',1,'terminal','30000000-0000-0000-0000-000000000108',false),
  ('${ID.campaign}','${ID.condition}','${ID.airfoil}',12,'${ID.revision}',1,'requested',NULL,false),
  ('${ID.campaign}','${ID.condition}','${ID.airfoil}',7,'${ID.revision}',1,'requested',NULL,false),
  ('${ID.campaign}','${ID.releasedCondition}','${ID.airfoil}',2,'${ID.revision}',1,'released','30000000-0000-0000-0000-000000000102',false);

-- Deliberately stale pre-0047 counters: the upgrade must rebuild these after
-- obligation projection, without waiting for a sweeper/reconciler tick.
INSERT INTO sim_campaign_progress
  (campaign_id, condition_id, airfoil_id, requested, solved, failed, running,
   superseded, derived, rejected)
VALUES
  ('${ID.campaign}','${ID.condition}','${ID.airfoil}',6,6,0,0,0,0,0),
  ('${ID.campaign}','${ID.releasedCondition}','${ID.airfoil}',1,1,0,0,0,0,0);

INSERT INTO sim_urans_requests
  (id, airfoil_id, revision_id, aoa_deg, fidelity, state, sim_job_id,
   continue_from_result_id, requested_by)
VALUES
  ('60000000-0000-0000-0000-000000000100','${ID.airfoil}','${ID.revision}',0,'precalc','pending',NULL,NULL,'system:precalc-continuation-v1'),
  ('60000000-0000-0000-0000-000000000101','${ID.airfoil}','${ID.revision}',1,'precalc','pending',NULL,'30000000-0000-0000-0000-000000000101','system:precalc-continuation-v1'),
  ('60000000-0000-0000-0000-000000000102','${ID.airfoil}','${ID.revision}',5,'precalc','running','20000000-0000-0000-0000-000000000106',NULL,'admin@airfoils.pro'),
  ('60000000-0000-0000-0000-000000000103','${ID.airfoil}','${ID.revision}',6,'precalc','running','20000000-0000-0000-0000-000000000107',NULL,'admin@airfoils.pro'),
  ('60000000-0000-0000-0000-000000000104','${ID.airfoil}','${ID.revision}',NULL,'precalc','running','20000000-0000-0000-0000-00000000010a',NULL,'admin@airfoils.pro');

INSERT INTO sim_urans_verify_queue
  (id, airfoil_id, revision_id, aoa_deg, campaign_id, state, precalc_result_id)
VALUES
  ('70000000-0000-0000-0000-000000000100','${ID.airfoil}','${ID.revision}',14,'${ID.deletedCampaign}','pending','30000000-0000-0000-0000-000000000105'),
  ('70000000-0000-0000-0000-000000000101','${ID.airfoil}','${ID.revision}',15,NULL,'pending','30000000-0000-0000-0000-000000000106');
DELETE FROM sim_campaigns WHERE id = '${ID.deletedCampaign}';
`;

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  baselineDir = makeMigrationFolder(42);
  client = postgres(targetUrl.toString(), { max: 1 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: baselineDir });
  await client.unsafe(fixtureSql);
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

describe("0043→0047 PRECALC upgrade data", () => {
  it("reconstructs ownership, bounded attempts, accepted truth, and in-flight payloads", async () => {
    const rows = (await client!.unsafe(`
      SELECT aoa_deg::float8 AS aoa, state, attempt_count, background_owner,
             last_outcome, last_error, next_submit_at
      FROM sim_precalc_obligations
      ORDER BY aoa_deg
    `)) as unknown as Array<{
      aoa: number;
      state: string;
      attempt_count: number;
      background_owner: boolean;
      last_outcome: string | null;
      last_error: string | null;
      next_submit_at: Date | null;
    }>;
    const byAoa = new Map(rows.map((row) => [Number(row.aoa), row]));
    expect(byAoa.get(0)).toMatchObject({ state: "pending", attempt_count: 0 });
    expect(byAoa.get(1)).toMatchObject({
      state: "pending",
      attempt_count: 1,
      last_outcome: "rejected",
    });
    expect(byAoa.get(2)).toMatchObject({
      state: "blocked",
      attempt_count: 2,
      last_outcome: "rejected_exhausted",
    });
    expect(byAoa.get(3)).toMatchObject({
      state: "satisfied",
      attempt_count: 1,
      last_outcome: "accepted",
      last_error: null,
      next_submit_at: null,
    });
    expect(byAoa.get(4)).toMatchObject({
      state: "satisfied",
      attempt_count: 1,
      last_outcome: "accepted",
      last_error: null,
      next_submit_at: null,
    });
    expect(byAoa.get(5)).toMatchObject({
      state: "running",
      attempt_count: 1,
      background_owner: false,
    });
    expect(byAoa.get(6)).toMatchObject({
      state: "pending",
      attempt_count: 0,
      background_owner: false,
    });
    expect(byAoa.get(7)).toMatchObject({ state: "running", attempt_count: 1 });
    expect(byAoa.get(8)).toMatchObject({ state: "running", attempt_count: 1 });
    expect(byAoa.get(9)).toMatchObject({ state: "running", attempt_count: 1 });
    expect(byAoa.get(10)).toMatchObject({
      state: "cancelled",
      attempt_count: 1,
      last_outcome: "rejected",
    });
    expect(byAoa.get(11)).toMatchObject({
      state: "pending",
      attempt_count: 1,
      last_outcome: "rejected",
    });
    expect(byAoa.get(12)).toMatchObject({
      state: "blocked",
      attempt_count: 2,
      last_outcome: "failed_exhausted",
    });
    expect(byAoa.get(13)).toMatchObject({
      state: "pending",
      attempt_count: 1,
    });

    const attempts = (await client!.unsafe(`
      SELECT obligation.aoa_deg::float8 AS aoa,
             array_agg(attempt.attempt_number ORDER BY attempt.attempt_number) AS numbers,
             array_agg(attempt.state ORDER BY attempt.attempt_number) AS states,
             array_agg(attempt.outcome ORDER BY attempt.attempt_number) AS outcomes
      FROM sim_precalc_obligation_attempts attempt
      JOIN sim_precalc_obligations obligation ON obligation.id = attempt.obligation_id
      GROUP BY obligation.aoa_deg ORDER BY obligation.aoa_deg
    `)) as unknown as Array<{
      aoa: number;
      numbers: number[];
      states: string[];
      outcomes: string[];
    }>;
    const attemptsByAoa = new Map(
      attempts.map((row) => [Number(row.aoa), row]),
    );
    expect(attemptsByAoa.get(2)?.numbers).toEqual([1, 2]);
    expect(attemptsByAoa.get(1)).toMatchObject({
      states: ["rejected"],
      outcomes: ["rejected"],
    });
    expect(attemptsByAoa.get(2)).toMatchObject({
      states: ["rejected", "rejected"],
      outcomes: ["rejected", "rejected"],
    });
    expect(attemptsByAoa.get(10)).toMatchObject({
      states: ["rejected"],
      outcomes: ["rejected"],
    });
    expect(attemptsByAoa.get(11)).toMatchObject({
      states: ["rejected"],
      outcomes: ["rejected"],
    });
    // Two engine-accepted jobs with no result_attempt evidence must occupy
    // two distinct ledger slots. The former unranked insert collapsed these
    // onto attempt 1 and left an illegal third solve available.
    expect(attemptsByAoa.get(12)).toMatchObject({
      numbers: [1, 2],
      states: ["failed", "failed"],
      outcomes: ["failed", "failed"],
    });
    expect(attemptsByAoa.get(13)?.numbers).toEqual([1]);
    expect(Math.max(...attempts.flatMap((row) => row.numbers))).toBe(2);

    const [progress] = (await client!.unsafe(`
      SELECT requested, solved, failed, rejected, blocked,
             requested - solved - derived - failed - rejected - blocked AS remaining
      FROM sim_campaign_progress
      WHERE campaign_id = '${ID.campaign}'
        AND condition_id = '${ID.condition}'
        AND airfoil_id = '${ID.airfoil}'
    `)) as unknown as Array<{
      requested: number;
      solved: number;
      failed: number;
      rejected: number;
      blocked: number;
      remaining: number;
    }>;
    expect(progress).toMatchObject({
      requested: 6,
      solved: 3,
      failed: 0,
      rejected: 0,
      blocked: 2,
      remaining: 1,
    });
    const [releasedProgress] = (await client!.unsafe(`
      SELECT requested, solved, failed, rejected, blocked,
             requested - solved - derived - failed - rejected - blocked AS remaining
      FROM sim_campaign_progress
      WHERE campaign_id = '${ID.campaign}'
        AND condition_id = '${ID.releasedCondition}'
        AND airfoil_id = '${ID.airfoil}'
    `)) as unknown as Array<{
      requested: number;
      solved: number;
      failed: number;
      rejected: number;
      blocked: number;
      remaining: number;
    }>;
    expect(releasedProgress).toMatchObject({
      requested: 0,
      solved: 0,
      failed: 0,
      rejected: 0,
      blocked: 0,
      remaining: 0,
    });

    const attemptPins = (await client!.unsafe(`
      SELECT aoa_deg::float8 AS aoa, result_attempt_id
      FROM sim_campaign_points
      WHERE campaign_id = '${ID.campaign}'
        AND condition_id = '${ID.condition}'
        AND aoa_deg IN (0, 2)
      ORDER BY aoa_deg
    `)) as unknown as Array<{
      aoa: number;
      result_attempt_id: string | null;
    }>;
    expect(attemptPins).toEqual([
      {
        aoa: 0,
        result_attempt_id: "40000000-0000-0000-0000-000000000100",
      },
      { aoa: 2, result_attempt_id: null },
    ]);
    await client!.unsafe(`
      DELETE FROM result_attempts
      WHERE id = '40000000-0000-0000-0000-000000000100'
    `);
    const [preservedPoint] = (await client!.unsafe(`
      SELECT count(*)::int AS n, max(result_attempt_id::text) AS result_attempt_id
      FROM sim_campaign_points
      WHERE campaign_id = '${ID.campaign}' AND aoa_deg = 0
    `)) as unknown as Array<{ n: number; result_attempt_id: string | null }>;
    expect(preservedPoint).toEqual({ n: 1, result_attempt_id: null });

    const jobs = (await client!.unsafe(`
      SELECT id, request_payload -> 'precalcObligationIds' AS ids
      FROM sim_jobs
      WHERE id IN (
        '20000000-0000-0000-0000-000000000106',
        '20000000-0000-0000-0000-000000000107',
        '20000000-0000-0000-0000-000000000109',
        '20000000-0000-0000-0000-00000000010a',
        '20000000-0000-0000-0000-00000000010f'
      ) ORDER BY id
    `)) as unknown as Array<{ id: string; ids: string[] }>;
    expect(jobs.map((job) => job.ids.length)).toEqual([1, 1, 1, 2, 1]);

    const requestRows = (await client!.unsafe(`
      SELECT request.id, request.state, request.sim_job_id,
             count(coverage.obligation_id)::int AS coverage_count,
             count(owner.campaign_id)::int AS campaign_owner_count
      FROM sim_urans_requests request
      LEFT JOIN sim_precalc_obligation_requests coverage ON coverage.request_id = request.id
      LEFT JOIN sim_urans_request_campaigns owner
        ON owner.request_id = request.id AND owner.state = 'active'
      GROUP BY request.id ORDER BY request.id
    `)) as unknown as Array<{
      id: string;
      state: string;
      sim_job_id: string | null;
      coverage_count: number;
      campaign_owner_count: number;
    }>;
    const requests = new Map(requestRows.map((row) => [row.id, row]));
    expect(requests.get("60000000-0000-0000-0000-000000000100")).toMatchObject({
      state: "pending",
      campaign_owner_count: 1,
    });
    expect(requests.get("60000000-0000-0000-0000-000000000102")).toMatchObject({
      state: "running",
      coverage_count: 1,
    });
    expect(requests.get("60000000-0000-0000-0000-000000000103")).toMatchObject({
      state: "pending",
      sim_job_id: null,
      coverage_count: 1,
    });
    expect(requests.get("60000000-0000-0000-0000-000000000104")).toMatchObject({
      state: "running",
      coverage_count: 2,
    });

    const verify = (await client!.unsafe(`
      SELECT id, state, background_owner FROM sim_urans_verify_queue ORDER BY id
    `)) as unknown as Array<{
      id: string;
      state: string;
      background_owner: boolean;
    }>;
    expect(verify).toEqual([
      {
        id: "70000000-0000-0000-0000-000000000100",
        state: "cancelled",
        background_owner: false,
      },
      {
        id: "70000000-0000-0000-0000-000000000101",
        state: "cancelled",
        background_owner: false,
      },
    ]);
  }, 60_000);

  it("reprojects populated 0046 accepted-marker evidence without fake satisfaction", async () => {
    const upgradeDbName = `aerodb_precalc_0047_${process.pid}_${Date.now()}`;
    const upgradeUrl = new URL(baseUrl);
    upgradeUrl.pathname = `/${upgradeDbName}`;
    const upgradeAdmin = postgres(adminUrl.toString(), { max: 1 });
    let upgradeClient: ReturnType<typeof postgres> | null = null;
    let through0046 = "";
    let through0047 = "";

    try {
      await upgradeAdmin.unsafe(`CREATE DATABASE "${upgradeDbName}"`);
      through0046 = makeMigrationFolder(46);
      through0047 = makeMigrationFolder(47);
      upgradeClient = postgres(upgradeUrl.toString(), { max: 1 });
      const upgradeDb = drizzle(upgradeClient);
      await migrate(upgradeDb, { migrationsFolder: through0046 });
      await upgradeClient.unsafe(fixtureSql);
      await migrate(upgradeDb, { migrationsFolder: through0047 });

      const obligations = (await upgradeClient.unsafe(`
        SELECT aoa_deg::float8 AS aoa, state, attempt_count, last_outcome
        FROM sim_precalc_obligations
        WHERE aoa_deg IN (1, 2, 3, 10, 11)
        ORDER BY aoa_deg
      `)) as unknown as Array<{
        aoa: number;
        state: string;
        attempt_count: number;
        last_outcome: string | null;
      }>;
      const obligationByAoa = new Map(
        obligations.map((row) => [Number(row.aoa), row]),
      );
      expect(obligationByAoa.get(1)).toMatchObject({
        state: "pending",
        attempt_count: 1,
        last_outcome: "rejected",
      });
      expect(obligationByAoa.get(2)).toMatchObject({
        state: "blocked",
        attempt_count: 2,
        last_outcome: "rejected_exhausted",
      });
      expect(obligationByAoa.get(3)).toMatchObject({
        state: "satisfied",
        attempt_count: 1,
        last_outcome: "accepted",
      });
      expect(obligationByAoa.get(10)).toMatchObject({
        state: "cancelled",
        attempt_count: 1,
        last_outcome: "rejected",
      });
      expect(obligationByAoa.get(11)).toMatchObject({
        state: "pending",
        attempt_count: 1,
        last_outcome: "rejected",
      });

      const ledger = (await upgradeClient.unsafe(`
        SELECT obligation.aoa_deg::float8 AS aoa,
               array_agg(attempt.state ORDER BY attempt.attempt_number) AS states,
               array_agg(attempt.outcome ORDER BY attempt.attempt_number) AS outcomes,
               count(attempt.result_attempt_id)::int AS linked_evidence_count
        FROM sim_precalc_obligation_attempts attempt
        JOIN sim_precalc_obligations obligation
          ON obligation.id = attempt.obligation_id
        WHERE obligation.aoa_deg IN (1, 2, 3, 10, 11)
        GROUP BY obligation.aoa_deg
        ORDER BY obligation.aoa_deg
      `)) as unknown as Array<{
        aoa: number;
        states: string[];
        outcomes: string[];
        linked_evidence_count: number;
      }>;
      const ledgerByAoa = new Map(ledger.map((row) => [Number(row.aoa), row]));
      expect(ledgerByAoa.get(1)).toMatchObject({
        states: ["rejected"],
        outcomes: ["rejected"],
        linked_evidence_count: 1,
      });
      expect(ledgerByAoa.get(2)).toMatchObject({
        states: ["rejected", "rejected"],
        outcomes: ["rejected", "rejected"],
        linked_evidence_count: 2,
      });
      expect(ledgerByAoa.get(3)).toMatchObject({
        states: ["accepted"],
        outcomes: ["accepted"],
        linked_evidence_count: 1,
      });
      expect(ledgerByAoa.get(10)).toMatchObject({
        states: ["rejected"],
        outcomes: ["rejected"],
        linked_evidence_count: 1,
      });
      expect(ledgerByAoa.get(11)).toMatchObject({
        states: ["rejected"],
        outcomes: ["rejected"],
        linked_evidence_count: 0,
      });
    } finally {
      if (upgradeClient) await upgradeClient.end();
      await upgradeAdmin.unsafe(
        `DROP DATABASE IF EXISTS "${upgradeDbName}" WITH (FORCE)`,
      );
      await upgradeAdmin.end();
      if (through0046) rmSync(through0046, { recursive: true, force: true });
      if (through0047) rmSync(through0047, { recursive: true, force: true });
    }
  }, 180_000);
});
