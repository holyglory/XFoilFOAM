import {
  progressiveCurveMetrics,
  type PolarMetricCondition,
} from "@aerodb/core";
import { sql } from "drizzle-orm";
import { analysisContentHash, type AnalysisPhysical } from "./analysis-target";
import type { DB } from "./client";

type Condition = Omit<AnalysisPhysical, "airfoilId" | "geometry">;
type CachedCurve = {
  airfoilId: string;
  targetId: string;
  modelId: string;
  kind: "prediction" | "estimate";
  alpha: number[];
  coefficients: number[][];
};

export interface ProgressiveCatalogMetric {
  ldmax: number | null;
  clmax: number;
  cdmin: number;
  polarCount: number;
  source: "prediction" | "estimate";
  condition: PolarMetricCondition;
  targetId: string;
  modelId: string;
}

export function describeCondition(physical: Condition): PolarMetricCondition {
  const {
    airfoilId: _airfoilId,
    geometry: _geometry,
    ...condition
  } = physical as AnalysisPhysical;
  return {
    key: analysisContentHash({
      version: "progressive-comparison-condition-v1",
      physical: condition,
    }),
    re: physical.derived.reynolds,
    mach: physical.derived.mach!,
    speedMps: physical.flow.speedMps,
    temperatureK: physical.flow.temperatureK,
    pressurePa: physical.flow.pressurePa,
    referenceLengthM: physical.reference.referenceLengthM,
    branch: physical.branch,
  };
}

export async function publicProgressiveConditions(
  db: DB,
): Promise<PolarMetricCondition[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT target.physical - 'airfoilId' - 'geometry' AS condition
    FROM neuralfoil_predictions prediction
    JOIN calculation_epochs epoch ON epoch.id = prediction.epoch_id AND epoch.current
    JOIN polar_analysis_targets target ON target.id = prediction.target_id
    JOIN airfoils airfoil ON airfoil.id = target.airfoil_id
    WHERE airfoil."deletedAt" IS NULL AND airfoil."archivedAt" IS NULL
      AND jsonb_array_length(prediction.payload->'alpha') >= 2
      AND EXISTS (
        SELECT 1 FROM progressive_generation_targets scope
        JOIN progressive_generations generation ON generation.id = scope.generation_id AND generation.epoch_id = epoch.id
        JOIN simulation_preset_revisions revision ON revision.id = scope.revision_id
        WHERE scope.target_id = target.id AND revision.snapshot->'flowState'->>'mediumSlug' = 'air'
      )
  `)) as unknown as Array<{ condition: Condition }>;
  return rows
    .map((row) => describeCondition(row.condition))
    .sort(
      (left, right) =>
        left.mach - right.mach ||
        left.re - right.re ||
        left.key.localeCompare(right.key),
    );
}

export async function publicProgressiveCatalog(
  db: DB,
  airfoilIds?: string[],
  selectedConditionKey?: string,
) {
  if (airfoilIds?.length === 0)
    return {
      conditions: [] as PolarMetricCondition[],
      metrics: new Map<string, ProgressiveCatalogMetric>(),
    };
  const groups = (await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (prediction.target_id)
        target.airfoil_id, prediction.target_id, prediction.id AS prediction_id,
        target.physical - 'airfoilId' - 'geometry' AS condition,
        CASE WHEN model.response#>'{estimate,curves,composite}' IS NOT NULL THEN model.id END AS model_id,
        CASE WHEN model.response#>'{estimate,curves,composite}' IS NOT NULL
          THEN model.response#>'{estimate,alpha}' ELSE prediction.payload->'alpha' END AS alpha,
        coalesce(model.response#>'{estimate,curves,composite,coefficients}',
          prediction.payload->'coefficients') AS coefficients
      FROM neuralfoil_predictions prediction
      JOIN calculation_epochs epoch ON epoch.id = prediction.epoch_id AND epoch.current
      JOIN polar_analysis_targets target ON target.id = prediction.target_id
      LEFT JOIN progressive_polar_fit_work fit ON fit.prediction_id = prediction.id AND fit.state = 'ready'
      LEFT JOIN progressive_polar_models model ON model.id = fit.model_id AND model.prediction_id = prediction.id
      WHERE ${
        airfoilIds
          ? sql`target.airfoil_id IN (${sql.join(
              airfoilIds.map((id) => sql`${id}::uuid`),
              sql`,`,
            )})`
          : sql`true`
      }
        AND EXISTS (
          SELECT 1 FROM progressive_generation_targets scope
          JOIN progressive_generations generation ON generation.id = scope.generation_id AND generation.epoch_id = epoch.id
          JOIN simulation_preset_revisions revision ON revision.id = scope.revision_id
          WHERE scope.target_id = target.id AND revision.snapshot->'flowState'->>'mediumSlug' = 'air'
        )
      ORDER BY prediction.target_id, prediction.created_at DESC, prediction.id
    )
    SELECT condition, jsonb_agg(jsonb_build_object(
      'airfoilId', airfoil_id, 'targetId', target_id,
      'modelId', coalesce(model_id, prediction_id),
      'kind', CASE WHEN model_id IS NULL THEN 'prediction' ELSE 'estimate' END,
      'alpha', alpha, 'coefficients', coefficients
    ) ORDER BY target_id) AS curves FROM latest GROUP BY condition
  `)) as unknown as Array<{ condition: Condition; curves: CachedCurve[] }>;
  const conditions: PolarMetricCondition[] = [];
  const metrics = new Map<string, ProgressiveCatalogMetric>();
  for (const group of groups) {
    const physical = group.condition;
    const condition = describeCondition(physical);
    let available = false;
    for (const curve of group.curves) {
      if (
        !Array.isArray(curve.alpha) ||
        !Array.isArray(curve.coefficients) ||
        curve.alpha.length !== curve.coefficients.length ||
        curve.coefficients.some(
          (row) => !Array.isArray(row) || row.length !== 3,
        )
      )
        continue;
      const samples = curve.alpha.map((alpha, index) => ({
        alpha,
        cl: curve.coefficients[index][0],
        cd: curve.coefficients[index][1],
        cm: curve.coefficients[index][2],
      }));
      const measured = progressiveCurveMetrics(samples);
      if (!measured) continue;
      available = true;
      if (selectedConditionKey && condition.key !== selectedConditionKey)
        continue;
      const candidate: ProgressiveCatalogMetric = {
        ldmax: measured.liftToDragMaximum,
        clmax: measured.liftMaximum,
        cdmin: measured.dragMinimum,
        polarCount: 1,
        source: curve.kind,
        condition,
        targetId: curve.targetId,
        modelId: curve.modelId,
      };
      const current = metrics.get(curve.airfoilId);
      const count = (current?.polarCount ?? 0) + 1;
      const better =
        !current ||
        (candidate.ldmax ?? -Infinity) > (current.ldmax ?? -Infinity) ||
        (candidate.ldmax === current.ldmax &&
          candidate.targetId < current.targetId);
      metrics.set(curve.airfoilId, {
        ...(better ? candidate : current),
        polarCount: count,
      });
    }
    if (available) conditions.push(condition);
  }
  conditions.sort(
    (left, right) =>
      left.mach - right.mach ||
      left.re - right.re ||
      left.key.localeCompare(right.key),
  );
  return { conditions, metrics };
}
