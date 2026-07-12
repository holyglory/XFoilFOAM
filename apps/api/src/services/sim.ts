import {
  canonicalAoa,
  type FieldId,
  type FieldMedia,
  type FrameTrackDetail,
  type SimulationDetail,
  type SteadyHistoryDetail,
  type UransVerifyDetail,
} from "@aerodb/core";
import {
  FRAME_IMAGE_ARTIFACT_KIND,
  parseFrameTrack,
  parsePointFidelity,
  parseSteadyHistory,
} from "@aerodb/engine-client";
import {
  airfoils,
  boundaryConditions,
  flowConditions,
  forceHistory,
  fieldColorScales,
  mediums,
  type Result,
  resultAttempts,
  resultClassifications,
  resultMedia,
  results,
  simulationPresetRevisions,
  simulationPresets,
  simUransVerifyQueue,
  solverEvidenceArtifacts,
  activeReviewVerdict,
} from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../db";
import { mediaStore } from "../media-store";

type ReviewDisclosure = {
  verdict: "exclude";
  note: string | null;
  reviewer: string;
  at: string;
};
type SimulationDetailWithReview = SimulationDetail & {
  review?: ReviewDisclosure;
};

function finiteStored(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const ENGINE_TO_FIELD: Record<string, FieldId> = {
  velocity_magnitude: "velocity_magnitude",
  velocity_x: "velocity_x",
  velocity_y: "velocity_y",
  pressure: "pressure",
  pressure_coefficient: "pressure_coefficient",
  vorticity: "vorticity",
  turbulent_kinetic_energy: "turbulent_kinetic_energy",
  turbulent_viscosity: "turbulent_viscosity",
};

function snapshotParts(snapshot: SimulationSetupSnapshot | undefined) {
  if (!snapshot) return null;
  const legacy = snapshot as unknown as {
    operating?: {
      mediumName: string;
      speedMps: number;
      referenceChordM: number;
      temperatureK: number;
      pressurePa: number;
      density?: number;
      dynamicViscosity?: number;
      kinematicViscosity?: number;
      mach?: number | null;
    };
    mesh?: {
      mesher: string;
      farfieldRadiusChords: number;
      wakeLengthChords: number;
      nSurface: number;
      nRadial: number;
      nWake: number;
      targetYPlus: number;
      spanChords: number;
    };
  };
  return {
    mediumName: snapshot.flowState?.mediumName ?? legacy.operating?.mediumName,
    speedMps: snapshot.flowState?.speedMps ?? legacy.operating?.speedMps,
    referenceChordM:
      snapshot.referenceGeometry?.referenceLengthM ??
      legacy.operating?.referenceChordM,
    temperatureK:
      snapshot.flowState?.temperatureK ?? legacy.operating?.temperatureK,
    pressurePa: snapshot.flowState?.pressurePa ?? legacy.operating?.pressurePa,
    density: snapshot.flowState?.density ?? legacy.operating?.density,
    dynamicViscosity:
      snapshot.flowState?.dynamicViscosity ??
      legacy.operating?.dynamicViscosity,
    kinematicViscosity:
      snapshot.flowState?.kinematicViscosity ??
      legacy.operating?.kinematicViscosity,
    mach: snapshot.flowState?.mach ?? legacy.operating?.mach,
    mesh: snapshot.mesh ?? legacy.mesh,
  };
}

/** Build the public/detail projection from the exact selected attempt. The
 * results row owns cell/physical identity; every solver output/provenance
 * value comes from current_result_attempt_id so generations can never mix. */
function selectedResultProjection(
  result: Result,
  attempt: typeof resultAttempts.$inferSelect,
): Result {
  const payload =
    attempt.evidencePayload && typeof attempt.evidencePayload === "object"
      ? (attempt.evidencePayload as Record<string, unknown>)
      : {};
  return {
    ...result,
    status: attempt.status,
    source: attempt.source,
    regime: attempt.regime,
    cl: attempt.cl,
    cd: attempt.cd,
    cm: attempt.cm,
    clCd: attempt.clCd,
    clStd: attempt.clStd,
    cdStd: attempt.cdStd,
    cmStd: attempt.cmStd,
    stalled: attempt.stalled,
    unsteady: attempt.unsteady,
    converged: attempt.converged,
    finalResidual: attempt.finalResidual,
    iterations: attempt.iterations,
    yPlusAvg: attempt.yPlusAvg,
    yPlusMax: attempt.yPlusMax,
    nCells: attempt.nCells,
    firstOrderFallback: attempt.firstOrderFallback,
    strouhal: attempt.strouhal,
    error: attempt.error,
    qualityWarnings: attempt.qualityWarnings,
    frameTrack: payload.frame_track ?? payload.frameTrack ?? null,
    fidelity: typeof payload.fidelity === "string" ? payload.fidelity : null,
    steadyHistory: payload.steady_history ?? payload.steadyHistory ?? null,
    simJobId: attempt.simJobId,
    engineJobId: attempt.engineJobId,
    engineCaseSlug: attempt.engineCaseSlug,
    solvedAt: attempt.solvedAt,
  };
}

type EvidenceRow = typeof solverEvidenceArtifacts.$inferSelect;

function frameIndexOf(row: EvidenceRow): number | null {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  if (typeof meta.frameIndex === "number" && Number.isInteger(meta.frameIndex))
    return meta.frameIndex;
  const match = /f(\d{4})\.(?:png|jpg|jpeg)$/i.exec(row.storageKey);
  return match ? Number(match[1]) : null;
}

/** Resolve results.frame_track (verbatim engine contract jsonb) + registered
 *  frame_image evidence rows into the modal payload: camelCase stats/window
 *  plus per-frame /api/media image URLs. Frames whose PNG evidence is not
 *  registered ship WITHOUT that field's URL — absence stays absence. A
 *  contract-drifted payload resolves to null (the classifier already rejects
 *  such points; the raw jsonb stays on the row as evidence). */
function frameTrackDetailOf(
  r: Result,
  frameArtifacts: EvidenceRow[],
): FrameTrackDetail | null {
  if (r.frameTrack === null || r.frameTrack === undefined) return null;
  const parsed = parseFrameTrack(r.frameTrack);
  if (!parsed.ok) return null;
  const ft = parsed.value;
  const urlByFieldFrame = new Map<string, string>();
  for (const row of frameArtifacts) {
    const index = frameIndexOf(row);
    const field =
      row.field ??
      ft.fields.find((f) => row.storageKey.includes(`/${f}/`)) ??
      null;
    if (index === null || !field) continue;
    urlByFieldFrame.set(`${field}:${index}`, mediaStore.url(row.storageKey));
  }
  return {
    periodS: ft.period_s,
    periodsRetained: ft.periods_retained,
    stationary: ft.stationary,
    driftFrac: ft.drift_frac,
    window: { tStart: ft.window.t_start, tEnd: ft.window.t_end },
    stats: ft.stats,
    fields: ft.fields,
    frames: ft.frames.map((frame) => ({
      i: frame.i,
      t: frame.t,
      cl: frame.cl,
      cd: frame.cd,
      cm: frame.cm,
      imageUrls: Object.fromEntries(
        ft.fields.flatMap((field) => {
          const url = urlByFieldFrame.get(`${field}:${frame.i}`);
          return url ? [[field, url] as const] : [];
        }),
      ),
    })),
  };
}

/** Strict-parse results.steady_history into the modal's camelCase shape.
 *  A drifted payload resolves to null — the chart never renders invented
 *  samples (the raw jsonb stays on the row as evidence). */
function steadyHistoryDetailOf(r: Result): SteadyHistoryDetail | null {
  if (r.steadyHistory === null || r.steadyHistory === undefined) return null;
  const parsed = parseSteadyHistory(r.steadyHistory);
  if (!parsed.ok) return null;
  const sh = parsed.value;
  return {
    iterations: sh.iterations,
    cl: sh.cl,
    cd: sh.cd,
    cm: sh.cm,
    window: { startIter: sh.window.start_iter, endIter: sh.window.end_iter },
    meanStable: sh.mean_stable,
    note: sh.note,
  };
}

/** Latest verify-queue item covering this point's cell+angle (contract 4) —
 *  the modal header renders "verify pending"/"disagreed" from the REAL queue
 *  row, never inferred from fidelity alone. */
async function uransVerifyDetailOf(
  r: Result,
): Promise<UransVerifyDetail | null> {
  if (!r.simulationPresetRevisionId) return null;
  const [item] = await db
    .select({
      state: simUransVerifyQueue.state,
      deltaCl: simUransVerifyQueue.deltaCl,
      deltaCd: simUransVerifyQueue.deltaCd,
      deltaCm: simUransVerifyQueue.deltaCm,
    })
    .from(simUransVerifyQueue)
    .where(
      and(
        eq(simUransVerifyQueue.airfoilId, r.airfoilId),
        eq(simUransVerifyQueue.revisionId, r.simulationPresetRevisionId),
        eq(simUransVerifyQueue.aoaDeg, r.aoaDeg),
      ),
    )
    .orderBy(desc(simUransVerifyQueue.createdAt))
    .limit(1);
  return item ?? null;
}

async function solvedDetail(
  name: string,
  re: number,
  r: Result,
): Promise<SimulationDetailWithReview | null> {
  if (!r.currentResultAttemptId) return null;
  if (
    !finiteStored(r.cl) ||
    !finiteStored(r.cd) ||
    r.cd <= 0 ||
    !finiteStored(re) ||
    re <= 0
  ) {
    return null;
  }
  const cl = r.cl;
  const cd = r.cd;
  const review = await activeReviewVerdict(db, r.id);
  const media: Partial<Record<FieldId, FieldMedia>> = {};
  const rows = await db
    .select()
    .from(resultMedia)
    .where(
      and(
        eq(resultMedia.resultId, r.id),
        eq(resultMedia.resultAttemptId, r.currentResultAttemptId!),
      ),
    );
  const scaleIds = Array.from(
    new Set(
      rows
        .map((row) => row.colorScaleId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const scales = scaleIds.length
    ? await db
        .select()
        .from(fieldColorScales)
        .where(inArray(fieldColorScales.id, scaleIds))
    : [];
  const scaleById = new Map(scales.map((scale) => [scale.id, scale]));
  for (const mrow of rows) {
    const field = mrow.field ? ENGINE_TO_FIELD[mrow.field] : undefined;
    if (!field) continue;
    const entry = (media[field] ??= { kind: mrow.kind, url: "" });
    const scale = mrow.colorScaleId ? scaleById.get(mrow.colorScaleId) : null;
    if (scale && !entry.scale) {
      entry.scale = {
        mode: "track",
        vmin: mrow.scaleVmin ?? scale.vmin,
        vmax: mrow.scaleVmax ?? scale.vmax,
        policy: mrow.scalePolicy ?? scale.scalePolicy,
        version: mrow.colorScaleVersion ?? scale.version,
        status: scale.status,
      };
    }
    if (mrow.role === "mean") {
      entry.meanUrl = mediaStore.url(mrow.storageKey);
    } else if (mrow.kind === "video") {
      // URANS stores both an instantaneous PNG and an MP4 for the same field.
      // The live pane must prefer the animation; the PNG remains a fallback.
      entry.kind = mrow.kind;
      entry.url = mediaStore.url(mrow.storageKey);
      entry.videoUrl = entry.url;
    } else if (!entry.url) {
      entry.kind = mrow.kind;
      entry.url = mediaStore.url(mrow.storageKey);
      entry.imageUrl = entry.url;
    } else if (!entry.imageUrl) {
      entry.imageUrl = mediaStore.url(mrow.storageKey);
    }
  }
  const allEvidenceRows = await db
    .select()
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.resultId, r.id),
        eq(solverEvidenceArtifacts.resultAttemptId, r.currentResultAttemptId!),
      ),
    )
    .orderBy(desc(solverEvidenceArtifacts.createdAt));
  // Per-frame URANS PNGs feed frameTrack.frames[].imageUrls; keeping their
  // <=240 rows out of the generic evidenceArtifacts list keeps the payload
  // bounded and the evidence panel readable.
  const frameArtifacts = allEvidenceRows.filter(
    (row) => row.kind === FRAME_IMAGE_ARTIFACT_KIND,
  );
  const evidenceRows = allEvidenceRows.filter(
    (row) => row.kind !== FRAME_IMAGE_ARTIFACT_KIND,
  );
  const [hist] = await db
    .select()
    .from(forceHistory)
    .where(
      and(
        eq(forceHistory.resultId, r.id),
        eq(forceHistory.resultAttemptId, r.currentResultAttemptId!),
      ),
    )
    .limit(1);
  const [revision] = r.simulationPresetRevisionId
    ? await db
        .select()
        .from(simulationPresetRevisions)
        .where(eq(simulationPresetRevisions.id, r.simulationPresetRevisionId))
        .limit(1)
    : [];
  const snapshot = revision?.snapshot as unknown as
    | SimulationSetupSnapshot
    | undefined;
  const [legacyCondition] = snapshot
    ? []
    : await db
        .select({ bc: boundaryConditions, mediumName: mediums.name })
        .from(boundaryConditions)
        .innerJoin(mediums, eq(boundaryConditions.mediumId, mediums.id))
        .where(eq(boundaryConditions.id, r.bcId))
        .limit(1);
  const setup = snapshotParts(snapshot);
  const mach = r.mach ?? revision?.mach ?? setup?.mach;
  if (!finiteStored(mach) || mach < 0) return null;
  const snapshotMesh =
    setup?.mesh &&
    typeof setup.mesh.mesher === "string" &&
    setup.mesh.mesher.trim() &&
    finiteStored(setup.mesh.farfieldRadiusChords) &&
    finiteStored(setup.mesh.wakeLengthChords) &&
    finiteStored(setup.mesh.nSurface) &&
    finiteStored(setup.mesh.nRadial) &&
    finiteStored(setup.mesh.nWake) &&
    finiteStored(setup.mesh.targetYPlus) &&
    finiteStored(setup.mesh.spanChords)
      ? {
          mesher: setup.mesh.mesher,
          farfieldRadiusChords: setup.mesh.farfieldRadiusChords,
          wakeLengthChords: setup.mesh.wakeLengthChords,
          nSurface: setup.mesh.nSurface,
          nRadial: setup.mesh.nRadial,
          nWake: setup.mesh.nWake,
          targetYPlus: setup.mesh.targetYPlus,
          spanChords: setup.mesh.spanChords,
          nCells: r.nCells,
          yPlusAvg: r.yPlusAvg,
          yPlusMax: r.yPlusMax,
          iterations: r.iterations,
          finalResidual: r.finalResidual,
        }
      : null;
  const snapshotCondition =
    snapshot &&
    setup &&
    typeof setup.mediumName === "string" &&
    setup.mediumName.trim() &&
    finiteStored(setup.speedMps) &&
    setup.speedMps >= 0 &&
    finiteStored(setup.referenceChordM) &&
    setup.referenceChordM > 0 &&
    finiteStored(setup.temperatureK) &&
    setup.temperatureK > 0 &&
    finiteStored(setup.pressurePa) &&
    setup.pressurePa > 0
      ? {
          boundaryConditionName: snapshot.preset.name,
          mediumName: setup.mediumName,
          speedMps: setup.speedMps,
          referenceChordM: setup.referenceChordM,
          temperatureK: setup.temperatureK,
          pressurePa: setup.pressurePa,
          density: setup.density,
          dynamicViscosity: setup.dynamicViscosity,
          kinematicViscosity: setup.kinematicViscosity,
          turbulenceModel: snapshot.solver.turbulenceModel,
          turbulenceIntensity: snapshot.boundary.turbulenceIntensity,
          viscosityRatio: snapshot.boundary.viscosityRatio,
          mesh: snapshotMesh,
        }
      : null;
  return {
    status: "solved",
    regime: r.unsteady ? "stalled" : "attached",
    airfoilName: name,
    alpha: r.aoaDeg,
    re,
    mach,
    cl,
    cd,
    cm: r.cm,
    ld: r.clCd ?? cl / cd,
    clStd: r.clStd,
    cdStd: r.cdStd,
    strouhal: r.strouhal,
    media: Object.keys(media).length ? media : null,
    availableFields: Object.keys(media) as FieldId[],
    evidenceArtifacts: evidenceRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      field: row.field,
      role: row.role,
      url: mediaStore.url(row.storageKey),
      downloadUrl: mediaStore.url(row.storageKey),
      mimeType: row.mimeType,
      sha256: row.sha256,
      byteSize: row.byteSize,
      metadata: row.metadata ?? {},
    })),
    history: hist ? { t: hist.t, cl: hist.cl, cd: hist.cd } : null,
    frameTrack: frameTrackDetailOf(r, frameArtifacts),
    fidelity: parsePointFidelity(r.fidelity),
    steadyHistory: steadyHistoryDetailOf(r),
    uransVerify: await uransVerifyDetailOf(r),
    review: review
      ? {
          verdict: review.verdict,
          note: review.note,
          reviewer: review.reviewer,
          at: review.createdAt.toISOString(),
        }
      : undefined,
    condition: snapshotCondition
      ? snapshotCondition
      : legacyCondition
        ? {
            boundaryConditionName: legacyCondition.bc.name,
            mediumName: legacyCondition.mediumName,
            speedMps: legacyCondition.bc.speedMps,
            referenceChordM: legacyCondition.bc.referenceChordM,
            temperatureK: legacyCondition.bc.temperatureK,
            pressurePa: legacyCondition.bc.pressurePa,
            density: legacyCondition.bc.density,
            dynamicViscosity: legacyCondition.bc.dynamicViscosity,
            kinematicViscosity: legacyCondition.bc.kinematicViscosity,
            turbulenceModel: legacyCondition.bc.turbulenceModel,
            turbulenceIntensity: legacyCondition.bc.turbulenceIntensity,
            viscosityRatio: legacyCondition.bc.viscosityRatio,
            mesh: {
              mesher: legacyCondition.bc.mesher,
              farfieldRadiusChords: legacyCondition.bc.farfieldRadiusChords,
              wakeLengthChords: legacyCondition.bc.wakeLengthChords,
              nSurface: legacyCondition.bc.nSurface,
              nRadial: legacyCondition.bc.nRadial,
              nWake: legacyCondition.bc.nWake,
              targetYPlus: legacyCondition.bc.targetYPlus,
              spanChords: legacyCondition.bc.spanChords,
              nCells: r.nCells,
              yPlusAvg: r.yPlusAvg,
              yPlusMax: r.yPlusMax,
              iterations: r.iterations,
              finalResidual: r.finalResidual,
            },
          }
        : null,
  };
}

export async function assembleSim(
  slug: string,
  re?: number,
  aoa?: number,
  resultId?: string,
): Promise<SimulationDetail | null> {
  const [a] = await db
    .select()
    .from(airfoils)
    .where(
      and(
        eq(airfoils.slug, slug),
        isNull(airfoils.archivedAt),
        isNull(airfoils.deletedAt),
      ),
    )
    .limit(1);
  if (!a) return null;

  if (resultId) {
    const [selected] = await db
      .select({ result: results, attempt: resultAttempts })
      .from(results)
      .innerJoin(
        resultAttempts,
        and(
          eq(resultAttempts.id, results.currentResultAttemptId),
          eq(resultAttempts.resultId, results.id),
        ),
      )
      .innerJoin(
        resultClassifications,
        eq(resultClassifications.resultAttemptId, resultAttempts.id),
      )
      .where(
        and(
          eq(results.id, resultId),
          eq(results.airfoilId, a.id),
          eq(resultAttempts.source, "solved"),
          eq(resultAttempts.status, "done"),
          inArray(resultClassifications.state, ["accepted", "needs_urans"]),
        ),
      )
      .limit(1);
    if (!selected) return null;
    const r = selectedResultProjection(selected.result, selected.attempt);
    const effectiveRe = r.reynolds ?? re;
    if (!finiteStored(effectiveRe) || effectiveRe <= 0) return null;
    return solvedDetail(a.name, effectiveRe, r);
  }

  if (re === undefined || aoa === undefined) return null;

  const [air] = await db
    .select({ id: mediums.id })
    .from(mediums)
    .where(eq(mediums.slug, "air"))
    .limit(1);
  if (air) {
    const presets = await db
      .select({
        revisionId: simulationPresetRevisions.id,
        reynolds: simulationPresetRevisions.reynolds,
      })
      .from(simulationPresets)
      .innerJoin(
        flowConditions,
        eq(flowConditions.id, simulationPresets.flowConditionId),
      )
      .innerJoin(
        simulationPresetRevisions,
        eq(simulationPresetRevisions.presetId, simulationPresets.id),
      )
      .where(
        and(
          eq(flowConditions.mediumId, air.id),
          eq(simulationPresets.enabled, true),
        ),
      )
      .orderBy(
        desc(simulationPresetRevisions.createdAt),
        desc(simulationPresetRevisions.revisionNumber),
      );
    const revisionIds = presets.map((preset) => preset.revisionId);
    const reByRevision = new Map(
      presets.map((preset) => [preset.revisionId, preset.reynolds]),
    );
    if (revisionIds.length) {
      const selectedRows = await db
        .select({ result: results, attempt: resultAttempts })
        .from(results)
        .innerJoin(
          resultAttempts,
          and(
            eq(resultAttempts.id, results.currentResultAttemptId),
            eq(resultAttempts.resultId, results.id),
          ),
        )
        .innerJoin(
          resultClassifications,
          eq(resultClassifications.resultAttemptId, resultAttempts.id),
        )
        .where(
          and(
            eq(results.airfoilId, a.id),
            inArray(results.simulationPresetRevisionId, revisionIds),
            // Exact-float AoA match (spec §10): results.aoaDeg is written at
            // canonical 1e-4° precision, so canonicalizing the query param
            // makes fractional campaign/refinement angles addressable instead
            // of being rounded to the nearest integer. Fractional evidence can
            // also always be opened by resultId.
            eq(results.aoaDeg, canonicalAoa(aoa)),
            eq(resultAttempts.source, "solved"),
            eq(resultAttempts.status, "done"),
            inArray(resultClassifications.state, ["accepted", "needs_urans"]),
          ),
        );
      const candidates = selectedRows
        .map(({ result, attempt }) => selectedResultProjection(result, attempt))
        .map((row) => {
          const effectiveRe =
            row.reynolds ??
            (row.simulationPresetRevisionId
              ? reByRevision.get(row.simulationPresetRevisionId)
              : null);
          return effectiveRe ? { row, effectiveRe } : null;
        })
        .filter(
          (candidate): candidate is { row: Result; effectiveRe: number } =>
            candidate !== null,
        )
        .sort(
          (left, right) =>
            Math.abs(left.effectiveRe - re) - Math.abs(right.effectiveRe - re),
        );
      const match = candidates[0];
      if (
        match &&
        Math.abs(match.effectiveRe - re) <= Math.max(1000, Math.abs(re) * 0.02)
      ) {
        return solvedDetail(a.name, match.effectiveRe, match.row);
      }
    }
  }
  return null;
}
