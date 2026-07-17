// Point History Explorer API tests (Solver ▸ Points tab, approved 2026-07-06):
// - table endpoint filter correctness (failed-only, classification buckets,
//   airfoil + campaign scoping, keyset pagination without overlap),
// - story endpoint timeline for a point with multiple attempts, an
//   interruption-cancelled sim_job (worker-restart shape), a classification
//   verdict, quality warnings, and campaign closure context,
// - single-point requeue: failed + rejected requeue, 409 on accepted.
//
// Shared-database integration suite (campaigns.test.ts harness pattern): a
// dedicated airfoil + a unique campaign speed isolate this suite's physics
// hash so foreign evidence can never terminal-link its points; rows are
// cleaned up in afterAll.
import { type Point } from "@aerodb/core";
import {
  airfoils,
  boundaryProfiles,
  categories,
  ensurePrecalcObligations,
  mediums,
  meshProfiles,
  onResultIngested,
  outputProfiles,
  resultAttempts,
  resultClassifications,
  results,
  simJobs,
  simPrecalcObligations,
  simResultSubmitRetries,
  solverProfiles,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import { createAcceptedPrecalcAttemptFixture } from "@aerodb/db/test-fixtures";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, sql as pgClient } from "../src/db";
import { sql } from "drizzle-orm";
import { buildServer } from "../src/server";
import { createExactResultAttemptFixture } from "./exact-result-fixture";

const PREFIX = `pw-pthist-${process.pid}-${Date.now().toString(36)}`;
// Runtime-computed from the canonical air medium so this fixture lands exactly
// on the public enqueue route's Re=200k snap point. The file-unique chord keeps
// the physical revision isolated from sibling suites.
let speedMps = 0;
const CHORD = 0.21425;

const camberedPoints: Point[] = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.09 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.03 },
  { x: 1, y: 0 },
];

let app: Awaited<ReturnType<typeof buildServer>>;
let airfoilId = "";
let publicFenceAirfoilId = "";
let categoryId = "";
let mediumId = "";
let ownsAirMedium = false;
let campaignId = "";
let conditionId = "";
let revisionId = "";
let bcId = "";
let presetId = "";
const numerics = {
  boundaryProfileId: "",
  meshProfileId: "",
  solverProfileId: "",
  outputProfileId: "",
};
const cleanupCampaignIds: string[] = [];
const cleanupAirfoilIds: string[] = [];

/** results row ids by α for the seeded story points. */
const resultIdByAoa = new Map<number, string>();

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
  categoryId = cat.id;
  const [af] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-af`,
      name: `${PREFIX} Story Foil`,
      categoryId,
      points: camberedPoints,
      isSymmetric: false,
    })
    .returning();
  airfoilId = af.id;
  cleanupAirfoilIds.push(airfoilId);
  const [publicFenceAirfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-public-af`,
      name: `${PREFIX} Public Fence Foil`,
      categoryId,
      points: camberedPoints,
      isSymmetric: false,
    })
    .returning();
  publicFenceAirfoilId = publicFenceAirfoil.id;
  cleanupAirfoilIds.push(publicFenceAirfoilId);
  let [medium] = await db
    .select()
    .from(mediums)
    .where(eq(mediums.slug, "air"))
    .limit(1);
  if (!medium) {
    [medium] = await db
      .insert(mediums)
      .values({
        slug: "air",
        name: "Air",
        phase: "gas",
        density: 1.225,
        viscosityModel: "constant",
        constantDynamicViscosity: 1.789e-5,
        dynamicViscosity: 1.789e-5,
        kinematicViscosity: 1.789e-5 / 1.225,
        speedOfSound: 340.3,
      })
      .returning();
    ownsAirMedium = true;
  }
  mediumId = medium.id;
  const density = Number(medium.density);
  const dynamicViscosity = Number(
    medium.dynamicViscosity ?? medium.constantDynamicViscosity,
  );
  speedMps = (200_000 * dynamicViscosity) / (density * CHORD);
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` })
    .returning();
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` })
    .returning();
  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` })
    .returning();
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` })
    .returning();
  numerics.boundaryProfileId = boundary.id;
  numerics.meshProfileId = mesh.id;
  numerics.solverProfileId = solver.id;
  numerics.outputProfileId = output.id;

  // Launch a real campaign (5 angles × 1 airfoil × 1 condition).
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/campaigns",
    payload: {
      name: `${PREFIX} story campaign`,
      priority: 5,
      idempotencyKey: `${PREFIX}-key`,
      airfoilIds: [airfoilId],
      plan: {
        mediumId,
        ambients: [[288.15, 101325]],
        speedsMps: [speedMps],
        chordsM: [CHORD],
        spanM: 1,
        areaMode: "derived",
        excludedConditions: [],
        baseSweep: { fromDeg: -2, toDeg: 2, stepDeg: 1, listDeg: null },
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
  cleanupCampaignIds.push(campaignId);

  const [cond] = (await db.execute(sql`
    SELECT cc.id, cc.preset_id, cc.simulation_preset_revision_id AS revision_id,
           p.legacy_boundary_condition_id AS bc_id
    FROM sim_campaign_conditions cc
    JOIN simulation_presets p ON p.id = cc.preset_id
    WHERE cc.campaign_id = ${campaignId}
  `)) as unknown as Array<{
    id: string;
    preset_id: string;
    revision_id: string;
    bc_id: string;
  }>;
  conditionId = cond.id;
  presetId = cond.preset_id;
  revisionId = cond.revision_id;
  bcId = cond.bc_id;
  // The public enqueue route intentionally considers only enabled public
  // presets. Campaign-created presets are private by default, so expose this
  // file-unique fixture explicitly.
  await db.execute(sql`
    UPDATE simulation_presets
    SET enabled = true, target_scope = 'all'
    WHERE id = ${presetId}
  `);
  await db.execute(sql`
    UPDATE simulation_preset_revisions
    SET reynolds = 200000
    WHERE id = ${revisionId}
  `);

  const insertResult = async (v: Record<string, unknown>) => {
    const [row] = await db
      .insert(results)
      .values(v as never)
      .returning({ id: results.id });
    resultIdByAoa.set(v.aoaDeg as number, row.id);
    return row.id;
  };
  const base = {
    airfoilId,
    bcId,
    simulationPresetRevisionId: revisionId,
    reynolds: 200000,
  };

  // α=+2 → done + accepted.
  const doneId = await insertResult({
    ...base,
    aoaDeg: 2,
    status: "done",
    source: "solved",
    regime: "rans",
    converged: true,
    cl: 0.61,
    cd: 0.013,
    clCd: 46.9,
    solvedAt: new Date(),
  });
  await onResultIngested(db, {
    airfoilId,
    revisionId,
    aoaDeg: 2,
    resultId: doneId,
    status: "done",
    regime: "rans",
  });
  // α=+1 → done + needs_urans.
  const nuId = await insertResult({
    ...base,
    aoaDeg: 1,
    status: "done",
    source: "solved",
    regime: "rans",
    converged: false,
    stalled: true,
    cl: 0.5,
    cd: 0.02,
    solvedAt: new Date(),
  });
  await onResultIngested(db, {
    airfoilId,
    revisionId,
    aoaDeg: 1,
    resultId: nuId,
    status: "done",
    regime: "rans",
  });
  // α=0 → FAILED after a RANS reject + a URANS timeout (the live escalation shape).
  const failId = await insertResult({
    ...base,
    aoaDeg: 0,
    status: "failed",
    source: "queued",
    regime: "urans",
    error: "OpenFOAMError: URANS timed out after 4h",
  });
  await onResultIngested(db, {
    airfoilId,
    revisionId,
    aoaDeg: 0,
    resultId: failId,
    status: "failed",
    regime: "urans",
  });
  // α=-1 → done but classified REJECTED.
  const rejId = await insertResult({
    ...base,
    aoaDeg: -1,
    status: "done",
    source: "solved",
    regime: "urans",
    converged: true,
    unsteady: true,
    cl: -0.05,
    cd: 0.03,
    solvedAt: new Date(),
  });
  await onResultIngested(db, {
    airfoilId,
    revisionId,
    aoaDeg: -1,
    resultId: rejId,
    status: "done",
    regime: "urans",
  });
  // α=-2 stays requested (open) — the closure-context denominator.

  // Result-level classifications (same language as the portal everywhere).
  await db.insert(resultClassifications).values([
    {
      resultId: doneId,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 2,
      regime: "rans",
      classifierVersion: "test-v1",
      state: "accepted",
      reasons: ["converged"],
      confidence: 0.97,
    },
    {
      resultId: nuId,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 1,
      regime: "rans",
      classifierVersion: "test-v1",
      state: "needs_urans",
      reasons: ["solver_stalled"],
      confidence: 0.7,
    },
    {
      resultId: rejId,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: -1,
      regime: "urans",
      classifierVersion: "test-v1",
      state: "rejected",
      reasons: ["cl_out_of_family", "cd_negative_family"],
      confidence: 0.9,
    },
  ]);

  // Attempt evidence: the rejected α=-1 point carries a RANS reject followed
  // by a URANS re-solve with persisted engine quality warnings (0030).
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      campaignId,
      jobKind: "sweep",
      referenceChordM: CHORD,
      wave: 1,
      status: "done",
      totalCases: 5,
      engineJobId: `${PREFIX}-engine-1`,
    })
    .returning({ id: simJobs.id });
  await db.insert(resultAttempts).values([
    {
      resultId: rejId,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: -1,
      simJobId: job.id,
      engineJobId: `${PREFIX}-engine-1`,
      status: "done",
      source: "solved",
      regime: "rans",
      validForPolar: false,
      converged: false,
      stalled: true,
      cl: -0.4,
      cd: 0.05,
      createdAt: new Date(Date.now() - 60_000),
      solvedAt: new Date(Date.now() - 60_000),
    },
    {
      resultId: rejId,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: -1,
      simJobId: job.id,
      engineJobId: `${PREFIX}-engine-1`,
      status: "done",
      source: "solved",
      regime: "urans",
      validForPolar: true,
      converged: true,
      unsteady: true,
      cl: -0.05,
      cd: 0.03,
      qualityWarnings: ["URANS shedding unmeasurable: no dominant frequency"],
      createdAt: new Date(Date.now() - 30_000),
      solvedAt: new Date(Date.now() - 30_000),
    },
  ]);
  // The failed α=0 point carries two failed attempts (RANS ✗ → URANS ✗ timeout).
  await db.insert(resultAttempts).values([
    {
      resultId: failId,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 0,
      simJobId: job.id,
      engineJobId: `${PREFIX}-engine-1`,
      status: "failed",
      source: "queued",
      regime: "rans",
      validForPolar: false,
      converged: false,
      error: "diverged: NaN residual",
      createdAt: new Date(Date.now() - 50_000),
    },
    {
      resultId: failId,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 0,
      simJobId: job.id,
      engineJobId: `${PREFIX}-engine-2`,
      status: "failed",
      source: "queued",
      regime: "urans",
      validForPolar: false,
      converged: false,
      error: "OpenFOAMError: URANS timed out after 4h",
      createdAt: new Date(Date.now() - 20_000),
    },
  ]);

  // Interruption: a cancelled sim_job that had claimed α=-1 and α=0 (the
  // worker-restart orphan-release shape — reconcile.ts message verbatim).
  const [cancelled] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      campaignId,
      jobKind: "sweep",
      referenceChordM: CHORD,
      wave: 1,
      status: "cancelled",
      totalCases: 2,
      engineJobId: `${PREFIX}-engine-cancelled`,
      error: "worker restarted mid-solve; points released for re-solve",
      requestPayload: {
        aoas: [-1, 0],
        speedMap: [{ speed: speedMps, bcId, presetRevisionId: revisionId }],
      },
      finishedAt: new Date(),
    })
    .returning({ id: simJobs.id });
}, 60_000);

afterAll(async () => {
  await cleanupCampaignFixtures(db, {
    campaignIds: cleanupCampaignIds,
    presetSlugPrefix: `campaign-${PREFIX.toLowerCase()}`,
  });
  await db.execute(
    sql`DELETE FROM boundary_profiles WHERE slug = ${`${PREFIX}-boundary`}`,
  );
  await db.execute(
    sql`DELETE FROM mesh_profiles WHERE slug = ${`${PREFIX}-mesh`}`,
  );
  await db.execute(
    sql`DELETE FROM solver_profiles WHERE slug = ${`${PREFIX}-solver`}`,
  );
  await db.execute(
    sql`DELETE FROM output_profiles WHERE slug = ${`${PREFIX}-output`}`,
  );
  if (cleanupAirfoilIds.length)
    await db.delete(airfoils).where(inArray(airfoils.id, cleanupAirfoilIds));
  await db.delete(categories).where(eq(categories.id, categoryId));
  if (ownsAirMedium) await db.delete(mediums).where(eq(mediums.id, mediumId));
  await app.close();
  await pgClient.end();
});

const listUrl = (params: Record<string, string>) =>
  `/api/admin/point-history?${new URLSearchParams(params).toString()}`;

describe("public simulation enqueue evidence fence", () => {
  it("never resets terminal URANS evidence and returns accepted evidence in place", async () => {
    const payload = { re: 200_000, aoa: 97 };
    const first = await app.inject({
      method: "POST",
      url: `/api/airfoils/${PREFIX}-public-af/simulate`,
      payload,
    });
    expect(first.statusCode, JSON.stringify(first.json())).toBe(202);
    const resultId = String(first.json().resultId);
    resultIdByAoa.set(97, resultId);
    const [created] = await db
      .select({ revisionId: results.simulationPresetRevisionId })
      .from(results)
      .where(eq(results.id, resultId));
    expect(created?.revisionId).toBeTruthy();

    await db
      .update(results)
      .set({
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.72,
        cd: 0.031,
        cm: -0.03,
        clCd: 0.72 / 0.031,
        converged: true,
        unsteady: true,
        solvedAt: new Date(),
      })
      .where(eq(results.id, resultId));
    await db.insert(resultClassifications).values({
      resultId,
      airfoilId: publicFenceAirfoilId,
      simulationPresetRevisionId: created.revisionId!,
      aoaDeg: 97,
      regime: "urans",
      classifierVersion: "public-enqueue-fence-v1",
      state: "needs_urans",
      reasons: ["test-terminal-urans"],
    });

    const refused = await app.inject({
      method: "POST",
      url: `/api/airfoils/${PREFIX}-public-af/simulate`,
      payload,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ resultId, status: "done" });
    const [preserved] = await db
      .select({
        status: results.status,
        regime: results.regime,
        fidelity: results.fidelity,
      })
      .from(results)
      .where(eq(results.id, resultId));
    expect(preserved).toEqual({
      status: "done",
      regime: "urans",
      fidelity: "urans_precalc",
    });

    await db
      .update(resultClassifications)
      .set({ state: "accepted", reasons: [] })
      .where(eq(resultClassifications.resultId, resultId));

    // A stale result-level accepted verdict without an exact selected attempt
    // is historical evidence, not a solved public response.
    const pointerlessAccepted = await app.inject({
      method: "POST",
      url: `/api/airfoils/${PREFIX}-public-af/simulate`,
      payload,
    });
    expect(pointerlessAccepted.statusCode).toBe(409);

    const wrongAttemptId = await createExactResultAttemptFixture(db, resultId, {
      publication: "historical-rejected",
      evidencePayload: { fidelity: "urans_precalc" },
    });
    await db.insert(resultClassifications).values({
      resultAttemptId: wrongAttemptId,
      airfoilId: publicFenceAirfoilId,
      simulationPresetRevisionId: created.revisionId!,
      aoaDeg: 97,
      regime: "urans",
      classifierVersion: "public-enqueue-wrong-attempt-v1",
      state: "accepted",
      reasons: [],
    });
    const selectedAttemptId = await createExactResultAttemptFixture(
      db,
      resultId,
      {
        publication: "selected-eligible",
        evidencePayload: { fidelity: "urans_precalc" },
      },
    );
    await db.insert(resultClassifications).values({
      resultAttemptId: selectedAttemptId,
      airfoilId: publicFenceAirfoilId,
      simulationPresetRevisionId: created.revisionId!,
      aoaDeg: 97,
      regime: "urans",
      classifierVersion: "public-enqueue-selected-v1",
      state: "needs_urans",
      reasons: ["selected-attempt-needs-more-evidence"],
    });

    // An accepted verdict for a different historical attempt cannot authorize
    // the selected generation.
    const wrongAttemptAccepted = await app.inject({
      method: "POST",
      url: `/api/airfoils/${PREFIX}-public-af/simulate`,
      payload,
    });
    expect(wrongAttemptAccepted.statusCode).toBe(409);

    await db
      .update(resultClassifications)
      .set({ state: "accepted", reasons: [] })
      .where(eq(resultClassifications.resultAttemptId, selectedAttemptId));
    const accepted = await app.inject({
      method: "POST",
      url: `/api/airfoils/${PREFIX}-public-af/simulate`,
      payload,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      resultId,
      status: "done",
      queued: false,
    });
  });
});

describe("point-history table endpoint", () => {
  it("failed filter returns ONLY failed rows and includes the seeded escalation chain", async () => {
    const res = await app.inject({
      method: "GET",
      url: listUrl({ status: "failed", airfoil: `${PREFIX} Story` }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(1);
    expect(
      body.items.every(
        (i: { bucket: string; status: string }) =>
          i.bucket === "failed" && i.status === "failed",
      ),
    ).toBe(true);
    const row = body.items[0];
    expect(row.resultId).toBe(resultIdByAoa.get(0));
    expect(row.attemptCount).toBe(2);
    // Digest is chronological: RANS diverged → URANS timeout.
    expect(row.attemptDigest.map((e: { regime: string }) => e.regime)).toEqual([
      "rans",
      "urans",
    ]);
    expect(row.attemptDigest[1].error).toContain("timed out");
    expect(row.errorClass).toBe("timeout");
    expect(row.campaignId).toBe(campaignId);
    // Chip counts describe the same filter scope (airfoil-scoped, all buckets).
    expect(body.counts.failed).toBe(1);
    expect(body.counts.accepted).toBe(1);
    expect(body.counts.needs_urans).toBe(1);
    expect(body.counts.rejected).toBe(1);
    expect(body.counts.all).toBe(4);
  });

  it("classification filters return only their bucket (rejected + needs_urans)", async () => {
    const rej = await app.inject({
      method: "GET",
      url: listUrl({ status: "rejected", airfoil: `${PREFIX} Story` }),
    });
    expect(rej.statusCode).toBe(200);
    expect(
      rej.json().items.map((i: { resultId: string }) => i.resultId),
    ).toEqual([resultIdByAoa.get(-1)]);
    expect(rej.json().items[0].classificationState).toBe("rejected");

    const nu = await app.inject({
      method: "GET",
      url: listUrl({ status: "needs_urans", airfoil: `${PREFIX} Story` }),
    });
    expect(nu.statusCode).toBe(200);
    expect(
      nu.json().items.map((i: { resultId: string }) => i.resultId),
    ).toEqual([resultIdByAoa.get(1)]);

    const acc = await app.inject({
      method: "GET",
      url: listUrl({ status: "accepted", airfoil: `${PREFIX} Story` }),
    });
    expect(
      acc.json().items.map((i: { resultId: string }) => i.resultId),
    ).toEqual([resultIdByAoa.get(2)]);
  });

  it("campaign + regime + errorClass filters compose; keyset pages never overlap", async () => {
    const byCampaign = await app.inject({
      method: "GET",
      url: listUrl({ campaignId, airfoil: `${PREFIX} Story` }),
    });
    expect(byCampaign.statusCode).toBe(200);
    expect(byCampaign.json().items.length).toBe(4);
    const byRegime = await app.inject({
      method: "GET",
      url: listUrl({ regime: "urans", airfoil: `${PREFIX} Story` }),
    });
    expect(
      byRegime
        .json()
        .items.every((i: { regime: string }) => i.regime === "urans"),
    ).toBe(true);
    expect(byRegime.json().items.length).toBe(2); // α=0 failed-urans + α=-1 rejected-urans
    const byClass = await app.inject({
      method: "GET",
      url: listUrl({ errorClass: "diverged", airfoil: `${PREFIX} Story` }),
    });
    expect(byClass.json().items.length).toBe(0); // result-level error is a timeout
    const byClassTimeout = await app.inject({
      method: "GET",
      url: listUrl({ errorClass: "timeout", airfoil: `${PREFIX} Story` }),
    });
    expect(
      byClassTimeout.json().items.map((i: { resultId: string }) => i.resultId),
    ).toEqual([resultIdByAoa.get(0)]);

    // Keyset pagination: 2+2 pages over the 4 airfoil-scoped rows, no overlap.
    const page1 = await app.inject({
      method: "GET",
      url: listUrl({ airfoil: `${PREFIX} Story`, limit: "2" }),
    });
    const p1 = page1.json();
    expect(p1.items.length).toBe(2);
    expect(p1.nextCursor).toBeTruthy();
    const page2 = await app.inject({
      method: "GET",
      url: listUrl({
        airfoil: `${PREFIX} Story`,
        limit: "2",
        cursor: p1.nextCursor,
      }),
    });
    const p2 = page2.json();
    expect(p2.items.length).toBe(2);
    const keys1 = new Set(p1.items.map((i: { rowKey: string }) => i.rowKey));
    expect(
      p2.items.filter((i: { rowKey: string }) => keys1.has(i.rowKey)).length,
    ).toBe(0);
  });

  it("keyset paging is LOSSLESS across identical microsecond timestamps (bulk now() stamps)", async () => {
    // Real-world shape: bulk SQL statements stamp whole batches with ONE
    // identical µs-precision now() (requeueSinglePoint, sim_campaign_points
    // mirrors). A cursor that round-trips through a JS Date (ms) truncates
    // the key and silently drops the rest of the batch from every later page.
    const ids = [...resultIdByAoa.values()];
    const idList = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    await db.execute(
      sql`UPDATE results SET "updatedAt" = now() WHERE id IN (${idList})`,
    );
    const [stamp] = (await db.execute(
      sql`SELECT count(DISTINCT "updatedAt")::int AS n, max("updatedAt"::text) AS ts FROM results WHERE id IN (${idList})`,
    )) as unknown as Array<{ n: number; ts: string }>;
    expect(stamp.n).toBe(1); // all four rows share ONE timestamp…
    expect(stamp.ts).toMatch(/\.\d{4,6}/); // …with sub-millisecond digits

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 5 && (i === 0 || cursor); i++) {
      const params: Record<string, string> = {
        airfoil: `${PREFIX} Story`,
        limit: "2",
      };
      if (cursor) params.cursor = cursor;
      const res = await app.inject({ method: "GET", url: listUrl(params) });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        items: Array<{ rowKey: string }>;
        nextCursor: string | null;
      };
      for (const item of body.items) {
        expect(seen.has(item.rowKey)).toBe(false); // no duplicates…
        seen.add(item.rowKey);
      }
      cursor = body.nextCursor;
    }
    expect(seen.size).toBe(4); // …and no dropped rows
  });

  it("facets ship campaigns + reynolds on request; facets=false means false; malformed cursor is a 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: listUrl({ airfoil: `${PREFIX} Story`, facets: "true" }),
    });
    const body = res.json();
    expect(
      body.facets.campaigns.some((c: { id: string }) => c.id === campaignId),
    ).toBe(true);
    expect(body.facets.reynolds).toContain(200000);
    const off = await app.inject({
      method: "GET",
      url: listUrl({ airfoil: `${PREFIX} Story`, facets: "false" }),
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().facets).toBeUndefined();
    const bad = await app.inject({
      method: "GET",
      url: listUrl({ cursor: "not-a-cursor" }),
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("derived-by-symmetry rows (UNION arm)", () => {
  let symCampaignId = "";
  let symAirfoilId = "";

  it("lists the terminal −α mirror cell as a derived row with its +α source", async () => {
    const symmetricPoints: Point[] = [
      { x: 1, y: 0 },
      { x: 0.5, y: 0.06 },
      { x: 0, y: 0 },
      { x: 0.5, y: -0.06 },
      { x: 1, y: 0 },
    ];
    const [sym] = await db
      .insert(airfoils)
      .values({
        slug: `${PREFIX}-sym`,
        name: `${PREFIX} Mirror Foil`,
        categoryId,
        points: symmetricPoints,
        isSymmetric: true,
      })
      .returning();
    symAirfoilId = sym.id;
    cleanupAirfoilIds.push(symAirfoilId);
    // Unique speed → own physics hash/revision; symmetric planning derives −α.
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      payload: {
        name: `${PREFIX} mirror campaign`,
        priority: 5,
        idempotencyKey: `${PREFIX}-sym-key`,
        airfoilIds: [symAirfoilId],
        plan: {
          mediumId,
          ambients: [[288.15, 101325]],
          speedsMps: [speedMps + 1.5],
          chordsM: [CHORD],
          spanM: 1,
          areaMode: "derived",
          excludedConditions: [],
          baseSweep: { fromDeg: -2, toDeg: 2, stepDeg: 1, listDeg: null },
          objectives: {
            ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
            clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
          },
          numerics,
        },
      },
    });
    expect(res.statusCode).toBe(201);
    symCampaignId = res.json().campaign.id;
    cleanupCampaignIds.push(symCampaignId);
    const [cond] = (await db.execute(sql`
      SELECT cc.simulation_preset_revision_id AS revision_id, p.legacy_boundary_condition_id AS bc_id
      FROM sim_campaign_conditions cc JOIN simulation_presets p ON p.id = cc.preset_id
      WHERE cc.campaign_id = ${symCampaignId}
    `)) as unknown as Array<{ revision_id: string; bc_id: string }>;
    // Solve α=+1 → the derived −1 cell goes terminal pointing at this result.
    const [src] = await db
      .insert(results)
      .values({
        airfoilId: symAirfoilId,
        bcId: cond.bc_id,
        simulationPresetRevisionId: cond.revision_id,
        aoaDeg: 1,
        status: "done",
        source: "solved",
        regime: "rans",
        converged: true,
        cl: 0.3,
        cd: 0.011,
        reynolds: 210000,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    await onResultIngested(db, {
      airfoilId: symAirfoilId,
      revisionId: cond.revision_id,
      aoaDeg: 1,
      resultId: src.id,
      status: "done",
      regime: "rans",
    });

    const list = await app.inject({
      method: "GET",
      url: listUrl({ airfoil: `${PREFIX} Mirror` }),
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<Record<string, unknown>>;
    const derived = items.find((i) => i.kind === "derived");
    expect(derived).toBeTruthy();
    expect(derived!.aoaDeg).toBe(-1);
    expect(derived!.sourceAoaDeg).toBe(1);
    expect(derived!.bucket).toBe("derived");
    expect(derived!.resultId).toBe(src.id); // points at the +α source evidence
    expect(derived!.campaignId).toBe(symCampaignId);
    // Derived mirrors are excluded from status-bucket filters (they are not
    // failed/solving/classified rows in their own right).
    const failedOnly = await app.inject({
      method: "GET",
      url: listUrl({ airfoil: `${PREFIX} Mirror`, status: "failed" }),
    });
    expect(
      (failedOnly.json().items as Array<Record<string, unknown>>).some(
        (i) => i.kind === "derived",
      ),
    ).toBe(false);
  });
});

describe("point-history story endpoint", () => {
  it("assembles the full timeline: attempts in order, quality warnings, interruption, classification, closure", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/point-history/${resultIdByAoa.get(-1)}/story`,
    });
    expect(res.statusCode).toBe(200);
    const story = res.json();
    expect(story.point.status).toBe("done");
    expect(story.point.classification.state).toBe("rejected");
    expect(story.point.classification.reasons).toContain("cl_out_of_family");
    // Attempts chronological: RANS reject then URANS with the persisted warning.
    expect(story.attempts.map((a: { regime: string }) => a.regime)).toEqual([
      "rans",
      "urans",
    ]);
    expect(story.attempts[0].validForPolar).toBe(false);
    expect(story.attempts[1].qualityWarnings).toEqual([
      "URANS shedding unmeasurable: no dominant frequency",
    ]);
    expect(story.attempts[1].simJob.campaignId).toBe(campaignId);
    // Interruption: the cancelled worker-restart job that had claimed α=-1.
    expect(story.interruptions.length).toBe(1);
    expect(story.interruptions[0].error).toContain(
      "worker restarted mid-solve",
    );
    // Closure context: this α is terminal for the only airfoil → 0 of 1 open.
    expect(story.closure).toMatchObject({
      campaignId,
      conditionId,
      openAirfoils: 0,
      totalAirfoils: 1,
    });
  });

  it("does NOT attribute the interruption to points outside the cancelled job's aoa list", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/point-history/${resultIdByAoa.get(2)}/story`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().interruptions.length).toBe(0); // α=+2 was not in [-1, 0]
  });

  it("does NOT attribute a cancelled job's interruption to the points it SOLVED before cancelling", async () => {
    // Worker-restart reconcile shape (reconcile.ts releaseWorkerRestartOrphan):
    // the batched job solves α=+2 (ingested as kept evidence, its attempt's
    // sim_job_id = this job), then the job is CANCELLED and only α=0 is
    // released. "point released" is true for α=0, false for α=+2.
    const solvedId = resultIdByAoa.get(2)!;
    const releasedId = resultIdByAoa.get(0)!;
    const [partial] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        campaignId,
        jobKind: "sweep",
        referenceChordM: CHORD,
        wave: 1,
        status: "cancelled",
        totalCases: 2,
        engineJobId: `${PREFIX}-engine-partial`,
        error: "worker restarted mid-solve; points released for re-solve",
        requestPayload: {
          aoas: [2, 0],
          speedMap: [{ speed: speedMps, bcId, presetRevisionId: revisionId }],
        },
        finishedAt: new Date(),
      })
      .returning({ id: simJobs.id });
    await db.insert(resultAttempts).values({
      resultId: solvedId,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 2,
      simJobId: partial.id,
      engineJobId: `${PREFIX}-engine-partial`,
      status: "done",
      source: "solved",
      regime: "rans",
      validForPolar: true,
      converged: true,
      cl: 0.61,
      cd: 0.013,
      solvedAt: new Date(),
    });

    // α=+2 kept its evidence from this job → NO false "point released" event.
    const kept = await app.inject({
      method: "GET",
      url: `/api/admin/point-history/${solvedId}/story`,
    });
    expect(kept.statusCode).toBe(200);
    expect(
      (kept.json().interruptions as Array<{ simJobId: string }>).some(
        (j) => j.simJobId === partial.id,
      ),
    ).toBe(false);
    // α=0 was actually released by this job → the interruption IS attributed.
    const released = await app.inject({
      method: "GET",
      url: `/api/admin/point-history/${releasedId}/story`,
    });
    expect(released.statusCode).toBe(200);
    expect(
      (released.json().interruptions as Array<{ simJobId: string }>).some(
        (j) => j.simJobId === partial.id,
      ),
    ).toBe(true);
  });

  it("404s on an unknown point", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/point-history/00000000-0000-4000-8000-000000000000/story",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("fidelity ladder fields + verify filter (migration 0034)", () => {
  const verifyItemIds: string[] = [];
  let selectedFixtureGeneration = 0;

  const selectAcceptedPrecalcFixture = async () => {
    const resultAttemptId = await createExactResultAttemptFixture(
      db,
      resultIdByAoa.get(2)!,
      { publication: "selected-eligible" },
    );
    await db.insert(resultClassifications).values({
      resultAttemptId,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 2,
      regime: "rans",
      classifierVersion: `${PREFIX}-modal-exact-${selectedFixtureGeneration++}`,
      state: "accepted",
      region: "attached",
      reasons: [],
    });
    return resultAttemptId;
  };

  beforeAll(async () => {
    // α=+2 → precalc row with an OPEN verify item (pending).
    // α=+1 → full row whose LATEST verify item DISAGREED (Δcl 0.06).
    // α=-1 → precalc row with an old disagreed item SUPERSEDED by a newer
    //        done item — "latest decides", it must NOT match disagreed.
    await db.execute(
      sql`UPDATE results SET fidelity = 'urans_precalc' WHERE id = ${resultIdByAoa.get(2)}`,
    );
    await db.execute(
      sql`UPDATE results SET fidelity = 'urans_full' WHERE id = ${resultIdByAoa.get(1)}`,
    );
    await db.execute(
      sql`UPDATE results SET fidelity = 'urans_precalc' WHERE id = ${resultIdByAoa.get(-1)}`,
    );
    const pendingPrecalcAttemptId = await selectAcceptedPrecalcFixture();
    const verifiedPrecalcAttemptId = await createAcceptedPrecalcAttemptFixture(
      db,
      resultIdByAoa.get(1)!,
    );
    const negativePrecalcAttemptId = await createAcceptedPrecalcAttemptFixture(
      db,
      resultIdByAoa.get(-1)!,
    );
    const rows = (await db.execute(sql`
      INSERT INTO sim_urans_verify_queue
        (airfoil_id, revision_id, aoa_deg, campaign_id, state, precalc_result_id, precalc_result_attempt_id, delta_cl, delta_cd, "createdAt")
      VALUES
        (${airfoilId}, ${revisionId}, 2, ${campaignId}, 'pending', ${resultIdByAoa.get(2)}, ${pendingPrecalcAttemptId}, NULL, NULL, now()),
        (${airfoilId}, ${revisionId}, 1, ${campaignId}, 'disagreed', ${resultIdByAoa.get(1)}, ${verifiedPrecalcAttemptId}, 0.06, 0.002, now()),
        (${airfoilId}, ${revisionId}, -1, ${campaignId}, 'disagreed', ${resultIdByAoa.get(-1)}, ${negativePrecalcAttemptId}, 0.09, NULL, now() - interval '1 hour'),
        (${airfoilId}, ${revisionId}, -1, ${campaignId}, 'done', ${resultIdByAoa.get(-1)}, ${negativePrecalcAttemptId}, 0.01, 0.001, now())
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    for (const r of rows) verifyItemIds.push(r.id);
  });

  afterAll(async () => {
    if (verifyItemIds.length) {
      const idList = sql.join(
        verifyItemIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      await db.execute(
        sql`DELETE FROM sim_urans_verify_queue WHERE id IN (${idList})`,
      );
    }
  });

  it("rows carry results.fidelity and the LATEST verify item (state + real deltas)", async () => {
    const res = await app.inject({
      method: "GET",
      url: listUrl({ airfoil: `${PREFIX} Story` }),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    const byId = new Map(items.map((i) => [i.resultId, i]));
    const precalc = byId.get(resultIdByAoa.get(2)) as {
      fidelity: string;
      verify: { state: string };
    };
    expect(precalc.fidelity).toBe("urans_precalc");
    expect(precalc.verify.state).toBe("pending");
    const disagreed = byId.get(resultIdByAoa.get(1)) as {
      fidelity: string;
      verify: { state: string; deltaCl: number; deltaCd: number };
    };
    expect(disagreed.fidelity).toBe("urans_full");
    expect(disagreed.verify).toMatchObject({
      state: "disagreed",
      deltaCl: 0.06,
      deltaCd: 0.002,
    });
    // latest decides: the re-verified α=-1 cell reads done, not disagreed
    const reverified = byId.get(resultIdByAoa.get(-1)) as {
      verify: { state: string };
    };
    expect(reverified.verify.state).toBe("done");
    // never-queued cell stays null
    const failed = byId.get(resultIdByAoa.get(0)) as {
      fidelity: string | null;
      verify: unknown;
    };
    expect(failed.verify).toBeNull();
  });

  it("verify=pending returns only cells with an OPEN verify item", async () => {
    const res = await app.inject({
      method: "GET",
      url: listUrl({ airfoil: `${PREFIX} Story`, verify: "pending" }),
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().items.map((i: { resultId: string }) => i.resultId),
    ).toEqual([resultIdByAoa.get(2)]);
  });

  it("verify=disagreed matches on the LATEST item only (a re-verified cell drops out)", async () => {
    const res = await app.inject({
      method: "GET",
      url: listUrl({ airfoil: `${PREFIX} Story`, verify: "disagreed" }),
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().items.map((i: { resultId: string }) => i.resultId),
    ).toEqual([resultIdByAoa.get(1)]);
    const bad = await app.inject({
      method: "GET",
      url: listUrl({ verify: "bogus" }),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("the story payload carries fidelity + the latest verify item", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/point-history/${resultIdByAoa.get(1)}/story`,
    });
    expect(res.statusCode).toBe(200);
    const story = res.json();
    expect(story.point.fidelity).toBe("urans_full");
    expect(story.point.verify).toMatchObject({
      state: "disagreed",
      deltaCl: 0.06,
    });
  });

  it("sim detail ships fidelity + camelCase steady_history + verify state (modal contract)", async () => {
    // Exact contract-2 shape → parsed and camelCased for the modal chart.
    const steadyHistory = {
      iterations: [100, 200, 300, 400],
      cl: [0.6, 0.62, 0.61, 0.61],
      cd: [0.013, 0.0131, 0.013, 0.013],
      cm: [-0.05, -0.051, -0.05, -0.05],
      window: { start_iter: 200, end_iter: 400 },
      mean_stable: true,
      note: "steady oscillating mean over trailing window",
    };
    await db.execute(
      sql`UPDATE results SET steady_history = ${JSON.stringify(steadyHistory)}::jsonb WHERE id = ${resultIdByAoa.get(2)}`,
    );
    await selectAcceptedPrecalcFixture();
    const res = await app.inject({
      method: "GET",
      url: `/api/airfoils/${PREFIX}-af/sim?resultId=${resultIdByAoa.get(2)}`,
    });
    expect(res.statusCode).toBe(200);
    const sim = res.json();
    expect(sim.fidelity).toBe("urans_precalc");
    expect(sim.uransVerify).toMatchObject({ state: "pending" });
    expect(sim.steadyHistory).toMatchObject({
      window: { startIter: 200, endIter: 400 },
      meanStable: true,
      note: "steady oscillating mean over trailing window",
    });
    expect(sim.steadyHistory.cl).toEqual(steadyHistory.cl);

    // Drifted payload (unexpected key) → strict parse fails → null, never a
    // half-invented chart.
    await db.execute(sql`
      UPDATE results SET steady_history = ${JSON.stringify({ ...steadyHistory, surprise: 1 })}::jsonb WHERE id = ${resultIdByAoa.get(2)}
    `);
    await selectAcceptedPrecalcFixture();
    const drifted = await app.inject({
      method: "GET",
      url: `/api/airfoils/${PREFIX}-af/sim?resultId=${resultIdByAoa.get(2)}`,
    });
    expect(drifted.statusCode).toBe(200);
    expect(drifted.json().steadyHistory).toBeNull();
    await db.execute(
      sql`UPDATE results SET steady_history = NULL WHERE id = ${resultIdByAoa.get(2)}`,
    );
  });
});

describe("single-point requeue", () => {
  it("reports an exhausted physical obligation as blocked/unavailable, never rescheduled", async () => {
    const id = resultIdByAoa.get(-1)!;
    const [obligation] = await ensurePrecalcObligations(
      db,
      [
        {
          airfoilId,
          revisionId,
          aoaDeg: -1,
          sourceResultId: id,
        },
      ],
      { campaignIds: [campaignId] },
    );
    await db
      .update(simPrecalcObligations)
      .set({
        state: "blocked",
        attemptCount: 2,
        lastOutcome: "rejected_exhausted",
        completedAt: new Date(),
      })
      .where(eq(simPrecalcObligations.id, obligation.id));
    const list = await app.inject({
      method: "GET",
      url: listUrl({ status: "rejected", airfoil: `${PREFIX} Story` }),
    });
    expect(list.statusCode).toBe(200);
    const item = list
      .json()
      .items.find(
        (candidate: { resultId: string }) => candidate.resultId === id,
      );
    expect(item).toMatchObject({
      reviewBucket: null,
      workDisposition: "blocked",
    });
    const story = await app.inject({
      method: "GET",
      url: `/api/admin/point-history/${id}/story`,
    });
    expect(story.statusCode).toBe(200);
    expect(story.json().point).toMatchObject({
      reviewBucket: null,
      workDisposition: "blocked",
    });
  });

  it("requeues a plain wave-1 RANS failure: result → pending, campaign point → requested", async () => {
    const [failedRans] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: -2,
        status: "failed",
        source: "queued",
        regime: "rans",
        error: "simpleFoam transient infrastructure failure",
      })
      .returning({ id: results.id });
    resultIdByAoa.set(-2, failedRans.id);
    await onResultIngested(db, {
      airfoilId,
      revisionId,
      aoaDeg: -2,
      resultId: failedRans.id,
      status: "failed",
      regime: "rans",
    });
    const id = failedRans.id;
    await db.insert(simResultSubmitRetries).values({
      resultId: id,
      state: "blocked",
      attemptCount: 1,
      lastHttpStatus: 503,
      lastError: "prior answered submit sequence exhausted",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/point-history/${id}/requeue`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      requeued: 1,
      scope: "failed",
      campaignIds: [campaignId],
    });
    const [r] = await db
      .select({ status: results.status, simJobId: results.simJobId })
      .from(results)
      .where(eq(results.id, id));
    expect(r.status).toBe("pending");
    expect(r.simJobId).toBeNull();
    expect(
      await db
        .select({ resultId: simResultSubmitRetries.resultId })
        .from(simResultSubmitRetries)
        .where(eq(simResultSubmitRetries.resultId, id)),
    ).toHaveLength(0);
    const [pt] = (await db.execute(sql`
      SELECT state FROM sim_campaign_points WHERE campaign_id = ${campaignId} AND aoa_deg = -2 AND airfoil_id = ${airfoilId}
    `)) as unknown as Array<{ state: string }>;
    expect(pt.state).toBe("requested");
  });

  it("refuses ordinary RANS requeue for every PRECALC obligation state", async () => {
    const [failedRans] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 98,
        status: "failed",
        source: "queued",
        regime: "rans",
        fidelity: "rans",
        error: "ledger-owned test failure",
      })
      .returning({ id: results.id });
    const [obligation] = await ensurePrecalcObligations(
      db,
      [
        {
          airfoilId,
          revisionId,
          aoaDeg: 98,
          sourceResultId: failedRans.id,
        },
      ],
      { backgroundOwner: true },
    );

    for (const state of [
      "pending",
      "running",
      "satisfied",
      "cancelled",
      "blocked",
    ]) {
      await db
        .update(simPrecalcObligations)
        .set({ state })
        .where(eq(simPrecalcObligations.id, obligation.id));
      const response = await app.inject({
        method: "POST",
        url: `/api/admin/point-history/${failedRans.id}/requeue`,
      });
      expect(response.statusCode, state).toBe(409);
      expect(response.json().error).toContain("PRECALC ledger");
      const [preserved] = await db
        .select({ status: results.status })
        .from(results)
        .where(eq(results.id, failedRans.id));
      expect(preserved.status, state).toBe("failed");
    }
  });

  it("refuses an URANS rejected point instead of downgrading it to ordinary RANS", async () => {
    const id = resultIdByAoa.get(-1)!;
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/point-history/${id}/requeue`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("URANS evidence is owned");
    const [r] = await db
      .select({ status: results.status })
      .from(results)
      .where(eq(results.id, id));
    expect(r.status).toBe("done");
  });

  it("refuses a failed URANS row instead of downgrading it to ordinary RANS", async () => {
    const id = resultIdByAoa.get(0)!;
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/point-history/${id}/requeue`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("URANS evidence is owned");
    const [r] = await db
      .select({ status: results.status })
      .from(results)
      .where(eq(results.id, id));
    expect(r.status).toBe("failed");
  });

  it("409s on accepted fidelity-ladder evidence", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/point-history/${resultIdByAoa.get(2)}/requeue`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("URANS evidence is owned");
  });
});

describe("legacy global failed-result requeue", () => {
  it("is inert and leaves result, campaign-point, obligation, and submit-retry truth unchanged", async () => {
    const resultId = resultIdByAoa.get(0)!;
    await db.execute(sql`
      UPDATE results
      SET status = 'failed', sim_job_id = NULL,
          error = 'terminal failure retained for explicit scoped repair'
      WHERE id = ${resultId}
    `);
    await db.execute(sql`
      UPDATE sim_campaign_points
      SET state = 'terminal', result_id = ${resultId}, "updatedAt" = now()
      WHERE campaign_id = ${campaignId}
        AND airfoil_id = ${airfoilId}
        AND revision_id = ${revisionId}
        AND aoa_deg = 0
    `);
    await db.insert(simResultSubmitRetries).values({
      resultId,
      state: "blocked",
      attemptCount: 1,
      lastHttpStatus: 503,
      lastError: "answered submit retry exhausted",
    });
    const [obligation] = (await db.execute(sql`
      INSERT INTO sim_precalc_obligations
        (airfoil_id, revision_id, aoa_deg, source_result_id, state,
         attempt_count, last_outcome, last_error)
      VALUES
        (${airfoilId}, ${revisionId}, 0, ${resultId}, 'blocked',
         2, 'failed', 'precalc attempt budget exhausted')
      ON CONFLICT (airfoil_id, revision_id, aoa_deg) DO UPDATE
      SET source_result_id = EXCLUDED.source_result_id,
          state = EXCLUDED.state,
          attempt_count = EXCLUDED.attempt_count,
          last_outcome = EXCLUDED.last_outcome,
          last_error = EXCLUDED.last_error,
          "updatedAt" = now()
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    await db.execute(sql`
      INSERT INTO sim_precalc_obligation_campaigns
        (obligation_id, campaign_id, state)
      VALUES (${obligation.id}, ${campaignId}, 'active')
      ON CONFLICT (obligation_id, campaign_id) DO UPDATE
      SET state = 'active', cancelled_at = NULL, "updatedAt" = now()
    `);

    const snapshot = async () => {
      const [row] = (await db.execute(sql`
        SELECT
          (SELECT jsonb_build_object(
             'status', r.status, 'simJobId', r.sim_job_id, 'error', r.error,
             'updatedAt', r."updatedAt"::text
           ) FROM results r WHERE r.id = ${resultId}) AS result,
          (SELECT jsonb_build_object(
             'state', p.state, 'resultId', p.result_id,
             'updatedAt', p."updatedAt"::text
           ) FROM sim_campaign_points p
           WHERE p.campaign_id = ${campaignId}
             AND p.airfoil_id = ${airfoilId}
             AND p.revision_id = ${revisionId}
             AND p.aoa_deg = 0) AS point,
          (SELECT jsonb_build_object(
             'state', o.state, 'attemptCount', o.attempt_count,
             'lastOutcome', o.last_outcome, 'lastError', o.last_error,
             'updatedAt', o."updatedAt"::text
           ) FROM sim_precalc_obligations o WHERE o.id = ${obligation.id}) AS obligation,
          (SELECT jsonb_build_object(
             'state', retry.state, 'attemptCount', retry.attempt_count,
             'lastHttpStatus', retry.last_http_status,
             'lastError', retry.last_error,
             'updatedAt', retry."updatedAt"::text
           ) FROM sim_result_submit_retries retry
           WHERE retry.result_id = ${resultId}) AS retry
      `)) as unknown as Array<Record<string, unknown>>;
      return row;
    };

    const before = await snapshot();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/results/requeue-failed",
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain(
      "global failed-result requeue is disabled",
    );
    expect(await snapshot()).toEqual(before);
  });
});

describe("auth hardening", () => {
  it("requires admin for all three point-history routes in prod mode", async () => {
    process.env.ADMIN_AUTH_REQUIRED = "true";
    try {
      expect(
        (await app.inject({ method: "GET", url: "/api/admin/point-history" }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/admin/point-history/${resultIdByAoa.get(2)}/story`,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/admin/point-history/${resultIdByAoa.get(2)}/requeue`,
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      delete process.env.ADMIN_AUTH_REQUIRED;
    }
  });
});
