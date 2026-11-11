import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import { readProgressiveRemoteRetention } from "./progressive-remote-retention";
import { progressiveReportedPointSources } from "./progressive-remote-report";
import { resolveProgressiveRemoteEvidence } from "./progressive-remote-evidence";
import { assertProgressiveRemoteEvidenceAttempt } from "./progressive-remote-evidence-receipts";
import { assertProgressiveRemotePhysicalCase } from "./progressive-remote-point-projection";
import { validateProgressiveExecutionStopProof } from "./progressive-cfd-settlement";
import { progressiveEvidencePreservesGeometry } from "./progressive-evidence-geometry";
import { ProgressiveCfdEvidenceScopeClosed } from "./progressive-storage-recovery-scope";

function refuse(): never {
  throw new ProgressiveCfdEvidenceScopeClosed("Stopped accepted publication lost its exact compatible ownership");
}

// Caller holds this transaction through publication. This authorizes only the
// existing accepted result; it never changes an attempt, unit, recipe or receipt.
// Settlement can opt into occupied cells to validate their retained historical
// source under the same scope/owner gates. It must not pass those IDs to promotion.
export async function readStoppedAcceptedProgressivePublication(
  db: DB,
  executionId: string,
  includeOccupied = false,
) {
  const [initial] = await db.execute(sql`SELECT campaign_id,request_payload->'progressive'->>'epochId' AS epoch_id
    FROM sim_jobs WHERE id=${executionId}::uuid AND status='cancelled' AND "ingestedAt" IS NULL`);
  if (!initial) return null;
  const [epoch] = await db.execute(sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`);
  if (epoch?.id !== initial.epoch_id) refuse();
  const [campaign] = await db.execute(sql`SELECT id,status,current_plan_revision_id FROM sim_campaigns
    WHERE id=${initial.campaign_id}::uuid FOR UPDATE`);
  if (!campaign || !["active", "attention", "paused", "completed"].includes(String(campaign.status))) refuse();
  const [job] = await db.execute(sql`SELECT job.airfoil_id,job.simulation_preset_revision_id,job.request_payload,
      dispatch.envelope,dispatch.solver_id,dispatch.promise_id,dispatch.content_signature,
      stopped.proof,stopped.proof_signature,stopped.epoch_id AS stopped_epoch_id
    FROM sim_jobs job JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=job.id
    JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=job.id AND stopped.engine_job_id=job.id::text
    JOIN registered_remote_solvers solver ON solver.id=dispatch.solver_id AND solver.revoked_at IS NULL
    JOIN sync_sweep_promises promise ON promise.id=dispatch.promise_id AND promise.status<>'active'
    WHERE job.id=${executionId}::uuid AND job.engine_job_id=job.id::text AND job.campaign_id=${campaign.id}::uuid
      AND job.status='cancelled' AND job."ingestedAt" IS NULL
      AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())`);
  if (!job) refuse();
  const envelope = verifyProgressiveRemoteExecution(job.envelope, { executionId, solverId: String(job.solver_id),
    promiseId: String(job.promise_id), contentSignature: String(job.content_signature) });
  const payload = job.request_payload as { engineRequest: unknown; progressive: unknown };
  if (canonicalAnalysisJson(payload.engineRequest) !== canonicalAnalysisJson(envelope.request) ||
    canonicalAnalysisJson(payload.progressive) !== canonicalAnalysisJson(envelope.scope) ||
    envelope.scope.epochId !== epoch.id || job.stopped_epoch_id !== epoch.id ||
    analysisContentHash(job.proof) !== job.proof_signature) refuse();
  const proof = job.proof as Parameters<typeof validateProgressiveExecutionStopProof>[0];
  validateProgressiveExecutionStopProof(proof);
  if (proof.job_id !== executionId || proof.ownership_basis === "never_started_cancellation_fence") refuse();
  const units = await db.execute(sql`SELECT attempt.token,attempt.outcome,attempt.finished_at,attempt.execution_recipe_id,
      unit.id AS unit_id,unit.aoa_deg,unit.state,unit.lease_token,unit.lease_owner,unit.lease_until,
      unit.recipe AS current_recipe,recipe.recipe,recipe.source_revision_id,recipe.execution_revision_id,
      target_scope.revision_id AS current_source_revision_id,revision.snapshot,target.physical,target.airfoil_id,
      airfoil.points AS current_geometry,work.target_id,work.stage,generation.id AS generation_id,
      EXISTS(SELECT 1 FROM progressive_cfd_attempts live WHERE live.unit_id=unit.id AND live.outcome='running') AS live_unit
    FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
    JOIN progressive_work work ON work.id=unit.work_id JOIN progressive_generations generation ON generation.id=work.generation_id
    JOIN progressive_generation_targets target_scope ON target_scope.generation_id=generation.id AND target_scope.target_id=work.target_id
    JOIN polar_analysis_targets target ON target.id=work.target_id JOIN airfoils airfoil ON airfoil.id=target.airfoil_id
    JOIN progressive_cfd_execution_recipes recipe ON recipe.id=attempt.execution_recipe_id
    JOIN simulation_preset_revisions revision ON revision.id=recipe.execution_revision_id
    WHERE attempt.sim_job_id=${executionId}::uuid AND generation.campaign_id=${campaign.id}::uuid
      AND generation.epoch_id=${epoch.id}::uuid AND generation.plan_revision_id=${campaign.current_plan_revision_id}::uuid
      AND generation.status IN ('active','attention','complete') AND NOT generation.benchmark_only
    ORDER BY unit.id FOR UPDATE OF generation,work,unit,attempt`);
  const [count] = await db.execute(sql`SELECT count(*)::int AS count FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid`);
  if (!units.length || units.length !== Number(count.count) || units.length !== envelope.scope.units.length ||
    units.some((unit) => unit.generation_id !== envelope.scope.generationId || unit.target_id !== envelope.scope.targetId ||
      unit.stage !== envelope.scope.stage || unit.execution_recipe_id !== envelope.scope.recipeId ||
      !["complete", "failed", "cancelled"].includes(String(unit.outcome)) || unit.finished_at == null ||
      !envelope.scope.units.some((bound) => bound.token === unit.token && bound.unitId === unit.unit_id && bound.alpha === unit.aoa_deg))) refuse();
  // Recheck the mutable job after campaign/unit locking, in the same order as
  // normal evidence ingestion, and retain its lock until publication commits.
  const [locked] = await db.execute(sql`SELECT request_payload,status,"ingestedAt",ingest_lease_token,
      ingest_lease_expires_at>clock_timestamp() AS ingest_live,ingest_lease_expires_at
    FROM sim_jobs WHERE id=${executionId}::uuid FOR UPDATE`);
  if (!locked || locked.status !== "cancelled" || locked.ingestedAt != null ||
    analysisContentHash(locked.request_payload) !== analysisContentHash(payload) ||
    (locked.ingest_lease_token != null && (locked.ingest_live || locked.ingest_lease_expires_at == null))) refuse();
  const retained = await readProgressiveRemoteRetention(db, executionId);
  if (retained.kind !== "retained") return null;
  const final = new Set(retained.report.result ? progressiveReportedPointSources({ ...retained.report.result,
    polars: retained.report.result.polars.map((polar) => ({ ...polar, attempts: [] })) }).map((source) => source.contentSignature) : []);
  const attemptIds: string[] = [];
  for (const entry of retained.sources) {
    if (entry.storageOnly || !entry.archived || !final.has(entry.delivery.progressiveEvidence.pointContentSignature)) continue;
    const [raw] = await db.execute(sql`SELECT raw.id,raw.result_id,raw.airfoil_id,raw.aoa_deg,raw.simulation_preset_revision_id,
        raw.evidence_payload,evidence.attempt_token,evidence.evidence_signature,result.airfoil_id AS cell_airfoil_id,
        result.aoa_deg AS cell_aoa_deg,result.simulation_preset_revision_id AS cell_revision_id
      FROM result_attempts raw JOIN progressive_cfd_evidence evidence ON evidence.result_attempt_id=raw.id
      JOIN result_classifications classification ON classification.result_attempt_id=raw.id AND classification.state='accepted'
      JOIN results result ON result.id=raw.result_id
      WHERE raw.id=${entry.resultAttemptId}::uuid AND raw.sim_job_id=${executionId}::uuid AND raw.engine_job_id=${executionId}
        AND raw.status='done' AND raw.valid_for_polar
        AND (${includeOccupied} OR result.current_result_attempt_id IS NULL)
        AND coalesce((SELECT review.verdict::text FROM result_review_verdicts review
          WHERE review.result_id=result.id AND review."revokedAt" IS NULL
          ORDER BY review."createdAt" DESC,review.id DESC LIMIT 1),'') NOT IN ('exclude','defer')
      ${includeOccupied ? sql`FOR SHARE OF result,raw,classification` : sql``}`);
    if (!raw) continue;
    const unit = units.find((item) => item.token === raw.attempt_token && item.aoa_deg === raw.aoa_deg);
    if (!unit || unit.airfoil_id !== job.airfoil_id || raw.airfoil_id !== job.airfoil_id ||
      raw.cell_airfoil_id !== raw.airfoil_id || raw.cell_aoa_deg !== raw.aoa_deg ||
      raw.cell_revision_id !== raw.simulation_preset_revision_id || raw.simulation_preset_revision_id !== unit.execution_revision_id ||
      raw.simulation_preset_revision_id !== job.simulation_preset_revision_id || unit.live_unit ||
      !["pending", "gap", "complete"].includes(String(unit.state)) || unit.lease_token != null || unit.lease_owner != null || unit.lease_until != null ||
      unit.source_revision_id !== unit.current_source_revision_id ||
      canonicalAnalysisJson(unit.current_recipe) !== canonicalAnalysisJson(unit.recipe) ||
      analysisContentHash({ sourceRevisionId: unit.source_revision_id, recipe: unit.recipe }) !== unit.execution_recipe_id ||
      analysisContentHash(raw.evidence_payload) !== raw.evidence_signature) refuse();
    const physical = unit.physical as Parameters<typeof progressiveEvidencePreservesGeometry>[0];
    const geometry = (unit.current_geometry as Array<{ x: number; y: number }>).map(({ x, y }) => [x, y]);
    if (analysisContentHash(unit.physical) !== unit.target_id ||
      canonicalAnalysisJson(physical.geometry) !== canonicalAnalysisJson(envelope.request.airfoil.points) ||
      canonicalAnalysisJson(geometry) !== canonicalAnalysisJson(physical.geometry) ||
      !progressiveEvidencePreservesGeometry(physical, raw.evidence_payload as Record<string, unknown>)) refuse();
    await assertProgressiveRemoteEvidenceAttempt(db, { ...entry.delivery, resultAttemptId: entry.resultAttemptId });
    const source = await resolveProgressiveRemoteEvidence(db, entry.delivery);
    if (!source) refuse();
    assertProgressiveRemotePhysicalCase(source, unit.snapshot as Parameters<typeof assertProgressiveRemotePhysicalCase>[1]);
    attemptIds.push(entry.resultAttemptId);
  }
  return { executionId, airfoilId: String(job.airfoil_id), simulationPresetRevisionId: String(job.simulation_preset_revision_id), attemptIds };
}

// Run after the polar cache locks and before its result update. Locking here
// preserves cache -> result order and fences a concurrently claimed result.
export async function lockStoppedPublicationResults(db: DB, executionId: string, attemptIds: readonly string[]) {
  const retained = await readProgressiveRemoteRetention(db, executionId);
  if (retained.kind !== "retained" || attemptIds.some((id) => !retained.sources.some((source) =>
    source.resultAttemptId === id && source.archived && !source.storageOnly))) refuse();
  const rows = await db.execute(sql`SELECT result.id,result.current_result_attempt_id,result.sim_job_id,
      owner.status AS owner_status,owner.ingest_lease_token,owner.ingest_lease_expires_at,
      owner.ingest_lease_expires_at>clock_timestamp() AS ingest_live
    FROM result_attempts raw JOIN results result ON result.id=raw.result_id LEFT JOIN sim_jobs owner ON owner.id=result.sim_job_id
    JOIN result_classifications classification ON classification.result_attempt_id=raw.id AND classification.state='accepted'
    WHERE raw.id IN (${sql.join(attemptIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND raw.sim_job_id=${executionId}::uuid AND raw.status='done' AND raw.valid_for_polar
      AND coalesce((SELECT review.verdict::text FROM result_review_verdicts review
        WHERE review.result_id=result.id AND review."revokedAt" IS NULL
        ORDER BY review."createdAt" DESC,review.id DESC LIMIT 1),'') NOT IN ('exclude','defer')
    ORDER BY result.id FOR UPDATE OF result FOR SHARE OF classification`);
  if (rows.length !== attemptIds.length || rows.some((row) => row.current_result_attempt_id != null ||
    (row.sim_job_id != null && row.sim_job_id !== executionId &&
      !["done", "failed", "cancelled"].includes(String(row.owner_status))) ||
    (row.ingest_lease_token != null && (row.ingest_live || row.ingest_lease_expires_at == null)))) refuse();
}
