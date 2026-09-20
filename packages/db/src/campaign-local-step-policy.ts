import { sql, type SQL } from "drizzle-orm";
import type { DB } from "./client";

export function localStepRecipeSql(recipe: SQL, smoothing: SQL): SQL {
  return sql`jsonb_set(jsonb_set(${recipe}, '{solver,localTimeStepSmoothing}', to_jsonb(${smoothing}::double precision)),
    '{recipe_id}', '"openfoam-fast-density-local-v2"'::jsonb)`;
}

export function eligibleLocalStepPolicySql(): SQL {
  return sql`work.stage=2 AND unit.recipe->>'timeCoordinate'='local_pseudo_time_iterations'
    AND unit.recipe#>>'{selection,solver}'='rhoCentralFoam'
    AND NOT EXISTS(SELECT 1 FROM progressive_cfd_recovery_plans recovery WHERE recovery.unit_id=unit.id)`;
}

export function currentLocalStepPolicySql(): SQL {
  return sql`SELECT policy.id FROM campaign_local_step_policies policy
    WHERE policy.campaign_id=generation.campaign_id AND policy.plan_revision_id=generation.plan_revision_id
      AND ${eligibleLocalStepPolicySql()}
    ORDER BY policy.sequence DESC LIMIT 1`;
}

export async function recordDefaultLocalStepPolicy(
  db: DB,
  campaignId: string,
  revisionId: string,
) {
  await db.execute(sql`
    INSERT INTO campaign_local_step_policies(campaign_id,plan_revision_id,smoothing,source)
    SELECT campaign.id, revision.id, coalesce(solver.local_time_step_smoothing, 0.2), 'default'
    FROM sim_campaigns campaign JOIN sim_campaign_plan_revisions revision ON revision.campaign_id=campaign.id
    JOIN solver_profiles solver ON solver.id=(revision.plan#>>'{numerics,solverProfileId}')::uuid
    WHERE campaign.id=${campaignId}::uuid AND revision.id=${revisionId}::uuid
      AND campaign.current_plan_revision_id=revision.id
      AND NOT EXISTS(SELECT 1 FROM campaign_local_step_policies policy
        WHERE policy.campaign_id=campaign.id AND policy.plan_revision_id=revision.id)
  `);
}

export async function inheritLocalStepPolicy(
  db: DB,
  campaignId: string,
  previousRevisionId: string,
  revisionId: string,
) {
  await db.execute(sql`
    INSERT INTO campaign_local_step_policies(campaign_id,plan_revision_id,smoothing,source)
    SELECT campaign.id, revision.id,
      CASE WHEN revision.plan#>>'{numerics,solverProfileId}' IS DISTINCT FROM prior.plan#>>'{numerics,solverProfileId}'
        THEN coalesce(solver.local_time_step_smoothing, 0.2) ELSE policy.smoothing END,
      'inherited'
    FROM sim_campaigns campaign JOIN sim_campaign_plan_revisions revision ON revision.campaign_id=campaign.id
    JOIN sim_campaign_plan_revisions prior ON prior.campaign_id=campaign.id AND prior.id=${previousRevisionId}::uuid
    JOIN solver_profiles solver ON solver.id=(revision.plan#>>'{numerics,solverProfileId}')::uuid
    JOIN LATERAL(SELECT smoothing FROM campaign_local_step_policies
      WHERE campaign_id=campaign.id AND plan_revision_id=prior.id ORDER BY sequence DESC LIMIT 1) policy ON true
    WHERE campaign.id=${campaignId}::uuid AND revision.id=${revisionId}::uuid
      AND campaign.current_plan_revision_id=revision.id
      AND NOT EXISTS(SELECT 1 FROM campaign_local_step_policies existing
        WHERE existing.campaign_id=campaign.id AND existing.plan_revision_id=revision.id)
  `);
}

export async function adoptProgressiveLocalTimeStepPolicy(
  db: DB,
  campaignId: string,
  smoothing = 0.2,
) {
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(campaignId) ||
    typeof smoothing !== "number" ||
    !Number.isFinite(smoothing) ||
    smoothing < 0 ||
    smoothing > 1
  )
    throw new Error(
      "An exact campaign UUID and finite smoothing between zero and one are required",
    );
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [campaign] = await connection.execute(sql`
      SELECT id,status,current_plan_revision_id FROM sim_campaigns WHERE id=${campaignId}::uuid FOR UPDATE
    `);
    if (
      !campaign?.current_plan_revision_id ||
      !["active", "attention", "paused", "completed"].includes(
        String(campaign.status),
      )
    )
      throw new Error("Campaign is unavailable for numerical adoption");
    const [previous] = await connection.execute(sql`
      SELECT id,smoothing FROM campaign_local_step_policies
      WHERE campaign_id=${campaignId}::uuid AND plan_revision_id=${campaign.current_plan_revision_id}
      ORDER BY sequence DESC LIMIT 1
    `);
    if (previous?.smoothing === smoothing)
      return {
        kind: "replayed" as const,
        campaignId,
        policyId: String(previous.id),
        smoothing,
      };
    const [admission] = await connection.execute(
      sql`SELECT enabled FROM sweeper_state WHERE id=1 FOR SHARE`,
    );
    if (admission?.enabled !== false)
      throw new Error("Pause new solver admissions before adopting recipes");
    const [busy] = await connection.execute(sql`
      SELECT EXISTS(SELECT 1 FROM progressive_cfd_units unit
        JOIN progressive_work work ON work.id=unit.work_id
        JOIN progressive_generations generation ON generation.id=work.generation_id
        JOIN calculation_epochs epoch ON epoch.id=generation.epoch_id AND epoch.current
        WHERE generation.campaign_id=${campaignId}::uuid
          AND generation.plan_revision_id=${campaign.current_plan_revision_id}
          AND generation.status IN ('active','attention')
          AND ${eligibleLocalStepPolicySql()}
          AND (unit.state='leased' OR EXISTS(
            SELECT 1 FROM progressive_cfd_attempts attempt
            LEFT JOIN sim_jobs job ON job.id=attempt.sim_job_id
            LEFT JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=job.id
            WHERE attempt.unit_id=unit.id AND (attempt.outcome='running'
              OR job.status IN ('pending','submitted','running','ingesting')
              OR (job.engine_job_id IS NOT NULL AND (stopped.engine_job_id IS DISTINCT FROM job.engine_job_id
                OR stopped.epoch_id IS DISTINCT FROM generation.epoch_id)))))) AS present
    `);
    if (busy?.present)
      throw new Error(
        "Affected solver attempts must be physically stopped and settled before adoption",
      );
    const [policy] = await connection.execute(sql`
      INSERT INTO campaign_local_step_policies(campaign_id,plan_revision_id,smoothing,source)
      VALUES(${campaignId}::uuid,${campaign.current_plan_revision_id},${smoothing},'adopted') RETURNING id
    `);
    return {
      kind: "adopted" as const,
      campaignId,
      policyId: String(policy.id),
      smoothing,
    };
  });
}
