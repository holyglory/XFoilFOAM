import {
  canonicalAnalysisJson,
  claimProgressiveWork,
  failProgressiveWork,
  storeNeuralFoilPrediction,
  type DB,
  type ProgressiveLease,
} from "@aerodb/db";
import { EngineError, type EngineClient } from "@aerodb/engine-client";
import { sql } from "drizzle-orm";

export async function runProgressiveBaselineBatch(
  db: DB,
  engine: Pick<EngineClient, "predictNeuralFoil">,
  owner: string,
  options: { requireSweeperEnabled?: boolean } = {},
) {
  const first = await claimProgressiveWork(db, {
    owner,
    stages: [1],
    leaseSeconds: 300,
    requireSweeperEnabled: options.requireSweeperEnabled,
  });
  if (!first)
    return { claimed: 0, stored: 0, reused: 0, errors: [] as string[] };
  const leases: ProgressiveLease[] = [first];
  for (let index = 1; index < 64; index++) {
    const maximumAngles =
      32768 - leases.reduce((sum, lease) => sum + lease.angles.length, 0);
    if (maximumAngles === 0) break;
    const next = await claimProgressiveWork(db, {
      owner,
      stages: [1],
      leaseSeconds: 300,
      requireSweeperEnabled: options.requireSweeperEnabled,
      baselineGroup: {
        generationId: first.generationId,
        airfoilId: first.physical.airfoilId,
        geometry: first.physical.geometry,
        recipe: first.recipes.neuralfoil,
        maximumAngles,
      },
    });
    if (!next) break;
    leases.push(next);
  }
  const summary = {
    claimed: leases.length,
    stored: 0,
    reused: 0,
    errors: [] as string[],
  };
  const pending: ProgressiveLease[] = [];
  for (const lease of leases) {
    const [cached] = (await db.execute(sql`
      SELECT payload FROM neuralfoil_predictions WHERE epoch_id = ${lease.epochId} AND target_id = ${lease.targetId}
        AND payload->'alpha' = ${JSON.stringify(lease.angles)}::jsonb
        AND payload->'recipe' = ${canonicalAnalysisJson(lease.recipes.neuralfoil)}::jsonb
      ORDER BY created_at DESC, id LIMIT 1
    `)) as unknown as Array<{ payload: Record<string, unknown> }>;
    if (cached) {
      try {
        await storeNeuralFoilPrediction(db, lease, cached.payload);
        summary.reused++;
      } catch (error) {
        summary.errors.push(`${lease.targetId}: ${String(error)}`);
        pending.push(lease);
      }
    } else if (
      lease.physical.boundary.sandGrainHeight !== 0 ||
      lease.angles.length < 2
    ) {
      const reason =
        lease.angles.length < 2
          ? "NeuralFoil polar requires at least two requested angles"
          : "NeuralFoil does not represent the target rough wall";
      await failProgressiveWork(db, lease, reason, false);
      summary.errors.push(`${lease.targetId}: ${reason}`);
    } else pending.push(lease);
  }
  if (!pending.length) return summary;
  try {
    const response = await engine.predictNeuralFoil({
      epoch_id: first.epochId,
      lease_token: first.token,
      coordinates: first.physical.geometry,
      geometry_provenance: {
        source: "immutable-analysis-target",
        airfoil_id: first.physical.airfoilId,
        target_signatures: pending.map((lease) => lease.targetId),
      },
      recipe: first.recipes.neuralfoil,
      conditions: pending.map((lease) => ({
        target_signature: lease.targetId,
        reynolds: lease.physical.derived.reynolds,
        mach: lease.physical.derived.mach!,
        alpha: lease.angles,
        n_crit: lease.physical.transition.nCrit,
        transition_upper: lease.physical.transition.upper,
        transition_lower: lease.physical.transition.lower,
        roughness_height: lease.physical.boundary.sandGrainHeight,
      })),
    });
    if (
      response.epoch_id !== first.epochId ||
      response.lease_token !== first.token ||
      response.predictions.length !== pending.length ||
      new Set(
        response.predictions.map((prediction) => prediction.target_signature),
      ).size !== pending.length ||
      response.predictions.some(
        (prediction) =>
          !pending.some(
            (lease) => lease.targetId === prediction.target_signature,
          ),
      )
    )
      throw new Error(
        "Prediction response does not acknowledge the exact leased batch",
      );
    for (const prediction of response.predictions) {
      const lease = pending.find(
        (item) => item.targetId === prediction.target_signature,
      )!;
      await storeNeuralFoilPrediction(db, lease, prediction);
      summary.stored++;
    }
  } catch (error) {
    const retry =
      error instanceof EngineError &&
      (error.status === 502 || error.status === 503 || error.status === 504);
    for (const lease of pending) {
      try {
        await failProgressiveWork(db, lease, String(error), retry);
      } catch (failure) {
        summary.errors.push(`${lease.targetId}: ${String(failure)}`);
      }
    }
    summary.errors.push(String(error));
  }
  return summary;
}
