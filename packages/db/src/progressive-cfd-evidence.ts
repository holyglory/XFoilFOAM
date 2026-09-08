import { sql } from "drizzle-orm";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import type { DB } from "./client";
import type { JobStatus } from "../../engine-client/src/types";
import {
  resolveSolverCaseAllocations,
  solverBudgetCaseKey,
} from "../../engine-client/src/solver-budget";
import { assertProgressiveExecutionIdentity } from "./progressive-execution-identity";

export class ProgressiveCfdEvidenceScopeClosed extends Error {}

interface BoundUnit {
  token: string;
  unit_id: string;
  aoa_deg: number;
  active_seconds: number;
  unit_seconds: number;
  active_budget_seconds: number;
  budget_guard_confirmed: boolean;
  state: string;
  outcome: string;
  execution_revision_id: string;
  generation_id: string;
  epoch_id: string;
  target_id: string;
  execution_recipe_id: string;
  stage: number;
  requested_budget_seconds?: number;
  snapshot: {
    flowState: { speedMps: number };
    referenceGeometry: { referenceLengthM: number };
  };
}

async function lockJobScope(db: DB, simJobId: string, engineJobId: string) {
  const [job] = await db.execute(sql`
    SELECT job.airfoil_id, job.engine_job_id, job.campaign_id, job.request_payload, job.request_payload->'progressive' AS progressive,
      job.request_payload->'engineRequest'->'resources' AS requested_resources,
      job.request_payload->'engineRequest'->'expected_solver_budget_version' AS requested_budget_version,
      EXISTS (SELECT 1 FROM progressive_cfd_attempts attempt WHERE attempt.sim_job_id = job.id) AS bound
    FROM sim_jobs job WHERE job.id = ${simJobId}
  `);
  if (!job) throw new Error("Solver evidence job is missing");
  if (job.progressive == null && !job.bound) return null;
  if (!job.bound || !job.progressive || job.engine_job_id !== engineJobId)
    throw new Error(
      "Progressive CFD evidence has no exact engine/job ownership",
    );
  const metadata = job.progressive as Record<string, unknown>;
  assertProgressiveExecutionIdentity(
    simJobId,
    engineJobId,
    job.request_payload,
  );
  const [epoch] = await db.execute(
    sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
  );
  if (!epoch || metadata.epochId !== epoch.id)
    throw new ProgressiveCfdEvidenceScopeClosed(
      "Obsolete CFD calculation epoch",
    );
  const [campaign] = await db.execute(sql`
    SELECT status, current_plan_revision_id FROM sim_campaigns WHERE id = ${job.campaign_id} FOR UPDATE
  `);
  if (
    !campaign ||
    !["active", "attention", "paused"].includes(String(campaign.status))
  )
    throw new ProgressiveCfdEvidenceScopeClosed(
      "Campaign no longer accepts CFD evidence",
    );
  const units = (await db.execute(sql`
    SELECT attempt.token, unit.id AS unit_id, unit.aoa_deg, attempt.active_seconds, unit.active_seconds AS unit_seconds,
      unit.active_budget_seconds, unit.state, attempt.outcome, recipe.execution_revision_id,
      (EXISTS (SELECT 1 FROM progressive_cfd_evidence receipt WHERE receipt.attempt_token = attempt.token
        AND receipt.budget_guard_exhausted) OR EXISTS (SELECT 1 FROM progressive_cfd_runtime_progress runtime
        WHERE runtime.attempt_token = attempt.token AND runtime.engine_job_id = ${engineJobId})) AS budget_guard_confirmed,
      generation.id AS generation_id, generation.epoch_id, work.target_id, work.stage, attempt.execution_recipe_id, revision.snapshot
    FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
    JOIN progressive_work work ON work.id = unit.work_id JOIN progressive_generations generation ON generation.id = work.generation_id
    JOIN progressive_cfd_execution_recipes recipe ON recipe.id = attempt.execution_recipe_id
    JOIN simulation_preset_revisions revision ON revision.id = recipe.execution_revision_id
    WHERE attempt.sim_job_id = ${simJobId} AND generation.epoch_id = ${epoch.id}
      AND generation.campaign_id = ${job.campaign_id} AND generation.plan_revision_id = ${campaign.current_plan_revision_id}
      AND generation.status = 'active' AND generation.stage = work.stage
    ORDER BY unit.ordinal FOR UPDATE OF generation, work, unit, attempt
  `)) as unknown as BoundUnit[];
  const [count] = await db.execute(
    sql`SELECT count(*)::integer AS count FROM progressive_cfd_attempts WHERE sim_job_id = ${simJobId}`,
  );
  if (
    !units.length ||
    units.length !== Number(count.count) ||
    units.some(
      (unit) =>
        unit.generation_id !== metadata.generationId ||
        unit.target_id !== metadata.targetId ||
        unit.execution_recipe_id !== metadata.recipeId ||
        unit.stage !== metadata.stage ||
        unit.outcome !== "running" ||
        !["leased", "blocked"].includes(unit.state),
    )
  )
    throw new ProgressiveCfdEvidenceScopeClosed(
      "Obsolete or settled progressive CFD execution scope",
    );
  const tokens = metadata.tokens;
  if (
    !Array.isArray(tokens) ||
    tokens.length !== units.length ||
    new Set(tokens).size !== units.length ||
    units.some((unit) => !tokens.includes(unit.token))
  )
    throw new Error("Progressive CFD evidence token ownership changed");
  const physicalCases = units.map((unit) => ({
    chord: unit.snapshot.referenceGeometry.referenceLengthM,
    speed: unit.snapshot.flowState.speedMps,
    aoa_deg: unit.aoa_deg,
  }));
  const allocations = resolveSolverCaseAllocations(
    job.requested_resources,
    physicalCases,
    job.requested_budget_version,
  );
  for (const [index, unit] of units.entries())
    unit.requested_budget_seconds = allocations.get(
      solverBudgetCaseKey(physicalCases[index]),
    );
  return {
    airfoilId: String(job.airfoil_id),
    units,
  };
}

export async function assertProgressiveCfdEvidenceJob(
  db: DB,
  simJobId: string,
  engineJobId: string,
  cases?: Array<{
    alpha: number;
    speed: number;
    chord: number;
    solverActiveSeconds?: number | null;
  }>,
) {
  return db.transaction(async (transaction) => {
    const scope = await lockJobScope(
      transaction as unknown as DB,
      simJobId,
      engineJobId,
    );
    if (scope && cases) {
      for (const item of cases) {
        const unit = scope.units.find(
          (candidate) => candidate.aoa_deg === item.alpha,
        );
        if (
          !unit ||
          item.speed !== unit.snapshot.flowState.speedMps ||
          item.chord !== unit.snapshot.referenceGeometry.referenceLengthM
        )
          throw new Error(
            "Progressive CFD delivery changed its exact physical scope",
          );
        if (
          typeof item.solverActiveSeconds !== "number" ||
          !Number.isFinite(item.solverActiveSeconds) ||
          item.solverActiveSeconds < 0
        )
          throw new Error(
            "Progressive CFD delivery lacks measured cumulative solver time",
          );
      }
    }
    return scope !== null;
  });
}

export async function recordProgressiveCfdRuntimeProgress(
  db: DB,
  input: {
    simJobId: string;
    engineJobId: string;
    progress: NonNullable<JobStatus["solver_budget_progress"]>;
  },
): Promise<{ updated: number; replayed: number; stale: number }> {
  const progress = input.progress;
  if (
    !progress ||
    progress.version !== 1 ||
    progress.job_id !== input.engineJobId ||
    typeof progress.observed_at !== "string" ||
    !/(Z|[+-]\d{2}:\d{2})$/.test(progress.observed_at) ||
    !Number.isFinite(Date.parse(progress.observed_at)) ||
    !Array.isArray(progress.cases) ||
    progress.cases.length > 512
  )
    throw new Error("Invalid exact-job solver budget observation");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const scope = await lockJobScope(
      connection,
      input.simJobId,
      input.engineJobId,
    );
    if (!scope)
      throw new Error(
        "Runtime budget observation has no progressive ownership",
      );
    const receipt = { updated: 0, replayed: 0, stale: 0 };
    const seen = new Set<number>();
    for (const observed of progress.cases) {
      const unit = scope.units.find(
        (candidate) => candidate.aoa_deg === observed?.aoa_deg,
      );
      if (
        !unit ||
        seen.has(observed.aoa_deg) ||
        observed.chord !== unit.snapshot.referenceGeometry.referenceLengthM ||
        observed.speed !== unit.snapshot.flowState.speedMps ||
        typeof observed.solver_active_seconds !== "number" ||
        !Number.isFinite(observed.solver_active_seconds) ||
        observed.solver_active_seconds < 0 ||
        typeof observed.limit_seconds !== "number" ||
        !Number.isFinite(observed.limit_seconds) ||
        observed.limit_seconds <= 0 ||
        observed.limit_seconds > 43200 ||
        observed.limit_seconds !== unit.requested_budget_seconds ||
        observed.limit_seconds >
          Number(unit.active_budget_seconds) -
            (Number(unit.unit_seconds) - Number(unit.active_seconds)) ||
        typeof observed.solver_running !== "boolean"
      )
        throw new Error(
          "Runtime budget observation differs from its immutable physical case allocation",
        );
      seen.add(observed.aoa_deg);
      const observation = {
        job_id: input.engineJobId,
        observed_at: progress.observed_at,
        case: observed,
      };
      const signature = analysisContentHash(observation);
      const [previous] = await connection.execute(sql`
        SELECT engine_job_id, active_seconds, limit_seconds, observation_signature,
          observed_at > ${progress.observed_at}::timestamptz AS newer,
          observed_at = ${progress.observed_at}::timestamptz AS same_time FROM progressive_cfd_runtime_progress
        WHERE attempt_token = ${unit.token} FOR UPDATE
      `);
      if (previous) {
        if (
          previous.engine_job_id !== input.engineJobId ||
          Number(previous.limit_seconds) !== observed.limit_seconds
        )
          throw new Error(
            "Runtime budget observation changed its execution ownership",
          );
        if (previous.newer) {
          receipt.stale += 1;
          continue;
        }
        if (previous.same_time) {
          if (previous.observation_signature !== signature)
            throw new Error("Runtime budget replay changed its observation");
          receipt.replayed += 1;
          continue;
        }
        if (observed.solver_active_seconds < Number(previous.active_seconds))
          throw new Error("Cumulative runtime solver time regressed");
      }
      await connection.execute(sql`
        INSERT INTO progressive_cfd_runtime_progress(attempt_token, engine_job_id, observed_at, active_seconds, limit_seconds,
          solver_running, observation, observation_signature)
        VALUES (${unit.token}, ${input.engineJobId}, ${progress.observed_at}::timestamptz, ${observed.solver_active_seconds},
          ${observed.limit_seconds}, ${observed.solver_running}, ${canonicalAnalysisJson(observation)}::jsonb, ${signature})
        ON CONFLICT (attempt_token) DO UPDATE SET observed_at = excluded.observed_at, active_seconds = excluded.active_seconds,
          solver_running = excluded.solver_running, observation = excluded.observation, observation_signature = excluded.observation_signature
      `);
      const measured = Math.max(
        Number(unit.active_seconds),
        observed.solver_active_seconds,
      );
      const total =
        Number(unit.unit_seconds) + measured - Number(unit.active_seconds);
      const exhausted = total >= Number(unit.active_budget_seconds);
      await connection.execute(
        sql`UPDATE progressive_cfd_attempts SET active_seconds = ${measured} WHERE token = ${unit.token}`,
      );
      await connection.execute(sql`UPDATE progressive_cfd_units SET active_seconds = ${total},
        state = CASE WHEN ${exhausted} THEN 'blocked' ELSE state END,
        lease_token = CASE WHEN ${exhausted} THEN NULL ELSE lease_token END,
        lease_owner = CASE WHEN ${exhausted} THEN NULL ELSE lease_owner END,
        lease_until = CASE WHEN ${exhausted} THEN NULL ELSE lease_until END,
        error = CASE WHEN ${exhausted} THEN 'active compute budget exhausted; engine guard owns case stop' ELSE error END
        WHERE id = ${unit.unit_id}`);
      unit.active_seconds = measured;
      unit.unit_seconds = total;
      receipt.updated += 1;
    }
    return receipt;
  });
}

export async function recordProgressiveCfdEvidence(
  db: DB,
  input: { simJobId: string; engineJobId: string; resultAttemptIds: string[] },
): Promise<{ progressive: boolean; linked: number; stopRequired: boolean }> {
  const ids = [...new Set(input.resultAttemptIds)];
  if (ids.length > 2048)
    throw new Error("CFD evidence batch exceeds its bounded case scope");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const scope = await lockJobScope(
      connection,
      input.simJobId,
      input.engineJobId,
    );
    if (!scope) return { progressive: false, linked: 0, stopRequired: false };
    let linked = 0;
    let stopRequired = scope.units.some(
      (unit) =>
        Number(unit.unit_seconds) >= Number(unit.active_budget_seconds) &&
        !unit.budget_guard_confirmed,
    );
    const evidence = ids.length
      ? await connection.execute(sql`
      SELECT attempt.id, attempt.airfoil_id, attempt.aoa_deg, attempt.simulation_preset_revision_id, attempt.evidence_payload,
        cell.airfoil_id AS cell_airfoil_id, cell.aoa_deg AS cell_aoa_deg,
        cell.simulation_preset_revision_id AS cell_revision_id
      FROM result_attempts attempt JOIN results cell ON cell.id = attempt.result_id
      WHERE attempt.id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND attempt.sim_job_id = ${input.simJobId} AND attempt.engine_job_id = ${input.engineJobId}
      ORDER BY attempt.aoa_deg, attempt.id FOR SHARE OF attempt, cell
    `)
      : [];
    if (evidence.length !== ids.length)
      throw new Error("CFD receipt must reference exact stored job evidence");
    for (const row of evidence) {
      const unit = scope.units.find(
        (item) => item.aoa_deg === Number(row.aoa_deg),
      );
      if (
        !unit ||
        row.airfoil_id !== scope.airfoilId ||
        row.simulation_preset_revision_id !== unit.execution_revision_id ||
        row.cell_airfoil_id !== row.airfoil_id ||
        Number(row.cell_aoa_deg) !== Number(row.aoa_deg) ||
        row.cell_revision_id !== row.simulation_preset_revision_id
      )
        throw new Error(
          "CFD evidence differs from the immutable physical/numerical scope",
        );
      const payload = row.evidence_payload as Record<string, unknown> | null;
      const duration = payload?.solver_active_seconds;
      if (
        typeof duration !== "number" ||
        !Number.isFinite(duration) ||
        duration < 0
      )
        throw new Error(
          "Progressive CFD evidence lacks measured cumulative solver time",
        );
      const signature = analysisContentHash(payload);
      const guard = payload?.solver_budget as
        | Record<string, unknown>
        | null
        | undefined;
      let budgetGuardExhausted = false;
      if (guard != null) {
        if (
          typeof guard !== "object" ||
          Array.isArray(guard) ||
          guard.version !== 1 ||
          guard.scope !== "physical_case_v1" ||
          typeof guard.limit_seconds !== "number" ||
          !Number.isFinite(guard.limit_seconds) ||
          guard.limit_seconds <= 0 ||
          guard.limit_seconds > 43200 ||
          guard.limit_seconds !== unit.requested_budget_seconds ||
          typeof guard.exhausted !== "boolean" ||
          guard.exhausted !== duration >= guard.limit_seconds ||
          guard.limit_seconds >
            Number(unit.active_budget_seconds) -
              (Number(unit.unit_seconds) - Number(unit.active_seconds))
        )
          throw new Error(
            "CFD budget acknowledgement differs from its measured immutable case allocation",
          );
        budgetGuardExhausted = guard.exhausted;
      }
      const inserted = await connection.execute(sql`
        INSERT INTO progressive_cfd_evidence (attempt_token, result_attempt_id, evidence_signature, solver_active_seconds, budget_guard_exhausted)
        VALUES (${unit.token}, ${row.id}, ${signature}, ${duration}, ${budgetGuardExhausted}) ON CONFLICT DO NOTHING RETURNING result_attempt_id
      `);
      if (!inserted.length) {
        const [existing] = await connection.execute(sql`
          SELECT attempt_token, evidence_signature, solver_active_seconds, budget_guard_exhausted FROM progressive_cfd_evidence WHERE result_attempt_id = ${row.id}
        `);
        if (
          !existing ||
          existing.attempt_token !== unit.token ||
          existing.evidence_signature !== signature ||
          Number(existing.solver_active_seconds) !== duration ||
          existing.budget_guard_exhausted !== budgetGuardExhausted
        )
          throw new Error("CFD evidence replay changed its immutable receipt");
      } else linked += 1;
      const measured = Math.max(Number(unit.active_seconds), duration);
      const total =
        Number(unit.unit_seconds) + measured - Number(unit.active_seconds);
      const exhausted = total >= Number(unit.active_budget_seconds);
      await connection.execute(
        sql`UPDATE progressive_cfd_attempts SET active_seconds = ${measured} WHERE token = ${unit.token}`,
      );
      await connection.execute(sql`
        UPDATE progressive_cfd_units SET active_seconds = ${total},
          state = CASE WHEN ${exhausted} THEN 'blocked' ELSE state END,
          lease_token = CASE WHEN ${exhausted} THEN NULL ELSE lease_token END,
          lease_owner = CASE WHEN ${exhausted} THEN NULL ELSE lease_owner END,
          lease_until = CASE WHEN ${exhausted} THEN NULL ELSE lease_until END,
          error = CASE WHEN ${exhausted} THEN 'active compute budget exhausted; execution stop acknowledgement required' ELSE error END
        WHERE id = ${unit.unit_id}
      `);
      unit.active_seconds = measured;
      unit.unit_seconds = total;
      unit.budget_guard_confirmed ||= budgetGuardExhausted;
    }
    stopRequired = scope.units.some(
      (unit) =>
        Number(unit.unit_seconds) >= Number(unit.active_budget_seconds) &&
        !unit.budget_guard_confirmed,
    );
    return { progressive: true, linked, stopRequired };
  });
}
