import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sourceAirModel } from "../../core/test/fixtures/source-air-model";
import { createClient, type DB } from "../src/client";
import { materializeCampaignLaunch } from "../src/campaigns";
import {
  prepareProgressiveReset,
  restoreProgressiveCampaignRequests,
  type ProgressiveResetInput,
} from "../src/prepare-progressive-reset";
import { cleanupCampaignFixtures } from "../src/test-cleanup";
import { probeCampaignCompletion } from "../src/campaign-execution";
import { SEEDED_RUNTIME_PROFILE_SLUGS } from "../seed/runtime-profiles";
import {
  airfoils,
  mediums,
  boundaryProfiles,
  meshProfiles,
  solverProfiles,
  outputProfiles,
  simCampaigns,
  simCampaignPlanRevisions,
  simCampaignConditions,
  simCampaignPoints,
  simulationPresetRevisions,
  sweeperState,
  solverExecutionPools,
} from "../src/schema";

const { db, sql: client } = createClient({ max: 2 });
const prefix = `reset-preparation-${randomUUID()}`;
let input: ProgressiveResetInput;
let originalPlan: Record<string, unknown>;
let previousSnapshot: Record<string, unknown>;
let previousRevisionId: string;

beforeAll(async () => {
  const [profile] = await db
    .select()
    .from(airfoils)
    .where(eq(airfoils.slug, "ag24"));
  const [medium] = await db
    .select()
    .from(mediums)
    .where(eq(mediums.slug, "air"));
  const [boundary] = await db
    .select()
    .from(boundaryProfiles)
    .where(eq(boundaryProfiles.slug, SEEDED_RUNTIME_PROFILE_SLUGS.boundary));
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
  const launched = await materializeCampaignLaunch(db, {
    name: prefix,
    priority: 7,
    idempotencyKey: prefix,
    airfoilIds: [profile.id],
    plan: {
      mediumId: medium.id,
      ambients: [[288.15, 101325]],
      speedsMps: [166],
      chordsM: [1.387219],
      spanM: 1,
      areaMode: "derived",
      excludedConditions: [],
      baseSweep: {
        fromDeg: null,
        toDeg: null,
        stepDeg: null,
        listDeg: [-2, 0, 2],
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
  const [campaign] = await db
    .select()
    .from(simCampaigns)
    .where(eq(simCampaigns.id, launched.campaign.id));
  const [plan] = await db
    .select()
    .from(simCampaignPlanRevisions)
    .where(eq(simCampaignPlanRevisions.id, campaign.currentPlanRevisionId!));
  const [condition] = await db
    .select()
    .from(simCampaignConditions)
    .where(eq(simCampaignConditions.campaignId, campaign.id));
  const [revision] = await db
    .select()
    .from(simulationPresetRevisions)
    .where(
      eq(simulationPresetRevisions.id, condition.simulationPresetRevisionId),
    );
  originalPlan = plan.plan;
  previousSnapshot = structuredClone(revision.snapshot);
  delete (previousSnapshot.solver as Record<string, unknown>)
    .uransPrecalcBudgetS;
  await db
    .update(simulationPresetRevisions)
    .set({ snapshot: previousSnapshot })
    .where(eq(simulationPresetRevisions.id, revision.id));
  previousRevisionId = revision.id;
  input = {
    campaignId: campaign.id,
    expectedPlanRevisionId: plan.id,
    mediumId: medium.id,
    gasThermodynamics: sourceAirModel(),
    sourceReference: "Isolated source audit reset rehearsal",
  };
  await db
    .delete(simCampaignPoints)
    .where(eq(simCampaignPoints.campaignId, campaign.id));
  await db
    .update(sweeperState)
    .set({ enabled: false })
    .where(eq(sweeperState.id, 1));
  await db.update(solverExecutionPools).set({ enabled: false });
});

afterAll(async () => {
  if (input)
    await cleanupCampaignFixtures(db, {
      campaignIds: [input.campaignId],
      presetSlugPrefix: `campaign-${prefix}`,
    });
  await client.end({ timeout: 5 });
});

it.each(["active", "attention", "completed", "paused"])(
  "restores reset requests from unchanged campaign intent while respecting %s",
  async (status) => {
    const rollback = new Error("isolated reset restoration proof");
    await expect(
      db.transaction(async (transaction) => {
        const connection = transaction as unknown as DB;
        await connection
          .update(simCampaigns)
          .set({ status })
          .where(eq(simCampaigns.id, input.campaignId));
        const [before] = await connection
          .select()
          .from(simCampaigns)
          .where(eq(simCampaigns.id, input.campaignId));
        const receipt = await restoreProgressiveCampaignRequests(
          connection,
          input,
        );
        const [after] = await connection
          .select()
          .from(simCampaigns)
          .where(eq(simCampaigns.id, input.campaignId));
        expect(receipt).toEqual({
          campaignId: input.campaignId,
          planRevisionId: input.expectedPlanRevisionId,
          points: 3,
        });
        expect(after.currentPlanRevisionId).toBe(before.currentPlanRevisionId);
        expect(after.status).toBe(status === "paused" ? "paused" : "active");
        const points = await connection
          .select()
          .from(simCampaignPoints)
          .where(eq(simCampaignPoints.campaignId, input.campaignId));
        expect(
          points
            .map((point) => point.aoaDeg)
            .sort((left, right) => left - right),
        ).toEqual([-2, 0, 2]);
        expect(
          points.every(
            (point) =>
              point.state === "requested" &&
              point.resultId === null &&
              point.revisionId === previousRevisionId,
          ),
        ).toBe(true);
        await expect(
          restoreProgressiveCampaignRequests(connection, input),
        ).rejects.toThrow("must not be overwritten");
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  },
);

it.each(["cancelled", "archived"])(
  "does not restart %s campaigns during request restoration",
  async (status) => {
    const rollback = new Error("isolated stopped campaign proof");
    await expect(
      db.transaction(async (transaction) => {
        const connection = transaction as unknown as DB;
        await connection
          .update(simCampaigns)
          .set({ status })
          .where(eq(simCampaigns.id, input.campaignId));
        await expect(
          restoreProgressiveCampaignRequests(connection, input),
        ).rejects.toThrow("cancelled or archived");
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  },
);

it.each(["active", "attention", "complete", "cancelled", "obsolete-epoch"])(
  "keeps legacy completion separate from a %s progressive generation",
  async (state) => {
    const rollback = new Error("isolated completion ownership proof");
    await expect(
      db.transaction(async (transaction) => {
        const connection = transaction as unknown as DB;
        await connection
          .update(simCampaigns)
          .set({ status: "active", completedAt: null })
          .where(eq(simCampaigns.id, input.campaignId));
        const [epoch] = await connection.execute(
          sql`SELECT id FROM calculation_epochs WHERE current`,
        );
        const obsoleteEpoch = randomUUID();
        if (state === "obsolete-epoch")
          await connection.execute(sql`
        INSERT INTO calculation_epochs(id,current,reason) VALUES(${obsoleteEpoch},false,'isolated obsolete epoch fixture')
      `);
        await connection.execute(sql`
        INSERT INTO progressive_generations(epoch_id,campaign_id,plan_revision_id,scope_key,scope_signature,status)
        VALUES(${state === "obsolete-epoch" ? obsoleteEpoch : epoch.id},${input.campaignId},
          ${input.expectedPlanRevisionId},${prefix + state},${"a".repeat(64)},${state === "obsolete-epoch" ? "active" : state})
      `);
        await probeCampaignCompletion(connection, input.campaignId);
        const [campaign] = await connection
          .select()
          .from(simCampaigns)
          .where(eq(simCampaigns.id, input.campaignId));
        expect(campaign.status).toBe(
          ["cancelled", "obsolete-epoch"].includes(state)
            ? "completed"
            : "active",
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  },
);

it("refuses changed plans, active admission and cancelled campaigns without mutation", async () => {
  await expect(
    prepareProgressiveReset(db, {
      ...input,
      expectedPlanRevisionId: randomUUID(),
    }),
  ).rejects.toThrow("plan changed");
  await db
    .update(sweeperState)
    .set({ enabled: true })
    .where(eq(sweeperState.id, 1));
  await expect(prepareProgressiveReset(db, input)).rejects.toThrow(
    "stopped admission",
  );
  await db
    .update(sweeperState)
    .set({ enabled: false })
    .where(eq(sweeperState.id, 1));
  await db
    .update(simCampaigns)
    .set({ status: "cancelled" })
    .where(eq(simCampaigns.id, input.campaignId));
  await expect(prepareProgressiveReset(db, input)).rejects.toThrow(
    "does not reactivate",
  );
  await db
    .update(simCampaigns)
    .set({ status: "paused" })
    .where(eq(simCampaigns.id, input.campaignId));
});

it("rehearses with complete rollback then restores requested points without changing campaign intent or old evidence", async () => {
  await expect(
    db.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE solver_profiles SET urans_precalc_budget_s = 14400
        WHERE id IN (SELECT preset.solver_profile_id FROM simulation_presets preset
          JOIN sim_campaign_conditions condition ON condition.preset_id = preset.id
          WHERE condition.campaign_id = ${input.campaignId})
      `);
      await prepareProgressiveReset(transaction as unknown as DB, input);
    }),
  ).rejects.toThrow("preserved solver values have changed");
  await expect(
    db.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE mesh_profiles SET n_surface = n_surface + 1
        WHERE id IN (SELECT preset.mesh_profile_id FROM simulation_presets preset
          JOIN sim_campaign_conditions condition ON condition.preset_id = preset.id
          WHERE condition.campaign_id = ${input.campaignId})
      `);
      await prepareProgressiveReset(transaction as unknown as DB, input);
    }),
  ).rejects.toThrow("preserved mesh values have changed");
  await expect(
    db.transaction(async (transaction) => {
      const receipt = await prepareProgressiveReset(
        transaction as unknown as DB,
        input,
      );
      expect(receipt).toMatchObject({ profiles: 1, conditions: 1, points: 3 });
      throw new Error("rehearsal rollback");
    }),
  ).rejects.toThrow("rehearsal rollback");
  const [unchanged] = await db
    .select()
    .from(simCampaigns)
    .where(eq(simCampaigns.id, input.campaignId));
  expect(unchanged.currentPlanRevisionId).toBe(input.expectedPlanRevisionId);
  const receipt = await prepareProgressiveReset(db, input);
  const [campaign] = await db
    .select()
    .from(simCampaigns)
    .where(eq(simCampaigns.id, input.campaignId));
  expect(campaign).toMatchObject({
    status: "paused",
    priority: 7,
    name: prefix,
  });
  const [plan] = await db
    .select()
    .from(simCampaignPlanRevisions)
    .where(eq(simCampaignPlanRevisions.id, receipt.planRevisionId));
  expect(plan.plan).toEqual(originalPlan);
  expect(plan.summary).toMatchObject({
    operation: "progressive-solver-domain-reset-v1",
    previousPlanRevisionId: input.expectedPlanRevisionId,
  });
  const [old] = await db
    .select()
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, previousRevisionId));
  expect(old.snapshot).toEqual(previousSnapshot);
  expect(receipt.revisions[0].revisionId).not.toBe(previousRevisionId);
  const points = await db
    .select()
    .from(simCampaignPoints)
    .where(
      and(
        eq(simCampaignPoints.campaignId, input.campaignId),
        sql`${simCampaignPoints.resultId} IS NULL`,
      ),
    );
  expect(
    points.map((point) => point.aoaDeg).sort((left, right) => left - right),
  ).toEqual([-2, 0, 2]);
  expect(
    points.every(
      (point) => point.revisionId === receipt.revisions[0].revisionId,
    ),
  ).toBe(true);
  await expect(
    prepareProgressiveReset(db, {
      ...input,
      expectedPlanRevisionId: receipt.planRevisionId,
    }),
  ).rejects.toThrow("must not be overwritten");
});
