import type { PolarMetricCondition } from "@aerodb/core";
import { sql } from "drizzle-orm";
import { analysisContentHash, type AnalysisPhysical } from "./analysis-target";
import type { DB } from "./client";

type Condition = Omit<AnalysisPhysical, "airfoilId" | "geometry">;
type CatalogCondition = { groupId: string; condition: PolarMetricCondition };

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

function latestCatalogCurves(airfoilIds?: string[], groupId?: string) {
  return sql`
    SELECT DISTINCT ON (prediction.target_id)
      target.airfoil_id, target.condition_group_id, prediction.target_id,
      CASE WHEN model.catalog_composite_present THEN model.id ELSE prediction.id END AS model_id,
      CASE WHEN model.catalog_composite_present THEN 'estimate' ELSE 'prediction' END AS kind,
      CASE WHEN model.catalog_composite_present
        THEN model.catalog_metrics_v1 ELSE prediction.catalog_metrics_v1 END AS metrics
    FROM neuralfoil_predictions prediction
    JOIN calculation_epochs epoch ON epoch.id = prediction.epoch_id AND epoch.current
    JOIN polar_analysis_targets target ON target.id = prediction.target_id
    JOIN airfoils airfoil ON airfoil.id = target.airfoil_id
    LEFT JOIN progressive_polar_fit_work fit ON fit.prediction_id = prediction.id
    LEFT JOIN progressive_polar_models model ON model.id = CASE WHEN fit.state = 'ready'
      THEN fit.model_id ELSE fit.policy_refresh_model_id END AND model.prediction_id = prediction.id
    WHERE airfoil."deletedAt" IS NULL AND airfoil."archivedAt" IS NULL
      AND ${
        airfoilIds
          ? sql`target.airfoil_id IN (${sql.join(
              airfoilIds.map((id) => sql`${id}::uuid`),
              sql`,`,
            )})`
          : sql`true`
      }
      AND ${groupId ? sql`target.condition_group_id = ${groupId}` : sql`true`}
      AND EXISTS (
        SELECT 1 FROM progressive_generation_targets scope
        JOIN progressive_generations generation ON generation.id = scope.generation_id AND generation.epoch_id = epoch.id
        JOIN simulation_preset_revisions revision ON revision.id = scope.revision_id
        WHERE scope.target_id = target.id AND revision.snapshot->'flowState'->>'mediumSlug' = 'air'
      )
    ORDER BY prediction.target_id, prediction.created_at DESC, prediction.id
  `;
}

async function catalogConditions(
  db: DB,
  airfoilIds?: string[],
): Promise<CatalogCondition[]> {
  const rows = (await db.execute(sql`
    WITH latest AS (${latestCatalogCurves(airfoilIds)}), groups AS (
      SELECT condition_group_id, min(target_id) AS target_id
      FROM latest WHERE metrics IS NOT NULL GROUP BY condition_group_id
    )
    SELECT groups.condition_group_id, target.physical - 'airfoilId' - 'geometry' AS condition
    FROM groups JOIN polar_analysis_targets target ON target.id = groups.target_id
  `)) as unknown as Array<{ condition_group_id: string; condition: Condition }>;
  return rows
    .map((row) => ({
      groupId: row.condition_group_id,
      condition: describeCondition(row.condition),
    }))
    .sort(
      (left, right) =>
        left.condition.mach - right.condition.mach ||
        left.condition.re - right.condition.re ||
        left.condition.key.localeCompare(right.condition.key),
    );
}

export async function publicProgressiveConditions(
  db: DB,
): Promise<PolarMetricCondition[]> {
  return (await catalogConditions(db)).map((row) => row.condition);
}

export async function publicProgressiveCatalog(
  db: DB,
  airfoilIds?: string[],
  selectedConditionKey?: string,
) {
  const metrics = new Map<string, ProgressiveCatalogMetric>();
  if (airfoilIds?.length === 0)
    return { conditions: [] as PolarMetricCondition[], metrics };
  const groups = await catalogConditions(db, airfoilIds);
  const conditions = groups.map((row) => row.condition);
  const selected = groups.find(
    (row) => row.condition.key === selectedConditionKey,
  );
  if (selectedConditionKey && !selected) return { conditions, metrics };
  const byGroup = new Map(groups.map((row) => [row.groupId, row.condition]));
  const rows = (await db.execute(sql`
    WITH latest AS (${latestCatalogCurves(airfoilIds, selected?.groupId)}), ranked AS (
      SELECT *, count(*) OVER (PARTITION BY airfoil_id)::int AS polar_count,
        row_number() OVER (PARTITION BY airfoil_id
          ORDER BY (metrics->>'ldmax')::float8 DESC NULLS LAST, target_id COLLATE "C") AS rank
      FROM latest WHERE metrics IS NOT NULL
    )
    SELECT airfoil_id, target_id, model_id, kind, condition_group_id, metrics, polar_count
    FROM ranked WHERE rank = 1
  `)) as unknown as Array<{
    airfoil_id: string;
    target_id: string;
    model_id: string;
    kind: "prediction" | "estimate";
    condition_group_id: string;
    metrics: { ldmax: number | null; clmax: number; cdmin: number };
    polar_count: number;
  }>;
  for (const row of rows) {
    const condition = byGroup.get(row.condition_group_id);
    if (!condition) continue;
    metrics.set(row.airfoil_id, {
      ...row.metrics,
      polarCount: row.polar_count,
      source: row.kind,
      condition,
      targetId: row.target_id,
      modelId: row.model_id,
    });
  }
  return { conditions, metrics };
}
