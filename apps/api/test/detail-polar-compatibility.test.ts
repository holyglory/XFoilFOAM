import { type Point, type Polar } from "@aerodb/core";
import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  flowConditions,
  forceHistory,
  mediums,
  meshProfiles,
  outputProfiles,
  polarCompatibilityFitSets,
  referenceGeometryProfiles,
  type Result,
  resultAttempts,
  resultClassifications,
  resultMedia,
  results,
  schedulingProfiles,
  simulationPresetRevisions,
  simulationPresets,
  solverProfiles,
  sweepDefinitions,
} from "@aerodb/db";
import {
  polarCompatibilitySeriesId,
  refreshPolarCompatibilityCache,
} from "@aerodb/db/polar-cache";
import {
  ensureSimulationPresetRevision,
  physicsHashForSnapshot,
} from "@aerodb/db/simulation-setup";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, sql as pgClient } from "../src/db";
import { assembleDetail, decoratePublicPolars } from "../src/services/detail";
import { assembleSolverWork } from "../src/services/solver-work";

const PREFIX = `detail-compat-${process.pid}-${Date.now().toString(36)}`;

const contour: Point[] = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.06 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.04 },
  { x: 1, y: 0 },
];

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
  if (!ids.length) return;
  await db
    .delete(table as never)
    .where(inArray((table as { id: never }).id, ids));
}

describe("public polar compatibility series", () => {
  let slug = "";
  let airfoilId = "";
  let baseHash = "";
  let baseResultIds: string[] = [];
  let allAcceptedResultIds: string[] = [];
  let conflictHash = "";
  let conflictResultIds: string[] = [];
  let legacyFallbackRevision: {
    id: string;
    snapshot: Record<string, unknown>;
  } | null = null;
  let refreshBaseCache: () => Promise<void> = async () => undefined;
  let bindAcceptedResults: (rows: Result[]) => Promise<void> = async () =>
    undefined;

  beforeAll(async () => {
    const [air] = await db
      .select()
      .from(mediums)
      .where(eq(mediums.slug, "air"))
      .limit(1);
    expect(air).toBeTruthy();

    const [category] = await db
      .insert(categories)
      .values({
        slug: `${PREFIX}-category`,
        name: `${PREFIX} category`,
        path: `${PREFIX}-category`,
        depth: 0,
      })
      .returning({ id: categories.id });
    cleanup.categoryIds.push(category.id);

    const [airfoil] = await db
      .insert(airfoils)
      .values({
        slug: `${PREFIX}-airfoil`,
        name: `${PREFIX} airfoil`,
        categoryId: category.id,
        source: "test",
        points: contour,
        isSymmetric: false,
        tags: [],
      })
      .returning({ id: airfoils.id, slug: airfoils.slug });
    cleanup.airfoilIds.push(airfoil.id);
    airfoilId = airfoil.id;
    slug = airfoil.slug;

    // File-unique physical values keep this live-DB fixture independent from
    // sibling Vitest workers while still producing the exact same Reynolds in
    // the doubled-speed/halved-chord separation case.
    const speed = 25.137;
    const chord = 0.1037;
    const reynolds = Math.round((speed * chord) / air.kinematicViscosity);
    const mach = air.speedOfSound ? speed / air.speedOfSound : null;

    const createFlow = async (suffix: string, speedMps: number) => {
      const [flow] = await db
        .insert(flowConditions)
        .values({
          slug: `${PREFIX}-${suffix}-flow`,
          name: `${PREFIX} ${suffix} flow`,
          mediumId: air.id,
          temperatureK: air.refTemperatureK,
          pressurePa: air.refPressurePa,
          speedMps,
          density: air.density,
          dynamicViscosity: air.dynamicViscosity,
          kinematicViscosity: air.kinematicViscosity,
          mach: air.speedOfSound ? speedMps / air.speedOfSound : null,
        })
        .returning({ id: flowConditions.id });
      cleanup.flowIds.push(flow.id);
      return flow.id;
    };
    const createReference = async (
      suffix: string,
      referenceLengthM: number,
    ) => {
      const [reference] = await db
        .insert(referenceGeometryProfiles)
        .values({
          slug: `${PREFIX}-${suffix}-reference`,
          name: `${PREFIX} ${suffix} reference`,
          geometryType: "airfoil_2d",
          referenceLengthKind: "chord",
          referenceLengthM,
        })
        .returning({ id: referenceGeometryProfiles.id });
      cleanup.referenceIds.push(reference.id);
      return reference.id;
    };
    const createLegacy = async (
      suffix: string,
      speedMps: number,
      referenceChordM: number,
    ) => {
      const [bc] = await db
        .insert(boundaryConditions)
        .values({
          slug: `${PREFIX}-${suffix}-bc`,
          name: `${PREFIX} ${suffix} BC`,
          mediumId: air.id,
          reynolds: Math.round(
            (speedMps * referenceChordM) / air.kinematicViscosity,
          ),
          referenceChordM,
          temperatureK: air.refTemperatureK,
          pressurePa: air.refPressurePa,
          speedMps,
          density: air.density,
          dynamicViscosity: air.dynamicViscosity,
          kinematicViscosity: air.kinematicViscosity,
          mach: air.speedOfSound ? speedMps / air.speedOfSound : null,
          enabled: true,
        })
        .returning({ id: boundaryConditions.id });
      cleanup.bcIds.push(bc.id);
      return bc.id;
    };

    const baseFlowId = await createFlow("base", speed);
    const fastFlowId = await createFlow("fast", speed * 2);
    const baseReferenceId = await createReference("base", chord);
    const shortReferenceId = await createReference("short", chord / 2);
    const baseBcId = await createLegacy("base", speed, chord);
    const fastBcId = await createLegacy("fast", speed * 2, chord / 2);

    const [boundary] = await db
      .insert(boundaryProfiles)
      .values({
        slug: `${PREFIX}-boundary`,
        name: `${PREFIX} boundary`,
      })
      .returning({ id: boundaryProfiles.id });
    cleanup.boundaryIds.push(boundary.id);
    const [baseMesh, changedMesh] = await db
      .insert(meshProfiles)
      .values([
        { slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh`, nSurface: 137 },
        {
          slug: `${PREFIX}-mesh-changed`,
          name: `${PREFIX} mesh changed`,
          nSurface: 139,
        },
      ])
      .returning({ id: meshProfiles.id });
    cleanup.meshIds.push(baseMesh.id, changedMesh.id);
    const [baseSolver, changedSolver] = await db
      .insert(solverProfiles)
      .values([
        {
          slug: `${PREFIX}-solver`,
          name: `${PREFIX} solver`,
          nIterations: 3107,
        },
        {
          slug: `${PREFIX}-solver-changed`,
          name: `${PREFIX} solver changed`,
          nIterations: 3209,
        },
      ])
      .returning({ id: solverProfiles.id });
    cleanup.solverIds.push(baseSolver.id, changedSolver.id);
    const [scheduling] = await db
      .insert(schedulingProfiles)
      .values({
        slug: `${PREFIX}-scheduling`,
        name: `${PREFIX} scheduling`,
      })
      .returning({ id: schedulingProfiles.id });
    cleanup.schedulingIds.push(scheduling.id);
    const [output] = await db
      .insert(outputProfiles)
      .values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` })
      .returning({ id: outputProfiles.id });
    cleanup.outputIds.push(output.id);
    const sweeps = await db
      .insert(sweepDefinitions)
      .values([
        {
          slug: `${PREFIX}-sweep-a`,
          name: `${PREFIX} remote-validation-e387 A`,
          aoaStart: -8,
          aoaStop: 6,
          aoaStep: 2,
          aoaList: [-8, -2, 2, 6],
        },
        {
          slug: `${PREFIX}-sweep-b`,
          name: `${PREFIX} remote-validation-e387 B`,
          aoaStart: -4,
          aoaStop: 4,
          aoaStep: 4,
          aoaList: [-4, 0, 4],
        },
        {
          slug: `${PREFIX}-sweep-single`,
          name: `${PREFIX} single`,
          aoaStart: 1,
          aoaStop: 1,
          aoaStep: 1,
          aoaList: [1],
        },
      ])
      .returning({ id: sweepDefinitions.id });
    cleanup.sweepIds.push(...sweeps.map((row) => row.id));

    const createPreset = async (args: {
      suffix: string;
      flowId: string;
      referenceId: string;
      meshId: string;
      solverId: string;
      sweepId: string;
      bcId: string;
    }) => {
      const [preset] = await db
        .insert(simulationPresets)
        .values({
          slug: `${PREFIX}-${args.suffix}-preset`,
          name: `${PREFIX} remote-validation-e387 ${args.suffix}`,
          flowConditionId: args.flowId,
          referenceGeometryProfileId: args.referenceId,
          boundaryProfileId: boundary.id,
          meshProfileId: args.meshId,
          solverProfileId: args.solverId,
          schedulingProfileId: scheduling.id,
          outputProfileId: output.id,
          sweepDefinitionId: args.sweepId,
          legacyBoundaryConditionId: args.bcId,
          enabled: true,
        })
        .returning({ id: simulationPresets.id });
      cleanup.presetIds.push(preset.id);
      const resolved = await ensureSimulationPresetRevision(db, preset.id);
      expect(resolved).toBeTruthy();
      return { bcId: args.bcId, ...resolved! };
    };

    const baseA = await createPreset({
      suffix: "base-a",
      flowId: baseFlowId,
      referenceId: baseReferenceId,
      meshId: baseMesh.id,
      solverId: baseSolver.id,
      sweepId: sweeps[0].id,
      bcId: baseBcId,
    });
    const baseB = await createPreset({
      suffix: "base-b",
      flowId: baseFlowId,
      referenceId: baseReferenceId,
      meshId: baseMesh.id,
      solverId: baseSolver.id,
      sweepId: sweeps[1].id,
      bcId: baseBcId,
    });
    legacyFallbackRevision = {
      id: baseB.revision.id,
      snapshot: baseB.revision.snapshot,
    };
    const differentMach = await createPreset({
      suffix: "different-mach",
      flowId: fastFlowId,
      referenceId: shortReferenceId,
      meshId: baseMesh.id,
      solverId: baseSolver.id,
      sweepId: sweeps[2].id,
      bcId: fastBcId,
    });
    const differentMesh = await createPreset({
      suffix: "different-mesh",
      flowId: baseFlowId,
      referenceId: baseReferenceId,
      meshId: changedMesh.id,
      solverId: baseSolver.id,
      sweepId: sweeps[2].id,
      bcId: baseBcId,
    });
    const differentMeshTwin = await createPreset({
      suffix: "different-mesh-twin",
      flowId: baseFlowId,
      referenceId: baseReferenceId,
      meshId: changedMesh.id,
      solverId: baseSolver.id,
      sweepId: sweeps[2].id,
      bcId: baseBcId,
    });
    const differentSolver = await createPreset({
      suffix: "different-solver",
      flowId: baseFlowId,
      referenceId: baseReferenceId,
      meshId: baseMesh.id,
      solverId: changedSolver.id,
      sweepId: sweeps[2].id,
      bcId: baseBcId,
    });

    const hashFor = (resolved: typeof baseA) =>
      resolved.revision.physicsHash ??
      physicsHashForSnapshot(resolved.snapshot);
    baseHash = hashFor(baseA);
    expect(hashFor(baseB)).toBe(baseHash);
    expect(
      new Set([
        hashFor(differentMach),
        hashFor(differentMesh),
        hashFor(differentSolver),
      ]).size,
    ).toBe(3);
    conflictHash = hashFor(differentMesh);
    expect(hashFor(differentMeshTwin)).toBe(conflictHash);
    expect(differentMach.revision.reynolds).toBe(reynolds);
    expect(differentMesh.revision.reynolds).toBe(reynolds);
    expect(differentSolver.revision.reynolds).toBe(reynolds);

    bindAcceptedResults = async (rows: Result[]) => {
      if (!rows.length) return;
      const attempts = await db
        .insert(resultAttempts)
        .values(
          rows.map((row) => ({
            resultId: row.id,
            airfoilId: row.airfoilId,
            bcId: row.bcId,
            simulationPresetRevisionId: row.simulationPresetRevisionId,
            aoaDeg: row.aoaDeg,
            simJobId: row.simJobId,
            engineJobId: row.engineJobId,
            engineCaseSlug: row.engineCaseSlug,
            status: row.status,
            source: row.source,
            regime: row.regime,
            validForPolar: true,
            cl: row.cl,
            cd: row.cd,
            cm: row.cm,
            clCd: row.clCd,
            clStd: row.clStd,
            cdStd: row.cdStd,
            cmStd: row.cmStd,
            stalled: row.stalled,
            unsteady: row.unsteady,
            converged: row.converged,
            finalResidual: row.finalResidual,
            iterations: row.iterations,
            yPlusAvg: row.yPlusAvg,
            yPlusMax: row.yPlusMax,
            nCells: row.nCells,
            firstOrderFallback: row.firstOrderFallback,
            strouhal: row.strouhal,
            error: row.error,
            qualityWarnings: row.qualityWarnings,
            evidencePayload: {
              fidelity: row.fidelity,
              frame_track: row.frameTrack,
              steady_history: row.steadyHistory,
            },
            solvedAt: row.solvedAt,
          })),
        )
        .returning({
          id: resultAttempts.id,
          resultId: resultAttempts.resultId,
          aoaDeg: resultAttempts.aoaDeg,
          regime: resultAttempts.regime,
        });
      for (const attempt of attempts) {
        await db
          .update(results)
          .set({ currentResultAttemptId: attempt.id })
          .where(eq(results.id, attempt.resultId!));
      }
      await db.insert(resultClassifications).values([
        ...rows.map((row) => ({
          resultId: row.id,
          airfoilId: row.airfoilId,
          simulationPresetRevisionId: row.simulationPresetRevisionId!,
          aoaDeg: row.aoaDeg,
          regime: row.regime,
          classifierVersion: "detail-compat-test-v1",
          state: "accepted" as const,
          region: "attached" as const,
          confidence: 1,
          reasons: [],
        })),
        ...attempts.map((attempt) => ({
          resultAttemptId: attempt.id,
          airfoilId,
          simulationPresetRevisionId: rows.find(
            (row) => row.id === attempt.resultId,
          )!.simulationPresetRevisionId!,
          aoaDeg: attempt.aoaDeg,
          regime: attempt.regime,
          classifierVersion: "detail-compat-test-v1",
          state: "accepted" as const,
          region: "attached" as const,
          confidence: 1,
          reasons: [],
        })),
      ]);
    };

    const insertAccepted = async (
      setup: typeof baseA,
      aoas: number[],
      clOffset = 0,
    ) => {
      const inserted = await db
        .insert(results)
        .values(
          aoas.map((aoaDeg) => {
            const cl = 0.48 + aoaDeg * 0.09 + clOffset;
            const cd = 0.014 + Math.abs(aoaDeg) * 0.001;
            return {
              airfoilId,
              bcId: setup.bcId,
              simulationPresetRevisionId: setup.revision.id,
              aoaDeg,
              status: "done" as const,
              source: "solved" as const,
              regime: "rans" as const,
              fidelity: "rans",
              reynolds: setup.revision.reynolds,
              speed: setup.snapshot.flowState.speedMps,
              chord: setup.snapshot.referenceGeometry.referenceLengthM,
              mach: setup.revision.mach,
              cl,
              cd,
              cm: -0.02,
              clCd: cl / cd,
              converged: true,
              stalled: false,
              solvedAt: new Date(),
            };
          }),
        )
        .returning();
      cleanup.resultIds.push(...inserted.map((row) => row.id));
      await bindAcceptedResults(inserted);
      return inserted.map((row) => row.id);
    };

    const idsA = await insertAccepted(baseA, [-8, -2, 2, 6]);
    const idsB = await insertAccepted(baseB, [-4, 0, 4]);
    baseResultIds = [...idsA, ...idsB];
    const differentMachIds = await insertAccepted(differentMach, [1]);
    const differentMeshIds = await insertAccepted(differentMesh, [1]);
    const differentMeshTwinIds = await insertAccepted(
      differentMeshTwin,
      [1],
      0.07,
    );
    conflictResultIds = [...differentMeshIds, ...differentMeshTwinIds];
    const differentSolverIds = await insertAccepted(differentSolver, [1]);
    const separationIds = [
      ...differentMachIds,
      ...conflictResultIds,
      ...differentSolverIds,
    ];
    allAcceptedResultIds = [...baseResultIds, ...separationIds];

    refreshBaseCache = async () => {
      await refreshPolarCompatibilityCache(db, airfoilId, baseHash);
    };
    await refreshBaseCache();
    await refreshPolarCompatibilityCache(db, airfoilId, hashFor(differentMach));
    await refreshPolarCompatibilityCache(db, airfoilId, hashFor(differentMesh));
    await refreshPolarCompatibilityCache(
      db,
      airfoilId,
      hashFor(differentSolver),
    );

    // MUST-CATCH legacy rollout shape: the public anchor can lack a stored
    // hash even though its immutable snapshot is fully compatible.
    await db
      .update(simulationPresetRevisions)
      .set({ physicsHash: null, isCanonicalPhysics: false })
      .where(eq(simulationPresetRevisions.id, baseB.revision.id));
  }, 60_000);

  afterAll(async () => {
    if (airfoilId) {
      await db
        .delete(polarCompatibilityFitSets)
        .where(eq(polarCompatibilityFitSets.airfoilId, airfoilId));
    }
    if (cleanup.resultIds.length) {
      await db
        .update(results)
        .set({ currentResultAttemptId: null })
        .where(inArray(results.id, cleanup.resultIds));
      await db
        .delete(resultClassifications)
        .where(inArray(resultClassifications.resultId, cleanup.resultIds));
    }
    await deleteIds(results, cleanup.resultIds);
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
    await pgClient.end();
  }, 30_000);

  it("MUST-CATCH: merges e387 disjoint sweeps without exposing batch identity", async () => {
    const detail = await assembleDetail(slug);
    expect(detail).toBeTruthy();
    const merged = detail!.polars.find(
      (polar) => polar.seriesId === polarCompatibilitySeriesId(baseHash),
    );
    expect(merged).toBeTruthy();
    expect(merged!.points.map((point) => point.a)).toEqual([
      -8, -4, -2, 0, 2, 4, 6,
    ]);
    expect(new Set(merged!.points.map((point) => point.resultId))).toEqual(
      new Set(baseResultIds),
    );
    expect(merged!.label).not.toMatch(
      /remote|validation|preset|revision|batch/i,
    );
  });

  it("reads Detail from the exact selected attempt and fails pointer-null evidence closed", async () => {
    const resultId = baseResultIds[0];
    const [projection] = await db
      .select()
      .from(results)
      .where(eq(results.id, resultId))
      .limit(1);
    const [attempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, resultId))
      .limit(1);
    expect(projection?.currentResultAttemptId).toBe(attempt?.id);
    try {
      // A mutable projection is deliberately corrupted while its exact pointer
      // remains valid. Detail must still expose the immutable attempt values.
      await db
        .update(results)
        .set({
          status: "failed",
          source: "queued",
          regime: "urans",
          fidelity: "urans_full",
          cl: null,
          cd: null,
          cm: 999,
          clCd: null,
          converged: false,
          stalled: true,
          unsteady: true,
          engineJobId: `${PREFIX}-stale-projection`,
          engineCaseSlug: "stale-projection",
        })
        .where(eq(results.id, resultId));
      const exactDetail = await assembleDetail(slug);
      const exactPoint = exactDetail!.polars
        .flatMap((polar) => polar.points)
        .find((point) => point.resultId === resultId);
      expect(exactPoint).toMatchObject({
        cl: attempt!.cl,
        cd: attempt!.cd,
        cm: attempt!.cm,
        converged: attempt!.converged,
        stalled: attempt!.stalled,
        unsteady: attempt!.unsteady,
      });
      const exactWork = await assembleSolverWork(slug);
      const exactWorkPoint = exactWork!.conditions
        .flatMap((condition) => condition.points)
        .find((point) => point.resultId === resultId);
      expect(exactWorkPoint).toMatchObject({
        state: "verified",
        cl: attempt!.cl,
        cd: attempt!.cd,
        cm: attempt!.cm,
      });

      // Even a stale accepted verdict may not turn missing coefficients into
      // the display layer's numeric defaults.
      await db
        .update(resultAttempts)
        .set({ cl: null })
        .where(eq(resultAttempts.id, attempt!.id));
      const incompleteDetail = await assembleDetail(slug);
      expect(
        incompleteDetail!.polars
          .flatMap((polar) => polar.points)
          .some((point) => point.resultId === resultId),
      ).toBe(false);
      await db
        .update(resultAttempts)
        .set({ cl: attempt!.cl })
        .where(eq(resultAttempts.id, attempt!.id));

      // Restore the otherwise-valid legacy projection but remove its selected
      // generation. It must stay unavailable with and without aggregate cache.
      await db
        .update(results)
        .set({
          currentResultAttemptId: null,
          status: projection.status,
          source: projection.source,
          regime: projection.regime,
          fidelity: projection.fidelity,
          cl: projection.cl,
          cd: projection.cd,
          cm: projection.cm,
          clCd: projection.clCd,
          converged: projection.converged,
          stalled: projection.stalled,
          unsteady: projection.unsteady,
          engineJobId: projection.engineJobId,
          engineCaseSlug: projection.engineCaseSlug,
        })
        .where(eq(results.id, resultId));
      for (const cachePresent of [true, false]) {
        if (!cachePresent) {
          await db
            .delete(polarCompatibilityFitSets)
            .where(eq(polarCompatibilityFitSets.compatibilityHash, baseHash));
        }
        const [detail, solverWork] = await Promise.all([
          assembleDetail(slug),
          assembleSolverWork(slug),
        ]);
        expect(
          detail!.polars
            .flatMap((polar) => polar.points)
            .some((point) => point.resultId === resultId),
        ).toBe(false);
        const retained = solverWork!.conditions
          .flatMap((condition) => condition.points)
          .find((point) => point.resultId === resultId);
        expect(retained).toMatchObject({
          state: "blocked",
          cl: null,
          cd: null,
          cm: null,
          actions: [],
        });
      }
    } finally {
      await db
        .update(resultAttempts)
        .set({ cl: attempt!.cl })
        .where(eq(resultAttempts.id, attempt!.id));
      await db
        .update(results)
        .set({
          currentResultAttemptId: projection.currentResultAttemptId,
          status: projection.status,
          source: projection.source,
          regime: projection.regime,
          fidelity: projection.fidelity,
          cl: projection.cl,
          cd: projection.cd,
          cm: projection.cm,
          clCd: projection.clCd,
          converged: projection.converged,
          stalled: projection.stalled,
          unsteady: projection.unsteady,
          engineJobId: projection.engineJobId,
          engineCaseSlug: projection.engineCaseSlug,
        })
        .where(eq(results.id, resultId));
      await refreshBaseCache();
    }
  });

  it("keeps same-Re different Mach, mesh, and solver physics separate", async () => {
    const detail = await assembleDetail(slug);
    expect(detail).toBeTruthy();
    expect(detail!.polars).toHaveLength(4);
    expect(new Set(detail!.polars.map((polar) => polar.re)).size).toBe(1);
    expect(new Set(detail!.polars.map((polar) => polar.seriesId)).size).toBe(4);
    expect(new Set(detail!.polars.map((polar) => polar.label)).size).toBe(4);
    expect(new Set(detail!.polars.map((polar) => polar.color)).size).toBe(4);
    expect(
      detail!.polars.every(
        (polar) =>
          !/remote|validation|preset|revision|batch/i.test(polar.label),
      ),
    ).toBe(true);
  });

  it("keeps labels and colors stable when distinct exact conditions format identically", () => {
    const input: Polar[] = [
      {
        seriesId: "physics-b",
        label: "",
        re: 171400,
        mach: 0.074,
        color: "",
        source: "solved",
        points: [],
      },
      {
        seriesId: "physics-a",
        label: "",
        re: 171100,
        mach: 0.071,
        color: "",
        source: "solved",
        points: [],
      },
    ];
    const forward = decoratePublicPolars(input.map((polar) => ({ ...polar })));
    const reversed = decoratePublicPolars(
      [...input].reverse().map((polar) => ({ ...polar })),
    );
    const publicIdentity = (polars: Polar[]) =>
      Object.fromEntries(
        polars.map((polar) => [
          polar.seriesId,
          { label: polar.label, color: polar.color },
        ]),
      );
    expect(new Set(forward.map((polar) => polar.label)).size).toBe(2);
    expect(new Set(forward.map((polar) => polar.color)).size).toBe(2);
    expect(publicIdentity(forward)).toEqual(publicIdentity(reversed));
    expect(forward.map((polar) => polar.label).join(" ")).not.toMatch(
      /setup|preset|revision|remote-validation|batch/i,
    );
  });

  it("shows compatibility conflicts as measured evidence but excludes them from the fit", async () => {
    const detail = await assembleDetail(slug);
    const conflicted = detail!.polars.find(
      (polar) => polar.seriesId === polarCompatibilitySeriesId(conflictHash),
    );
    expect(new Set(conflicted?.points.map((point) => point.resultId))).toEqual(
      new Set(conflictResultIds),
    );
    expect(
      conflicted?.points.every((point) =>
        point.classificationReasons?.includes("compatibility_conflict"),
      ),
    ).toBe(true);
    expect(
      conflicted?.points.every((point) => point.evidenceRole === "conflict"),
    ).toBe(true);
    expect(conflicted?.fit?.points.some((point) => point.a === 1)).toBe(false);
  });

  it("keeps an exact duplicate result reachable as an alternate in cache and rollout fallback", async () => {
    expect(legacyFallbackRevision).toBeTruthy();
    const [primary] = await db
      .select()
      .from(results)
      .where(eq(results.id, baseResultIds[1]))
      .limit(1);
    expect(primary).toBeTruthy();
    const [alternate] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: primary.bcId,
        simulationPresetRevisionId: legacyFallbackRevision!.id,
        aoaDeg: primary.aoaDeg,
        status: "done",
        source: "solved",
        regime: primary.regime,
        fidelity: primary.fidelity,
        reynolds: primary.reynolds,
        speed: primary.speed,
        chord: primary.chord,
        mach: primary.mach,
        cl: primary.cl,
        cd: primary.cd,
        cm: primary.cm,
        clCd: primary.clCd,
        converged: true,
        stalled: false,
        solvedAt: primary.solvedAt,
      })
      .returning();
    cleanup.resultIds.push(alternate.id);
    await bindAcceptedResults([alternate]);
    try {
      await refreshBaseCache();
      for (const cachePresent of [true, false]) {
        if (!cachePresent) {
          await db
            .delete(polarCompatibilityFitSets)
            .where(eq(polarCompatibilityFitSets.compatibilityHash, baseHash));
        }
        const [detail, work] = await Promise.all([
          assembleDetail(slug),
          assembleSolverWork(slug),
        ]);
        const merged = detail!.polars.find(
          (polar) => polar.seriesId === polarCompatibilitySeriesId(baseHash),
        )!;
        const repeated = merged.points.filter(
          (point) => point.a === primary.aoaDeg,
        );
        expect(new Set(repeated.map((point) => point.resultId))).toEqual(
          new Set([primary.id, alternate.id]),
        );
        expect(new Set(repeated.map((point) => point.evidenceRole))).toEqual(
          new Set(["primary", "alternate"]),
        );
        const workIds = new Set(
          work!.conditions.flatMap((condition) =>
            condition.points
              .filter((point) => point.resultId)
              .map((point) => point.resultId!),
          ),
        );
        expect(workIds.has(primary.id)).toBe(true);
        expect(workIds.has(alternate.id)).toBe(true);
      }
    } finally {
      await db
        .update(results)
        .set({ currentResultAttemptId: null })
        .where(eq(results.id, alternate.id));
      await db
        .delete(resultClassifications)
        .where(eq(resultClassifications.resultId, alternate.id));
      await db.delete(results).where(eq(results.id, alternate.id));
      await refreshBaseCache();
    }
  });

  it("preserves an accepted missing Cm as null in the public detail payload", async () => {
    expect(legacyFallbackRevision).toBeTruthy();
    const [template] = await db
      .select()
      .from(results)
      .where(eq(results.id, baseResultIds[0]))
      .limit(1);
    const aoaDeg = -6;
    const cl = 0.48 + aoaDeg * 0.09;
    const cd = 0.014 + Math.abs(aoaDeg) * 0.001;
    const [missingCm] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: template.bcId,
        simulationPresetRevisionId: legacyFallbackRevision!.id,
        aoaDeg,
        status: "done",
        source: "solved",
        regime: "rans",
        fidelity: "rans",
        reynolds: template.reynolds,
        speed: template.speed,
        chord: template.chord,
        mach: template.mach,
        cl,
        cd,
        cm: null,
        clCd: cl / cd,
        converged: true,
        stalled: false,
        solvedAt: new Date(),
      })
      .returning();
    cleanup.resultIds.push(missingCm.id);
    await bindAcceptedResults([missingCm]);
    try {
      await refreshBaseCache();
      const detail = await assembleDetail(slug);
      const point = detail!.polars
        .flatMap((polar) => polar.points)
        .find((candidate) => candidate.resultId === missingCm.id);
      expect(point?.cm).toBeNull();
      expect(point?.evidenceRole).toBe("primary");
    } finally {
      await db
        .update(results)
        .set({ currentResultAttemptId: null })
        .where(eq(results.id, missingCm.id));
      await db
        .delete(resultClassifications)
        .where(eq(resultClassifications.resultId, missingCm.id));
      await db.delete(results).where(eq(results.id, missingCm.id));
      await refreshBaseCache();
    }
  });

  it("never publishes unclassified nonstationary URANS through the raw fallback", async () => {
    expect(legacyFallbackRevision).toBeTruthy();
    const [template] = await db
      .select()
      .from(results)
      .where(eq(results.id, baseResultIds[0]))
      .limit(1);
    const [unclassified] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: template.bcId,
        simulationPresetRevisionId: legacyFallbackRevision!.id,
        aoaDeg: 3,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        reynolds: template.reynolds,
        speed: template.speed,
        chord: template.chord,
        mach: template.mach,
        cl: 0.79,
        cd: 0.031,
        cm: -0.04,
        clCd: 0.79 / 0.031,
        converged: true,
        stalled: true,
        unsteady: true,
        frameTrack: {
          stationary: false,
          periods_retained: 3,
          reason: "retained window still drifting",
        },
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    cleanup.resultIds.push(unclassified.id);
    await db.insert(forceHistory).values({
      resultId: unclassified.id,
      t: [0, 0.1, 0.2, 0.3],
      cl: [0.6, 0.7, 0.8, 0.9],
      cd: [0.02, 0.025, 0.03, 0.035],
      cm: [-0.04, -0.04, -0.04, -0.04],
    });
    await db.insert(resultMedia).values({
      resultId: unclassified.id,
      kind: "video",
      field: "velocity_magnitude",
      role: "instantaneous",
      storageKey: `${PREFIX}/unclassified-nonstationary.mp4`,
      mimeType: "video/mp4",
    });

    try {
      const detail = await assembleDetail(slug, {
        revisionId: legacyFallbackRevision!.id,
      });
      expect(
        detail!.polars
          .flatMap((polar) => polar.points)
          .some((point) => point.resultId === unclassified.id),
      ).toBe(false);
    } finally {
      // Keep later Solver Work/chart conservation assertions scoped to their
      // accepted fixture set.  Child force/media evidence cascades.
      await db.delete(results).where(eq(results.id, unclassified.id));
    }
  });

  it("conserves every verified Solver Work result in a public chart series", async () => {
    const [detail, work] = await Promise.all([
      assembleDetail(slug),
      assembleSolverWork(slug),
    ]);
    expect(detail).toBeTruthy();
    expect(work).toBeTruthy();
    const chartIds = new Set(
      detail!.polars.flatMap((polar) =>
        polar.points
          .map((point) => point.resultId)
          .filter((id): id is string => typeof id === "string"),
      ),
    );
    const eligibleWorkIds = new Set(
      work!.conditions.flatMap((condition) =>
        condition.points
          .filter(
            (point) =>
              (point.state === "verified" || point.state === "provisional") &&
              point.resultId,
          )
          .map((point) => point.resultId!),
      ),
    );
    expect(chartIds).toEqual(new Set(allAcceptedResultIds));
    expect(chartIds).toEqual(eligibleWorkIds);
  });

  it("falls back to raw compatible evidence when the additive cache is absent", async () => {
    await db
      .delete(polarCompatibilityFitSets)
      .where(eq(polarCompatibilityFitSets.compatibilityHash, baseHash));
    try {
      const detail = await assembleDetail(slug);
      const merged = detail!.polars.find(
        (polar) => polar.seriesId === polarCompatibilitySeriesId(baseHash),
      );
      expect(new Set(merged?.points.map((point) => point.resultId))).toEqual(
        new Set(baseResultIds),
      );
      expect(merged?.fit).toBeUndefined();
    } finally {
      await refreshBaseCache();
    }
  });

  it("fails closed without a 500 when a legacy snapshot cannot be hashed", async () => {
    expect(legacyFallbackRevision).toBeTruthy();
    await db
      .update(simulationPresetRevisions)
      .set({ snapshot: { malformed: true }, physicsHash: null })
      .where(eq(simulationPresetRevisions.id, legacyFallbackRevision!.id));
    try {
      const detail = await assembleDetail(slug);
      expect(detail).toBeTruthy();
      const isolated = detail!.polars.find(
        (polar) =>
          polar.seriesId ===
          polarCompatibilitySeriesId(
            `legacy-revision:${legacyFallbackRevision!.id}`,
          ),
      );
      expect(isolated?.points.map((point) => point.a)).toEqual([-4, 0, 4]);
    } finally {
      await db
        .update(simulationPresetRevisions)
        .set({ snapshot: legacyFallbackRevision!.snapshot, physicsHash: null })
        .where(eq(simulationPresetRevisions.id, legacyFallbackRevision!.id));
    }
  });
});
