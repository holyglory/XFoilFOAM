// Campaign API integration tests (spec §13): launch idempotency, physics-hash
// revision reuse, legacy bcId bridge, symmetric point planning, reuse preview,
// closure classification (kept vs released), force-release drift checks,
// lifecycle verbs, and the §10 auth hardening.
import { POLAR_FIT_VERSION, type Point } from "@aerodb/core";
import {
  airfoils,
  boundaryProfiles,
  campaignFailures,
  campaignAirfoilRows,
  campaignSummary,
  campaignProgressTotals,
  campaignRejected,
  categories,
  closeCampaignWithFailures,
  deriveCampaignCompletion,
  ensurePrecalcObligations,
  forceHistory,
  laneTick,
  mediums,
  meshProfiles,
  onResultIngested,
  outputProfiles,
  listCampaigns,
  polarFitSets,
  probeCampaignCompletion,
  recomputeCampaignProgress,
  refreshPolarCacheForRevision,
  requeueCampaignFailed,
  resultAttempts,
  resultClassifications,
  resultMedia,
  results,
  simCampaigns,
  simCampaignPoints,
  simPrecalcObligations,
  simResultSubmitRetries,
  simulationPresetRevisions,
  simulationPresets,
  solverProfiles,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, sql as pgClient } from "../src/db";
import { buildServer } from "../src/server";
import { createExactResultAttemptFixture } from "./exact-result-fixture";

const RUN_STAMP = Date.now();
const PREFIX = `pw-camp-${process.pid}-${RUN_STAMP.toString(36)}`;
// flow_conditions and reference_geometry_profiles dedupe on physical values,
// not fixture ownership. These canonical values are reserved for this file so
// parallel campaign suites cannot share registry rows accidentally.
const PRIMARY_CHORD_M = 0.2847;
const SECONDARY_CHORD_M = 0.4847;
const FILE_SPEED_OFFSET_MPS = 0.847;
const BASE_SPEED_MPS = 10 + FILE_SPEED_OFFSET_MPS;

const cleanupAirfoilIds: string[] = [];
const cleanupCategoryIds: string[] = [];
const cleanupMediumIds: string[] = [];
const cleanupProfileIds = {
  boundary: [] as string[],
  mesh: [] as string[],
  solver: [] as string[],
  output: [] as string[],
};
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
let numerics = {
  boundaryProfileId: "",
  meshProfileId: "",
  solverProfileId: "",
  outputProfileId: "",
};
let uransMeshProfileId = "";
let uransPrecalcMeshProfileId = "";

function planBody(overrides: Record<string, unknown> = {}) {
  return {
    mediumId,
    ambients: [[288.15, 101325]],
    speedsMps: [BASE_SPEED_MPS],
    chordsM: [PRIMARY_CHORD_M, SECONDARY_CHORD_M],
    spanM: 1,
    areaMode: "derived",
    excludedConditions: [],
    baseSweep: { fromDeg: -2, toDeg: 2, stepDeg: 1, listDeg: null },
    objectives: {
      ldMax: { enabled: true, toleranceDeg: 0.1, maxRounds: 4 },
      clZero: { enabled: true, toleranceDeg: 0.05, maxRounds: 4 },
      clMax: { enabled: true, toleranceDeg: 0.1, maxRounds: 4 },
    },
    numerics,
    ...overrides,
  };
}

beforeAll(async () => {
  app = await buildServer();
  const [cat] = await db
    .insert(categories)
    .values({
      slug: `${PREFIX}-cat`,
      name: `${PREFIX} cat`,
      path: `${PREFIX}-cat`,
      depth: 0,
    })
    .returning();
  cleanupCategoryIds.push(cat.id);
  const [asym] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-cambered`,
      name: `${PREFIX} cambered`,
      categoryId: cat.id,
      points: camberedPoints,
      isSymmetric: false,
    })
    .returning();
  const [symm] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-symmetric`,
      name: `${PREFIX} symmetric`,
      categoryId: cat.id,
      points: symmetricPoints,
      isSymmetric: true,
    })
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
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` })
    .returning();
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` })
    .returning();
  const [uransMesh] = await db
    .insert(meshProfiles)
    .values({
      slug: `${PREFIX}-urans-mesh`,
      name: `${PREFIX} URANS mesh`,
      nSurface: 260,
      nRadial: 140,
      nWake: 90,
      targetYPlus: 0.8,
    })
    .returning();
  const [uransPrecalcMesh] = await db
    .insert(meshProfiles)
    .values({
      slug: `${PREFIX}-urans-precalc-mesh`,
      name: `${PREFIX} URANS precalc mesh`,
      nSurface: 90,
      nRadial: 45,
      nWake: 35,
      targetYPlus: 40,
    })
    .returning();
  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` })
    .returning();
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` })
    .returning();
  cleanupProfileIds.boundary.push(boundary.id);
  cleanupProfileIds.mesh.push(mesh.id, uransMesh.id, uransPrecalcMesh.id);
  cleanupProfileIds.solver.push(solver.id);
  cleanupProfileIds.output.push(output.id);
  numerics = {
    boundaryProfileId: boundary.id,
    meshProfileId: mesh.id,
    solverProfileId: solver.id,
    outputProfileId: output.id,
  };
  uransMeshProfileId = uransMesh.id;
  uransPrecalcMeshProfileId = uransPrecalcMesh.id;
});

afterAll(async () => {
  // Explicit result ids may include non-campaign evidence created by a test;
  // preserve that cleanup outside the campaign-owned fixture graph.
  if (cleanupResultIds.length)
    await db.delete(results).where(inArray(results.id, cleanupResultIds));
  await cleanupCampaignFixtures(db, {
    campaignIds: cleanupCampaignIds,
    presetSlugPrefix: `campaign-${PREFIX.toLowerCase()}`,
  });
  if (cleanupProfileIds.boundary.length)
    await db
      .delete(boundaryProfiles)
      .where(inArray(boundaryProfiles.id, cleanupProfileIds.boundary));
  if (cleanupProfileIds.mesh.length)
    await db
      .delete(meshProfiles)
      .where(inArray(meshProfiles.id, cleanupProfileIds.mesh));
  if (cleanupProfileIds.solver.length)
    await db
      .delete(solverProfiles)
      .where(inArray(solverProfiles.id, cleanupProfileIds.solver));
  if (cleanupProfileIds.output.length)
    await db
      .delete(outputProfiles)
      .where(inArray(outputProfiles.id, cleanupProfileIds.output));
  if (cleanupAirfoilIds.length)
    await db.delete(airfoils).where(inArray(airfoils.id, cleanupAirfoilIds));
  if (cleanupCategoryIds.length)
    await db
      .delete(categories)
      .where(inArray(categories.id, cleanupCategoryIds));
  if (cleanupMediumIds.length)
    await db.delete(mediums).where(inArray(mediums.id, cleanupMediumIds));
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
    `)) as unknown as Array<{
      id: string;
      preset_id: string;
      simulation_preset_revision_id: string;
    }>;
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
      .where(
        inArray(
          simulationPresets.id,
          conditions.map((c) => c.preset_id),
        ),
      );
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
      .where(
        inArray(
          simulationPresetRevisions.id,
          conditions.map((c) => c.simulation_preset_revision_id),
        ),
      );
    for (const revision of revisions) {
      expect(revision.physicsHash).toBeTruthy();
      expect(revision.isCanonicalPhysics).toBe(true);
    }

    // Lanes: symmetric cl_zero lanes are symmetric_definition.
    const lanes = (await db.execute(sql`
      SELECT airfoil_id, objective, state FROM sim_campaign_lanes WHERE campaign_id = ${campaignId}
    `)) as unknown as Array<{
      airfoil_id: string;
      objective: string;
      state: string;
    }>;
    expect(lanes.length).toBe(12); // 2 airfoils × 2 conditions × 3 objectives
    for (const lane of lanes) {
      if (lane.objective === "cl_zero" && lane.airfoil_id === symId)
        expect(lane.state).toBe("symmetric_definition");
      else expect(lane.state).toBe("awaiting_seed");
    }
    // Cl_max is a real nonzero-α target even on symmetric airfoils: its lanes
    // must seed and iterate (α ≥ 0 clamped), NEVER take the cl_zero
    // symmetric_definition shortcut.
    const symClMaxLanes = lanes.filter(
      (lane) => lane.objective === "cl_max" && lane.airfoil_id === symId,
    );
    expect(symClMaxLanes.length).toBe(2);
    for (const lane of symClMaxLanes) expect(lane.state).toBe("awaiting_seed");
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
    const rows = await db
      .select({ id: simCampaigns.id })
      .from(simCampaigns)
      .where(eq(simCampaigns.idempotencyKey, `${PREFIX}-key-1`));
    expect(rows.length).toBe(1);
  });

  it("reuses physics-hash revisions across campaigns (no duplicate presets)", async () => {
    const [presetCountBefore] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM simulation_presets
          WHERE origin = 'campaign' AND slug LIKE ${`campaign-${PREFIX.toLowerCase()}%`}`,
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
      sql`SELECT count(*)::int AS n FROM simulation_presets
          WHERE origin = 'campaign' AND slug LIKE ${`campaign-${PREFIX.toLowerCase()}%`}`,
    )) as unknown as Array<{ n: number }>;
    expect(Number(presetCountAfter.n)).toBe(Number(presetCountBefore.n));
    const firstRevisions = (await db.execute(sql`
      SELECT simulation_preset_revision_id FROM sim_campaign_conditions WHERE campaign_id = ${campaignId} ORDER BY ord
    `)) as unknown as Array<{ simulation_preset_revision_id: string }>;
    const secondRevisions = (await db.execute(sql`
      SELECT simulation_preset_revision_id FROM sim_campaign_conditions WHERE campaign_id = ${secondId} ORDER BY ord
    `)) as unknown as Array<{ simulation_preset_revision_id: string }>;
    expect(secondRevisions.map((r) => r.simulation_preset_revision_id)).toEqual(
      firstRevisions.map((r) => r.simulation_preset_revision_id),
    );
  });

  it("accepts and round-trips per-tier URANS mesh numerics fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} tier mesh pins`,
        priority: 5,
        idempotencyKey: `${PREFIX}-key-tier-mesh`,
        airfoilIds: [asymId],
        plan: planBody({
          chordsM: [PRIMARY_CHORD_M],
          numerics: {
            ...numerics,
            uransMeshProfileId,
            uransPrecalcMeshProfileId,
          },
        }),
      },
    });
    expect(res.statusCode).toBe(201);
    const tierCampaignId = res.json().campaign.id as string;
    cleanupCampaignIds.push(tierCampaignId);

    const summary = await app.inject({
      method: "GET",
      url: `/api/admin/campaigns/${tierCampaignId}`,
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().campaign.plan.numerics).toMatchObject({
      uransMeshProfileId,
      uransPrecalcMeshProfileId,
    });

    const [stored] = (await db.execute(sql`
      SELECT sp.urans_mesh_profile_id, sp.urans_precalc_mesh_profile_id,
             rev.snapshot->'uransMesh'->>'id' AS snapshot_urans_mesh_id,
             rev.snapshot->'uransPrecalcMesh'->>'id' AS snapshot_urans_precalc_mesh_id
      FROM sim_campaign_conditions cc
      JOIN simulation_presets sp ON sp.id = cc.preset_id
      JOIN simulation_preset_revisions rev ON rev.id = cc.simulation_preset_revision_id
      WHERE cc.campaign_id = ${tierCampaignId}
      LIMIT 1
    `)) as unknown as Array<{
      urans_mesh_profile_id: string;
      urans_precalc_mesh_profile_id: string;
      snapshot_urans_mesh_id: string;
      snapshot_urans_precalc_mesh_id: string;
    }>;
    expect(stored.urans_mesh_profile_id).toBe(uransMeshProfileId);
    expect(stored.urans_precalc_mesh_profile_id).toBe(
      uransPrecalcMeshProfileId,
    );
    expect(stored.snapshot_urans_mesh_id).toBe(uransMeshProfileId);
    expect(stored.snapshot_urans_precalc_mesh_id).toBe(
      uransPrecalcMeshProfileId,
    );
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
    expect(
      body.conditions.every(
        (c: { revisionId: string | null }) => c.revisionId != null,
      ),
    ).toBe(true);
  });

  it("returns the bounded summary with scheduler + suppressed rate", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/campaigns/${campaignId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.campaign.status).toBe("active");
    expect(body.campaign.plan.numerics.uransMeshProfileId).toBeNull();
    expect(body.campaign.plan.numerics.uransPrecalcMeshProfileId).toBeNull();
    expect(body.conditions.length).toBe(2);
    expect(body.totals.requested).toBe(20);
    expect(body.scheduler).toHaveProperty("sweeperEnabled");
    expect(body.scheduler).toHaveProperty("campaignJobsRunning");
    expect(body.rate).toBeNull(); // <50 measured points → suppressed (spec §12)
    const matrix = await app.inject({
      method: "GET",
      url: `/api/admin/campaigns/${campaignId}/airfoils?limit=10`,
    });
    expect(matrix.statusCode).toBe(200);
    expect(matrix.json().items.length).toBe(2);
  });

  describe("plan editing + closure (§6)", () => {
    let baseRevision = 1;
    let diffHash = "";

    it("classifies a removed condition with evidence as kept, without as released", async () => {
      // Land real evidence on the primary-chord condition at α = +1.
      const conditions = (await db.execute(sql`
        SELECT cc.id, cc.simulation_preset_revision_id AS revision_id, p.legacy_boundary_condition_id AS bc_id,
               (rev.snapshot->'referenceGeometry'->>'referenceLengthM')::float8 AS chord
        FROM sim_campaign_conditions cc
        JOIN simulation_presets p ON p.id = cc.preset_id
        JOIN simulation_preset_revisions rev ON rev.id = cc.simulation_preset_revision_id
        WHERE cc.campaign_id = ${campaignId}
      `)) as unknown as Array<{
        id: string;
        revision_id: string;
        bc_id: string;
        chord: number;
      }>;
      const primaryCondition = conditions.find(
        (c) => Math.abs(c.chord - PRIMARY_CHORD_M) < 1e-9,
      )!;
      expect(primaryCondition).toBeTruthy();
      const [solved] = await db
        .insert(results)
        .values({
          airfoilId: asymId,
          bcId: primaryCondition.bc_id,
          simulationPresetRevisionId: primaryCondition.revision_id,
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
        payload: {
          plan: planBody({ chordsM: [SECONDARY_CHORD_M] }),
          basePlanRevisionNumber: baseRevision,
        },
      });
      expect(preview.statusCode).toBe(200);
      const diff = preview.json();
      expect(diff.keptConditions.length).toBe(1);
      expect(diff.keptConditions[0].conditionId).toBe(primaryCondition.id);
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
        payload: {
          plan: planBody({ chordsM: [SECONDARY_CHORD_M] }),
          basePlanRevisionNumber: 99,
          diffHash,
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("conflict");
    });

    it("applies the acknowledged diff atomically", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/campaigns/${campaignId}/plan/apply`,
        payload: {
          plan: planBody({ chordsM: [SECONDARY_CHORD_M] }),
          basePlanRevisionNumber: baseRevision,
          diffHash,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("applied");
      expect(body.planRevisionNumber).toBe(2);
      baseRevision = 2;
      const [keptCond] = (await db.execute(sql`
        SELECT status FROM sim_campaign_conditions cc
        JOIN simulation_preset_revisions rev ON rev.id = cc.simulation_preset_revision_id
        WHERE cc.campaign_id = ${campaignId}
          AND abs((rev.snapshot->'referenceGeometry'->>'referenceLengthM')::float8 - ${PRIMARY_CHORD_M}) < 1e-9
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
      const pause = await app.inject({
        method: "POST",
        url: `/api/admin/campaigns/${campaignId}/pause`,
      });
      expect(pause.statusCode).toBe(200);
      expect(pause.json().campaign.status).toBe("paused");
      const resume = await app.inject({
        method: "POST",
        url: `/api/admin/campaigns/${campaignId}/resume`,
      });
      expect(resume.statusCode).toBe(200);
      const cancel = await app.inject({
        method: "POST",
        url: `/api/admin/campaigns/${campaignId}/cancel`,
      });
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
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/campaigns/${campaignId}/duplicate`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toContain("copy");
    expect(body.plan.mediumId).toBe(mediumId);
    expect(body.airfoilIds.sort()).toEqual([asymId, symId].sort());
    const after = await db.select({ id: simCampaigns.id }).from(simCampaigns);
    expect(after.length).toBe(before.length);
  });
});

// Cl_max is a real nonzero-α target on symmetric airfoils (unlike cl_zero's
// 0°-by-definition shortcut): the lane must iterate, and its predicted α must
// be clamped to the α ≥ 0 half the symmetric planner actually solves — a
// negative fine target would request a point the campaign then mirrors away.
describe("cl_max lane on a symmetric airfoil clamps predicted α to ≥ 0 (laneTick)", () => {
  const CLAMP_SPEED = 13 + FILE_SPEED_OFFSET_MPS; // file-unique physics revision
  let campaignId = "";
  let conditionId = "";
  let revisionId = "";
  let fitSetId = "";

  afterAll(async () => {
    // FK order: laneTick appended a lane step witnessing this fit set — drop
    // the steps (scoped to this fixture fit) before the fit row itself.
    if (fitSetId) {
      await db.execute(
        sql`DELETE FROM sim_campaign_lane_steps WHERE fit_set_id = ${fitSetId}`,
      );
      await db.delete(polarFitSets).where(eq(polarFitSets.id, fitSetId));
    }
  });

  it("launches a symmetric-only clMax campaign whose lane awaits its seed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} clmax clamp`,
        priority: 5,
        idempotencyKey: `${PREFIX}-key-clamp`,
        airfoilIds: [symId],
        plan: planBody({
          chordsM: [PRIMARY_CHORD_M],
          speedsMps: [CLAMP_SPEED],
          objectives: {
            ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
            clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
            clMax: { enabled: true, toleranceDeg: 0.1, maxRounds: 4 },
          },
        }),
      },
    });
    expect(res.statusCode).toBe(201);
    campaignId = res.json().campaign.id;
    cleanupCampaignIds.push(campaignId);
    const [condition] = (await db.execute(sql`
      SELECT id, simulation_preset_revision_id AS revision_id FROM sim_campaign_conditions WHERE campaign_id = ${campaignId}
    `)) as unknown as Array<{ id: string; revision_id: string }>;
    conditionId = condition.id;
    revisionId = condition.revision_id;
    const lanes = (await db.execute(sql`
      SELECT objective, state FROM sim_campaign_lanes WHERE campaign_id = ${campaignId}
    `)) as unknown as Array<{ objective: string; state: string }>;
    expect(lanes).toEqual([{ objective: "cl_max", state: "awaiting_seed" }]);
  });

  it("laneTick clamps a negative α(Cl_max) prediction to the α ≥ 0 search half", async () => {
    // A current fit whose fine Cl_max target is NEGATIVE (mirror side). The
    // real symmetric polar is mirror-symmetric, so −1.5° and +1.5° are the
    // same physics — the lane must pursue the solvable +side representative.
    const [fit] = await db
      .insert(polarFitSets)
      .values({
        airfoilId: symId,
        simulationPresetRevisionId: revisionId,
        fitVersion: POLAR_FIT_VERSION,
        evidenceSignature: `${PREFIX}-clamp-sig`,
        status: "final",
        confidence: 0.9,
        acceptedPointCount: 5,
        provisionalPointCount: 0,
        rejectedPointCount: 0,
        alphaClmaxFine: -1.5,
        isCurrent: true,
      })
      .returning({ id: polarFitSets.id });
    fitSetId = fit.id;

    const result = await laneTick(db, {
      campaignId,
      airfoilId: symId,
      conditionId,
      objective: "cl_max",
    });
    expect(result).not.toBeNull();
    // Clamped prediction 0° collides with the base-sweep point at α = 0 →
    // duplicate branch: lane iterates on that open point, nothing new enqueued.
    expect(result!.state).toBe("iterating");
    expect(result!.enqueuedAoaDeg).toBeNull();

    const [lane] = (await db.execute(sql`
      SELECT current_target_alpha FROM sim_campaign_lanes
      WHERE campaign_id = ${campaignId} AND airfoil_id = ${symId} AND condition_id = ${conditionId} AND objective = 'cl_max'
    `)) as unknown as Array<{ current_target_alpha: number | string }>;
    expect(Number(lane.current_target_alpha)).toBe(0); // −1.5 unclamped would be the F-shape failure

    // And the clamp kept the negative half derived-only: no solver-facing
    // campaign point may exist at α < 0 for the symmetric airfoil.
    const [negativeSolverPoints] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM sim_campaign_points
      WHERE campaign_id = ${campaignId} AND aoa_deg < 0 AND NOT derived_by_symmetry
    `)) as unknown as Array<{ n: number }>;
    expect(Number(negativeSolverPoints.n)).toBe(0);
  });

  it("converges once the seed is terminal and accepted evidence lands within tolerance of the clamped target", async () => {
    const [preset] = (await db.execute(sql`
      SELECT p.legacy_boundary_condition_id AS bc_id
      FROM sim_campaign_conditions cc JOIN simulation_presets p ON p.id = cc.preset_id
      WHERE cc.id = ${conditionId}
    `)) as unknown as Array<{ bc_id: string }>;
    // Solve the whole symmetric seed (solver half α = 0, 1, 2) with accepted
    // evidence — the ld_max laneTick flow: terminal-link via onResultIngested,
    // then tick the lane against the unchanged witness fit.
    for (const [aoa, cl] of [
      [0, 0],
      [1, 0.11],
      [2, 0.22],
    ] as Array<[number, number]>) {
      const [row] = await db
        .insert(results)
        .values({
          airfoilId: symId,
          bcId: preset.bc_id,
          simulationPresetRevisionId: revisionId,
          aoaDeg: aoa,
          status: "done",
          source: "solved",
          regime: "rans",
          converged: true,
          stalled: false,
          cl,
          cd: 0.01,
          cm: -0.01,
        })
        .returning({ id: results.id });
      cleanupResultIds.push(row.id);
      await db.insert(resultClassifications).values({
        resultId: row.id,
        airfoilId: symId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: aoa,
        regime: "rans",
        classifierVersion: "test-fixture",
        state: "accepted",
        region: "attached",
        confidence: 0.9,
      });
      await onResultIngested(db, {
        airfoilId: symId,
        revisionId,
        aoaDeg: aoa,
        resultId: row.id,
        status: "done",
      });
    }

    const result = await laneTick(db, {
      campaignId,
      airfoilId: symId,
      conditionId,
      objective: "cl_max",
    });
    expect(result).not.toBeNull();
    // No open lane points, accepted evidence at |α − 0| ≤ 0.10°, witness fit
    // unmoved since the prediction → converged against the final-status fit.
    expect(result!.state).toBe("converged_final");
    expect(result!.enqueuedAoaDeg).toBeNull();
    const [lane] = (await db.execute(sql`
      SELECT state, current_target_alpha, witness_fit_set_id FROM sim_campaign_lanes
      WHERE campaign_id = ${campaignId} AND airfoil_id = ${symId} AND condition_id = ${conditionId} AND objective = 'cl_max'
    `)) as unknown as Array<{
      state: string;
      current_target_alpha: number | string;
      witness_fit_set_id: string;
    }>;
    expect(lane.state).toBe("converged_final");
    expect(Number(lane.current_target_alpha)).toBe(0);
    expect(lane.witness_fit_set_id).toBe(fitSetId);
  });

  it("polar-cache refresh retires prior-version current rows (single-current invariant)", async () => {
    // A POLAR_FIT_VERSION bump refreshes lazily: before the fix, storeFit only
    // un-currented rows of the CURRENT version, so the stale prior-version row
    // stayed co-current and the detail/catalog single-current readers picked
    // between the two nondeterministically. Must-catch: stale v1 current row +
    // one refresh → exactly one current row, the fresh-version one.
    // The current-version witness above is no longer current in this synthetic
    // version-bump scenario; the DB-level one-current constraint must remain
    // valid even while constructing the stale prior-version fixture.
    await db
      .update(polarFitSets)
      .set({ isCurrent: false })
      .where(eq(polarFitSets.id, fitSetId));
    const [stale] = await db
      .insert(polarFitSets)
      .values({
        airfoilId: symId,
        simulationPresetRevisionId: revisionId,
        fitVersion: "evidence-lowess-v1",
        evidenceSignature: `${PREFIX}-stale-v1-sig`,
        status: "final",
        confidence: 0.9,
        acceptedPointCount: 3,
        provisionalPointCount: 0,
        rejectedPointCount: 0,
        alphaClmax: 2,
        isCurrent: true,
      })
      .returning({ id: polarFitSets.id });

    await refreshPolarCacheForRevision(db, symId, revisionId);

    const rows = await db
      .select({
        id: polarFitSets.id,
        fitVersion: polarFitSets.fitVersion,
        isCurrent: polarFitSets.isCurrent,
      })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, symId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
        ),
      );
    const current = rows.filter((r) => r.isCurrent);
    expect(current.length).toBe(1);
    expect(current[0].fitVersion).toBe(POLAR_FIT_VERSION);
    expect(rows.find((r) => r.id === stale.id)?.isCurrent).toBe(false);
  });
});

// The running production campaign predates the clMax objective: its stored
// plan revisions have NO objectives.clMax block at all. Enabling Cl_max on
// such a campaign goes through preview → apply (§6.1) and must (a) classify
// without crashing on the absent legacy block, (b) surface the enable in
// objectiveDeltas, and (c) materialize the new cl_max lanes via the generic
// ensureCampaignLanes loop — including awaiting_seed on the symmetric airfoil.
describe("plan edit enables cl_max on a legacy (pre-clMax) campaign and materializes lanes", () => {
  const EDIT_SPEED = 17 + FILE_SPEED_OFFSET_MPS; // file-unique physics revision
  let campaignId = "";
  let diffHash = "";

  const legacyObjectives = {
    ldMax: { enabled: true, toleranceDeg: 0.1, maxRounds: 4 },
    clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
    // clMax intentionally ABSENT: pre-clMax clients never sent it — the zod
    // default + normalizeCampaignPlan must treat absence as disabled.
  };
  const editedObjectives = {
    ...legacyObjectives,
    // Tolerance/rounds match the disabled-block defaults so the only delta is
    // the enable itself (a rounds change would add "rounds_changed").
    clMax: { enabled: true, toleranceDeg: 0.1, maxRounds: 8 },
  };

  it("launches without a clMax block → ld_max lanes only", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} clmax plan edit`,
        priority: 5,
        idempotencyKey: `${PREFIX}-key-planedit`,
        airfoilIds: [asymId, symId],
        plan: planBody({
          chordsM: [PRIMARY_CHORD_M],
          speedsMps: [EDIT_SPEED],
          objectives: legacyObjectives,
        }),
      },
    });
    expect(res.statusCode).toBe(201);
    campaignId = res.json().campaign.id;
    cleanupCampaignIds.push(campaignId);
    const lanes = (await db.execute(sql`
      SELECT objective FROM sim_campaign_lanes WHERE campaign_id = ${campaignId}
    `)) as unknown as Array<{ objective: string }>;
    expect(lanes.map((l) => l.objective).sort()).toEqual(["ld_max", "ld_max"]);

    // Make the stored revision a true legacy artifact: strip the normalized
    // clMax block so the jsonb matches what pre-clMax launches persisted.
    await db.execute(sql`
      UPDATE sim_campaign_plan_revisions
      SET plan = jsonb_set(plan, '{objectives}', (plan->'objectives') - 'clMax')
      WHERE campaign_id = ${campaignId}
    `);
    const [stored] = (await db.execute(sql`
      SELECT plan->'objectives' ? 'clMax' AS has_clmax FROM sim_campaign_plan_revisions WHERE campaign_id = ${campaignId}
    `)) as unknown as Array<{ has_clmax: boolean }>;
    expect(stored.has_clmax).toBe(false);
  });

  it("preview classifies the legacy plan without crashing and reports the cl_max enable", async () => {
    const preview = await app.inject({
      method: "POST",
      url: `/api/admin/campaigns/${campaignId}/plan/preview`,
      payload: {
        plan: planBody({
          chordsM: [PRIMARY_CHORD_M],
          speedsMps: [EDIT_SPEED],
          objectives: editedObjectives,
        }),
        basePlanRevisionNumber: 1,
      },
    });
    expect(preview.statusCode).toBe(200);
    const diff = preview.json();
    expect(diff.objectiveDeltas).toEqual([
      { objective: "cl_max", changes: ["enabled"], toleranceDeg: "0.10" },
    ]);
    // Objective toggles alone release/add nothing.
    expect(diff.releasedConditions.length).toBe(0);
    expect(diff.addedConditions.length).toBe(0);
    diffHash = diff.diffHash;
  });

  it("apply materializes the cl_max lanes (symmetric included, never symmetric_definition)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/campaigns/${campaignId}/plan/apply`,
      payload: {
        plan: planBody({
          chordsM: [PRIMARY_CHORD_M],
          speedsMps: [EDIT_SPEED],
          objectives: editedObjectives,
        }),
        basePlanRevisionNumber: 1,
        diffHash,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("applied");

    const lanes = (await db.execute(sql`
      SELECT airfoil_id, objective, state FROM sim_campaign_lanes WHERE campaign_id = ${campaignId} ORDER BY objective
    `)) as unknown as Array<{
      airfoil_id: string;
      objective: string;
      state: string;
    }>;
    expect(lanes.map((l) => l.objective)).toEqual([
      "cl_max",
      "cl_max",
      "ld_max",
      "ld_max",
    ]);
    const clMaxLanes = lanes.filter((l) => l.objective === "cl_max");
    expect(clMaxLanes.map((l) => l.airfoil_id).sort()).toEqual(
      [asymId, symId].sort(),
    );
    for (const lane of clMaxLanes) expect(lane.state).toBe("awaiting_seed");

    // The new stored revision carries the normalized clMax block.
    const [rev2] = (await db.execute(sql`
      SELECT plan->'objectives'->'clMax' AS clmax FROM sim_campaign_plan_revisions
      WHERE campaign_id = ${campaignId} AND revision_number = 2
    `)) as unknown as Array<{
      clmax: { enabled: boolean; toleranceDeg: string; maxRounds: number };
    }>;
    expect(rev2.clmax).toEqual({
      enabled: true,
      toleranceDeg: "0.10",
      maxRounds: 8,
    });
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
  const DRIFT_SPEED = 13.5 + FILE_SPEED_OFFSET_MPS;

  beforeAll(async () => {
    const [af] = await db
      .insert(airfoils)
      .values({
        slug: `${PREFIX}-drift-af`,
        name: `${PREFIX} drift af`,
        categoryId: cleanupCategoryIds[0],
        points: camberedPoints,
        isSymmetric: false,
      })
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
        plan: planBody({
          chordsM: [PRIMARY_CHORD_M],
          speedsMps: [DRIFT_SPEED],
          objectives: {
            ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
            clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
          },
        }),
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
      .values({
        airfoilId: driftAirfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 2,
        status: "done",
        source: "solved",
        regime: "rans",
        converged: true,
        stalled: false,
        cl: 0.6,
        cd: 0.012,
        cm: -0.02,
      })
      .returning({ id: results.id });
    cleanupResultIds.push(doneRow.id);
    await createExactResultAttemptFixture(db, doneRow.id, {
      publication: "selected-eligible",
    });
    await db.insert(resultClassifications).values({
      resultId: doneRow.id,
      airfoilId: driftAirfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 2,
      regime: "rans",
      classifierVersion: "test-v1",
      state: "accepted",
      reasons: [],
      confidence: 0.9,
    });
    await onResultIngested(db, {
      airfoilId: driftAirfoilId,
      revisionId,
      aoaDeg: 2,
      resultId: doneRow.id,
      status: "done",
    });

    // α=0 → FAILED, ingested exactly as the engine reports it: the point goes
    // TERMINAL linked to a results row at status='failed' (the URANS-no-shedding
    // degenerate path from the live campaign).
    const [failRow] = await db
      .insert(results)
      .values({
        airfoilId: driftAirfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 0,
        status: "failed",
        source: "solved",
        error: "OpenFOAMError: URANS transient produced no coefficient.dat",
      })
      .returning({ id: results.id });
    cleanupResultIds.push(failRow.id);
    await onResultIngested(db, {
      airfoilId: driftAirfoilId,
      revisionId,
      aoaDeg: 0,
      resultId: failRow.id,
      status: "failed",
    });

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
        .values({
          airfoilId: driftAirfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: aoa,
          status: "done",
          source: "solved",
          regime: "rans",
          converged: true,
          stalled: false,
          cl: 0.1 * aoa,
          cd: 0.011,
          cm: -0.02,
        })
        .returning({ id: results.id });
      cleanupResultIds.push(row.id);
      await createExactResultAttemptFixture(db, row.id, {
        publication: "selected-eligible",
      });
      await onResultIngested(db, {
        airfoilId: driftAirfoilId,
        revisionId,
        aoaDeg: aoa,
        resultId: row.id,
        status: "done",
      });
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
    await expect(
      requeueCampaignFailed(db, campaignId, { expectedCount: 5 }),
    ).rejects.toMatchObject({ code: "drift" });

    const [failed] = (await db.execute(sql`
      SELECT r.id
      FROM results r
      JOIN sim_campaign_points p ON p.result_id = r.id
      WHERE p.campaign_id = ${campaignId} AND p.aoa_deg = 0
    `)) as unknown as Array<{ id: string }>;
    await db.insert(simResultSubmitRetries).values({
      resultId: failed.id,
      state: "retry_wait",
      attemptCount: 1,
      nextAttemptAt: new Date(Date.now() + 60_000),
      lastHttpStatus: 503,
      lastError: "prior delayed submit retry",
    });

    const out = await requeueCampaignFailed(db, campaignId, {
      expectedCount: 1,
    });
    expect(out.requeued).toBe(1);

    // The point is re-claimable: state back to 'requested', result back to 'pending'.
    const [point] = (await db.execute(sql`
      SELECT p.state, r.status
      FROM sim_campaign_points p JOIN results r ON r.id = p.result_id
      WHERE p.campaign_id = ${campaignId} AND p.aoa_deg = 0
    `)) as unknown as Array<{ state: string; status: string }>;
    expect(point.state).toBe("requested");
    expect(point.status).toBe("pending");
    expect(
      await db
        .select({ resultId: simResultSubmitRetries.resultId })
        .from(simResultSubmitRetries)
        .where(eq(simResultSubmitRetries.resultId, failed.id)),
    ).toHaveLength(0);

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

// MUST-CATCH (chip == click-through + no double-count): a symmetric airfoil's
// derived −α mirror goes terminal linked to the SAME results row as its +α
// source. A failed source is not usable aerodynamic evidence, so its mirror is
// explicitly blocked instead of being booked as a solved derived point. The
// failed counter still counts the physical source only, matching the Points-tab
// source-result list and conserving the requested denominator exactly.
describe("failed symmetry sources block their mirrors without inflating failed", () => {
  let campaignId = "";
  let revisionId = "";
  let bcId = "";
  let mirrorAfId = "";
  let failedResultId = "";
  // Unique speed → unique physics hash → this campaign pins its own revision,
  // so no evidence from the other suites can terminal-link these points.
  const MIRROR_SPEED = 13.65 + FILE_SPEED_OFFSET_MPS;

  beforeAll(async () => {
    const [af] = await db
      .insert(airfoils)
      .values({
        slug: `${PREFIX}-mirror-af`,
        name: `${PREFIX} mirror af`,
        categoryId: cleanupCategoryIds[0],
        points: symmetricPoints,
        isSymmetric: true,
      })
      .returning();
    mirrorAfId = af.id;
    cleanupAirfoilIds.push(af.id);
  });

  it("launches a 5-point symmetric campaign: solver half 0..2 + derived mirrors −1,−2", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} mirror`,
        priority: 5,
        idempotencyKey: `${PREFIX}-mirror-key`,
        airfoilIds: [mirrorAfId],
        plan: planBody({
          chordsM: [PRIMARY_CHORD_M],
          speedsMps: [MIRROR_SPEED],
          objectives: {
            ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
            clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
          },
        }),
      },
    });
    expect(res.statusCode).toBe(201);
    campaignId = res.json().campaign.id;
    cleanupCampaignIds.push(campaignId);
    expect(res.json().totals.requested).toBe(5);

    const [cond] = (await db.execute(sql`
      SELECT cc.id, cc.simulation_preset_revision_id AS revision_id, p.legacy_boundary_condition_id AS bc_id
      FROM sim_campaign_conditions cc
      JOIN simulation_presets p ON p.id = cc.preset_id
      WHERE cc.campaign_id = ${campaignId}
    `)) as unknown as Array<{ id: string; revision_id: string; bc_id: string }>;
    revisionId = cond.revision_id;
    bcId = cond.bc_id;

    const mirrors = (await db.execute(sql`
      SELECT aoa_deg::float8 AS aoa FROM sim_campaign_points
      WHERE campaign_id = ${campaignId} AND derived_by_symmetry ORDER BY aoa_deg
    `)) as unknown as Array<{ aoa: number }>;
    expect(mirrors.map((m) => Number(m.aoa))).toEqual([-2, -1]);
  });

  it("failing the +1 source terminalizes its −1 mirror as blocked, not derived or failed", async () => {
    // Real breakage shape: the engine reports the +α solve failed; ingest
    // terminal-links the source AND its mirror to the same failed results row.
    const [failRow] = await db
      .insert(results)
      .values({
        airfoilId: mirrorAfId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 1,
        status: "failed",
        source: "solved",
        error: "OpenFOAMError: solver crashed: NaN residual",
      })
      .returning({ id: results.id });
    failedResultId = failRow.id;
    cleanupResultIds.push(failRow.id);
    await onResultIngested(db, {
      airfoilId: mirrorAfId,
      revisionId,
      aoaDeg: 1,
      resultId: failRow.id,
      status: "failed",
    });

    // Ground truth: the mirror IS terminal, derived, and linked to the FAILED row.
    const [mirror] = (await db.execute(sql`
      SELECT p.state, p.result_id, r.status
      FROM sim_campaign_points p JOIN results r ON r.id = p.result_id
      WHERE p.campaign_id = ${campaignId} AND p.aoa_deg = -1 AND p.derived_by_symmetry
    `)) as unknown as Array<{
      state: string;
      result_id: string;
      status: string;
    }>;
    expect(mirror.state).toBe("terminal");
    expect(mirror.result_id).toBe(failedResultId);
    expect(mirror.status).toBe("failed");

    // The source is one failure; the unusable mirror is one blocked obligation.
    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals.failed).toBe(1); // NOT 2: the mirror is not a second failure
    expect(totals.derived).toBe(0);
    expect(totals.blocked).toBe(1);
    expect(totals.solved).toBe(0);
    expect(totals.rejected).toBe(0);
    expect(
      totals.solved +
        totals.derived +
        totals.failed +
        totals.rejected +
        totals.blocked +
        totals.remaining,
    ).toBe(totals.requested);

    // Chip == click-through: the Points tab failed filter lists source results
    // rows only, so the failed counter must equal its list length.
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/point-history?${new URLSearchParams({ campaignId, status: "failed" }).toString()}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ aoaDeg: number }>;
      counts: Record<string, number>;
    };
    expect(body.items.length).toBe(totals.failed);
    expect(body.items.map((i) => i.aoaDeg)).toEqual([1]);
    expect(body.counts.failed).toBe(totals.failed);
  });

  it("full settle balances exactly with the mirror present and still flips the campaign to attention (gate unaffected)", async () => {
    // Solve the remaining solver-half points (0, +2); +2's mirror (−2) derives.
    for (const aoa of [0, 2]) {
      const [row] = await db
        .insert(results)
        .values({
          airfoilId: mirrorAfId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: aoa,
          status: "done",
          source: "solved",
          regime: "rans",
          fidelity: "rans",
          converged: true,
          stalled: false,
          cl: 0.3 * aoa,
          cd: 0.011,
          cm: -0.01,
        })
        .returning({ id: results.id });
      cleanupResultIds.push(row.id);
      await db.insert(resultClassifications).values({
        resultId: row.id,
        airfoilId: mirrorAfId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: aoa,
        regime: "rans",
        classifierVersion: "test-v1",
        state: "accepted",
        reasons: [],
        confidence: 0.9,
      });
      await onResultIngested(db, {
        airfoilId: mirrorAfId,
        revisionId,
        aoaDeg: aoa,
        resultId: row.id,
        status: "done",
      });
    }

    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals.requested).toBe(5);
    expect(totals.solved).toBe(2); // 0, +2
    expect(totals.derived).toBe(1); // −2 mirrors accepted source evidence
    expect(totals.failed).toBe(1); // the +1 source only
    expect(totals.blocked).toBe(1); // −1 cannot derive from failed evidence
    expect(totals.rejected).toBe(0);
    expect(totals.remaining).toBe(0);
    // The unclamped identity: 5 = 2 accepted + 1 derived + 1 failed + 1 blocked.
    expect(
      totals.solved +
        totals.derived +
        totals.failed +
        totals.rejected +
        totals.blocked +
        totals.remaining,
    ).toBe(totals.requested);

    // Attention gate: a mirror can only fail alongside its source, so excluding
    // mirrors from the failed COUNTER can never hide a failure from the gate.
    expect(deriveCampaignCompletion(totals)).toBe("attention");
    await probeCampaignCompletion(db, campaignId);
    const [camp] = (await db.execute(
      sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`,
    )) as unknown as Array<{ status: string }>;
    expect(camp.status).toBe("attention");
  });

  it("both recompute paths agree row-for-row (incremental keys vs whole-campaign) and re-ingest is idempotent", async () => {
    const readCounters = async () =>
      (await db.execute(sql`
        SELECT condition_id, airfoil_id, requested, solved, failed, running, superseded, derived, rejected
        FROM sim_campaign_progress WHERE campaign_id = ${campaignId}
        ORDER BY condition_id, airfoil_id
      `)) as unknown as Array<Record<string, unknown>>;

    // Counters as last written by the incremental ingest path (keys).
    const fromKeysPath = await readCounters();
    expect(fromKeysPath.length).toBeGreaterThan(0);

    // Whole-campaign recompute (launch/plan-edit path) must produce identical rows.
    await db.transaction(async (tx) => {
      await recomputeCampaignProgress(tx, campaignId);
    });
    expect(await readCounters()).toEqual(fromKeysPath);

    // Idempotent re-ingest of the failed result routes back through the keys
    // path (rows already linked) — counters must not move.
    await onResultIngested(db, {
      airfoilId: mirrorAfId,
      revisionId,
      aoaDeg: 1,
      resultId: failedResultId,
      status: "failed",
    });
    expect(await readCounters()).toEqual(fromKeysPath);
  });
});

describe("rejected-classification honesty + premature-completion guard (D6)", () => {
  let campaignId = "";
  let revisionId = "";
  let bcId = "";
  let rejAirfoilId = "";
  let uransResultId = "";
  let aoa1ResultId = "";
  const REJ_SPEED = 14.5 + FILE_SPEED_OFFSET_MPS; // file-unique physics hash

  beforeAll(async () => {
    const [af] = await db
      .insert(airfoils)
      .values({
        slug: `${PREFIX}-rej-af`,
        name: `${PREFIX} rej af`,
        categoryId: cleanupCategoryIds[0],
        points: camberedPoints,
        isSymmetric: false,
      })
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
        plan: planBody({
          chordsM: [PRIMARY_CHORD_M],
          speedsMps: [REJ_SPEED],
          objectives: {
            ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
            clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
          },
        }),
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
      await createExactResultAttemptFixture(db, row.id, {
        publication: "selected-eligible",
      });
      await onResultIngested(db, {
        airfoilId: rejAirfoilId,
        revisionId,
        aoaDeg: aoa,
        resultId: row.id,
        status: "done",
      });
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
    const rejectedAttemptId = await createExactResultAttemptFixture(
      db,
      urans.id,
      { publication: "historical-rejected" },
    );
    await onResultIngested(db, {
      airfoilId: rejAirfoilId,
      revisionId,
      aoaDeg: 0,
      resultId: urans.id,
      status: "done",
    });

    // The ingest-time probe fires before classification. Unjudged evidence
    // fails closed immediately as unavailable/attention; cache classification
    // below then replaces the temporary blocked counters with final buckets.
    const [preVerdict] = (await db.execute(
      sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`,
    )) as unknown as Array<{ status: string }>;
    expect(preVerdict.status).toBe("attention");

    // Classify (the sweeper does this right after ingest), recompute, settle.
    await refreshPolarCacheForRevision(db, rejAirfoilId, revisionId);
    const [rc] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultAttemptId, rejectedAttemptId));
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
    const [camp] = (await db.execute(
      sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`,
    )) as unknown as Array<{ status: string }>;
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
      .set({
        status: "attention",
        closedWithFailedCount: null,
        closedWithRejectedCount: null,
        completedAt: null,
      })
      .where(eq(simCampaigns.id, campaignId));
  });

  it("blocks completion while a terminal point's cell result is re-solving (wave-2 window)", async () => {
    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, campaignId));
    // Simulate the wave-2 child claim: point stays terminal, cell row queued.
    await db
      .update(results)
      .set({ status: "queued", source: "queued" })
      .where(eq(results.id, aoa1ResultId));
    await probeCampaignCompletion(db, campaignId);
    const [during] = (await db.execute(
      sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`,
    )) as unknown as Array<{ status: string }>;
    expect(during.status).toBe("active"); // in-flight guard: NOT completed/attention

    // A LOST wave-2 job resets the cell row to 'pending' (reconcile's
    // requeueLostJob) — still re-solve intent, so the probe must keep
    // blocking; the sweeper re-claims pending rows, so no deadlock.
    await db
      .update(results)
      .set({ status: "pending", source: "queued" })
      .where(eq(results.id, aoa1ResultId));
    await probeCampaignCompletion(db, campaignId);
    const [pendingProbe] = (await db.execute(
      sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`,
    )) as unknown as Array<{ status: string }>;
    expect(pendingProbe.status).toBe("active"); // lost-job window: NOT completed/attention

    // 'stale' cell rows on a terminal point are re-solve intent too.
    await db
      .update(results)
      .set({ status: "stale", source: "queued" })
      .where(eq(results.id, aoa1ResultId));
    await probeCampaignCompletion(db, campaignId);
    const [staleProbe] = (await db.execute(
      sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`,
    )) as unknown as Array<{ status: string }>;
    expect(staleProbe.status).toBe("active");

    await db
      .update(results)
      .set({ status: "done", source: "solved" })
      .where(eq(results.id, aoa1ResultId));
    await probeCampaignCompletion(db, campaignId);
    const [after] = (await db.execute(
      sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`,
    )) as unknown as Array<{ status: string }>;
    expect(after.status).toBe("attention"); // rejected>0 remains unavailable
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
      sha256: "2".repeat(64),
      byteSize: 4096,
    });
    await createExactResultAttemptFixture(db, uransResultId, {
      publication: "selected-eligible",
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
    const [rc] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, uransResultId));
    expect(rc?.state).toBe("accepted");
    // …and supersedeRansWithAcceptedUrans is no longer dead code: the RANS
    // attempt's classification flips to superseded_by_urans.
    const [attemptRc] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultAttemptId, attempt.id));
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

    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, campaignId));
    await probeCampaignCompletion(db, campaignId);
    const [camp] = (await db.execute(
      sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`,
    )) as unknown as Array<{ status: string }>;
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
  const RQ_SPEED = 15.5 + FILE_SPEED_OFFSET_MPS; // file-unique physics hash

  beforeAll(async () => {
    const [af] = await db
      .insert(airfoils)
      .values({
        slug: `${PREFIX}-rq-af`,
        name: `${PREFIX} rq af`,
        categoryId: cleanupCategoryIds[0],
        points: camberedPoints,
        isSymmetric: false,
      })
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
        plan: planBody({
          chordsM: [PRIMARY_CHORD_M],
          speedsMps: [RQ_SPEED],
          objectives: {
            ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
            clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
          },
        }),
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
        .values({
          airfoilId: rqAirfoilId,
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
      if (aoa === 1) ransResultId = row.id;
      await createExactResultAttemptFixture(db, row.id, {
        publication: "selected-eligible",
      });
      await onResultIngested(db, {
        airfoilId: rqAirfoilId,
        revisionId,
        aoaDeg: aoa,
        resultId: row.id,
        status: "done",
      });
    }
    // α=0 → ingest-shaped URANS done WITHOUT force history / video → rejected.
    const [urans] = await db
      .insert(results)
      .values({
        airfoilId: rqAirfoilId,
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
    rejectedResultId = urans.id;
    cleanupResultIds.push(urans.id);
    await createExactResultAttemptFixture(db, urans.id, {
      publication: "historical-rejected",
    });
    await onResultIngested(db, {
      airfoilId: rqAirfoilId,
      revisionId,
      aoaDeg: 0,
      resultId: urans.id,
      status: "done",
    });

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

    // The generic RANS requeue preview deliberately excludes URANS evidence;
    // the terminal rejected counter remains visible but the ladder owns repair.
    const rejected = await campaignRejected(db, campaignId);
    expect(rejected.total).toBe(0);

    // API shape for the dialog: failures response carries the rejected bucket.
    const viaApi = await app.inject({
      method: "GET",
      url: `/api/admin/campaigns/${campaignId}/failures`,
    });
    expect(viaApi.statusCode).toBe(200);
    expect(viaApi.json().total).toBe(0);
    expect(viaApi.json().rejected.total).toBe(0);
  });

  it("failed-only requeue is a no-op on rejected evidence (false-positive guard)", async () => {
    const out = await requeueCampaignFailed(db, campaignId, {
      expectedCount: 0,
    });
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
      requeueCampaignFailed(db, campaignId, {
        expectedCount: 0,
        includeRejected: true,
        expectedRejectedCount: 3,
      }),
    ).rejects.toMatchObject({ code: "drift" });
    const noEligibleRejected = await requeueCampaignFailed(db, campaignId, {
      expectedCount: 0,
      includeRejected: true,
      expectedRejectedCount: 0,
    });
    expect(noEligibleRejected.requeued).toBe(0);
    const drift = await app.inject({
      method: "POST",
      url: `/api/admin/campaigns/${campaignId}/requeue-failed`,
      payload: {
        expectedCount: 0,
        includeRejected: true,
        expectedRejectedCount: 2,
      },
    });
    expect(drift.statusCode).toBe(409);
  });

  it("refuses to downgrade the URANS rejected point into the ordinary campaign queue", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/campaigns/${campaignId}/requeue-failed`,
      payload: {
        expectedCount: 0,
        includeRejected: true,
        expectedRejectedCount: 1,
      },
    });
    expect(res.statusCode).toBe(409);

    // Re-claimable exactly like the failed path: point requested, result pending.
    const [point] = (await db.execute(sql`
      SELECT p.state, r.status
      FROM sim_campaign_points p JOIN results r ON r.id = p.result_id
      WHERE p.campaign_id = ${campaignId} AND p.aoa_deg = 0
    `)) as unknown as Array<{ state: string; status: string }>;
    expect(point.state).toBe("terminal");
    expect(point.status).toBe("done");

    const rejected = await campaignRejected(db, campaignId);
    expect(rejected.total).toBe(0);
    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals.rejected).toBe(1);
    expect(totals.remaining).toBe(0);
    const [camp] = (await db.execute(
      sql`SELECT status FROM sim_campaigns WHERE id = ${campaignId}`,
    )) as unknown as Array<{ status: string }>;
    expect(camp.status).toBe("attention");
  });

  it("new dedicated URANS evidence can still land and refresh classification in place", async () => {
    await db
      .update(results)
      .set({
        status: "done",
        source: "solved",
        regime: "urans",
        unsteady: true,
        stalled: true,
        converged: true,
        cl: 0.36,
        cd: 0.019,
      })
      .where(eq(results.id, rejectedResultId));
    await db.insert(forceHistory).values({
      resultId: rejectedResultId,
      t: [0, 0.1, 0.2, 0.3],
      cl: [0.33, 0.37, 0.35, 0.36],
      cd: [0.019, 0.021, 0.02, 0.02],
      cm: [-0.02, -0.02, -0.02, -0.02],
    });
    await db.insert(resultMedia).values({
      resultId: rejectedResultId,
      kind: "video",
      field: "velocity_magnitude",
      role: "instantaneous",
      storageKey: `jobs/${PREFIX}-rq/cases/c0/velocity_magnitude.mp4`,
      mimeType: "video/mp4",
      sha256: "3".repeat(64),
      byteSize: 4096,
    });
    await createExactResultAttemptFixture(db, rejectedResultId, {
      publication: "selected-eligible",
    });
    await onResultIngested(db, {
      airfoilId: rqAirfoilId,
      revisionId,
      aoaDeg: 0,
      resultId: rejectedResultId,
      status: "done",
    });
    await refreshPolarCacheForRevision(db, rqAirfoilId, revisionId);

    const [rc] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, rejectedResultId));
    expect(rc?.state).toBe("accepted"); // the requeued point comes back clean

    // Regime staleness must-catch (prod row 3db79ff8: regime='rans' stamped on
    // an accepted urans verdict): re-solve a formerly-RANS row as URANS and the
    // classification row updated IN PLACE must carry the new regime.
    const [rcBefore] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, ransResultId));
    expect(rcBefore?.regime).toBe("rans");
    await db
      .update(results)
      .set({ regime: "urans", unsteady: true, stalled: true, converged: true })
      .where(eq(results.id, ransResultId));
    await db.insert(forceHistory).values({
      resultId: ransResultId,
      t: [0, 0.1, 0.2, 0.3],
      cl: [0.38, 0.42, 0.4, 0.41],
      cd: [0.019, 0.021, 0.02, 0.02],
      cm: [-0.02, -0.02, -0.02, -0.02],
    });
    await db.insert(resultMedia).values({
      resultId: ransResultId,
      kind: "video",
      field: "velocity_magnitude",
      role: "instantaneous",
      storageKey: `jobs/${PREFIX}-rq/cases/c1/velocity_magnitude.mp4`,
      mimeType: "video/mp4",
      sha256: "4".repeat(64),
      byteSize: 4096,
    });
    await createExactResultAttemptFixture(db, ransResultId, {
      publication: "selected-eligible",
    });
    await refreshPolarCacheForRevision(db, rqAirfoilId, revisionId);
    const [rcAfter] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, ransResultId));
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

describe("machine-blocked campaign counters and symmetry conservation", () => {
  let campaignId = "";
  let conditionId = "";
  let revisionId = "";
  let bcId = "";
  let rejectedResultId = "";
  const BLOCKED_SPEED = 19.75 + FILE_SPEED_OFFSET_MPS;

  const expectPerConditionConservation = async () => {
    const summary = await campaignSummary(db, campaignId);
    const counters = summary.conditions.find(
      (condition) => condition.id === conditionId,
    )?.counters;
    expect(counters).toBeDefined();
    expect(
      counters!.solved +
        counters!.derived +
        counters!.failed +
        counters!.rejected +
        (counters!.blocked ?? 0) +
        counters!.remaining,
    ).toBe(counters!.requested);
    return summary;
  };

  it("keeps a rejected-source mirror open, then blocks source+mirror exactly when the physical obligation blocks", async () => {
    const launched = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} blocked symmetry`,
        priority: 5,
        idempotencyKey: `${PREFIX}-blocked-symmetry-key`,
        airfoilIds: [symId],
        plan: planBody({
          chordsM: [PRIMARY_CHORD_M],
          speedsMps: [BLOCKED_SPEED],
          baseSweep: { fromDeg: -1, toDeg: 1, stepDeg: 1, listDeg: null },
          objectives: {
            ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
            clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
            clMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
          },
        }),
      },
    });
    expect(launched.statusCode).toBe(201);
    campaignId = launched.json().campaign.id;
    cleanupCampaignIds.push(campaignId);
    const [condition] = (await db.execute(sql`
      SELECT cc.id, cc.simulation_preset_revision_id AS revision_id,
             preset.legacy_boundary_condition_id AS bc_id
      FROM sim_campaign_conditions cc
      JOIN simulation_presets preset ON preset.id = cc.preset_id
      WHERE cc.campaign_id = ${campaignId}
    `)) as unknown as Array<{
      id: string;
      revision_id: string;
      bc_id: string;
    }>;
    conditionId = condition.id;
    revisionId = condition.revision_id;
    bcId = condition.bc_id;

    const [rejected] = await db
      .insert(results)
      .values({
        airfoilId: symId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 1,
        status: "done",
        source: "solved",
        regime: "rans",
        converged: false,
        stalled: true,
        cl: 0.4,
        cd: 0.03,
        cm: 0,
      })
      .returning({ id: results.id });
    rejectedResultId = rejected.id;
    cleanupResultIds.push(rejected.id);
    await db.insert(resultClassifications).values({
      resultId: rejected.id,
      airfoilId: symId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 1,
      regime: "rans",
      classifierVersion: "blocked-counter-test-v1",
      state: "rejected",
      reasons: ["test-rejected"],
    });
    await onResultIngested(db, {
      airfoilId: symId,
      revisionId,
      aoaDeg: 1,
      resultId: rejected.id,
      status: "done",
      regime: "rans",
    });
    await db.transaction((tx) => recomputeCampaignProgress(tx, campaignId));

    let totals = await campaignProgressTotals(db, campaignId);
    expect(totals).toMatchObject({
      requested: 3,
      solved: 0,
      derived: 0,
      rejected: 1,
      blocked: 0,
      remaining: 2,
    });
    const rejectedWithoutWork = await expectPerConditionConservation();
    expect(rejectedWithoutWork.reviewBuckets).toEqual({
      awaitingUrans: 0,
      needsReview: 0,
    });

    const [obligation] = await ensurePrecalcObligations(
      db,
      [
        {
          airfoilId: symId,
          revisionId,
          aoaDeg: 1,
          sourceResultId: rejected.id,
        },
      ],
      { campaignIds: [campaignId] },
    );
    expect(obligation.state).toBe("pending");
    await db
      .update(simPrecalcObligations)
      .set({
        state: "blocked",
        attemptCount: 2,
        lastOutcome: "failed_exhausted",
        completedAt: new Date(),
      })
      .where(eq(simPrecalcObligations.id, obligation.id));
    await db.transaction((tx) => recomputeCampaignProgress(tx, campaignId));

    totals = await campaignProgressTotals(db, campaignId);
    expect(totals).toMatchObject({
      requested: 3,
      solved: 0,
      derived: 0,
      failed: 0,
      rejected: 0,
      blocked: 2,
      remaining: 1,
    });
    expect(
      totals.solved +
        totals.derived +
        totals.failed +
        totals.rejected +
        totals.blocked +
        totals.remaining,
    ).toBe(totals.requested);

    const summary = await expectPerConditionConservation();
    expect(summary.totals.blocked).toBe(2);
    expect(summary.conditions[0].counters.blocked).toBe(2);
    const matrix = await campaignAirfoilRows(db, campaignId);
    expect(matrix.items[0].perCondition[0].blocked).toBe(2);
    const listed = await listCampaigns(db, {
      statuses: ["active", "attention"],
      limit: 100,
    });
    expect(
      listed.items.find((item) => item.id === campaignId)?.totals.blocked,
    ).toBe(2);
  });

  it("excludes a released mirror from both requested and blocked", async () => {
    await db
      .update(simCampaignPoints)
      .set({ state: "released" })
      .where(
        and(
          eq(simCampaignPoints.campaignId, campaignId),
          eq(simCampaignPoints.conditionId, conditionId),
          eq(simCampaignPoints.airfoilId, symId),
          eq(simCampaignPoints.aoaDeg, -1),
        ),
      );
    await db.transaction((tx) => recomputeCampaignProgress(tx, campaignId));
    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals).toMatchObject({
      requested: 2,
      blocked: 1,
      remaining: 1,
    });
    await expectPerConditionConservation();
  });

  it("fails a terminal unclassified result closed as blocked and reaches terminal attention", async () => {
    const [unclassified] = await db
      .insert(results)
      .values({
        airfoilId: symId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 0,
        status: "done",
        source: "solved",
        regime: "rans",
        converged: true,
        stalled: false,
        cl: 0.1,
        cd: 0.02,
        cm: 0,
      })
      .returning({ id: results.id });
    cleanupResultIds.push(unclassified.id);
    await onResultIngested(db, {
      airfoilId: symId,
      revisionId,
      aoaDeg: 0,
      resultId: unclassified.id,
      status: "done",
      regime: "rans",
    });
    await db.transaction((tx) => recomputeCampaignProgress(tx, campaignId));
    const totals = await campaignProgressTotals(db, campaignId);
    expect(totals).toMatchObject({
      requested: 2,
      solved: 0,
      rejected: 0,
      blocked: 2,
      remaining: 0,
    });
    await expectPerConditionConservation();
    expect(deriveCampaignCompletion(totals)).toBe("attention");
    await db
      .update(simCampaigns)
      .set({ status: "active" })
      .where(eq(simCampaigns.id, campaignId));
    await probeCampaignCompletion(db, campaignId);
    const [campaign] = await db
      .select({ status: simCampaigns.status })
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignId));
    expect(campaign.status).toBe("attention");
  });
});

describe("auth hardening (§10)", () => {
  it("requires admin for campaign routes, PATCH /api/sweeper, and GET /api/sim-jobs in prod mode", async () => {
    process.env.ADMIN_AUTH_REQUIRED = "true";
    try {
      const campaignList = await app.inject({
        method: "GET",
        url: "/api/admin/campaigns",
      });
      expect(campaignList.statusCode).toBe(401);
      const launch = await app.inject({
        method: "POST",
        url: "/api/admin/campaigns",
        payload: {},
      });
      expect(launch.statusCode).toBe(401);
      const sweeperPatch = await app.inject({
        method: "PATCH",
        url: "/api/sweeper",
        payload: { enabled: false },
      });
      expect(sweeperPatch.statusCode).toBe(401);
      const simJobs = await app.inject({ method: "GET", url: "/api/sim-jobs" });
      expect(simJobs.statusCode).toBe(401);
      // Public status read stays open (no campaign metadata in it).
      const sweeperGet = await app.inject({
        method: "GET",
        url: "/api/sweeper",
      });
      expect(sweeperGet.statusCode).toBe(200);
    } finally {
      delete process.env.ADMIN_AUTH_REQUIRED;
    }
  });
});

describe("same-α fit refreshes do not append duplicate lane steps (laneTick churn must-catch)", () => {
  // Prod 2026-07-09 (clarky ld_max Re 3.4M): tier-2 ingest re-derived the
  // best fit after every result, and although the predicted α never moved,
  // every refresh appended ANOTHER identical step — twelve duplicate 7.67°
  // rows later swept to 'superseded' in one go. The lane step table is
  // append-only EVIDENCE of target movement, not a fit-refresh log.
  const CHURN_SPEED = 14 + FILE_SPEED_OFFSET_MPS; // file-unique physics revision
  let campaignId = "";
  let conditionId = "";
  let revisionId = "";
  const fitIds: string[] = [];

  const stepsQuery = async () =>
    (await db.execute(sql`
      SELECT iteration, predicted_alpha, outcome FROM sim_campaign_lane_steps
      WHERE campaign_id = ${campaignId} AND airfoil_id = ${symId}
        AND condition_id = ${conditionId} AND objective = 'ld_max'
      ORDER BY iteration
    `)) as unknown as Array<{
      iteration: number;
      predicted_alpha: number | string;
      outcome: string;
    }>;

  const insertCurrentFit = async (alphaLdmaxFine: number, sig: string) => {
    if (fitIds.length) {
      await db.execute(
        sql`UPDATE polar_fit_sets SET is_current = false WHERE id = ANY(${`{${fitIds.join(",")}}`}::uuid[])`,
      );
    }
    const [fit] = await db
      .insert(polarFitSets)
      .values({
        airfoilId: symId,
        simulationPresetRevisionId: revisionId,
        fitVersion: POLAR_FIT_VERSION,
        evidenceSignature: `${PREFIX}-${sig}`,
        status: "final",
        confidence: 0.9,
        acceptedPointCount: 5,
        provisionalPointCount: 0,
        rejectedPointCount: 0,
        alphaLdmaxFine,
        isCurrent: true,
      })
      .returning({ id: polarFitSets.id });
    fitIds.push(fit.id);
    return fit.id;
  };

  afterAll(async () => {
    if (fitIds.length) {
      await db.execute(
        sql`DELETE FROM sim_campaign_lane_steps WHERE fit_set_id = ANY(${`{${fitIds.join(",")}}`}::uuid[])`,
      );
      await db.delete(polarFitSets).where(inArray(polarFitSets.id, fitIds));
    }
  });

  it("appends the first prediction step and enqueues the point", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} step churn`,
        priority: 5,
        idempotencyKey: `${PREFIX}-key-churn`,
        airfoilIds: [symId],
        plan: planBody({
          chordsM: [PRIMARY_CHORD_M],
          speedsMps: [CHURN_SPEED],
          objectives: {
            ldMax: { enabled: true, toleranceDeg: 0.1, maxRounds: 4 },
            clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
            clMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
          },
        }),
      },
    });
    expect(res.statusCode).toBe(201);
    campaignId = res.json().campaign.id;
    cleanupCampaignIds.push(campaignId);
    const [condition] = (await db.execute(sql`
      SELECT id, simulation_preset_revision_id AS revision_id FROM sim_campaign_conditions WHERE campaign_id = ${campaignId}
    `)) as unknown as Array<{ id: string; revision_id: string }>;
    conditionId = condition.id;
    revisionId = condition.revision_id;

    await insertCurrentFit(3.42, "churn-a");
    const result = await laneTick(db, {
      campaignId,
      airfoilId: symId,
      conditionId,
      objective: "ld_max",
    });
    expect(result).not.toBeNull();
    const steps = await stepsQuery();
    expect(steps.map((s) => [Number(s.predicted_alpha), s.outcome])).toEqual([
      [3.42, "predicted"],
    ]);
  });

  it("MUST-CATCH: a refreshed fit with an unmoved target appends nothing and supersedes nothing", async () => {
    await insertCurrentFit(3.42, "churn-b"); // new fit id, same argmax
    const result = await laneTick(db, {
      campaignId,
      airfoilId: symId,
      conditionId,
      objective: "ld_max",
    });
    expect(result).not.toBeNull();
    const steps = await stepsQuery();
    // pre-fix behavior: a second identical 3.42° row appears here
    expect(steps.map((s) => [Number(s.predicted_alpha), s.outcome])).toEqual([
      [3.42, "predicted"],
    ]);
  });

  it("a genuinely moved target appends and supersedes the stale prediction", async () => {
    await insertCurrentFit(4.1, "churn-c");
    const result = await laneTick(db, {
      campaignId,
      airfoilId: symId,
      conditionId,
      objective: "ld_max",
    });
    expect(result).not.toBeNull();
    const steps = await stepsQuery();
    expect(steps.map((s) => [Number(s.predicted_alpha), s.outcome])).toEqual([
      [3.42, "superseded"],
      [4.1, "predicted"],
    ]);
  });

  it("converges through a same-α fit refresh (target stability, not fit-id identity)", async () => {
    // Terminal-link every open lane point with accepted evidence (3.42 from
    // the first prediction, 4.1 from the move), then refresh the fit AGAIN
    // with the SAME 4.1 argmax — under the old fit-id equality test the lane
    // could never converge once same-α refreshes stopped appending steps.
    const [preset] = (await db.execute(sql`
      SELECT p.legacy_boundary_condition_id AS bc_id
      FROM sim_campaign_conditions cc JOIN simulation_presets p ON p.id = cc.preset_id
      WHERE cc.id = ${conditionId}
    `)) as unknown as Array<{ bc_id: string }>;
    const openPoints = (await db.execute(sql`
      SELECT aoa_deg FROM sim_campaign_points
      WHERE campaign_id = ${campaignId} AND condition_id = ${conditionId} AND airfoil_id = ${symId}
        AND state NOT IN ('terminal')
    `)) as unknown as Array<{ aoa_deg: number | string }>;
    for (const p of openPoints) {
      const aoa = Number(p.aoa_deg);
      const [row] = await db
        .insert(results)
        .values({
          airfoilId: symId,
          bcId: preset.bc_id,
          simulationPresetRevisionId: revisionId,
          aoaDeg: aoa,
          status: "done",
          source: "solved",
          regime: "rans",
          converged: true,
          stalled: false,
          cl: 0.1 * aoa,
          cd: 0.01,
          cm: -0.01,
        })
        .returning({ id: results.id });
      cleanupResultIds.push(row.id);
      await db.insert(resultClassifications).values({
        resultId: row.id,
        airfoilId: symId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: aoa,
        regime: "rans",
        classifierVersion: "test-fixture",
        state: "accepted",
        region: "attached",
        confidence: 0.9,
      });
      await onResultIngested(db, {
        airfoilId: symId,
        revisionId,
        aoaDeg: aoa,
        resultId: row.id,
        status: "done",
      });
    }

    await insertCurrentFit(4.1, "churn-d"); // fourth fit id, unmoved argmax
    const result = await laneTick(db, {
      campaignId,
      airfoilId: symId,
      conditionId,
      objective: "ld_max",
    });
    expect(result).not.toBeNull();
    expect(result!.state).toBe("converged_final");
    // and the refresh still appended nothing
    const steps = await stepsQuery();
    expect(steps.length).toBe(2);
  });
});
