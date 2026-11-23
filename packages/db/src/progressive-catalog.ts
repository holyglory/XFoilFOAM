import type { PolarMetricCondition } from "@aerodb/core";
import { sql } from "drizzle-orm";
import { analysisContentHash, type AnalysisPhysical } from "./analysis-target";
import type { DB } from "./client";
import { SOURCE_GEOMETRY_POLICY_VERSION } from "./progressive-evidence-geometry";

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

function airfoilFilter(airfoilIds?: string[]) {
  return airfoilIds
    ? sql`target.airfoil_id = ANY(${sql.param(airfoilIds)}::uuid[])`
    : sql`TRUE`;
}

const useComposite = sql`model.catalog_composite_present AND model.catalog_primary_method <> 'neuralfoil'`;
const chosenMetrics = sql`CASE WHEN ${useComposite} THEN model.catalog_metrics_v1 ELSE prediction.catalog_metrics_v1 END`;
const verifiedModel = sql`
  LEFT JOIN progressive_polar_fit_work fit ON fit.prediction_id = prediction.id
  LEFT JOIN progressive_polar_geometry_verifications verification
    ON verification.model_id = CASE WHEN fit.state = 'ready' THEN fit.model_id ELSE fit.policy_refresh_model_id END
    AND verification.policy_version = ${SOURCE_GEOMETRY_POLICY_VERSION} AND verification.source_geometry_compatible
  LEFT JOIN progressive_polar_models model ON model.id = verification.model_id AND model.prediction_id = prediction.id`;
const inAirScope = sql`EXISTS (
  SELECT 1 FROM progressive_generation_targets scope
  JOIN progressive_generations generation ON generation.id = scope.generation_id AND generation.epoch_id = prediction.epoch_id
  JOIN simulation_preset_revisions revision ON revision.id = scope.revision_id
  WHERE scope.target_id = target.id AND revision.snapshot->'flowState'->>'mediumSlug' = 'air'
)`;

function latestCatalogCurves(airfoilIds?: string[], groupId?: string) {
  // A selective page/condition can use the target and prediction indexes. The
  // whole-catalog ranking shares its generation membership and model joins.
  if (!groupId && (!airfoilIds || airfoilIds.length > 1)) {
    return sql`
      WITH current_epoch AS MATERIALIZED (SELECT id FROM calculation_epochs WHERE current),
      scoped AS MATERIALIZED (
        SELECT DISTINCT scope.target_id FROM progressive_generations generation
        JOIN progressive_generation_targets scope ON scope.generation_id = generation.id
        JOIN (SELECT id FROM simulation_preset_revisions
          WHERE snapshot->'flowState'->>'mediumSlug' = 'air' ORDER BY id) revision ON revision.id = scope.revision_id
        WHERE generation.epoch_id = (SELECT id FROM current_epoch)
      ), picked AS (
        SELECT DISTINCT ON (p.target_id) target.airfoil_id,target.condition_group_id,p.target_id,p.id,p.catalog_metrics_v1
        FROM scoped JOIN neuralfoil_predictions p ON p.target_id = scoped.target_id
        JOIN polar_analysis_targets target ON target.id = p.target_id
        JOIN airfoils airfoil ON airfoil.id = target.airfoil_id
        WHERE p.epoch_id = (SELECT id FROM current_epoch) AND ${airfoilFilter(airfoilIds)}
          AND airfoil."deletedAt" IS NULL AND airfoil."archivedAt" IS NULL
        ORDER BY p.target_id,p.created_at DESC,p.id
      ), composites AS MATERIALIZED (
        SELECT fit.prediction_id,model.id,model.catalog_metrics_v1
        FROM progressive_polar_fit_work fit
        JOIN progressive_polar_models model ON model.id = CASE WHEN fit.state = 'ready' THEN fit.model_id ELSE fit.policy_refresh_model_id END
          AND model.prediction_id = fit.prediction_id
        JOIN progressive_polar_geometry_verifications verification ON verification.model_id = model.id
          AND verification.policy_version = ${SOURCE_GEOMETRY_POLICY_VERSION} AND verification.source_geometry_compatible
        WHERE ${useComposite}
      )
      SELECT picked.airfoil_id,picked.condition_group_id,picked.target_id,
        coalesce(composites.id, picked.id) AS model_id,
        CASE WHEN composites.id IS NULL THEN 'prediction' ELSE 'estimate' END AS kind,
        CASE WHEN composites.id IS NULL THEN picked.catalog_metrics_v1 ELSE composites.catalog_metrics_v1 END AS metrics
      FROM picked LEFT JOIN composites ON composites.prediction_id = picked.id
    `;
  }

  return sql`
    SELECT DISTINCT ON (prediction.target_id)
      target.airfoil_id, target.condition_group_id, prediction.target_id,
      CASE WHEN ${useComposite} THEN model.id ELSE prediction.id END AS model_id,
      CASE WHEN ${useComposite} THEN 'estimate' ELSE 'prediction' END AS kind,
      ${chosenMetrics} AS metrics
    FROM neuralfoil_predictions prediction
    JOIN calculation_epochs epoch ON epoch.id = prediction.epoch_id AND epoch.current
    JOIN polar_analysis_targets target ON target.id = prediction.target_id
    JOIN airfoils airfoil ON airfoil.id = target.airfoil_id
    ${verifiedModel}
    WHERE airfoil."deletedAt" IS NULL AND airfoil."archivedAt" IS NULL
      AND ${airfoilFilter(airfoilIds)}
      AND ${groupId ? sql`target.condition_group_id = ${groupId}` : sql`TRUE`}
      AND ${inAirScope}
    ORDER BY prediction.target_id, prediction.created_at DESC, prediction.id
  `;
}

async function catalogConditions(
  db: DB,
  airfoilIds?: string[],
): Promise<CatalogCondition[]> {
  // The descriptor comes from the smallest eligible target ID in each group.
  // Walk the target index until a current, publishable curve is found.
  const rows = (await db.execute(sql`
    WITH groups AS MATERIALIZED (
      SELECT DISTINCT target.condition_group_id FROM polar_analysis_targets target
      WHERE ${airfoilFilter(airfoilIds)}
    )
    SELECT groups.condition_group_id, physical_target.physical - 'airfoilId' - 'geometry' AS condition
    FROM groups
    JOIN LATERAL (
      SELECT target.id FROM polar_analysis_targets target
      JOIN airfoils airfoil ON airfoil.id = target.airfoil_id
      JOIN LATERAL (
        SELECT p.id, p.epoch_id, p.catalog_metrics_v1 FROM neuralfoil_predictions p
        JOIN calculation_epochs epoch ON epoch.id = p.epoch_id AND epoch.current
        WHERE p.target_id = target.id ORDER BY p.created_at DESC, p.id LIMIT 1
      ) prediction ON true
      ${verifiedModel}
      WHERE target.condition_group_id = groups.condition_group_id AND ${airfoilFilter(airfoilIds)}
        AND airfoil."deletedAt" IS NULL AND airfoil."archivedAt" IS NULL
        AND ${inAirScope} AND ${chosenMetrics} IS NOT NULL
      ORDER BY target.id LIMIT 1
    ) representative ON true
    JOIN polar_analysis_targets physical_target ON physical_target.id = representative.id
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
