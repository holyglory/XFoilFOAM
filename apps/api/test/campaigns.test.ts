// Campaign API integration tests (spec §13): launch idempotency, physics-hash
// revision reuse, legacy bcId bridge, symmetric point planning, reuse preview,
// closure classification (kept vs released), force-release drift checks,
// lifecycle verbs, and the §10 auth hardening.
import { type Point } from "@aerodb/core";
import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  campaignFailures,
  campaignProgressTotals,
  campaignRejected,
  categories,
  closeCampaignWithFailures,
  deriveCampaignCompletion,
  flowConditions,
  forceHistory,
  mediums,
  meshProfiles,
  onResultIngested,
  outputProfiles,
  probeCampaignCompletion,
  recomputeCampaignProgress,
  referenceGeometryProfiles,
  refreshPolarCacheForRevision,
  requeueCampaignFailed,
  resultAttempts,
  resultClassifications,
  resultMedia,
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

// Regression guard for the counter/failures/requeue drift found on the first
// production campaign (validation-campaign-20260705): two recompute paths and
// the failures/requeue queries disagreed on what a FAILED point is. A failed
// campaign point is TERMINAL with its results row status='failed' — NOT
// state='requested'. The whole solved/failed/attention/requeue cycle below is
// the must-catch shape of that real breakage.
describe("counter/failures/requeue coherence (production drift regression)", () => {
  let campaignId = "";
  let conditionId = "";
  let revisionId = "";
  let bcId = "";
  // Dedicated airfoil + a unique speed so this campaign's physics hash (and thus
  // its pinned revision) is unique — no pre-solved evidence from the other tests
  // can terminal-link my points at launch, keeping the counts deterministic.
  let driftAirfoilId = "";
  const DRIFT_SPEED = 13.5;

  beforeAll(async () => {
    const [af] = await db
      .insert(airfoils)
      .values({ slug: `${PREFIX}-drift-af`, name: `${PREFIX} drift af`, categoryId: cleanupCategoryIds[0], points: camberedPoints, isSymmetric: false })
      .returning();
    driftAirfoilId = af.id;
    cleanupAirfoilIds.push(af.id);
  });

  // One cambered (asymmetric) airfoil, single chord, single α-list -2..2 so the
  // obligation is exactly 5 points on one condition — small enough to drive by
  // hand into done / failed / requested and assert precise counts.
  it("seeds a one-condition campaign and drives points to done/failed/requested", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} drift`,
        priority: 5,
        idempotencyKey: `${PREFIX}-drift-key`,
        airfoilIds: [driftAirfoilId],
        plan: planBody({ chordsM: [0.2], speedsMps: [DRIFT_SPEED], objectives: { ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 }, clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 } } }),
      },
    });
    expect(res.statusCode).toBe(201);
    campaignId = res.json().campaign.id;
    cleanupCampaignIds.push(campaignId);
    // 5 angles × 1 airfoil × 1 condition = 5 obligated points, all open.
    expect(res.json().totals.requested).toBe(5);
    expect(res.json().totals.remaining).toBe(5);

    const [cond] = (await db.execute(sql`
      SELECT cc.id, cc.simulation_preset_revision_id AS revision_id, p.legacy_boundary_condition_id AS bc_id
      FROM sim_campaign_conditions cc
      JOIN simulation_presets p ON p.id = cc.preset_id
      WHERE cc.campaign_id = ${campaignId}
    `)) as unknown as Array<{ id: string; revision_id: string; bc_id: string }>;
    conditionId = cond.id;
    revisionId = cond.revision_id;
    bcId = cond.bc_id;

    // α=+2 → DONE (a genuine solved solver cell).
    const [doneRow] = await db
      .insert(results)
      .values({ airfoilId: driftAirfoilId, bcId, simulationPresetRevisionId: revisionId, aoaDeg: 2, status: "done", source: "solved", regime: "rans", converged: true, stalled: false, cl: 0.6, cd: 0.012, cm: -0.02 })
      .returning({ id: results.id });
    cleanupResultIds.push(doneRow.id);
    await onResultIngested(db, { airfoilId: driftAirfoilId, revisionId, aoaDeg: 2, resultId: doneRow.id, status: "done" });

    // α=0 → FAILED, ingested exactly as the engine reports it: the point goes
    // TERMINAL linked to a results row at status='failed' (the URANS-no-shedding
    // degenerate path from the live campaign).
    const [failRow] = await db
      .insert(results)
      .values({ airfoilId: driftAirfoilId, bcId, simulationPresetRevisionId: revisionId, aoaDeg: 0, status: "failed", source: "solved", error: "OpenFOAMError: URANS transient produced no coefficient.dat" })
      .returning({ id: results.id });
    cleanupResultIds.push(failRow.id);
    await onResultIngested(db, { airfoilId: driftAirfoilId, revisionId, aoaDeg: 0, resultId: failRow.id, status: "failed" });

    // Ground-truth DB shape: the failed point is terminal + failed, NOT requested.
    const [failPoint] = (await db.execute(sql`
      SELECT p.state, r.status
      FROM sim_campaign_points p JOIN results r ON r.id = p.result_id
      WHERE p.campaign_id = ${campaignId} AND p.aoa_deg = 0
    `)) as unknown as Array<{ state: string; status: string }>;
    expect(failPoint.state).toBe("terminal");
    expect(failPoint.status).toBe("failed");
    // α=-2,-1,+1 remain open (state='requested').
    const [open] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM sim_campaign_points WHERE campaign_id = ${campaignId} AND state = 'requested'
    `)) as unknown as Array<{ n: number }>;
    expect(Number(open.n)).toBe(3);
  });

  it("recomputeCampaignProgress counts solved=done-only and failed=terminal-failed (not the reverse)", async () => {
    // The whole-campaign recompute (launch/plan-edit path) must agree with the
    // incremental ingest path: solved excludes the failure, failed sees it.
    await db.transaction(async (tx) => {
      await recomputeCampaignProgress(tx, campaignId);
    });
    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals.requested).toBe(5); // total obligation, the UI denominator
    expect(totals.solved).toBe(1); // only α=+2 done — the failure is NOT absorbed
    expect(totals.failed).toBe(1); // α=0 terminal-failed — NOT silently 0
    expect(totals.derived).toBe(0);
    // remaining = requested - solved - derived - failed = 5-1-0-1 = 3 open.
    expect(totals.remaining).toBe(3);
  });

  it("campaignFailures finds the terminal-failed point with the right error class", async () => {
    const failures = await campaignFailures(db, campaignId);
    expect(failures.total).toBe(1); // the live monitor saw total:0 here — the bug
    expect(failures.groups.length).toBe(1);
    const group = failures.groups[0];
    expect(group.errorClass).toBe("solver"); // "URANS transient produced no coefficient.dat"
    expect(group.count).toBe(1);
    expect(group.samples[0].aoaDeg).toBe(0);
    expect(group.samples[0].resultId).toBeTruthy();
  });

  it("resolves to attention (not completed) once every obligated point is terminal with failed>0", async () => {
    // Solve the three remaining open points so the campaign is fully settled
    // with exactly one failure — the completion state must be 'attention'.
    for (const aoa of [-2, -1, 1]) {
      const [row] = await db
        .insert(results)
        .values({ airfoilId: driftAirfoilId, bcId, simulationPresetRevisionId: revisionId, aoaDeg: aoa, status: "done", source: "solved", regime: "rans", converged: true, stalled: false, cl: 0.1 * aoa, cd: 0.011, cm: -0.02 })
        .returning({ id: results.id });
      cleanupResultIds.push(row.id);
      await onResultIngested(db, { airfoilId: driftAirfoilId, revisionId, aoaDeg: aoa, resultId: row.id, status: "done" });
    }
    // The ingest-time probe blocks on done-but-unclassified evidence
    // (awaiting_verdict); the sweeper refreshes classifications and re-probes
    // right after ingest — mirror that pipeline here.
    await refreshPolarCacheForRevision(db, driftAirfoilId, revisionId);
    await probeCampaignCompletion(db, campaignId);
    await db.transaction(async (tx) => {
      await recomputeCampaignProgress(tx, campaignId);
    });
    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals.solved).toBe(4);
    expect(totals.failed).toBe(1);
    expect(totals.remaining).toBe(0);
    expect(deriveCampaignCompletion(totals)).toBe("attention");
    // The post-refresh completion probe drove the live campaign row the same way.
    const [camp] = (await db.execute(
      sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`,
    )) as unknown as Array<{ status: string }>;
    expect(camp.status).toBe("attention");
  });

  it("requeueCampaignFailed flips the terminal-failed point back to requested + pending, then finds zero", async () => {
    // Drift guard still holds: wrong expectedCount → 409-class error.
    await expect(requeueCampaignFailed(db, campaignId, { expectedCount: 5 })).rejects.toMatchObject({ code: "drift" });

    const out = await requeueCampaignFailed(db, campaignId, { expectedCount: 1 });
    expect(out.requeued).toBe(1);

    // The point is re-claimable: state back to 'requested', result back to 'pending'.
    const [point] = (await db.execute(sql`
      SELECT p.state, r.status
      FROM sim_campaign_points p JOIN results r ON r.id = p.result_id
      WHERE p.campaign_id = ${campaignId} AND p.aoa_deg = 0
    `)) as unknown as Array<{ state: string; status: string }>;
    expect(point.state).toBe("requested");
    expect(point.status).toBe("pending");

    // A second failures read now returns zero — nothing failed remains.
    const after = await campaignFailures(db, campaignId);
    expect(after.total).toBe(0);
    // Reopening a settled campaign drops it out of attention back to active.
    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals.failed).toBe(0);
    expect(totals.remaining).toBe(1);
    expect(out.totals.remaining).toBe(1);
  });
});

describe("rejected-classification honesty + premature-completion guard (D6)", () => {
  let campaignId = "";
  let revisionId = "";
  let bcId = "";
  let rejAirfoilId = "";
  let uransResultId = "";
  let aoa1ResultId = "";
  const REJ_SPEED = 14.5; // unique physics hash → isolated pinned revision

  beforeAll(async () => {
    const [af] = await db
      .insert(airfoils)
      .values({ slug: `${PREFIX}-rej-af`, name: `${PREFIX} rej af`, categoryId: cleanupCategoryIds[0], points: camberedPoints, isSymmetric: false })
      .returning();
    rejAirfoilId = af.id;
    cleanupAirfoilIds.push(af.id);
  });

  it("books a physics-REJECTED done point as rejected (not solved) and resolves to attention", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} rejected`,
        priority: 5,
        idempotencyKey: `${PREFIX}-rej-key`,
        airfoilIds: [rejAirfoilId],
        plan: planBody({ chordsM: [0.2], speedsMps: [REJ_SPEED], objectives: { ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 }, clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 } } }),
      },
    });
    expect(res.statusCode).toBe(201);
    campaignId = res.json().campaign.id;
    cleanupCampaignIds.push(campaignId);
    expect(res.json().totals.requested).toBe(5);

    const [cond] = (await db.execute(sql`
      SELECT cc.simulation_preset_revision_id AS revision_id, p.legacy_boundary_condition_id AS bc_id
      FROM sim_campaign_conditions cc JOIN simulation_presets p ON p.id = cc.preset_id
      WHERE cc.campaign_id = ${campaignId}
    `)) as unknown as Array<{ revision_id: string; bc_id: string }>;
    revisionId = cond.revision_id;
    bcId = cond.bc_id;

    // α=-2,-1,1,2 → clean accepted RANS evidence.
    for (const aoa of [-2, -1, 1, 2]) {
      const [row] = await db
        .insert(results)
        .values({
          airfoilId: rejAirfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: aoa,
          status: "done",
          source: "solved",
          regime: "rans",
          converged: true,
          stalled: false,
          cl: 0.3 + 0.1 * aoa,
          cd: 0.011,
          cm: -0.02,
        })
        .returning({ id: results.id });
      cleanupResultIds.push(row.id);
      if (aoa === 1) aoa1ResultId = row.id;
      await onResultIngested(db, { airfoilId: rejAirfoilId, revisionId, aoaDeg: aoa, resultId: row.id, status: "done" });
    }

    // α=0 → EXACT ingest-shaped URANS row (stalled=true because unsteady,
    // converged) but WITHOUT force history / video: evidence-first honesty
    // must classify it rejected.
    const [urans] = await db
      .insert(results)
      .values({
        airfoilId: rejAirfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 0,
        status: "done",
        source: "solved",
        regime: "urans",
        unsteady: true,
        stalled: true,
        converged: true,
        cl: 0.35,
        cd: 0.02,
        cm: -0.02,
      })
      .returning({ id: results.id });
    uransResultId = urans.id;
    cleanupResultIds.push(urans.id);
    await onResultIngested(db, { airfoilId: rejAirfoilId, revisionId, aoaDeg: 0, resultId: urans.id, status: "done" });

    // The ingest-time probe fired BEFORE any classification exists: the
    // campaign must NOT book completed on unjudged evidence (awaiting_verdict).
    const [preVerdict] = (await db.execute(sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`)) as unknown as Array<{ status: string }>;
    expect(preVerdict.status).toBe("active");

    // Classify (the sweeper does this right after ingest), recompute, settle.
    await refreshPolarCacheForRevision(db, rejAirfoilId, revisionId);
    const [rc] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, urans.id));
    expect(rc?.state).toBe("rejected");
    expect(rc?.reasons).toContain("missing-force-history");
    expect(rc?.reasons).toContain("missing-urans-video");
    expect(rc?.reasons).not.toContain("solver-stalled"); // aerodynamic marker, not a solver defect

    await db.transaction(async (tx) => {
      await recomputeCampaignProgress(tx, campaignId);
    });
    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals.requested).toBe(5);
    expect(totals.solved).toBe(4); // the rejected point is NOT solved work
    expect(totals.rejected).toBe(1);
    expect(totals.failed).toBe(0);
    expect(totals.remaining).toBe(0); // settled — but not clean
    expect(deriveCampaignCompletion(totals)).toBe("attention");

    await probeCampaignCompletion(db, campaignId);
    const [camp] = (await db.execute(sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`)) as unknown as Array<{ status: string }>;
    expect(camp.status).toBe("attention");
  });

  it("close-with-failures records the rejected count too (honest close record, F2)", async () => {
    // The attention state above is driven by 1 REJECTED point and 0 failed:
    // the close record must say so instead of booking "0 failed points".
    const out = await closeCampaignWithFailures(db, campaignId);
    expect(out.closedWithFailedCount).toBe(0);
    expect(out.closedWithRejectedCount).toBe(1);
    expect(out.campaign.closedWithFailedCount).toBe(0);
    expect(out.campaign.closedWithRejectedCount).toBe(1);
    expect(out.campaign.status).toBe("completed");
    // Restore the pre-close state so the wave-2 window test below is unaffected.
    await db
      .update(simCampaigns)
      .set({ status: "attention", closedWithFailedCount: null, closedWithRejectedCount: null, completedAt: null })
      .where(eq(simCampaigns.id, campaignId));
  });

  it("blocks completion while a terminal point's cell result is re-solving (wave-2 window)", async () => {
    await db.update(simCampaigns).set({ status: "active" }).where(eq(simCampaigns.id, campaignId));
    // Simulate the wave-2 child claim: point stays terminal, cell row queued.
    await db.update(results).set({ status: "queued", source: "queued" }).where(eq(results.id, aoa1ResultId));
    await probeCampaignCompletion(db, campaignId);
    const [during] = (await db.execute(sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`)) as unknown as Array<{ status: string }>;
    expect(during.status).toBe("active"); // in-flight guard: NOT completed/attention

    // A LOST wave-2 job resets the cell row to 'pending' (reconcile's
    // requeueLostJob) — still re-solve intent, so the probe must keep
    // blocking; the sweeper re-claims pending rows, so no deadlock.
    await db.update(results).set({ status: "pending", source: "queued" }).where(eq(results.id, aoa1ResultId));
    await probeCampaignCompletion(db, campaignId);
    const [pendingProbe] = (await db.execute(sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`)) as unknown as Array<{ status: string }>;
    expect(pendingProbe.status).toBe("active"); // lost-job window: NOT completed/attention

    // 'stale' cell rows on a terminal point are re-solve intent too.
    await db.update(results).set({ status: "stale", source: "queued" }).where(eq(results.id, aoa1ResultId));
    await probeCampaignCompletion(db, campaignId);
    const [staleProbe] = (await db.execute(sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`)) as unknown as Array<{ status: string }>;
    expect(staleProbe.status).toBe("active");

    await db.update(results).set({ status: "done", source: "solved" }).where(eq(results.id, aoa1ResultId));
    await probeCampaignCompletion(db, campaignId);
    const [after] = (await db.execute(sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`)) as unknown as Array<{ status: string }>;
    expect(after.status).toBe("attention"); // rejected>0 still needs review
  });

  it("accepted URANS evidence supersedes the RANS classification and clears the rejection (D3 unlock)", async () => {
    // Backfill the missing URANS evidence: force history + instantaneous video.
    await db.insert(forceHistory).values({
      resultId: uransResultId,
      t: [0, 0.1, 0.2, 0.3],
      cl: [0.33, 0.37, 0.35, 0.36],
      cd: [0.019, 0.021, 0.02, 0.02],
      cm: [-0.02, -0.02, -0.02, -0.02],
    });
    await db.insert(resultMedia).values({
      resultId: uransResultId,
      kind: "video",
      field: "velocity_magnitude",
      role: "instantaneous",
      storageKey: `jobs/${PREFIX}-rej/cases/c0/velocity_magnitude.mp4`,
      mimeType: "video/mp4",
    });
    // A prior RANS attempt at the same angle (the evidence the URANS replaced).
    const [attempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: uransResultId,
        airfoilId: rejAirfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 0,
        status: "done",
        source: "solved",
        regime: "rans",
        converged: true,
        stalled: false,
        cl: 0.34,
        cd: 0.018,
        cm: -0.02,
      })
      .returning({ id: resultAttempts.id });

    await refreshPolarCacheForRevision(db, rejAirfoilId, revisionId);

    // The ingest-shaped URANS row now classifies ACCEPTED end-to-end vs the DB…
    const [rc] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, uransResultId));
    expect(rc?.state).toBe("accepted");
    // …and supersedeRansWithAcceptedUrans is no longer dead code: the RANS
    // attempt's classification flips to superseded_by_urans.
    const [attemptRc] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultAttemptId, attempt.id));
    expect(attemptRc?.state).toBe("superseded_by_urans");
    expect(attemptRc?.reasons).toContain("urans-replacement");

    // Counters clear: no rejected work left, the campaign may book completed.
    await db.transaction(async (tx) => {
      await recomputeCampaignProgress(tx, campaignId);
    });
    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals.rejected).toBe(0);
    expect(totals.solved).toBe(5);
    expect(deriveCampaignCompletion(totals)).toBe("completed");

    await db.update(simCampaigns).set({ status: "active" }).where(eq(simCampaigns.id, campaignId));
    await probeCampaignCompletion(db, campaignId);
    const [camp] = (await db.execute(sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`)) as unknown as Array<{ status: string }>;
    expect(camp.status).toBe("completed");
  });
});

// Must-catch mirror of the counter/failures/requeue coherence suite for the
// REJECTED bucket (live campaign 592d40c6, 2026-07-05: 4 done-but-physics-
// rejected points had NO repair affordance — re-solving them needed manual
// SQL). A rejected campaign point is TERMINAL with its results row DONE and
// its classification 'rejected'; the dialog count (campaignRejected), the
// counters, and requeueCampaignFailed(includeRejected) must all match on that
// model, and a failed-only requeue must NEVER touch rejected evidence.
describe("rejected requeue coherence (engine-fix re-solve path)", () => {
  let campaignId = "";
  let conditionId = "";
  let revisionId = "";
  let bcId = "";
  let rqAirfoilId = "";
  let rejectedResultId = "";
  let ransResultId = "";
  const RQ_SPEED = 15.5; // unique physics hash → isolated pinned revision

  beforeAll(async () => {
    const [af] = await db
      .insert(airfoils)
      .values({ slug: `${PREFIX}-rq-af`, name: `${PREFIX} rq af`, categoryId: cleanupCategoryIds[0], points: camberedPoints, isSymmetric: false })
      .returning();
    rqAirfoilId = af.id;
    cleanupAirfoilIds.push(af.id);
  });

  it("drives a campaign to 4 accepted + 1 rejected and the dialog data sees exactly that", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} rq`,
        priority: 5,
        idempotencyKey: `${PREFIX}-rq-key`,
        airfoilIds: [rqAirfoilId],
        plan: planBody({ chordsM: [0.2], speedsMps: [RQ_SPEED], objectives: { ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 }, clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 } } }),
      },
    });
    expect(res.statusCode).toBe(201);
    campaignId = res.json().campaign.id;
    cleanupCampaignIds.push(campaignId);

    const [cond] = (await db.execute(sql`
      SELECT cc.id, cc.simulation_preset_revision_id AS revision_id, p.legacy_boundary_condition_id AS bc_id
      FROM sim_campaign_conditions cc JOIN simulation_presets p ON p.id = cc.preset_id
      WHERE cc.campaign_id = ${campaignId}
    `)) as unknown as Array<{ id: string; revision_id: string; bc_id: string }>;
    conditionId = cond.id;
    revisionId = cond.revision_id;
    bcId = cond.bc_id;

    // α=-2,-1,1,2 → clean accepted RANS evidence (α=1 kept for the regime test).
    for (const aoa of [-2, -1, 1, 2]) {
      const [row] = await db
        .insert(results)
        .values({ airfoilId: rqAirfoilId, bcId, simulationPresetRevisionId: revisionId, aoaDeg: aoa, status: "done", source: "solved", regime: "rans", converged: true, stalled: false, cl: 0.3 + 0.1 * aoa, cd: 0.011, cm: -0.02 })
        .returning({ id: results.id });
      cleanupResultIds.push(row.id);
      if (aoa === 1) ransResultId = row.id;
      await onResultIngested(db, { airfoilId: rqAirfoilId, revisionId, aoaDeg: aoa, resultId: row.id, status: "done" });
    }
    // α=0 → ingest-shaped URANS done WITHOUT force history / video → rejected.
    const [urans] = await db
      .insert(results)
      .values({ airfoilId: rqAirfoilId, bcId, simulationPresetRevisionId: revisionId, aoaDeg: 0, status: "done", source: "solved", regime: "urans", unsteady: true, stalled: true, converged: true, cl: 0.35, cd: 0.02, cm: -0.02 })
      .returning({ id: results.id });
    rejectedResultId = urans.id;
    cleanupResultIds.push(urans.id);
    await onResultIngested(db, { airfoilId: rqAirfoilId, revisionId, aoaDeg: 0, resultId: urans.id, status: "done" });

    await refreshPolarCacheForRevision(db, rqAirfoilId, revisionId);
    await db.transaction(async (tx) => {
      await recomputeCampaignProgress(tx, campaignId);
    });
    await probeCampaignCompletion(db, campaignId);
    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals.solved).toBe(4);
    expect(totals.rejected).toBe(1);
    expect(totals.failed).toBe(0);
    expect(totals.remaining).toBe(0);

    // The dialog data source must find the rejected point on the SAME
    // terminal+result_id model as the counters (the failures analogue of the
    // production drift: campaignFailures saw total:0 while failed counted 1).
    const rejected = await campaignRejected(db, campaignId);
    expect(rejected.total).toBe(1);
    expect(rejected.samples[0].resultId).toBe(rejectedResultId);
    expect(rejected.samples[0].aoaDeg).toBe(0);
    expect(rejected.samples[0].reasons).toContain("missing-force-history");

    // API shape for the dialog: failures response carries the rejected bucket.
    const viaApi = await app.inject({ method: "GET", url: `/api/admin/campaigns/${campaignId}/failures` });
    expect(viaApi.statusCode).toBe(200);
    expect(viaApi.json().total).toBe(0);
    expect(viaApi.json().rejected.total).toBe(1);
    expect(viaApi.json().rejected.samples[0].airfoilSlug).toBe(`${PREFIX}-rq-af`);
  });

  it("failed-only requeue is a no-op on rejected evidence (false-positive guard)", async () => {
    const out = await requeueCampaignFailed(db, campaignId, { expectedCount: 0 });
    expect(out.requeued).toBe(0);
    const [point] = (await db.execute(sql`
      SELECT p.state, r.status
      FROM sim_campaign_points p JOIN results r ON r.id = p.result_id
      WHERE p.campaign_id = ${campaignId} AND p.aoa_deg = 0
    `)) as unknown as Array<{ state: string; status: string }>;
    expect(point.state).toBe("terminal");
    expect(point.status).toBe("done"); // rejected evidence untouched
  });

  it("rejected requeue drift-guards on its own expected count", async () => {
    // Wrong rejected count → drift, nothing moves (includeRejected without a
    // confirmed count behaves the same: expected 0 vs actual 1).
    await expect(
      requeueCampaignFailed(db, campaignId, { expectedCount: 0, includeRejected: true, expectedRejectedCount: 3 }),
    ).rejects.toMatchObject({ code: "drift" });
    await expect(requeueCampaignFailed(db, campaignId, { expectedCount: 0, includeRejected: true })).rejects.toMatchObject({
      code: "drift",
    });
    const drift = await app.inject({
      method: "POST",
      url: `/api/admin/campaigns/${campaignId}/requeue-failed`,
      payload: { expectedCount: 0, includeRejected: true, expectedRejectedCount: 2 },
    });
    expect(drift.statusCode).toBe(409);
  });

  it("requeues the rejected point back to requested + pending and reopens the campaign", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/campaigns/${campaignId}/requeue-failed`,
      payload: { expectedCount: 0, includeRejected: true, expectedRejectedCount: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().requeued).toBe(1);
    expect(res.json().requeuedFailed).toBe(0);
    expect(res.json().requeuedRejected).toBe(1);

    // Re-claimable exactly like the failed path: point requested, result pending.
    const [point] = (await db.execute(sql`
      SELECT p.state, r.status
      FROM sim_campaign_points p JOIN results r ON r.id = p.result_id
      WHERE p.campaign_id = ${campaignId} AND p.aoa_deg = 0
    `)) as unknown as Array<{ state: string; status: string }>;
    expect(point.state).toBe("requested");
    expect(point.status).toBe("pending");

    const rejected = await campaignRejected(db, campaignId);
    expect(rejected.total).toBe(0);
    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals.rejected).toBe(0);
    expect(totals.remaining).toBe(1);
    const [camp] = (await db.execute(sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`)) as unknown as Array<{ status: string }>;
    expect(camp.status).toBe("active");
  });

  it("the re-solve lands accepted and the classification row refreshes regime in place (3db79ff8 staleness)", async () => {
    // Simulate the fixed-engine re-solve landing on the SAME results row with
    // full URANS evidence this time.
    await db
      .update(results)
      .set({ status: "done", source: "solved", regime: "urans", unsteady: true, stalled: true, converged: true, cl: 0.36, cd: 0.019 })
      .where(eq(results.id, rejectedResultId));
    await db.insert(forceHistory).values({ resultId: rejectedResultId, t: [0, 0.1, 0.2, 0.3], cl: [0.33, 0.37, 0.35, 0.36], cd: [0.019, 0.021, 0.02, 0.02], cm: [-0.02, -0.02, -0.02, -0.02] });
    await db.insert(resultMedia).values({ resultId: rejectedResultId, kind: "video", field: "velocity_magnitude", role: "instantaneous", storageKey: `jobs/${PREFIX}-rq/cases/c0/velocity_magnitude.mp4`, mimeType: "video/mp4" });
    await onResultIngested(db, { airfoilId: rqAirfoilId, revisionId, aoaDeg: 0, resultId: rejectedResultId, status: "done" });
    await refreshPolarCacheForRevision(db, rqAirfoilId, revisionId);

    const [rc] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, rejectedResultId));
    expect(rc?.state).toBe("accepted"); // the requeued point comes back clean

    // Regime staleness must-catch (prod row 3db79ff8: regime='rans' stamped on
    // an accepted urans verdict): re-solve a formerly-RANS row as URANS and the
    // classification row updated IN PLACE must carry the new regime.
    const [rcBefore] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, ransResultId));
    expect(rcBefore?.regime).toBe("rans");
    await db
      .update(results)
      .set({ regime: "urans", unsteady: true, stalled: true, converged: true })
      .where(eq(results.id, ransResultId));
    await db.insert(forceHistory).values({ resultId: ransResultId, t: [0, 0.1, 0.2, 0.3], cl: [0.38, 0.42, 0.4, 0.41], cd: [0.019, 0.021, 0.02, 0.02], cm: [-0.02, -0.02, -0.02, -0.02] });
    await db.insert(resultMedia).values({ resultId: ransResultId, kind: "video", field: "velocity_magnitude", role: "instantaneous", storageKey: `jobs/${PREFIX}-rq/cases/c1/velocity_magnitude.mp4`, mimeType: "video/mp4" });
    await refreshPolarCacheForRevision(db, rqAirfoilId, revisionId);
    const [rcAfter] = await db.select().from(resultClassifications).where(eq(resultClassifications.resultId, ransResultId));
    expect(rcAfter?.state).toBe("accepted");
    expect(rcAfter?.regime).toBe("urans"); // NOT the stale 'rans' from the first verdict

    // Campaign settles clean after the re-solve verdict.
    await db.transaction(async (tx) => {
      await recomputeCampaignProgress(tx, campaignId);
    });
    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals.solved).toBe(5);
    expect(totals.rejected).toBe(0);
    expect(deriveCampaignCompletion(totals)).toBe("completed");
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
