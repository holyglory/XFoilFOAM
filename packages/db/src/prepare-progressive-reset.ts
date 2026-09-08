import assert from "node:assert/strict";
import { evaluateGasState, parseGasThermodynamicModel } from "@aerodb/core";
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "./client";
import {
  angleSetsFromAngles,
  campaignEnrollmentScope,
  insertCampaignPoints,
  recomputeCampaignProgress,
} from "./campaigns";
import {
  ensureSimulationPresetRevision,
  type SimulationSetupSnapshot,
} from "./simulation-setup";
import {
  flowConditions,
  mediums,
  simCampaignConditions,
  simCampaignPlanRevisions,
  simCampaigns,
  simulationPresetRevisions,
} from "./schema";

export interface ProgressiveResetInput {
  campaignId: string;
  expectedPlanRevisionId: string;
  mediumId: string;
  gasThermodynamics: unknown;
  sourceReference: string;
}

export async function prepareProgressiveReset(
  db: DB,
  input: ProgressiveResetInput,
) {
  assert(
    input.sourceReference.trim(),
    "A material source reference is required",
  );
  const model = parseGasThermodynamicModel(input.gasThermodynamics);
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(sql`
      LOCK TABLE sweeper_state, solver_execution_pools, sim_jobs, results,
        progressive_generations, neuralfoil_predictions IN SHARE ROW EXCLUSIVE MODE
    `);
    const [state] = (await connection.execute(sql`
      SELECT
        EXISTS(SELECT 1 FROM sweeper_state WHERE enabled) AS sweeper,
        EXISTS(SELECT 1 FROM solver_execution_pools WHERE enabled) AS pools,
        EXISTS(SELECT 1 FROM sim_jobs) AS jobs,
        EXISTS(SELECT 1 FROM results) AS results,
        EXISTS(SELECT 1 FROM progressive_generations) AS generations,
        EXISTS(SELECT 1 FROM neuralfoil_predictions) AS predictions
    `)) as unknown as Record<string, boolean>[];
    assert(
      Object.values(state).every((value) => value === false),
      "Reset preparation requires stopped admission and an empty solver domain",
    );
    const [campaign] = await connection
      .select()
      .from(simCampaigns)
      .where(eq(simCampaigns.id, input.campaignId))
      .for("update");
    assert(campaign, "Campaign does not exist");
    assert.equal(
      campaign.currentPlanRevisionId,
      input.expectedPlanRevisionId,
      "Campaign plan changed after reset preparation was requested",
    );
    assert(
      ["active", "paused", "attention", "completed"].includes(campaign.status),
      "Reset preparation does not reactivate stopped campaigns",
    );
    const [plan] = await connection
      .select()
      .from(simCampaignPlanRevisions)
      .where(eq(simCampaignPlanRevisions.id, input.expectedPlanRevisionId));
    assert(
      plan && plan.plan.mediumId === input.mediumId,
      "Campaign material differs",
    );
    const [existingPoints] = (await connection.execute(sql`
      SELECT count(*)::int AS count FROM sim_campaign_points WHERE campaign_id = ${campaign.id}
    `)) as unknown as Array<{ count: number }>;
    assert.equal(
      existingPoints.count,
      0,
      "Existing campaign requests must not be overwritten",
    );
    const intent = await campaignEnrollmentScope(connection, campaign.id);
    const conditions = await connection
      .select()
      .from(simCampaignConditions)
      .where(
        and(
          eq(simCampaignConditions.campaignId, campaign.id),
          eq(
            simCampaignConditions.generation,
            campaign.currentConditionGeneration,
          ),
        ),
      )
      .for("update");
    const active = conditions.filter((condition) =>
      intent.cellsByCondition.has(condition.id),
    );
    assert(active.length > 0, "Campaign has no preserved operating conditions");
    const [medium] = await connection
      .select()
      .from(mediums)
      .where(eq(mediums.id, input.mediumId))
      .for("update");
    assert(medium?.phase === "gas", "The selected material must be a gas");
    evaluateGasState(model, medium.refTemperatureK, medium.refPressurePa);
    const flows = await connection
      .select()
      .from(flowConditions)
      .where(eq(flowConditions.mediumId, medium.id))
      .for("update");
    const states = flows.map((flow) => ({
      flow,
      gas: evaluateGasState(model, flow.temperatureK, flow.pressurePa),
    }));
    await connection
      .update(mediums)
      .set({ gasThermodynamics: model })
      .where(eq(mediums.id, medium.id));
    for (const { flow, gas } of states) {
      await connection
        .update(flowConditions)
        .set({
          density: gas.density,
          dynamicViscosity: gas.dynamicViscosity,
          kinematicViscosity: gas.kinematicViscosity,
          mach: flow.speedMps / gas.speedOfSound,
        })
        .where(eq(flowConditions.id, flow.id));
    }
    const revisions: Array<{
      conditionId: string;
      previousRevisionId: string;
      revisionId: string;
    }> = [];
    for (const condition of active) {
      assert(
        flows.some((flow) => flow.id === condition.flowConditionId),
        "A campaign condition uses another material",
      );
      const resolved = await ensureSimulationPresetRevision(
        connection,
        condition.presetId,
      );
      assert(
        resolved?.snapshot.material?.gasThermodynamics,
        "Material snapshot was not resolved",
      );
      assert.equal(
        resolved.snapshot.flowState.id,
        condition.flowConditionId,
        "The preset no longer describes the preserved flow condition",
      );
      assert.equal(
        resolved.snapshot.referenceGeometry.id,
        condition.referenceGeometryProfileId,
        "The preset no longer describes the preserved reference geometry",
      );
      const [previous] = await connection
        .select()
        .from(simulationPresetRevisions)
        .where(
          eq(
            simulationPresetRevisions.id,
            condition.simulationPresetRevisionId,
          ),
        );
      assert(previous, "The preserved setup revision is missing");
      const snapshot = previous.snapshot as unknown as SimulationSetupSnapshot;
      for (const key of [
        "referenceGeometry",
        "boundary",
        "mesh",
        "uransMesh",
        "uransPrecalcMesh",
        "solver",
        "sweep",
        "scheduling",
        "output",
      ] as const)
        assert.deepEqual(
          key === "solver"
            ? {
                ...resolved.snapshot.solver,
                uransPrecalcBudgetS:
                  resolved.snapshot.solver.uransPrecalcBudgetS ?? null,
              }
            : resolved.snapshot[key],
          key === "solver"
            ? {
                ...snapshot.solver,
                uransPrecalcBudgetS:
                  snapshot.solver.uransPrecalcBudgetS ?? null,
              }
            : snapshot[key],
          `The preserved ${key} values have changed; an explicit setup replan is required`,
        );
      for (const key of ["temperatureK", "pressurePa", "speedMps"] as const)
        assert.equal(
          resolved.snapshot.flowState[key],
          snapshot.flowState[key],
          `The preserved ${key} operating condition has changed`,
        );
      revisions.push({
        conditionId: condition.id,
        previousRevisionId: condition.simulationPresetRevisionId,
        revisionId: resolved.revision.id,
      });
      await connection
        .update(simCampaignConditions)
        .set({
          simulationPresetRevisionId: resolved.revision.id,
          reynolds: resolved.revision.reynolds,
          mach: resolved.revision.mach,
        })
        .where(eq(simCampaignConditions.id, condition.id));
    }
    const [revision] = await connection
      .insert(simCampaignPlanRevisions)
      .values({
        campaignId: campaign.id,
        revisionNumber: plan.revisionNumber + 1,
        kind: "edit",
        plan: plan.plan,
        summary: {
          operation: "progressive-solver-domain-reset-v1",
          sourceReference: input.sourceReference,
          previousPlanRevisionId: plan.id,
          revisions,
        },
        createdBy: "solver-reset-maintenance",
      })
      .returning();
    await connection
      .update(simCampaigns)
      .set({ currentPlanRevisionId: revision.id })
      .where(eq(simCampaigns.id, campaign.id));
    for (const condition of active) {
      await insertCampaignPoints(
        transaction,
        campaign.id,
        revision.revisionNumber,
        angleSetsFromAngles(intent.cellsByCondition.get(condition.id)!.angles),
        { conditionIds: [condition.id] },
      );
    }
    await recomputeCampaignProgress(transaction, campaign.id);
    const [counts] = (await connection.execute(sql`
      SELECT (SELECT count(*)::int FROM sim_campaign_airfoils WHERE campaign_id = ${campaign.id}) AS profiles,
        (SELECT count(*)::int FROM sim_campaign_points WHERE campaign_id = ${campaign.id}) AS points
    `)) as unknown as Array<{ profiles: number; points: number }>;
    return {
      campaignId: campaign.id,
      planRevisionId: revision.id,
      previousPlanRevisionId: plan.id,
      conditions: active.length,
      ...counts,
      revisions,
    };
  });
}
