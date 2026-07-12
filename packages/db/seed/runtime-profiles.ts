import {
  ALL_IMAGE_FIELDS,
  boundaryProfiles,
  meshProfiles,
  outputProfiles,
  schedulingProfiles,
  solverProfiles,
} from "../src/schema";
import type { DB } from "../src/client";

/**
 * Deterministic, production-capable setup profiles required after a full reset.
 * These values are the previously deployed baseline configuration, now owned by
 * the seed rather than by an unrecoverable pre-reset database row.
 */
export const SEEDED_RUNTIME_PROFILE_SLUGS = {
  boundary: "standard-airfoil-boundary",
  mesh: "standard-airfoil-cgrid",
  solver: "standard-airfoil-komega-sst",
  output: "standard-airfoil-fields",
  scheduling: "campaign-auto",
} as const;

export async function seedRuntimeProfiles(db: DB): Promise<void> {
  await db
    .insert(boundaryProfiles)
    .values({
      slug: SEEDED_RUNTIME_PROFILE_SLUGS.boundary,
      name: "Standard airfoil boundary",
      turbulenceIntensity: 0.001,
      viscosityRatio: 10,
      sandGrainHeight: 0,
      roughnessConstant: 0.5,
      isSeeded: true,
    })
    .onConflictDoUpdate({
      target: boundaryProfiles.slug,
      set: {
        name: "Standard airfoil boundary",
        turbulenceIntensity: 0.001,
        viscosityRatio: 10,
        sandGrainHeight: 0,
        roughnessConstant: 0.5,
        isSeeded: true,
      },
    });

  await db
    .insert(meshProfiles)
    .values({
      slug: SEEDED_RUNTIME_PROFILE_SLUGS.mesh,
      name: "Standard airfoil C-grid",
      mesher: "blockmesh-cgrid",
      farfieldRadiusChords: 15,
      wakeLengthChords: 12,
      nSurface: 130,
      nRadial: 80,
      nWake: 60,
      targetYPlus: 1,
      spanChords: 0.1,
      isSeeded: true,
    })
    .onConflictDoUpdate({
      target: meshProfiles.slug,
      set: {
        name: "Standard airfoil C-grid",
        mesher: "blockmesh-cgrid",
        farfieldRadiusChords: 15,
        wakeLengthChords: 12,
        nSurface: 130,
        nRadial: 80,
        nWake: 60,
        targetYPlus: 1,
        spanChords: 0.1,
        isSeeded: true,
      },
    });

  await db
    .insert(solverProfiles)
    .values({
      slug: SEEDED_RUNTIME_PROFILE_SLUGS.solver,
      name: "Standard k-omega SST",
      turbulenceModel: "kOmegaSST",
      nIterations: 3000,
      convergenceTolerance: 1e-5,
      momentumScheme: "linearUpwind",
      transientCycles: 10,
      transientDiscardFraction: 0.4,
      transientMaxCourant: 4,
      isSeeded: true,
    })
    .onConflictDoUpdate({
      target: solverProfiles.slug,
      set: {
        name: "Standard k-omega SST",
        turbulenceModel: "kOmegaSST",
        nIterations: 3000,
        convergenceTolerance: 1e-5,
        momentumScheme: "linearUpwind",
        transientCycles: 10,
        transientDiscardFraction: 0.4,
        transientMaxCourant: 4,
        isSeeded: true,
      },
    });

  await db
    .insert(outputProfiles)
    .values({
      slug: SEEDED_RUNTIME_PROFILE_SLUGS.output,
      name: "Standard airfoil fields",
      writeImages: [...ALL_IMAGE_FIELDS],
      imageZoomChords: 2,
      isSeeded: true,
    })
    .onConflictDoUpdate({
      target: outputProfiles.slug,
      set: {
        name: "Standard airfoil fields",
        writeImages: [...ALL_IMAGE_FIELDS],
        imageZoomChords: 2,
        isSeeded: true,
      },
    });

  await db
    .insert(schedulingProfiles)
    .values({
      slug: SEEDED_RUNTIME_PROFILE_SLUGS.scheduling,
      name: "Campaign auto scheduling",
      schedulingPolicy: "auto",
      cpuBudget: null,
      caseConcurrency: null,
      solverProcesses: null,
      isSeeded: true,
    })
    .onConflictDoUpdate({
      target: schedulingProfiles.slug,
      set: {
        name: "Campaign auto scheduling",
        schedulingPolicy: "auto",
        cpuBudget: null,
        caseConcurrency: null,
        solverProcesses: null,
        isSeeded: true,
      },
    });
}
