import { sql } from "drizzle-orm";
import {
  FAST_WALL_SPACING_POLICY,
  PRECISE_SOLVER_SELECTION_POLICY,
} from "@aerodb/core";
import type { DB } from "./client";
import {
  cancelObsoleteProgressiveCfdUnits,
  initializeProgressiveCfdWork,
} from "./progressive-cfd";
import {
  reuseAcceptedProgressiveCfdEvidence,
  reuseInformativeProgressiveCfdEvidence,
} from "./progressive-cfd-reuse";
import { materializeProgressiveCampaignScope } from "./progressive-materialization";
import { analysisContentHash } from "./analysis-target";
import { SUBSONIC_THROUGH_PRECISE_POLICY } from "./progressive-execution-policy";
import {
  advanceGeneration,
  sealProgressiveGeneration,
  type SealedPolarTarget,
  validateNeuralFoilPredictionPayload,
} from "./progressive-campaigns";

export { MAX_PROGRESSIVE_CFD_REUSE_UNITS } from "./progressive-cfd-reuse";
export { reuseAcceptedProgressiveCfdEvidence } from "./progressive-cfd-reuse";

export async function reusePreviousBaselines(
  db: DB,
  generationId: string,
  previousIds: string[],
  epochId: string,
) {
  const previous = sql.join(
    previousIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  let cursor: string | null = null;
  let reused = 0;
  for (;;) {
    const batch: Record<string, unknown>[] = await db.execute(sql`
      SELECT work.id,work.target_id,scope.angles,scope.recipes,target.physical,cached.prediction_id,cached.payload
      FROM progressive_work work JOIN progressive_generation_targets scope
        ON scope.generation_id=work.generation_id AND scope.target_id=work.target_id
      JOIN polar_analysis_targets target ON target.id=scope.target_id
      LEFT JOIN LATERAL (
        SELECT prediction.id AS prediction_id,prediction.payload FROM progressive_work prior
        JOIN progressive_prediction_links link ON link.work_id=prior.id
        JOIN neuralfoil_predictions prediction ON prediction.id=link.prediction_id
        WHERE prior.generation_id IN (${previous}) AND prior.stage=1 AND prior.target_id=work.target_id
          AND prior.state='complete' AND prediction.target_id=work.target_id AND prediction.epoch_id=${epochId}::uuid
        ORDER BY prediction.created_at DESC,prediction.id LIMIT 1
      ) cached ON true
      WHERE work.generation_id=${generationId}::uuid AND work.stage=1 AND work.state='pending'
        ${cursor ? sql`AND work.id>${cursor}::uuid` : sql``}
      ORDER BY work.id LIMIT 256
    `);
    if (!batch.length) break;
    const links: Array<{ workId: string; predictionId: string }> = [];
    for (const row of batch) {
      cursor = String(row.id);
      if (
        !row.payload ||
        analysisContentHash({ epochId, payload: row.payload }) !==
          row.prediction_id
      )
        continue;
      try {
        validateNeuralFoilPredictionPayload(
          String(row.target_id),
          {
            angles: row.angles as number[],
            recipes: row.recipes as SealedPolarTarget["recipes"],
            physical: row.physical as SealedPolarTarget["physical"],
          },
          row.payload as Record<string, unknown>,
        );
      } catch {
        continue;
      }
      links.push({
        workId: String(row.id),
        predictionId: String(row.prediction_id),
      });
    }
    if (links.length) {
      await db.execute(sql`INSERT INTO progressive_prediction_links(work_id,prediction_id)
        VALUES ${sql.join(
          links.map((link) => sql`(${link.workId}::uuid,${link.predictionId})`),
          sql`, `,
        )}`);
      await db.execute(sql`UPDATE progressive_work SET state='complete',completed_at=clock_timestamp(),error=NULL
        WHERE id IN (${sql.join(
          links.map((link) => sql`${link.workId}::uuid`),
          sql`, `,
        )})`);
      reused += links.length;
    }
  }
  await advanceGeneration(db, generationId);
  return reused;
}

export async function adoptProgressiveWallPolicy(db: DB, campaignId: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(campaignId))
    throw new Error("An exact campaign UUID is required");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    const [admission] = await connection.execute(
      sql`SELECT enabled FROM sweeper_state WHERE id=1 FOR SHARE`,
    );
    const [campaign] = await connection.execute(
      sql`SELECT id,status,current_plan_revision_id FROM sim_campaigns WHERE id=${campaignId}::uuid FOR UPDATE`,
    );
    if (!epoch || !campaign?.current_plan_revision_id)
      throw new Error("Campaign and calculation epoch must exist");
    const [receipt] = await connection.execute(sql`
      SELECT generation_id,previous_generation_ids FROM progressive_recipe_adoptions
      WHERE epoch_id=${epoch.id} AND campaign_id=${campaignId}::uuid
        AND plan_revision_id=${campaign.current_plan_revision_id} AND policy=${FAST_WALL_SPACING_POLICY}
    `);
    if (receipt) return { kind: "replayed" as const, campaignId, ...receipt };
    if (!["active", "attention"].includes(String(campaign.status)))
      throw new Error(
        "Only active preliminary campaigns may adopt a numerical policy",
      );
    if (admission?.enabled !== false)
      throw new Error("Pause new solver admissions before adopting recipes");
    const generations = await connection.execute(sql`
      SELECT id,stage FROM progressive_generations WHERE campaign_id=${campaignId}::uuid
        AND epoch_id=${epoch.id} AND plan_revision_id=${campaign.current_plan_revision_id}
        AND status IN ('active','attention') ORDER BY id FOR UPDATE
    `);
    if (!generations.length)
      return { kind: "not_required" as const, campaignId };
    const generationIds = generations.map((generation) =>
      String(generation.id),
    );
    const ids = sql.join(
      generationIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const [outdated] = await connection.execute(sql`
      SELECT EXISTS(
        SELECT 1
        FROM progressive_generation_targets scope
        JOIN polar_analysis_targets target ON target.id = scope.target_id
        WHERE scope.generation_id IN (${ids})
          AND target.mach < 1.2
          AND (
            scope.recipes#>>'{fast,wallSpacing,policy}' IS DISTINCT FROM ${FAST_WALL_SPACING_POLICY}
            OR scope.recipes#>>'{precise,wallSpacing,policy}' IS DISTINCT FROM ${FAST_WALL_SPACING_POLICY}
          )
      ) AS present
    `);
    if (!outdated?.present)
      return { kind: "not_required" as const, campaignId };
    const [busy] = await connection.execute(sql`
      SELECT EXISTS(SELECT 1 FROM progressive_cfd_attempts attempt
        JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        JOIN progressive_work work ON work.id=unit.work_id
        JOIN sim_jobs job ON job.id=attempt.sim_job_id
        LEFT JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=job.id
        WHERE work.generation_id IN (${ids}) AND (attempt.outcome='running'
          OR job.status IN ('pending','submitted','running','ingesting')
          OR (attempt.outcome = 'running' AND job.engine_job_id IS NOT NULL
            AND (stopped.engine_job_id IS DISTINCT FROM job.engine_job_id
              OR stopped.epoch_id IS DISTINCT FROM ${epoch.id}::uuid))))
        OR EXISTS(SELECT 1 FROM progressive_work WHERE generation_id IN (${ids}) AND state='leased') AS present
    `);
    if (busy?.present)
      throw new Error(
        "Old solver work must be physically stopped and settled before recipe adoption",
      );
    const profiles = await connection.execute(sql`
      SELECT DISTINCT target.airfoil_id FROM progressive_generation_targets scope
      JOIN polar_analysis_targets target ON target.id=scope.target_id
      WHERE scope.generation_id IN (${ids}) ORDER BY target.airfoil_id
    `);
    await connection.execute(
      sql`UPDATE progressive_generations SET status='cancelled' WHERE id IN (${ids})`,
    );
    await cancelObsoleteProgressiveCfdUnits(connection, campaignId);
    await connection.execute(sql`
      UPDATE progressive_work SET state='gap',completed_at=clock_timestamp(),error='superseded by explicit numerical policy adoption'
      WHERE generation_id IN (${ids}) AND state IN ('pending','leased')
    `);
    const successor = await materializeProgressiveCampaignScope(
      connection,
      campaignId,
      profiles.map((profile) => String(profile.airfoil_id)),
      `adopt-${FAST_WALL_SPACING_POLICY}`,
    );
    if (!successor)
      throw new Error("Recipe adoption has no current eligible profile scope");
    await reusePreviousBaselines(
      connection,
      successor.id,
      generationIds,
      String(epoch.id),
    );
    await initializeProgressiveCfdWork(connection, campaignId);
    let reusedCfd = 0;
    for (let pass = 0; pass < 256; pass += 1) {
      const batch = await reuseAcceptedProgressiveCfdEvidence(
        connection,
        successor.id,
        generationIds,
        String(epoch.id),
      );
      reusedCfd += batch;
      if (batch === 0) break;
    }
    await connection.execute(sql`
      INSERT INTO progressive_recipe_adoptions(epoch_id,campaign_id,plan_revision_id,policy,previous_generation_ids,generation_id)
      VALUES(${epoch.id},${campaignId}::uuid,${campaign.current_plan_revision_id},${FAST_WALL_SPACING_POLICY},ARRAY[${ids}],${successor.id})
    `);
    return {
      kind: "adopted" as const,
      campaignId,
      generation_id: successor.id,
      previous_generation_ids: generationIds,
      reused_cfd: reusedCfd,
    };
  });
}

const PRECISE_CAMPAIGN_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

type BusyCounts = {
  leasedWork: number;
  runningAttempts: number;
  unsettledExecutions: number;
  activeJobs: number;
  activeRemotePromises: number;
};

type PreciseSelectionInspection = {
  campaignId: string;
  epochId: string;
  planRevisionId: string;
  status: string;
  admissionPaused: boolean;
  receipt: { generationId: string; previousGenerationIds: string[] } | null;
  generationIds: string[];
  successorTargets: SealedPolarTarget[];
  targetCount: number;
  subsonicTargetCount: number;
  highTargetCount: number;
  affectedTargetCount: number;
  unknownPolicies: string[];
  cohortReady: boolean;
  cohortMissingGenerations: number;
  unsupportedFastCells: number;
  busy: BusyCounts;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSubsonic(target: SealedPolarTarget) {
  const derived = target.physical.derived as
    | { mach?: unknown }
    | null
    | undefined;
  return (
    typeof derived?.mach === "number" &&
    Number.isFinite(derived.mach) &&
    derived.mach >= 0 &&
    derived.mach < 1
  );
}

function readPreciseSourceTarget(
  row: Record<string, unknown>,
): SealedPolarTarget {
  if (
    !isRecord(row.recipes) ||
    !isRecord(row.recipes.neuralfoil) ||
    !isRecord(row.recipes.fast) ||
    !isRecord(row.recipes.precise) ||
    !isRecord(row.physical) ||
    !Array.isArray(row.angles)
  )
    throw new Error("Current source generation recipe metadata is invalid");
  const target = {
    airfoilId: String(row.airfoil_id),
    targetId: String(row.target_id),
    physical: row.physical as SealedPolarTarget["physical"],
    revisionId: String(row.revision_id),
    angles: row.angles as number[],
    recipes: structuredClone(row.recipes) as SealedPolarTarget["recipes"],
  };
  if (
    analysisContentHash(target.physical) !== target.targetId ||
    target.physical.airfoilId !== target.airfoilId
  )
    throw new Error("Current source generation target identity is invalid");
  return target;
}

function emptyBusyCounts(): BusyCounts {
  return {
    leasedWork: 0,
    runningAttempts: 0,
    unsettledExecutions: 0,
    activeJobs: 0,
    activeRemotePromises: 0,
  };
}

function hasBusyWork(busy: BusyCounts) {
  return Object.values(busy).some((count) => count > 0);
}

async function readPreciseBusyCounts(
  db: DB,
  campaignId: string,
  epochId: string,
  generationIds: string[],
): Promise<BusyCounts> {
  if (!generationIds.length) return emptyBusyCounts();
  const ids = sql.join(
    generationIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const [row] = await db.execute(sql`
    WITH old_work AS MATERIALIZED (
      SELECT work.id,work.state,
        EXISTS(SELECT 1 FROM progressive_cfd_units unit
          WHERE unit.work_id=work.id AND unit.state='leased') AS cfd_leased
      FROM progressive_work work
      JOIN progressive_generations generation ON generation.id=work.generation_id
      WHERE generation.id IN (${ids}) AND generation.campaign_id=${campaignId}::uuid
        AND generation.epoch_id=${epochId}::uuid
    ), old_attempts AS MATERIALIZED (
      SELECT attempt.token,attempt.outcome,attempt.sim_job_id,job.id AS job_id,
        job.status AS job_status,job.engine_job_id,job.ingest_lease_expires_at,
        stopped.sim_job_id AS stopped_sim_job_id,stopped.engine_job_id AS stopped_engine_job_id,
        stopped.epoch_id AS stopped_epoch_id,
        EXISTS(SELECT 1 FROM progressive_remote_dispatches dispatch
          JOIN sync_sweep_promises promise ON promise.id=dispatch.promise_id
          WHERE dispatch.sim_job_id=job.id AND promise.status='active') AS active_remote_promise
      FROM progressive_cfd_attempts attempt
      JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
      JOIN progressive_work work ON work.id=unit.work_id
      JOIN progressive_generations generation ON generation.id=work.generation_id
      LEFT JOIN sim_jobs job ON job.id=attempt.sim_job_id
      LEFT JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=job.id
      WHERE generation.id IN (${ids}) AND generation.campaign_id=${campaignId}::uuid
        AND generation.epoch_id=${epochId}::uuid
    )
    SELECT
      (SELECT count(*)::int FROM old_work WHERE state='leased' OR cfd_leased) AS leased_work,
      count(DISTINCT token) FILTER (WHERE outcome='running')::int AS running_attempts,
      count(DISTINCT token) FILTER (WHERE outcome='running' OR
        (sim_job_id IS NOT NULL AND (stopped_sim_job_id IS NULL
          OR stopped_engine_job_id IS DISTINCT FROM engine_job_id
          OR stopped_epoch_id IS DISTINCT FROM ${epochId}::uuid))
        OR job_status IN ('pending','submitted','running','ingesting')
        OR ingest_lease_expires_at>clock_timestamp())::int AS unsettled_executions,
      count(DISTINCT job_id) FILTER (WHERE job_status IN ('pending','submitted','running','ingesting')
        OR ingest_lease_expires_at>clock_timestamp())::int AS active_jobs,
      count(DISTINCT job_id) FILTER (WHERE active_remote_promise)::int AS active_remote_promises
    FROM old_attempts
  `);
  return {
    leasedWork: Number(row?.leased_work ?? 0),
    runningAttempts: Number(row?.running_attempts ?? 0),
    unsettledExecutions: Number(row?.unsettled_executions ?? 0),
    activeJobs: Number(row?.active_jobs ?? 0),
    activeRemotePromises: Number(row?.active_remote_promises ?? 0),
  };
}

async function readUnsupportedFastCells(db: DB, generationIds: string[]) {
  if (!generationIds.length) return 0;
  const ids = sql.join(
    generationIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const [row] = await db.execute(sql`
    SELECT count(*)::int AS count
    FROM progressive_cfd_units source_unit
    JOIN progressive_work source_work ON source_work.id=source_unit.work_id
    JOIN progressive_generations source_generation
      ON source_generation.id=source_work.generation_id
    WHERE source_work.generation_id IN (${ids}) AND source_work.stage=2
      AND source_unit.state='complete'
      AND (
        NOT EXISTS (
          SELECT 1
          FROM progressive_cfd_attempts attempt
          JOIN progressive_cfd_evidence evidence ON evidence.attempt_token=attempt.token
          JOIN result_attempts raw ON raw.id=evidence.result_attempt_id
          JOIN result_classifications classification
            ON classification.result_attempt_id=raw.id AND classification.state='accepted'
          WHERE attempt.unit_id=source_unit.id AND raw.status='done'
            AND raw.source='solved' AND raw.valid_for_polar
            AND coalesce((SELECT review.verdict FROM result_review_verdicts review
              WHERE review.result_id=raw.result_id AND review."revokedAt" IS NULL
              ORDER BY review."createdAt" DESC,review.id DESC LIMIT 1),'waive')
              NOT IN ('exclude','defer')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM progressive_cfd_evidence_reuses reuse
          JOIN progressive_cfd_evidence proof
            ON proof.attempt_token=reuse.source_attempt_token
            AND proof.result_attempt_id=reuse.source_result_attempt_id
            AND proof.evidence_signature=reuse.source_evidence_signature
          JOIN progressive_cfd_attempts source_attempt
            ON source_attempt.token=proof.attempt_token
          JOIN progressive_cfd_units source_unit_proof
            ON source_unit_proof.id=source_attempt.unit_id
          JOIN progressive_work source_work_proof
            ON source_work_proof.id=source_unit_proof.work_id
          JOIN progressive_generations source_generation_proof
            ON source_generation_proof.id=source_work_proof.generation_id
          WHERE reuse.successor_unit_id=source_unit.id
            AND reuse.source_generation_id=source_generation_proof.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM progressive_cfd_attempts informative_attempt
          JOIN progressive_cfd_evidence informative_evidence
            ON informative_evidence.attempt_token=informative_attempt.token
          JOIN result_attempts informative_raw
            ON informative_raw.id=informative_evidence.result_attempt_id
          JOIN sim_jobs informative_job
            ON informative_job.id=informative_attempt.sim_job_id
            AND informative_job.engine_job_id=informative_raw.engine_job_id
          JOIN progressive_cfd_execution_stops informative_stop
            ON informative_stop.sim_job_id=informative_job.id
            AND informative_stop.engine_job_id=informative_job.engine_job_id
            AND informative_stop.epoch_id=source_generation.epoch_id
          WHERE informative_attempt.unit_id=source_unit.id
            AND informative_job.status IN ('done','failed','cancelled')
            AND informative_job."ingestedAt" IS NOT NULL
            AND (informative_job.ingest_lease_expires_at IS NULL
              OR informative_job.ingest_lease_expires_at <= clock_timestamp())
            AND informative_raw.status IN ('done','failed')
            AND informative_raw.evidence_payload IS NOT NULL
            AND jsonb_typeof(informative_raw.evidence_payload)='object'
            AND informative_raw.cl IS NOT NULL
            AND informative_raw.cl > '-Infinity'::double precision
            AND informative_raw.cl < 'Infinity'::double precision
            AND informative_raw.cd IS NOT NULL
            AND informative_raw.cd > '-Infinity'::double precision
            AND informative_raw.cd < 'Infinity'::double precision
            AND informative_raw.cm IS NOT NULL
            AND informative_raw.cm > '-Infinity'::double precision
            AND informative_raw.cm < 'Infinity'::double precision
            AND informative_evidence.solver_active_seconds > 0
            AND informative_evidence.solver_active_seconds < 'Infinity'::double precision
            AND coalesce(informative_raw.evidence_payload->>'failure_disposition','')
              NOT IN ('infrastructure','deterministic_mesh','material_domain')
            AND NOT EXISTS (
              SELECT 1 FROM result_classifications classification
              WHERE classification.result_attempt_id=informative_raw.id
                AND classification.state='accepted'
            )
            AND coalesce((SELECT review.verdict FROM result_review_verdicts review
              WHERE review.result_id=informative_raw.result_id
                AND review."revokedAt" IS NULL
              ORDER BY review."createdAt" DESC,review.id DESC LIMIT 1),'waive')
              NOT IN ('exclude','defer')
        )
      )
  `);
  return Number(row?.count ?? 0);
}

async function inspectPreciseSelectionPolicy(
  db: DB,
  campaignId: string,
  lock: boolean,
): Promise<PreciseSelectionInspection> {
  if (!PRECISE_CAMPAIGN_UUID.test(campaignId))
    throw new Error("An exact campaign UUID is required");
  const [epoch] = await db.execute(
    sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
  );
  const [campaign] = await db.execute(sql`
    SELECT id,status,current_plan_revision_id FROM sim_campaigns
    WHERE id=${campaignId}::uuid ${lock ? sql`FOR UPDATE` : sql``}
  `);
  if (!epoch || !campaign?.current_plan_revision_id)
    throw new Error("Campaign and calculation epoch must exist");
  const epochId = String(epoch.id);
  const planRevisionId = String(campaign.current_plan_revision_id);
  const [receipt] = await db.execute(sql`
    SELECT generation_id,previous_generation_ids FROM progressive_recipe_adoptions
    WHERE epoch_id=${epochId}::uuid AND campaign_id=${campaignId}::uuid
      AND plan_revision_id=${planRevisionId}::uuid
      AND policy=${PRECISE_SOLVER_SELECTION_POLICY}
  `);
  if (receipt)
    return {
      campaignId,
      epochId,
      planRevisionId,
      status: String(campaign.status),
      admissionPaused: false,
      receipt: {
        generationId: String(receipt.generation_id),
        previousGenerationIds: (
          receipt.previous_generation_ids as string[]
        ).map(String),
      },
      generationIds: [],
      successorTargets: [],
      targetCount: 0,
      subsonicTargetCount: 0,
      highTargetCount: 0,
      affectedTargetCount: 0,
      unknownPolicies: [],
      cohortReady: true,
      cohortMissingGenerations: 0,
      unsupportedFastCells: 0,
      busy: emptyBusyCounts(),
    };
  const [admission] = await db.execute(
    sql`SELECT enabled FROM sweeper_state WHERE id=1 FOR SHARE`,
  );
  const generations = await db.execute(sql`
    SELECT id FROM progressive_generations
    WHERE campaign_id=${campaignId}::uuid AND epoch_id=${epochId}::uuid
      AND plan_revision_id=${planRevisionId}::uuid
      AND status IN ('active','attention')
    ORDER BY id ${lock ? sql`FOR UPDATE` : sql``}
  `);
  const generationIds = generations.map((generation) => String(generation.id));
  if (!generationIds.length)
    return {
      campaignId,
      epochId,
      planRevisionId,
      status: String(campaign.status),
      admissionPaused: admission?.enabled === false,
      receipt: null,
      generationIds,
      successorTargets: [],
      targetCount: 0,
      subsonicTargetCount: 0,
      highTargetCount: 0,
      affectedTargetCount: 0,
      unknownPolicies: [],
      cohortReady: false,
      cohortMissingGenerations: 0,
      unsupportedFastCells: 0,
      busy: emptyBusyCounts(),
    };
  const ids = sql.join(
    generationIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await db.execute(sql`
    SELECT scope.generation_id,scope.target_id,scope.revision_id,scope.angles,scope.recipes,
      target.airfoil_id,target.physical
    FROM progressive_generation_targets scope
    JOIN polar_analysis_targets target ON target.id=scope.target_id
    JOIN progressive_generations generation ON generation.id=scope.generation_id
    WHERE generation.id IN (${ids}) AND generation.campaign_id=${campaignId}::uuid
      AND generation.epoch_id=${epochId}::uuid
      AND generation.plan_revision_id=${planRevisionId}::uuid
  `);
  const targets = new Map<string, SealedPolarTarget>();
  const fingerprints = new Map<string, string>();
  const expectedCohorts = new Map<string, Map<string, number>>();
  const unknownPolicies = new Set<string>();
  let subsonicTargetCount = 0;
  let highTargetCount = 0;
  let affectedTargetCount = 0;
  for (const row of rows) {
    const target = readPreciseSourceTarget(row);
    const fingerprint = analysisContentHash(target);
    if (
      fingerprints.has(target.targetId) &&
      fingerprints.get(target.targetId) !== fingerprint
    )
      throw new Error(
        "Current source generations have conflicting target metadata",
      );
    fingerprints.set(target.targetId, fingerprint);
    targets.set(target.targetId, target);
    const cohort = isSubsonic(target) ? "low" : "high";
    const counts = expectedCohorts.get(String(row.generation_id)) ?? new Map();
    counts.set(cohort, (counts.get(cohort) ?? 0) + 1);
    expectedCohorts.set(String(row.generation_id), counts);
    const precise = target.recipes.precise as Record<string, unknown>;
    const policy = precise.selectionPolicy;
    if (policy !== undefined && policy !== PRECISE_SOLVER_SELECTION_POLICY)
      unknownPolicies.add(typeof policy === "string" ? policy : String(policy));
    if (cohort === "low") {
      subsonicTargetCount += 1;
      if (!Object.prototype.hasOwnProperty.call(precise, "selectionPolicy"))
        affectedTargetCount += 1;
    } else highTargetCount += 1;
  }
  const [cohortPolicy] = await db.execute(sql`
    SELECT campaign_id FROM campaign_progressive_execution_policies
    WHERE campaign_id=${campaignId}::uuid AND policy=${SUBSONIC_THROUGH_PRECISE_POLICY}
  `);
  const members = await db.execute(sql`
    SELECT generation_id,cohort,count(*)::int AS count
    FROM progressive_generation_cohort_targets
    WHERE generation_id IN (${ids}) GROUP BY generation_id,cohort
  `);
  const actualCohorts = new Map<string, Map<string, number>>();
  for (const row of members) {
    const counts = actualCohorts.get(String(row.generation_id)) ?? new Map();
    counts.set(String(row.cohort), Number(row.count));
    actualCohorts.set(String(row.generation_id), counts);
  }
  let cohortMissingGenerations = 0;
  for (const generationId of generationIds) {
    const expected = expectedCohorts.get(generationId) ?? new Map();
    const actual = actualCohorts.get(generationId) ?? new Map();
    if ([...expected].some(([cohort, count]) => actual.get(cohort) !== count))
      cohortMissingGenerations += 1;
  }
  const successorTargets = [...targets.values()]
    .sort((left, right) => left.targetId.localeCompare(right.targetId))
    .map((target) => {
      if (!isSubsonic(target)) return target;
      const precise = target.recipes.precise as Record<string, unknown>;
      if (precise.selectionPolicy === PRECISE_SOLVER_SELECTION_POLICY)
        return target;
      const recipes = structuredClone(target.recipes);
      recipes.precise = {
        ...recipes.precise,
        selectionPolicy: PRECISE_SOLVER_SELECTION_POLICY,
      };
      return { ...target, recipes };
    });
  return {
    campaignId,
    epochId,
    planRevisionId,
    status: String(campaign.status),
    admissionPaused: admission?.enabled === false,
    receipt: null,
    generationIds,
    successorTargets,
    targetCount: targets.size,
    subsonicTargetCount,
    highTargetCount,
    affectedTargetCount,
    unknownPolicies: [...unknownPolicies].sort(),
    cohortReady: Boolean(cohortPolicy) && cohortMissingGenerations === 0,
    cohortMissingGenerations,
    unsupportedFastCells: await readUnsupportedFastCells(db, generationIds),
    busy: await readPreciseBusyCounts(db, campaignId, epochId, generationIds),
  };
}

async function assertPreciseFastPreserved(
  db: DB,
  previousGenerationIds: string[],
  successorGenerationId: string,
) {
  const previous = sql.join(
    previousGenerationIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const cells = await db.execute(sql`
    WITH source_cells AS (
      SELECT work.target_id,unit.aoa_deg,unit.recipe,unit.state
      FROM progressive_cfd_units unit
      JOIN progressive_work work ON work.id=unit.work_id
      WHERE work.generation_id IN (${previous}) AND work.stage=2
        AND unit.state IN ('complete','gap')
    )
    SELECT source.target_id,source.aoa_deg,source.state AS source_state,
      successor.id AS successor_unit_id,successor.state AS successor_state,
      EXISTS(SELECT 1 FROM progressive_cfd_evidence_reuses reuse
        WHERE reuse.successor_unit_id=successor.id) AS reuse_proof
    FROM source_cells source
    LEFT JOIN progressive_work successor_work
      ON successor_work.generation_id=${successorGenerationId}::uuid
      AND successor_work.target_id=source.target_id AND successor_work.stage=2
    LEFT JOIN progressive_cfd_units successor
      ON successor.work_id=successor_work.id AND successor.aoa_deg=source.aoa_deg
      AND successor.recipe=source.recipe
  `);
  for (const cell of cells) {
    const sourceState = String(cell.source_state);
    const successorState =
      cell.successor_state == null ? null : String(cell.successor_state);
    const reuseProof =
      cell.reuse_proof === true || String(cell.reuse_proof) === "true";
    if (!successorState)
      throw new Error(
        "Precise selection adoption lost a predecessor fast cell",
      );
    if (sourceState === "complete" && successorState !== "complete")
      throw new Error(
        "Precise selection adoption regressed completed fast evidence",
      );
    if (sourceState === "gap" && !["complete", "gap"].includes(successorState))
      throw new Error(
        "Precise selection adoption reopened a predecessor fast gap",
      );
    if (successorState === "complete" && !reuseProof)
      throw new Error(
        "Precise selection adoption lacks a genuine fast evidence reuse proof",
      );
  }
}

async function preserveTerminalFastGaps(
  db: DB,
  previousGenerationIds: string[],
  successorGenerationId: string,
) {
  const previous = sql.join(
    previousGenerationIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await db.execute(sql`
    UPDATE progressive_cfd_units successor
    SET state='gap',
      error=coalesce(source_unit.error,
        'preserved predecessor fast gap during precise solver selection policy adoption')
    FROM progressive_work successor_work
    JOIN progressive_work source_work
      ON source_work.target_id=successor_work.target_id AND source_work.stage=2
    JOIN progressive_cfd_units source_unit
      ON source_unit.work_id=source_work.id
    WHERE successor.work_id=successor_work.id
      AND successor_work.generation_id=${successorGenerationId}::uuid
      AND successor_work.stage=2
      AND successor.state='pending'
      AND source_work.generation_id IN (${previous})
      AND source_unit.aoa_deg=successor.aoa_deg
      AND source_unit.recipe=successor.recipe
      AND source_unit.state='gap'
  `);
}

async function reusePreviousCfdEvidenceProofs(
  db: DB,
  previousGenerationIds: string[],
  successorGenerationId: string,
) {
  const previous = sql.join(
    previousGenerationIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const candidates = await db.execute(sql`
    SELECT successor.id AS successor_unit_id,
      successor.recipe AS successor_recipe,
      successor_scope.revision_id AS successor_revision_id,
      reuse.source_attempt_token,
      reuse.source_result_attempt_id,
      reuse.source_evidence_signature,
      reuse.source_generation_id,
      reuse.source_execution_recipe_id,
      raw.evidence_payload AS source_evidence_payload,
      stopped.proof,
      stopped.proof_signature
    FROM progressive_cfd_units successor
    JOIN progressive_work successor_work ON successor_work.id=successor.work_id
    JOIN progressive_generation_targets successor_scope
      ON successor_scope.generation_id=successor_work.generation_id
      AND successor_scope.target_id=successor_work.target_id
    JOIN progressive_generations successor_generation
      ON successor_generation.id=successor_work.generation_id
    JOIN progressive_work source_work
      ON source_work.target_id=successor_work.target_id
      AND source_work.stage=2
      AND source_work.generation_id IN (${previous})
    JOIN progressive_cfd_units source_unit
      ON source_unit.work_id=source_work.id
      AND source_unit.state='complete'
    JOIN progressive_cfd_evidence_reuses reuse
      ON reuse.successor_unit_id=source_unit.id
    JOIN progressive_cfd_attempts source_attempt
      ON source_attempt.token=reuse.source_attempt_token
    JOIN progressive_cfd_evidence evidence
      ON evidence.attempt_token=source_attempt.token
      AND evidence.result_attempt_id=reuse.source_result_attempt_id
      AND evidence.evidence_signature=reuse.source_evidence_signature
    JOIN result_attempts raw ON raw.id=evidence.result_attempt_id
    JOIN progressive_generations source_generation
      ON source_generation.id=reuse.source_generation_id
      AND source_generation.campaign_id=successor_generation.campaign_id
      AND source_generation.epoch_id=successor_generation.epoch_id
    JOIN progressive_cfd_execution_recipes execution_recipe
      ON execution_recipe.id=reuse.source_execution_recipe_id
      AND execution_recipe.source_revision_id=successor_scope.revision_id
      AND execution_recipe.recipe=successor.recipe
    JOIN sim_jobs source_job
      ON source_job.id=source_attempt.sim_job_id
      AND source_job.engine_job_id=raw.engine_job_id
    JOIN progressive_cfd_execution_stops stopped
      ON stopped.sim_job_id=source_job.id
      AND stopped.engine_job_id=source_job.engine_job_id
      AND stopped.epoch_id=successor_generation.epoch_id
    WHERE successor_work.generation_id=${successorGenerationId}::uuid
      AND successor_work.stage=2 AND successor_work.state='pending'
      AND successor.state='pending'
      AND successor.lease_token IS NULL AND successor.lease_owner IS NULL
      AND successor.lease_until IS NULL
      AND source_unit.aoa_deg=successor.aoa_deg
      AND source_unit.recipe=successor.recipe
      AND source_job.status IN ('done','failed','cancelled')
      AND source_job."ingestedAt" IS NOT NULL
      AND (source_job.ingest_lease_expires_at IS NULL
        OR source_job.ingest_lease_expires_at <= clock_timestamp())
      AND raw.evidence_payload IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM progressive_cfd_evidence_reuses existing
        WHERE existing.successor_unit_id=successor.id
      )
    ORDER BY successor.id, reuse.created_at DESC, reuse.source_attempt_token
    LIMIT 256
  `);
  let reused = 0;
  for (const row of candidates) {
    if (
      analysisContentHash({
        sourceRevisionId: String(row.successor_revision_id),
        recipe: row.successor_recipe,
      }) !== row.source_execution_recipe_id ||
      analysisContentHash(row.source_evidence_payload) !==
        row.source_evidence_signature ||
      analysisContentHash(row.proof) !== row.proof_signature
    )
      continue;
    const inserted = await db.execute(sql`
      INSERT INTO progressive_cfd_evidence_reuses (
        successor_unit_id,source_attempt_token,source_result_attempt_id,
        source_evidence_signature,source_generation_id,source_execution_recipe_id
      ) VALUES (
        ${row.successor_unit_id}::uuid,${row.source_attempt_token}::uuid,
        ${row.source_result_attempt_id}::uuid,${row.source_evidence_signature},
        ${row.source_generation_id}::uuid,${row.source_execution_recipe_id}
      ) ON CONFLICT (successor_unit_id) DO NOTHING RETURNING successor_unit_id
    `);
    if (!inserted.length) continue;
    const updated = await db.execute(sql`
      UPDATE progressive_cfd_units SET state='complete',error=NULL
      WHERE id=${row.successor_unit_id}::uuid AND state='pending'
        AND lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL
      RETURNING id
    `);
    if (updated.length !== 1)
      throw new Error(
        "Progressive CFD reuse lost its exact successor unit owner",
      );
    reused += 1;
  }
  return reused;
}

async function adoptPreciseRecipeSuccessor(
  db: DB,
  campaignId: string,
  epochId: string,
  planRevisionId: string,
  generationIds: string[],
  successorTargets: SealedPolarTarget[],
) {
  const ids = sql.join(
    generationIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await db.execute(
    sql`UPDATE progressive_generations SET status='cancelled' WHERE id IN (${ids})`,
  );
  await cancelObsoleteProgressiveCfdUnits(db, campaignId);
  await db.execute(sql`
    UPDATE progressive_work SET state='gap',completed_at=clock_timestamp(),error='superseded by precise solver selection policy adoption'
    WHERE generation_id IN (${ids}) AND state IN ('pending','leased')
  `);
  const successor = await sealProgressiveGeneration(db, {
    campaignId,
    planRevisionId,
    scopeKey: analysisContentHash({
      policy: PRECISE_SOLVER_SELECTION_POLICY,
      planRevisionId,
      sourceGenerationIds: generationIds,
      targets: successorTargets,
    }),
    targets: successorTargets,
  });
  await reusePreviousBaselines(db, successor.id, generationIds, epochId);
  await initializeProgressiveCfdWork(db, campaignId);
  let reusedCfd = 0;
  for (let pass = 0; pass < 256; pass += 1) {
    const batch = await reuseAcceptedProgressiveCfdEvidence(
      db,
      successor.id,
      generationIds,
      epochId,
    );
    reusedCfd += batch;
    if (batch === 0) break;
  }
  for (let pass = 0; pass < 256; pass += 1) {
    const batch = await reuseInformativeProgressiveCfdEvidence(
      db,
      successor.id,
      generationIds,
      epochId,
    );
    reusedCfd += batch;
    if (batch === 0) break;
  }
  for (let pass = 0; pass < 256; pass += 1) {
    const batch = await reusePreviousCfdEvidenceProofs(
      db,
      generationIds,
      successor.id,
    );
    reusedCfd += batch;
    if (batch === 0) break;
  }
  await preserveTerminalFastGaps(db, generationIds, successor.id);
  await assertPreciseFastPreserved(db, generationIds, successor.id);
  await db.execute(sql`
    INSERT INTO progressive_recipe_adoptions(epoch_id,campaign_id,plan_revision_id,policy,previous_generation_ids,generation_id)
    VALUES(${epochId}::uuid,${campaignId}::uuid,${planRevisionId}::uuid,${PRECISE_SOLVER_SELECTION_POLICY},ARRAY[${ids}],${successor.id}::uuid)
  `);
  return { generationId: String(successor.id), reusedCfd };
}

function preciseSelectionReason(
  state: PreciseSelectionInspection,
): string | null {
  if (state.receipt || !state.generationIds.length) return null;
  if (!["active", "attention"].includes(state.status))
    return "Only active preliminary campaigns may adopt a numerical policy";
  if (!state.admissionPaused)
    return "Pause new solver admissions before adopting recipes";
  if (state.unknownPolicies.length)
    return "Unknown precise solver selection policy";
  if (!state.cohortReady)
    return "The subsonic cohort barrier is missing or inconsistent";
  if (state.unsupportedFastCells)
    return "Precise selection adoption cannot preserve completed fast history";
  if (!state.affectedTargetCount)
    return "No legacy subsonic precise recipe requires adoption";
  if (hasBusyWork(state.busy))
    return "Old solver work must be physically stopped and settled before precise solver selection adoption";
  return null;
}

export async function previewProgressivePreciseSelectionPolicy(
  db: DB,
  campaignId: string,
) {
  return db.transaction(async (transaction) => {
    const state = await inspectPreciseSelectionPolicy(
      transaction as unknown as DB,
      campaignId,
      false,
    );
    const reason = preciseSelectionReason(state);
    return {
      kind: "preview" as const,
      campaignId,
      epochId: state.epochId,
      planRevisionId: state.planRevisionId,
      policy: PRECISE_SOLVER_SELECTION_POLICY,
      replayed: state.receipt !== null,
      receipt: state.receipt,
      generationCount: state.generationIds.length,
      targetCount: state.targetCount,
      subsonicTargetCount: state.subsonicTargetCount,
      highTargetCount: state.highTargetCount,
      affectedTargetCount: state.affectedTargetCount,
      unknownPolicies: state.unknownPolicies,
      admissionPaused: state.admissionPaused,
      cohortReady: state.cohortReady,
      cohortMissingGenerations: state.cohortMissingGenerations,
      unsupportedFastCells: state.unsupportedFastCells,
      busy: state.busy,
      ready: reason === null,
      reason,
    };
  });
}

export async function adoptProgressivePreciseSelectionPolicy(
  db: DB,
  campaignId: string,
) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const state = await inspectPreciseSelectionPolicy(
      connection,
      campaignId,
      true,
    );
    if (state.receipt)
      return {
        kind: "replayed" as const,
        campaignId,
        generation_id: state.receipt.generationId,
        previous_generation_ids: state.receipt.previousGenerationIds,
      };
    if (!["active", "attention"].includes(state.status))
      throw new Error(
        "Only active preliminary campaigns may adopt a numerical policy",
      );
    if (!state.generationIds.length)
      return { kind: "not_required" as const, campaignId };
    if (!state.admissionPaused)
      throw new Error("Pause new solver admissions before adopting recipes");
    if (state.unknownPolicies.length)
      throw new Error("Unknown precise solver selection policy");
    if (!state.cohortReady)
      throw new Error("The subsonic cohort barrier is missing or inconsistent");
    if (state.unsupportedFastCells)
      throw new Error(
        "Precise selection adoption cannot preserve completed fast history",
      );
    if (!state.affectedTargetCount)
      return { kind: "not_required" as const, campaignId };
    if (hasBusyWork(state.busy))
      throw new Error(
        "Old solver work must be physically stopped and settled before precise solver selection adoption",
      );
    const adopted = await adoptPreciseRecipeSuccessor(
      connection,
      campaignId,
      state.epochId,
      state.planRevisionId,
      state.generationIds,
      state.successorTargets,
    );
    return {
      kind: "adopted" as const,
      campaignId,
      generation_id: adopted.generationId,
      previous_generation_ids: state.generationIds,
      reused_cfd: adopted.reusedCfd,
      affected_targets: state.affectedTargetCount,
      preserved_high_targets: state.highTargetCount,
    };
  });
}
