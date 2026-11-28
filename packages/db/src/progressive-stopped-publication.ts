import { attemptDigestColumns, matchesOriginalAttemptDigest } from "./attempt-evidence-digest";
import { sql } from "drizzle-orm";
import { effectiveProgressiveStageSql } from "./progressive-execution-policy";
import { progressiveBenchmarkAttemptSql } from "./progressive-recipe-policy";
import type { DB } from "./client";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import { readProgressiveRemoteRetention, readStoppedPublicationSources } from "./progressive-remote-retention";
import { progressiveReportedPointSources, type ProgressiveRemoteReport } from "./progressive-remote-report";
import { resolveProgressiveRemoteEvidence } from "./progressive-remote-evidence";
import { assertProgressiveRemoteEvidenceAttempt } from "./progressive-remote-evidence-receipts";
import { assertProgressiveRemotePhysicalCase } from "./progressive-remote-point-projection";
import { validateProgressiveExecutionStopProof } from "./progressive-cfd-settlement";
import { progressiveEvidencePreservesGeometry } from "./progressive-evidence-geometry";
import { ProgressiveCfdEvidenceScopeClosed } from "./progressive-storage-recovery-scope";

function refuse(): never {
  throw new ProgressiveCfdEvidenceScopeClosed("Stopped accepted publication lost its exact compatible ownership");
}

// A cancelled, unbound, zero-work claim is retained history. A later physical
// execution owns its point even after its lease and process have ended.
function laterPhysicalExecution() {
  return sql`EXISTS (SELECT FROM progressive_cfd_attempts newer WHERE newer.unit_id=unit.id
    AND (newer.started_at,newer.token)>(attempt.started_at,attempt.token)
    AND (newer.sim_job_id IS NOT NULL OR newer.outcome='running' OR newer.active_seconds>0
      OR EXISTS (SELECT FROM progressive_cfd_evidence receipt WHERE receipt.attempt_token=newer.token)))`;
}

// An active promise for another execution is an independent reservation even
// if this particular unit is unleased and its canonical pointer is empty.
function foreignCellPromise(executionId: string) {
  return sql`EXISTS (SELECT FROM sync_sweep_promise_points point
    JOIN sync_sweep_promises promise ON promise.id=point.promise_id
    WHERE point.airfoil_id=result.airfoil_id AND point.simulation_preset_revision_id=result.simulation_preset_revision_id
      AND point.aoa_deg=result.aoa_deg AND point.status='active' AND promise.status='active'
      AND promise."expiresAt">clock_timestamp() AND NOT EXISTS (SELECT FROM progressive_remote_dispatches own
        WHERE own.sim_job_id=${executionId}::uuid AND own.promise_id=promise.id))`;
}

function finalPointSignatures(report: ProgressiveRemoteReport) {
  const result = report.result;
  return new Set(result ? progressiveReportedPointSources({
    ...result, polars: result.polars.map(polar => ({ ...polar, attempts: [] })),
  }).map(source => source.contentSignature) : []);
}

type StoppedPublicationState = "cancelled" | "ingesting";

// The active-ingestion path keeps its usual authority unless an original
// sibling has already settled and the physical execution has actually stopped.
export async function stoppedPublicationState(db: DB, executionId: string): Promise<StoppedPublicationState | null> {
  const [row] = await db.execute(sql`SELECT job.status FROM sim_jobs job
    WHERE job.id=${executionId}::uuid AND job."ingestedAt" IS NULL AND (
      job.status='cancelled' OR (job.status='ingesting' AND job.request_payload#>>'{progressive,stage}'='3' AND job.engine_state IN ('completed','failed','cancelled')
        AND EXISTS (SELECT FROM progressive_cfd_execution_stops stop WHERE stop.sim_job_id=job.id AND stop.engine_job_id=job.id::text)
        AND EXISTS (SELECT FROM progressive_cfd_attempts sibling WHERE sibling.sim_job_id=job.id
          AND sibling.outcome IN ('complete','failed','cancelled') AND sibling.finished_at IS NOT NULL)))`);
  return row?.status === "cancelled" || row?.status === "ingesting" ? row.status : null;
}

// Caller holds this transaction through publication. This authorizes only the
// existing accepted result; it never changes an attempt, unit, recipe or receipt.
// Settlement can opt into occupied cells to validate their retained historical
// source under the same scope/owner gates. It must not pass those IDs to promotion.
// Canonical rows/classifications are observations here, not locked before the
// cache scope. Empty-slot publication revalidates them under cache locks below.
export async function readStoppedAcceptedProgressivePublication(
  db: DB,
  executionId: string,
  includeOccupied = false,
  status: StoppedPublicationState = "cancelled",
) {
  const ingesting = status === "ingesting";
  const [initial] = await db.execute(sql`SELECT campaign_id,request_payload->'progressive'->>'epochId' AS epoch_id
    FROM sim_jobs WHERE id=${executionId}::uuid AND status=${status} AND "ingestedAt" IS NULL`);
  if (!initial) return null;
  const [epoch] = await db.execute(sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`);
  if (epoch?.id !== initial.epoch_id) refuse();
  const [campaign] = await db.execute(sql`SELECT id,status,current_plan_revision_id FROM sim_campaigns
    WHERE id=${initial.campaign_id}::uuid FOR UPDATE`);
  if (!campaign || !["active", "attention", "paused", "completed"].includes(String(campaign.status))) refuse();
  const [job] = await db.execute(sql`SELECT job.airfoil_id,job.simulation_preset_revision_id,job.request_payload,
      dispatch.envelope,dispatch.solver_id,dispatch.promise_id,dispatch.content_signature,promise.status AS promise_status,promise.registered_solver_id,
      stopped.proof,stopped.proof_signature,stopped.epoch_id AS stopped_epoch_id
    FROM sim_jobs job JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=job.id
    JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=job.id AND stopped.engine_job_id=job.id::text
    JOIN registered_remote_solvers solver ON solver.id=dispatch.solver_id AND solver.revoked_at IS NULL
    JOIN sync_sweep_promises promise ON promise.id=dispatch.promise_id AND (${ingesting} OR promise.status<>'active')
    WHERE job.id=${executionId}::uuid AND job.engine_job_id=job.id::text AND job.campaign_id=${campaign.id}::uuid
      AND job.status=${status} AND job."ingestedAt" IS NULL
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
  const units = await db.execute(sql`SELECT attempt.token,attempt.owner,attempt.outcome,attempt.finished_at,attempt.execution_recipe_id,
      unit.lease_until<=statement_timestamp() AS lease_expired,
      NOT EXISTS(SELECT FROM progressive_cfd_attempts newer WHERE newer.unit_id=unit.id
        AND (newer.started_at,newer.token)>(attempt.started_at,attempt.token)) AS latest,
      ${laterPhysicalExecution()} AS physically_superseded,
      generation.status='active' AND ${effectiveProgressiveStageSql()}=work.stage AS current_stage,
      unit.id AS unit_id,unit.aoa_deg,unit.state,unit.lease_token,unit.lease_owner,unit.lease_until,
      unit.recipe AS current_recipe,recipe.recipe,recipe.source_revision_id,recipe.execution_revision_id,
      target_scope.revision_id AS current_source_revision_id,revision.snapshot,target.physical,target.airfoil_id,
      airfoil.points AS current_geometry,work.target_id,work.stage,generation.id AS generation_id,
      EXISTS(SELECT 1 FROM progressive_cfd_attempts live WHERE live.unit_id=unit.id AND live.token<>attempt.token AND live.outcome='running') AS competing
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
      (unit.outcome === "running" ? unit.finished_at != null
        : !["complete", "failed", "cancelled"].includes(String(unit.outcome)) || unit.finished_at == null) ||
      !envelope.scope.units.some((bound) => bound.token === unit.token && bound.unitId === unit.unit_id && bound.alpha === unit.aoa_deg))) refuse();
  // Recheck the mutable job after campaign/unit locking, in the same order as
  // normal evidence ingestion, and retain its lock until publication commits.
  const [locked] = await db.execute(sql`SELECT request_payload,status,engine_state,"ingestedAt",ingest_lease_token,
      ingest_lease_expires_at>clock_timestamp() AS ingest_live,ingest_lease_expires_at
    FROM sim_jobs WHERE id=${executionId}::uuid FOR UPDATE`);
  if (!locked || locked.status !== status || locked.ingestedAt != null ||
    analysisContentHash(locked.request_payload) !== analysisContentHash(payload) ||
    (locked.ingest_lease_token != null && (locked.ingest_live || locked.ingest_lease_expires_at == null))) refuse();
  // Occupied slots are inspected only for retiring the historical job. They
  // require complete whole-job retention, even when another point was published.
  const retained = includeOccupied
    ? await readProgressiveRemoteRetention(db, executionId)
    : await readStoppedPublicationSources(db, executionId);
  if (!retained || retained.kind === "waiting") return null;
  // Only current precise points can publish ahead of missing sibling evidence.
  // Retirement still uses whole-job retention in the settlement controller.
  const perPoint = ingesting || units.some(unit => unit.outcome === "running") ||
    (retained.kind === "verified_sources" && retained.incomplete);
  if (perPoint && (envelope.scope.stage !== 3 || job.registered_solver_id !== job.solver_id ||
      retained.report.status.state !== locked.engine_state || !retained.report.stopProof ||
      analysisContentHash(retained.report.stopProof) !== job.proof_signature ||
      !units.some(unit => unit.finished_at != null))) refuse();
  const final = finalPointSignatures(retained.report);
  const attemptIds: string[] = [];
  for (const entry of retained.sources) {
    if (entry.storageOnly || !entry.archived || !final.has(entry.delivery.progressiveEvidence.pointContentSignature)) continue;
    const [raw] = await db.execute(sql`SELECT raw.id,raw.result_id,raw.airfoil_id,raw.aoa_deg,raw.simulation_preset_revision_id,raw.regime,raw.converged,raw.stalled,
        result.current_result_attempt_id AS selected,result.sim_job_id AS cell_owner,
        ${foreignCellPromise(executionId)} AS foreign_promise,
        ${attemptDigestColumns(sql`raw`, true)},evidence.attempt_token,evidence.evidence_signature,result.airfoil_id AS cell_airfoil_id,
        result.aoa_deg AS cell_aoa_deg,result.simulation_preset_revision_id AS cell_revision_id
      FROM result_attempts raw JOIN progressive_cfd_evidence evidence ON evidence.result_attempt_id=raw.id
      JOIN result_classifications classification ON classification.result_attempt_id=raw.id AND classification.state='accepted'
      JOIN results result ON result.id=raw.result_id
      WHERE raw.id=${entry.resultAttemptId}::uuid AND raw.sim_job_id=${executionId}::uuid AND raw.engine_job_id=${executionId}
        AND raw.status='done' AND raw.valid_for_polar AND NOT ${progressiveBenchmarkAttemptSql(sql`raw.id`)}
        AND (${includeOccupied} OR result.current_result_attempt_id IS NULL)
        AND coalesce((SELECT review.verdict::text FROM result_review_verdicts review
          WHERE review.result_id=result.id AND review."revokedAt" IS NULL
          ORDER BY review."createdAt" DESC,review.id DESC LIMIT 1),'') NOT IN ('exclude','defer')`);
    if (!raw) continue;
    const unit = units.find((item) => item.token === raw.attempt_token && item.aoa_deg === raw.aoa_deg);
    if (!unit || unit.airfoil_id !== job.airfoil_id || raw.airfoil_id !== job.airfoil_id ||
      raw.cell_airfoil_id !== raw.airfoil_id || raw.cell_aoa_deg !== raw.aoa_deg ||
      raw.cell_revision_id !== raw.simulation_preset_revision_id || raw.simulation_preset_revision_id !== unit.execution_revision_id ||
      raw.simulation_preset_revision_id !== job.simulation_preset_revision_id ||
      unit.source_revision_id !== unit.current_source_revision_id ||
      canonicalAnalysisJson(unit.current_recipe) !== canonicalAnalysisJson(unit.recipe) ||
      analysisContentHash({ sourceRevisionId: unit.source_revision_id, recipe: unit.recipe }) !== unit.execution_recipe_id ||
      !matchesOriginalAttemptDigest(raw, raw.evidence_signature)) refuse();
    const unleased = unit.lease_token == null && unit.lease_owner == null && unit.lease_until == null;
    const retired = unit.outcome !== "running" && unleased && ["pending","gap","complete"].includes(String(unit.state));
    if (raw.selected == null && (raw.foreign_promise || unit.physically_superseded ||
        (raw.cell_owner != null && raw.cell_owner !== executionId))) continue;
    if (perPoint) {
      const precise = raw.regime === "rans" ? raw.converged === true && raw.stalled !== true
        : raw.regime === "urans" && (raw.evidence_payload as Record<string, unknown>)?.fidelity === "urans_full";
      if (!precise) continue;
      // A signed source belongs to its own original token. An omitted sibling
      // may already have failed or acquired another owner. Neither grants this
      // point a lease. Leave a contested point pending while publishing its peers.
      const originalLease = unit.state === "leased" && unit.lease_token === unit.token &&
        unit.lease_owner === unit.owner && unit.lease_expired === true;
      const stoppedOwner = ingesting && unit.outcome === "running" && (originalLease || (unit.state === "blocked" && unleased));
      if (!unit.current_stage || !unit.latest || unit.competing ||
          !(stoppedOwner || (retired && job.promise_status !== "active"))) continue;
    } else if (!retired || unit.competing) continue;
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
  const retained = await readStoppedPublicationSources(db, executionId);
  if (!retained?.report.result) refuse();
  const final = finalPointSignatures(retained.report);
  if (attemptIds.some(id => !retained.sources.some(source => source.resultAttemptId === id && source.archived &&
      !source.storageOnly && final.has(source.delivery.progressiveEvidence.pointContentSignature)))) refuse();
  const rows = await db.execute(sql`SELECT result.id,result.current_result_attempt_id,result.sim_job_id,
      owner.status AS owner_status,owner.ingest_lease_token,owner.ingest_lease_expires_at,
      owner.ingest_lease_expires_at>clock_timestamp() AS ingest_live
    FROM result_attempts raw JOIN results result ON result.id=raw.result_id LEFT JOIN sim_jobs owner ON owner.id=result.sim_job_id
    JOIN result_classifications classification ON classification.result_attempt_id=raw.id AND classification.state='accepted'
    JOIN progressive_cfd_evidence receipt ON receipt.result_attempt_id=raw.id
    JOIN progressive_cfd_attempts attempt ON attempt.token=receipt.attempt_token AND attempt.sim_job_id=raw.sim_job_id
    JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id AND unit.aoa_deg=raw.aoa_deg
    WHERE raw.id IN (${sql.join(attemptIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND NOT ${laterPhysicalExecution()}
      AND NOT EXISTS (SELECT FROM progressive_cfd_attempts competing WHERE competing.unit_id=unit.id
        AND competing.token<>attempt.token AND competing.outcome='running')
      AND ((unit.lease_token IS NULL AND unit.lease_owner IS NULL AND unit.lease_until IS NULL)
        OR (unit.state='leased' AND unit.lease_token=attempt.token AND unit.lease_owner=attempt.owner
          AND unit.lease_until<=statement_timestamp()))
      AND raw.airfoil_id=result.airfoil_id AND raw.simulation_preset_revision_id=result.simulation_preset_revision_id
      AND result.aoa_deg=raw.aoa_deg AND NOT ${foreignCellPromise(executionId)}
      AND (result.sim_job_id IS NULL OR result.sim_job_id=raw.sim_job_id)
      AND NOT ${progressiveBenchmarkAttemptSql(sql`raw.id`)}
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
