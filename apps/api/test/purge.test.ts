// POST /api/admin/test-artifacts/purge — campaign-family residue coverage.
// Seeds everything through the public/admin API (the same way the Playwright
// e2e suites do), launches a real campaign, lands one solved-evidence row on
// a campaign point, then asserts a single purge call removes EVERY campaign
// artifact: sim_campaigns (+airfoils/plan_revisions/conditions/points/
// progress/lanes via FK), origin='campaign' presets pinned by the campaign,
// their legacy boundary_conditions mirrors, campaign-created flow_conditions
// and reference_geometry_profiles, results at the pinned revisions, and the
// pw- catalog rows themselves.
import { results } from "@aerodb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { db, sql as pgClient } from "../src/db";
import { buildServer } from "../src/server";

const PREFIX = `pw-purge-${Date.now().toString(36)}`;

let app: Awaited<ReturnType<typeof buildServer>>;
let campaignId = "";
let symId = "";
let asymId = "";
let mediumId = "";
let numerics = { boundaryProfileId: "", meshProfileId: "", solverProfileId: "", outputProfileId: "" };
// Unusual physics values so the launch really creates the flow/geometry rows
// (canonical-key reuse would otherwise attribute them to an older campaign).
const AMBIENT: [number, number] = [289.37, 100123];
const SPEED = 13.7;
const CHORD = 0.279;

async function countRows(query: ReturnType<typeof sql>): Promise<number> {
  const [row] = (await db.execute(query)) as unknown as Array<{ n: number }>;
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  app = await buildServer();

  const cat = await app.inject({ method: "POST", url: "/api/admin/categories", payload: { name: `${PREFIX} cat`, parentId: null } });
  expect(cat.statusCode).toBe(201);
  const catSlug = cat.json().slug as string;

  // Airfoils through the public API — also proves symmetry is a real computed
  // property at creation time (NACA 0012 symmetric, NACA 4415 cambered).
  const symRes = await app.inject({
    method: "POST",
    url: "/api/airfoils",
    payload: { name: `${PREFIX} sym 0012`, categorySlug: catSlug, naca: { t: 0.12, m: 0, p: 0 } },
  });
  expect(symRes.statusCode).toBe(201);
  symId = symRes.json().id;
  const asymRes = await app.inject({
    method: "POST",
    url: "/api/airfoils",
    payload: { name: `${PREFIX} asym 4415`, categorySlug: catSlug, naca: { t: 0.15, m: 0.04, p: 0.4 } },
  });
  expect(asymRes.statusCode).toBe(201);
  asymId = asymRes.json().id;

  const medium = await app.inject({
    method: "POST",
    url: "/api/admin/mediums",
    payload: {
      name: `${PREFIX} air`,
      phase: "gas",
      density: 1.225,
      refTemperatureK: 288.15,
      refPressurePa: 101325,
      viscosityModel: "constant",
      constantDynamicViscosity: 1.789e-5,
      speedOfSound: 340.3,
    },
  });
  expect(medium.statusCode).toBe(201);
  mediumId = medium.json().id;

  const profiles = await Promise.all([
    app.inject({ method: "POST", url: "/api/admin/boundary-profiles", payload: { name: `${PREFIX} boundary` } }),
    app.inject({ method: "POST", url: "/api/admin/mesh-profiles", payload: { name: `${PREFIX} mesh` } }),
    app.inject({ method: "POST", url: "/api/admin/solver-profiles", payload: { name: `${PREFIX} solver` } }),
    app.inject({ method: "POST", url: "/api/admin/output-profiles", payload: { name: `${PREFIX} output` } }),
  ]);
  for (const res of profiles) expect(res.statusCode).toBe(201);
  numerics = {
    boundaryProfileId: profiles[0].json().id,
    meshProfileId: profiles[1].json().id,
    solverProfileId: profiles[2].json().id,
    outputProfileId: profiles[3].json().id,
  };
});

afterAll(async () => {
  // Defensive teardown if an assertion failed midway; a clean run leaves
  // nothing for this purge to find.
  await app.inject({ method: "POST", url: "/api/admin/test-artifacts/purge", payload: { prefix: PREFIX } });
  await app.close();
  await pgClient.end();
});

describe("test-artifacts purge — campaign cascade", () => {
  it("launches a campaign with symmetric planning (isSymmetric computed at creation)", async () => {
    const airfoilRows = (await db.execute(sql`
      SELECT id, is_symmetric, "symmetryCheckedAt" AS symmetry_checked_at FROM airfoils WHERE id IN (${symId}::uuid, ${asymId}::uuid)
    `)) as unknown as Array<{ id: string; is_symmetric: boolean; symmetry_checked_at: string | null }>;
    const bySelf = new Map(airfoilRows.map((r) => [r.id, r]));
    expect(bySelf.get(symId)?.is_symmetric).toBe(true);
    expect(bySelf.get(symId)?.symmetry_checked_at).toBeTruthy();
    expect(bySelf.get(asymId)?.is_symmetric).toBe(false);
    expect(bySelf.get(asymId)?.symmetry_checked_at).toBeTruthy();

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} purge target`,
        priority: 5,
        idempotencyKey: `${PREFIX}-launch-key`,
        airfoilIds: [symId, asymId],
        plan: {
          mediumId,
          ambients: [AMBIENT],
          speedsMps: [SPEED],
          chordsM: [CHORD],
          spanM: 1,
          areaMode: "derived",
          excludedConditions: [],
          baseSweep: { fromDeg: -2, toDeg: 2, stepDeg: 2, listDeg: null },
          objectives: {
            ldMax: { enabled: true, toleranceDeg: 0.1, maxRounds: 4 },
            clZero: { enabled: true, toleranceDeg: 0.05, maxRounds: 4 },
          },
          numerics,
        },
      },
    });
    expect(res.statusCode).toBe(201);
    campaignId = res.json().campaign.id;
    // 3 angles (−2, 0, 2) × 2 airfoils × 1 condition = 6 points.
    expect(res.json().totals.requested).toBe(6);

    // Symmetric planning materialized real derived_by_symmetry point rows.
    const derived = await countRows(
      sql`SELECT count(*)::int AS n FROM sim_campaign_points WHERE campaign_id = ${campaignId} AND derived_by_symmetry`,
    );
    expect(derived).toBe(1); // symmetric airfoil at −2°
    const lanes = await countRows(sql`SELECT count(*)::int AS n FROM sim_campaign_lanes WHERE campaign_id = ${campaignId}`);
    expect(lanes).toBe(4); // 2 airfoils × 1 condition × 2 objectives
  });

  it("records a plan edit as revision 2 with kind='edit' (releases the removed angle)", async () => {
    const editedPlan = {
      mediumId,
      ambients: [AMBIENT],
      speedsMps: [SPEED],
      chordsM: [CHORD],
      spanM: 1,
      areaMode: "derived",
      excludedConditions: [],
      // Drops −2° and adds 1° while keeping ≥3 angles for the objectives.
      baseSweep: { fromDeg: null, toDeg: null, stepDeg: null, listDeg: [0, 1, 2] },
      objectives: {
        ldMax: { enabled: true, toleranceDeg: 0.1, maxRounds: 4 },
        clZero: { enabled: true, toleranceDeg: 0.05, maxRounds: 4 },
      },
      numerics,
    };
    const preview = await app.inject({
      method: "POST",
      url: `/api/admin/campaigns/${campaignId}/plan/preview`,
      payload: { plan: editedPlan, basePlanRevisionNumber: 1 },
    });
    expect(preview.statusCode).toBe(200);
    const diff = preview.json();
    expect(diff.removedAngles.map(Number)).toEqual([-2]);
    // −2° releases the cambered solver point and the symmetric derived point.
    expect(diff.cancelledPoints).toBe(2);
    const apply = await app.inject({
      method: "POST",
      url: `/api/admin/campaigns/${campaignId}/plan/apply`,
      payload: { plan: editedPlan, basePlanRevisionNumber: 1, diffHash: diff.diffHash },
    });
    expect(apply.statusCode).toBe(200);
    expect(apply.json().planRevisionNumber).toBe(2);
    const [revision] = (await db.execute(sql`
      SELECT kind FROM sim_campaign_plan_revisions WHERE campaign_id = ${campaignId} AND revision_number = 2
    `)) as unknown as Array<{ kind: string }>;
    expect(revision?.kind).toBe("edit");
    const released = await countRows(
      sql`SELECT count(*)::int AS n FROM sim_campaign_points WHERE campaign_id = ${campaignId} AND state = 'released'`,
    );
    expect(released).toBe(2);
  });

  it("purges every campaign-family table plus results/presets/mirrors/flow/geometry", async () => {
    // Land one real solved-evidence row on a campaign point so the purge has
    // pw- results residue to remove (mirrors campaigns.test.ts's approach).
    const [cond] = (await db.execute(sql`
      SELECT cc.id, cc.simulation_preset_revision_id AS revision_id, cc.flow_condition_id, cc.reference_geometry_profile_id,
             cc.preset_id, p.legacy_boundary_condition_id AS bc_id
      FROM sim_campaign_conditions cc
      JOIN simulation_presets p ON p.id = cc.preset_id
      WHERE cc.campaign_id = ${campaignId}
    `)) as unknown as Array<{
      id: string;
      revision_id: string;
      flow_condition_id: string;
      reference_geometry_profile_id: string;
      preset_id: string;
      bc_id: string;
    }>;
    expect(cond).toBeTruthy();
    expect(cond.bc_id).toBeTruthy(); // §3.3 legacy bridge exists
    await db.insert(results).values({
      airfoilId: asymId,
      bcId: cond.bc_id,
      simulationPresetRevisionId: cond.revision_id,
      aoaDeg: 2,
      status: "done",
      source: "solved",
      cl: 0.42,
      cd: 0.011,
    });

    // The launch created these rows for THIS campaign (unusual physics values).
    const ownedFlow = await countRows(
      sql`SELECT count(*)::int AS n FROM flow_conditions WHERE created_by_campaign_id = ${campaignId}`,
    );
    const ownedGeo = await countRows(
      sql`SELECT count(*)::int AS n FROM reference_geometry_profiles WHERE created_by_campaign_id = ${campaignId}`,
    );
    expect(ownedFlow).toBeGreaterThan(0);
    expect(ownedGeo).toBeGreaterThan(0);

    // Dry run reports without deleting.
    const dry = await app.inject({ method: "POST", url: "/api/admin/test-artifacts/purge", payload: { prefix: PREFIX, dryRun: true } });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().purged.sim_campaigns).toBe(1);
    expect(await countRows(sql`SELECT count(*)::int AS n FROM sim_campaigns WHERE id = ${campaignId}`)).toBe(1);

    const res = await app.inject({ method: "POST", url: "/api/admin/test-artifacts/purge", payload: { prefix: PREFIX } });
    expect(res.statusCode).toBe(200);
    const purged = res.json().purged;
    expect(purged.sim_campaigns).toBe(1);
    expect(purged.campaign_results).toBe(1);
    expect(purged.campaign_presets).toBeGreaterThan(0);
    expect(purged.campaign_legacy_boundary_conditions).toBeGreaterThan(0);

    // Zero residue in every campaign-family table.
    const residueQueries: Array<[string, ReturnType<typeof sql>]> = [
      ["sim_campaigns", sql`SELECT count(*)::int AS n FROM sim_campaigns WHERE id = ${campaignId}`],
      ["sim_campaign_airfoils", sql`SELECT count(*)::int AS n FROM sim_campaign_airfoils WHERE campaign_id = ${campaignId}`],
      ["sim_campaign_plan_revisions", sql`SELECT count(*)::int AS n FROM sim_campaign_plan_revisions WHERE campaign_id = ${campaignId}`],
      ["sim_campaign_conditions", sql`SELECT count(*)::int AS n FROM sim_campaign_conditions WHERE campaign_id = ${campaignId}`],
      ["sim_campaign_points", sql`SELECT count(*)::int AS n FROM sim_campaign_points WHERE campaign_id = ${campaignId}`],
      ["sim_campaign_progress", sql`SELECT count(*)::int AS n FROM sim_campaign_progress WHERE campaign_id = ${campaignId}`],
      ["sim_campaign_lanes", sql`SELECT count(*)::int AS n FROM sim_campaign_lanes WHERE campaign_id = ${campaignId}`],
      ["sim_campaign_lane_steps", sql`SELECT count(*)::int AS n FROM sim_campaign_lane_steps WHERE campaign_id = ${campaignId}`],
      ["campaign presets", sql`SELECT count(*)::int AS n FROM simulation_presets WHERE id = ${cond.preset_id}`],
      [
        "preset revisions",
        sql`SELECT count(*)::int AS n FROM simulation_preset_revisions WHERE id = ${cond.revision_id}`,
      ],
      ["legacy bc mirrors", sql`SELECT count(*)::int AS n FROM boundary_conditions WHERE id = ${cond.bc_id}`],
      ["campaign flow_conditions", sql`SELECT count(*)::int AS n FROM flow_conditions WHERE id = ${cond.flow_condition_id}`],
      [
        "campaign reference_geometry_profiles",
        sql`SELECT count(*)::int AS n FROM reference_geometry_profiles WHERE id = ${cond.reference_geometry_profile_id}`,
      ],
      [
        "results at pinned revisions",
        sql`SELECT count(*)::int AS n FROM results WHERE simulation_preset_revision_id = ${cond.revision_id}`,
      ],
      ["pw airfoils", sql`SELECT count(*)::int AS n FROM airfoils WHERE id IN (${symId}::uuid, ${asymId}::uuid)`],
      ["pw categories", sql`SELECT count(*)::int AS n FROM categories WHERE name ILIKE ${`${PREFIX}%`}`],
      ["pw mediums", sql`SELECT count(*)::int AS n FROM mediums WHERE id = ${mediumId}`],
      ["pw boundary profiles", sql`SELECT count(*)::int AS n FROM boundary_profiles WHERE id = ${numerics.boundaryProfileId}`],
      ["pw mesh profiles", sql`SELECT count(*)::int AS n FROM mesh_profiles WHERE id = ${numerics.meshProfileId}`],
      ["pw solver profiles", sql`SELECT count(*)::int AS n FROM solver_profiles WHERE id = ${numerics.solverProfileId}`],
      ["pw output profiles", sql`SELECT count(*)::int AS n FROM output_profiles WHERE id = ${numerics.outputProfileId}`],
    ];
    for (const [label, query] of residueQueries) {
      expect(await countRows(query), `${label} should be fully purged`).toBe(0);
    }
  });

  it("still refuses non pw- prefixes", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/test-artifacts/purge", payload: { prefix: "prod-data" } });
    expect(res.statusCode).toBe(422);
  });
});
