import type { Point } from "@aerodb/core";
import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  flowConditions,
  mediums,
  meshProfiles,
  outputProfiles,
  polarFitSets,
  referenceGeometryProfiles,
  resultClassifications,
  resultReviewVerdicts,
  results,
  schedulingProfiles,
  simulationPresets,
  solverProfiles,
  sweepDefinitions,
} from "@aerodb/db";
import { refreshPolarCacheForRevision } from "@aerodb/db/polar-cache";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const PREFIX = `review-verdicts-${process.pid}-${Date.now().toString(36)}`;
const ADMIN_EMAIL = "reviewer@airfoils.pro";
const ADMIN_PASSWORD = "review-verdict-password";

const points: Point[] = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.05 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.05 },
  { x: 1, y: 0 },
];

let app: Awaited<ReturnType<(typeof import("../src/server"))["buildServer"]>>;
let db: (typeof import("../src/db"))["db"];
let pgClient: (typeof import("../src/db"))["sql"];
let adminCookie = "";

const cleanup = {
  resultIds: [] as string[],
  presetIds: [] as string[],
  bcIds: [] as string[],
  flowIds: [] as string[],
  referenceIds: [] as string[],
  boundaryIds: [] as string[],
  meshIds: [] as string[],
  solverIds: [] as string[],
  schedulingIds: [] as string[],
  outputIds: [] as string[],
  sweepIds: [] as string[],
  airfoilIds: [] as string[],
  categoryIds: [] as string[],
};

async function deleteIds<T extends { id: unknown }>(table: T, ids: string[]) {
  if (ids.length)
    await db
      .delete(table as never)
      .where(inArray((table as { id: never }).id, ids));
}

async function createFixture(suffix: string) {
  const [air] = await db
    .select()
    .from(mediums)
    .where(eq(mediums.slug, "air"))
    .limit(1);
  expect(air).toBeTruthy();

  const [category] = await db
    .insert(categories)
    .values({
      slug: `${PREFIX}-${suffix}-cat`,
      name: `${PREFIX} ${suffix}`,
      path: `${PREFIX}-${suffix}-cat`,
      depth: 0,
    })
    .returning({ id: categories.id });
  cleanup.categoryIds.push(category.id);
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-${suffix}-af`,
      name: `${PREFIX} ${suffix} airfoil`,
      categoryId: category.id,
      points,
      isSymmetric: false,
    })
    .returning({ id: airfoils.id, slug: airfoils.slug });
  cleanup.airfoilIds.push(airfoil.id);

  const [bc] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${PREFIX}-${suffix}-bc`,
      name: `${PREFIX} ${suffix} bc`,
      mediumId: air.id,
      reynolds: 310000,
      referenceChordM: 0.5,
      speedMps: 9.05,
      density: air.density,
      dynamicViscosity: air.dynamicViscosity,
      kinematicViscosity: air.kinematicViscosity,
      mach: air.speedOfSound ? 9.05 / air.speedOfSound : null,
    })
    .returning({ id: boundaryConditions.id });
  cleanup.bcIds.push(bc.id);
  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${PREFIX}-${suffix}-flow`,
      name: `${PREFIX} ${suffix} flow`,
      mediumId: air.id,
      speedMps: 9.05,
      density: air.density,
      dynamicViscosity: air.dynamicViscosity,
      kinematicViscosity: air.kinematicViscosity,
      mach: air.speedOfSound ? 9.05 / air.speedOfSound : null,
    })
    .returning({ id: flowConditions.id });
  cleanup.flowIds.push(flow.id);
  const [reference] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${PREFIX}-${suffix}-ref`,
      name: `${PREFIX} ${suffix} ref`,
      geometryType: "airfoil_2d",
      referenceLengthKind: "chord",
      referenceLengthM: 0.5,
    })
    .returning({ id: referenceGeometryProfiles.id });
  cleanup.referenceIds.push(reference.id);
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({
      slug: `${PREFIX}-${suffix}-boundary`,
      name: `${PREFIX} ${suffix} boundary`,
    })
    .returning({ id: boundaryProfiles.id });
  const [mesh] = await db
    .insert(meshProfiles)
    .values({
      slug: `${PREFIX}-${suffix}-mesh`,
      name: `${PREFIX} ${suffix} mesh`,
    })
    .returning({ id: meshProfiles.id });
  const [solver] = await db
    .insert(solverProfiles)
    .values({
      slug: `${PREFIX}-${suffix}-solver`,
      name: `${PREFIX} ${suffix} solver`,
    })
    .returning({ id: solverProfiles.id });
  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({
      slug: `${PREFIX}-${suffix}-scheduling`,
      name: `${PREFIX} ${suffix} scheduling`,
    })
    .returning({ id: schedulingProfiles.id });
  const [output] = await db
    .insert(outputProfiles)
    .values({
      slug: `${PREFIX}-${suffix}-output`,
      name: `${PREFIX} ${suffix} output`,
    })
    .returning({ id: outputProfiles.id });
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({
      slug: `${PREFIX}-${suffix}-sweep`,
      name: `${PREFIX} ${suffix} sweep`,
      aoaStart: -2,
      aoaStop: 4,
      aoaStep: 2,
    })
    .returning({ id: sweepDefinitions.id });
  cleanup.boundaryIds.push(boundary.id);
  cleanup.meshIds.push(mesh.id);
  cleanup.solverIds.push(solver.id);
  cleanup.schedulingIds.push(scheduling.id);
  cleanup.outputIds.push(output.id);
  cleanup.sweepIds.push(sweep.id);

  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${PREFIX}-${suffix}-preset`,
      name: `${PREFIX} ${suffix} preset`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: reference.id,
      boundaryProfileId: boundary.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      schedulingProfileId: scheduling.id,
      outputProfileId: output.id,
      sweepDefinitionId: sweep.id,
      legacyBoundaryConditionId: bc.id,
      enabled: true,
    })
    .returning({ id: simulationPresets.id });
  cleanup.presetIds.push(preset.id);
  const resolved = await ensureSimulationPresetRevision(db, preset.id);
  expect(resolved).toBeTruthy();
  const revisionId = resolved!.revision.id;

  const base = {
    airfoilId: airfoil.id,
    bcId: bc.id,
    simulationPresetRevisionId: revisionId,
    status: "done" as const,
    source: "solved" as const,
    reynolds: 310000,
    speed: 9.05,
    chord: 0.5,
    mach: air.speedOfSound ? 9.05 / air.speedOfSound : null,
    solvedAt: new Date(),
  };
  const [left, right, review] = await db
    .insert(results)
    .values([
      {
        ...base,
        aoaDeg: -2,
        regime: "rans",
        fidelity: "rans",
        cl: -0.2,
        cd: 0.02,
        cm: 0.01,
        converged: true,
      },
      {
        ...base,
        aoaDeg: 2,
        regime: "rans",
        fidelity: "rans",
        cl: 0.2,
        cd: 0.02,
        cm: -0.01,
        converged: true,
      },
      {
        ...base,
        aoaDeg: 4,
        regime: "urans",
        fidelity: "urans_full",
        cl: 0.52,
        cd: 0.034,
        cm: -0.05,
        converged: true,
        unsteady: true,
        qualityWarnings: ["URANS retained 2.0 of 5 periods before review"],
        frameTrack: { stationary: true, periods_retained: 2 },
      },
    ])
    .returning({ id: results.id });
  cleanup.resultIds.push(left.id, right.id, review.id);
  await refreshPolarCacheForRevision(db, airfoil.id, revisionId);
  return {
    slug: airfoil.slug,
    airfoilId: airfoil.id,
    revisionId,
    reviewResultId: review.id,
    acceptedResultId: left.id,
  };
}

async function authed(
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: unknown,
) {
  return app.inject({ method, url, headers: { cookie: adminCookie }, payload });
}

async function currentFit(airfoilId: string, revisionId: string) {
  const rows = await db
    .select()
    .from(polarFitSets)
    .where(eq(polarFitSets.airfoilId, airfoilId));
  return (
    rows.find(
      (row) => row.simulationPresetRevisionId === revisionId && row.isCurrent,
    ) ?? null
  );
}

beforeAll(async () => {
  process.env.ADMIN_AUTH_REQUIRED = "true";
  process.env.ADMIN_AUTH_DISABLED = "false";
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.ADMIN_SESSION_SECRET = "review-verdict-test-secret";

  const [serverModule, dbModule] = await Promise.all([
    import("../src/server"),
    import("../src/db"),
  ]);
  db = dbModule.db;
  pgClient = dbModule.sql;
  app = await serverModule.buildServer();

  const login = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers["set-cookie"];
  adminCookie = String(
    Array.isArray(setCookie) ? setCookie[0] : setCookie,
  ).split(";")[0];
}, 60_000);

afterAll(async () => {
  if (cleanup.resultIds.length) {
    await db
      .delete(resultReviewVerdicts)
      .where(inArray(resultReviewVerdicts.resultId, cleanup.resultIds));
    await db
      .delete(resultClassifications)
      .where(inArray(resultClassifications.resultId, cleanup.resultIds));
  }
  await deleteIds(results, cleanup.resultIds);
  if (cleanup.airfoilIds.length) {
    await db
      .delete(polarFitSets)
      .where(inArray(polarFitSets.airfoilId, cleanup.airfoilIds));
  }
  await deleteIds(simulationPresets, cleanup.presetIds);
  await deleteIds(boundaryConditions, cleanup.bcIds);
  await deleteIds(flowConditions, cleanup.flowIds);
  await deleteIds(referenceGeometryProfiles, cleanup.referenceIds);
  await deleteIds(boundaryProfiles, cleanup.boundaryIds);
  await deleteIds(meshProfiles, cleanup.meshIds);
  await deleteIds(solverProfiles, cleanup.solverIds);
  await deleteIds(schedulingProfiles, cleanup.schedulingIds);
  await deleteIds(outputProfiles, cleanup.outputIds);
  await deleteIds(sweepDefinitions, cleanup.sweepIds);
  await deleteIds(airfoils, cleanup.airfoilIds);
  await deleteIds(categories, cleanup.categoryIds);
  await app.close();
  await pgClient.end();
  process.env = { ...ORIGINAL_ENV };
}, 60_000);

describe("review verdict overlay", () => {
  it("waive marks solver-work verified, refreshes the polar cache, and discloses in detail", async () => {
    const fixture = await createFixture("waive");
    const res = await authed(
      "POST",
      `/api/admin/results/${fixture.reviewResultId}/review`,
      {
        verdict: "waive",
        note: "accepted after visual review",
      },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().review).toMatchObject({
      verdict: "waive",
      note: "accepted after visual review",
      reviewer: ADMIN_EMAIL,
    });

    const work = await app.inject({
      method: "GET",
      url: `/api/airfoils/${fixture.slug}/solver-work?revision=${fixture.revisionId}`,
    });
    const point = work
      .json()
      .conditions[0].points.find(
        (p: { resultId: string }) => p.resultId === fixture.reviewResultId,
      );
    expect(point).toMatchObject({
      state: "verified",
      reviewed: true,
      review: { verdict: "waive", note: "accepted after visual review" },
    });
    expect(
      point.gates.some((gate: { pass: boolean }) => gate.pass === false),
    ).toBe(true);

    const fit = await currentFit(fixture.airfoilId, fixture.revisionId);
    expect(fit?.acceptedPointCount).toBe(3);
    expect(fit?.status).toBe("final");

    const detail = await app.inject({
      method: "GET",
      url: `/api/airfoils/${fixture.slug}?revisionId=${fixture.revisionId}`,
    });
    const polarPoint = detail
      .json()
      .polars[0].points.find(
        (p: { resultId: string }) => p.resultId === fixture.reviewResultId,
      );
    expect(polarPoint).toMatchObject({
      classificationState: "accepted",
      review: { verdict: "waive", note: "accepted after visual review" },
    });
  });

  it("exclude marks solver-work excluded, removes the point from the fit, and keeps it listed", async () => {
    const fixture = await createFixture("exclude");
    const res = await authed(
      "POST",
      `/api/admin/results/${fixture.reviewResultId}/review`,
      {
        verdict: "exclude",
        note: "bad retained-period evidence",
      },
    );
    expect(res.statusCode).toBe(201);

    const work = await app.inject({
      method: "GET",
      url: `/api/airfoils/${fixture.slug}/solver-work?revision=${fixture.revisionId}`,
    });
    const condition = work.json().conditions[0];
    const point = condition.points.find(
      (p: { resultId: string }) => p.resultId === fixture.reviewResultId,
    );
    expect(point).toMatchObject({
      state: "excluded",
      reviewed: true,
      review: { verdict: "exclude" },
    });
    expect(condition.attentionCount).toBe(0);

    const fit = await currentFit(fixture.airfoilId, fixture.revisionId);
    expect(fit?.acceptedPointCount).toBe(2);
    expect(fit?.status).toBe("insufficient");
  });

  it("revoke restores the machine needs-review state and refreshes caches", async () => {
    const fixture = await createFixture("revoke");
    expect(
      (
        await authed(
          "POST",
          `/api/admin/results/${fixture.reviewResultId}/review`,
          { verdict: "waive", note: "temporary waiver" },
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await authed(
          "DELETE",
          `/api/admin/results/${fixture.reviewResultId}/review`,
        )
      ).statusCode,
    ).toBe(204);

    const work = await app.inject({
      method: "GET",
      url: `/api/airfoils/${fixture.slug}/solver-work?revision=${fixture.revisionId}`,
    });
    const point = work
      .json()
      .conditions[0].points.find(
        (p: { resultId: string }) => p.resultId === fixture.reviewResultId,
      );
    expect(point).toMatchObject({
      state: "needs_review",
      reviewed: false,
      review: null,
    });
    const fit = await currentFit(fixture.airfoilId, fixture.revisionId);
    expect(fit?.acceptedPointCount).toBe(2);
  });

  it("re-verdict auto-revokes the previous active verdict and keeps history", async () => {
    const fixture = await createFixture("reverdict");
    expect(
      (
        await authed(
          "POST",
          `/api/admin/results/${fixture.reviewResultId}/review`,
          { verdict: "waive", note: "first verdict" },
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await authed(
          "POST",
          `/api/admin/results/${fixture.reviewResultId}/review`,
          { verdict: "exclude", note: "second verdict" },
        )
      ).statusCode,
    ).toBe(201);

    const history = await authed(
      "GET",
      `/api/admin/results/${fixture.reviewResultId}/reviews`,
    );
    expect(history.statusCode).toBe(200);
    const items = history.json().items as Array<{
      verdict: string;
      revokedAt: string | null;
    }>;
    expect(items.map((item) => item.verdict)).toEqual(["exclude", "waive"]);
    expect(items[0].revokedAt).toBeNull();
    expect(items[1].revokedAt).toEqual(expect.any(String));
  });

  it("requires notes for waive/exclude, rejects non-reviewable points, and gates anonymous callers", async () => {
    const fixture = await createFixture("validation");
    const missingNote = await authed(
      "POST",
      `/api/admin/results/${fixture.reviewResultId}/review`,
      { verdict: "waive" },
    );
    expect(missingNote.statusCode).toBe(422);

    const nonReviewable = await authed(
      "POST",
      `/api/admin/results/${fixture.acceptedResultId}/review`,
      {
        verdict: "exclude",
        note: "not reviewable",
      },
    );
    expect(nonReviewable.statusCode).toBe(409);

    const anonymous = await app.inject({
      method: "POST",
      url: `/api/admin/results/${fixture.reviewResultId}/review`,
      payload: { verdict: "defer", note: "anonymous attempt" },
    });
    expect([401, 403]).toContain(anonymous.statusCode);
  });

  it("MUST-CATCH: a waived point does not count in another airfoil or revision scope", async () => {
    const waived = await createFixture("scope-waived");
    const other = await createFixture("scope-other");
    expect(
      (
        await authed(
          "POST",
          `/api/admin/results/${waived.reviewResultId}/review`,
          { verdict: "waive", note: "scope-local waiver" },
        )
      ).statusCode,
    ).toBe(201);

    const otherFit = await currentFit(other.airfoilId, other.revisionId);
    expect(otherFit?.acceptedPointCount).toBe(2);

    const otherWork = await app.inject({
      method: "GET",
      url: `/api/airfoils/${other.slug}/solver-work?revision=${other.revisionId}`,
    });
    const otherPoint = otherWork
      .json()
      .conditions[0].points.find(
        (p: { resultId: string }) => p.resultId === other.reviewResultId,
      );
    expect(otherPoint).toMatchObject({
      state: "needs_review",
      reviewed: false,
    });
  });
});
