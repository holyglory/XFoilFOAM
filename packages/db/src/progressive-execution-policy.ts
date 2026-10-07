import { sql, type SQL } from "drizzle-orm";
import type { DB } from "./client";

export const SUBSONIC_THROUGH_PRECISE_POLICY = "subsonic-through-precise-v1";

export function progressiveTargetMachSql(physical: SQL = sql`target.physical`) {
  return sql`CASE WHEN jsonb_typeof(${physical}->'derived'->'mach') = 'number'
    THEN (${physical}->'derived'->>'mach')::double precision ELSE NULL END`;
}

export function progressiveTargetCohortSql(physical: SQL) {
  const mach = progressiveTargetMachSql(physical);
  return sql`CASE WHEN ${mach} >= 0 AND ${mach} < 1 THEN 'low' ELSE 'high' END`;
}

export function progressiveExecutionPolicySql(generation = "generation") {
  return sql`EXISTS (SELECT 1 FROM campaign_progressive_execution_policies execution_policy
    WHERE execution_policy.campaign_id = ${sql.raw(generation)}.campaign_id
      AND execution_policy.policy = ${SUBSONIC_THROUGH_PRECISE_POLICY})`;
}

export function effectiveProgressiveStageSql(
  generation = "generation",
  targetId: SQL = sql`work.target_id`,
) {
  return sql`CASE WHEN ${progressiveExecutionPolicySql(generation)} THEN (
    SELECT cursor.stage FROM progressive_generation_cohorts cursor
    JOIN progressive_generation_cohort_targets member ON member.generation_id = cursor.generation_id AND member.cohort = cursor.cohort
    WHERE cursor.generation_id = ${sql.raw(generation)}.id AND member.target_id = ${targetId}
  ) ELSE ${sql.raw(generation)}.stage END`;
}

export function progressiveSameCohortSql(
  siblingTargetId: SQL,
  targetId: SQL = sql`work.target_id`,
  generation = "generation",
) {
  return sql`(NOT ${progressiveExecutionPolicySql(generation)} OR (
    SELECT sibling_target.cohort = cohort_target.cohort
    FROM progressive_generation_cohort_targets sibling_target, progressive_generation_cohort_targets cohort_target
    WHERE sibling_target.generation_id = ${sql.raw(generation)}.id AND sibling_target.target_id = ${siblingTargetId}
      AND cohort_target.generation_id = ${sql.raw(generation)}.id AND cohort_target.target_id = ${targetId}
  ))`;
}

export function progressiveInitialCoverageCompleteSql() {
  return progressiveCohortReadySql("initial_coverage_complete");
}

export function progressiveCohortInitializedSql() {
  return progressiveCohortReadySql("initialized");
}

function progressiveCohortReadySql(field: "initialized" | "initial_coverage_complete") {
  return sql`EXISTS (SELECT 1 FROM progressive_cohort_readiness readiness
    WHERE readiness.generation_id = generation.id AND readiness.stage = work.stage AND readiness.${sql.raw(field)}
      AND (readiness.cohort IS NULL OR EXISTS (
        SELECT 1 FROM progressive_generation_cohort_targets member
        WHERE member.generation_id = generation.id AND member.target_id = work.target_id AND member.cohort = readiness.cohort)))`;
}

export function progressiveCohortReadinessSql(
  epochId: string,
  generationFilter: SQL = sql`TRUE`,
  includeInitialized = true,
) {
  return sql`progressive_cohort_readiness AS MATERIALIZED (
    SELECT generation.id AS generation_id, active.cohort, active.stage,
      ${
        includeInitialized
          ? sql`NOT EXISTS (
        SELECT 1 FROM progressive_work sibling
        LEFT JOIN progressive_generation_cohort_targets member ON member.generation_id = sibling.generation_id AND member.target_id = sibling.target_id
        WHERE sibling.generation_id = generation.id AND sibling.stage = active.stage
          AND (active.cohort IS NULL OR member.cohort = active.cohort) AND sibling.state = 'pending'
          AND NOT EXISTS (SELECT 1 FROM progressive_cfd_units initialized WHERE initialized.work_id = sibling.id)
      ) AS initialized,`
          : sql``
      }
      NOT EXISTS (
        SELECT 1 FROM progressive_work sibling
        LEFT JOIN progressive_generation_cohort_targets member ON member.generation_id = sibling.generation_id AND member.target_id = sibling.target_id
        WHERE sibling.generation_id = generation.id AND sibling.stage = 2
          AND (active.cohort IS NULL OR member.cohort = active.cohort) AND sibling.state NOT IN ('complete', 'gap')
          AND (NOT EXISTS (SELECT 1 FROM progressive_cfd_units initial WHERE initial.work_id = sibling.id AND initial.purpose = 'initial')
            OR EXISTS (SELECT 1 FROM progressive_cfd_units initial WHERE initial.work_id = sibling.id
              AND initial.purpose = 'initial' AND initial.state NOT IN ('complete', 'gap')))
      ) AS initial_coverage_complete
    FROM progressive_generations generation JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
    LEFT JOIN campaign_progressive_execution_policies execution_policy ON execution_policy.campaign_id = campaign.id
    CROSS JOIN LATERAL (
      SELECT cursor.cohort, cursor.stage FROM progressive_generation_cohorts cursor
      WHERE cursor.generation_id = generation.id AND execution_policy.campaign_id IS NOT NULL
      UNION ALL SELECT NULL::text, generation.stage WHERE execution_policy.campaign_id IS NULL
    ) active
    WHERE generation.epoch_id = ${epochId}::uuid AND generation.status = 'active'
      AND generation.plan_revision_id = campaign.current_plan_revision_id
      AND ${generationFilter}
  )`;
}

export function progressiveLowPreciseOutstandingSql(generation = "generation") {
  return sql`EXISTS (
    SELECT 1 FROM progressive_generations low_generation
    JOIN sim_campaigns low_campaign ON low_campaign.id = low_generation.campaign_id
    JOIN progressive_generation_cohorts low_cursor ON low_cursor.generation_id = low_generation.id AND low_cursor.cohort = 'low'
    WHERE low_generation.campaign_id = ${sql.raw(generation)}.campaign_id
      AND low_generation.epoch_id = ${sql.raw(generation)}.epoch_id
      AND low_generation.plan_revision_id = low_campaign.current_plan_revision_id
      AND low_generation.status <> 'cancelled'
      AND low_cursor.status <> 'complete'
  )`;
}

export function progressiveAdmissionFrontierSql(epochId: string) {
  return sql`progressive_admission_frontier AS MATERIALIZED (
    SELECT execution_policy.campaign_id,
      NOT EXISTS (
        SELECT 1 FROM progressive_generations low_generation
        JOIN sim_campaigns low_campaign ON low_campaign.id = low_generation.campaign_id
        JOIN progressive_generation_cohorts low_cursor ON low_cursor.generation_id = low_generation.id AND low_cursor.cohort = 'low'
        WHERE low_generation.campaign_id = execution_policy.campaign_id AND low_generation.epoch_id = ${epochId}::uuid
          AND low_generation.plan_revision_id = low_campaign.current_plan_revision_id AND low_generation.status <> 'cancelled'
          AND low_cursor.status <> 'complete'
      ) AND NOT EXISTS (
        SELECT 1 FROM progressive_scope_requests request WHERE request.campaign_id = execution_policy.campaign_id
          AND (request.requested_version > request.processed_version OR request.error IS NOT NULL)
      ) AS high_allowed
    FROM campaign_progressive_execution_policies execution_policy WHERE execution_policy.policy = ${SUBSONIC_THROUGH_PRECISE_POLICY}
  )`;
}

export function progressiveCfdAdmissionSql(
  generation = "generation",
  targetId: SQL = sql`work.target_id`,
  frontier = false,
) {
  const highAllowed = frontier
    ? sql`coalesce((SELECT high_allowed FROM progressive_admission_frontier frontier WHERE frontier.campaign_id = ${sql.raw(generation)}.campaign_id), false)`
    : sql`NOT ${progressiveLowPreciseOutstandingSql(generation)} AND NOT EXISTS (
        SELECT 1 FROM progressive_scope_requests request WHERE request.campaign_id = ${sql.raw(generation)}.campaign_id
          AND (request.requested_version > request.processed_version OR request.error IS NOT NULL))`;
  return sql`(NOT ${progressiveExecutionPolicySql(generation)} OR (
    SELECT admission_target.cohort = 'low' OR (${highAllowed})
    FROM progressive_generation_cohort_targets admission_target
    WHERE admission_target.generation_id = ${sql.raw(generation)}.id AND admission_target.target_id = ${targetId}
  ))`;
}

export function progressiveCampaignActiveStageSql(campaignId: SQL, fallback: SQL) {
  return sql`CASE WHEN EXISTS (SELECT 1 FROM campaign_progressive_execution_policies policy
    WHERE policy.campaign_id = ${campaignId} AND policy.policy = ${SUBSONIC_THROUGH_PRECISE_POLICY}) THEN (
    SELECT coalesce(min(cursor.stage) FILTER (WHERE cursor.stage = 1),
      min(cursor.stage) FILTER (WHERE cursor.cohort = 'low' AND cursor.status <> 'complete'),
      min(cursor.stage) FILTER (WHERE cursor.status <> 'complete'))::int
    FROM progressive_generations generation JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id AND epoch.current
    JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
    JOIN progressive_generation_cohorts cursor ON cursor.generation_id = generation.id
    WHERE generation.campaign_id = ${campaignId} AND generation.plan_revision_id = campaign.current_plan_revision_id
      AND generation.status <> 'cancelled'
  ) ELSE ${fallback} END`;
}

export async function initializeProgressiveGenerationCohorts(db: DB, generationId: string) {
  await db.execute(sql`
    INSERT INTO progressive_generation_cohorts(generation_id, cohort)
    SELECT generation.id, ${progressiveTargetCohortSql(sql`target.physical`)}
    FROM progressive_generations generation
    JOIN progressive_generation_targets scope ON scope.generation_id = generation.id
    JOIN polar_analysis_targets target ON target.id = scope.target_id
    WHERE generation.id = ${generationId}::uuid AND ${progressiveExecutionPolicySql()}
    GROUP BY generation.id, ${progressiveTargetCohortSql(sql`target.physical`)}
    ON CONFLICT (generation_id, cohort) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO progressive_generation_cohort_targets(generation_id, target_id, cohort)
    SELECT generation.id, target.id, ${progressiveTargetCohortSql(sql`target.physical`)}
    FROM progressive_generations generation
    JOIN progressive_generation_targets scope ON scope.generation_id = generation.id
    JOIN polar_analysis_targets target ON target.id = scope.target_id
    WHERE generation.id = ${generationId}::uuid AND ${progressiveExecutionPolicySql()}
    ON CONFLICT (generation_id, target_id) DO NOTHING
  `);
}

export async function advanceProgressiveGenerationCohorts(db: DB, generationId: string) {
  const [generation] = await db.execute(sql`
    SELECT generation.id, ${progressiveExecutionPolicySql()} AS cohort_policy
    FROM progressive_generations generation WHERE generation.id = ${generationId}::uuid FOR UPDATE
  `);
  if (!generation?.cohort_policy) return false;
  const [baseline] = await db.execute(sql`
    SELECT EXISTS (SELECT 1 FROM progressive_work WHERE generation_id = ${generationId}::uuid
      AND stage = 1 AND state NOT IN ('complete', 'gap')) AS pending
  `);
  if (baseline.pending) return true;
  const cursors = await db.execute(sql`
    SELECT cohort FROM progressive_generation_cohorts WHERE generation_id = ${generationId}::uuid ORDER BY cohort FOR UPDATE
  `);
  for (const cursor of cursors) {
    const [counts] = await db.execute(sql`
      SELECT count(*) FILTER (WHERE work.stage = 2 AND work.state NOT IN ('complete', 'gap'))::int AS fast_open,
        count(*) FILTER (WHERE work.stage = 3 AND work.state NOT IN ('complete', 'gap'))::int AS precise_open,
        count(*) FILTER (WHERE work.stage = 3 AND work.state = 'gap')::int AS precise_gaps
      FROM progressive_generation_cohort_targets member
      JOIN progressive_work work ON work.generation_id = member.generation_id AND work.target_id = member.target_id
      WHERE member.generation_id = ${generationId}::uuid AND member.cohort = ${cursor.cohort}
    `);
    const stage = Number(counts.fast_open) ? 2 : 3;
    const status = stage === 2 || Number(counts.precise_open) ? "active" : Number(counts.precise_gaps) ? "attention" : "complete";
    await db.execute(sql`
      UPDATE progressive_generation_cohorts SET stage = ${stage}, status = ${status}, updated_at = clock_timestamp()
      WHERE generation_id = ${generationId}::uuid AND cohort = ${cursor.cohort}
        AND (stage, status) IS DISTINCT FROM (${stage}::smallint, ${status}::text)
    `);
  }
  await db.execute(sql`
    UPDATE progressive_generations generation SET stage = summary.stage,
      status = summary.status, completed_at = CASE WHEN summary.status = 'complete'
        THEN coalesce(generation.completed_at, clock_timestamp()) ELSE NULL END
    FROM (SELECT min(stage)::smallint AS stage,
      CASE WHEN bool_or(status = 'active') THEN 'active'
        WHEN bool_or(status = 'attention') THEN 'attention' ELSE 'complete' END AS status
      FROM progressive_generation_cohorts WHERE generation_id = ${generationId}::uuid) summary
    WHERE generation.id = ${generationId}::uuid AND generation.status <> 'cancelled'
      AND summary.stage IS NOT NULL AND (generation.stage, generation.status) IS DISTINCT FROM (summary.stage, summary.status)
  `);
  return true;
}

export async function adoptProgressiveSubsonicPriority(db: DB, campaignId: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(campaignId))
    throw new Error("Subsonic priority requires an exact campaign UUID");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await connection.execute(sql`SET LOCAL statement_timeout = '30s'`);
    const [epoch] = await connection.execute(sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`);
    const [campaign] = await connection.execute(sql`
      SELECT status, current_plan_revision_id FROM sim_campaigns WHERE id = ${campaignId}::uuid FOR UPDATE
    `);
    if (!epoch || !campaign || !["active", "attention", "paused", "completed"].includes(String(campaign.status)))
      throw new Error("Subsonic priority requires a current, non-cancelled campaign");
    const inserted = await connection.execute(sql`
      INSERT INTO campaign_progressive_execution_policies(campaign_id, policy)
      VALUES (${campaignId}::uuid, ${SUBSONIC_THROUGH_PRECISE_POLICY}) ON CONFLICT (campaign_id) DO NOTHING RETURNING campaign_id
    `);
    const [policy] = await connection.execute(sql`
      SELECT policy, adopted_at FROM campaign_progressive_execution_policies WHERE campaign_id = ${campaignId}::uuid
    `);
    const generations = await connection.execute(sql`
      SELECT id FROM progressive_generations WHERE campaign_id = ${campaignId}::uuid AND epoch_id = ${epoch.id}
        AND plan_revision_id = ${campaign.current_plan_revision_id} AND status <> 'cancelled' ORDER BY id FOR UPDATE
    `);
    if (inserted.length) {
      for (const generation of generations) {
        await initializeProgressiveGenerationCohorts(connection, String(generation.id));
        await advanceProgressiveGenerationCohorts(connection, String(generation.id));
      }
    }
    return {
      campaignId, epochId: String(epoch.id), planRevisionId: String(campaign.current_plan_revision_id),
      policy: String(policy.policy), adoptedAt: policy.adopted_at,
      generationIds: generations.map((generation) => String(generation.id)), replayed: !inserted.length,
    };
  });
}
