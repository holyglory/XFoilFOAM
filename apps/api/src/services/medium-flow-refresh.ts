import {
  flowConditions,
  mediums,
  mediumViscosityTablePoints,
  simulationPresets,
  syncLegacyBoundaryConditionForPreset,
} from "@aerodb/db";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { deriveFlowState } from "./mediums";

export async function refreshPresetRevisionsForRows(rows: { id: string }[]) {
  for (const row of rows) {
    await syncLegacyBoundaryConditionForPreset(db, row.id);
    await ensureSimulationPresetRevision(db, row.id);
  }
}

export async function refreshFlowConditionsForMedium(mediumId: string) {
  const [medium] = await db
    .select()
    .from(mediums)
    .where(eq(mediums.id, mediumId));
  if (!medium) return;
  const points = await db
    .select()
    .from(mediumViscosityTablePoints)
    .where(eq(mediumViscosityTablePoints.mediumId, mediumId));
  const flows = await db
    .select()
    .from(flowConditions)
    .where(eq(flowConditions.mediumId, mediumId))
    .orderBy(asc(flowConditions.id));
  for (const flow of flows) {
    const derived = deriveFlowState(medium, flow, points);
    await db
      .update(flowConditions)
      .set({
        density: derived.density,
        dynamicViscosity: derived.dynamicViscosity,
        kinematicViscosity: derived.kinematicViscosity,
        mach: derived.mach,
      })
      .where(eq(flowConditions.id, flow.id));
    const presets = await db
      .select({ id: simulationPresets.id })
      .from(simulationPresets)
      .where(eq(simulationPresets.flowConditionId, flow.id))
      .orderBy(asc(simulationPresets.id));
    await refreshPresetRevisionsForRows(presets);
  }
}
