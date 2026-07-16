import {
  boundaryConditions,
  boundaryProfiles,
  flowConditions,
  mediums,
  meshProfiles,
  outputProfiles,
  referenceGeometryProfiles,
  schedulingProfiles,
  simulationPresetRevisions,
  simulationPresets,
  solverImplementations,
  solverProfiles,
  sweepDefinitions,
  type DB,
} from "@aerodb/db";
import { eq } from "drizzle-orm";

export interface MinimalSolverFixture {
  bcId: string;
  revisionId: string;
  solverImplementationId: string;
  cleanup: () => Promise<void>;
}

/** Small exact setup graph for DB tests that need immutable solver identity
 * but do not launch a campaign. Values and slugs are file-unique. */
export async function createMinimalSolverFixture(
  db: DB,
  prefix: string,
): Promise<MinimalSolverFixture> {
  const [medium] = await db.select({ id: mediums.id }).from(mediums).limit(1);
  const [boundary] = await db
    .select({ id: boundaryProfiles.id })
    .from(boundaryProfiles)
    .limit(1);
  const [mesh] = await db
    .select({ id: meshProfiles.id })
    .from(meshProfiles)
    .limit(1);
  const [solver] = await db
    .select({ id: solverProfiles.id })
    .from(solverProfiles)
    .limit(1);
  const [scheduling] = await db
    .select({ id: schedulingProfiles.id })
    .from(schedulingProfiles)
    .limit(1);
  const [output] = await db
    .select({ id: outputProfiles.id })
    .from(outputProfiles)
    .limit(1);
  const [implementation] = await db
    .select({ id: solverImplementations.id })
    .from(solverImplementations)
    .orderBy(solverImplementations.key)
    .limit(1);
  if (
    !medium ||
    !boundary ||
    !mesh ||
    !solver ||
    !scheduling ||
    !output ||
    !implementation
  ) {
    throw new Error("seeded runtime profiles missing");
  }

  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${prefix}-flow`,
      name: `${prefix} flow`,
      mediumId: medium.id,
      speedMps: 19.876543,
      origin: "user",
    })
    .returning();
  const [reference] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${prefix}-reference`,
      name: `${prefix} reference`,
      referenceLengthM: 0.987654,
      origin: "user",
    })
    .returning();
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({
      slug: `${prefix}-sweep`,
      name: `${prefix} sweep`,
      aoaList: [80],
    })
    .returning();
  const [bc] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${prefix}-bc`,
      name: `${prefix} bc`,
      mediumId: medium.id,
      reynolds: 1_234_567,
      speedMps: 19.876543,
      referenceChordM: 0.987654,
    })
    .returning();
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${prefix}-preset`,
      name: `${prefix} preset`,
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
    .returning();
  const [revision] = await db
    .insert(simulationPresetRevisions)
    .values({
      presetId: preset.id,
      revisionNumber: 1,
      signatureHash: `${prefix}-signature`,
      reynolds: 1_234_567,
      mach: 0.06,
      referenceLengthM: 0.987654,
      solverImplementationId: implementation.id,
      snapshot: {
        flowState: {
          mediumId: medium.id,
          speedMps: 19.876543,
          temperatureK: 288.15,
          pressurePa: 101325,
        },
        referenceGeometry: { referenceLengthM: 0.987654 },
        boundary: {},
        mesh: {},
        solver: {},
        scheduling: {},
        output: {},
        sweep: { aoaList: [80] },
      },
    })
    .returning();

  return {
    bcId: bc.id,
    revisionId: revision.id,
    solverImplementationId: implementation.id,
    cleanup: async () => {
      await db
        .delete(simulationPresets)
        .where(eq(simulationPresets.id, preset.id));
      await db
        .delete(boundaryConditions)
        .where(eq(boundaryConditions.id, bc.id));
      await db.delete(flowConditions).where(eq(flowConditions.id, flow.id));
      await db
        .delete(referenceGeometryProfiles)
        .where(eq(referenceGeometryProfiles.id, reference.id));
      await db
        .delete(sweepDefinitions)
        .where(eq(sweepDefinitions.id, sweep.id));
    },
  };
}
