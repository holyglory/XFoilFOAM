import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { createClient, type DB } from "./client";
import { materializeCampaignLaunch, pauseCampaign } from "./campaigns";
import {
  airfoils,
  mediums,
  simCampaigns,
  solverExecutionPools,
  solverImplementations,
  sweeperState,
  boundaryProfiles,
  meshProfiles,
  solverProfiles,
  outputProfiles,
} from "./schema";
import { SEEDED_RUNTIME_PROFILE_SLUGS } from "../seed/runtime-profiles";
import { sourceAirModel } from "../../core/test/fixtures/source-air-model";

assert(
  process.env.DC2_COMPONENT === "solver" &&
    process.env.DC2_POSTGRES_DB_URL &&
    process.env.DATABASE_URL === process.env.DC2_POSTGRES_DB_URL,
  "Real preview solving requires its owned preview database",
);
const { db, sql } = createClient({ max: 2 });
try {
  await db.transaction(async (transaction) => {
    const db = transaction as unknown as DB;
    const [profile] = await db
      .select()
      .from(airfoils)
      .where(eq(airfoils.slug, "ag24"));
    const [medium] = await db
      .select()
      .from(mediums)
      .where(eq(mediums.slug, "air"));
    assert(profile && medium && profile.source === "selig-database");
    const name = "Local AG24 real CFD preview";
    const [existing] = await db
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.name, name));
    if (!existing) {
      const [baseline] = await db
        .select()
        .from(simCampaigns)
        .where(eq(simCampaigns.name, "Local AG24 progressive preview"));
      if (baseline && baseline.status === "active")
        await pauseCampaign(db, baseline.id);
      await db
        .update(mediums)
        .set({ gasThermodynamics: sourceAirModel() })
        .where(eq(mediums.id, medium.id));
      const [boundary] = await db
        .select()
        .from(boundaryProfiles)
        .where(
          eq(boundaryProfiles.slug, SEEDED_RUNTIME_PROFILE_SLUGS.boundary),
        );
      const [mesh] = await db
        .select()
        .from(meshProfiles)
        .where(eq(meshProfiles.slug, SEEDED_RUNTIME_PROFILE_SLUGS.mesh));
      const [solver] = await db
        .select()
        .from(solverProfiles)
        .where(eq(solverProfiles.slug, SEEDED_RUNTIME_PROFILE_SLUGS.solver));
      const [output] = await db
        .select()
        .from(outputProfiles)
        .where(eq(outputProfiles.slug, SEEDED_RUNTIME_PROFILE_SLUGS.output));
      assert(boundary && mesh && solver && output);
      await materializeCampaignLaunch(db, {
        name,
        priority: 5,
        idempotencyKey: "local-real-cfd-preview-v1",
        airfoilIds: [profile.id],
        plan: {
          mediumId: medium.id,
          ambients: [[288.15, 101325]],
          speedsMps: [30, 166],
          chordsM: [1.123457],
          spanM: 1,
          areaMode: "derived",
          excludedConditions: [],
          baseSweep: {
            fromDeg: null,
            toDeg: null,
            stepDeg: null,
            listDeg: [-2, 0, 2, 4],
          },
          objectives: {
            ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
            clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
            clMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
          },
          numerics: {
            boundaryProfileId: boundary.id,
            meshProfileId: mesh.id,
            solverProfileId: solver.id,
            outputProfileId: output.id,
          },
        },
      });
      const implementations = await db
        .select()
        .from(solverImplementations)
        .where(
          and(
            eq(solverImplementations.family, "openfoam"),
            eq(solverImplementations.distribution, "opencfd"),
            eq(solverImplementations.releaseVersion, "2606"),
            eq(solverImplementations.numericsRevision, "1"),
            eq(solverImplementations.adapterContractVersion, 1),
          ),
        );
      assert.equal(implementations.length, 1);
      const pools = await db
        .select()
        .from(solverExecutionPools)
        .where(
          eq(
            solverExecutionPools.solverImplementationId,
            implementations[0].id,
          ),
        );
      assert.equal(pools.length, 1);
      await db
        .update(solverExecutionPools)
        .set({ enabled: true, capacityLimit: 1 })
        .where(eq(solverExecutionPools.id, pools[0].id));
      await db
        .update(sweeperState)
        .set({ enabled: true, cpuSlots: 1, maxConcurrentJobs: 1 })
        .where(eq(sweeperState.id, 1));
    }
    console.log(
      JSON.stringify({
        kind: "real-cfd-preview-campaign",
        created: !existing,
        name,
      }),
    );
  });
} finally {
  await sql.end({ timeout: 5 });
}
