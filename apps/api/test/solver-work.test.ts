import {
  URANS_BUDGET_STOP_MARKER,
  URANS_CONTINUATION_REQUIRED_MARKER,
  type Point,
} from "@aerodb/core";
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
  simJobs,
  simUransVerifyQueue,
  simulationPresets,
  solverProfiles,
  sweepDefinitions,
} from "@aerodb/db";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, sql as pgClient } from "../src/db";
import { buildServer } from "../src/server";
import { solverWorkStateForPoint } from "../src/services/solver-work";

const PREFIX = `solver-work-${process.pid}-${Date.now().toString(36)}`;
const BUDGET_WARNING = `URANS integration ${URANS_BUDGET_STOP_MARKER}: retained 1.4 of 3 periods (budget); marched 0.21 s of 0.46 s`;
const CONTINUATION_WARNING = `URANS continuation ${URANS_CONTINUATION_REQUIRED_MARKER}: reached the 6-chunk in-run safety cap with restartable saved case state; URANS window not stationary (precalc established-oscillation test): cycle means trend upward monotonically`;

const points: Point[] = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.05 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.05 },
  { x: 1, y: 0 },
];

const cleanup = {
  verifyIds: [] as string[],
  resultIds: [] as string[],
  jobIds: [] as string[],
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

async function createCondition(
  suffix: string,
  reynolds: number,
  speedMps: number,
  chordM: number,
) {
  const [air] = await db
    .select()
    .from(mediums)
    .where(eq(mediums.slug, "air"))
    .limit(1);
  expect(air).toBeTruthy();
  const mach = air.speedOfSound ? speedMps / air.speedOfSound : null;

  const [bc] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${PREFIX}-${suffix}-bc`,
      name: `${PREFIX} ${suffix} BC`,
      mediumId: air.id,
      reynolds,
      referenceChordM: chordM,
      temperatureK: air.refTemperatureK,
      pressurePa: air.refPressurePa,
      speedMps,
      density: air.density,
      dynamicViscosity: air.dynamicViscosity,
      kinematicViscosity: air.kinematicViscosity,
      mach,
      enabled: true,
    })
    .returning({ id: boundaryConditions.id });
  cleanup.bcIds.push(bc.id);

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
      mach,
    })
    .returning({ id: flowConditions.id });
  cleanup.flowIds.push(flow.id);

  const [reference] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${PREFIX}-${suffix}-ref`,
      name: `${PREFIX} ${suffix} reference`,
      geometryType: "airfoil_2d",
      referenceLengthKind: "chord",
      referenceLengthM: chordM,
    })
    .returning({ id: referenceGeometryProfiles.id });
  cleanup.referenceIds.push(reference.id);

  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({
      slug: `${PREFIX}-${suffix}-boundary`,
      name: `${PREFIX} ${suffix} boundary`,
    })
    .returning({
      id: boundaryProfiles.id,
    });
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
    .returning({
      id: solverProfiles.id,
    });
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
    .returning({
      id: outputProfiles.id,
    });
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({
      slug: `${PREFIX}-${suffix}-sweep`,
      name: `${PREFIX} ${suffix} sweep`,
      aoaStart: -2,
      aoaStop: 6,
      aoaStep: 1,
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
  return {
    bcId: bc.id,
    presetId: preset.id,
    revisionId: resolved!.revision.id,
    reynolds,
    speedMps,
    chordM,
    mach,
  };
}

describe("solverWorkStateForPoint", () => {
  it("pins the honest public taxonomy for every state", () => {
    expect(
      solverWorkStateForPoint({
        resultId: "r",
        status: "done",
        classificationState: "accepted",
        regime: "rans",
        fidelity: "rans",
      }),
    ).toBe("verified");
    expect(
      solverWorkStateForPoint({
        resultId: "r",
        status: "done",
        classificationState: "needs_urans",
        regime: "rans",
        fidelity: "rans",
      }),
    ).toBe("provisional");
    expect(
      solverWorkStateForPoint({
        resultId: "r",
        status: "running",
        classificationState: null,
        regime: "urans",
        fidelity: "urans_precalc",
      }),
    ).toBe("solving");
    expect(solverWorkStateForPoint({ resultId: null, status: null })).toBe(
      "queued",
    );
    expect(
      solverWorkStateForPoint({
        resultId: "r",
        status: "done",
        classificationState: "rejected",
        regime: "rans",
        fidelity: "rans",
        openRequest: true,
      }),
    ).toBe("ladder");
    expect(
      solverWorkStateForPoint({
        resultId: "r",
        status: "done",
        classificationState: "rejected",
        regime: "urans",
        fidelity: "urans_precalc",
        continuable: true,
      }),
    ).toBe("needs_time");
    expect(
      solverWorkStateForPoint({
        resultId: "r",
        status: "done",
        classificationState: "rejected",
        regime: "urans",
        fidelity: "urans_full",
      }),
    ).toBe("blocked");
    expect(
      solverWorkStateForPoint({
        resultId: "legacy-urans",
        status: "done",
        classificationState: "rejected",
        regime: "urans",
        fidelity: null,
      }),
    ).toBe("blocked");
    expect(
      solverWorkStateForPoint({
        resultId: "legacy-rans",
        status: "done",
        classificationState: "rejected",
        regime: null,
        fidelity: null,
      }),
    ).toBe("ladder");
    expect(
      solverWorkStateForPoint({
        resultId: "r",
        status: "failed",
        regime: "urans",
        error: "mesh degenerate at leading edge",
      }),
    ).toBe("blocked");
    expect(
      solverWorkStateForPoint({
        resultId: "r",
        status: "failed",
        regime: "urans",
        fidelity: "urans_precalc",
        classificationState: "rejected",
        classificationReasons: ["missing-urans-video"],
        mediaRepairState: "retry_wait",
      }),
    ).toBe("ladder");
    expect(
      solverWorkStateForPoint({
        resultId: "r",
        status: "failed",
        regime: "urans",
        error: "second transient solver crash",
      }),
    ).toBe("blocked");
    expect(
      solverWorkStateForPoint({
        resultId: "r",
        status: "done",
        classificationState: "rejected",
        classificationReasons: ["missing-urans-video"],
        regime: "urans",
        fidelity: "urans_precalc",
      }),
    ).toBe("blocked");
    expect(
      solverWorkStateForPoint({
        resultId: "r",
        status: "done",
        classificationState: "superseded_by_urans",
        regime: "rans",
        fidelity: "rans",
      }),
    ).toBe("superseded");
  });

  it("keeps accepted rows with unrelated live continuation requests verified", () => {
    expect(
      solverWorkStateForPoint({
        resultId: "accepted",
        status: "done",
        classificationState: "accepted",
        regime: "urans",
        fidelity: "urans_full",
        openRequest: true,
      }),
    ).toBe("verified");
  });

  it("MUST-CATCH: never verifies completed RANS or URANS evidence without a known machine classification", () => {
    for (const row of [
      {
        resultId: "unclassified-rans",
        status: "done",
        classificationState: null,
        regime: "rans",
        fidelity: "rans",
      },
      {
        resultId: "unclassified-urans",
        status: "done",
        classificationState: null,
        regime: "urans",
        fidelity: "urans_precalc",
      },
      {
        resultId: "unknown-classification",
        status: "done",
        classificationState: "legacy_unknown_state",
        regime: "urans",
        fidelity: "urans_full",
      },
    ]) {
      expect(solverWorkStateForPoint(row)).toBe("blocked");
    }
  });

  it("never lets a legacy human waiver override the machine state", () => {
    expect(
      solverWorkStateForPoint({
        resultId: "legacy-waiver",
        status: "done",
        classificationState: "rejected",
        regime: "urans",
        fidelity: "urans_full",
        reviewVerdict: "waive",
      }),
    ).toBe("blocked");
    expect(
      solverWorkStateForPoint({
        resultId: "conservative-exclusion",
        status: "done",
        classificationState: "accepted",
        regime: "urans",
        fidelity: "urans_full",
        reviewVerdict: "exclude",
      }),
    ).toBe("excluded");
  });
});

describe("GET /api/airfoils/:slug/solver-work", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let slug = "";
  let revA = "";
  let revB = "";
  let jobA = "";

  beforeAll(async () => {
    app = await buildServer();
    const [cat] = await db
      .insert(categories)
      .values({
        slug: `${PREFIX}-cat`,
        name: `${PREFIX} category`,
        path: `${PREFIX}-cat`,
        depth: 0,
      })
      .returning({ id: categories.id });
    cleanup.categoryIds.push(cat.id);
    const [airfoil] = await db
      .insert(airfoils)
      .values({
        slug: `${PREFIX}-af`,
        name: `${PREFIX} airfoil`,
        categoryId: cat.id,
        points,
        isSymmetric: false,
      })
      .returning({ id: airfoils.id, slug: airfoils.slug });
    cleanup.airfoilIds.push(airfoil.id);
    slug = airfoil.slug;

    const conditionA = await createCondition("a", 853000, 25, 0.5);
    const conditionB = await createCondition("b", 420000, 18, 0.3);
    revA = conditionA.revisionId;
    revB = conditionB.revisionId;

    const [provisional] = await db
      .insert(results)
      .values({
        airfoilId: airfoil.id,
        bcId: conditionA.bcId,
        simulationPresetRevisionId: revA,
        aoaDeg: 2,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        reynolds: conditionA.reynolds,
        speed: conditionA.speedMps,
        chord: conditionA.chordM,
        mach: conditionA.mach,
        cl: 0.72,
        cd: 0.021,
        cm: -0.04,
        converged: true,
        unsteady: true,
        solvedAt: new Date(),
      })
      .returning();
    const [needsTime] = await db
      .insert(results)
      .values({
        airfoilId: airfoil.id,
        bcId: conditionA.bcId,
        simulationPresetRevisionId: revA,
        aoaDeg: 3,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        reynolds: conditionA.reynolds,
        speed: conditionA.speedMps,
        chord: conditionA.chordM,
        mach: conditionA.mach,
        cl: 0.8,
        cd: 0.03,
        cm: -0.05,
        converged: true,
        unsteady: true,
        qualityWarnings: [BUDGET_WARNING],
        engineJobId: `${PREFIX}-engine-budget`,
        engineCaseSlug: `${PREFIX}-case-budget`,
        solvedAt: new Date(),
      })
      .returning();
    const [needsContinuation] = await db
      .insert(results)
      .values({
        airfoilId: airfoil.id,
        bcId: conditionA.bcId,
        simulationPresetRevisionId: revA,
        aoaDeg: 4,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        reynolds: conditionA.reynolds,
        speed: conditionA.speedMps,
        chord: conditionA.chordM,
        mach: conditionA.mach,
        cl: 0.82,
        cd: 0.031,
        cm: -0.05,
        converged: true,
        unsteady: true,
        qualityWarnings: [CONTINUATION_WARNING],
        engineJobId: `${PREFIX}-engine-continuation`,
        engineCaseSlug: `${PREFIX}-case-continuation`,
        solvedAt: new Date(),
      })
      .returning();
    const [verifiedB] = await db
      .insert(results)
      .values({
        airfoilId: airfoil.id,
        bcId: conditionB.bcId,
        simulationPresetRevisionId: revB,
        aoaDeg: 1,
        status: "done",
        source: "solved",
        regime: "rans",
        fidelity: "rans",
        reynolds: conditionB.reynolds,
        speed: conditionB.speedMps,
        chord: conditionB.chordM,
        mach: conditionB.mach,
        cl: 0.4,
        cd: 0.012,
        cm: -0.02,
        converged: true,
        solvedAt: new Date(),
      })
      .returning();
    const [unclassifiedRans] = await db
      .insert(results)
      .values({
        airfoilId: airfoil.id,
        bcId: conditionA.bcId,
        simulationPresetRevisionId: revA,
        aoaDeg: 6,
        status: "done",
        source: "solved",
        regime: "rans",
        fidelity: "rans",
        reynolds: conditionA.reynolds,
        speed: conditionA.speedMps,
        chord: conditionA.chordM,
        mach: conditionA.mach,
        cl: 0.9,
        cd: 0.04,
        cm: -0.06,
        converged: true,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    const [unclassifiedUrans] = await db
      .insert(results)
      .values({
        airfoilId: airfoil.id,
        bcId: conditionA.bcId,
        simulationPresetRevisionId: revA,
        aoaDeg: 7,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        reynolds: conditionA.reynolds,
        speed: conditionA.speedMps,
        chord: conditionA.chordM,
        mach: conditionA.mach,
        cl: 0.95,
        cd: 0.045,
        cm: -0.065,
        converged: true,
        unsteady: true,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    cleanup.resultIds.push(
      provisional.id,
      needsTime.id,
      needsContinuation.id,
      verifiedB.id,
      unclassifiedRans.id,
      unclassifiedUrans.id,
    );

    await db.insert(resultClassifications).values([
      {
        resultId: provisional.id,
        airfoilId: airfoil.id,
        simulationPresetRevisionId: revA,
        aoaDeg: 2,
        regime: "urans",
        classifierVersion: "test",
        state: "accepted",
        reasons: [],
        confidence: 0.95,
      },
      {
        resultId: needsTime.id,
        airfoilId: airfoil.id,
        simulationPresetRevisionId: revA,
        aoaDeg: 3,
        regime: "urans",
        classifierVersion: "test",
        state: "rejected",
        reasons: ["insufficient-periods"],
        confidence: 0.9,
      },
      {
        resultId: needsContinuation.id,
        airfoilId: airfoil.id,
        simulationPresetRevisionId: revA,
        aoaDeg: 4,
        regime: "urans",
        classifierVersion: "test",
        state: "rejected",
        reasons: ["sparse-frame-track"],
        confidence: 0.9,
      },
      {
        resultId: verifiedB.id,
        airfoilId: airfoil.id,
        simulationPresetRevisionId: revB,
        aoaDeg: 1,
        regime: "rans",
        classifierVersion: "test",
        state: "accepted",
        reasons: [],
        confidence: 0.95,
      },
    ]);

    const exactRows = [provisional, needsTime, needsContinuation, verifiedB];
    const exactStates = new Map([
      [provisional.id, { state: "accepted" as const, reasons: [] }],
      [
        needsTime.id,
        { state: "rejected" as const, reasons: ["insufficient-periods"] },
      ],
      [
        needsContinuation.id,
        { state: "rejected" as const, reasons: ["sparse-frame-track"] },
      ],
      [verifiedB.id, { state: "accepted" as const, reasons: [] }],
    ]);
    const exactAttempts = await db
      .insert(resultAttempts)
      .values(
        exactRows.map((result) => ({
          resultId: result.id,
          airfoilId: result.airfoilId,
          bcId: result.bcId,
          simulationPresetRevisionId: result.simulationPresetRevisionId,
          aoaDeg: result.aoaDeg,
          status: result.status,
          source: result.source,
          regime: result.regime,
          validForPolar: exactStates.get(result.id)?.state === "accepted",
          cl: result.cl,
          cd: result.cd,
          cm: result.cm,
          clCd: result.clCd,
          converged: result.converged,
          unsteady: result.unsteady,
          qualityWarnings: result.qualityWarnings,
          engineJobId: result.engineJobId,
          engineCaseSlug: result.engineCaseSlug,
          evidencePayload: {
            fidelity: result.fidelity,
            frame_track: result.frameTrack,
          },
          solvedAt: result.solvedAt,
        })),
      )
      .returning({
        id: resultAttempts.id,
        resultId: resultAttempts.resultId,
        aoaDeg: resultAttempts.aoaDeg,
        regime: resultAttempts.regime,
      });
    for (const attempt of exactAttempts) {
      await db
        .update(results)
        .set({ currentResultAttemptId: attempt.id })
        .where(eq(results.id, attempt.resultId!));
    }
    await db.insert(resultClassifications).values(
      exactAttempts.map((attempt) => ({
        resultAttemptId: attempt.id,
        airfoilId: airfoil.id,
        simulationPresetRevisionId: exactRows.find(
          (result) => result.id === attempt.resultId,
        )!.simulationPresetRevisionId!,
        aoaDeg: attempt.aoaDeg,
        regime: attempt.regime,
        classifierVersion: "test",
        state: exactStates.get(attempt.resultId!)!.state,
        reasons: exactStates.get(attempt.resultId!)!.reasons,
        confidence: 0.95,
      })),
    );

    const [verify] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId: airfoil.id,
        revisionId: revA,
        aoaDeg: 2,
        state: "pending",
        precalcResultId: provisional.id,
      })
      .returning({ id: simUransVerifyQueue.id });
    cleanup.verifyIds.push(verify.id);

    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: airfoil.id,
        bcIds: [conditionA.bcId],
        simulationPresetRevisionId: revA,
        jobKind: "sweep",
        referenceChordM: conditionA.chordM,
        wave: 1,
        status: "running",
        totalCases: 3,
        completedCases: 1,
        engineJobId: `${PREFIX}-engine-a`,
        requestPayload: {
          aoas: [2, 3, 5],
          setupSnapshot: {
            preset: { name: `${PREFIX} setup A` },
            derived: { reynolds: conditionA.reynolds },
            flowState: { mach: conditionA.mach },
          },
          speedMap: [{ mach: conditionA.mach }],
        },
      })
      .returning({ id: simJobs.id });
    cleanup.jobIds.push(job.id);
    jobA = job.id;
  }, 60_000);

  afterAll(async () => {
    await deleteIds(simUransVerifyQueue, cleanup.verifyIds);
    if (cleanup.resultIds.length) {
      await db
        .update(results)
        .set({ currentResultAttemptId: null })
        .where(inArray(results.id, cleanup.resultIds));
      await db
        .delete(resultClassifications)
        .where(inArray(resultClassifications.resultId, cleanup.resultIds));
      await db.delete(results).where(inArray(results.id, cleanup.resultIds));
    }
    await deleteIds(simJobs, cleanup.jobIds);
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
  });

  it("groups solver work by condition and preserves the legacy job row shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/airfoils/${slug}/solver-work`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      conditions: Array<{
        presetRevisionId: string;
        reynolds: number;
        mach: number | null;
        chordM: number | null;
        speedMps: number | null;
        attentionCount: number;
        points: Array<{
          aoaDeg: number;
          state: string;
          actions: string[];
          resultId: string | null;
          cl: number | null;
          cd: number | null;
          cm: number | null;
          gate: { name: string; detail: string } | null;
          gates: Array<{ name: string; detail: string; pass: boolean }>;
          plain: string;
          reviewed: boolean;
        }>;
        jobs: unknown[];
      }>;
    };
    expect(new Set(body.conditions.map((c) => c.presetRevisionId))).toEqual(
      new Set([revA, revB]),
    );
    const conditionA = body.conditions.find(
      (c) => c.presetRevisionId === revA,
    )!;
    expect(conditionA.reynolds).toBeCloseTo(853000, -3); // fixture derives Re back from speed (852891)
    expect(conditionA.chordM).toBeCloseTo(0.5);
    expect(conditionA.speedMps).toBeCloseTo(25);
    expect(conditionA.attentionCount).toBe(4);
    const byAoa = new Map(conditionA.points.map((p) => [p.aoaDeg, p]));
    expect(byAoa.get(2)?.state).toBe("provisional");
    expect(byAoa.get(3)?.state).toBe("needs_time");
    expect(byAoa.get(3)?.actions).toEqual(["continue"]);
    expect(byAoa.get(3)?.gate).toMatchObject({
      name: "march-rate guard",
      detail: "retained 1.4 / 3 periods · marched 0.21 s of 0.46 s",
    });
    expect(byAoa.get(4)).toMatchObject({
      state: "needs_time",
      actions: ["continue"],
      gate: { name: "stationarity gate" },
    });
    expect(byAoa.get(4)?.plain).toContain("needs more same-case integration");
    expect(byAoa.get(4)?.plain).not.toContain("time budget");
    expect(byAoa.get(5)).toMatchObject({ state: "queued", resultId: null });
    for (const aoa of [6, 7]) {
      expect(byAoa.get(aoa)).toMatchObject({
        state: "blocked",
        actions: [],
        reviewed: false,
        cl: null,
        cd: null,
        cm: null,
        gate: {
          name: "quality gate",
          detail:
            "Automatic evidence classification is unavailable; this stored result is not used in the polar.",
        },
      });
      expect(byAoa.get(aoa)?.plain).toContain("no human review is required");
      expect(byAoa.get(aoa)?.plain).not.toContain("verified");
      expect(byAoa.get(aoa)?.gates).toEqual([
        {
          name: "quality gate",
          detail:
            "Automatic evidence classification is unavailable; this stored result is not used in the polar.",
          pass: false,
        },
      ]);
    }

    const detail = await app.inject({
      method: "GET",
      url: `/api/airfoils/${slug}`,
    });
    expect(detail.statusCode).toBe(200);
    const legacyJob = (
      detail.json().simulationWorks as Array<{ id: string }>
    ).find((job) => job.id === jobA);
    expect(conditionA.jobs).toEqual([legacyJob]);
  });

  it("filters to one preset revision", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/airfoils/${slug}/solver-work?revision=${revB}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      conditions: Array<{
        presetRevisionId: string;
        points: Array<{ state: string }>;
      }>;
    };
    expect(
      body.conditions.map((condition) => condition.presetRevisionId),
    ).toEqual([revB]);
    expect(body.conditions[0].points.map((point) => point.state)).toEqual([
      "verified",
    ]);
  });
});
