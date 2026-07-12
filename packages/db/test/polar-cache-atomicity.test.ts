import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient } from "../src/client";
import {
  refreshPolarCacheForRevision,
  refreshPolarCompatibilityCache,
} from "../src/polar-cache";
import {
  airfoils,
  boundaryProfiles,
  boundaryConditions,
  categories,
  flowConditions,
  forceHistory,
  mediums,
  meshProfiles,
  outputProfiles,
  polarCompatibilityFitSets,
  polarFitPoints,
  polarFitSets,
  referenceGeometryProfiles,
  resultAttempts,
  resultClassifications,
  resultMedia,
  results,
  schedulingProfiles,
  simulationPresets,
  simulationPresetRevisions,
  solverProfiles,
  sweepDefinitions,
} from "../src/schema";

const { db, sql: pgClient } = createClient({ max: 4 });
const PREFIX = `polar-atomic-${process.pid}-${Date.now().toString(36)}`;

describe("revision polar cache transaction boundary", () => {
  let airfoilId = "";
  let categoryId = "";
  let revisionId = "";
  let presetId = "";
  let bcId = "";
  const profileIds: Record<string, string> = {};
  let priorFitSetId = "";
  let priorPointCount = 0;

  beforeAll(async () => {
    const [medium] = await db
      .select({ id: mediums.id })
      .from(mediums)
      .where(eq(mediums.slug, "air"))
      .limit(1);
    expect(medium).toBeTruthy();

    const [flow] = await db
      .insert(flowConditions)
      .values({
        slug: `${PREFIX}-flow`,
        name: `${PREFIX} flow`,
        mediumId: medium.id,
        speedMps: 25.321,
      })
      .returning({ id: flowConditions.id });
    profileIds.flow = flow.id;
    const [reference] = await db
      .insert(referenceGeometryProfiles)
      .values({
        slug: `${PREFIX}-reference`,
        name: `${PREFIX} reference`,
        referenceLengthM: 0.10321,
      })
      .returning({ id: referenceGeometryProfiles.id });
    profileIds.reference = reference.id;
    const [boundary] = await db
      .insert(boundaryProfiles)
      .values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` })
      .returning({ id: boundaryProfiles.id });
    profileIds.boundary = boundary.id;
    const [mesh] = await db
      .insert(meshProfiles)
      .values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` })
      .returning({ id: meshProfiles.id });
    profileIds.mesh = mesh.id;
    const [solver] = await db
      .insert(solverProfiles)
      .values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` })
      .returning({ id: solverProfiles.id });
    profileIds.solver = solver.id;
    const [scheduling] = await db
      .insert(schedulingProfiles)
      .values({
        slug: `${PREFIX}-scheduling`,
        name: `${PREFIX} scheduling`,
      })
      .returning({ id: schedulingProfiles.id });
    profileIds.scheduling = scheduling.id;
    const [output] = await db
      .insert(outputProfiles)
      .values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` })
      .returning({ id: outputProfiles.id });
    profileIds.output = output.id;
    const [sweep] = await db
      .insert(sweepDefinitions)
      .values({ slug: `${PREFIX}-sweep`, name: `${PREFIX} sweep` })
      .returning({ id: sweepDefinitions.id });
    profileIds.sweep = sweep.id;
    const [bc] = await db
      .insert(boundaryConditions)
      .values({
        slug: `${PREFIX}-bc`,
        name: `${PREFIX} bc`,
        mediumId: medium.id,
        reynolds: 179123,
      })
      .returning({ id: boundaryConditions.id });
    bcId = bc.id;
    const [preset] = await db
      .insert(simulationPresets)
      .values({
        slug: `${PREFIX}-preset`,
        name: `${PREFIX} preset`,
        flowConditionId: flow.id,
        referenceGeometryProfileId: reference.id,
        boundaryProfileId: boundary.id,
        meshProfileId: mesh.id,
        solverProfileId: solver.id,
        schedulingProfileId: scheduling.id,
        outputProfileId: output.id,
        sweepDefinitionId: sweep.id,
        legacyBoundaryConditionId: bc.id,
      })
      .returning({ id: simulationPresets.id });
    presetId = preset.id;
    const [revision] = await db
      .insert(simulationPresetRevisions)
      .values({
        presetId,
        revisionNumber: 1,
        signatureHash: `${PREFIX}-signature`,
        reynolds: 179123,
        mach: 0.07,
        referenceLengthM: 0.10321,
        snapshot: {
          flowState: {
            mediumId: medium.id,
            mediumSlug: "air",
            temperatureK: 288.15,
            pressurePa: 101325,
            speedMps: 25.321,
            density: 1.225,
            dynamicViscosity: 1.789e-5,
            kinematicViscosity: 1.46e-5,
          },
          referenceGeometry: {
            geometryType: "airfoil_2d",
            referenceLengthKind: "chord",
            referenceLengthM: 0.10321,
            spanM: null,
            referenceAreaM2: null,
          },
          boundary: {
            turbulenceIntensity: 0.001,
            viscosityRatio: 10,
            sandGrainHeight: 0,
            roughnessConstant: 0.5,
          },
          mesh: { id: mesh.id, slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` },
          solver: {
            id: solver.id,
            slug: `${PREFIX}-solver`,
            name: `${PREFIX} solver`,
          },
          derived: { reynolds: 179123, mach: 0.07 },
        },
        physicsHash: `${PREFIX}-physics`,
      })
      .returning({ id: simulationPresetRevisions.id });
    revisionId = revision.id;

    const [category] = await db
      .insert(categories)
      .values({
        slug: `${PREFIX}-category`,
        name: `${PREFIX} category`,
        path: `${PREFIX}-category`,
        depth: 0,
      })
      .returning({ id: categories.id });
    categoryId = category.id;
    const [airfoil] = await db
      .insert(airfoils)
      .values({
        slug: `${PREFIX}-airfoil`,
        name: `${PREFIX} airfoil`,
        categoryId,
        source: "test",
        points: [
          { x: 1, y: 0 },
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
        tags: [],
      })
      .returning({ id: airfoils.id });
    airfoilId = airfoil.id;

    const seededResults = await db
      .insert(results)
      .values(
        [-4, -2, 0, 2, 4].map((aoaDeg) => {
          const cl = 0.1 * aoaDeg;
          const cd = 0.012 + Math.abs(aoaDeg) * 0.001;
          return {
            airfoilId,
            bcId,
            simulationPresetRevisionId: revisionId,
            aoaDeg,
            status: "done" as const,
            source: "solved" as const,
            regime: "rans" as const,
            fidelity: "rans",
            cl,
            cd,
            cm: -0.01,
            clCd: cl / cd,
            converged: true,
            stalled: false,
            solvedAt: new Date(),
          };
        }),
      )
      .returning({ id: results.id, aoaDeg: results.aoaDeg });
    for (const result of seededResults) {
      const cl = 0.1 * result.aoaDeg;
      const cd = 0.012 + Math.abs(result.aoaDeg) * 0.001;
      const [attempt] = await db
        .insert(resultAttempts)
        .values({
          resultId: result.id,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: result.aoaDeg,
          status: "done",
          source: "solved",
          regime: "rans",
          validForPolar: true,
          cl,
          cd,
          cm: -0.01,
          clCd: cl / cd,
          converged: true,
          stalled: false,
          evidencePayload: { fidelity: "rans" },
          solvedAt: new Date(),
        })
        .returning({ id: resultAttempts.id });
      await db
        .update(results)
        .set({ currentResultAttemptId: attempt.id })
        .where(eq(results.id, result.id));
    }
    const refreshed = await refreshPolarCacheForRevision(
      db,
      airfoilId,
      revisionId,
    );
    expect(refreshed.fitSetId).toBeTruthy();
    priorFitSetId = refreshed.fitSetId!;
    const [count] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(polarFitPoints)
      .where(eq(polarFitPoints.fitSetId, priorFitSetId));
    priorPointCount = count.value;
    expect(priorPointCount).toBeGreaterThan(0);
  }, 60_000);

  afterAll(async () => {
    if (airfoilId) {
      await db
        .delete(polarCompatibilityFitSets)
        .where(eq(polarCompatibilityFitSets.airfoilId, airfoilId));
      await db
        .delete(polarFitSets)
        .where(eq(polarFitSets.airfoilId, airfoilId));
      await db
        .delete(resultClassifications)
        .where(eq(resultClassifications.airfoilId, airfoilId));
      await db
        .update(results)
        .set({ currentResultAttemptId: null })
        .where(eq(results.airfoilId, airfoilId));
      await db
        .delete(resultAttempts)
        .where(eq(resultAttempts.airfoilId, airfoilId));
      await db.delete(results).where(eq(results.airfoilId, airfoilId));
      await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
    }
    if (presetId) {
      await db
        .delete(simulationPresetRevisions)
        .where(eq(simulationPresetRevisions.presetId, presetId));
      await db
        .delete(simulationPresets)
        .where(eq(simulationPresets.id, presetId));
    }
    if (bcId) {
      await db
        .delete(boundaryConditions)
        .where(eq(boundaryConditions.id, bcId));
    }
    if (profileIds.flow)
      await db
        .delete(flowConditions)
        .where(eq(flowConditions.id, profileIds.flow));
    if (profileIds.reference)
      await db
        .delete(referenceGeometryProfiles)
        .where(eq(referenceGeometryProfiles.id, profileIds.reference));
    if (profileIds.boundary)
      await db
        .delete(boundaryProfiles)
        .where(eq(boundaryProfiles.id, profileIds.boundary));
    if (profileIds.mesh)
      await db.delete(meshProfiles).where(eq(meshProfiles.id, profileIds.mesh));
    if (profileIds.solver)
      await db
        .delete(solverProfiles)
        .where(eq(solverProfiles.id, profileIds.solver));
    if (profileIds.scheduling)
      await db
        .delete(schedulingProfiles)
        .where(eq(schedulingProfiles.id, profileIds.scheduling));
    if (profileIds.output)
      await db
        .delete(outputProfiles)
        .where(eq(outputProfiles.id, profileIds.output));
    if (profileIds.sweep)
      await db
        .delete(sweepDefinitions)
        .where(eq(sweepDefinitions.id, profileIds.sweep));
    if (categoryId) {
      await db.delete(categories).where(eq(categories.id, categoryId));
    }
    await pgClient.end();
  }, 30_000);

  it("keeps the previously committed current fit and points visible mid-refresh", async () => {
    let entered!: () => void;
    let release!: () => void;
    const afterDelete = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const mayContinue = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = refreshPolarCacheForRevision(db, airfoilId, revisionId, {
      afterFitPointsDeleted: async () => {
        entered();
        await mayContinue;
      },
    });

    await afterDelete;
    const currentDuring = await db
      .select({ id: polarFitSets.id })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      );
    const [pointsDuring] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(polarFitPoints)
      .where(eq(polarFitPoints.fitSetId, priorFitSetId));
    expect(currentDuring.map((row) => row.id)).toEqual([priorFitSetId]);
    expect(pointsDuring.value).toBe(priorPointCount);

    release();
    await refresh;
  }, 60_000);

  it("rolls back current flags and point deletion when refresh fails", async () => {
    const before = await db
      .select({ id: polarFitSets.id })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      );
    expect(before).toHaveLength(1);
    const currentId = before[0].id;
    const [pointsBefore] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(polarFitPoints)
      .where(eq(polarFitPoints.fitSetId, currentId));

    await expect(
      refreshPolarCacheForRevision(db, airfoilId, revisionId, {
        afterFitPointsDeleted: async () => {
          throw new Error("synthetic post-delete failure");
        },
      }),
    ).rejects.toThrow("synthetic post-delete failure");

    const after = await db
      .select({ id: polarFitSets.id })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      );
    const [pointsAfter] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(polarFitPoints)
      .where(eq(polarFitPoints.fitSetId, currentId));
    expect(after.map((row) => row.id)).toEqual([currentId]);
    expect(pointsAfter.value).toBe(pointsBefore.value);
  }, 60_000);

  it("serializes concurrent refreshes to one current fit", async () => {
    await Promise.all([
      refreshPolarCacheForRevision(db, airfoilId, revisionId),
      refreshPolarCacheForRevision(db, airfoilId, revisionId),
    ]);
    const current = await db
      .select({ id: polarFitSets.id })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      );
    expect(current).toHaveLength(1);
    const [points] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(polarFitPoints)
      .where(eq(polarFitPoints.fitSetId, current[0].id));
    expect(points.value).toBeGreaterThan(0);
  }, 60_000);

  it("publishes a pointer promotion and rebuilt cache at one transaction boundary", async () => {
    const [target] = await db
      .select({
        id: results.id,
        currentResultAttemptId: results.currentResultAttemptId,
        cl: results.cl,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, revisionId),
          eq(results.aoaDeg, 0),
        ),
      )
      .limit(1);
    expect(target.currentResultAttemptId).toBeTruthy();

    const [replacement] = await db
      .insert(resultAttempts)
      .values({
        resultId: target.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 0,
        status: "done",
        source: "solved",
        regime: "rans",
        validForPolar: true,
        cl: 0.05,
        cd: 0.0125,
        cm: -0.011,
        clCd: 4,
        converged: true,
        evidencePayload: { fidelity: "rans" },
        solvedAt: new Date(),
      })
      .returning({ id: resultAttempts.id });
    const [fitBefore] = await db
      .select({ id: polarFitSets.id })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      )
      .limit(1);

    let entered!: () => void;
    let release!: () => void;
    const promotedButUncommitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = refreshPolarCacheForRevision(db, airfoilId, revisionId, {
      beforeEvidenceLoad: async (tx) => {
        await tx
          .update(results)
          .set({
            currentResultAttemptId: replacement.id,
            status: "done",
            source: "solved",
            regime: "rans",
            fidelity: "rans",
            cl: 0.05,
            cd: 0.0125,
            cm: -0.011,
            clCd: 4,
            converged: true,
            stalled: false,
            unsteady: false,
            error: null,
          })
          .where(eq(results.id, target.id));
        entered();
        await mayCommit;
      },
    });

    await promotedButUncommitted;
    const [during] = await db
      .select({
        currentResultAttemptId: results.currentResultAttemptId,
        cl: results.cl,
      })
      .from(results)
      .where(eq(results.id, target.id));
    const [fitDuring] = await db
      .select({ id: polarFitSets.id })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      );
    expect(during).toEqual({
      currentResultAttemptId: target.currentResultAttemptId,
      cl: target.cl,
    });
    expect(fitDuring.id).toBe(fitBefore.id);

    release();
    await refresh;
    const [after] = await db
      .select({
        currentResultAttemptId: results.currentResultAttemptId,
        cl: results.cl,
      })
      .from(results)
      .where(eq(results.id, target.id));
    const [fitAfter] = await db
      .select({ id: polarFitSets.id })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      );
    expect(after).toEqual({
      currentResultAttemptId: replacement.id,
      cl: 0.05,
    });
    expect(fitAfter.id).not.toBe(fitBefore.id);
  }, 60_000);

  it("classifies and fits only the exact pointed attempt generation", async () => {
    const validForceHistory = {
      t: [0, 0.1, 0.2],
      cl: [0.7, 0.72, 0.71],
      cd: [0.03, 0.031, 0.03],
    };
    const [result] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 8,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.71,
        cd: 0.03,
        cm: -0.03,
        clCd: 0.71 / 0.03,
        converged: true,
        stalled: true,
        unsteady: true,
        frameTrack: { stationary: true, periods_retained: 3 },
      })
      .returning({ id: results.id });
    const [olderAttempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 8,
        status: "done",
        source: "solved",
        regime: "urans",
        validForPolar: true,
        cl: 0.71,
        cd: 0.03,
        cm: -0.03,
        clCd: 0.71 / 0.03,
        converged: true,
        stalled: true,
        unsteady: true,
        evidencePayload: {
          fidelity: "urans_precalc",
          force_history: validForceHistory,
          frame_track: { stationary: true, periods_retained: 3 },
        },
        solvedAt: new Date(Date.now() - 2_000),
      })
      .returning({ id: resultAttempts.id });
    const [failedAttempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 8,
        status: "failed",
        source: "solved",
        regime: "urans",
        validForPolar: false,
        cl: null,
        cd: null,
        cm: null,
        converged: false,
        stalled: true,
        unsteady: true,
        error: "current generation failed",
        qualityWarnings: [
          "precalc requires further same-case integration before acceptance",
        ],
        evidencePayload: {
          fidelity: "urans_precalc",
          forceHistory: { t: [], cl: [0.7], cd: [0.03] },
          frame_track: { stationary: false, periods_retained: 1 },
        },
        solvedAt: new Date(Date.now() - 1_000),
      })
      .returning({ id: resultAttempts.id });
    await db.insert(resultMedia).values([
      {
        resultId: result.id,
        resultAttemptId: olderAttempt.id,
        kind: "video",
        field: "velocity_magnitude",
        role: "instantaneous",
        storageKey: `${PREFIX}/older.mp4`,
        mimeType: "video/mp4",
        sha256: "a".repeat(64),
        byteSize: 123,
      },
      {
        resultId: result.id,
        resultAttemptId: null,
        kind: "video",
        field: "velocity_magnitude",
        role: "instantaneous",
        storageKey: `${PREFIX}/legacy.mp4`,
        mimeType: "video/mp4",
        sha256: "b".repeat(64),
        byteSize: 123,
      },
    ]);
    await db.insert(forceHistory).values([
      {
        resultId: result.id,
        resultAttemptId: failedAttempt.id,
        ...validForceHistory,
      },
      {
        resultId: result.id,
        resultAttemptId: null,
        ...validForceHistory,
      },
    ]);
    await db
      .update(results)
      .set({ currentResultAttemptId: failedAttempt.id })
      .where(eq(results.id, result.id));

    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    const firstPass = await db
      .select({
        resultId: resultClassifications.resultId,
        resultAttemptId: resultClassifications.resultAttemptId,
        state: resultClassifications.state,
        reasons: resultClassifications.reasons,
      })
      .from(resultClassifications)
      .where(
        inArray(resultClassifications.resultAttemptId, [
          olderAttempt.id,
          failedAttempt.id,
        ]),
      );
    const [resultFirstPass] = await db
      .select({
        state: resultClassifications.state,
        regime: resultClassifications.regime,
        reasons: resultClassifications.reasons,
      })
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, result.id));
    expect(resultFirstPass.state).toBe("rejected");
    expect(resultFirstPass.regime).toBe("urans");
    expect(resultFirstPass.reasons).toEqual(
      expect.arrayContaining([
        "not-solved",
        "missing-coefficients",
        "solver-error",
        "not-converged",
        "incomplete-urans-integration",
        "missing-force-history",
        "missing-urans-video",
        "non-stationary",
        "insufficient-periods",
      ]),
    );
    expect(
      firstPass.find(
        (classification) => classification.resultAttemptId === olderAttempt.id,
      )?.state,
    ).toBe("accepted");
    expect(
      firstPass.find(
        (classification) => classification.resultAttemptId === failedAttempt.id,
      )?.state,
    ).toBe("rejected");

    const [acceptedAttempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 8,
        status: "done",
        source: "solved",
        regime: "urans",
        validForPolar: true,
        cl: 0.77,
        cd: 0.031,
        cm: -0.04,
        clCd: 0.77 / 0.031,
        converged: true,
        stalled: true,
        unsteady: true,
        evidencePayload: {
          fidelity: "urans_precalc",
          force_history: null,
          forceHistory: validForceHistory,
          frameTrack: { stationary: true, periods_retained: 3 },
        },
        solvedAt: new Date(),
      })
      .returning({ id: resultAttempts.id });
    await db.insert(resultMedia).values({
      resultId: result.id,
      resultAttemptId: acceptedAttempt.id,
      kind: "video",
      field: "velocity_magnitude",
      role: "instantaneous",
      storageKey: `${PREFIX}/accepted.mp4`,
      mimeType: "video/mp4",
      sha256: "c".repeat(64),
      byteSize: 123,
    });
    await db
      .update(results)
      .set({
        currentResultAttemptId: acceptedAttempt.id,
        status: "failed",
        source: "queued",
        regime: "rans",
        fidelity: "urans_full",
        cl: 8,
        cd: 0.5,
        cm: 8,
        clCd: 16,
        converged: false,
        stalled: false,
        unsteady: false,
        error: "stale mutable projection",
        frameTrack: { stationary: false, periods_retained: 0 },
        qualityWarnings: ["requires further same-case integration"],
      })
      .where(eq(results.id, result.id));

    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    const [resultSecondPass] = await db
      .select({
        state: resultClassifications.state,
        regime: resultClassifications.regime,
        reasons: resultClassifications.reasons,
      })
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, result.id));
    const attemptSecondPass = await db
      .select({
        resultAttemptId: resultClassifications.resultAttemptId,
        state: resultClassifications.state,
      })
      .from(resultClassifications)
      .where(
        inArray(resultClassifications.resultAttemptId, [
          olderAttempt.id,
          acceptedAttempt.id,
        ]),
      );
    expect(resultSecondPass).toEqual({
      state: "accepted",
      regime: "urans",
      reasons: [],
    });
    expect(
      attemptSecondPass.find(
        (classification) =>
          classification.resultAttemptId === acceptedAttempt.id,
      )?.state,
    ).toBe("accepted");
    expect(
      attemptSecondPass.find(
        (classification) => classification.resultAttemptId === olderAttempt.id,
      )?.state,
    ).toBe("accepted");

    const [currentFit] = await db
      .select({ id: polarFitSets.id })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      );
    const [pointAtEight] = await db
      .select({ cl: polarFitPoints.cl })
      .from(polarFitPoints)
      .where(
        and(
          eq(polarFitPoints.fitSetId, currentFit.id),
          eq(polarFitPoints.aoaDeg, 8),
        ),
      );
    expect(pointAtEight.cl).toBeLessThan(2);

    const [compatibilityMember] = (await db.execute(sql`
      SELECT member.cl, member.cd, member.regime, member.fidelity
      FROM polar_compatibility_fit_members member
      JOIN polar_compatibility_fit_sets fit ON fit.id = member.fit_set_id
      WHERE fit.airfoil_id = ${airfoilId}
        AND fit.compatibility_hash = ${`${PREFIX}-physics`}
        AND fit.is_current = true
        AND member.result_id = ${result.id}
        AND member.role = 'selected'
    `)) as unknown as Array<{
      cl: number;
      cd: number;
      regime: string | null;
      fidelity: string | null;
    }>;
    expect(compatibilityMember).toEqual({
      cl: 0.77,
      cd: 0.031,
      regime: "urans",
      fidelity: "urans_precalc",
    });

    // A result-level accepted verdict and an accepted historical attempt must
    // not authorize the selected generation when its own verdict is rejected.
    await db
      .update(resultClassifications)
      .set({ state: "rejected", reasons: ["selected-attempt-rejected"] })
      .where(eq(resultClassifications.resultAttemptId, acceptedAttempt.id));
    await db
      .update(resultClassifications)
      .set({ state: "accepted", reasons: [] })
      .where(eq(resultClassifications.resultAttemptId, olderAttempt.id));
    await db
      .update(resultClassifications)
      .set({ state: "accepted", reasons: [] })
      .where(eq(resultClassifications.resultId, result.id));
    await refreshPolarCompatibilityCache(db, airfoilId, `${PREFIX}-physics`);
    const wrongAttemptMembers = (await db.execute(sql`
      SELECT member.result_id
      FROM polar_compatibility_fit_members member
      JOIN polar_compatibility_fit_sets fit ON fit.id = member.fit_set_id
      WHERE fit.airfoil_id = ${airfoilId}
        AND fit.compatibility_hash = ${`${PREFIX}-physics`}
        AND fit.is_current = true
        AND member.result_id = ${result.id}
    `)) as unknown as Array<{ result_id: string }>;
    expect(wrongAttemptMembers).toHaveLength(0);

    // Restore classifier truth for later shared-fixture tests.
    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
  }, 60_000);

  it("keeps pointer-less legacy and attempt artifacts out of the current cache", async () => {
    const validForceHistory = {
      t: [0, 0.1, 0.2],
      cl: [0.8, 0.82, 0.81],
      cd: [0.04, 0.041, 0.04],
    };
    const [result] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 12,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 0.81,
        cd: 0.04,
        cm: -0.05,
        clCd: 0.81 / 0.04,
        converged: true,
        stalled: true,
        unsteady: true,
        frameTrack: { stationary: true, periods_retained: 3 },
      })
      .returning({ id: results.id });
    const [attempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 12,
        status: "done",
        source: "solved",
        regime: "urans",
        validForPolar: true,
        cl: 0.81,
        cd: 0.04,
        cm: -0.05,
        clCd: 0.81 / 0.04,
        converged: true,
        stalled: true,
        unsteady: true,
        evidencePayload: {
          fidelity: "urans_precalc",
          force_history: validForceHistory,
          frame_track: { stationary: true, periods_retained: 3 },
        },
      })
      .returning({ id: resultAttempts.id });
    await db.insert(resultMedia).values([
      {
        resultId: result.id,
        resultAttemptId: attempt.id,
        kind: "video",
        field: "velocity_magnitude",
        role: "instantaneous",
        storageKey: `${PREFIX}/pointerless-attempt.mp4`,
        mimeType: "video/mp4",
        sha256: "d".repeat(64),
        byteSize: 123,
      },
      {
        resultId: result.id,
        resultAttemptId: null,
        kind: "video",
        field: "velocity_magnitude",
        role: "instantaneous",
        storageKey: `${PREFIX}/pointerless-legacy.mp4`,
        mimeType: "video/mp4",
        sha256: "e".repeat(64),
        byteSize: 123,
      },
    ]);
    await db.insert(forceHistory).values({
      resultId: result.id,
      resultAttemptId: null,
      ...validForceHistory,
    });

    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    const [resultClassification] = await db
      .select({
        state: resultClassifications.state,
        regime: resultClassifications.regime,
        reasons: resultClassifications.reasons,
      })
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, result.id));
    const [attemptClassification] = await db
      .select({ state: resultClassifications.state })
      .from(resultClassifications)
      .where(eq(resultClassifications.resultAttemptId, attempt.id));
    expect(resultClassification.state).toBe("rejected");
    expect(resultClassification.regime).toBeNull();
    expect(resultClassification.reasons).toEqual(
      expect.arrayContaining([
        "not-solved",
        "missing-coefficients",
        "not-converged",
      ]),
    );
    expect(attemptClassification.state).toBe("accepted");
    const compatibilityMembers = (await db.execute(sql`
      SELECT member.result_id
      FROM polar_compatibility_fit_members member
      JOIN polar_compatibility_fit_sets fit ON fit.id = member.fit_set_id
      WHERE fit.airfoil_id = ${airfoilId}
        AND fit.is_current = true
        AND member.result_id = ${result.id}
    `)) as unknown as Array<{ result_id: string }>;
    expect(compatibilityMembers).toHaveLength(0);

    // Even if a legacy/result-level verdict and mutable projection are stale
    // accepted, a direct aggregate rebuild must not publish a pointer-less row.
    await db
      .update(resultClassifications)
      .set({ state: "accepted", region: "attached", reasons: [] })
      .where(eq(resultClassifications.resultId, result.id));
    await db
      .update(results)
      .set({
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        cl: 9.81,
        cd: 0.4,
        cm: -0.5,
        clCd: 9.81 / 0.4,
        converged: true,
        stalled: true,
        unsteady: true,
        error: null,
      })
      .where(eq(results.id, result.id));
    await refreshPolarCompatibilityCache(db, airfoilId, `${PREFIX}-physics`);
    const stalePointerlessMembers = (await db.execute(sql`
      SELECT member.result_id
      FROM polar_compatibility_fit_members member
      JOIN polar_compatibility_fit_sets fit ON fit.id = member.fit_set_id
      WHERE fit.airfoil_id = ${airfoilId}
        AND fit.compatibility_hash = ${`${PREFIX}-physics`}
        AND fit.is_current = true
        AND member.result_id = ${result.id}
    `)) as unknown as Array<{ result_id: string }>;
    expect(stalePointerlessMembers).toHaveLength(0);

    // Restore the result-level rejected projection before subsequent tests.
    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
  }, 60_000);

  it("changes the fit evidence signature when an identical visible generation replaces the pointer", async () => {
    const [target] = await db
      .select()
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, revisionId),
          eq(results.aoaDeg, -4),
        ),
      )
      .limit(1);
    const [currentAttempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.id, target.currentResultAttemptId!))
      .limit(1);
    const [before] = await db
      .select({ evidenceSignature: polarFitSets.evidenceSignature })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      )
      .limit(1);
    const [replacement] = await db
      .insert(resultAttempts)
      .values({
        resultId: target.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: currentAttempt.aoaDeg,
        status: currentAttempt.status,
        source: currentAttempt.source,
        regime: currentAttempt.regime,
        validForPolar: currentAttempt.validForPolar,
        cl: currentAttempt.cl,
        cd: currentAttempt.cd,
        cm: currentAttempt.cm,
        clCd: currentAttempt.clCd,
        converged: currentAttempt.converged,
        stalled: currentAttempt.stalled,
        unsteady: currentAttempt.unsteady,
        evidencePayload: currentAttempt.evidencePayload,
        solvedAt: currentAttempt.solvedAt,
      })
      .returning({ id: resultAttempts.id });
    await refreshPolarCacheForRevision(db, airfoilId, revisionId, {
      beforeEvidenceLoad: async (tx) => {
        await tx
          .update(results)
          .set({ currentResultAttemptId: replacement.id })
          .where(eq(results.id, target.id));
      },
    });
    const [after] = await db
      .select({ evidenceSignature: polarFitSets.evidenceSignature })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      )
      .limit(1);
    expect(after.evidenceSignature).not.toBe(before.evidenceSignature);
  }, 60_000);

  it("isolates null-sim-job attempt classification by immutable engine job", async () => {
    const cells = await db
      .select({ id: results.id, aoaDeg: results.aoaDeg })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, revisionId),
          inArray(results.aoaDeg, [0, 4]),
        ),
      );
    const lowAoaCell = cells.find((row) => row.aoaDeg === 0);
    const independentCell = cells.find((row) => row.aoaDeg === 4);
    expect(lowAoaCell).toBeTruthy();
    expect(independentCell).toBeTruthy();

    const [failedLowAoa, independentAccepted] = await db
      .insert(resultAttempts)
      .values([
        {
          resultId: lowAoaCell!.id,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: 0,
          simJobId: null,
          engineJobId: `${PREFIX}-retained-engine-a`,
          status: "failed" as const,
          source: "queued" as const,
          regime: "rans" as const,
          validForPolar: false,
          converged: false,
          stalled: true,
          error: "independent low-angle solver failure",
          evidencePayload: { fidelity: "rans" },
        },
        {
          resultId: independentCell!.id,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: 4,
          simJobId: null,
          engineJobId: `${PREFIX}-retained-engine-b`,
          status: "done" as const,
          source: "solved" as const,
          regime: "rans" as const,
          validForPolar: true,
          cl: 0.41,
          cd: 0.016,
          cm: -0.01,
          clCd: 0.41 / 0.016,
          converged: true,
          stalled: false,
          evidencePayload: { fidelity: "rans" },
        },
      ])
      .returning({ id: resultAttempts.id });

    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    const classifications = await db
      .select({
        resultAttemptId: resultClassifications.resultAttemptId,
        state: resultClassifications.state,
        reasons: resultClassifications.reasons,
      })
      .from(resultClassifications)
      .where(
        inArray(resultClassifications.resultAttemptId, [
          failedLowAoa.id,
          independentAccepted.id,
        ]),
      );
    expect(
      classifications.find((row) => row.resultAttemptId === failedLowAoa.id)
        ?.state,
    ).toBe("rejected");
    const independent = classifications.find(
      (row) => row.resultAttemptId === independentAccepted.id,
    );
    expect(independent?.state).toBe("accepted");
    expect(independent?.reasons).not.toContain("low-aoa-rans-failure");
  }, 60_000);

  it("derives and persists a null physics hash under ordered locks without concurrent deadlock", async () => {
    await db
      .update(simulationPresetRevisions)
      .set({ physicsHash: null, isCanonicalPhysics: false })
      .where(eq(simulationPresetRevisions.id, revisionId));
    await Promise.all([
      refreshPolarCacheForRevision(db, airfoilId, revisionId),
      refreshPolarCacheForRevision(db, airfoilId, revisionId),
    ]);
    const [revision] = await db
      .select({ physicsHash: simulationPresetRevisions.physicsHash })
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, revisionId));
    expect(revision.physicsHash).toMatch(/^[a-f0-9]{64}$/);
    const currentRows = (await db.execute(sql`
      SELECT count(*)::int AS count
      FROM polar_fit_sets
      WHERE airfoil_id = ${airfoilId}
        AND simulation_preset_revision_id = ${revisionId}
        AND is_current = true
    `)) as unknown as Array<{ count: number }>;
    expect(currentRows[0]?.count).toBe(1);
  }, 60_000);
});
