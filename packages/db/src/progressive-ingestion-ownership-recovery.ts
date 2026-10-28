import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import { acquireProgressiveAdmissionLock } from "./progressive-admission-lock";
import { assertProgressiveCfdEvidenceJob } from "./progressive-cfd-evidence";
import { progressiveCfdEffectiveBudgetSql } from "./progressive-cfd-budget-extension";
import { validateProgressiveExecutionStopProof } from "./progressive-cfd-settlement";
import { effectiveProgressiveStageSql } from "./progressive-execution-policy";
import { assertProgressiveExecutionIdentity } from "./progressive-execution-identity";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import { progressiveRemoteReportInventory } from "./progressive-remote-inventory";
import { assertProgressiveRemotePhysicalCase } from "./progressive-remote-point-projection";
import {
  isFinalProgressiveRemoteReport,
  progressiveReportedPointSources,
  validateProgressiveRemoteReport,
} from "./progressive-remote-report";
import { assertProgressiveStorageEvidenceRecoveryHost } from "./progressive-storage-recovery-scope";
import type { EngineExecutionStopProof } from "../../engine-client/src/types";

const FAILURE = "terminal execution has no measured case evidence";
const RETRY = "Retrying after terminal execution without measurable case evidence";
const DEFERRED = "Another execution owns these result cells; preparation deferred";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_UNITS = 64;

export interface ProgressiveIngestionRecoverySelection {
  jobId: string;
  solverId: string;
  promiseId: string;
  unitIds: string[];
  expectedUnitCount: number;
}

export interface ProgressiveIngestionRecoveryManifest {
  version: 1;
  selection: ProgressiveIngestionRecoverySelection;
  stateSignature: string;
  signature: string;
}

function requireRecovery(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Ingestion ownership recovery: ${reason}`);
}

export function parseProgressiveIngestionRecoverySelection(
  value: unknown,
): ProgressiveIngestionRecoverySelection {
  const input = value as Partial<ProgressiveIngestionRecoverySelection> | null;
  requireRecovery(input && typeof input === "object", "selection is required");
  for (const identity of [input.jobId, input.solverId, input.promiseId])
    requireRecovery(typeof identity === "string" && UUID.test(identity), "exact job, solver and promise IDs are required");
  requireRecovery(
    Array.isArray(input.unitIds) && input.unitIds.length > 0 && input.unitIds.length <= MAX_UNITS &&
    input.unitIds.every((identity) => typeof identity === "string" && UUID.test(identity)) &&
    Number.isSafeInteger(input.expectedUnitCount) && input.expectedUnitCount === input.unitIds.length,
    "exact unit IDs and matching bounded expectedUnitCount are required",
  );
  const unitIds = input.unitIds.map((identity) => identity.toLowerCase()).sort();
  requireRecovery(new Set(unitIds).size === unitIds.length, "selection repeats a unit");
  return {
    jobId: input.jobId!.toLowerCase(),
    solverId: input.solverId!.toLowerCase(),
    promiseId: input.promiseId!.toLowerCase(),
    unitIds,
    expectedUnitCount: input.expectedUnitCount!,
  };
}

function validateManifest(
  manifest: ProgressiveIngestionRecoveryManifest,
  selection: ProgressiveIngestionRecoverySelection,
) {
  requireRecovery(manifest?.version === 1 && HASH.test(manifest.stateSignature) && HASH.test(manifest.signature), "invalid dry-run manifest");
  requireRecovery(
    canonicalAnalysisJson(manifest.selection) === canonicalAnalysisJson(selection) &&
    manifest.signature === analysisContentHash({ version: 1, selection, stateSignature: manifest.stateSignature }),
    "dry-run manifest identity or signature changed",
  );
}

export async function recoverProgressiveIngestionOwnership(
  db: DB,
  requested: ProgressiveIngestionRecoverySelection,
  options: { apply?: boolean; manifest?: ProgressiveIngestionRecoveryManifest } = {},
) {
  const selection = parseProgressiveIngestionRecoverySelection(requested);
  requireRecovery(!options.apply || options.manifest, "apply requires the reviewed dry-run manifest");
  if (options.manifest) validateManifest(options.manifest, selection);
  const mode = options.apply ? "apply" as const : "dry-run" as const;
  const rollback = new Error("Rollback ingestion ownership dry run");
  let result: {
    mode: "apply" | "dry-run";
    manifest: ProgressiveIngestionRecoveryManifest;
    eligibleUnitIds: string[];
    restoredUnitIds: string[];
    replayed: boolean;
    receiptAttemptTokens: string[];
  } | undefined;
  await db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await connection.execute(sql`SET LOCAL statement_timeout = '20s'`);
    await assertProgressiveStorageEvidenceRecoveryHost(connection);
    await acquireProgressiveAdmissionLock(connection);
    const [assigned] = await connection.execute(sql`
      SELECT dispatch.*, job.campaign_id FROM progressive_remote_dispatches dispatch
      JOIN sim_jobs job ON job.id = dispatch.sim_job_id
      WHERE dispatch.sim_job_id = ${selection.jobId}::uuid
    `);
    requireRecovery(assigned, "original remote dispatch is missing");
    const envelope = verifyProgressiveRemoteExecution(assigned.envelope, {
      executionId: selection.jobId, solverId: selection.solverId,
      promiseId: selection.promiseId, contentSignature: String(assigned.content_signature),
    });
    requireRecovery(assigned.solver_id === selection.solverId && assigned.promise_id === selection.promiseId, "foreign solver or promise");
    const [epoch] = await connection.execute(sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`);
    requireRecovery(epoch?.id === envelope.scope.epochId, "obsolete epoch");
    const [campaign] = await connection.execute(sql`
      SELECT id, status, current_plan_revision_id FROM sim_campaigns
      WHERE id = ${assigned.campaign_id}::uuid FOR UPDATE
    `);
    requireRecovery(campaign && ["active", "attention", "paused"].includes(String(campaign.status)), "campaign is closed");
    const [generation] = await connection.execute(sql`
      SELECT id, campaign_id, epoch_id, plan_revision_id, status FROM progressive_generations
      WHERE id = ${envelope.scope.generationId}::uuid FOR UPDATE
    `);
    requireRecovery(generation?.campaign_id === campaign.id && generation.epoch_id === epoch!.id &&
      generation.plan_revision_id === campaign.current_plan_revision_id && generation.status === "active", "current plan or generation changed");
    const [work] = await connection.execute(sql`
      SELECT work.id, work.state, work.stage, ${effectiveProgressiveStageSql()} AS effective_stage
      FROM progressive_work work JOIN progressive_generations generation ON generation.id = work.generation_id
      WHERE work.generation_id = ${generation.id}::uuid AND work.target_id = ${envelope.scope.targetId}
        AND work.stage = ${envelope.scope.stage} FOR UPDATE OF work
    `);
    requireRecovery(work?.state === "pending" && work.stage === work.effective_stage, "work or effective stage changed");
    await connection.execute(sql`
      SELECT unit.id FROM progressive_cfd_units unit
      JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id
      WHERE attempt.sim_job_id = ${selection.jobId}::uuid ORDER BY unit.ordinal, unit.id FOR UPDATE OF unit
    `);
    await connection.execute(sql`
      SELECT attempt.token FROM progressive_cfd_attempts attempt
      JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
      WHERE attempt.sim_job_id = ${selection.jobId}::uuid ORDER BY unit.ordinal, unit.id, attempt.token FOR UPDATE OF attempt
    `);
    const [job] = await connection.execute(sql`
      SELECT job.*, to_jsonb(job) - 'request_payload' - 'strip_report' AS prior_job,
        (ingest_lease_expires_at > clock_timestamp() OR
          (ingest_lease_expires_at IS NULL AND (ingest_lease_token IS NOT NULL OR
            "updatedAt" > clock_timestamp() - interval '10 minutes'))) AS live_ingest
      FROM sim_jobs job WHERE id = ${selection.jobId}::uuid FOR UPDATE
    `);
    requireRecovery(job?.campaign_id === campaign.id, "job campaign changed");
    assertProgressiveExecutionIdentity(selection.jobId, String(job.engine_job_id), job.request_payload);
    const request = job.request_payload as { progressive: unknown; engineRequest: unknown };
    requireRecovery(analysisContentHash(request.progressive) === analysisContentHash(envelope.scope) &&
      analysisContentHash(request.engineRequest) === analysisContentHash(envelope.request), "immutable request changed");
    const [solver] = await connection.execute(sql`
      SELECT id, revoked_at FROM registered_remote_solvers WHERE id = ${selection.solverId}::uuid FOR SHARE
    `);
    const [dispatch] = await connection.execute(sql`
      SELECT content_signature, solver_id, promise_id FROM progressive_remote_dispatches
      WHERE sim_job_id = ${selection.jobId}::uuid FOR SHARE
    `);
    const [promise] = await connection.execute(sql`
      SELECT id, registered_solver_id, airfoil_id, simulation_preset_revision_id, status
      FROM sync_sweep_promises WHERE id = ${selection.promiseId}::uuid FOR SHARE
    `);
    requireRecovery(solver && solver.revoked_at === null && dispatch?.content_signature === envelope.contentSignature &&
      dispatch.solver_id === solver.id && dispatch.promise_id === promise?.id && promise.registered_solver_id === solver.id &&
      promise.airfoil_id === job.airfoil_id && promise.simulation_preset_revision_id === job.simulation_preset_revision_id &&
      ["active", "expired", "fulfilled"].includes(String(promise.status)), "foreign, revoked or cancelled assignment");
    const selectedIds = sql.join(selection.unitIds.map((identity) => sql`${identity}::uuid`), sql`, `);
    const receipts = await connection.execute(sql`
      SELECT receipt.*, NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts newer
        JOIN progressive_cfd_attempts original ON original.token = receipt.attempt_token
        WHERE newer.unit_id = receipt.unit_id AND (newer.started_at, newer.token) > (original.started_at, original.token)) AS latest
      FROM progressive_ingestion_ownership_recoveries receipt
      WHERE receipt.sim_job_id = ${selection.jobId}::uuid AND receipt.unit_id IN (${selectedIds})
      ORDER BY receipt.unit_id
    `);
    if (receipts.length) {
      requireRecovery(options.manifest && receipts.length === selection.expectedUnitCount && receipts.every((receipt) =>
        receipt.latest === true && receipt.manifest_signature === options.manifest!.signature &&
        canonicalAnalysisJson(receipt.manifest) === canonicalAnalysisJson(options.manifest)), "existing recovery receipt differs or has a newer owner");
      result = { mode, manifest: options.manifest!, eligibleUnitIds: selection.unitIds, restoredUnitIds: [],
        replayed: true, receiptAttemptTokens: receipts.map((receipt) => String(receipt.attempt_token)) };
      return;
    }
    requireRecovery(job.status === "ingesting" && job.ingestedAt === null &&
      ["completed", "failed"].includes(String(job.engine_state)) && job.live_ingest !== true,
      "job is not stopped ingestion work without a competing ingest lease");
    const [stopped] = await connection.execute(sql`
      SELECT epoch_id, engine_job_id, proof, proof_signature FROM progressive_cfd_execution_stops
      WHERE sim_job_id = ${selection.jobId}::uuid FOR SHARE
    `);
    requireRecovery(stopped?.engine_job_id === selection.jobId && stopped.epoch_id === epoch!.id, "exact physical stop is missing");
    validateProgressiveExecutionStopProof(stopped.proof as EngineExecutionStopProof);
    requireRecovery(analysisContentHash(stopped.proof) === stopped.proof_signature, "physical stop signature differs");
    requireRecovery((stopped.proof as EngineExecutionStopProof).job_id === selection.jobId, "foreign physical stop");
    const [latest] = await connection.execute(sql`
      SELECT sequence, content_signature, report FROM progressive_remote_reports
      WHERE sim_job_id = ${selection.jobId}::uuid ORDER BY sequence DESC LIMIT 1 FOR SHARE
    `);
    requireRecovery(latest, "final report is missing");
    const validated = validateProgressiveRemoteReport(latest.report, envelope);
    const report = validated.report;
    requireRecovery(validated.contentSignature === latest.content_signature && isFinalProgressiveRemoteReport(report) &&
      report.result && report.stopProof && report.status.state === job.engine_state, "final report hash, state or stop proof differs");
    validateProgressiveExecutionStopProof(report.stopProof);
    requireRecovery(
      analysisContentHash(report.stopProof) === stopped.proof_signature &&
      canonicalAnalysisJson(report.stopProof) === canonicalAnalysisJson(stopped.proof),
      "final report stop proof differs from the stored physical stop",
    );
    const inventory = progressiveRemoteReportInventory(report);
    const [indexed] = await connection.execute(sql`
      SELECT report_content_signature, inventory_signature, source_count FROM progressive_remote_report_inventories
      WHERE sim_job_id = ${selection.jobId}::uuid AND sequence = ${report.sequence}
    `);
    const indexedSources = await connection.execute(sql`
      SELECT point_content_signature, aoa_deg, case_slug FROM progressive_remote_report_sources
      WHERE sim_job_id = ${selection.jobId}::uuid AND sequence = ${report.sequence} ORDER BY point_content_signature
    `);
    requireRecovery(indexed?.report_content_signature === validated.contentSignature &&
      indexed.inventory_signature === inventory.inventorySignature && Number(indexed.source_count) === inventory.sources.length &&
      canonicalAnalysisJson([...indexedSources]) === canonicalAnalysisJson(inventory.sources), "final source inventory differs");
    const rows = await connection.execute(sql`
      SELECT attempt.token, attempt.owner, attempt.execution_recipe_id, attempt.outcome, attempt.error,
        attempt.active_seconds AS attempt_seconds, to_jsonb(attempt) AS prior_attempt,
        unit.id, unit.work_id, unit.aoa_deg, unit.state, unit.lease_token, unit.lease_owner, unit.lease_until,
        unit.active_seconds, unit.error AS unit_error, to_jsonb(unit) AS prior_unit,
        ${progressiveCfdEffectiveBudgetSql(sql`unit`)} AS effective_budget,
        recipe.execution_revision_id, recipe.source_revision_id, recipe.recipe, revision.snapshot,
        NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts newer WHERE newer.unit_id = unit.id
          AND (newer.started_at, newer.token) > (attempt.started_at, attempt.token)) AS latest,
        EXISTS (SELECT 1 FROM progressive_cfd_attempts running WHERE running.unit_id = unit.id AND running.outcome = 'running') AS running,
        EXISTS (SELECT 1 FROM progressive_cfd_evidence evidence WHERE evidence.attempt_token = attempt.token) AS linked
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
      JOIN progressive_cfd_execution_recipes recipe ON recipe.id = attempt.execution_recipe_id
      JOIN simulation_preset_revisions revision ON revision.id = recipe.execution_revision_id
      WHERE attempt.sim_job_id = ${selection.jobId}::uuid AND unit.id IN (${selectedIds}) ORDER BY unit.id
    `);
    requireRecovery(rows.length === selection.expectedUnitCount, "selected unit count or execution recipe changed");
    const sources = progressiveReportedPointSources(report.result);
    const prepared = [];
    for (const row of rows) {
      const original = envelope.scope.units.find((unit) => unit.unitId === row.id);
      requireRecovery(original, "selected unit is outside the immutable dispatch scope");
      requireRecovery(original.token === row.token && original.alpha === Number(row.aoa_deg) &&
        row.work_id === work.id && row.execution_recipe_id === envelope.scope.recipeId &&
        analysisContentHash({ sourceRevisionId: row.source_revision_id, recipe: row.recipe }) === row.execution_recipe_id,
        "original token, AoA, preset revision or recipe differs");
      requireRecovery(row.latest === true && row.running === false && row.linked === false &&
        row.outcome === "failed" && row.error === FAILURE && ["pending", "gap"].includes(String(row.state)) &&
        [FAILURE, RETRY, DEFERRED].includes(String(row.unit_error)) && row.lease_token === null && row.lease_owner === null && row.lease_until === null,
        "unit is not the latest unleased no-evidence failure");
      requireRecovery(Number.isFinite(Number(row.active_seconds)) && Number.isFinite(Number(row.attempt_seconds)) &&
        Number(row.active_seconds) >= Number(row.attempt_seconds) && Number(row.attempt_seconds) >= 0 &&
        Number(row.active_seconds) < Number(row.effective_budget), "unit budget is exhausted or inconsistent");
      const physical = sources.filter(({ point }) => point.aoa_deg === Number(row.aoa_deg) &&
        ([point.cl, point.cd, point.cm].some((value) => typeof value === "number" && Number.isFinite(value)) ||
          (point.evidence_artifacts?.length ?? 0) > 0));
      requireRecovery(physical.length === 1, "selected AoA has no unique physical source");
      const source = physical[0];
      assertProgressiveRemotePhysicalCase({ ...source, envelope, report }, row.snapshot as Parameters<typeof assertProgressiveRemotePhysicalCase>[1]);
      const existing = await connection.execute(sql`
        SELECT result_attempt_id FROM progressive_remote_evidence_receipts
        WHERE sim_job_id = ${selection.jobId}::uuid AND point_content_signature = ${source.contentSignature}
      `);
      requireRecovery(existing.length === 0, "source already has an evidence receipt");
      const cells = await connection.execute(sql`
        SELECT cell.id, cell.sim_job_id, cell.status, cell.current_result_attempt_id,
          EXISTS (SELECT 1 FROM result_classifications classification
            WHERE classification.result_id = cell.id AND classification.state = 'accepted') AS accepted
        FROM results cell WHERE cell.airfoil_id = ${job.airfoil_id}::uuid
          AND cell.simulation_preset_revision_id = ${row.execution_revision_id}::uuid AND cell.aoa_deg = ${row.aoa_deg}
        FOR UPDATE OF cell
      `);
      requireRecovery(cells.length === 1, "exact canonical result cell is missing or ambiguous");
      const cell = cells[0];
      requireRecovery((cell.sim_job_id === null || cell.sim_job_id === selection.jobId) &&
        cell.current_result_attempt_id === null && cell.accepted === false && cell.status !== "done",
        "canonical result cell has another claim or accepted generation");
      const promised = await connection.execute(sql`
        SELECT id FROM sync_sweep_promise_points WHERE promise_id = ${selection.promiseId}::uuid
          AND airfoil_id = ${job.airfoil_id}::uuid AND simulation_preset_revision_id = ${row.execution_revision_id}::uuid
          AND aoa_deg = ${row.aoa_deg} AND status IN ('active', 'expired') AND result_id IS NULL AND result_attempt_id IS NULL
        FOR SHARE
      `);
      requireRecovery(promised.length === 1, "original promise point is fulfilled, foreign or closed");
      prepared.push({ row, source, cell, promisePointId: promised[0].id });
    }
    const priorJob = job.prior_job as Record<string, unknown>;
    const criticalJob = Object.fromEntries([
      "id", "campaign_id", "airfoil_id", "simulation_preset_revision_id", "engine_job_id", "engine_state", "status",
      "ingestedAt", "ingest_lease_token", "ingest_lease_claimed_at", "ingest_lease_expires_at",
    ].map((key) => [key, priorJob[key]]));
    const stateSignature = analysisContentHash({
      job: criticalJob, request: analysisContentHash(job.request_payload), campaign, generation, work,
      dispatch: envelope.contentSignature, promise, stop: stopped.proof,
      report: validated.contentSignature, inventory: inventory.inventorySignature,
      units: prepared.map(({ row, source, cell, promisePointId }) => ({
        attempt: row.prior_attempt,
        unit: Object.fromEntries(Object.entries(row.prior_unit as Record<string, unknown>).filter(([key]) => key !== "retry_after")),
        effectiveBudget: Number(row.effective_budget),
        source: source.contentSignature, cell, promisePointId,
      })),
    });
    const unsigned = { version: 1 as const, selection, stateSignature };
    const manifest = { ...unsigned, signature: analysisContentHash(unsigned) };
    requireRecovery(!options.manifest || options.manifest.signature === manifest.signature, "dry-run state drifted; nothing restored");
    const [lease] = await connection.execute(sql`SELECT clock_timestamp() + interval '10 minutes' AS until`);
    const leaseUntil = (lease.until instanceof Date ? lease.until : new Date(String(lease.until))).toISOString();
    for (const { row } of prepared) {
      const changedAttempt = await connection.execute(sql`
        UPDATE progressive_cfd_attempts SET outcome = 'running', finished_at = NULL, error = NULL, lease_until = ${leaseUntil}::timestamptz
        WHERE token = ${row.token}::uuid AND sim_job_id = ${selection.jobId}::uuid AND outcome = 'failed' AND error = ${FAILURE}
        RETURNING token
      `);
      const changedUnit = await connection.execute(sql`
        UPDATE progressive_cfd_units SET state = 'leased', lease_token = ${row.token}::uuid,
          lease_owner = ${row.owner}, lease_until = ${leaseUntil}::timestamptz, retry_after = NULL, error = NULL
        WHERE id = ${row.id}::uuid AND state IN ('pending', 'gap')
          AND lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL RETURNING id
      `);
      requireRecovery(changedAttempt.length === 1 && changedUnit.length === 1, "ownership changed during restoration");
    }
    requireRecovery(await assertProgressiveCfdEvidenceJob(connection, selection.jobId, selection.jobId,
      prepared.map(({ source }) => ({ alpha: source.point.aoa_deg, speed: source.polar.speed,
        chord: source.polar.chord, solverActiveSeconds: source.point.solver_active_seconds }))), "strict ingestion scope is unavailable");
    for (const { row, source, cell } of prepared) {
      await connection.execute(sql`
        INSERT INTO progressive_ingestion_ownership_recoveries
          (attempt_token, unit_id, sim_job_id, manifest_signature, manifest, prior_state, restored_lease_until)
        VALUES (${row.token}::uuid, ${row.id}::uuid, ${selection.jobId}::uuid, ${manifest.signature},
          ${canonicalAnalysisJson(manifest)}::jsonb,
          ${canonicalAnalysisJson({ attempt: row.prior_attempt, unit: row.prior_unit, job: job.prior_job,
            dispatchSignature: envelope.contentSignature, reportSequence: report.sequence,
            reportSignature: validated.contentSignature, pointSignature: source.contentSignature, resultId: cell.id })}::jsonb,
          ${leaseUntil}::timestamptz)
      `);
    }
    result = { mode, manifest, eligibleUnitIds: selection.unitIds,
      restoredUnitIds: options.apply ? selection.unitIds : [], replayed: false,
      receiptAttemptTokens: options.apply ? prepared.map(({ row }) => String(row.token)) : [] };
    if (!options.apply) throw rollback;
  }).catch((error) => { if (error !== rollback) throw error; });
  requireRecovery(result, "operation returned no receipt");
  return result;
}
