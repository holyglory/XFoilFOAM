import { sql } from "drizzle-orm";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import type { DB } from "./client";
import { effectiveProgressiveStageSql } from "./progressive-execution-policy";
import { progressiveCfdEffectiveBudgetSql } from "./progressive-cfd-budget-extension";
import type { JobStatus } from "../../engine-client/src/types";
import {
  resolveSolverCaseAllocations,
  solverBudgetCaseKey,
} from "../../engine-client/src/solver-budget";
import { assertProgressiveExecutionIdentity } from "./progressive-execution-identity";
import { readProgressiveRemoteRetention, readProgressiveRemoteSourceClassifications } from "./progressive-remote-retention";
import { assertStoppedProgressiveStorage } from "./progressive-stopped-storage";
import { resolveProgressiveRemoteEvidence, assertProgressiveReportedManifest, ProgressiveRemoteEvidenceConflict, type ProgressiveRemoteEvidenceReference } from "./progressive-remote-evidence";
import { readProgressiveDiagnosticRecoverySources } from "./progressive-cfd-diagnostic-recovery";
import { progressiveRemotePointProjection, assertProgressiveRemotePhysicalCase } from "./progressive-remote-point-projection";
import { progressiveReportedPointSources } from "./progressive-remote-report";
import type { ProgressiveRemoteEvidenceDelivery } from "./progressive-remote-evidence-receipts";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import {
  assertProgressiveStorageEvidenceRecoveryHost,
  assertProgressiveStorageEvidenceRecoveryRole,
  lockProgressiveStorageRecoveryUnits,
  ProgressiveCfdEvidenceScopeClosed,
  ProgressiveCfdEvidenceScopePending,
  type ProgressiveStorageEvidenceRecoveryScope,
} from "./progressive-storage-recovery-scope";
export {
  assertProgressiveStorageEvidenceRecoveryRole,
  ProgressiveCfdEvidenceScopeClosed,
  ProgressiveCfdEvidenceScopePending,
  type ProgressiveStorageEvidenceRecoveryScope,
} from "./progressive-storage-recovery-scope";

interface BoundUnit {
  token: string;
  owner: string;
  unit_id: string;
  aoa_deg: number;
  active_seconds: number;
  unit_seconds: number;
  active_budget_seconds: number;
  effective_budget_seconds: number;
  budget_guard_confirmed: boolean;
  state: string;
  outcome: string;
  execution_revision_id: string;
  generation_id: string;
  epoch_id: string;
  target_id: string;
  execution_recipe_id: string;
  stage: number;
  lease_token: string | null;
  lease_owner: string | null;
  lease_until: Date | string | null;
  work_state: string;
  latest_attempt: boolean;
  has_case_history: boolean;
  requested_budget_seconds?: number;
  snapshot: {
    flowState: { speedMps: number };
    referenceGeometry: { referenceLengthM: number };
    derived?: { mach?: number | null };
  };
}

type JobScopePolicy = "strict" | "runtime" | "stopped-failed-storage";

function isRuntimeProgressActiveUnit(unit: BoundUnit): boolean {
  return (
    unit.latest_attempt === true &&
    unit.outcome === "running" &&
    ["leased", "blocked"].includes(unit.state)
  );
}

function isRuntimeProgressObsoleteUnit(unit: BoundUnit): boolean {
  return (
    !isRuntimeProgressActiveUnit(unit) &&
    (!unit.latest_attempt ||
      ["complete", "failed", "expired", "cancelled"].includes(unit.outcome) ||
      ["complete", "gap", "cancelled"].includes(unit.state))
  );
}

function isStoppedFailedStorageUnit(unit: BoundUnit): boolean {
  if (!unit.latest_attempt) return false;
  const unowned = unit.lease_token == null && unit.lease_owner == null && unit.lease_until == null;
  return (unit.outcome === "failed" && ["gap", "pending"].includes(unit.state) && unowned) ||
    (unit.outcome === "running" && ((unit.state === "blocked" && unowned) ||
      (unit.state === "leased" && unit.lease_token === unit.token &&
        unit.lease_owner === unit.owner && unit.lease_until != null)));
}

async function lockJobScope(
  db: DB,
  simJobId: string,
  engineJobId: string,
  options: {
    recoveryScope?: ProgressiveStorageEvidenceRecoveryScope;
    policy?: JobScopePolicy;
    evidenceAoas?: readonly number[];
    terminalDiagnostics?: boolean;
    diagnosticRecovery?: ProgressiveRemoteEvidenceReference & { receiptSignature?: string; historySignature?: string };
  } = {},
) {
  const recoveryScope = options.recoveryScope;
  const policy = options.policy ?? "strict";
  const selectedAoas = options.evidenceAoas ? new Set(options.evidenceAoas) : null;
  if (selectedAoas && ((policy !== "strict" && policy !== "stopped-failed-storage") || recoveryScope || !selectedAoas.size ||
    selectedAoas.size > 2048 || [...selectedAoas].some((alpha) => !Number.isFinite(alpha))))
    throw new Error("Invalid exact CFD evidence case selection");
  if (policy === "stopped-failed-storage" && (!selectedAoas || selectedAoas.size !== 1))
    throw new Error("Stopped failure storage requires one exact selected case");
  if (recoveryScope) await assertProgressiveStorageEvidenceRecoveryHost(db);
  const [job] = await db.execute(sql`
    SELECT job.airfoil_id, job.engine_job_id, job.campaign_id, job.status, job."ingestedAt", job.ingest_lease_expires_at,
      job.request_payload, job.request_payload->'progressive' AS progressive,
      job.request_payload->'engineRequest'->'resources' AS requested_resources,
      job.request_payload->'engineRequest'->'expected_solver_budget_version' AS requested_budget_version,
      EXISTS (SELECT 1 FROM progressive_cfd_attempts attempt WHERE attempt.sim_job_id = job.id) AS bound
    FROM sim_jobs job WHERE job.id = ${simJobId}
  `);
  if (!job)
    throw new ProgressiveCfdEvidenceScopeClosed(
      "Solver evidence job is missing",
    );
  if (job.progressive == null && !job.bound) return null;
  if (job.bound && job.progressive && job.engine_job_id === null)
    throw new ProgressiveCfdEvidenceScopePending(
      "Progressive CFD execution ownership is awaiting report processing",
    );
  if (!job.bound || !job.progressive || job.engine_job_id !== engineJobId)
    throw new ProgressiveCfdEvidenceScopeClosed(
      "Progressive CFD evidence has no exact engine/job ownership",
    );
  if (
    recoveryScope &&
    (!recoveryScope.campaignId ||
      job.campaign_id !== recoveryScope.campaignId ||
      (job.progressive as Record<string, unknown>).generationId !==
        recoveryScope.generationId ||
      (job.progressive as Record<string, unknown>).stage !==
        recoveryScope.stage ||
      !["done", "failed", "cancelled"].includes(String(job.status)) ||
      job.ingestedAt == null ||
      (job.ingest_lease_expires_at != null &&
        new Date(String(job.ingest_lease_expires_at)).getTime() > Date.now()))
  )
    throw new ProgressiveCfdEvidenceScopeClosed(
      "Historical progressive evidence recovery requires a terminal, ingested execution with no active ingest lease",
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
  if (
    !epoch ||
    metadata.epochId !== epoch.id ||
    (recoveryScope && String(epoch.id) !== recoveryScope.epochId)
  )
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
  if (
    recoveryScope &&
    (String(campaign.current_plan_revision_id) !==
      recoveryScope.planRevisionId ||
      String(job.campaign_id) !== recoveryScope.campaignId)
  )
    throw new ProgressiveCfdEvidenceScopeClosed(
      "Historical progressive evidence recovery does not match the current campaign plan",
    );
  if (recoveryScope)
    await lockProgressiveStorageRecoveryUnits(db, recoveryScope, simJobId);
  const diagnosticRecovery = options.diagnosticRecovery
    ? await readProgressiveDiagnosticRecoverySources(db, simJobId, options.diagnosticRecovery)
    : null;
  if (options.diagnosticRecovery && !diagnosticRecovery) return null;
  const units = (await db.execute(sql`
    SELECT attempt.token, attempt.owner, unit.id AS unit_id, unit.aoa_deg, attempt.active_seconds, unit.active_seconds AS unit_seconds,
      unit.active_budget_seconds, ${progressiveCfdEffectiveBudgetSql(sql`unit`)} AS effective_budget_seconds,
      unit.state, attempt.outcome, recipe.execution_revision_id,
      unit.lease_token, unit.lease_owner, unit.lease_until, work.state AS work_state,
      NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts newer WHERE newer.unit_id = unit.id
        AND (newer.started_at, newer.token) > (attempt.started_at, attempt.token)) AS latest_attempt,
      ${options.diagnosticRecovery ? sql`(EXISTS (SELECT 1 FROM progressive_cfd_evidence evidence
          JOIN progressive_cfd_attempts history ON history.token = evidence.attempt_token WHERE history.unit_id = unit.id)
        OR EXISTS (SELECT 1 FROM result_attempts raw WHERE raw.sim_job_id = attempt.sim_job_id AND raw.aoa_deg = unit.aoa_deg)
        OR EXISTS (SELECT 1 FROM progressive_cfd_runtime_progress runtime
          JOIN progressive_cfd_attempts history ON history.token = runtime.attempt_token
          WHERE history.unit_id = unit.id AND runtime.active_seconds > 0))` : sql`false`} AS has_case_history,
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
      AND generation.status = 'active' AND ${effectiveProgressiveStageSql()} = work.stage
    ORDER BY unit.ordinal, unit.id
    ${recoveryScope ? sql`` : sql`FOR UPDATE OF generation, work, unit, attempt`}
  `)) as unknown as BoundUnit[];
  const [count] = await db.execute(
    sql`SELECT count(*)::integer AS count FROM progressive_cfd_attempts WHERE sim_job_id = ${simJobId}`,
  );
  if (selectedAoas && [...selectedAoas].some((alpha) => !units.some((unit) => unit.aoa_deg === alpha)))
    throw new ProgressiveCfdEvidenceScopeClosed("Progressive CFD delivery changed its exact physical scope");
  const diagnosticCandidates = policy === "strict" && (selectedAoas || options.terminalDiagnostics) ? units.filter((unit) =>
    (options.terminalDiagnostics || !selectedAoas?.has(unit.aoa_deg)) && unit.latest_attempt && unit.outcome === "failed" &&
    ["gap", "pending"].includes(unit.state) && unit.lease_token == null && unit.lease_until == null,
  ) : [];
  const diagnostics = diagnosticCandidates.length ? await readProgressiveRemoteSourceClassifications(
    db, simJobId, diagnosticCandidates.map((unit) => unit.aoa_deg),
  ) : [];
  const retainedDiagnostics = new Set(diagnosticCandidates.filter((unit) => {
    const sources = diagnostics.filter((source) => source.aoaDeg === unit.aoa_deg);
    return sources.length > 0 && sources.every((source) => source.kind === "material_diagnostic" ||
      (!options.terminalDiagnostics && selectedAoas !== null && unit.lease_owner == null &&
        source.kind === "failure_diagnostic"));
  }).map((unit) => unit.token));
  if (options.terminalDiagnostics && retainedDiagnostics.size !== units.length)
    throw new ProgressiveCfdEvidenceScopeClosed("Terminal diagnostics require exact stopped, unowned material failures for every original unit");
  const omitted = new Set(diagnosticRecovery?.intentionallyOmittedAoas ?? []);
  if (diagnosticRecovery && units.some((unit) => omitted.has(unit.aoa_deg) &&
    (unit.active_seconds !== 0 || unit.unit_seconds !== 0 || unit.has_case_history)))
    throw new ProgressiveCfdEvidenceScopeClosed("Numerical recovery cannot omit a case with recorded work or physical history");
  const terminalRecovery = new Set(diagnosticRecovery ? units.filter((unit) =>
    unit.latest_attempt && unit.outcome === "failed" && ["gap", "pending"].includes(unit.state) &&
    unit.lease_token == null && unit.lease_owner == null && unit.lease_until == null &&
    (omitted.has(unit.aoa_deg) || diagnosticRecovery.attemptedAoas.includes(unit.aoa_deg)),
  ).map((unit) => unit.token) : []);
  if (
    !units.length ||
    units.length !== Number(count.count) ||
    units.some(
      (unit) =>
        unit.generation_id !== metadata.generationId ||
        unit.target_id !== metadata.targetId ||
        unit.execution_recipe_id !== metadata.recipeId ||
        unit.stage !== metadata.stage ||
        (recoveryScope
          ? !["complete", "failed", "cancelled"].includes(unit.outcome) ||
            !["leased", "blocked", "gap", "complete"].includes(unit.state) ||
            unit.work_state !== "pending" ||
            (unit.state === "leased"
              ? unit.lease_token !== unit.token ||
                unit.lease_until == null ||
                new Date(String(unit.lease_until)).getTime() > Date.now()
              : unit.lease_token != null || unit.lease_until != null)
          : policy === "stopped-failed-storage"
            ? selectedAoas!.has(unit.aoa_deg) && !isStoppedFailedStorageUnit(unit)
          : policy === "runtime"
            ? !isRuntimeProgressActiveUnit(unit) &&
              !isRuntimeProgressObsoleteUnit(unit)
            : !retainedDiagnostics.has(unit.token) && !terminalRecovery.has(unit.token) &&
              (unit.outcome !== "running" || !["leased", "blocked"].includes(unit.state) ||
                ((selectedAoas !== null || diagnosticRecovery !== null) && (!unit.latest_attempt ||
                  (unit.state === "leased" && unit.lease_token !== unit.token))) ||
                (diagnosticRecovery !== null && (unit.state === "leased"
                  ? unit.lease_owner !== unit.owner || unit.lease_until == null
                  : unit.lease_token != null || unit.lease_owner != null || unit.lease_until != null)))),
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
  if (recoveryScope) {
    const [lockedJob] = await db.execute(sql`
      SELECT engine_job_id, request_payload, status, "ingestedAt", ingest_lease_token, ingest_lease_expires_at
      FROM sim_jobs WHERE id = ${simJobId} FOR UPDATE
    `);
    if (
      !lockedJob ||
      lockedJob.engine_job_id !== engineJobId ||
      analysisContentHash(lockedJob.request_payload) !==
        analysisContentHash(job.request_payload) ||
      !["done", "failed", "cancelled"].includes(String(lockedJob.status)) ||
      lockedJob.ingestedAt == null ||
      (lockedJob.ingest_lease_token != null &&
        (lockedJob.ingest_lease_expires_at == null ||
          new Date(String(lockedJob.ingest_lease_expires_at)).getTime() >
            Date.now()))
    )
      throw new ProgressiveCfdEvidenceScopeClosed(
        "Historical progressive execution ownership changed or is still active",
      );
  }
  return {
    airfoilId: String(job.airfoil_id),
    units,
    diagnosticRecovery,
  };
}

export async function assertProgressiveStoppedFailedEvidenceJob(
  db: DB,
  delivery: ProgressiveRemoteEvidenceDelivery,
) {
  const source = await resolveProgressiveRemoteEvidence(db, delivery);
  if (!source || progressiveRemotePointProjection(source).status !== "failed" || source.point.converged !== false ||
    !["material_domain", "infrastructure", "hard_solver"].includes(String(source.point.failure_disposition)) ||
    !progressiveReportedPointSources({ ...source.report.result!,
      polars: source.report.result!.polars.map((polar) => ({ ...polar, points: [] })),
    }).some((entry) => entry.contentSignature === source.contentSignature))
    throw new ProgressiveRemoteEvidenceConflict("Stopped failure storage requires an authentic reported failed attempt");
  const manifests = source.point.evidence_artifacts?.filter((artifact) => artifact.kind === "manifest") ?? [];
  if (manifests.length !== 1 || typeof manifests[0].sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(manifests[0].sha256) || typeof manifests[0].byte_size !== "number" ||
    !Number.isSafeInteger(manifests[0].byte_size) || manifests[0].byte_size <= 0 ||
    typeof manifests[0].path !== "string" || !manifests[0].path.trim())
    throw new ProgressiveRemoteEvidenceConflict("Stopped physical failure storage requires its exact reported manifest");
  assertProgressiveReportedManifest(source, { manifestSha256: manifests[0].sha256, manifestByteSize: manifests[0].byte_size });
  const classifications = await readProgressiveRemoteSourceClassifications(db, delivery.engineJobId, [delivery.aoaDeg]);
  if (!classifications.some((entry) => entry.pointContentSignature === source.contentSignature && entry.kind === "requires_evidence"))
    throw new ProgressiveCfdEvidenceScopePending("Stopped failure storage awaits the authenticated final report, inventory and stop acknowledgement");
  const scope = await lockJobScope(db, delivery.engineJobId, delivery.engineJobId, {
    policy: "stopped-failed-storage", evidenceAoas: [delivery.aoaDeg],
  });
  const selected = scope?.units.filter((unit) => unit.aoa_deg === delivery.aoaDeg) ?? [];
  if (!scope || selected.length !== 1)
    throw new ProgressiveCfdEvidenceScopeClosed("Stopped failure storage has no unique original selected owner");
  const [owner] = await db.execute(sql`SELECT ingest_lease_token,ingest_lease_expires_at
    FROM sim_jobs WHERE id=${delivery.engineJobId}::uuid FOR UPDATE`);
  if (!owner || (owner.ingest_lease_token != null &&
    (owner.ingest_lease_expires_at == null || new Date(String(owner.ingest_lease_expires_at)).getTime() > Date.now())))
    throw new ProgressiveCfdEvidenceScopeClosed("Stopped failure storage conflicts with a live ingestion or selected unit owner");
  const [promise] = await db.execute(sql`SELECT promise.status FROM sync_sweep_promises promise
    JOIN progressive_remote_dispatches dispatch ON dispatch.promise_id=promise.id
    WHERE promise.id=${delivery.promiseId}::uuid AND dispatch.sim_job_id=${delivery.engineJobId}::uuid
      AND dispatch.solver_id=${delivery.solverId}::uuid FOR SHARE OF promise`);
  if (promise?.status !== "active")
    throw new ProgressiveCfdEvidenceScopeClosed("Current stopped failure contribution requires an active promise");
  assertProgressiveRemotePhysicalCase(source, selected[0].snapshot);
  return { source, scope: { ...scope, units: selected } };
}

export async function assertProgressiveStorageEvidenceRecoveryJob(
  db: DB,
  simJobId: string,
  recoveryScope: ProgressiveStorageEvidenceRecoveryScope,
  resultAttemptIds: string[],
) {
  assertProgressiveStorageEvidenceRecoveryRole();
  if (
    !recoveryScope ||
    recoveryScope.stage !== 2 ||
    [
      recoveryScope.campaignId,
      recoveryScope.epochId,
      recoveryScope.generationId,
      recoveryScope.planRevisionId,
    ].some(
      (id) =>
        typeof id !== "string" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id),
    )
  )
    throw new ProgressiveCfdEvidenceScopeClosed(
      "Historical progressive recovery requires the exact current stage-2 scope",
    );
  await db.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await db.execute(sql`SET LOCAL statement_timeout = '30s'`);
  const scope = await lockJobScope(db, simJobId, simJobId, { recoveryScope });
  if (!scope || !resultAttemptIds.length || resultAttemptIds.length > 2048)
    throw new ProgressiveCfdEvidenceScopeClosed(
      "Historical progressive recovery requires exact stored attempt identities",
    );
  if (
    recoveryScope.cohort === "low" &&
    scope.units.some((unit) => {
      const mach = unit.snapshot.derived?.mach;
      return (
        typeof mach !== "number" ||
        !Number.isFinite(mach) ||
        mach < 0 ||
        mach >= 1
      );
    })
  )
    throw new ProgressiveCfdEvidenceScopeClosed(
      "Historical progressive evidence is outside the requested low-Mach scope",
    );
  const [dispatch] = await db.execute(sql`
    SELECT solver_id, promise_id, envelope, content_signature FROM progressive_remote_dispatches
    WHERE sim_job_id = ${simJobId}::uuid FOR SHARE
  `);
  if (!dispatch)
    throw new ProgressiveCfdEvidenceScopeClosed(
      "Historical progressive recovery has no original remote dispatch",
    );
  const envelope = verifyProgressiveRemoteExecution(dispatch.envelope, {
    solverId: String(dispatch.solver_id),
    promiseId: String(dispatch.promise_id),
    executionId: simJobId,
    contentSignature: String(dispatch.content_signature),
  });
  if (
    envelope.scope.epochId !== recoveryScope.epochId ||
    envelope.scope.generationId !== recoveryScope.generationId ||
    envelope.scope.stage !== recoveryScope.stage ||
    scope.units.some(
      (unit) =>
        envelope.scope.targetId !== unit.target_id ||
        envelope.scope.recipeId !== unit.execution_recipe_id ||
        !envelope.scope.tokens.includes(unit.token),
    )
  )
    throw new ProgressiveCfdEvidenceScopeClosed(
      "Historical progressive recovery differs from its immutable remote scope",
    );
  const retained = await readProgressiveRemoteRetention(db, simJobId);
  if (retained.kind !== "retained")
    throw new ProgressiveCfdEvidenceScopePending(
      `Historical progressive recovery is waiting for complete remote retention: ${retained.reason}`,
    );
  for (const resultAttemptId of resultAttemptIds) {
    const source = retained.sources.find(
      (item) => item.resultAttemptId === resultAttemptId,
    );
    const unit = scope.units.find(
      (item) => item.aoa_deg === source?.delivery.aoaDeg,
    );
    if (!source || !unit || !unit.latest_attempt || unit.state === "complete")
      throw new ProgressiveCfdEvidenceScopeClosed(
        "Historical progressive evidence no longer owns the latest unsettled unit attempt",
      );
    if (!source.archived)
      throw new ProgressiveCfdEvidenceScopePending(
        "Historical progressive evidence is waiting for its manifest and archive custody",
      );
    const [receipt] = await db.execute(sql`
      SELECT storage_only FROM progressive_remote_evidence_receipts
      WHERE sim_job_id = ${simJobId}::uuid AND result_attempt_id = ${resultAttemptId}::uuid
    `);
    if (receipt?.storage_only !== true)
      throw new ProgressiveCfdEvidenceScopeClosed(
        "Historical progressive recovery requires an immutable storage-only receipt",
      );
    await assertStoppedProgressiveStorage(db, source.delivery);
    const { assertProgressiveRemoteEvidenceAttempt } =
      await import("./progressive-remote-evidence-receipts");
    await assertProgressiveRemoteEvidenceAttempt(db, {
      ...source.delivery,
      resultAttemptId,
      recoveryScope,
    });
  }
  return scope;
}

export async function assertProgressiveCfdTerminalDiagnostics(
  db: DB,
  simJobId: string,
  engineJobId: string,
) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [terminal] = await connection.execute(sql`SELECT count(*)>0 AND bool_and(
      attempt.outcome='failed' AND unit.state IN ('gap','pending')
        AND unit.lease_token IS NULL AND unit.lease_until IS NULL) AS ready
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
      WHERE attempt.sim_job_id=${simJobId}`);
    if (terminal?.ready !== true) return false;
    return await lockJobScope(connection, simJobId, engineJobId, { terminalDiagnostics: true }) !== null;
  });
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
      { evidenceAoas: cases?.length ? cases.map((item) => item.alpha) : undefined },
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

// This is the shared reconciliation/planning boundary. The private lock derives
// any terminal or zero-work omitted allowance from the authenticated report.
export async function readProgressiveDiagnosticRecoveryTrigger(
  db: DB,
  simJobId: string,
  reference: ProgressiveRemoteEvidenceReference & { receiptSignature?: string; historySignature?: string },
) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const scope = await lockJobScope(connection, simJobId, simJobId, { diagnosticRecovery: reference });
    if (!scope?.diagnosticRecovery) return null;
    const validated = scope.diagnosticRecovery;
    for (const source of validated.reportedSources) {
      const unit = scope.units.find((candidate) => candidate.aoa_deg === source.point.aoa_deg);
      if (!unit) throw new ProgressiveRemoteEvidenceConflict("Numerical recovery changed an original physical case");
      assertProgressiveRemotePhysicalCase(source, unit.snapshot);
    }
    const physical = await connection.execute(sql`SELECT raw.id, raw.sim_job_id, raw.engine_job_id, raw.airfoil_id,
      raw.simulation_preset_revision_id, raw.aoa_deg, raw.evidence_payload, evidence.evidence_signature, evidence.attempt_token
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_evidence evidence ON evidence.attempt_token = attempt.token
      JOIN result_attempts raw ON raw.id = evidence.result_attempt_id
      WHERE attempt.sim_job_id = ${simJobId}::uuid ORDER BY raw.id LIMIT 2049`);
    const retained = new Set(validated.physicalSources.map((entry) => entry.resultAttemptId));
    if (physical.length > 2048 || physical.length !== retained.size || physical.some((raw) => {
      const unit = scope.units.find((candidate) => candidate.token === raw.attempt_token);
      return !unit || !retained.has(String(raw.id)) || raw.sim_job_id !== simJobId || raw.engine_job_id !== simJobId ||
        raw.airfoil_id !== scope.airfoilId || raw.simulation_preset_revision_id !== unit.execution_revision_id ||
        raw.aoa_deg !== unit.aoa_deg || analysisContentHash(raw.evidence_payload) !== raw.evidence_signature;
    })) throw new ProgressiveRemoteEvidenceConflict("Numerical recovery changed retained physical evidence identity or coverage");
    const unit = scope.units.find((candidate) => candidate.aoa_deg === validated.triggerAoaDeg)!;
    return {
      revisionId: unit.execution_revision_id, attemptToken: unit.token,
      triggerAoaDeg: validated.triggerAoaDeg, attemptedAoas: validated.attemptedAoas,
      intentionallyOmittedAoas: validated.intentionallyOmittedAoas,
      diagnosticAoas: validated.diagnosticAoas, reference: validated.reference,
    };
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
      { policy: "runtime" },
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
        Number(unit.effective_budget_seconds) -
            (Number(unit.unit_seconds) - Number(unit.active_seconds)) ||
        typeof observed.solver_running !== "boolean"
      )
        throw new Error(
          "Runtime budget observation differs from its immutable physical case allocation",
        );
      seen.add(observed.aoa_deg);
      if (!isRuntimeProgressActiveUnit(unit)) continue;
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
      const exhausted = total >= Number(unit.effective_budget_seconds);
      await connection.execute(sql`UPDATE progressive_cfd_attempts SET active_seconds = ${measured},
        lease_until = CASE WHEN ${exhausted} THEN clock_timestamp() ELSE clock_timestamp() + interval '120 seconds' END
        WHERE token = ${unit.token}`);
      await connection.execute(sql`UPDATE progressive_cfd_units SET active_seconds = ${total},
        state = CASE WHEN ${exhausted} THEN 'blocked' ELSE state END,
        lease_token = CASE WHEN ${exhausted} THEN NULL ELSE lease_token END,
        lease_owner = CASE WHEN ${exhausted} THEN NULL ELSE lease_owner END,
        lease_until = CASE WHEN ${exhausted} THEN NULL ELSE clock_timestamp() + interval '120 seconds' END,
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
  input: {
    simJobId: string;
    engineJobId: string;
    resultAttemptIds: string[];
    recoveryScope?: ProgressiveStorageEvidenceRecoveryScope;
    stoppedFailedStorage?: ProgressiveRemoteEvidenceDelivery;
  },
): Promise<{ progressive: boolean; linked: number; stopRequired: boolean }> {
  const ids = [...new Set(input.resultAttemptIds)];
  if (ids.length > 2048)
    throw new Error("CFD evidence batch exceeds its bounded case scope");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    if (input.stoppedFailedStorage && (input.recoveryScope || ids.length !== 1 ||
      input.stoppedFailedStorage.engineJobId !== input.simJobId || input.engineJobId !== input.simJobId))
      throw new Error("Stopped failed evidence requires its one exact authenticated delivery");
    const selectedEvidence = ids.length && !input.recoveryScope ? await connection.execute(sql`
      SELECT id,aoa_deg FROM result_attempts WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
        AND sim_job_id=${input.simJobId} AND engine_job_id=${input.engineJobId}
    `) : [];
    const evidenceAoas = [...new Set(selectedEvidence.map((row) => Number(row.aoa_deg)))];
    const scope = input.stoppedFailedStorage
      ? (await assertProgressiveStoppedFailedEvidenceJob(connection, input.stoppedFailedStorage)).scope
      : input.recoveryScope
      ? await assertProgressiveStorageEvidenceRecoveryJob(
          connection,
          input.simJobId,
          input.recoveryScope,
          ids,
        )
      : await lockJobScope(connection, input.simJobId, input.engineJobId, {
          evidenceAoas: evidenceAoas.length ? evidenceAoas : undefined,
        });
    if (input.recoveryScope && input.engineJobId !== input.simJobId)
      throw new ProgressiveCfdEvidenceScopeClosed(
        "Historical progressive recovery requires exact engine ownership",
      );
    if (!scope) return { progressive: false, linked: 0, stopRequired: false };
    if (input.stoppedFailedStorage) {
      const { assertProgressiveRemoteEvidenceAttempt } = await import("./progressive-remote-evidence-receipts");
      await assertProgressiveRemoteEvidenceAttempt(connection, { ...input.stoppedFailedStorage, resultAttemptId: ids[0] });
      const [raw] = await connection.execute(sql`SELECT status,converged,valid_for_polar FROM result_attempts WHERE id=${ids[0]}::uuid`);
      if (!raw || raw.status !== "failed" || raw.converged !== false || raw.valid_for_polar !== false)
        throw new ProgressiveRemoteEvidenceConflict("Stopped failed storage cannot link accepted or solved CFD");
    }
    let linked = 0;
    let stopRequired = scope.units.some(
      (unit) =>
        Number(unit.unit_seconds) >= Number(unit.effective_budget_seconds) &&
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
    if (!input.recoveryScope && evidence.some((row) => !selectedEvidence.some((selected) =>
      selected.id === row.id && Number(selected.aoa_deg) === Number(row.aoa_deg))))
      throw new Error("CFD evidence changed its exact stored case selection");
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
            Number(unit.effective_budget_seconds) -
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
      const exhausted = total >= Number(unit.effective_budget_seconds);
      await connection.execute(
        sql`UPDATE progressive_cfd_attempts SET active_seconds = ${measured} WHERE token = ${unit.token}`,
      );
      if (input.stoppedFailedStorage) await connection.execute(sql`
        UPDATE progressive_cfd_units SET active_seconds = ${total} WHERE id = ${unit.unit_id}
      `);
      else await connection.execute(sql`
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
        Number(unit.unit_seconds) >= Number(unit.effective_budget_seconds) &&
        !unit.budget_guard_confirmed,
    );
    return { progressive: true, linked, stopRequired: input.stoppedFailedStorage ? false : stopRequired };
  });
}
