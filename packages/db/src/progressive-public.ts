import {
  progressiveCurveMetrics,
  type ProgressivePolarSeries,
} from "@aerodb/core";
import type { ProgressivePolarEstimate } from "../../engine-client/src/progressive-polar";
import { sql } from "drizzle-orm";
import type { DB } from "./client";
import {
  progressiveComparisonConditionKey,
  type AnalysisPhysical,
} from "./analysis-target";

function curveWithMetrics(
  curve: Omit<ProgressivePolarSeries["curves"][number], "metrics">,
): ProgressivePolarSeries["curves"][number] {
  return { ...curve, metrics: progressiveCurveMetrics(curve.samples) };
}

export async function publicProgressivePolars(
  db: DB,
  airfoilId: string,
  revisionId?: string | null,
): Promise<ProgressivePolarSeries[]> {
  const records = (await db.execute(sql`
    SELECT DISTINCT ON (prediction.target_id) prediction.id, prediction.target_id, prediction.created_at,
      target.physical, prediction.payload, model.id AS model_id, model.created_at AS model_created_at,
      model.source_signature, model.response->'estimate' AS estimate,
      (SELECT jsonb_object_agg(attempt.id, attempt.aoa_deg)
       FROM progressive_polar_model_evidence evidence
       JOIN result_attempts attempt ON attempt.id = evidence.result_attempt_id
       WHERE evidence.model_id = model.id) AS evidence_angles
    FROM neuralfoil_predictions prediction
    JOIN calculation_epochs epoch ON epoch.id = prediction.epoch_id AND epoch.current
    JOIN polar_analysis_targets target ON target.id = prediction.target_id
    LEFT JOIN progressive_polar_fit_work fit ON fit.prediction_id = prediction.id AND fit.state = 'ready'
    LEFT JOIN progressive_polar_models model ON model.id = fit.model_id AND model.prediction_id = prediction.id
    WHERE target.airfoil_id = ${airfoilId} AND EXISTS (
      SELECT 1 FROM progressive_generation_targets scope
      JOIN progressive_generations generation ON generation.id = scope.generation_id AND generation.epoch_id = epoch.id
      JOIN simulation_preset_revisions revision ON revision.id = scope.revision_id
      WHERE scope.target_id = target.id
        AND ${revisionId ? sql`revision.id = ${revisionId}` : sql`revision.snapshot->'flowState'->>'mediumSlug' = 'air'`}
    ) ORDER BY prediction.target_id, prediction.created_at DESC, prediction.id
  `)) as unknown as Array<{
    id: string;
    target_id: string;
    created_at: Date;
    physical: AnalysisPhysical;
    model_id: string | null;
    model_created_at: Date | null;
    source_signature: string | null;
    estimate: ProgressivePolarEstimate | null;
    evidence_angles: Record<string, number> | null;
    payload: {
      alpha: number[];
      coefficients: number[][];
      model: Record<string, unknown>;
      geometry_fit: { rms_chord: number; maximum_chord: number };
    };
  }>;
  return records
    .map(
      (record): ProgressivePolarSeries => ({
        targetId: record.target_id,
        conditionKey: progressiveComparisonConditionKey(record.physical),
        modelId: record.model_id ?? record.id,
        kind: record.estimate ? "estimate" : "prediction",
        re: record.physical.derived.reynolds,
        mach: record.physical.derived.mach!,
        branch: record.physical.branch,
        updatedAt: new Date(
          record.model_created_at ?? record.created_at,
        ).toISOString(),
        curves: [
          curveWithMetrics({
            method: "neuralfoil",
            samples: record.payload.alpha.map((alpha, index) => ({
              alpha,
              cl: record.payload.coefficients[index][0],
              cd: record.payload.coefficients[index][1],
              cm: record.payload.coefficients[index][2],
            })),
          }),
          ...(record.estimate
            ? Object.entries(record.estimate.curves).map(([method, curve]) =>
                curveWithMetrics({
                  method: method as
                    | "composite"
                    | "openfoam_fast"
                    | "openfoam_precise",
                  samples: record.estimate!.alpha.map((alpha, index) => ({
                    alpha,
                    cl: curve.coefficients[index][0],
                    cd: curve.coefficients[index][1],
                    cm: curve.coefficients[index][2],
                    lower: {
                      cl: curve.lower[index][0],
                      cd: curve.lower[index][1],
                      cm: curve.lower[index][2],
                    },
                    upper: {
                      cl: curve.upper[index][0],
                      cd: curve.upper[index][1],
                      cm: curve.upper[index][2],
                    },
                  })),
                }),
              )
            : []),
        ],
        explanation: {
          calibration: record.estimate?.calibration_status ?? "unvalidated",
          modelVersions: {
            NeuralFoil: String(record.payload.model.neuralfoil),
            AeroSandbox: String(record.payload.model.aerosandbox),
            ...(record.estimate
              ? { "Polar model": record.estimate.version }
              : {}),
          },
          geometryRms: record.payload.geometry_fit.rms_chord,
          geometryMaximumError: record.payload.geometry_fit.maximum_chord,
          ...(record.estimate
            ? {
                sourceSignature: record.source_signature!,
                modelSignature: record.estimate.signature,
                contributors: record.estimate.contributors.map((row) => ({
                  observationId: row.observation_id,
                  resultId: row.result_id,
                  attemptId: row.attempt_id,
                  alpha: record.evidence_angles?.[row.attempt_id] ?? null,
                  method: row.method,
                  window: row.window ?? null,
                  numericalConvergence: row.numerical_convergence,
                  statisticalCertification: row.statistical_certification,
                })),
                exclusions: record.estimate.excluded.map((row) => ({
                  observationId: row.observation_id,
                  reason: row.reason,
                })),
              }
            : {}),
        },
      }),
    )
    .sort(
      (left, right) =>
        left.mach - right.mach ||
        left.re - right.re ||
        left.targetId.localeCompare(right.targetId),
    );
}
