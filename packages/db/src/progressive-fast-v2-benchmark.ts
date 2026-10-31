import { sql } from "drizzle-orm";
import { airfoilConcaveCurvature } from "@aerodb/core";
import { campaignEnrollmentScope } from "./campaigns";
import type { DB } from "./client";
import {
  analysisContentHash,
  canonicalAnalysisJson,
  createAnalysisTarget,
  type AnalysisPhysical,
} from "./analysis-target";
import {
  progressiveFastV2BenchmarkRecipes,
  progressiveRecipes,
} from "./progressive-materialization";
import {
  sealProgressiveGeneration,
  type SealedPolarTarget,
} from "./progressive-campaigns";
import { initializeProgressiveCfdWork } from "./progressive-cfd";
import { reusePreviousBaselines } from "./progressive-recipe-adoption";
import {
  isLowMachBenchmarkMach,
  PROGRESSIVE_BENCHMARK_PUBLICATION,
} from "./progressive-recipe-policy";
import type { SimulationSetupSnapshot } from "./simulation-setup";

export const FAST_V2_BENCHMARK_SCHEMA =
  "progressive-fast-v2-benchmark-v1" as const;
export const FAST_V2_BENCHMARK_MAX_CASES = 32;
export const FAST_V2_BENCHMARK_PRIORITY = 0;
const FAST_V2_BENCHMARK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;

export function fastV2BenchmarkPriority(sourcePriority: number): number {
  if (
    !Number.isInteger(sourcePriority) ||
    sourcePriority < 0 ||
    sourcePriority > 9
  )
    throw new Error(
      "Source campaign priority must be an integer from 0 through 9",
    );
  return Math.max(FAST_V2_BENCHMARK_PRIORITY, sourcePriority - 1);
}

export interface FastV2BenchmarkCaseInput {
  caseId: string;
  snapshot: SimulationSetupSnapshot;
  maximumConcaveCurvature?: number | null;
  angles?: number[];
  airfoilId?: string | null;
  revisionId?: string | null;
  targetId?: string | null;
  physical?: AnalysisPhysical;
}

export interface FastV2BenchmarkLaunchInput {
  benchmarkId: string;
  sourceCampaignId: string;
  profileIds: string[];
  conditionIds: string[];
}

export interface FastV2BenchmarkLaunchResult {
  benchmarkId: string;
  benchmarkCampaignId: string;
  currentFastGenerationId: string;
  fastV2GenerationId: string;
  initializedFastUnits: number;
  replayed: boolean;
}

export interface FastV2BenchmarkPlanCase {
  caseId: string;
  mach: number;
  angles: number[];
  airfoilId: string | null;
  revisionId: string | null;
  targetId: string | null;
  setupSignature: string;
  recipes: {
    currentFast: Record<string, unknown>;
    fastV2: Record<string, unknown>;
    precise: Record<string, unknown>;
  };
}

export interface FastV2BenchmarkPlan {
  schema: typeof FAST_V2_BENCHMARK_SCHEMA;
  benchmarkId: string;
  cohort: "low-mach";
  generatedAt: string;
  cases: FastV2BenchmarkPlanCase[];
}

export interface FastV2BenchmarkRun {
  elapsedSeconds: number;
  acceptedAngles: number[];
  coefficients: Array<{
    alpha: number;
    cl: number;
    cd: number;
    cm: number | null;
  }>;
}

export interface FastV2BenchmarkMeasurementCase {
  caseId: string;
  currentFast: FastV2BenchmarkRun;
  fastV2: FastV2BenchmarkRun;
  preciseReference?: FastV2BenchmarkRun;
}

export interface FastV2BenchmarkMeasurements {
  schema: typeof FAST_V2_BENCHMARK_SCHEMA;
  benchmarkId: string;
  cases: FastV2BenchmarkMeasurementCase[];
}

interface ErrorMetrics {
  matchedAngles: number;
  clRmse: number | null;
  cdRmse: number | null;
  cmRmse: number | null;
}

export function buildFastV2BenchmarkPlan(input: {
  benchmarkId: string;
  cases: FastV2BenchmarkCaseInput[];
}): FastV2BenchmarkPlan {
  if (!input.benchmarkId.trim())
    throw new Error("A fast-v2 benchmark requires a stable benchmark id");
  if (!input.cases.length || input.cases.length > FAST_V2_BENCHMARK_MAX_CASES)
    throw new Error(
      `A fast-v2 benchmark must contain between 1 and ${FAST_V2_BENCHMARK_MAX_CASES} cases`,
    );
  const caseIds = new Set<string>();
  const cases = input.cases.map((item) => {
    if (!item.caseId.trim() || caseIds.has(item.caseId))
      throw new Error(
        "Fast-v2 benchmark case ids must be non-empty and unique",
      );
    caseIds.add(item.caseId);
    const mach = item.snapshot.derived.mach;
    if (!isLowMachBenchmarkMach(mach))
      throw new Error(
        `Fast-v2 benchmark case ${item.caseId} is outside the low-Mach cohort`,
      );
    const lowMach = mach as number;
    const current = progressiveRecipes(
      item.snapshot,
      item.maximumConcaveCurvature ?? null,
    );
    const fastV2 = progressiveFastV2BenchmarkRecipes(
      item.snapshot,
      item.maximumConcaveCurvature ?? null,
    );
    if (
      canonicalAnalysisJson(current.precise) !==
      canonicalAnalysisJson(fastV2.precise)
    )
      throw new Error(
        `Fast-v2 benchmark case ${item.caseId} changed the precise recipe`,
      );
    const angles = item.angles ?? [];
    if (
      angles.some(
        (angle, index) =>
          !Number.isFinite(angle) || (index > 0 && angle <= angles[index - 1]),
      )
    )
      throw new Error(
        `Fast-v2 benchmark case ${item.caseId} has an invalid angle list`,
      );
    return {
      caseId: item.caseId,
      mach: lowMach,
      angles,
      airfoilId: item.airfoilId ?? null,
      revisionId: item.revisionId ?? null,
      targetId: item.targetId ?? null,
      setupSignature: analysisContentHash(item.snapshot),
      recipes: {
        currentFast: current.fast,
        fastV2: fastV2.fast,
        precise: current.precise,
      },
    };
  });
  return {
    schema: FAST_V2_BENCHMARK_SCHEMA,
    benchmarkId: input.benchmarkId,
    cohort: "low-mach",
    generatedAt: new Date().toISOString(),
    cases,
  };
}

function validateRun(run: FastV2BenchmarkRun, label: string) {
  if (!Number.isFinite(run.elapsedSeconds) || run.elapsedSeconds <= 0)
    throw new Error(`${label} elapsedSeconds must be positive and finite`);
  const angles = new Set<number>();
  for (const angle of run.acceptedAngles) {
    if (!Number.isFinite(angle) || angles.has(angle))
      throw new Error(`${label} acceptedAngles must be finite and unique`);
    angles.add(angle);
  }
  const coefficientAngles = new Set<number>();
  for (const coefficient of run.coefficients) {
    if (
      !Number.isFinite(coefficient.alpha) ||
      coefficientAngles.has(coefficient.alpha) ||
      !Number.isFinite(coefficient.cl) ||
      !Number.isFinite(coefficient.cd) ||
      coefficient.cd <= 0 ||
      (coefficient.cm !== null && !Number.isFinite(coefficient.cm))
    )
      throw new Error(`${label} contains invalid coefficient evidence`);
    coefficientAngles.add(coefficient.alpha);
  }
}

function rmse(values: number[]): number | null {
  return values.length
    ? Math.sqrt(
        values.reduce((sum, value) => sum + value * value, 0) / values.length,
      )
    : null;
}

function errorMetrics(
  run: FastV2BenchmarkRun,
  reference: FastV2BenchmarkRun | undefined,
): ErrorMetrics | null {
  if (!reference) return null;
  const referenceByAngle = new Map(
    reference.coefficients.map((coefficient) => [
      coefficient.alpha,
      coefficient,
    ]),
  );
  const cl: number[] = [];
  const cd: number[] = [];
  const cm: number[] = [];
  for (const coefficient of run.coefficients) {
    const baseline = referenceByAngle.get(coefficient.alpha);
    if (!baseline) continue;
    cl.push(coefficient.cl - baseline.cl);
    cd.push(coefficient.cd - baseline.cd);
    if (coefficient.cm !== null && baseline.cm !== null)
      cm.push(coefficient.cm - baseline.cm);
  }
  return {
    matchedAngles: cl.length,
    clRmse: rmse(cl),
    cdRmse: rmse(cd),
    cmRmse: rmse(cm),
  };
}

export function buildFastV2BenchmarkReport(
  plan: FastV2BenchmarkPlan,
  measurements: FastV2BenchmarkMeasurements | null = null,
) {
  if (measurements && measurements.benchmarkId !== plan.benchmarkId)
    throw new Error("Benchmark measurements belong to a different benchmark");
  const measurementsByCase = new Map(
    (measurements?.cases ?? []).map((item) => [item.caseId, item]),
  );
  const comparisons = plan.cases.map((item) => {
    const measurement = measurementsByCase.get(item.caseId);
    if (!measurement) return { caseId: item.caseId, measurement: null };
    validateRun(measurement.currentFast, `${item.caseId} current fast`);
    validateRun(measurement.fastV2, `${item.caseId} fast-v2`);
    if (measurement.preciseReference)
      validateRun(
        measurement.preciseReference,
        `${item.caseId} precise reference`,
      );
    return {
      caseId: item.caseId,
      measurement,
      comparison: {
        speedup:
          measurement.currentFast.elapsedSeconds /
          measurement.fastV2.elapsedSeconds,
        acceptedPointDelta:
          measurement.fastV2.acceptedAngles.length -
          measurement.currentFast.acceptedAngles.length,
        currentFastAgainstPrecise: errorMetrics(
          measurement.currentFast,
          measurement.preciseReference,
        ),
        fastV2AgainstPrecise: errorMetrics(
          measurement.fastV2,
          measurement.preciseReference,
        ),
      },
    };
  });
  const speedups = comparisons.flatMap((item) =>
    "comparison" in item && item.comparison ? [item.comparison.speedup] : [],
  );
  const sortedSpeedups = [...speedups].sort((left, right) => left - right);
  const medianSpeedup = sortedSpeedups.length
    ? sortedSpeedups[Math.floor(sortedSpeedups.length / 2)]
    : null;
  return {
    ...plan,
    status: speedups.length === plan.cases.length ? "measured" : "plan_only",
    comparisons,
    summary: {
      measuredCases: speedups.length,
      totalCases: plan.cases.length,
      medianSpeedup,
    },
  };
}

export async function campaignCases(
  db: DB,
  campaignId: string,
  profileIds: string[],
  conditionIds: string[],
): Promise<FastV2BenchmarkCaseInput[]> {
  if (!profileIds.length || !conditionIds.length)
    throw new Error(
      "Campaign benchmark mode requires at least one --profile-id and --condition-id",
    );
  const [campaign] = (await db.execute(sql`
    SELECT id, current_condition_generation FROM sim_campaigns WHERE id=${campaignId}::uuid
  `)) as unknown as Array<{
    id: string;
    current_condition_generation: number;
  }>;
  if (!campaign) throw new Error("Benchmark campaign does not exist");
  const profiles = (await db.execute(sql`
    SELECT airfoil.id, airfoil.points
    FROM sim_campaign_airfoils membership JOIN airfoils airfoil ON airfoil.id=membership.airfoil_id
    WHERE membership.campaign_id=${campaignId}::uuid
      AND airfoil.id IN (${sql.join(
        profileIds.map((id) => sql`${id}::uuid`),
        sql`,`,
      )})
      AND airfoil."deletedAt" IS NULL AND airfoil."archivedAt" IS NULL
    ORDER BY airfoil.id
  `)) as unknown as Array<{
    id: string;
    points: Array<{ x: number; y: number }>;
  }>;
  const conditions = (await db.execute(sql`
    SELECT condition.id, revision.id AS revision_id, revision.snapshot
    FROM sim_campaign_conditions condition
    JOIN simulation_preset_revisions revision ON revision.id=condition.simulation_preset_revision_id
    WHERE condition.campaign_id=${campaignId}::uuid
      AND condition.generation=${campaign.current_condition_generation}
      AND condition.status IN ('active','kept')
      AND condition.id IN (${sql.join(
        conditionIds.map((id) => sql`${id}::uuid`),
        sql`,`,
      )})
    ORDER BY condition.id
  `)) as unknown as Array<{
    id: string;
    revision_id: string;
    snapshot: SimulationSetupSnapshot;
  }>;
  if (profiles.length !== new Set(profileIds).size)
    throw new Error(
      "One or more selected benchmark profiles are not in the campaign",
    );
  if (conditions.length !== new Set(conditionIds).size)
    throw new Error(
      "One or more selected benchmark conditions are not active in the campaign",
    );
  const enrollment = await campaignEnrollmentScope(db, campaignId);
  const cases: FastV2BenchmarkCaseInput[] = [];
  for (const condition of conditions) {
    const angles = enrollment.cellsByCondition.get(condition.id)?.angles;
    if (!angles)
      throw new Error(`Condition ${condition.id} has no angle intent`);
    if (!condition.snapshot.material)
      throw new Error(`Condition ${condition.id} has no material snapshot`);
    for (const profile of profiles) {
      const target = createAnalysisTarget({
        airfoilId: profile.id,
        points: profile.points,
        snapshot: condition.snapshot,
        material: {
          ...condition.snapshot.material,
          speedOfSound: condition.snapshot.material.speedOfSound ?? null,
        },
        transition: { model: "fully_turbulent", nCrit: 9, upper: 0, lower: 0 },
        branch: "increasing",
      });
      cases.push({
        caseId: `${condition.id}:${profile.id}`,
        snapshot: condition.snapshot,
        maximumConcaveCurvature: airfoilConcaveCurvature(profile.points),
        angles,
        airfoilId: profile.id,
        revisionId: condition.revision_id,
        targetId: target.signature,
        physical: target.physical,
      });
    }
  }
  return cases;
}

function benchmarkTargets(
  cases: FastV2BenchmarkCaseInput[],
  variant: "current" | "fast-v2-benchmark",
): SealedPolarTarget[] {
  return cases.map((item) => {
    if (!item.airfoilId || !item.revisionId || !item.targetId || !item.physical)
      throw new Error(
        `Benchmark case ${item.caseId} is missing immutable target identity`,
      );
    const current = progressiveRecipes(
      item.snapshot,
      item.maximumConcaveCurvature ?? null,
    );
    const candidate = progressiveFastV2BenchmarkRecipes(
      item.snapshot,
      item.maximumConcaveCurvature ?? null,
    );
    return {
      airfoilId: item.airfoilId,
      targetId: item.targetId,
      physical: item.physical,
      revisionId: item.revisionId,
      angles: item.angles ?? [],
      recipes:
        variant === "current"
          ? {
              ...current,
              fast: {
                ...current.fast,
                publication: PROGRESSIVE_BENCHMARK_PUBLICATION,
              },
            }
          : candidate,
    };
  });
}

function benchmarkScopeKey(
  benchmarkId: string,
  variant: "current" | "fast-v2",
) {
  return `fast-v2-benchmark:${benchmarkId}:${variant === "fast-v2" ? "fast-v2" : "current-fast"}`;
}

function validateBenchmarkId(benchmarkId: string) {
  if (!FAST_V2_BENCHMARK_ID_RE.test(benchmarkId))
    throw new Error(
      "Benchmark id must be 1-120 characters of letters, numbers, dot, underscore, colon, or hyphen",
    );
}

async function benchmarkGenerationRows(db: DB, campaignId: string) {
  return (await db.execute(sql`
    SELECT id, scope_key, benchmark_only FROM progressive_generations
    WHERE campaign_id=${campaignId}::uuid AND benchmark_only=true
      AND scope_key LIKE 'fast-v2-benchmark:%'
    ORDER BY scope_key
  `)) as unknown as Array<{
    id: string;
    scope_key: string;
    benchmark_only: boolean;
  }>;
}

async function assertFastOnlyBenchmark(db: DB, campaignId: string) {
  const generations = await benchmarkGenerationRows(db, campaignId);
  if (generations.length !== 2)
    throw new Error(
      "Benchmark campaign must contain exactly two fast generations",
    );
  const keys = new Set(generations.map((row) => row.scope_key));
  if (
    !keys.has(benchmarkScopeKeyFromScope(generations, "current-fast")) ||
    !keys.has(benchmarkScopeKeyFromScope(generations, "fast-v2"))
  )
    throw new Error(
      "Benchmark campaign is missing its current-fast or fast-v2 generation",
    );
  const [stage3] = (await db.execute(sql`
    SELECT count(*)::int AS count FROM progressive_work work
    JOIN progressive_generations generation ON generation.id=work.generation_id
    WHERE generation.campaign_id=${campaignId}::uuid AND generation.benchmark_only=true AND work.stage=3
  `)) as unknown as Array<{ count: number }>;
  if (Number(stage3?.count ?? 0) !== 0)
    throw new Error("Benchmark-only campaign contains precise work");
  return generations;
}

function benchmarkScopeKeyFromScope(
  generations: Array<{ scope_key: string }>,
  suffix: "current-fast" | "fast-v2",
) {
  const row = generations.find((item) => item.scope_key.endsWith(`:${suffix}`));
  if (!row) return `missing:${suffix}`;
  return row.scope_key;
}

export async function launchFastV2Benchmark(
  db: DB,
  input: FastV2BenchmarkLaunchInput,
): Promise<FastV2BenchmarkLaunchResult> {
  validateBenchmarkId(input.benchmarkId);
  const cases = await campaignCases(
    db,
    input.sourceCampaignId,
    input.profileIds,
    input.conditionIds,
  );
  buildFastV2BenchmarkPlan({ benchmarkId: input.benchmarkId, cases });
  const idempotencyKey = `fast-v2-benchmark:${input.benchmarkId}`;
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('fast-v2-benchmark-launch', 0))`,
    );
    const [existing] = (await connection.execute(sql`
      SELECT id FROM sim_campaigns WHERE idempotency_key=${idempotencyKey}
    `)) as unknown as Array<{ id: string }>;
    if (existing) {
      const generations = await assertFastOnlyBenchmark(
        connection,
        existing.id,
      );
      const initialized = await initializeProgressiveCfdWork(
        connection,
        existing.id,
      );
      return {
        benchmarkId: input.benchmarkId,
        benchmarkCampaignId: existing.id,
        currentFastGenerationId: generations.find((row) =>
          row.scope_key.endsWith(":current-fast"),
        )!.id,
        fastV2GenerationId: generations.find((row) =>
          row.scope_key.endsWith(":fast-v2"),
        )!.id,
        initializedFastUnits: initialized,
        replayed: true,
      };
    }
    const [source] = (await connection.execute(sql`
      SELECT campaign.id, campaign.name, campaign.priority, campaign.current_plan_revision_id,
        revision.plan
      FROM sim_campaigns campaign
      JOIN sim_campaign_plan_revisions revision ON revision.id=campaign.current_plan_revision_id
      WHERE campaign.id=${input.sourceCampaignId}::uuid
      FOR SHARE OF campaign
    `)) as unknown as Array<{
      id: string;
      name: string;
      priority: number;
      current_plan_revision_id: string;
      plan: Record<string, unknown>;
    }>;
    if (!source) throw new Error("Source campaign does not exist");
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (!epoch) throw new Error("Calculation epoch is missing");
    const sourceGenerations = (await connection.execute(sql`
      SELECT id FROM progressive_generations
      WHERE campaign_id=${input.sourceCampaignId}::uuid AND epoch_id=${epoch.id}
        AND status <> 'cancelled'
      ORDER BY created_at, id
    `)) as unknown as Array<{ id: string }>;
    if (!sourceGenerations.length)
      throw new Error(
        "Fast-v2 benchmark requires an existing progressive baseline generation",
      );
    const sourceConditions = (await connection.execute(sql`
      SELECT condition.id, condition.ord, condition.flow_condition_id, condition.reference_geometry_profile_id,
        condition.preset_id, condition.simulation_preset_revision_id, condition.reynolds, condition.mach,
        scope.angles
      FROM sim_campaign_conditions condition
      JOIN campaign_condition_scopes scope ON scope.condition_id=condition.id
      WHERE condition.campaign_id=${input.sourceCampaignId}::uuid
        AND condition.id IN (${sql.join(
          input.conditionIds.map((id) => sql`${id}::uuid`),
          sql`,`,
        )})
        AND condition.status IN ('active','kept')
      ORDER BY condition.ord
    `)) as unknown as Array<Record<string, unknown>>;
    if (sourceConditions.length !== new Set(input.conditionIds).size)
      throw new Error("Selected benchmark conditions changed before launch");
    const slug = `fast-v2-benchmark-${input.benchmarkId}`;
    const [campaign] = (await connection.execute(sql`
      INSERT INTO sim_campaigns(slug,name,notes,status,priority,idempotency_key,current_condition_generation)
      VALUES(${slug},${`Fast-v2 benchmark ${input.benchmarkId}`},
        ${JSON.stringify({ kind: FAST_V2_BENCHMARK_SCHEMA, benchmarkId: input.benchmarkId, sourceCampaignId: input.sourceCampaignId })},
        'active',${fastV2BenchmarkPriority(source.priority)},${idempotencyKey},1)
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const [planRevision] = (await connection.execute(sql`
      INSERT INTO sim_campaign_plan_revisions(campaign_id,revision_number,kind,plan,summary)
      VALUES(${campaign.id},1,'initial',${canonicalAnalysisJson(source.plan)}::jsonb,
        ${canonicalAnalysisJson({ kind: FAST_V2_BENCHMARK_SCHEMA, sourceCampaignId: input.sourceCampaignId, profileIds: input.profileIds, conditionIds: input.conditionIds })}::jsonb)
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    await connection.execute(sql`
      UPDATE sim_campaigns SET current_plan_revision_id=${planRevision.id} WHERE id=${campaign.id}
    `);
    await connection.execute(sql`
      INSERT INTO sim_campaign_airfoils(campaign_id,airfoil_id)
      SELECT ${campaign.id}, airfoil_id FROM sim_campaign_airfoils
      WHERE campaign_id=${input.sourceCampaignId}::uuid
        AND airfoil_id IN (${sql.join(
          input.profileIds.map((id) => sql`${id}::uuid`),
          sql`,`,
        )})
    `);
    await connection.execute(sql`
      INSERT INTO sim_campaign_conditions(
        id,campaign_id,ord,generation,flow_condition_id,reference_geometry_profile_id,preset_id,
        simulation_preset_revision_id,reynolds,mach,status,introduced_in_plan_revision_id)
      SELECT gen_random_uuid(),${campaign.id},source.ord,1,source.flow_condition_id,source.reference_geometry_profile_id,
        source.preset_id,source.simulation_preset_revision_id,source.reynolds,source.mach,'active',${planRevision.id}
      FROM sim_campaign_conditions source
      WHERE source.campaign_id=${input.sourceCampaignId}::uuid
        AND source.id IN (${sql.join(
          input.conditionIds.map((id) => sql`${id}::uuid`),
          sql`,`,
        )})
    `);
    await connection.execute(sql`
      INSERT INTO campaign_condition_scopes(condition_id,angles,source_plan_revision_id)
      SELECT cloned.id, source_scope.angles, ${planRevision.id}
      FROM sim_campaign_conditions cloned
      JOIN sim_campaign_conditions source
        ON source.campaign_id=${input.sourceCampaignId}::uuid AND source.ord=cloned.ord
      JOIN campaign_condition_scopes source_scope ON source_scope.condition_id=source.id
      WHERE cloned.campaign_id=${campaign.id}
    `);
    const currentGeneration = await sealProgressiveGeneration(connection, {
      campaignId: campaign.id,
      planRevisionId: planRevision.id,
      scopeKey: benchmarkScopeKey(input.benchmarkId, "current"),
      targets: benchmarkTargets(cases, "current"),
      benchmarkOnly: true,
    });
    const fastV2Generation = await sealProgressiveGeneration(connection, {
      campaignId: campaign.id,
      planRevisionId: planRevision.id,
      scopeKey: benchmarkScopeKey(input.benchmarkId, "fast-v2"),
      targets: benchmarkTargets(cases, "fast-v2-benchmark"),
      benchmarkOnly: true,
    });
    for (const generation of [currentGeneration, fastV2Generation])
      await reusePreviousBaselines(
        connection,
        generation.id,
        sourceGenerations.map((row) => String(row.id)),
        String(epoch.id),
      );
    const [pendingBaseline] = await connection.execute(sql`
      SELECT count(*)::int AS count FROM progressive_work
      WHERE generation_id IN (${currentGeneration.id}::uuid,${fastV2Generation.id}::uuid)
        AND stage=1 AND state <> 'complete'
    `);
    if (Number(pendingBaseline?.count ?? 0) !== 0)
      throw new Error(
        "Fast-v2 benchmark requires complete reusable NeuralFoil baselines",
      );
    const initialized = await initializeProgressiveCfdWork(
      connection,
      String(campaign.id),
    );
    await assertFastOnlyBenchmark(connection, String(campaign.id));
    return {
      benchmarkId: input.benchmarkId,
      benchmarkCampaignId: String(campaign.id),
      currentFastGenerationId: currentGeneration.id,
      fastV2GenerationId: fastV2Generation.id,
      initializedFastUnits: initialized,
      replayed: false,
    };
  });
}

interface BenchmarkObservationRow {
  scope_key: string;
  target_id: string;
  aoa_deg: number;
  unit_state: string;
  active_seconds: number;
  accepted: boolean | null;
  cl: number | null;
  cd: number | null;
  cm: number | null;
}

function benchmarkRunFromRows(rows: BenchmarkObservationRow[]) {
  const accepted = rows.filter((row) => row.accepted === true);
  return {
    totalPoints: rows.length,
    acceptedPoints: accepted.length,
    acceptedEvidenceRate: rows.length ? accepted.length / rows.length : 0,
    activeSeconds: rows.reduce(
      (total, row) => total + Number(row.active_seconds),
      0,
    ),
    complete: rows.every((row) => ["complete", "gap"].includes(row.unit_state)),
    acceptedAngles: accepted
      .map((row) => Number(row.aoa_deg))
      .sort((a, b) => a - b),
    coefficients: accepted
      .filter(
        (row) =>
          row.cl !== null &&
          row.cd !== null &&
          Number.isFinite(Number(row.cl)) &&
          Number.isFinite(Number(row.cd)),
      )
      .map((row) => ({
        alpha: Number(row.aoa_deg),
        cl: Number(row.cl),
        cd: Number(row.cd),
        cm: row.cm === null ? null : Number(row.cm),
      })),
  };
}

export async function readFastV2BenchmarkReport(
  db: DB,
  benchmarkCampaignId: string,
) {
  const generations = await assertFastOnlyBenchmark(db, benchmarkCampaignId);
  const rows = (await db.execute(sql`
    SELECT generation.scope_key, work.target_id, unit.aoa_deg,
      unit.state AS unit_state, unit.active_seconds,
      observed.accepted, observed.cl, observed.cd, observed.cm
    FROM progressive_generations generation
    JOIN progressive_work work ON work.generation_id=generation.id AND work.stage=2
    JOIN progressive_cfd_units unit ON unit.work_id=work.id
    LEFT JOIN LATERAL (
      SELECT raw.cl, raw.cd, raw.cm,
        (raw.status='done' AND raw.valid_for_polar AND classification.state='accepted') AS accepted
      FROM progressive_cfd_attempts attempt
      JOIN progressive_cfd_evidence evidence ON evidence.attempt_token=attempt.token
      JOIN result_attempts raw ON raw.id=evidence.result_attempt_id
      LEFT JOIN LATERAL (
        SELECT verdict.state FROM result_classifications verdict
        WHERE verdict.result_attempt_id=raw.id
        ORDER BY verdict."createdAt" DESC, verdict.id DESC LIMIT 1
      ) classification ON true
      WHERE attempt.unit_id=unit.id
      ORDER BY (raw.status='done' AND raw.valid_for_polar AND classification.state='accepted') DESC,
        raw."createdAt" DESC, raw.id DESC
      LIMIT 1
    ) observed ON true
    WHERE generation.campaign_id=${benchmarkCampaignId}::uuid
      AND generation.benchmark_only=true
    ORDER BY generation.scope_key, work.target_id, unit.aoa_deg
  `)) as unknown as BenchmarkObservationRow[];
  const byVariant = new Map<string, Map<string, BenchmarkObservationRow[]>>();
  for (const generation of generations) {
    const variant = generation.scope_key.endsWith(":fast-v2")
      ? "fastV2"
      : generation.scope_key.endsWith(":current-fast")
        ? "currentFast"
        : null;
    if (!variant) continue;
    const targets = new Map<string, BenchmarkObservationRow[]>();
    byVariant.set(variant, targets);
    for (const row of rows.filter(
      (item) => item.scope_key === generation.scope_key,
    )) {
      const targetRows = targets.get(row.target_id) ?? [];
      targetRows.push(row);
      targets.set(row.target_id, targetRows);
    }
  }
  const targetIds = new Set<string>([
    ...(byVariant.get("currentFast") ?? new Map()).keys(),
    ...(byVariant.get("fastV2") ?? new Map()).keys(),
  ]);
  const cases = [...targetIds].sort().map((targetId) => {
    const current = benchmarkRunFromRows(
      byVariant.get("currentFast")?.get(targetId) ?? [],
    );
    const fastV2 = benchmarkRunFromRows(
      byVariant.get("fastV2")?.get(targetId) ?? [],
    );
    const currentByAngle = new Map(
      current.coefficients.map((row) => [row.alpha, row]),
    );
    const deltas = fastV2.coefficients.flatMap((row) => {
      const baseline = currentByAngle.get(row.alpha);
      return baseline
        ? [
            {
              alpha: row.alpha,
              deltaCl: row.cl - baseline.cl,
              deltaCd: row.cd - baseline.cd,
              deltaCm:
                row.cm === null || baseline.cm === null
                  ? null
                  : row.cm - baseline.cm,
            },
          ]
        : [];
    });
    return {
      targetId,
      currentFast: current,
      fastV2,
      speedup:
        current.activeSeconds > 0 && fastV2.activeSeconds > 0
          ? current.activeSeconds / fastV2.activeSeconds
          : null,
      coefficientDeltas: deltas,
    };
  });
  return {
    schema: FAST_V2_BENCHMARK_SCHEMA,
    benchmarkCampaignId,
    benchmarkOnly: true,
    preciseWorkCreated: false,
    generations: generations.map((generation) => ({
      id: generation.id,
      scopeKey: generation.scope_key,
    })),
    status: cases.every(
      (item) => item.currentFast.complete && item.fastV2.complete,
    )
      ? "complete"
      : "running",
    cases,
  };
}
