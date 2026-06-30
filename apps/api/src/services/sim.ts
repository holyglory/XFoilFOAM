import { type FieldId, type FieldMedia, type SimulationDetail } from "@aerodb/core";
import {
  airfoils,
  boundaryConditions,
  flowConditions,
  forceHistory,
  fieldColorScales,
  mediums,
  type Result,
  resultMedia,
  results,
  simulationPresetRevisions,
  simulationPresets,
  solverEvidenceArtifacts,
} from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../db";
import { mediaStore } from "../media-store";

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
    referenceChordM: snapshot.referenceGeometry?.referenceLengthM ?? legacy.operating?.referenceChordM,
    temperatureK: snapshot.flowState?.temperatureK ?? legacy.operating?.temperatureK,
    pressurePa: snapshot.flowState?.pressurePa ?? legacy.operating?.pressurePa,
    density: snapshot.flowState?.density ?? legacy.operating?.density,
    dynamicViscosity: snapshot.flowState?.dynamicViscosity ?? legacy.operating?.dynamicViscosity,
    kinematicViscosity: snapshot.flowState?.kinematicViscosity ?? legacy.operating?.kinematicViscosity,
    mesh: snapshot.mesh ?? legacy.mesh,
  };
}

async function solvedDetail(name: string, re: number, r: Result): Promise<SimulationDetail | null> {
  const cl = r.cl ?? 0;
  const cd = r.cd ?? 0;
  const media: Partial<Record<FieldId, FieldMedia>> = {};
  const rows = await db.select().from(resultMedia).where(eq(resultMedia.resultId, r.id));
  const scaleIds = Array.from(new Set(rows.map((row) => row.colorScaleId).filter((id): id is string => Boolean(id))));
  const scales = scaleIds.length
    ? await db.select().from(fieldColorScales).where(inArray(fieldColorScales.id, scaleIds))
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
  const evidenceRows = await db
    .select()
    .from(solverEvidenceArtifacts)
    .where(eq(solverEvidenceArtifacts.resultId, r.id))
    .orderBy(desc(solverEvidenceArtifacts.createdAt));
  const [hist] = await db.select().from(forceHistory).where(eq(forceHistory.resultId, r.id)).limit(1);
  const [revision] = r.simulationPresetRevisionId
    ? await db.select().from(simulationPresetRevisions).where(eq(simulationPresetRevisions.id, r.simulationPresetRevisionId)).limit(1)
    : [];
  const snapshot = revision?.snapshot as unknown as SimulationSetupSnapshot | undefined;
  const [legacyCondition] = snapshot
    ? []
    : await db
        .select({ bc: boundaryConditions, mediumName: mediums.name })
        .from(boundaryConditions)
        .innerJoin(mediums, eq(boundaryConditions.mediumId, mediums.id))
        .where(eq(boundaryConditions.id, r.bcId))
        .limit(1);
  const setup = snapshotParts(snapshot);
  return {
    status: "solved",
    regime: r.unsteady ? "stalled" : "attached",
    airfoilName: name,
    alpha: r.aoaDeg,
    re,
    mach: r.mach ?? 0.1,
    cl,
    cd,
    cm: r.cm ?? 0,
    ld: r.clCd ?? (cd !== 0 ? cl / cd : 0),
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
    condition: snapshot && setup
      ? {
          boundaryConditionName: snapshot.preset.name,
          mediumName: setup.mediumName ?? "medium",
          speedMps: setup.speedMps ?? 0,
          referenceChordM: setup.referenceChordM ?? 1,
          temperatureK: setup.temperatureK ?? 288.15,
          pressurePa: setup.pressurePa ?? 101325,
          density: setup.density,
          dynamicViscosity: setup.dynamicViscosity,
          kinematicViscosity: setup.kinematicViscosity,
          turbulenceModel: snapshot.solver.turbulenceModel,
          turbulenceIntensity: snapshot.boundary.turbulenceIntensity,
          viscosityRatio: snapshot.boundary.viscosityRatio,
          mesh: setup.mesh
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
            : null,
        }
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
    .where(and(eq(airfoils.slug, slug), isNull(airfoils.archivedAt), isNull(airfoils.deletedAt)))
    .limit(1);
  if (!a) return null;

  if (resultId) {
    const [r] = await db
      .select()
      .from(results)
      .where(
        and(
          eq(results.id, resultId),
          eq(results.airfoilId, a.id),
          eq(results.source, "solved"),
          eq(results.status, "done"),
        ),
      )
      .limit(1);
    if (!r) return null;
    const effectiveRe = r.reynolds ?? re ?? 0;
    return solvedDetail(a.name, effectiveRe, r);
  }

  if (re === undefined || aoa === undefined) return null;

  const [air] = await db.select({ id: mediums.id }).from(mediums).where(eq(mediums.slug, "air")).limit(1);
  if (air) {
    const presets = await db
      .select({ revisionId: simulationPresetRevisions.id, reynolds: simulationPresetRevisions.reynolds })
      .from(simulationPresets)
      .innerJoin(flowConditions, eq(flowConditions.id, simulationPresets.flowConditionId))
      .innerJoin(simulationPresetRevisions, eq(simulationPresetRevisions.presetId, simulationPresets.id))
      .where(and(eq(flowConditions.mediumId, air.id), eq(simulationPresets.enabled, true)))
      .orderBy(desc(simulationPresetRevisions.createdAt), desc(simulationPresetRevisions.revisionNumber));
    const revisionIds = presets.map((preset) => preset.revisionId);
    const reByRevision = new Map(presets.map((preset) => [preset.revisionId, preset.reynolds]));
    if (revisionIds.length) {
      const rows = await db
        .select()
        .from(results)
        .where(
          and(
            eq(results.airfoilId, a.id),
            inArray(results.simulationPresetRevisionId, revisionIds),
            eq(results.aoaDeg, Math.round(aoa)),
            eq(results.source, "solved"),
            eq(results.status, "done"),
          ),
        );
      const candidates = rows
        .map((row) => {
          const effectiveRe = row.reynolds ?? (row.simulationPresetRevisionId ? reByRevision.get(row.simulationPresetRevisionId) : null);
          return effectiveRe ? { row, effectiveRe } : null;
        })
        .filter((candidate): candidate is { row: Result; effectiveRe: number } => candidate !== null)
        .sort((left, right) => Math.abs(left.effectiveRe - re) - Math.abs(right.effectiveRe - re));
      const match = candidates[0];
      if (match && Math.abs(match.effectiveRe - re) <= Math.max(1000, Math.abs(re) * 0.02)) {
        return solvedDetail(a.name, match.effectiveRe, match.row);
      }
    }
  }
  return null;
}
