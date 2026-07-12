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
  refreshPolarCacheForRevision,
  resultClassifications,
  results,
  schedulingProfiles,
  simulationPresets,
  solverProfiles,
  sweepDefinitions,
} from "@aerodb/db";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, sql } from "../src/db";
import { assembleDetail } from "../src/services/detail";
import { listAirfoils } from "../src/services/catalog";
import { createExactResultAttemptFixture } from "./exact-result-fixture";

const cleanupResultIds = new Set<string>();
const cleanupClassificationIds = new Set<string>();
const cleanupFitSetIds = new Set<string>();
const cleanupPresetIds = new Set<string>();
const cleanupBoundaryConditionIds = new Set<string>();
const cleanupFlowConditionIds = new Set<string>();
const cleanupReferenceGeometryIds = new Set<string>();
const cleanupBoundaryProfileIds = new Set<string>();
const cleanupMeshProfileIds = new Set<string>();
const cleanupSolverProfileIds = new Set<string>();
const cleanupSchedulingProfileIds = new Set<string>();
const cleanupOutputProfileIds = new Set<string>();
const cleanupSweepDefinitionIds = new Set<string>();
const cleanupAirfoilIds = new Set<string>();
const cleanupCategoryIds = new Set<string>();

// Geometrically symmetric contour (spec §9.1 — symmetry is a real property).
const symmetricPoints = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.06 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.06 },
  { x: 1, y: 0 },
];

async function createTestBoundaryCondition(unique: string, reynolds = 500000) {
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
    .returning({
      id: boundaryConditions.id,
      reynolds: boundaryConditions.reynolds,
    });
  cleanupBoundaryConditionIds.add(bc.id);

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
  cleanupFlowConditionIds.add(flow.id);

  const [referenceGeometry] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${unique}-reference-geometry`,
      name: `${unique} Reference Geometry`,
      geometryType: "airfoil_2d",
      referenceLengthKind: "chord",
      referenceLengthM: 1,
    })
    .returning({ id: referenceGeometryProfiles.id });
  cleanupReferenceGeometryIds.add(referenceGeometry.id);

  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({
      slug: `${unique}-boundary`,
      name: `${unique} Boundary`,
      turbulenceIntensity: 0.001,
      viscosityRatio: 10,
    })
    .returning({ id: boundaryProfiles.id });
  cleanupBoundaryProfileIds.add(boundary.id);

  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${unique}-mesh`, name: `${unique} Mesh` })
    .returning({ id: meshProfiles.id });
  cleanupMeshProfileIds.add(mesh.id);

  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${unique}-solver`, name: `${unique} Solver` })
    .returning({ id: solverProfiles.id });
  cleanupSolverProfileIds.add(solver.id);

  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({ slug: `${unique}-scheduling`, name: `${unique} Scheduling` })
    .returning({ id: schedulingProfiles.id });
  cleanupSchedulingProfileIds.add(scheduling.id);

  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${unique}-output`, name: `${unique} Output` })
    .returning({ id: outputProfiles.id });
  cleanupOutputProfileIds.add(output.id);

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
  cleanupSweepDefinitionIds.add(sweep.id);

  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${unique}-preset`,
      name: `${unique} Preset`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: referenceGeometry.id,
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
  cleanupPresetIds.add(preset.id);

  const resolved = await ensureSimulationPresetRevision(db, preset.id);
  expect(resolved).toBeTruthy();
  return {
    ...bc,
    presetId: preset.id,
    presetRevisionId: resolved!.revision.id,
  };
}

afterAll(async () => {
  if (cleanupFitSetIds.size)
    await db
      .delete(polarFitSets)
      .where(inArray(polarFitSets.id, Array.from(cleanupFitSetIds)));
  if (cleanupClassificationIds.size) {
    await db
      .delete(resultClassifications)
      .where(
        inArray(resultClassifications.id, Array.from(cleanupClassificationIds)),
      );
  }
  if (cleanupResultIds.size)
    await db
      .delete(results)
      .where(inArray(results.id, Array.from(cleanupResultIds)));
  if (cleanupPresetIds.size) {
    await db
      .delete(simulationPresets)
      .where(inArray(simulationPresets.id, Array.from(cleanupPresetIds)));
  }
  if (cleanupBoundaryConditionIds.size) {
    await db
      .delete(boundaryConditions)
      .where(
        inArray(boundaryConditions.id, Array.from(cleanupBoundaryConditionIds)),
      );
  }
  if (cleanupFlowConditionIds.size) {
    await db
      .delete(flowConditions)
      .where(inArray(flowConditions.id, Array.from(cleanupFlowConditionIds)));
  }
  if (cleanupReferenceGeometryIds.size) {
    await db
      .delete(referenceGeometryProfiles)
      .where(
        inArray(
          referenceGeometryProfiles.id,
          Array.from(cleanupReferenceGeometryIds),
        ),
      );
  }
  if (cleanupBoundaryProfileIds.size) {
    await db
      .delete(boundaryProfiles)
      .where(
        inArray(boundaryProfiles.id, Array.from(cleanupBoundaryProfileIds)),
      );
  }
  if (cleanupMeshProfileIds.size) {
    await db
      .delete(meshProfiles)
      .where(inArray(meshProfiles.id, Array.from(cleanupMeshProfileIds)));
  }
  if (cleanupSolverProfileIds.size) {
    await db
      .delete(solverProfiles)
      .where(inArray(solverProfiles.id, Array.from(cleanupSolverProfileIds)));
  }
  if (cleanupSchedulingProfileIds.size) {
    await db
      .delete(schedulingProfiles)
      .where(
        inArray(schedulingProfiles.id, Array.from(cleanupSchedulingProfileIds)),
      );
  }
  if (cleanupOutputProfileIds.size) {
    await db
      .delete(outputProfiles)
      .where(inArray(outputProfiles.id, Array.from(cleanupOutputProfileIds)));
  }
  if (cleanupSweepDefinitionIds.size) {
    await db
      .delete(sweepDefinitions)
      .where(
        inArray(sweepDefinitions.id, Array.from(cleanupSweepDefinitionIds)),
      );
  }
  if (cleanupAirfoilIds.size)
    await db
      .delete(airfoils)
      .where(inArray(airfoils.id, Array.from(cleanupAirfoilIds)));
  if (cleanupCategoryIds.size)
    await db
      .delete(categories)
      .where(inArray(categories.id, Array.from(cleanupCategoryIds)));
  await sql.end();
});

describe("symmetric airfoil read-path derivation (spec §9.2–§9.3)", () => {
  it("mirrors display points and fit coverage without inflating real-solve counts", async () => {
    const unique = `symmetry-detail-${Date.now()}`;
    const bc = await createTestBoundaryCondition(unique);

    const [cat] = await db
      .insert(categories)
      .values({
        slug: unique,
        name: "Symmetry Detail Test",
        path: unique,
        depth: 0,
        sortOrder: 998,
      })
      .returning({ id: categories.id });
    cleanupCategoryIds.add(cat.id);

    const [airfoil] = await db
      .insert(airfoils)
      .values({
        slug: unique,
        name: `${unique} Airfoil`,
        categoryId: cat.id,
        source: "test",
        points: symmetricPoints,
        thicknessPct: 12,
        camberPct: 0,
        refMetricsSource: "queued",
        tags: [],
        isSymmetric: true,
        symmetryCheckedAt: new Date(),
      })
      .returning({ id: airfoils.id });
    cleanupAirfoilIds.add(airfoil.id);

    // Three real +α solves plus one REAL negative solve at α = −2 (the mirror
    // of +2 must be suppressed by the real point).
    const solveSpecs = [
      { aoa: 2, cl: 0.4 },
      { aoa: 4, cl: 0.6 },
      { aoa: 6, cl: 0.8 },
      { aoa: -2, cl: -0.41 },
    ];
    const realRows = await db
      .insert(results)
      .values(
        solveSpecs.map((spec) => ({
          airfoilId: airfoil.id,
          bcId: bc.id,
          simulationPresetRevisionId: bc.presetRevisionId,
          aoaDeg: spec.aoa,
          status: "done" as const,
          source: "solved" as const,
          regime: "rans" as const,
          cl: spec.cl,
          cd: 0.02,
          cm: spec.cl >= 0 ? -0.02 : 0.02,
          clCd: spec.cl / 0.02,
          converged: true,
          solvedAt: new Date(),
        })),
      )
      .returning({ id: results.id, aoaDeg: results.aoaDeg });
    realRows.forEach((row) => cleanupResultIds.add(row.id));
    for (const row of realRows) {
      await createExactResultAttemptFixture(db, row.id, {
        publication: "selected-eligible",
      });
    }
    const resultIdByAoa = new Map(realRows.map((row) => [row.aoaDeg, row.id]));

    const refreshed = await refreshPolarCacheForRevision(
      db,
      airfoil.id,
      bc.presetRevisionId,
    );
    if (refreshed.fitSetId) cleanupFitSetIds.add(refreshed.fitSetId);
    const cachedClassifications = await db
      .select({
        id: resultClassifications.id,
        aoaDeg: resultClassifications.aoaDeg,
      })
      .from(resultClassifications)
      .where(
        and(
          eq(resultClassifications.airfoilId, airfoil.id),
          isNull(resultClassifications.resultAttemptId),
        ),
      );
    cachedClassifications.forEach((row) =>
      cleanupClassificationIds.add(row.id),
    );

    // result_classifications rows stay real-rows-only: no rows at −4/−6.
    expect(
      cachedClassifications.map((row) => row.aoaDeg).sort((a, b) => a - b),
    ).toEqual([-2, 2, 4, 6]);

    // Fit set: counts stay real-solve-only, fit points span the mirrored side,
    // and the zero-lift angle lands near 0° for a symmetric airfoil.
    const [fitSet] = await db
      .select()
      .from(polarFitSets)
      .where(eq(polarFitSets.id, refreshed.fitSetId!))
      .limit(1);
    expect(fitSet.acceptedPointCount + fitSet.provisionalPointCount).toBe(4);
    expect(fitSet.aoaMin).not.toBeNull();
    expect(fitSet.aoaMin!).toBeLessThanOrEqual(-6);
    expect(fitSet.alphaClZeroFine).not.toBeNull();
    expect(Math.abs(fitSet.alphaClZeroFine!)).toBeLessThan(0.5);

    // Browse polarCount / rankings count real solves only (4, not 6).
    const [summary] = await listAirfoils({
      q: `${unique} Airfoil`,
      sort: "ldmax",
      dir: "desc",
    });
    expect(summary.polarCount).toBe(4);

    // Detail payload: 4 real points + mirrors for +4/+6 only (real −2 wins).
    const detail = await assembleDetail(unique);
    const points = detail?.polars.flatMap((polar) => polar.points) ?? [];
    expect(points).toHaveLength(6);
    type MaybeDerived = (typeof points)[number] & {
      derived?: boolean;
      derivedFromResultId?: string;
      derivedFromAoaDeg?: number;
    };
    const derived = (points as MaybeDerived[]).filter(
      (p) => p.derived === true,
    );
    expect(derived.map((p) => p.a).sort((a, b) => a - b)).toEqual([-6, -4]);
    const minusFour = derived.find((p) => p.a === -4)!;
    expect(minusFour.derivedFromResultId).toBe(resultIdByAoa.get(4));
    expect(minusFour.derivedFromAoaDeg).toBe(4);
    expect(minusFour.resultId).toBe(resultIdByAoa.get(4));
    expect(minusFour.cl).toBeCloseTo(-0.6, 10);
    expect(minusFour.cd).toBeCloseTo(0.02, 10);
    expect(minusFour.cm).toBeCloseTo(0.02, 10);
    expect(minusFour.ld).toBeCloseTo(-0.6 / 0.02, 10);
    expect(minusFour.classificationState).toBe("accepted");
    const minusTwo = (points as MaybeDerived[]).find((p) => p.a === -2)!;
    expect(minusTwo.derived).toBeUndefined();
    expect(minusTwo.resultId).toBe(resultIdByAoa.get(-2));
    expect(minusTwo.cl).toBeCloseTo(-0.41, 10);

    // Toggling isSymmetric off refreshes the fit set (signature carries the
    // symmetry marker) and drops mirrored coverage + display points.
    await db
      .update(airfoils)
      .set({ isSymmetric: false })
      .where(eq(airfoils.id, airfoil.id));
    const refreshedOff = await refreshPolarCacheForRevision(
      db,
      airfoil.id,
      bc.presetRevisionId,
    );
    if (refreshedOff.fitSetId) cleanupFitSetIds.add(refreshedOff.fitSetId);
    expect(refreshedOff.fitSetId).not.toBe(refreshed.fitSetId);
    const [fitSetOff] = await db
      .select()
      .from(polarFitSets)
      .where(eq(polarFitSets.id, refreshedOff.fitSetId!))
      .limit(1);
    expect(fitSetOff.aoaMin).not.toBeNull();
    expect(fitSetOff.aoaMin!).toBeGreaterThanOrEqual(-2);
    const detailOff = await assembleDetail(unique);
    const pointsOff = (detailOff?.polars.flatMap((polar) => polar.points) ??
      []) as MaybeDerived[];
    expect(pointsOff).toHaveLength(4);
    expect(pointsOff.every((p) => p.derived === undefined)).toBe(true);
  });
});
