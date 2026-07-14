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
  solverEvidenceArtifacts,
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
      await db.insert(solverEvidenceArtifacts).values({
        resultId: result.id,
        resultAttemptId: attempt.id,
        airfoilId,
        engineJobId: null,
        engineCaseSlug: null,
        aoaDeg: result.aoaDeg,
        kind: "manifest",
        storageKey: `${PREFIX}/base-${result.aoaDeg}/manifest.json`,
        mimeType: "application/json",
        sha256: (result.aoaDeg + 5).toString(16).repeat(64),
        byteSize: 128,
      });
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
    await db.insert(solverEvidenceArtifacts).values({
      resultId: target.id,
      resultAttemptId: replacement.id,
      airfoilId,
      aoaDeg: 0,
      kind: "manifest",
      storageKey: `${PREFIX}/replacement-atomic/manifest.json`,
      mimeType: "application/json",
      sha256: "a".repeat(64),
      byteSize: 128,
    });
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
    const [pointerAfterRejectedSelection] = await db
      .select({ currentResultAttemptId: results.currentResultAttemptId })
      .from(results)
      .where(eq(results.id, result.id));
    expect(resultFirstPass.state).toBe("rejected");
    expect(resultFirstPass.regime).toBeNull();
    expect(resultFirstPass.reasons).toEqual(
      expect.arrayContaining([
        "not-solved",
        "missing-coefficients",
        "not-converged",
      ]),
    );
    expect(pointerAfterRejectedSelection.currentResultAttemptId).toBeNull();
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
    await db.insert(solverEvidenceArtifacts).values({
      resultId: result.id,
      resultAttemptId: acceptedAttempt.id,
      airfoilId,
      aoaDeg: 8,
      kind: "manifest",
      storageKey: `${PREFIX}/accepted/manifest.json`,
      mimeType: "application/json",
      sha256: "b".repeat(64),
      byteSize: 128,
    });
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

    // Restore classifier truth, then reproduce the production regression: an
    // accepted selected URANS generation loses its exact video and the next
    // classifier pass changes only that attempt to missing-urans-video.
    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    const [fitBeforeMediaLoss] = await db
      .select({ id: polarFitSets.id })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      );
    const [compatibilityBeforeMediaLoss] = await db
      .select({ id: polarCompatibilityFitSets.id })
      .from(polarCompatibilityFitSets)
      .where(
        and(
          eq(polarCompatibilityFitSets.airfoilId, airfoilId),
          eq(polarCompatibilityFitSets.compatibilityHash, `${PREFIX}-physics`),
          eq(polarCompatibilityFitSets.isCurrent, true),
        ),
      );
    const [unaffectedAccepted] = await db
      .select({
        id: results.id,
        currentResultAttemptId: results.currentResultAttemptId,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, revisionId),
          eq(results.aoaDeg, -2),
        ),
      );
    await db
      .delete(resultMedia)
      .where(eq(resultMedia.resultAttemptId, acceptedAttempt.id));

    await refreshPolarCacheForRevision(db, airfoilId, revisionId);

    const [retiredResult] = await db
      .select({ currentResultAttemptId: results.currentResultAttemptId })
      .from(results)
      .where(eq(results.id, result.id));
    const [rejectedAttempt] = await db
      .select({
        state: resultClassifications.state,
        reasons: resultClassifications.reasons,
      })
      .from(resultClassifications)
      .where(eq(resultClassifications.resultAttemptId, acceptedAttempt.id));
    const [fitAfterMediaLoss] = await db
      .select({ id: polarFitSets.id })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      );
    const pointAfterMediaLoss = await db
      .select({ aoaDeg: polarFitPoints.aoaDeg })
      .from(polarFitPoints)
      .where(
        and(
          eq(polarFitPoints.fitSetId, fitAfterMediaLoss.id),
          eq(polarFitPoints.aoaDeg, 8),
        ),
      );
    const compatibilityAfterMediaLoss = (await db.execute(sql`
      SELECT member.result_id
      FROM polar_compatibility_fit_members member
      JOIN polar_compatibility_fit_sets fit ON fit.id = member.fit_set_id
      WHERE fit.airfoil_id = ${airfoilId}
        AND fit.compatibility_hash = ${`${PREFIX}-physics`}
        AND fit.is_current = true
        AND member.result_id = ${result.id}
    `)) as unknown as Array<{ result_id: string }>;
    const [retiredFit] = await db
      .select({ isCurrent: polarFitSets.isCurrent })
      .from(polarFitSets)
      .where(eq(polarFitSets.id, fitBeforeMediaLoss.id));
    const [retiredCompatibility] = await db
      .select({ isCurrent: polarCompatibilityFitSets.isCurrent })
      .from(polarCompatibilityFitSets)
      .where(eq(polarCompatibilityFitSets.id, compatibilityBeforeMediaLoss.id));
    const [unaffectedAcceptedAfter] = await db
      .select({ currentResultAttemptId: results.currentResultAttemptId })
      .from(results)
      .where(eq(results.id, unaffectedAccepted.id));

    expect(rejectedAttempt).toEqual({
      state: "rejected",
      reasons: ["missing-urans-video"],
    });
    expect(retiredResult.currentResultAttemptId).toBeNull();
    expect(retiredFit.isCurrent).toBe(false);
    expect(retiredCompatibility.isCurrent).toBe(false);
    expect(fitAfterMediaLoss.id).not.toBe(fitBeforeMediaLoss.id);
    expect(pointAfterMediaLoss).toHaveLength(0);
    expect(compatibilityAfterMediaLoss).toHaveLength(0);
    expect(unaffectedAcceptedAfter.currentResultAttemptId).toBe(
      unaffectedAccepted.currentResultAttemptId,
    );

    // Restore exact media and republish through the same revision transaction
    // so subsequent shared-fixture tests start from accepted truth.
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
    await refreshPolarCacheForRevision(db, airfoilId, revisionId, {
      afterAttemptClassifications: async (tx) => {
        await tx
          .update(results)
          .set({ currentResultAttemptId: acceptedAttempt.id })
          .where(eq(results.id, result.id));
      },
    });

    // The classifier does not inspect manifests, so the publication invariant
    // must independently withdraw an otherwise accepted selected generation
    // when its exact manifest becomes missing/ambiguous.
    const [fitBeforeManifestLoss] = await db
      .select({ id: polarFitSets.id })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      );
    await db
      .delete(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultAttemptId, acceptedAttempt.id),
          eq(solverEvidenceArtifacts.kind, "manifest"),
        ),
      );
    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    const [manifestlessResult] = await db
      .select({ currentResultAttemptId: results.currentResultAttemptId })
      .from(results)
      .where(eq(results.id, result.id));
    const [stillAcceptedAttempt] = await db
      .select({ state: resultClassifications.state })
      .from(resultClassifications)
      .where(eq(resultClassifications.resultAttemptId, acceptedAttempt.id));
    const [retiredManifestFit] = await db
      .select({ isCurrent: polarFitSets.isCurrent })
      .from(polarFitSets)
      .where(eq(polarFitSets.id, fitBeforeManifestLoss.id));
    expect(stillAcceptedAttempt.state).toBe("accepted");
    expect(manifestlessResult.currentResultAttemptId).toBeNull();
    expect(retiredManifestFit.isCurrent).toBe(false);

    await db.insert(solverEvidenceArtifacts).values({
      resultId: result.id,
      resultAttemptId: acceptedAttempt.id,
      airfoilId,
      aoaDeg: 8,
      kind: "manifest",
      storageKey: `${PREFIX}/accepted/manifest.json`,
      mimeType: "application/json",
      sha256: "b".repeat(64),
      byteSize: 128,
    });
    await refreshPolarCacheForRevision(db, airfoilId, revisionId, {
      afterAttemptClassifications: async (tx) => {
        await tx
          .update(results)
          .set({ currentResultAttemptId: acceptedAttempt.id })
          .where(eq(results.id, result.id));
      },
    });
  }, 60_000);

  it("preserves selected accepted and needs_urans exact generations", async () => {
    const targets = await db
      .select({
        id: results.id,
        aoaDeg: results.aoaDeg,
        currentResultAttemptId: results.currentResultAttemptId,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, revisionId),
          inArray(results.aoaDeg, [-4, -2]),
        ),
      );
    const provisional = targets.find((row) => row.aoaDeg === -4)!;
    const accepted = targets.find((row) => row.aoaDeg === -2)!;
    expect(provisional.currentResultAttemptId).toBeTruthy();
    expect(accepted.currentResultAttemptId).toBeTruthy();

    await refreshPolarCacheForRevision(db, airfoilId, revisionId, {
      afterAttemptClassifications: async (tx) => {
        await tx
          .update(resultClassifications)
          .set({
            state: "needs_urans",
            region: "post_stall",
            reasons: ["test-provisional-exact-generation"],
          })
          .where(
            eq(
              resultClassifications.resultAttemptId,
              provisional.currentResultAttemptId!,
            ),
          );
      },
    });

    const after = await db
      .select({
        id: results.id,
        currentResultAttemptId: results.currentResultAttemptId,
      })
      .from(results)
      .where(inArray(results.id, [provisional.id, accepted.id]));
    expect(
      after.find((row) => row.id === provisional.id)?.currentResultAttemptId,
    ).toBe(provisional.currentResultAttemptId);
    expect(
      after.find((row) => row.id === accepted.id)?.currentResultAttemptId,
    ).toBe(accepted.currentResultAttemptId);

    // Restore classifier-derived accepted state for later tests.
    await refreshPolarCacheForRevision(db, airfoilId, revisionId);
  }, 60_000);

  it("keeps a selected RANS projection provisional after its rejected low-AoA sibling is withdrawn", async () => {
    const cells = await db
      .select({
        id: results.id,
        aoaDeg: results.aoaDeg,
        currentResultAttemptId: results.currentResultAttemptId,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, revisionId),
          inArray(results.aoaDeg, [0, 2]),
        ),
      );
    const rejectedCell = cells.find((row) => row.aoaDeg === 0)!;
    const survivingCell = cells.find((row) => row.aoaDeg === 2)!;
    expect(rejectedCell.currentResultAttemptId).toBeTruthy();
    expect(survivingCell.currentResultAttemptId).toBeTruthy();

    const engineJobId = `${PREFIX}-low-aoa-shared-sweep`;
    const [rejectedAttempt, survivingAttempt] = await db
      .insert(resultAttempts)
      .values([
        {
          resultId: rejectedCell.id,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: 0,
          engineJobId,
          engineCaseSlug: "a0-rejected",
          status: "done" as const,
          source: "solved" as const,
          regime: "rans" as const,
          validForPolar: false,
          cl: 0.02,
          cd: 0.04,
          cm: -0.01,
          clCd: 0.5,
          converged: false,
          stalled: true,
          evidencePayload: { fidelity: "rans" },
        },
        {
          resultId: survivingCell.id,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: 2,
          engineJobId,
          engineCaseSlug: "a2-surviving",
          status: "done" as const,
          source: "solved" as const,
          regime: "rans" as const,
          validForPolar: true,
          cl: 0.2,
          cd: 0.014,
          cm: -0.01,
          clCd: 0.2 / 0.014,
          converged: true,
          stalled: false,
          evidencePayload: { fidelity: "rans" },
        },
      ])
      .returning({ id: resultAttempts.id });
    await db.insert(solverEvidenceArtifacts).values([
      {
        resultId: rejectedCell.id,
        resultAttemptId: rejectedAttempt.id,
        airfoilId,
        engineJobId,
        engineCaseSlug: "a0-rejected",
        aoaDeg: 0,
        kind: "manifest" as const,
        storageKey: `${PREFIX}/low-aoa-rejected/manifest.json`,
        mimeType: "application/json",
        sha256: "d".repeat(64),
        byteSize: 128,
      },
      {
        resultId: survivingCell.id,
        resultAttemptId: survivingAttempt.id,
        airfoilId,
        engineJobId,
        engineCaseSlug: "a2-surviving",
        aoaDeg: 2,
        kind: "manifest" as const,
        storageKey: `${PREFIX}/low-aoa-surviving/manifest.json`,
        mimeType: "application/json",
        sha256: "e".repeat(64),
        byteSize: 128,
      },
    ]);

    try {
      await db
        .update(results)
        .set({ currentResultAttemptId: rejectedAttempt.id })
        .where(eq(results.id, rejectedCell.id));
      await db
        .update(results)
        .set({ currentResultAttemptId: survivingAttempt.id })
        .where(eq(results.id, survivingCell.id));

      const refreshed = await refreshPolarCacheForRevision(
        db,
        airfoilId,
        revisionId,
      );
      expect(refreshed.lowAoaFailure).toBe(true);
      expect(refreshed.fitStatus).toBe("provisional");

      const projected = await db
        .select({
          id: results.id,
          currentResultAttemptId: results.currentResultAttemptId,
          state: resultClassifications.state,
          reasons: resultClassifications.reasons,
        })
        .from(results)
        .leftJoin(
          resultClassifications,
          eq(resultClassifications.resultId, results.id),
        )
        .where(inArray(results.id, [rejectedCell.id, survivingCell.id]));
      const rejectedProjection = projected.find(
        (row) => row.id === rejectedCell.id,
      );
      const survivingProjection = projected.find(
        (row) => row.id === survivingCell.id,
      );
      expect(rejectedProjection?.currentResultAttemptId).toBeNull();
      expect(rejectedProjection?.state).toBe("rejected");
      expect(survivingProjection?.currentResultAttemptId).toBe(
        survivingAttempt.id,
      );
      expect(survivingProjection?.state).toBe("needs_urans");
      expect(survivingProjection?.reasons).toContain("low-aoa-rans-failure");
    } finally {
      await db
        .update(results)
        .set({ currentResultAttemptId: rejectedCell.currentResultAttemptId })
        .where(eq(results.id, rejectedCell.id));
      await db
        .update(results)
        .set({ currentResultAttemptId: survivingCell.currentResultAttemptId })
        .where(eq(results.id, survivingCell.id));
      await db
        .delete(resultClassifications)
        .where(
          inArray(resultClassifications.resultAttemptId, [
            rejectedAttempt.id,
            survivingAttempt.id,
          ]),
        );
      await db
        .delete(solverEvidenceArtifacts)
        .where(
          inArray(solverEvidenceArtifacts.resultAttemptId, [
            rejectedAttempt.id,
            survivingAttempt.id,
          ]),
        );
      await db
        .delete(resultAttempts)
        .where(
          inArray(resultAttempts.id, [rejectedAttempt.id, survivingAttempt.id]),
        );
      await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    }
  }, 60_000);

  it("propagates a job-scoped low-angle alternate-branch verdict to only its selected A18-like cells", async () => {
    const branchEngineJobId = `${PREFIX}-a18-branch-march`;
    const branchValues = new Map<number, number>([
      [-5, 0.25],
      [-4, 0.24],
      [-3, -0.3],
      [-2, -0.2],
      [-1, -0.1],
      [0, 0],
      [1, 0.1],
      [2, 0.2],
      [3, 0.3],
      [4, 0.4],
      [5, 0.5],
    ]);
    const angles = [...branchValues.keys()];
    const existing = await db
      .select({
        id: results.id,
        aoaDeg: results.aoaDeg,
        currentResultAttemptId: results.currentResultAttemptId,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, revisionId),
          inArray(results.aoaDeg, angles),
        ),
      );
    const resultByAoa = new Map(existing.map((row) => [row.aoaDeg, row]));
    const createdResultIds: string[] = [];
    for (const aoaDeg of angles) {
      if (resultByAoa.has(aoaDeg)) continue;
      const cl = branchValues.get(aoaDeg)!;
      const [created] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg,
          status: "done",
          source: "solved",
          regime: "rans",
          fidelity: "rans",
          cl,
          cd: 0.02,
          cm: -0.05,
          clCd: cl / 0.02,
          converged: true,
          stalled: false,
          solvedAt: new Date(),
        })
        .returning({ id: results.id, aoaDeg: results.aoaDeg });
      resultByAoa.set(created.aoaDeg, {
        ...created,
        currentResultAttemptId: null,
      });
      createdResultIds.push(created.id);
    }

    const branchAttempts = await db
      .insert(resultAttempts)
      .values(
        angles.map((aoaDeg) => {
          const cl = branchValues.get(aoaDeg)!;
          return {
            resultId: resultByAoa.get(aoaDeg)!.id,
            airfoilId,
            bcId,
            simulationPresetRevisionId: revisionId,
            aoaDeg,
            engineJobId: branchEngineJobId,
            engineCaseSlug: `a${aoaDeg}`,
            status: "done" as const,
            source: "solved" as const,
            regime: "rans" as const,
            validForPolar: true,
            cl,
            cd: 0.02,
            cm: -0.05,
            clCd: cl / 0.02,
            converged: true,
            stalled: false,
            evidencePayload: { fidelity: "rans" },
            solvedAt: new Date(),
          };
        }),
      )
      .returning({
        id: resultAttempts.id,
        resultId: resultAttempts.resultId,
        aoaDeg: resultAttempts.aoaDeg,
      });
    const attemptByAoa = new Map(
      branchAttempts.map((attempt) => [attempt.aoaDeg, attempt]),
    );
    await db.insert(solverEvidenceArtifacts).values(
      branchAttempts.map((attempt) => ({
        resultId: attempt.resultId,
        resultAttemptId: attempt.id,
        airfoilId,
        engineJobId: branchEngineJobId,
        engineCaseSlug: `a${attempt.aoaDeg}`,
        aoaDeg: attempt.aoaDeg,
        kind: "manifest" as const,
        storageKey: `${PREFIX}/a18-branch/${attempt.aoaDeg}/manifest.json`,
        mimeType: "application/json",
        sha256: `${Math.round(attempt.aoaDeg + 10)}`.padStart(64, "b"),
        byteSize: 128,
      })),
    );

    try {
      await Promise.all(
        angles.map((aoaDeg) =>
          db
            .update(results)
            .set({ currentResultAttemptId: attemptByAoa.get(aoaDeg)!.id })
            .where(eq(results.id, resultByAoa.get(aoaDeg)!.id)),
        ),
      );

      const refreshed = await refreshPolarCacheForRevision(
        db,
        airfoilId,
        revisionId,
      );
      expect(refreshed.lowAoaFailure).toBe(false);
      expect(refreshed.needsUransAoas).toEqual([-5, -4]);

      const verdicts = await db
        .select({
          aoaDeg: results.aoaDeg,
          state: resultClassifications.state,
          reasons: resultClassifications.reasons,
        })
        .from(results)
        .innerJoin(
          resultClassifications,
          eq(resultClassifications.resultId, results.id),
        )
        .where(
          inArray(
            results.id,
            angles.map((aoaDeg) => resultByAoa.get(aoaDeg)!.id),
          ),
        );
      const verdictByAoa = new Map(verdicts.map((row) => [row.aoaDeg, row]));
      expect(verdictByAoa.get(-5)?.state).toBe("needs_urans");
      expect(verdictByAoa.get(-4)?.state).toBe("needs_urans");
      expect(verdictByAoa.get(-4)?.reasons).toContain(
        "low-aoa-attached-branch-discontinuity",
      );
      expect(verdictByAoa.get(-3)?.state).toBe("accepted");
      expect(verdictByAoa.get(5)?.state).toBe("accepted");
    } finally {
      await Promise.all(
        existing.map((row) =>
          db
            .update(results)
            .set({ currentResultAttemptId: row.currentResultAttemptId })
            .where(eq(results.id, row.id)),
        ),
      );
      if (createdResultIds.length) {
        await db
          .update(results)
          .set({ currentResultAttemptId: null })
          .where(inArray(results.id, createdResultIds));
      }
      await db.delete(resultClassifications).where(
        inArray(
          resultClassifications.resultAttemptId,
          branchAttempts.map((attempt) => attempt.id),
        ),
      );
      if (createdResultIds.length) {
        await db
          .delete(resultClassifications)
          .where(inArray(resultClassifications.resultId, createdResultIds));
      }
      await db.delete(solverEvidenceArtifacts).where(
        inArray(
          solverEvidenceArtifacts.resultAttemptId,
          branchAttempts.map((attempt) => attempt.id),
        ),
      );
      await db.delete(resultAttempts).where(
        inArray(
          resultAttempts.id,
          branchAttempts.map((attempt) => attempt.id),
        ),
      );
      if (createdResultIds.length) {
        await db.delete(results).where(inArray(results.id, createdResultIds));
      }
      await refreshPolarCacheForRevision(db, airfoilId, revisionId);
    }
  }, 60_000);

  it("supersedes only historical precalc when selected full URANS is accepted", async () => {
    const aoaDeg = 10;
    const force = {
      t: [0, 0.1, 0.2],
      cl: [0.82, 0.84, 0.83],
      cd: [0.04, 0.041, 0.04],
    };
    const [result] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_full",
        cl: 0.83,
        cd: 0.04,
        cm: -0.05,
        clCd: 0.83 / 0.04,
        converged: true,
        stalled: true,
        unsteady: true,
      })
      .returning({ id: results.id });
    const [precalcAttempt, fullAttempt] = await db
      .insert(resultAttempts)
      .values([
        {
          resultId: result.id,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg,
          engineJobId: `${PREFIX}-historical-precalc`,
          engineCaseSlug: "a10-precalc",
          status: "done",
          source: "solved",
          regime: "urans",
          validForPolar: true,
          cl: 0.81,
          cd: 0.041,
          cm: -0.05,
          clCd: 0.81 / 0.041,
          converged: true,
          stalled: true,
          unsteady: true,
          evidencePayload: {
            fidelity: "urans_precalc",
            force_history: force,
            frame_track: { stationary: true, periods_retained: 3 },
          },
          solvedAt: new Date(Date.now() - 1_000),
        },
        {
          resultId: result.id,
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg,
          engineJobId: `${PREFIX}-selected-full`,
          engineCaseSlug: "a10-full",
          status: "done",
          source: "solved",
          regime: "urans",
          validForPolar: true,
          cl: 0.83,
          cd: 0.04,
          cm: -0.05,
          clCd: 0.83 / 0.04,
          converged: true,
          stalled: true,
          unsteady: true,
          evidencePayload: {
            fidelity: "urans_full",
            force_history: force,
            frame_track: { stationary: true, periods_retained: 6 },
          },
          solvedAt: new Date(),
        },
      ])
      .returning({ id: resultAttempts.id });
    const precalcManifestSha = "6".repeat(64);
    const fullManifestSha = "7".repeat(64);
    await db.insert(solverEvidenceArtifacts).values([
      {
        resultId: result.id,
        resultAttemptId: precalcAttempt.id,
        airfoilId,
        engineJobId: `${PREFIX}-historical-precalc`,
        engineCaseSlug: "a10-precalc",
        aoaDeg,
        kind: "manifest",
        storageKey: `${PREFIX}/historical-precalc/manifest.json`,
        mimeType: "application/json",
        sha256: precalcManifestSha,
        byteSize: 128,
      },
      {
        resultId: result.id,
        resultAttemptId: fullAttempt.id,
        airfoilId,
        engineJobId: `${PREFIX}-selected-full`,
        engineCaseSlug: "a10-full",
        aoaDeg,
        kind: "manifest",
        storageKey: `${PREFIX}/selected-full/manifest.json`,
        mimeType: "application/json",
        sha256: fullManifestSha,
        byteSize: 128,
      },
    ]);
    await db.insert(resultMedia).values([
      {
        resultId: result.id,
        resultAttemptId: precalcAttempt.id,
        kind: "video",
        field: "velocity_magnitude",
        role: "instantaneous",
        storageKey: `${PREFIX}/historical-precalc.mp4`,
        mimeType: "video/mp4",
        evidenceSha256: precalcManifestSha,
        sha256: "8".repeat(64),
        byteSize: 128,
      },
      {
        resultId: result.id,
        resultAttemptId: fullAttempt.id,
        kind: "video",
        field: "velocity_magnitude",
        role: "instantaneous",
        storageKey: `${PREFIX}/selected-full.mp4`,
        mimeType: "video/mp4",
        evidenceSha256: fullManifestSha,
        sha256: "9".repeat(64),
        byteSize: 128,
      },
    ]);
    await db
      .update(results)
      .set({ currentResultAttemptId: fullAttempt.id })
      .where(eq(results.id, result.id));

    await refreshPolarCacheForRevision(db, airfoilId, revisionId);

    const classifications = await db
      .select({
        resultAttemptId: resultClassifications.resultAttemptId,
        state: resultClassifications.state,
      })
      .from(resultClassifications)
      .where(
        inArray(resultClassifications.resultAttemptId, [
          precalcAttempt.id,
          fullAttempt.id,
        ]),
      );
    expect(
      classifications.find(
        (classification) =>
          classification.resultAttemptId === precalcAttempt.id,
      )?.state,
    ).toBe("superseded_by_urans");
    expect(
      classifications.find(
        (classification) => classification.resultAttemptId === fullAttempt.id,
      )?.state,
    ).toBe("accepted");
    const [selected] = await db
      .select({ currentResultAttemptId: results.currentResultAttemptId })
      .from(results)
      .where(eq(results.id, result.id));
    expect(selected.currentResultAttemptId).toBe(fullAttempt.id);

    await db
      .update(results)
      .set({ currentResultAttemptId: null })
      .where(eq(results.id, result.id));
    await db.delete(results).where(eq(results.id, result.id));
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
    await db.insert(solverEvidenceArtifacts).values({
      resultId: target.id,
      resultAttemptId: replacement.id,
      airfoilId,
      engineJobId: null,
      engineCaseSlug: null,
      aoaDeg: currentAttempt.aoaDeg,
      kind: "manifest",
      storageKey: `${PREFIX}/replacement-signature/manifest.json`,
      mimeType: "application/json",
      sha256: "c".repeat(64),
      byteSize: 128,
    });
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
