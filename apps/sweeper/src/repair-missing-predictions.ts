import { randomUUID } from "node:crypto";
import {
  claimMissingPredictionRepair,
  failPredictionRepair,
  storeRepairedPrediction,
  type DB,
} from "@aerodb/db";
import { EngineError, type EngineClient } from "@aerodb/engine-client";

export async function repairMissingPredictions(
  db: DB,
  engine: Pick<EngineClient, "healthDetails" | "predictNeuralFoil">,
  campaignId: string,
  limit: number,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
    throw new Error("Prediction repair requires a limit from 1 through 256");
  const health = await engine.healthDetails({ timeoutMs: 5000 });
  if (health.status !== "ok" || health.neuralfoil_geometry_fit_version !== 2)
    throw new Error(
      "Deploy the verified retained-polyline prediction engine before retrying gaps",
    );
  const owner = `prediction-repair-${randomUUID()}`;
  const receipt = {
    claimed: 0,
    stored: 0,
    gaps: 0,
    errors: [] as Array<{ workId: string; error: string }>,
  };
  for (let index = 0; index < limit; index++) {
    const lease = await claimMissingPredictionRepair(db, campaignId, owner);
    if (!lease) break;
    receipt.claimed++;
    try {
      const response = await engine.predictNeuralFoil({
        epoch_id: lease.epochId,
        lease_token: lease.token,
        coordinates: lease.physical.geometry,
        geometry_provenance: {
          source: "immutable-analysis-target",
          airfoil_id: lease.physical.airfoilId,
          target_signatures: [lease.targetId],
          supplemental_repair_work_id: lease.workId,
        },
        recipe: lease.recipes.neuralfoil,
        conditions: [
          {
            target_signature: lease.targetId,
            reynolds: lease.physical.derived.reynolds,
            mach: lease.physical.derived.mach!,
            alpha: lease.angles,
            n_crit: lease.physical.transition.nCrit,
            transition_upper: lease.physical.transition.upper,
            transition_lower: lease.physical.transition.lower,
            roughness_height: lease.physical.boundary.sandGrainHeight,
          },
        ],
      });
      if (
        response.epoch_id !== lease.epochId ||
        response.lease_token !== lease.token ||
        response.predictions.length !== 1
      )
        throw new Error(
          "Prediction repair response changed the exact requested scope",
        );
      await storeRepairedPrediction(db, lease, response.predictions[0]);
      receipt.stored++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        error instanceof EngineError &&
        (error.status === undefined || error.status >= 500);
      await failPredictionRepair(db, lease, message, retryable);
      receipt.gaps++;
      receipt.errors.push({ workId: lease.workId, error: message });
    }
  }
  return receipt;
}
