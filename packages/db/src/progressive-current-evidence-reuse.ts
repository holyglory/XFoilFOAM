import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import { tryProgressiveAdmissionLock } from "./progressive-admission-lock";
import { effectiveProgressiveStageSql } from "./progressive-execution-policy";
import { progressiveEvidencePreservesGeometry } from "./progressive-evidence-geometry";
import { validateProgressiveExecutionStopProof } from "./progressive-cfd-settlement";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import { isFinalProgressiveRemoteReport, progressiveReportedPointSources, validateProgressiveRemoteReport } from "./progressive-remote-report";
import { readProgressiveRemoteRetention } from "./progressive-remote-retention";
import { resolveProgressiveRemoteEvidence } from "./progressive-remote-evidence";
import { assertProgressiveRemoteEvidenceAttempt } from "./progressive-remote-evidence-receipts";
import { assertProgressiveRemotePhysicalCase } from "./progressive-remote-point-projection";
import { POLAR_COMPATIBILITY_VERSION, resolveRevisionMethodCompatibilityHash } from "./polar-compatibility-cache";

const MAX_CURRENT_REUSE_UNITS = 64;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface CurrentPreciseReuseCursor {
  after?: { unitId: string; resultAttemptId: string };
}
// Like the publication service's rotating cursor, this is scan position only.
// Reuse authority lives in PostgreSQL. A restart begins a fresh bounded cycle.
const maintenanceCursors = new WeakMap<DB, Map<string, CurrentPreciseReuseCursor>>();

export interface CurrentPreciseEvidenceReuseInput {
  campaignId?: string;
  /** An exact operator/test scope. Omitted during bounded maintenance. */
  unitIds?: readonly string[];
  limit?: number;
  cursor?: CurrentPreciseReuseCursor;
}

export interface CurrentPreciseEvidenceReuseResult {
  reusedUnitIds: string[];
  replayedUnitIds: string[];
  refused: Array<{ unitId: string; reason: string }>;
}

type Candidate = { unit_id: string; result_attempt_id: string; campaign_id: string; epoch_id: string };
class ReuseRefused extends Error {}
function requireProof(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new ReuseRefused(reason);
}

async function authenticate<T>(read: () => T | Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    const failure = error as { code?: unknown; cause?: { code?: unknown } };
    if (!(error instanceof Error) || failure.code || failure.cause?.code || error.name !== "Error") throw error;
    throw new ReuseRefused(`Source authentication failed: ${error.message}`);
  }
}

async function reuseCurrentUnit(db: DB, candidate: Candidate): Promise<"reused" | "replayed"> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = await connection.execute(sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`);
    requireProof(epoch?.id === candidate.epoch_id, "obsolete epoch");
    requireProof(await tryProgressiveAdmissionLock(connection), "admission busy");
    const [campaign] = await connection.execute(sql`SELECT id,status,current_plan_revision_id FROM sim_campaigns
      WHERE id=${candidate.campaign_id}::uuid FOR UPDATE SKIP LOCKED`);
    requireProof(campaign && ["active", "attention", "paused", "completed"].includes(String(campaign.status)), "campaign unavailable");
    const [scope] = await connection.execute(sql`SELECT unit.id,unit.state,unit.recipe,unit.aoa_deg,unit.lease_token,unit.lease_owner,unit.lease_until,
        work.id AS work_id,work.state AS work_state,work.stage,work.target_id,${effectiveProgressiveStageSql()} AS effective_stage,
        generation.id AS generation_id,generation.status AS generation_status,generation.epoch_id,generation.plan_revision_id,
        generation.benchmark_only,target_scope.revision_id,target_scope.angles,target.physical,target.airfoil_id,airfoil.points,
        source.token,source.sim_job_id,source.execution_recipe_id,source.outcome,source.finished_at,
        recipe.recipe AS execution_recipe,recipe.source_revision_id,recipe.execution_revision_id,revision.snapshot,
        raw.result_id,raw.simulation_preset_revision_id,raw.evidence_payload,evidence.evidence_signature,
        raw.aoa_deg=unit.aoa_deg AND raw.airfoil_id=target.airfoil_id AND raw.sim_job_id=source.sim_job_id AS exact_cell,
        EXISTS(SELECT 1 FROM progressive_cfd_recovery_plans plan WHERE plan.unit_id=unit.id) OR
        EXISTS(SELECT 1 FROM progressive_cfd_budget_extensions extension WHERE extension.unit_id=unit.id) OR
        EXISTS(SELECT 1 FROM progressive_publication_recoveries recovery WHERE recovery.unit_id=unit.id) AS recovery_obligation
      FROM progressive_cfd_units unit JOIN progressive_work work ON work.id=unit.work_id
      JOIN progressive_generations generation ON generation.id=work.generation_id
      JOIN progressive_generation_targets target_scope ON target_scope.generation_id=generation.id AND target_scope.target_id=work.target_id
      JOIN polar_analysis_targets target ON target.id=work.target_id JOIN airfoils airfoil ON airfoil.id=target.airfoil_id
      JOIN progressive_cfd_attempts source ON source.unit_id=unit.id
      JOIN progressive_cfd_evidence evidence ON evidence.attempt_token=source.token
      JOIN result_attempts raw ON raw.id=evidence.result_attempt_id AND raw.id=${candidate.result_attempt_id}::uuid
      JOIN progressive_cfd_execution_recipes recipe ON recipe.id=source.execution_recipe_id
      JOIN simulation_preset_revisions revision ON revision.id=recipe.execution_revision_id
      WHERE unit.id=${candidate.unit_id}::uuid AND generation.campaign_id=${campaign.id}::uuid
      FOR UPDATE OF generation,work,unit,source SKIP LOCKED`);
    requireProof(scope, "unit unavailable");
    const [existing] = await connection.execute(sql`SELECT * FROM progressive_cfd_evidence_reuses WHERE successor_unit_id=${scope.id}::uuid`);
    const replay = scope.state === "complete" && existing != null;
    requireProof(scope.epoch_id === epoch.id && scope.plan_revision_id === campaign.current_plan_revision_id &&
      scope.benchmark_only === false && scope.stage === 3 &&
      (replay ? ["active", "complete"].includes(String(scope.generation_status))
        : scope.effective_stage === 3 && scope.generation_status === "active" && ["active", "attention", "paused"].includes(String(campaign.status)) &&
          ["pending", "gap"].includes(String(scope.state)) && scope.work_state === "pending"), "current precise scope required");
    requireProof(scope.lease_token == null && scope.lease_owner == null && scope.lease_until == null &&
      scope.recovery_obligation === false, "unit leased or recovery obligation present");
    // Stage 3 has no local-time-step overlay. Refusing recovery plans above
    // makes the unit recipe exactly the recipe the normal claimant would use.
    requireProof(scope.exact_cell === true && (scope.angles as number[]).includes(Number(scope.aoa_deg)) &&
      scope.source_revision_id === scope.revision_id && scope.simulation_preset_revision_id === scope.execution_revision_id &&
      canonicalAnalysisJson(scope.recipe) === canonicalAnalysisJson(scope.execution_recipe) &&
      analysisContentHash({ sourceRevisionId: scope.source_revision_id, recipe: scope.recipe }) === scope.execution_recipe_id &&
      analysisContentHash(scope.evidence_payload) === scope.evidence_signature, "physical/numerical evidence identity changed");
    const physical = scope.physical as Parameters<typeof progressiveEvidencePreservesGeometry>[0];
    const geometry = (scope.points as Array<{ x: number; y: number }>).map(({ x, y }) => [x, y]);
    requireProof(analysisContentHash(scope.physical) === scope.target_id &&
      canonicalAnalysisJson(geometry) === canonicalAnalysisJson(physical.geometry) &&
      progressiveEvidencePreservesGeometry(physical, scope.evidence_payload as Record<string, unknown>), "source geometry changed");

    const history = await connection.execute(sql`SELECT attempt.token,attempt.outcome,attempt.finished_at,attempt.active_seconds,
        attempt.execution_recipe_id,job.id AS job_id,job.engine_job_id,job.campaign_id,job.airfoil_id,job.simulation_preset_revision_id,
        job.status AS job_status,job."ingestedAt",job.request_payload,job.ingest_lease_token,job.ingest_lease_expires_at,
        job.ingest_lease_expires_at>clock_timestamp() AS ingest_live,stopped.proof,stopped.proof_signature,stopped.epoch_id AS stop_epoch_id,
        dispatch.envelope,dispatch.content_signature,dispatch.solver_id,dispatch.promise_id,solver.revoked_at,promise.status AS promise_status,
        (attempt.started_at,attempt.token)>(source.started_at,source.token) AS later,
        EXISTS(SELECT 1 FROM progressive_cfd_evidence e WHERE e.attempt_token=attempt.token) OR
        EXISTS(SELECT 1 FROM result_attempts r WHERE r.sim_job_id=job.id AND r.aoa_deg=${scope.aoa_deg}) OR
        EXISTS(SELECT 1 FROM progressive_cfd_runtime_progress p WHERE p.attempt_token=attempt.token AND p.active_seconds>0) AS has_evidence
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_attempts source ON source.token=${scope.token}::uuid
      LEFT JOIN sim_jobs job ON job.id=attempt.sim_job_id
      LEFT JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=job.id AND stopped.engine_job_id=job.id::text
      LEFT JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=job.id
      LEFT JOIN registered_remote_solvers solver ON solver.id=dispatch.solver_id
      LEFT JOIN sync_sweep_promises promise ON promise.id=dispatch.promise_id
      WHERE attempt.unit_id=${scope.id}::uuid ORDER BY attempt.started_at,attempt.token LIMIT 65`);
    requireProof(history.length > 0 && history.length <= 64, "unbounded unit history");
    // Lock jobs after the unit, matching ordinary ingestion and settlement.
    const jobIds = [...new Set(history.map((row) => String(row.job_id)))].sort();
    requireProof(jobIds.every((id) => UUID.test(id)), "unbound attempt owner");
    await connection.execute(sql`SELECT id FROM sim_jobs WHERE id IN (${sql.join(jobIds.map((id) => sql`${id}::uuid`), sql`, `)})
      ORDER BY id FOR UPDATE`);
    // Fresh statement after locking catches an owner/lease change while waiting.
    const owners = await connection.execute(sql`SELECT id,status,"ingestedAt",request_payload,engine_job_id,ingest_lease_token,
        ingest_lease_expires_at,ingest_lease_expires_at>clock_timestamp() AS ingest_live
      FROM sim_jobs WHERE id IN (${sql.join(jobIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    const assignments = await connection.execute(sql`SELECT dispatch.sim_job_id,dispatch.content_signature,dispatch.promise_id,dispatch.solver_id
      FROM progressive_remote_dispatches dispatch JOIN registered_remote_solvers solver ON solver.id=dispatch.solver_id AND solver.revoked_at IS NULL
      JOIN sync_sweep_promises promise ON promise.id=dispatch.promise_id AND promise.status<>'active'
      WHERE dispatch.sim_job_id IN (${sql.join(jobIds.map((id) => sql`${id}::uuid`), sql`, `)})
      ORDER BY dispatch.sim_job_id FOR SHARE OF dispatch,solver,promise`);
    let sourceEnvelope: ReturnType<typeof verifyProgressiveRemoteExecution> | undefined;
    for (const row of history) {
      const owner = owners.find((item) => item.id === row.job_id);
      const assignment = assignments.find((item) => item.sim_job_id === row.job_id);
      requireProof(owner && ["done", "failed", "cancelled"].includes(String(owner.status)) && owner.ingestedAt != null &&
        assignment && assignment.content_signature === row.content_signature && assignment.promise_id === row.promise_id && assignment.solver_id === row.solver_id &&
        ["complete", "failed", "cancelled"].includes(String(row.outcome)) && row.finished_at != null &&
        !(owner.ingest_lease_token != null && (owner.ingest_live || owner.ingest_lease_expires_at == null)) &&
        owner.engine_job_id === row.job_id && row.campaign_id === campaign.id && row.airfoil_id === scope.airfoil_id &&
        row.promise_status != null && row.promise_status !== "active" && row.revoked_at === null && row.envelope != null &&
        row.proof != null && row.stop_epoch_id === epoch.id && analysisContentHash(row.proof) === row.proof_signature,
      "live, unretired or unauthenticated execution owner");
      const envelope = await authenticate(() => verifyProgressiveRemoteExecution(row.envelope, { executionId: String(row.job_id),
        solverId: String(row.solver_id), promiseId: String(row.promise_id), contentSignature: String(row.content_signature) }));
      const payload = owner.request_payload as { engineRequest: unknown; progressive: unknown };
      requireProof(canonicalAnalysisJson(payload.progressive) === canonicalAnalysisJson(envelope.scope) &&
        canonicalAnalysisJson(payload.engineRequest) === canonicalAnalysisJson(envelope.request) &&
        envelope.scope.epochId === epoch.id && envelope.scope.generationId === scope.generation_id &&
        envelope.scope.targetId === scope.target_id && envelope.scope.stage === 3 &&
        envelope.scope.recipeId === row.execution_recipe_id &&
        envelope.scope.units.some((unit) => unit.unitId === scope.id && unit.token === row.token && unit.alpha === scope.aoa_deg),
      "execution assignment changed");
      const proof = row.proof as Parameters<typeof validateProgressiveExecutionStopProof>[0];
      await authenticate(() => validateProgressiveExecutionStopProof(proof));
      requireProof(proof.job_id === row.job_id, "foreign stop proof");
      if (row.token === scope.token) {
        requireProof(row.execution_recipe_id === scope.execution_recipe_id && row.simulation_preset_revision_id === scope.execution_revision_id &&
          proof.ownership_basis !== "never_started_cancellation_fence", "source was not the exact physical execution");
        sourceEnvelope = envelope;
      }
      if (row.later) {
        requireProof(row.outcome === "cancelled" && Number(row.active_seconds) === 0 && row.has_evidence === false &&
          row.execution_recipe_id === scope.execution_recipe_id && row.simulation_preset_revision_id === scope.execution_revision_id &&
          proof.ownership_basis === "never_started_cancellation_fence", "successor contains work or different numerical authority");
        const [reported] = await connection.execute(sql`SELECT report,content_signature FROM progressive_remote_reports
          WHERE sim_job_id=${row.job_id}::uuid ORDER BY sequence DESC LIMIT 1`);
        requireProof(reported, "successor cancellation report missing");
        const validated = await authenticate(() => validateProgressiveRemoteReport(reported.report, envelope));
        requireProof(validated.contentSignature === reported.content_signature && isFinalProgressiveRemoteReport(validated.report) &&
          validated.report.stopProof?.ownership_basis === "never_started_cancellation_fence", "successor cancellation was not authenticated");
      }
    }
    requireProof(sourceEnvelope && canonicalAnalysisJson(sourceEnvelope.request.airfoil.points) === canonicalAnalysisJson(physical.geometry),
      "reported geometry changed");

    // Do not take revision/classification row locks before the cache advisories.
    // Use try locks so a busy publisher/reviewer leaves this unit for a later pass.
    const method = await resolveRevisionMethodCompatibilityHash(connection, String(scope.execution_revision_id));
    requireProof(method, "numerical compatibility unavailable");
    for (const key of [`polar-compatibility:${POLAR_COMPATIBILITY_VERSION}:${scope.airfoil_id}:${method}`,
      `polar-revision:${scope.airfoil_id}:${scope.execution_revision_id}`, `result-evidence:${scope.result_id}`,
      `result-review-verdict:${scope.result_id}`]) {
      const [lock] = await connection.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key},0)) AS acquired`);
      requireProof(lock?.acquired === true, "canonical evidence busy");
    }
    const [accepted] = await connection.execute(sql`SELECT raw.id FROM result_attempts raw
      JOIN results cell ON cell.id=raw.result_id AND cell.current_result_attempt_id=raw.id
        AND cell.airfoil_id=raw.airfoil_id AND cell.simulation_preset_revision_id=raw.simulation_preset_revision_id
        AND cell.aoa_deg=raw.aoa_deg AND cell.sim_job_id=raw.sim_job_id AND cell.status='done'
      JOIN result_classifications classification ON classification.result_attempt_id=raw.id AND classification.state='accepted'
      WHERE raw.id=${candidate.result_attempt_id}::uuid AND raw.result_id=${scope.result_id}::uuid
        AND raw.status='done' AND raw.source='solved' AND raw.valid_for_polar
        AND raw.regime='urans' AND raw.evidence_payload->>'fidelity'='urans_full'
        AND NOT EXISTS(SELECT 1 FROM result_review_verdicts review WHERE review.result_id=cell.id
          AND review."revokedAt" IS NULL AND review.verdict IN ('exclude','defer'))
      FOR UPDATE OF cell FOR SHARE OF classification`);
    requireProof(accepted, "selected canonical accepted full URANS changed");
    const [currentGeometry] = await connection.execute(sql`SELECT points FROM airfoils WHERE id=${scope.airfoil_id}::uuid FOR SHARE`);
    requireProof(currentGeometry && canonicalAnalysisJson(currentGeometry.points) === canonicalAnalysisJson(scope.points), "geometry changed during reconciliation");
    const archives = await connection.execute(sql`SELECT archive.id FROM solver_evidence_archives archive
      JOIN solver_evidence_artifacts manifest ON manifest.result_attempt_id=archive.result_attempt_id AND manifest.result_id=archive.result_id
        AND manifest.kind='manifest'
      WHERE archive.result_attempt_id=${candidate.result_attempt_id}::uuid AND archive.result_id=${scope.result_id}::uuid AND archive.state='current'
      FOR SHARE OF archive,manifest`);
    requireProof(archives.length === 1, "current archive/manifest missing or ambiguous");
    const retention = await authenticate(() => readProgressiveRemoteRetention(connection, String(scope.sim_job_id)));
    requireProof(retention.kind === "retained", "source custody incomplete");
    const retained = retention.sources.find((entry) => entry.resultAttemptId === candidate.result_attempt_id);
    requireProof(retained && retained.archived && !retained.storageOnly && retention.report.result &&
      progressiveReportedPointSources({ ...retention.report.result,
        polars: retention.report.result.polars.map((polar) => ({ ...polar, attempts: [] })) })
        .some((entry) => entry.contentSignature === retained.delivery.progressiveEvidence.pointContentSignature),
    "source is not an archived final physical point");
    await authenticate(() => assertProgressiveRemoteEvidenceAttempt(connection, { ...retained.delivery, resultAttemptId: candidate.result_attempt_id }));
    const reported = await authenticate(() => resolveProgressiveRemoteEvidence(connection, retained.delivery));
    requireProof(reported, "source report unavailable");
    await authenticate(() => assertProgressiveRemotePhysicalCase(reported, scope.snapshot as Parameters<typeof assertProgressiveRemotePhysicalCase>[1]));
    const proof = { source_attempt_token: scope.token, source_result_attempt_id: candidate.result_attempt_id,
      source_evidence_signature: scope.evidence_signature, source_generation_id: scope.generation_id,
      source_execution_recipe_id: scope.execution_recipe_id };
    requireProof(!existing || Object.entries(proof).every(([key, value]) => existing[key] === value), "conflicting durable reuse");
    if (replay) return "replayed";
    requireProof(!existing, "reuse exists for an incomplete unit");
    const inserted = await connection.execute(sql`INSERT INTO progressive_cfd_evidence_reuses
      (successor_unit_id,source_attempt_token,source_result_attempt_id,source_evidence_signature,source_generation_id,source_execution_recipe_id)
      VALUES(${scope.id}::uuid,${scope.token}::uuid,${candidate.result_attempt_id}::uuid,${scope.evidence_signature},
        ${scope.generation_id}::uuid,${scope.execution_recipe_id}) ON CONFLICT(successor_unit_id) DO NOTHING RETURNING successor_unit_id`);
    requireProof(inserted.length === 1, "reuse insertion conflicted");
    const updated = await connection.execute(sql`UPDATE progressive_cfd_units SET state='complete',error=NULL
      WHERE id=${scope.id}::uuid AND state IN ('pending','gap') AND lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL
      RETURNING id`);
    requireProof(updated.length === 1, "unit ownership changed");
    return "reused";
  });
}

/** Credits existing current-generation evidence, never submits or rewrites a solve. */
export async function reconcileCurrentPreciseEvidenceReuse(
  db: DB, input: CurrentPreciseEvidenceReuseInput = {},
): Promise<CurrentPreciseEvidenceReuseResult> {
  const limit = input.limit ?? MAX_CURRENT_REUSE_UNITS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CURRENT_REUSE_UNITS ||
    (input.campaignId !== undefined && !UUID.test(input.campaignId)) ||
    (input.cursor !== undefined && input.unitIds !== undefined) ||
    (input.cursor?.after !== undefined && (!UUID.test(input.cursor.after.unitId) || !UUID.test(input.cursor.after.resultAttemptId))) ||
    (input.unitIds !== undefined && (!input.unitIds.length || input.unitIds.length > limit ||
      input.unitIds.some((id) => !UUID.test(id)) || new Set(input.unitIds.map((id) => id.toLowerCase())).size !== input.unitIds.length)))
    throw new Error("Current precise reuse requires a bounded unique unit scope");
  let cursor = input.cursor;
  if (!input.unitIds && !cursor) {
    let scopes = maintenanceCursors.get(db);
    if (!scopes) { scopes = new Map(); maintenanceCursors.set(db, scopes); }
    const key = input.campaignId ?? "all";
    cursor = scopes.get(key);
    if (!cursor) { cursor = {}; scopes.set(key, cursor); }
  }
  const candidates = await db.execute(sql`SELECT DISTINCT unit.id AS unit_id,raw.id AS result_attempt_id,
      generation.campaign_id,generation.epoch_id
    FROM progressive_cfd_units unit JOIN progressive_work work ON work.id=unit.work_id
    JOIN progressive_generations generation ON generation.id=work.generation_id
    JOIN sim_campaigns campaign ON campaign.id=generation.campaign_id
    JOIN calculation_epochs epoch ON epoch.id=generation.epoch_id AND epoch.current
    JOIN progressive_cfd_attempts attempt ON attempt.unit_id=unit.id
    JOIN sim_jobs job ON job.id=attempt.sim_job_id AND job.engine_job_id=job.id::text
    JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=job.id AND stopped.engine_job_id=job.id::text
      AND stopped.epoch_id=generation.epoch_id
    JOIN progressive_cfd_execution_recipes recipe ON recipe.id=attempt.execution_recipe_id AND recipe.recipe=unit.recipe
    JOIN progressive_generation_targets target_scope ON target_scope.generation_id=generation.id
      AND target_scope.target_id=work.target_id AND target_scope.revision_id=recipe.source_revision_id
    JOIN progressive_cfd_evidence evidence ON evidence.attempt_token=attempt.token
    JOIN result_attempts raw ON raw.id=evidence.result_attempt_id
    JOIN results cell ON cell.id=raw.result_id AND cell.current_result_attempt_id=raw.id AND cell.sim_job_id=job.id
      AND cell.airfoil_id=raw.airfoil_id AND cell.aoa_deg=raw.aoa_deg AND cell.simulation_preset_revision_id=raw.simulation_preset_revision_id
    JOIN result_classifications classification ON classification.result_attempt_id=raw.id AND classification.state='accepted'
    WHERE work.stage=3 AND generation.plan_revision_id=campaign.current_plan_revision_id AND NOT generation.benchmark_only
      AND generation.status IN ('active','complete') AND campaign.status IN ('active','attention','paused','completed')
      AND raw.status='done' AND raw.valid_for_polar AND raw.regime='urans' AND raw.evidence_payload->>'fidelity'='urans_full'
      AND raw.sim_job_id=job.id AND raw.engine_job_id=job.id::text AND raw.aoa_deg=unit.aoa_deg
      AND raw.simulation_preset_revision_id=recipe.execution_revision_id
      AND attempt.outcome IN ('complete','failed','cancelled') AND attempt.finished_at IS NOT NULL
      AND job.status IN ('done','failed','cancelled') AND job."ingestedAt" IS NOT NULL
      AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM progressive_cfd_recovery_plans p WHERE p.unit_id=unit.id)
      AND NOT EXISTS(SELECT 1 FROM progressive_cfd_budget_extensions e WHERE e.unit_id=unit.id)
      AND NOT EXISTS(SELECT 1 FROM progressive_publication_recoveries p WHERE p.unit_id=unit.id)
      AND NOT EXISTS(SELECT 1 FROM progressive_cfd_attempts live WHERE live.unit_id=unit.id AND live.outcome='running')
      AND NOT EXISTS(SELECT 1 FROM progressive_cfd_attempts history JOIN progressive_remote_dispatches d ON d.sim_job_id=history.sim_job_id
        JOIN sync_sweep_promises p ON p.id=d.promise_id WHERE history.unit_id=unit.id AND p.status='active')
      AND NOT EXISTS(SELECT 1 FROM result_review_verdicts review WHERE review.result_id=cell.id AND review."revokedAt" IS NULL AND review.verdict IN ('exclude','defer'))
      ${input.campaignId ? sql`AND campaign.id=${input.campaignId}::uuid` : sql``}
      ${input.unitIds ? sql`AND unit.id IN (${sql.join(input.unitIds.map((id) => sql`${id}::uuid`), sql`, `)})`
        : sql`AND unit.state IN ('pending','gap') AND unit.lease_token IS NULL AND unit.lease_owner IS NULL AND unit.lease_until IS NULL
          AND NOT EXISTS(SELECT 1 FROM progressive_cfd_evidence_reuses reuse WHERE reuse.successor_unit_id=unit.id)`}
      ${cursor?.after ? sql`AND (unit.id,raw.id)>(${cursor.after.unitId}::uuid,${cursor.after.resultAttemptId}::uuid)` : sql``}
    ORDER BY unit.id,raw.id LIMIT ${limit}`) as unknown as Candidate[];
  const result: CurrentPreciseEvidenceReuseResult = { reusedUnitIds: [], replayedUnitIds: [], refused: [] };
  for (const candidate of candidates) {
    // Advance on refusals too, including a hard error: the next maintenance
    // pass must not restart at an unchanged corrupt or busy prefix.
    if (cursor) cursor.after = { unitId: candidate.unit_id, resultAttemptId: candidate.result_attempt_id };
    try {
      const outcome = await reuseCurrentUnit(db, candidate);
      (outcome === "reused" ? result.reusedUnitIds : result.replayedUnitIds).push(candidate.unit_id);
    } catch (error) {
      if (!(error instanceof ReuseRefused)) throw error;
      result.refused.push({ unitId: candidate.unit_id, reason: error.message });
    }
  }
  if (cursor && candidates.length < limit) delete cursor.after;
  for (const id of input.unitIds ?? []) if (!candidates.some((candidate) => candidate.unit_id.toLowerCase() === id.toLowerCase()))
    result.refused.push({ unitId: id, reason: "no current selected accepted source" });
  return result;
}
