// Campaign API integration tests (spec §13): launch idempotency, physics-hash
// revision reuse, legacy bcId bridge, symmetric point planning, reuse preview,
// closure classification (kept vs released), force-release drift checks,
// lifecycle verbs, and the §10 auth hardening.
import { type Point } from "@aerodb/core";
import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  flowConditions,
  mediums,
  meshProfiles,
  outputProfiles,
  referenceGeometryProfiles,
  results,
  simCampaigns,
  simulationPresetRevisions,
  simulationPresets,
  solverProfiles,
  sweepDefinitions,
} from "@aerodb/db";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, sql as pgClient } from "../src/db";
import { buildServer } from "../src/server";

const PREFIX = `pw-camp-${Date.now().toString(36)}`;

const cleanupAirfoilIds: string[] = [];
const cleanupCategoryIds: string[] = [];
const cleanupMediumIds: string[] = [];
const cleanupProfileIds = { boundary: [] as string[], mesh: [] as string[], solver: [] as string[], output: [] as string[] };
const cleanupCampaignIds: string[] = [];
const cleanupResultIds: string[] = [];

const symmetricPoints: Point[] = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.06 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.06 },
  { x: 1, y: 0 },
];
const camberedPoints: Point[] = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

let app: Awaited<ReturnType<typeof buildServer>>;
let asymId = "";
let symId = "";
let mediumId = "";
let numerics = { boundaryProfileId: "", meshProfileId: "", solverProfileId: "", outputProfileId: "" };

function planBody(overrides: Record<string, unknown> = {}) {
  return {
    mediumId,
    ambients: [[288.15, 101325]],
    speedsMps: [10],
    chordsM: [0.2, 0.4],
    spanM: 1,
    areaMode: "derived",
    excludedConditions: [],
    baseSweep: { fromDeg: -2, toDeg: 2, stepDeg: 1, listDeg: null },
    objectives: {
      ldMax: { enabled: true, toleranceDeg: 0.1, maxRounds: 4 },
      clZero: { enabled: true, toleranceDeg: 0.05, maxRounds: 4 },
    },
    numerics,
    ...overrides,
  };
}

beforeAll(async () => {
  app = await buildServer();
  const [cat] = await db
    .insert(categories)
    .values({ slug: `${PREFIX}-cat`, name: `${PREFIX} cat`, path: `${PREFIX}-cat`, depth: 0 })
    .returning();
  cleanupCategoryIds.push(cat.id);
  const [asym] = await db
    .insert(airfoils)
    .values({ slug: `${PREFIX}-cambered`, name: `${PREFIX} cambered`, categoryId: cat.id, points: camberedPoints, isSymmetric: false })
    .returning();
  const [symm] = await db
    .insert(airfoils)
    .values({ slug: `${PREFIX}-symmetric`, name: `${PREFIX} symmetric`, categoryId: cat.id, points: symmetricPoints, isSymmetric: true })
    .returning();
  asymId = asym.id;
  symId = symm.id;
  cleanupAirfoilIds.push(asym.id, symm.id);
  const [medium] = await db
    .insert(mediums)
    .values({
      slug: `${PREFIX}-air`,
      name: `${PREFIX} air`,
      phase: "gas",
      density: 1.225,
      viscosityModel: "constant",
      constantDynamicViscosity: 1.789e-5,
      dynamicViscosity: 1.789e-5,
      kinematicViscosity: 1.789e-5 / 1.225,
      speedOfSound: 340.3,
    })
    .returning();
  mediumId = medium.id;
  cleanupMediumIds.push(medium.id);
  const [boundary] = await db.insert(boundaryProfiles).values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` }).returning();
  const [mesh] = await db.insert(meshProfiles).values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` }).returning();
  const [solver] = await db.insert(solverProfiles).values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` }).returning();
  const [output] = await db.insert(outputProfiles).values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` }).returning();
  cleanupProfileIds.boundary.push(boundary.id);
  cleanupProfileIds.mesh.push(mesh.id);
  cleanupProfileIds.solver.push(solver.id);
  cleanupProfileIds.output.push(output.id);
  numerics = { boundaryProfileId: boundary.id, meshProfileId: mesh.id, solverProfileId: solver.id, outputProfileId: output.id };
});

afterAll(async () => {
  // Order matters: results → campaigns (cascades campaign tables) → presets
  // (cascades revisions) → legacy bcs → registries → airfoils/category/medium.
  if (cleanupResultIds.length) await db.delete(results).where(inArray(results.id, cleanupResultIds));
  await db.execute(sql`
    DELETE FROM results r
    USING sim_campaign_points p
    WHERE p.campaign_id = ANY(${`{${cleanupCampaignIds.join(",")}}`}::uuid[])
      AND r.airfoil_id = p.airfoil_id AND r.simulation_preset_revision_id = p.revision_id AND r.aoa_deg = p.aoa_deg
  `);
  if (cleanupCampaignIds.length) await db.delete(simCampaigns).where(inArray(simCampaigns.id, cleanupCampaignIds));
  const campaignPresets = await db
    .select({ id: simulationPresets.id, legacyId: simulationPresets.legacyBoundaryConditionId })
    .from(simulationPresets)
    .where(like(simulationPresets.slug, "campaign-pw-camp-%"));
  if (campaignPresets.length) {
    await db.delete(simulationPresets).where(inArray(simulationPresets.id, campaignPresets.map((p) => p.id)));
    const legacyIds = campaignPresets.map((p) => p.legacyId).filter((x): x is string => Boolean(x));
    if (legacyIds.length) await db.delete(boundaryConditions).where(inArray(boundaryConditions.id, legacyIds));
  }
  await db.delete(sweepDefinitions).where(like(sweepDefinitions.slug, "campaign-pw-camp-%"));
  await db.delete(flowConditions).where(eq(flowConditions.mediumId, mediumId));
  await db.execute(sql`
    DELETE FROM reference_geometry_profiles
    WHERE origin = 'campaign' AND created_by_campaign_id IS NULL AND slug LIKE 'chord-0-2000m-span-1-0000m%'
  `);
  await db.execute(sql`DELETE FROM reference_geometry_profiles WHERE slug LIKE 'chord-0-4000m-span-1-0000m%' AND origin = 'campaign'`);
  if (cleanupProfileIds.boundary.length) await db.delete(boundaryProfiles).where(inArray(boundaryProfiles.id, cleanupProfileIds.boundary));
  if (cleanupProfileIds.mesh.length) await db.delete(meshProfiles).where(inArray(meshProfiles.id, cleanupProfileIds.mesh));
  if (cleanupProfileIds.solver.length) await db.delete(solverProfiles).where(inArray(solverProfiles.id, cleanupProfileIds.solver));
  if (cleanupProfileIds.output.length) await db.delete(outputProfiles).where(inArray(outputProfiles.id, cleanupProfileIds.output));
  if (cleanupAirfoilIds.length) await db.delete(airfoils).where(inArray(airfoils.id, cleanupAirfoilIds));
  if (cleanupCategoryIds.length) await db.delete(categories).where(inArray(categories.id, cleanupCategoryIds));
  if (cleanupMediumIds.length) await db.delete(mediums).where(inArray(mediums.id, cleanupMediumIds));
  await app.close();
  await pgClient.end();
});

describe("campaign launch (§5)", () => {
  let campaignId = "";
  let conditionIds: string[] = [];

  it("launches, materializes conditions/points/lanes, and bridges legacy bcId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} launch`,
        priority: 5,
        idempotencyKey: `${PREFIX}-key-1`,
        airfoilIds: [asymId, symId],
        plan: planBody(),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    campaignId = body.campaign.id;
    cleanupCampaignIds.push(campaignId);
    expect(body.replayed).toBe(false);
    expect(body.conditionCount).toBe(2);
    // 5 angles × 2 airfoils × 2 conditions = 20 obligated points.
    expect(body.totals.requested).toBe(20);
    expect(body.totals.remaining).toBe(20);

    const conditions = (await db.execute(sql`
      SELECT id, preset_id, simulation_preset_revision_id FROM sim_campaign_conditions WHERE campaign_id = ${campaignId} ORDER BY ord
    `)) as unknown as Array<{ id: string; preset_id: string; simulation_preset_revision_id: string }>;
    expect(conditions.length).toBe(2);
    conditionIds = conditions.map((c) => c.id);

    // Symmetric airfoil: derived rows on the negative side only.
    const [derivedCount] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM sim_campaign_points WHERE campaign_id = ${campaignId} AND derived_by_symmetry
    `)) as unknown as Array<{ n: number }>;
    expect(Number(derivedCount.n)).toBe(4); // angles -2,-1 × 2 conditions
    const [symNegativeSolver] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM sim_campaign_points
      WHERE campaign_id = ${campaignId} AND airfoil_id = ${symId} AND aoa_deg < 0 AND NOT derived_by_symmetry
    `)) as unknown as Array<{ n: number }>;
    expect(Number(symNegativeSolver.n)).toBe(0);

    // §3.3: every preset used has a legacy boundary_conditions bridge row.
    const presets = await db
      .select()
      .from(simulationPresets)
      .where(inArray(simulationPresets.id, conditions.map((c) => c.preset_id)));
    expect(presets.length).toBe(2);
    for (const preset of presets) {
      expect(preset.origin).toBe("campaign");
      expect(preset.enabled).toBe(false);
      expect(preset.legacyBoundaryConditionId).toBeTruthy();
    }
    // Canonical physics election on the pinned revisions.
    const revisions = await db
      .select()
      .from(simulationPresetRevisions)
      .where(inArray(simulationPresetRevisions.id, conditions.map((c) => c.simulation_preset_revision_id)));
    for (const revision of revisions) {
      expect(revision.physicsHash).toBeTruthy();
      expect(revision.isCanonicalPhysics).toBe(true);
    }

    // Lanes: symmetric cl_zero lanes are symmetric_definition.
    const lanes = (await db.execute(sql`
      SELECT airfoil_id, objective, state FROM sim_campaign_lanes WHERE campaign_id = ${campaignId}
    `)) as unknown as Array<{ airfoil_id: string; objective: string; state: string }>;
    expect(lanes.length).toBe(8); // 2 airfoils × 2 conditions × 2 objectives
    for (const lane of lanes) {
      if (lane.objective === "cl_zero" && lane.airfoil_id === symId) expect(lane.state).toBe("symmetric_definition");
      else expect(lane.state).toBe("awaiting_seed");
    }
  });

  it("replays idempotently (double POST → one campaign, 200)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} launch replayed`,
        priority: 5,
        idempotencyKey: `${PREFIX}-key-1`,
        airfoilIds: [asymId, symId],
        plan: planBody(),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().replayed).toBe(true);
    expect(res.json().campaign.id).toBe(campaignId);
    const rows = await db.select({ id: simCampaigns.id }).from(simCampaigns).where(eq(simCampaigns.idempotencyKey, `${PREFIX}-key-1`));
    expect(rows.length).toBe(1);
  });

  it("reuses physics-hash revisions across campaigns (no duplicate presets)", async () => {
    const [presetCountBefore] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM simulation_presets WHERE origin = 'campaign' AND slug LIKE 'campaign-pw-camp-%'`,
    )) as unknown as Array<{ n: number }>;
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} second`,
        priority: 5,
        idempotencyKey: `${PREFIX}-key-2`,
        airfoilIds: [asymId],
        plan: planBody(),
      },
    });
    expect(res.statusCode).toBe(201);
    const secondId = res.json().campaign.id as string;
    cleanupCampaignIds.push(secondId);
    const [presetCountAfter] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM simulation_presets WHERE origin = 'campaign' AND slug LIKE 'campaign-pw-camp-%'`,
    )) as unknown as Array<{ n: number }>;
    expect(Number(presetCountAfter.n)).toBe(Number(presetCountBefore.n));
    const firstRevisions = (await db.execute(sql`
      SELECT simulation_preset_revision_id FROM sim_campaign_conditions WHERE campaign_id = ${campaignId} ORDER BY ord
    `)) as unknown as Array<{ simulation_preset_revision_id: string }>;
    const secondRevisions = (await db.execute(sql`
      SELECT simulation_preset_revision_id FROM sim_campaign_conditions WHERE campaign_id = ${secondId} ORDER BY ord
    `)) as unknown as Array<{ simulation_preset_revision_id: string }>;
    expect(secondRevisions.map((r) => r.simulation_preset_revision_id)).toEqual(firstRevisions.map((r) => r.simulation_preset_revision_id));
  });

  it("previews reuse read-only with real counts", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns/preview",
      payload: { plan: planBody(), airfoilIds: [asymId, symId] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.totalPoints).toBe(20);
    // Solver runs: cambered 5 angles + symmetric 3 (α ≥ 0) per condition.
    expect(body.totalSolverRuns).toBe(16);
    expect(body.conditions.length).toBe(2);
    expect(body.conditions.every((c: { revisionId: string | null }) => c.revisionId != null)).toBe(true);
  });

  it("returns the bounded summary with scheduler + suppressed rate", async () => {
    const res = await app.inject({ method: "GET", url: `/api/admin/campaigns/${campaignId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.campaign.status).toBe("active");
    expect(body.conditions.length).toBe(2);
    expect(body.totals.requested).toBe(20);
    expect(body.scheduler).toHaveProperty("sweeperEnabled");
    expect(body.scheduler).toHaveProperty("campaignJobsRunning");
    expect(body.rate).toBeNull(); // <50 measured points → suppressed (spec §12)
    const matrix = await app.inject({ method: "GET", url: `/api/admin/campaigns/${campaignId}/airfoils?limit=10` });
    expect(matrix.statusCode).toBe(200);
    expect(matrix.json().items.length).toBe(2);
  });

  describe("plan editing + closure (§6)", () => {
    let baseRevision = 1;
    let diffHash = "";

    it("classifies a removed condition with evidence as kept, without as released", async () => {
      // Land real evidence on the chord 0.2 condition at α = +1.
      const conditions = (await db.execute(sql`
        SELECT cc.id, cc.simulation_preset_revision_id AS revision_id, p.legacy_boundary_condition_id AS bc_id,
               (rev.snapshot->'referenceGeometry'->>'referenceLengthM')::float8 AS chord
        FROM sim_campaign_conditions cc
        JOIN simulation_presets p ON p.id = cc.preset_id
        JOIN simulation_preset_revisions rev ON rev.id = cc.simulation_preset_revision_id
        WHERE cc.campaign_id = ${campaignId}
      `)) as unknown as Array<{ id: string; revision_id: string; bc_id: string; chord: number }>;
      const cond02 = conditions.find((c) => Math.abs(c.chord - 0.2) < 1e-9)!;
      expect(cond02).toBeTruthy();
      const [solved] = await db
        .insert(results)
        .values({
          airfoilId: asymId,
          bcId: cond02.bc_id,
          simulationPresetRevisionId: cond02.revision_id,
          aoaDeg: 1,
          status: "done",
          source: "solved",
          cl: 0.5,
          cd: 0.01,
        })
        .returning({ id: results.id });
      cleanupResultIds.push(solved.id);

      const preview = await app.inject({
        method: "POST",
        url: `/api/admin/campaigns/${campaignId}/plan/preview`,
        payload: { plan: planBody({ chordsM: [0.4] }), basePlanRevisionNumber: baseRevision },
      });
      expect(preview.statusCode).toBe(200);
      const diff = preview.json();
      expect(diff.keptConditions.length).toBe(1);
      expect(diff.keptConditions[0].conditionId).toBe(cond02.id);
      expect(diff.keptConditions[0].solvedAngles).toEqual([1]);
      expect(diff.releasedConditions.length).toBe(0);
      // Kept cells: cambered@+1, symmetric@+1, symmetric derived@−1 → 3 stay,
      // the other 7 of the condition's 10 points are released.
      expect(diff.keptConditions[0].keptOpenPoints).toBe(3);
      expect(diff.keptConditions[0].releasedPoints).toBe(7);
      expect(diff.cancelledPoints).toBe(7);
      diffHash = diff.diffHash;
    });

    it("rejects apply on stale base revision with 409", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/campaigns/${campaignId}/plan/apply`,
        payload: { plan: planBody({ chordsM: [0.4] }), basePlanRevisionNumber: 99, diffHash },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("conflict");
    });

    it("applies the acknowledged diff atomically", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/campaigns/${campaignId}/plan/apply`,
        payload: { plan: planBody({ chordsM: [0.4] }), basePlanRevisionNumber: baseRevision, diffHash },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("applied");
      expect(body.planRevisionNumber).toBe(2);
      baseRevision = 2;
      const [keptCond] = (await db.execute(sql`
        SELECT status FROM sim_campaign_conditions cc
        JOIN simulation_preset_revisions rev ON rev.id = cc.simulation_preset_revision_id
        WHERE cc.campaign_id = ${campaignId} AND (rev.snapshot->'referenceGeometry'->>'referenceLengthM')::float8 = 0.2
      `)) as unknown as Array<{ status: string }>;
      expect(keptCond.status).toBe("kept");
      const [releasedPoints] = (await db.execute(sql`
        SELECT count(*)::int AS n FROM sim_campaign_points WHERE campaign_id = ${campaignId} AND state = 'released'
      `)) as unknown as Array<{ n: number }>;
      expect(Number(releasedPoints.n)).toBe(7);
    });

    it("force-releases a kept condition with exact-count verification", async () => {
      const [keptCond] = (await db.execute(sql`
        SELECT cc.id FROM sim_campaign_conditions cc WHERE cc.campaign_id = ${campaignId} AND cc.status = 'kept'
      `)) as unknown as Array<{ id: string }>;
      const drift = await app.inject({
        method: "POST",
        url: `/api/admin/campaigns/${campaignId}/conditions/${keptCond.id}/force-release`,
        payload: { expectedCancelledPoints: 99 },
      });
      expect(drift.statusCode).toBe(409);
      expect(drift.json().code).toBe("drift");
      const ok = await app.inject({
        method: "POST",
        url: `/api/admin/campaigns/${campaignId}/conditions/${keptCond.id}/force-release`,
        payload: { expectedCancelledPoints: 2 },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().cancelledPoints).toBe(2);
      baseRevision = 3;
      const [cond] = (await db.execute(
        sql`SELECT status FROM sim_campaign_conditions WHERE id = ${keptCond.id}`,
      )) as unknown as Array<{ status: string }>;
      expect(cond.status).toBe("released");
    });

    it("verifies requeue-failed drift protection", async () => {
      const drift = await app.inject({
        method: "POST",
        url: `/api/admin/campaigns/${campaignId}/requeue-failed`,
        payload: { expectedCount: 5 },
      });
      expect(drift.statusCode).toBe(409);
      const ok = await app.inject({
        method: "POST",
        url: `/api/admin/campaigns/${campaignId}/requeue-failed`,
        payload: { expectedCount: 0 },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().requeued).toBe(0);
    });

    it("pauses, resumes, and cancels with real counts", async () => {
      const pause = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaignId}/pause` });
      expect(pause.statusCode).toBe(200);
      expect(pause.json().campaign.status).toBe("paused");
      const resume = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaignId}/resume` });
      expect(resume.statusCode).toBe(200);
      const cancel = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaignId}/cancel` });
      expect(cancel.statusCode).toBe(200);
      const body = cancel.json();
      expect(body.campaign.status).toBe("cancelled");
      // Evidence retained; presets referenced by conditions are NOT GC'd.
      const [presetCount] = (await db.execute(sql`
        SELECT count(*)::int AS n FROM sim_campaign_conditions cc JOIN simulation_presets p ON p.id = cc.preset_id
        WHERE cc.campaign_id = ${campaignId}
      `)) as unknown as Array<{ n: number }>;
      expect(Number(presetCount.n)).toBe(2);
      const solvedStill = await db
        .select({ id: results.id })
        .from(results)
        .where(and(eq(results.airfoilId, asymId), eq(results.status, "done")));
      expect(solvedStill.length).toBeGreaterThan(0);
    });
  });

  it("duplicate returns a prefill payload without creating anything", async () => {
    const before = await db.select({ id: simCampaigns.id }).from(simCampaigns);
    const res = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaignId}/duplicate` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toContain("copy");
    expect(body.plan.mediumId).toBe(mediumId);
    expect(body.airfoilIds.sort()).toEqual([asymId, symId].sort());
    const after = await db.select({ id: simCampaigns.id }).from(simCampaigns);
    expect(after.length).toBe(before.length);
  });
});

describe("auth hardening (§10)", () => {
  it("requires admin for campaign routes, PATCH /api/sweeper, and GET /api/sim-jobs in prod mode", async () => {
    process.env.ADMIN_AUTH_REQUIRED = "true";
    try {
      const campaignList = await app.inject({ method: "GET", url: "/api/admin/campaigns" });
      expect(campaignList.statusCode).toBe(401);
      const launch = await app.inject({ method: "POST", url: "/api/admin/campaigns", payload: {} });
      expect(launch.statusCode).toBe(401);
      const sweeperPatch = await app.inject({ method: "PATCH", url: "/api/sweeper", payload: { enabled: false } });
      expect(sweeperPatch.statusCode).toBe(401);
      const simJobs = await app.inject({ method: "GET", url: "/api/sim-jobs" });
      expect(simJobs.statusCode).toBe(401);
      // Public status read stays open (no campaign metadata in it).
      const sweeperGet = await app.inject({ method: "GET", url: "/api/sweeper" });
      expect(sweeperGet.statusCode).toBe(200);
    } finally {
      delete process.env.ADMIN_AUTH_REQUIRED;
    }
  });
});
