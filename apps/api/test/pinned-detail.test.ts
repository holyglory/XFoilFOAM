// Pinned-revision detail scope — campaign presets are disabled by design so
// that they cannot schedule work independently, but their immutable campaign
// conditions still anchor real evidence on the unpinned public Detail page.
// This also preserves the admin journey's exact pinned-revision view.
//
// MUST-CATCH #1: assembleDetail(slug, { revisionId }) must surface the
// disabled-preset campaign evidence — this test fails if the pinned scope
// regresses (e.g. the scoped branch starts honoring preset.enabled again).
// The unpinned assertion guards the public campaign-evidence contract without
// leaking campaign/preset metadata as polar labels.
//
// MUST-CATCH #2: the admin queue payload must carry the job's setup revision
// (AdminJob.revisionId) so admin evidence links can pin it — single-revision
// jobs expose the revision, multi-revision batched jobs expose null (a
// multi-revision batch has no single pinned view).
//
// Shared-database integration test (campaigns.test.ts harness rules): rows
// are prefixed and deleted in afterAll.
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
  resultAttempts,
  resultClassifications,
  results,
  schedulingProfiles,
  simCampaignConditions,
  simCampaignPlanRevisions,
  simCampaigns,
  simJobs,
  simulationPresetRevisions,
  simulationPresets,
  solverProfiles,
  sweepDefinitions,
} from "@aerodb/db";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const PREFIX = `pw-pinned-${Date.now().toString(36)}`;
// Deliberately non-catalog Reynolds so no enabled dev preset collides.
const CAMPAIGN_RE = 333333;

let db: (typeof import("../src/db"))["db"];
let pgClient: (typeof import("../src/db"))["sql"];
let assembleDetail: (typeof import("../src/services/detail"))["assembleDetail"];
let app: Awaited<ReturnType<(typeof import("../src/server"))["buildServer"]>>;

const cleanup = {
  resultIds: [] as string[],
  classificationIds: [] as string[],
  jobIds: [] as string[],
  campaignIds: [] as string[],
  presetIds: [] as string[],
  bcIds: [] as string[],
  flowIds: [] as string[],
  refGeoIds: [] as string[],
  boundaryIds: [] as string[],
  meshIds: [] as string[],
  solverIds: [] as string[],
  schedulingIds: [] as string[],
  outputIds: [] as string[],
  sweepIds: [] as string[],
  airfoilIds: [] as string[],
  categoryIds: [] as string[],
};

/** Campaign-style DISABLED preset + revision (campaign presets are disabled
 *  by design — the whole point of the pinned scope). */
async function createDisabledPresetRevision(unique: string, reynolds: number) {
  const [air] = await db
    .select()
    .from(mediums)
    .where(eq(mediums.slug, "air"))
    .limit(1);
  expect(air).toBeTruthy();
  const speed =
    Math.round(reynolds * air.kinematicViscosity * 1_000_000) / 1_000_000;
  const [bc] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${unique}-bc`,
      name: `${unique} BC`,
      mediumId: air.id,
      reynolds,
      referenceChordM: 1,
      temperatureK: air.refTemperatureK,
      pressurePa: air.refPressurePa,
      speedMps: speed,
    })
    .returning({ id: boundaryConditions.id });
  cleanup.bcIds.push(bc.id);
  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${unique}-flow`,
      name: `${unique} Flow`,
      mediumId: air.id,
      temperatureK: air.refTemperatureK,
      pressurePa: air.refPressurePa,
      speedMps: speed,
      density: air.density,
      dynamicViscosity: air.dynamicViscosity,
      kinematicViscosity: air.kinematicViscosity,
      mach: air.speedOfSound ? speed / air.speedOfSound : null,
    })
    .returning({ id: flowConditions.id });
  cleanup.flowIds.push(flow.id);
  const [refGeo] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${unique}-refgeo`,
      name: `${unique} RefGeo`,
      geometryType: "airfoil_2d",
      referenceLengthKind: "chord",
      referenceLengthM: 1,
    })
    .returning({ id: referenceGeometryProfiles.id });
  cleanup.refGeoIds.push(refGeo.id);
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({
      slug: `${unique}-boundary`,
      name: `${unique} Boundary`,
      turbulenceIntensity: 0.001,
      viscosityRatio: 10,
    })
    .returning({ id: boundaryProfiles.id });
  cleanup.boundaryIds.push(boundary.id);
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${unique}-mesh`, name: `${unique} Mesh` })
    .returning({ id: meshProfiles.id });
  cleanup.meshIds.push(mesh.id);
  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${unique}-solver`, name: `${unique} Solver` })
    .returning({ id: solverProfiles.id });
  cleanup.solverIds.push(solver.id);
  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({ slug: `${unique}-scheduling`, name: `${unique} Scheduling` })
    .returning({ id: schedulingProfiles.id });
  cleanup.schedulingIds.push(scheduling.id);
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${unique}-output`, name: `${unique} Output` })
    .returning({ id: outputProfiles.id });
  cleanup.outputIds.push(output.id);
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({
      slug: `${unique}-sweep`,
      name: `${unique} Sweep`,
      aoaStart: -8,
      aoaStop: 20,
      aoaStep: 1,
    })
    .returning({ id: sweepDefinitions.id });
  cleanup.sweepIds.push(sweep.id);
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${unique}-preset`,
      name: `${unique} Preset`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: refGeo.id,
      boundaryProfileId: boundary.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      schedulingProfileId: scheduling.id,
      outputProfileId: output.id,
      sweepDefinitionId: sweep.id,
      legacyBoundaryConditionId: bc.id,
      enabled: false, // ← campaign presets are disabled by design
    })
    .returning({ id: simulationPresets.id });
  cleanup.presetIds.push(preset.id);
  const resolved = await ensureSimulationPresetRevision(db, preset.id);
  expect(resolved).toBeTruthy();
  return {
    bcId: bc.id,
    flowConditionId: flow.id,
    referenceGeometryProfileId: refGeo.id,
    presetId: preset.id,
    revisionId: resolved!.revision.id,
  };
}

let airfoilId = "";
let airfoilSlug = "";
let revisionA = "";
let revisionB = "";
let resultId = "";
let singleJobId = "";
let batchedJobId = "";

beforeAll(async () => {
  // Env BEFORE the dynamic server import (src/env snapshots at module load):
  // dev-open admin auth; engine on a closed port — every probe fails fast and
  // is race-capped, and this suite never talks to a live engine.
  process.env.ADMIN_AUTH_DISABLED = "true";
  process.env.ENGINE_URL = "http://127.0.0.1:9";

  const [dbModule, detailModule, serverModule] = await Promise.all([
    import("../src/db"),
    import("../src/services/detail"),
    import("../src/server"),
  ]);
  db = dbModule.db;
  pgClient = dbModule.sql;
  assembleDetail = detailModule.assembleDetail;
  app = await serverModule.buildServer();

  const [cat] = await db
    .insert(categories)
    .values({
      slug: PREFIX,
      name: `${PREFIX} cat`,
      path: PREFIX,
      depth: 0,
      sortOrder: 997,
    })
    .returning({ id: categories.id });
  cleanup.categoryIds.push(cat.id);

  airfoilSlug = `${PREFIX}-af`;
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: airfoilSlug,
      name: `${PREFIX} airfoil`,
      categoryId: cat.id,
      source: "test",
      points: [
        { x: 1, y: 0 },
        { x: 0.5, y: 0.08 },
        { x: 0, y: 0 },
        { x: 0.5, y: -0.04 },
        { x: 1, y: 0 },
      ],
      tags: [],
    })
    .returning({ id: airfoils.id });
  airfoilId = airfoil.id;
  cleanup.airfoilIds.push(airfoil.id);

  const setupA = await createDisabledPresetRevision(`${PREFIX}-a`, CAMPAIGN_RE);
  const setupB = await createDisabledPresetRevision(
    `${PREFIX}-b`,
    CAMPAIGN_RE + 111,
  );
  revisionA = setupA.revisionId;
  revisionB = setupB.revisionId;

  // Campaign-generated presets are disabled execution records, not private
  // polar visibility. Their immutable condition pin is the public anchor;
  // the campaign itself is already completed so no scheduling can result from
  // this read-path fixture.
  const [campaign] = await db
    .insert(simCampaigns)
    .values({
      slug: `${PREFIX}-campaign`,
      name: `${PREFIX} campaign`,
      status: "completed",
      priority: 5,
      idempotencyKey: `${PREFIX}-campaign`,
    })
    .returning({ id: simCampaigns.id });
  cleanup.campaignIds.push(campaign.id);
  const [plan] = await db
    .insert(simCampaignPlanRevisions)
    .values({
      campaignId: campaign.id,
      revisionNumber: 1,
      kind: "initial",
      plan: {},
      summary: {},
    })
    .returning({ id: simCampaignPlanRevisions.id });
  await db
    .update(simCampaigns)
    .set({ currentPlanRevisionId: plan.id })
    .where(eq(simCampaigns.id, campaign.id));
  await db.insert(simCampaignConditions).values({
    campaignId: campaign.id,
    ord: 0,
    flowConditionId: setupA.flowConditionId,
    referenceGeometryProfileId: setupA.referenceGeometryProfileId,
    presetId: setupA.presetId,
    simulationPresetRevisionId: revisionA,
    reynolds: CAMPAIGN_RE,
    status: "active",
    introducedInPlanRevisionId: plan.id,
  });

  // Campaign-solved ACCEPTED evidence at α=-2 under the DISABLED revision —
  // the exact shape of the production clarky row.
  const [row] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId: setupA.bcId,
      simulationPresetRevisionId: revisionA,
      aoaDeg: -2,
      status: "done",
      source: "solved",
      regime: "rans",
      cl: -0.12,
      cd: 0.02,
      cm: 0.01,
      clCd: -6,
      converged: true,
      solvedAt: new Date(),
    })
    .returning();
  resultId = row.id;
  cleanup.resultIds.push(row.id);
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: row.id,
      airfoilId,
      bcId: row.bcId,
      simulationPresetRevisionId: revisionA,
      aoaDeg: row.aoaDeg,
      status: "done",
      source: "solved",
      regime: "rans",
      validForPolar: true,
      cl: row.cl,
      cd: row.cd,
      cm: row.cm,
      clCd: row.clCd,
      converged: true,
      evidencePayload: { fidelity: "rans" },
      solvedAt: row.solvedAt,
    })
    .returning({ id: resultAttempts.id });
  await db
    .update(results)
    .set({ currentResultAttemptId: attempt.id })
    .where(eq(results.id, row.id));
  const classifications = await db
    .insert(resultClassifications)
    .values([
      {
        resultId: row.id,
        airfoilId,
        simulationPresetRevisionId: revisionA,
        aoaDeg: -2,
        regime: "rans" as const,
        classifierVersion: "test",
        state: "accepted" as const,
        region: "attached" as const,
        confidence: 1,
        reasons: [],
      },
      {
        resultAttemptId: attempt.id,
        airfoilId,
        simulationPresetRevisionId: revisionA,
        aoaDeg: -2,
        regime: "rans" as const,
        classifierVersion: "test",
        state: "accepted" as const,
        region: "attached" as const,
        confidence: 1,
        reasons: [],
      },
    ])
    .returning({ id: resultClassifications.id });
  cleanup.classificationIds.push(...classifications.map((row) => row.id));

  // Finished queue jobs: one single-revision campaign job, one batched job
  // whose conditionMap spans TWO revisions (anchor = revisionA).
  const now = new Date();
  const jobs = await db
    .insert(simJobs)
    .values([
      {
        airfoilId,
        bcIds: [setupA.bcId],
        simulationPresetRevisionId: revisionA,
        referenceChordM: 1,
        status: "done",
        totalCases: 1,
        completedCases: 1,
        finishedAt: now,
        requestPayload: {
          conditionMap: [{ revisionId: revisionA, reynolds: CAMPAIGN_RE }],
        },
      },
      {
        airfoilId,
        bcIds: [setupA.bcId, setupB.bcId],
        simulationPresetRevisionId: revisionA,
        referenceChordM: 1,
        status: "done",
        totalCases: 2,
        completedCases: 2,
        finishedAt: now,
        requestPayload: {
          conditionMap: [
            { revisionId: revisionA, reynolds: CAMPAIGN_RE },
            { revisionId: revisionB, reynolds: CAMPAIGN_RE + 111 },
          ],
        },
      },
    ])
    .returning({ id: simJobs.id });
  singleJobId = jobs[0].id;
  batchedJobId = jobs[1].id;
  cleanup.jobIds.push(...jobs.map((j) => j.id));
}, 30_000);

afterAll(async () => {
  if (db) {
    if (cleanup.jobIds.length)
      await db.delete(simJobs).where(inArray(simJobs.id, cleanup.jobIds));
    if (cleanup.campaignIds.length)
      await db
        .delete(simCampaigns)
        .where(inArray(simCampaigns.id, cleanup.campaignIds));
    if (cleanup.classificationIds.length)
      await db
        .delete(resultClassifications)
        .where(inArray(resultClassifications.id, cleanup.classificationIds));
    if (cleanup.resultIds.length) {
      await db
        .update(results)
        .set({ currentResultAttemptId: null })
        .where(inArray(results.id, cleanup.resultIds));
      await db.delete(results).where(inArray(results.id, cleanup.resultIds));
    }
    if (cleanup.presetIds.length)
      await db
        .delete(simulationPresets)
        .where(inArray(simulationPresets.id, cleanup.presetIds));
    if (cleanup.bcIds.length)
      await db
        .delete(boundaryConditions)
        .where(inArray(boundaryConditions.id, cleanup.bcIds));
    if (cleanup.flowIds.length)
      await db
        .delete(flowConditions)
        .where(inArray(flowConditions.id, cleanup.flowIds));
    if (cleanup.refGeoIds.length)
      await db
        .delete(referenceGeometryProfiles)
        .where(inArray(referenceGeometryProfiles.id, cleanup.refGeoIds));
    if (cleanup.boundaryIds.length)
      await db
        .delete(boundaryProfiles)
        .where(inArray(boundaryProfiles.id, cleanup.boundaryIds));
    if (cleanup.meshIds.length)
      await db
        .delete(meshProfiles)
        .where(inArray(meshProfiles.id, cleanup.meshIds));
    if (cleanup.solverIds.length)
      await db
        .delete(solverProfiles)
        .where(inArray(solverProfiles.id, cleanup.solverIds));
    if (cleanup.schedulingIds.length)
      await db
        .delete(schedulingProfiles)
        .where(inArray(schedulingProfiles.id, cleanup.schedulingIds));
    if (cleanup.outputIds.length)
      await db
        .delete(outputProfiles)
        .where(inArray(outputProfiles.id, cleanup.outputIds));
    if (cleanup.sweepIds.length)
      await db
        .delete(sweepDefinitions)
        .where(inArray(sweepDefinitions.id, cleanup.sweepIds));
    if (cleanup.airfoilIds.length)
      await db.delete(airfoils).where(inArray(airfoils.id, cleanup.airfoilIds));
    if (cleanup.categoryIds.length)
      await db
        .delete(categories)
        .where(inArray(categories.id, cleanup.categoryIds));
  }
  await app?.close();
  await pgClient?.end();
  process.env = { ...ORIGINAL_ENV };
}, 30_000);

describe("pinned-revision detail scope (campaign spec §11 surgical exception)", () => {
  it("MUST-CATCH: unpinned detail publishes evidence from a disabled campaign preset without exposing campaign metadata", async () => {
    const detail = await assembleDetail(airfoilSlug);
    expect(detail).toBeTruthy();
    expect(detail!.reList).toContain(CAMPAIGN_RE);
    const allPoints = detail!.polars.flatMap((p) => p.points);
    expect(allPoints.some((p) => p.resultId === resultId)).toBe(true);
    const polar = detail!.polars.find((p) => p.re === CAMPAIGN_RE);
    expect(polar?.label).toMatch(
      new RegExp(`^Re ${Math.round(CAMPAIGN_RE / 1000)}k(?: · M \\d+\\.\\d+)?$`),
    );
    expect(polar?.label).not.toContain("campaign");
    expect(polar?.label).not.toContain("Preset");
  });

  it("MUST-CATCH: pinned scope surfaces the accepted campaign point under the disabled revision", async () => {
    const detail = await assembleDetail(airfoilSlug, { revisionId: revisionA });
    expect(detail).toBeTruthy();
    // Scoped mode always emits exactly the pinned revision's Re entry.
    expect(detail!.reList).toEqual([CAMPAIGN_RE]);
    const polar = detail!.polars.find((p) => p.re === CAMPAIGN_RE);
    expect(polar).toBeTruthy();
    const point = polar!.points.find((p) => p.a === -2);
    expect(point).toBeTruthy();
    expect(point!.resultId).toBe(resultId);
    expect(point!.source).toBe("solved");
    expect(point!.cl).toBeCloseTo(-0.12, 10);
  });

  it("unknown pinned revision renders honestly empty (no invented Re, no crash)", async () => {
    const detail = await assembleDetail(airfoilSlug, {
      revisionId: "00000000-0000-4000-8000-000000000000",
    });
    expect(detail).toBeTruthy();
    expect(detail!.reList).toEqual([]);
    expect(detail!.polars).toEqual([]);
  });
});

describe("admin queue payload carries the pin (AdminJob.revisionId)", () => {
  it("single-revision job exposes its revision; multi-revision batched job exposes null", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/queue?scope=activity",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      finishedJobs: Array<{ id: string; revisionId: string | null }>;
    };
    const single = body.finishedJobs.find((j) => j.id === singleJobId);
    const batched = body.finishedJobs.find((j) => j.id === batchedJobId);
    expect(single).toBeTruthy();
    expect(batched).toBeTruthy();
    expect(single!.revisionId).toBe(revisionA);
    expect(batched!.revisionId).toBeNull();
  });
});
