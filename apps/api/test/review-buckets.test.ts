// Bucket-predicate MATRIX for the amendment-A semantic split (approved design
// c19fd74a): awaiting_urans vs needs_review, derived from the canonical rule
//   awaiting_urans = rejected AND fidelity 'rans'
//   needs_review   = failed OR (rejected AND fidelity urans_* AND nothing
//                    further scheduled: no open verify item, no open
//                    request-URANS item covering the cell)
// plus the amendment-C `continuable` flag (budget-stop marker + saved case
// state addressing).
//
// One campaign, eight cells — every predicate arm gets a dedicated cell, and
// the matrix is asserted through EVERY payload surface that ships the split:
//   campaignReviewBuckets / campaignSummary / campaignAirfoilRows /
//   listCampaigns (db read models) and the Points tab API (filters, counts,
//   reviewBucket + continuable item fields, story payload). The final test
//   flips the "nothing further scheduled" inputs (verify item settles, request
//   settles) and asserts the buckets MOVE — recall, not just precision.
//
// Shared-database integration suite (point-history.test.ts harness pattern).
import { type Point } from "@aerodb/core";
import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  campaignAirfoilRows,
  campaignReviewBuckets,
  campaignSummary,
  categories,
  listCampaigns,
  mediums,
  meshProfiles,
  onResultIngested,
  outputProfiles,
  simCampaignPoints,
  recomputeProgressForCampaign,
  resultClassifications,
  results,
  simCampaigns,
  simulationPresets,
  simUransRequests,
  simUransVerifyQueue,
  solverProfiles,
  sweepDefinitions,
} from "@aerodb/db";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, sql as pgClient } from "../src/db";
import { sql } from "drizzle-orm";
import { buildServer } from "../src/server";

const PREFIX = `pw-revbuck-${Date.now().toString(36)}`;
// Unique speed → unique physics hash → this campaign pins its own revision.
const SPEED = 13.35;

const BUDGET_STOP_WARNING =
  "URANS integration stopped by the wall-clock budget guard: retained 1.6 of 3 periods (budget); projected 2.9h continuation exceeds 80% of the 2.0h solver timeout";

const camberedPoints: Point[] = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

let app: Awaited<ReturnType<typeof buildServer>>;
let airfoilId = "";
let categoryId = "";
let mediumId = "";
let campaignId = "";
let conditionId = "";
let revisionId = "";
let bcId = "";
let verifyItemId = "";
let openRequestId = "";
const numerics = { boundaryProfileId: "", meshProfileId: "", solverProfileId: "", outputProfileId: "" };
const cleanupResultIds: string[] = [];
const resultIdByAoa = new Map<number, string>();

const listUrl = (params: Record<string, string>) => `/api/admin/point-history?${new URLSearchParams(params).toString()}`;

beforeAll(async () => {
  app = await buildServer();
  const [cat] = await db
    .insert(categories)
    .values({ slug: `${PREFIX}-cat`, name: `${PREFIX} cat`, path: `${PREFIX}-cat`, depth: 0 })
    .returning();
  categoryId = cat.id;
  const [af] = await db
    .insert(airfoils)
    .values({ slug: `${PREFIX}-af`, name: `${PREFIX} Bucket Foil`, categoryId, points: camberedPoints, isSymmetric: false })
    .returning();
  airfoilId = af.id;
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
  const [boundary] = await db.insert(boundaryProfiles).values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` }).returning();
  const [mesh] = await db.insert(meshProfiles).values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` }).returning();
  const [solver] = await db.insert(solverProfiles).values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` }).returning();
  const [output] = await db.insert(outputProfiles).values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` }).returning();
  numerics.boundaryProfileId = boundary.id;
  numerics.meshProfileId = mesh.id;
  numerics.solverProfileId = solver.id;
  numerics.outputProfileId = output.id;

  const res = await app.inject({
    method: "POST",
    url: "/api/admin/campaigns",
    payload: {
      name: `${PREFIX} bucket campaign`,
      priority: 5,
      idempotencyKey: `${PREFIX}-key`,
      airfoilIds: [airfoilId],
      plan: {
        mediumId,
        ambients: [[288.15, 101325]],
        speedsMps: [SPEED],
        chordsM: [0.2],
        spanM: 1,
        areaMode: "derived",
        excludedConditions: [],
        baseSweep: { fromDeg: -2, toDeg: 5, stepDeg: 1, listDeg: null },
        objectives: {
          ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
          clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
        },
        numerics,
      },
    },
  });
  expect(res.statusCode).toBe(201);
  campaignId = res.json().campaign.id;

  const [cond] = (await db.execute(sql`
    SELECT cc.id, cc.simulation_preset_revision_id AS revision_id, p.legacy_boundary_condition_id AS bc_id
    FROM sim_campaign_conditions cc
    JOIN simulation_presets p ON p.id = cc.preset_id
    WHERE cc.campaign_id = ${campaignId}
  `)) as unknown as Array<{ id: string; revision_id: string; bc_id: string }>;
  conditionId = cond.id;
  revisionId = cond.revision_id;
  bcId = cond.bc_id;

  const insertResult = async (v: Record<string, unknown>) => {
    const [row] = await db
      .insert(results)
      .values(v as never)
      .returning({ id: results.id });
    cleanupResultIds.push(row.id);
    resultIdByAoa.set(v.aoaDeg as number, row.id);
    await onResultIngested(db, {
      airfoilId,
      revisionId,
      aoaDeg: v.aoaDeg as number,
      resultId: row.id,
      status: v.status as string,
      regime: (v.regime as "rans" | "urans" | null) ?? null,
    });
    return row.id;
  };
  const classify = async (resultId: string, aoaDeg: number, regime: "rans" | "urans", state: string, reasons: string[]) => {
    await db.insert(resultClassifications).values({
      resultId,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      regime,
      classifierVersion: "test-v1",
      state: state as never,
      reasons,
      confidence: 0.9,
    });
  };
  const base = { airfoilId, bcId, simulationPresetRevisionId: revisionId, reynolds: 183000, solvedAt: new Date() };

  // aoa +2 — done ACCEPTED rans: in neither bucket.
  const okId = await insertResult({ ...base, aoaDeg: 2, status: "done", source: "solved", regime: "rans", fidelity: "rans", converged: true, cl: 0.6, cd: 0.012 });
  await classify(okId, 2, "rans", "accepted", []);
  // aoa +1 — done REJECTED at fidelity 'rans': awaiting_urans (violet).
  const awaitingId = await insertResult({ ...base, aoaDeg: 1, status: "done", source: "solved", regime: "rans", fidelity: "rans", converged: false, stalled: true, cl: 0.4, cd: 0.03 });
  await classify(awaitingId, 1, "rans", "rejected", ["not-converged"]);
  // aoa 0 — FAILED: needs_review (crash class).
  await insertResult({ ...base, aoaDeg: 0, status: "failed", source: "queued", regime: "rans", fidelity: "rans", error: "solver crashed: NaN residual", solvedAt: null });
  // aoa −1 — REJECTED urans_precalc, budget-stopped, saved case state, nothing
  // scheduled: needs_review AND continuable.
  const contId = await insertResult({
    ...base,
    aoaDeg: -1,
    status: "done",
    source: "solved",
    regime: "urans",
    fidelity: "urans_precalc",
    converged: true,
    unsteady: true,
    cl: 0.7,
    cd: 0.06,
    engineJobId: `${PREFIX}-budget-engine`,
    engineCaseSlug: "aoa_-1.00",
    qualityWarnings: [BUDGET_STOP_WARNING],
  });
  await classify(contId, -1, "urans", "rejected", ["insufficient-periods"]);
  // aoa +3 — REJECTED urans_precalc with an OPEN verify item: still scheduled,
  // so NEITHER refined bucket (stays in the deprecated 'rejected' alias only).
  const verifyCoveredId = await insertResult({ ...base, aoaDeg: 3, status: "done", source: "solved", regime: "urans", fidelity: "urans_precalc", converged: true, unsteady: true, cl: 0.8, cd: 0.05 });
  await classify(verifyCoveredId, 3, "urans", "rejected", ["non-stationary"]);
  const [verifyItem] = await db
    .insert(simUransVerifyQueue)
    .values({ airfoilId, revisionId, aoaDeg: 3, campaignId, state: "pending", precalcResultId: verifyCoveredId })
    .returning({ id: simUransVerifyQueue.id });
  verifyItemId = verifyItem.id;
  // aoa +4 — REJECTED urans_full with an OPEN request-URANS item: scheduled,
  // neither refined bucket.
  const requestCoveredId = await insertResult({ ...base, aoaDeg: 4, status: "done", source: "solved", regime: "urans", fidelity: "urans_full", converged: true, unsteady: true, cl: 0.85, cd: 0.055 });
  await classify(requestCoveredId, 4, "urans", "rejected", ["missing-urans-video"]);
  const [openRequest] = await db
    .insert(simUransRequests)
    .values({ airfoilId, revisionId, aoaDeg: 4, fidelity: "full", state: "pending" })
    .returning({ id: simUransRequests.id });
  openRequestId = openRequest.id;
  // aoa +5 — REJECTED urans_full, nothing scheduled, NO budget marker, no
  // case addressing: needs_review but NOT continuable.
  const deadEndId = await insertResult({ ...base, aoaDeg: 5, status: "done", source: "solved", regime: "urans", fidelity: "urans_full", converged: false, unsteady: true, cl: 0.2, cd: 0.09 });
  await classify(deadEndId, 5, "urans", "rejected", ["not-converged"]);
  // aoa −2 stays requested (open) — never bucketed.

  // The seed classifies AFTER each terminal-link, so the last cell's verdict
  // post-dates its counter recompute — refresh the stored counters the way the
  // sweeper's post-refresh settle does before asserting against them.
  await recomputeProgressForCampaign(db, campaignId);
}, 60_000);

afterAll(async () => {
  if (verifyItemId) await db.delete(simUransVerifyQueue).where(eq(simUransVerifyQueue.id, verifyItemId));
  await db.delete(simUransRequests).where(eq(simUransRequests.revisionId, revisionId));
  if (cleanupResultIds.length) {
    await db.delete(resultClassifications).where(inArray(resultClassifications.resultId, cleanupResultIds));
    await db.delete(results).where(inArray(results.id, cleanupResultIds));
  }
  if (campaignId) await db.delete(simCampaigns).where(eq(simCampaigns.id, campaignId));
  const presets = await db
    .select({ id: simulationPresets.id, legacyId: simulationPresets.legacyBoundaryConditionId })
    .from(simulationPresets)
    .where(like(simulationPresets.slug, `campaign-${PREFIX}-%`));
  if (presets.length) {
    await db.delete(simulationPresets).where(inArray(simulationPresets.id, presets.map((p) => p.id)));
    const legacyIds = presets.map((p) => p.legacyId).filter((x): x is string => Boolean(x));
    if (legacyIds.length) await db.delete(boundaryConditions).where(inArray(boundaryConditions.id, legacyIds));
  }
  await db.delete(sweepDefinitions).where(like(sweepDefinitions.slug, `campaign-${PREFIX}-%`));
  await db.execute(sql`DELETE FROM flow_conditions WHERE medium_id = ${mediumId}`);
  // Reference-guarded mop-up (F9 FK flake shape): geometry rows are
  // find-or-create deduped across suites.
  await db.execute(sql`
    DELETE FROM reference_geometry_profiles rgp
    WHERE rgp.origin = 'campaign' AND rgp.slug LIKE 'chord-0-2000m-span-1-0000m%' AND rgp.created_by_campaign_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM simulation_presets sp WHERE sp.reference_geometry_profile_id = rgp.id)
      AND NOT EXISTS (SELECT 1 FROM sim_campaign_conditions scc WHERE scc.reference_geometry_profile_id = rgp.id)
  `);
  await db.execute(sql`DELETE FROM boundary_profiles WHERE slug = ${`${PREFIX}-boundary`}`);
  await db.execute(sql`DELETE FROM mesh_profiles WHERE slug = ${`${PREFIX}-mesh`}`);
  await db.execute(sql`DELETE FROM solver_profiles WHERE slug = ${`${PREFIX}-solver`}`);
  await db.execute(sql`DELETE FROM output_profiles WHERE slug = ${`${PREFIX}-output`}`);
  await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
  await db.delete(categories).where(eq(categories.id, categoryId));
  await db.delete(mediums).where(eq(mediums.id, mediumId));
  await app.close();
  await pgClient.end();
});

describe("campaign payloads: awaitingUrans / needsReview derived from the canonical rule", () => {
  it("campaignReviewBuckets: awaiting=1 (rans reject), needsReview=3 (failed + 2 unscheduled urans rejects)", async () => {
    const buckets = await campaignReviewBuckets(db, campaignId);
    expect(buckets).toEqual({ awaitingUrans: 1, needsReview: 3 });
  });

  it("MUST-CATCH (count = click-through): a derived symmetry mirror of a failed source does NOT inflate needsReview", async () => {
    // Real breakage shape: symmetric airfoil, +α source failed → its −α mirror
    // point is terminal too and shares the SOURCE results row. The red chip
    // counts campaign points, the Points tab lists source results rows only —
    // a double-counted mirror makes the chip exceed its click-through list.
    const failedSourceResultId = resultIdByAoa.get(0)!;
    const [planPoint] = await db
      .select({ planRevisionNumber: simCampaignPoints.planRevisionNumber })
      .from(simCampaignPoints)
      .where(eq(simCampaignPoints.campaignId, campaignId))
      .limit(1);
    await db.insert(simCampaignPoints).values({
      campaignId,
      conditionId,
      airfoilId,
      aoaDeg: -30, // outside the plan sweep: collides with nothing
      revisionId,
      planRevisionNumber: planPoint.planRevisionNumber,
      state: "terminal",
      resultId: failedSourceResultId,
      derivedBySymmetry: true,
    });
    try {
      const buckets = await campaignReviewBuckets(db, campaignId);
      expect(buckets).toEqual({ awaitingUrans: 1, needsReview: 3 }); // NOT 4
      // The chip's click-through (Points tab needs_review filter) also shows 3.
      const res = await app.inject({ method: "GET", url: listUrl({ campaignId, status: "needs_review" }) });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { items: unknown[] }).items.length).toBe(3);
    } finally {
      await db.execute(sql`DELETE FROM sim_campaign_points WHERE campaign_id = ${campaignId} AND aoa_deg = -30`);
    }
  });

  it("campaignSummary ships the split at campaign AND condition level", async () => {
    const summary = await campaignSummary(db, campaignId);
    expect(summary.reviewBuckets).toEqual({ awaitingUrans: 1, needsReview: 3 });
    expect(summary.conditions.length).toBe(1);
    expect(summary.conditions[0].reviewBuckets).toEqual({ awaitingUrans: 1, needsReview: 3 });
    // The split partitions consistently with the legacy counters it refines:
    // rejected(5) = awaiting(1) + urans-unscheduled(2) + still-scheduled(2).
    expect(summary.totals.rejected).toBe(5);
    expect(summary.totals.failed).toBe(1);
  });

  it("campaignAirfoilRows (coverage matrix) carries the per-cell split", async () => {
    const { items } = await campaignAirfoilRows(db, campaignId, {});
    expect(items.length).toBe(1);
    const cell = items[0].perCondition.find((c) => c.conditionId === conditionId)!;
    expect(cell.awaitingUrans).toBe(1);
    expect(cell.needsReview).toBe(3);
    expect(cell.rejected).toBe(5);
  });

  it("listCampaigns items carry reviewBuckets", async () => {
    const { items } = await listCampaigns(db, { limit: 100 });
    const item = items.find((c) => c.id === campaignId)!;
    expect(item).toBeTruthy();
    expect(item.reviewBuckets).toEqual({ awaitingUrans: 1, needsReview: 3 });
  });
});

describe("Points tab API: awaiting_urans / needs_review filters, deprecated alias, continuable flag", () => {
  it("status=awaiting_urans returns exactly the rans reject, labelled with its reviewBucket", async () => {
    const res = await app.inject({ method: "GET", url: listUrl({ campaignId, status: "awaiting_urans" }) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ aoaDeg: number; reviewBucket: string | null; continuable: boolean }> };
    expect(body.items.map((i) => i.aoaDeg)).toEqual([1]);
    expect(body.items[0].reviewBucket).toBe("awaiting_urans");
    expect(body.items[0].continuable).toBe(false);
  });

  it("status=needs_review returns the failed point + both unscheduled urans rejects; ONLY the budget-stopped one is continuable", async () => {
    const res = await app.inject({ method: "GET", url: listUrl({ campaignId, status: "needs_review" }) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ aoaDeg: number; reviewBucket: string | null; continuable: boolean }> };
    expect(body.items.map((i) => i.aoaDeg).sort((a, b) => a - b)).toEqual([-1, 0, 5]);
    expect(body.items.every((i) => i.reviewBucket === "needs_review")).toBe(true);
    const byAoa = new Map(body.items.map((i) => [i.aoaDeg, i]));
    expect(byAoa.get(-1)!.continuable).toBe(true); // budget marker + case state
    expect(byAoa.get(0)!.continuable).toBe(false); // crash, nothing saved
    expect(byAoa.get(5)!.continuable).toBe(false); // rejected, no budget stop
  });

  it("deprecated status=rejected alias still matches EVERY done+rejected row (scheduled ones included)", async () => {
    const res = await app.inject({ method: "GET", url: listUrl({ campaignId, status: "rejected" }) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ aoaDeg: number; reviewBucket: string | null }> };
    expect(body.items.map((i) => i.aoaDeg).sort((a, b) => a - b)).toEqual([-1, 1, 3, 4, 5]);
    // Scheduled urans rejects are in NEITHER refined bucket.
    const byAoa = new Map(body.items.map((i) => [i.aoaDeg, i]));
    expect(byAoa.get(3)!.reviewBucket).toBeNull();
    expect(byAoa.get(4)!.reviewBucket).toBeNull();
  });

  it("counts expose the split alongside the legacy chips", async () => {
    const res = await app.inject({ method: "GET", url: listUrl({ campaignId }) });
    expect(res.statusCode).toBe(200);
    const counts = (res.json() as { counts: Record<string, number> }).counts;
    expect(counts.awaiting_urans).toBe(1);
    expect(counts.needs_review).toBe(3);
    expect(counts.rejected).toBe(5);
    expect(counts.failed).toBe(1);
    expect(counts.accepted).toBe(1);
  });

  it("story payload carries reviewBucket + continuable", async () => {
    const contRes = await app.inject({ method: "GET", url: `/api/admin/point-history/${resultIdByAoa.get(-1)}/story` });
    expect(contRes.statusCode).toBe(200);
    const cont = contRes.json() as { point: { reviewBucket: string | null; continuable: boolean; qualityWarnings: string[] } };
    expect(cont.point.reviewBucket).toBe("needs_review");
    expect(cont.point.continuable).toBe(true);
    expect(cont.point.qualityWarnings.some((w) => w.includes("stopped by the wall-clock budget guard"))).toBe(true);

    const awaitingRes = await app.inject({ method: "GET", url: `/api/admin/point-history/${resultIdByAoa.get(1)}/story` });
    expect(awaitingRes.statusCode).toBe(200);
    const awaiting = awaitingRes.json() as { point: { reviewBucket: string | null; continuable: boolean } };
    expect(awaiting.point.reviewBucket).toBe("awaiting_urans");
    expect(awaiting.point.continuable).toBe(false);
  });

  it("RECALL MUST-CATCH: settling the verify item and the open request MOVES their cells into needs_review", async () => {
    // The real-world shape: a verify solve gets cancelled (item settles) and
    // an admin request completes without replacing the rejected evidence —
    // "nothing further scheduled" must now be TRUE for aoa 3 and 4.
    await db.update(simUransVerifyQueue).set({ state: "cancelled" }).where(eq(simUransVerifyQueue.id, verifyItemId));
    await db.update(simUransRequests).set({ state: "done" }).where(eq(simUransRequests.id, openRequestId));

    const buckets = await campaignReviewBuckets(db, campaignId);
    expect(buckets).toEqual({ awaitingUrans: 1, needsReview: 5 });

    const res = await app.inject({ method: "GET", url: listUrl({ campaignId, status: "needs_review" }) });
    const body = res.json() as { items: Array<{ aoaDeg: number }>; counts: Record<string, number> };
    expect(body.items.map((i) => i.aoaDeg).sort((a, b) => a - b)).toEqual([-1, 0, 3, 4, 5]);
    expect(body.counts.needs_review).toBe(5);
  });
});
