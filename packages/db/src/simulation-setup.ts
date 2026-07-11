import { createHash } from "node:crypto";

import { canonicalSiString } from "@aerodb/core";
import { desc, eq, type InferSelectModel } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { DB } from "./client";
import {
  boundaryProfiles,
  flowConditions,
  mediums,
  meshProfiles,
  outputProfiles,
  referenceGeometryProfiles,
  schedulingProfiles,
  simulationPresetRevisions,
  simulationPresets,
  solverProfiles,
  sweepDefinitions,
} from "./schema";

type MeshSnapshot = Omit<InferSelectModel<typeof meshProfiles>, "createdAt" | "updatedAt" | "isSeeded">;

const uransMeshProfiles = alias(meshProfiles, "urans_mesh_profiles");
const uransPrecalcMeshProfiles = alias(meshProfiles, "urans_precalc_mesh_profiles");

export interface SimulationSetupSnapshot {
  preset: {
    id: string;
    slug: string;
    name: string;
    enabled: boolean;
    legacyBoundaryConditionId: string | null;
  };
  flowState: {
    id: string;
    slug: string;
    name: string;
    mediumId: string;
    mediumSlug: string;
    mediumName: string;
    temperatureK: number;
    pressurePa: number;
    speedMps: number;
    density: number;
    dynamicViscosity: number;
    kinematicViscosity: number;
    mach: number | null;
  };
  referenceGeometry: {
    id: string;
    slug: string;
    name: string;
    geometryType: string;
    referenceLengthKind: string;
    referenceLengthM: number;
    spanM: number | null;
    referenceAreaM2: number | null;
  };
  derived: {
    reynolds: number;
    mach: number | null;
  };
  boundary: {
    id: string;
    slug: string;
    name: string;
    turbulenceIntensity: number;
    viscosityRatio: number;
    sandGrainHeight: number;
    roughnessConstant: number;
  };
  mesh: MeshSnapshot;
  uransMesh: SimulationSetupSnapshot["mesh"] | null;
  uransPrecalcMesh: SimulationSetupSnapshot["mesh"] | null;
  solver: Omit<InferSelectModel<typeof solverProfiles>, "createdAt" | "updatedAt" | "isSeeded">;
  scheduling: Omit<InferSelectModel<typeof schedulingProfiles>, "createdAt" | "updatedAt" | "isSeeded">;
  output: Omit<InferSelectModel<typeof outputProfiles>, "createdAt" | "updatedAt" | "isSeeded">;
  sweep: Omit<InferSelectModel<typeof sweepDefinitions>, "createdAt" | "updatedAt" | "isSeeded">;
}

export interface ResolvedSimulationPreset {
  revision: InferSelectModel<typeof simulationPresetRevisions>;
  snapshot: SimulationSetupSnapshot;
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function simulationSetupSignature(snapshot: SimulationSetupSnapshot): string {
  // Signature intentionally covers the whole snapshot. Adding always-present
  // uransMesh/uransPrecalcMesh null keys changes signatures; a DB reseed
  // follows this deploy.
  return createHash("md5").update(stableStringify(snapshot)).digest("hex");
}

/**
 * Physics-only hash (spec §4/§3.2): sha256 over a stable-stringified subset of
 * the snapshot so value-identical physics+numerics hash equal across presets
 * and profile rows. EXACT field list:
 *  - flowState: medium identity (mediumId, mediumSlug) + temperatureK /
 *    pressurePa / speedMps + resolved density / dynamicViscosity /
 *    kinematicViscosity
 *  - referenceGeometry: geometryType, referenceLengthKind, referenceLengthM,
 *    spanM, referenceAreaM2
 *  - boundary: turbulenceIntensity, viscosityRatio, sandGrainHeight,
 *    roughnessConstant
 *  - mesh / solver: full numeric payloads minus row identity (id/slug/name)
 *  - uransMesh / uransPrecalcMesh: same mesh payload minus identity, included
 *    only when pinned; NULL/absent preserves the historical hash byte-for-byte
 *  - derived: reynolds, mach
 * EXCLUDED: preset name/slug, sweep block, scheduling block, output block,
 * every registry-row id/slug/name, and timestamps — two profile rows with the
 * same values must produce the same hash.
 */
export function physicsHashForSnapshot(snapshot: SimulationSetupSnapshot): string {
  const { flowState, referenceGeometry, boundary, mesh, uransMesh, uransPrecalcMesh, solver, derived } = snapshot;
  const { id: _meshId, slug: _meshSlug, name: _meshName, ...meshPhysics } = mesh;
  const uransMeshPhysics = uransMesh ? meshPhysicsPayload(uransMesh) : null;
  const uransPrecalcMeshPhysics = uransPrecalcMesh ? meshPhysicsPayload(uransPrecalcMesh) : null;
  const { id: _solverId, slug: _solverSlug, name: _solverName, ...solverPhysics } = solver;
  const subset = {
    flowState: {
      mediumId: flowState.mediumId,
      mediumSlug: flowState.mediumSlug,
      temperatureK: flowState.temperatureK,
      pressurePa: flowState.pressurePa,
      speedMps: flowState.speedMps,
      density: flowState.density,
      dynamicViscosity: flowState.dynamicViscosity,
      kinematicViscosity: flowState.kinematicViscosity,
    },
    referenceGeometry: {
      geometryType: referenceGeometry.geometryType,
      referenceLengthKind: referenceGeometry.referenceLengthKind,
      referenceLengthM: referenceGeometry.referenceLengthM,
      spanM: referenceGeometry.spanM,
      referenceAreaM2: referenceGeometry.referenceAreaM2,
    },
    boundary: {
      turbulenceIntensity: boundary.turbulenceIntensity,
      viscosityRatio: boundary.viscosityRatio,
      sandGrainHeight: boundary.sandGrainHeight,
      roughnessConstant: boundary.roughnessConstant,
    },
    mesh: meshPhysics,
    ...(uransMeshPhysics ? { uransMesh: uransMeshPhysics } : {}),
    ...(uransPrecalcMeshPhysics ? { uransPrecalcMesh: uransPrecalcMeshPhysics } : {}),
    solver: solverPhysics,
    derived: { reynolds: derived.reynolds, mach: derived.mach },
  };
  return createHash("sha256").update(stableStringify(subset)).digest("hex");
}

function meshPhysicsPayload(mesh: MeshSnapshot): Omit<MeshSnapshot, "id" | "slug" | "name"> {
  const { id: _id, slug: _slug, name: _name, ...payload } = mesh;
  return payload;
}

function stripMeshProfileMeta(row: InferSelectModel<typeof meshProfiles> | null): MeshSnapshot | null {
  if (!row) return null;
  const { createdAt: _createdAt, updatedAt: _updatedAt, isSeeded: _isSeeded, ...payload } = row;
  return payload;
}

export interface FlowConditionCanonicalInput {
  mediumId: string;
  temperatureK: number;
  pressurePa: number;
  speedMps: number;
}

/** flow_conditions.canonicalKey: mediumId|T|P|speed over INPUT values only
 *  (never derived density/viscosity), at canonical SI precision (spec §4). */
export function flowConditionCanonicalKey(input: FlowConditionCanonicalInput): string {
  return [
    input.mediumId,
    canonicalSiString("temperatureK", input.temperatureK),
    canonicalSiString("pressurePa", input.pressurePa),
    canonicalSiString("speedMps", input.speedMps),
  ].join("|");
}

export interface ReferenceGeometryCanonicalInput {
  geometryType: string;
  referenceLengthKind: string;
  referenceLengthM: number;
  spanM: number | null;
  referenceAreaM2: number | null;
}

/** reference_geometry_profiles.canonicalKey: type|kind|chord|span|area over
 *  INPUT values only at canonical SI precision; absent span/area serialize as
 *  the empty segment so the key stays deterministic. */
export function referenceGeometryCanonicalKey(input: ReferenceGeometryCanonicalInput): string {
  return [
    input.geometryType,
    input.referenceLengthKind,
    canonicalSiString("chordM", input.referenceLengthM),
    input.spanM == null ? "" : canonicalSiString("spanM", input.spanM),
    input.referenceAreaM2 == null ? "" : canonicalSiString("areaM2", input.referenceAreaM2),
  ].join("|");
}

export function snapshotAoas(snapshot: SimulationSetupSnapshot): number[] {
  if (Array.isArray(snapshot.sweep.aoaList) && snapshot.sweep.aoaList.length > 0) {
    return snapshot.sweep.aoaList.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  }
  const out: number[] = [];
  const step = snapshot.sweep.aoaStep;
  if (!(Number.isFinite(step) && step > 0)) return out;
  for (let a = snapshot.sweep.aoaStart; a <= snapshot.sweep.aoaStop + step * 1e-9; a += step) {
    out.push(Math.round(a * 1_000_000) / 1_000_000);
  }
  return out;
}

export async function resolveSimulationPresetSnapshot(db: DB, presetId: string): Promise<SimulationSetupSnapshot | null> {
  const [row] = await db
    .select({
      preset: simulationPresets,
      flowState: flowConditions,
      medium: mediums,
      referenceGeometry: referenceGeometryProfiles,
      boundary: boundaryProfiles,
      mesh: meshProfiles,
      uransMesh: uransMeshProfiles,
      uransPrecalcMesh: uransPrecalcMeshProfiles,
      solver: solverProfiles,
      scheduling: schedulingProfiles,
      output: outputProfiles,
      sweep: sweepDefinitions,
    })
    .from(simulationPresets)
    .innerJoin(flowConditions, eq(flowConditions.id, simulationPresets.flowConditionId))
    .innerJoin(mediums, eq(mediums.id, flowConditions.mediumId))
    .innerJoin(referenceGeometryProfiles, eq(referenceGeometryProfiles.id, simulationPresets.referenceGeometryProfileId))
    .innerJoin(boundaryProfiles, eq(boundaryProfiles.id, simulationPresets.boundaryProfileId))
    .innerJoin(meshProfiles, eq(meshProfiles.id, simulationPresets.meshProfileId))
    .leftJoin(uransMeshProfiles, eq(uransMeshProfiles.id, simulationPresets.uransMeshProfileId))
    .leftJoin(uransPrecalcMeshProfiles, eq(uransPrecalcMeshProfiles.id, simulationPresets.uransPrecalcMeshProfileId))
    .innerJoin(solverProfiles, eq(solverProfiles.id, simulationPresets.solverProfileId))
    .innerJoin(schedulingProfiles, eq(schedulingProfiles.id, simulationPresets.schedulingProfileId))
    .innerJoin(outputProfiles, eq(outputProfiles.id, simulationPresets.outputProfileId))
    .innerJoin(sweepDefinitions, eq(sweepDefinitions.id, simulationPresets.sweepDefinitionId))
    .where(eq(simulationPresets.id, presetId))
    .limit(1);
  if (!row) return null;
  const { preset, flowState, medium, referenceGeometry, boundary, mesh, uransMesh, uransPrecalcMesh, solver, scheduling, output, sweep } = row;
  const meshPayload = stripMeshProfileMeta(mesh);
  const uransMeshPayload = stripMeshProfileMeta(uransMesh);
  const uransPrecalcMeshPayload = stripMeshProfileMeta(uransPrecalcMesh);
  const { createdAt: _solCreated, updatedAt: _solUpdated, isSeeded: _solSeeded, ...solverPayload } = solver;
  const { createdAt: _schedCreated, updatedAt: _schedUpdated, isSeeded: _schedSeeded, ...schedulingPayload } = scheduling;
  const { createdAt: _outCreated, updatedAt: _outUpdated, isSeeded: _outSeeded, ...outputPayload } = output;
  const { createdAt: _swCreated, updatedAt: _swUpdated, isSeeded: _swSeeded, ...sweepPayload } = sweep;
  return {
    preset: {
      id: preset.id,
      slug: preset.slug,
      name: preset.name,
      enabled: preset.enabled,
      legacyBoundaryConditionId: preset.legacyBoundaryConditionId,
    },
    flowState: {
      id: flowState.id,
      slug: flowState.slug,
      name: flowState.name,
      mediumId: flowState.mediumId,
      mediumSlug: medium.slug,
      mediumName: medium.name,
      temperatureK: flowState.temperatureK,
      pressurePa: flowState.pressurePa,
      speedMps: flowState.speedMps,
      density: flowState.density,
      dynamicViscosity: flowState.dynamicViscosity,
      kinematicViscosity: flowState.kinematicViscosity,
      mach: flowState.mach,
    },
    referenceGeometry: {
      id: referenceGeometry.id,
      slug: referenceGeometry.slug,
      name: referenceGeometry.name,
      geometryType: referenceGeometry.geometryType,
      referenceLengthKind: referenceGeometry.referenceLengthKind,
      referenceLengthM: referenceGeometry.referenceLengthM,
      spanM: referenceGeometry.spanM,
      referenceAreaM2: referenceGeometry.referenceAreaM2,
    },
    derived: {
      reynolds: Math.round((flowState.speedMps * referenceGeometry.referenceLengthM) / flowState.kinematicViscosity),
      mach: flowState.mach,
    },
    boundary: {
      id: boundary.id,
      slug: boundary.slug,
      name: boundary.name,
      turbulenceIntensity: boundary.turbulenceIntensity,
      viscosityRatio: boundary.viscosityRatio,
      sandGrainHeight: boundary.sandGrainHeight,
      roughnessConstant: boundary.roughnessConstant,
    },
    mesh: meshPayload!,
    uransMesh: uransMeshPayload,
    uransPrecalcMesh: uransPrecalcMeshPayload,
    solver: solverPayload,
    scheduling: schedulingPayload,
    output: outputPayload,
    sweep: sweepPayload,
  };
}

export async function ensureSimulationPresetRevision(db: DB, presetId: string): Promise<ResolvedSimulationPreset | null> {
  const snapshot = await resolveSimulationPresetSnapshot(db, presetId);
  if (!snapshot) return null;
  const signatureHash = simulationSetupSignature(snapshot);
  const physicsHash = physicsHashForSnapshot(snapshot);
  const [latest] = await db
    .select()
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.presetId, presetId))
    .orderBy(desc(simulationPresetRevisions.revisionNumber))
    .limit(1);
  if (
    latest &&
    (latest.signatureHash === signatureHash ||
      stableStringify(latest.snapshot) === stableStringify(snapshot))
  ) {
    if (!latest.physicsHash) {
      const [withPhysicsHash] = await db
        .update(simulationPresetRevisions)
        .set({ physicsHash, isCanonicalPhysics: false })
        .where(eq(simulationPresetRevisions.id, latest.id))
        .returning();
      return {
        revision: withPhysicsHash ?? { ...latest, physicsHash },
        snapshot: latest.snapshot as unknown as SimulationSetupSnapshot,
      };
    }
    return { revision: latest, snapshot: latest.snapshot as unknown as SimulationSetupSnapshot };
  }
  await db
    .insert(simulationPresetRevisions)
    .values({
      presetId,
      revisionNumber: (latest?.revisionNumber ?? 0) + 1,
      signatureHash,
      reynolds: snapshot.derived.reynolds,
      mach: snapshot.derived.mach,
      referenceLengthM: snapshot.referenceGeometry.referenceLengthM,
      snapshot: snapshot as unknown as Record<string, unknown>,
      physicsHash,
    })
    .onConflictDoNothing({ target: [simulationPresetRevisions.presetId, simulationPresetRevisions.signatureHash] });
  const [revision] = await db
    .select()
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.presetId, presetId))
    .orderBy(desc(simulationPresetRevisions.revisionNumber))
    .limit(1);
  return revision ? { revision, snapshot } : null;
}

export function snapshotFlowState(snapshot: SimulationSetupSnapshot) {
  return snapshot.flowState;
}

export function snapshotReferenceGeometry(snapshot: SimulationSetupSnapshot) {
  return snapshot.referenceGeometry;
}

export function snapshotReynolds(snapshot: SimulationSetupSnapshot): number {
  return snapshot.derived.reynolds;
}

export function snapshotReferenceLengthM(snapshot: SimulationSetupSnapshot): number {
  return snapshot.referenceGeometry.referenceLengthM;
}

export async function ensureEnabledSimulationPresetRevisions(db: DB): Promise<ResolvedSimulationPreset[]> {
  const presets = await db
    .select({ id: simulationPresets.id })
    .from(simulationPresets)
    .where(eq(simulationPresets.enabled, true));
  const resolved: ResolvedSimulationPreset[] = [];
  for (const preset of presets) {
    const row = await ensureSimulationPresetRevision(db, preset.id);
    if (row) resolved.push(row);
  }
  return resolved;
}
