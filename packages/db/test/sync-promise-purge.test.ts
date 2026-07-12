import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient } from "../src/client";
import { purgeSyncSweepPromises } from "../src/sync-promise-purge";
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
  schedulingProfiles,
  simulationPresets,
  simulationPresetRevisions,
  solverProfiles,
  sweepDefinitions,
  syncRemotePromiseCancellations,
  syncSweepPromises,
} from "../src/schema";

const { db, sql } = createClient({ max: 1 });
const PREFIX = `sync-promise-purge-${process.pid}-${Date.now().toString(36)}`;
const FIXTURE = {
  category: randomUUID(),
  airfoil: randomUUID(),
  medium: randomUUID(),
  flow: randomUUID(),
  geometry: randomUUID(),
  boundaryProfile: randomUUID(),
  mesh: randomUUID(),
  solver: randomUUID(),
  scheduling: randomUUID(),
  output: randomUUID(),
  sweep: randomUUID(),
  boundaryCondition: randomUUID(),
  preset: randomUUID(),
  revision: randomUUID(),
} as const;
const createdPromiseIds: string[] = [];
const airfoilId = FIXTURE.airfoil;
const revisionId = FIXTURE.revision;

beforeAll(async () => {
  await db.insert(categories).values({
    id: FIXTURE.category,
    slug: `${PREFIX}-category`,
    name: `${PREFIX} category`,
    path: `${PREFIX}-category`,
  });
  await db.insert(airfoils).values({
    id: airfoilId,
    slug: `${PREFIX}-airfoil`,
    name: `${PREFIX} airfoil`,
    categoryId: FIXTURE.category,
    points: [
      { x: 1, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ],
  });
  await db.insert(mediums).values({
    id: FIXTURE.medium,
    slug: `${PREFIX}-medium`,
    name: `${PREFIX} medium`,
    phase: "gas",
    density: 1.225,
    viscosityModel: "constant",
    constantDynamicViscosity: 1.789e-5,
    dynamicViscosity: 1.789e-5,
    kinematicViscosity: 1.4604e-5,
  });
  await db.insert(flowConditions).values({
    id: FIXTURE.flow,
    slug: `${PREFIX}-flow`,
    name: `${PREFIX} flow`,
    mediumId: FIXTURE.medium,
    speedMps: 20,
    density: 1.225,
    dynamicViscosity: 1.789e-5,
    kinematicViscosity: 1.4604e-5,
  });
  await db.insert(referenceGeometryProfiles).values({
    id: FIXTURE.geometry,
    slug: `${PREFIX}-geometry`,
    name: `${PREFIX} geometry`,
    referenceLengthM: 1,
  });
  await db.insert(boundaryProfiles).values({
    id: FIXTURE.boundaryProfile,
    slug: `${PREFIX}-boundary`,
    name: `${PREFIX} boundary`,
  });
  await db.insert(meshProfiles).values({
    id: FIXTURE.mesh,
    slug: `${PREFIX}-mesh`,
    name: `${PREFIX} mesh`,
  });
  await db.insert(solverProfiles).values({
    id: FIXTURE.solver,
    slug: `${PREFIX}-solver`,
    name: `${PREFIX} solver`,
  });
  await db.insert(schedulingProfiles).values({
    id: FIXTURE.scheduling,
    slug: `${PREFIX}-scheduling`,
    name: `${PREFIX} scheduling`,
  });
  await db.insert(outputProfiles).values({
    id: FIXTURE.output,
    slug: `${PREFIX}-output`,
    name: `${PREFIX} output`,
  });
  await db.insert(sweepDefinitions).values({
    id: FIXTURE.sweep,
    slug: `${PREFIX}-sweep`,
    name: `${PREFIX} sweep`,
    aoaList: [0],
  });
  await db.insert(boundaryConditions).values({
    id: FIXTURE.boundaryCondition,
    slug: `${PREFIX}-legacy-condition`,
    name: `${PREFIX} legacy condition`,
    mediumId: FIXTURE.medium,
    reynolds: 1_369_491,
  });
  await db.insert(simulationPresets).values({
    id: FIXTURE.preset,
    slug: `${PREFIX}-preset`,
    name: `${PREFIX} preset`,
    flowConditionId: FIXTURE.flow,
    referenceGeometryProfileId: FIXTURE.geometry,
    boundaryProfileId: FIXTURE.boundaryProfile,
    meshProfileId: FIXTURE.mesh,
    solverProfileId: FIXTURE.solver,
    schedulingProfileId: FIXTURE.scheduling,
    outputProfileId: FIXTURE.output,
    sweepDefinitionId: FIXTURE.sweep,
    legacyBoundaryConditionId: FIXTURE.boundaryCondition,
  });
  await db.insert(simulationPresetRevisions).values({
    id: revisionId,
    presetId: FIXTURE.preset,
    revisionNumber: 1,
    signatureHash: `${PREFIX}-signature`,
    reynolds: 1_369_491,
    referenceLengthM: 1,
    snapshot: { fixture: PREFIX },
  });
});

afterAll(async () => {
  if (createdPromiseIds.length) {
    await db
      .delete(syncRemotePromiseCancellations)
      .where(
        inArray(syncRemotePromiseCancellations.promiseId, createdPromiseIds),
      );
    await db
      .update(syncSweepPromises)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(inArray(syncSweepPromises.id, createdPromiseIds));
    await db
      .delete(syncSweepPromises)
      .where(inArray(syncSweepPromises.id, createdPromiseIds));
  }
  await db
    .delete(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, revisionId));
  await db
    .delete(simulationPresets)
    .where(eq(simulationPresets.id, FIXTURE.preset));
  await db
    .delete(boundaryConditions)
    .where(eq(boundaryConditions.id, FIXTURE.boundaryCondition));
  await db.delete(flowConditions).where(eq(flowConditions.id, FIXTURE.flow));
  await db
    .delete(referenceGeometryProfiles)
    .where(eq(referenceGeometryProfiles.id, FIXTURE.geometry));
  await db
    .delete(boundaryProfiles)
    .where(eq(boundaryProfiles.id, FIXTURE.boundaryProfile));
  await db.delete(meshProfiles).where(eq(meshProfiles.id, FIXTURE.mesh));
  await db.delete(solverProfiles).where(eq(solverProfiles.id, FIXTURE.solver));
  await db
    .delete(schedulingProfiles)
    .where(eq(schedulingProfiles.id, FIXTURE.scheduling));
  await db.delete(outputProfiles).where(eq(outputProfiles.id, FIXTURE.output));
  await db
    .delete(sweepDefinitions)
    .where(eq(sweepDefinitions.id, FIXTURE.sweep));
  await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
  await db.delete(categories).where(eq(categories.id, FIXTURE.category));
  await db.delete(mediums).where(eq(mediums.id, FIXTURE.medium));
  await sql.end();
});

describe("explicit sync promise purge", () => {
  it("refuses the whole set while work is live, then purges delivered audit rows first", async () => {
    const deliveredId = randomUUID();
    const pendingId = randomUUID();
    const activeId = randomUUID();
    createdPromiseIds.push(deliveredId, pendingId, activeId);
    await db.insert(syncSweepPromises).values([
      {
        id: deliveredId,
        status: "cancelled",
        cancelledAt: new Date(),
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaCount: 1,
        expiresAt: new Date(),
      },
      {
        id: pendingId,
        status: "cancelled",
        cancelledAt: new Date(),
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaCount: 1,
        expiresAt: new Date(),
      },
      {
        id: activeId,
        status: "active",
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    await db.insert(syncRemotePromiseCancellations).values([
      {
        promiseId: deliveredId,
        state: "delivered",
        attemptCount: 1,
        deliveredAt: new Date(),
      },
      { promiseId: pendingId, state: "retry_wait", attemptCount: 1 },
    ]);

    expect(await purgeSyncSweepPromises(db, [deliveredId, pendingId])).toEqual({
      kind: "refused",
      activeOrExpiredPromiseIds: [],
      undeliveredCancellationPromiseIds: [pendingId],
    });
    expect(
      await db
        .select({ id: syncSweepPromises.id })
        .from(syncSweepPromises)
        .where(inArray(syncSweepPromises.id, [deliveredId, pendingId])),
    ).toHaveLength(2);
    expect(
      await db
        .select({ id: syncRemotePromiseCancellations.promiseId })
        .from(syncRemotePromiseCancellations)
        .where(
          inArray(syncRemotePromiseCancellations.promiseId, [
            deliveredId,
            pendingId,
          ]),
        ),
    ).toHaveLength(2);

    await db
      .update(syncRemotePromiseCancellations)
      .set({ state: "delivered", deliveredAt: new Date() })
      .where(eq(syncRemotePromiseCancellations.promiseId, pendingId));
    expect(await purgeSyncSweepPromises(db, [deliveredId, pendingId])).toEqual({
      kind: "purged",
      promiseIds: [deliveredId, pendingId].sort(),
    });
    expect(
      await db
        .select({ id: syncRemotePromiseCancellations.promiseId })
        .from(syncRemotePromiseCancellations)
        .where(
          inArray(syncRemotePromiseCancellations.promiseId, [
            deliveredId,
            pendingId,
          ]),
        ),
    ).toEqual([]);

    expect(await purgeSyncSweepPromises(db, [activeId])).toEqual({
      kind: "refused",
      activeOrExpiredPromiseIds: [activeId],
      undeliveredCancellationPromiseIds: [],
    });
    await db
      .update(syncSweepPromises)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(syncSweepPromises.id, activeId));
    expect(await purgeSyncSweepPromises(db, [activeId])).toEqual({
      kind: "purged",
      promiseIds: [activeId],
    });
  });
});
