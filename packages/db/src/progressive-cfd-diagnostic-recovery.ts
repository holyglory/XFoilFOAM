import { sql } from "drizzle-orm";
import type { EngineExecutionStopProof } from "../../engine-client/src/types";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import type { DB } from "./client";
import { validateProgressiveExecutionStopProof } from "./progressive-cfd-settlement";
import type { ProgressiveRemoteDiagnosticReceipt } from "./progressive-remote-diagnostic-receipts";
import {
  resolveProgressiveRemoteEvidence,
  ProgressiveRemoteEvidenceConflict,
  type ProgressiveRemoteEvidenceReference,
} from "./progressive-remote-evidence";
import { assertProgressiveRemoteEvidenceAttempt } from "./progressive-remote-evidence-receipts";
import { progressiveRemotePointProjection } from "./progressive-remote-point-projection";
import {
  readProgressiveRemoteRetention,
  readProgressiveRemoteSourceClassifications,
  progressiveReportedDiagnosticFailureKind,
} from "./progressive-remote-retention";

export interface ProgressiveDiagnosticRecoveryReference extends ProgressiveRemoteEvidenceReference {
  receiptSignature: string;
  historySignature: string;
}

// Called inside the existing epoch/campaign lock, before any terminal/omitted
// ownership allowance. Every allowance comes from this authenticated report,
// never from the caller's attempted/omitted arrays.
export async function readProgressiveDiagnosticRecoverySources(
  db: DB,
  executionId: string,
  reference: ProgressiveRemoteEvidenceReference & {
    receiptSignature?: string;
    historySignature?: string;
  },
) {
  const [stored] =
    await db.execute(sql`SELECT diagnostic.receipt, diagnostic.sequence,
      dispatch.solver_id, dispatch.promise_id, stopped.epoch_id, stopped.proof, stopped.proof_signature,
      source.aoa_deg, source.case_slug
    FROM progressive_remote_diagnostic_receipts diagnostic
    JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id = diagnostic.sim_job_id
    JOIN registered_remote_solvers solver ON solver.id = dispatch.solver_id AND solver.revoked_at IS NULL
    JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = diagnostic.sim_job_id
      AND stopped.engine_job_id = diagnostic.sim_job_id::text
    JOIN progressive_remote_report_sources source ON source.sim_job_id = diagnostic.sim_job_id
      AND source.sequence = ${reference.sequence} AND source.point_content_signature = diagnostic.point_content_signature
    WHERE diagnostic.sim_job_id = ${executionId}::uuid
      AND diagnostic.point_content_signature = ${reference.pointContentSignature}
    FOR SHARE OF diagnostic, dispatch, stopped, solver`);
  if (!stored) return null;
  const receipt = stored.receipt as ProgressiveRemoteDiagnosticReceipt;
  const receiptSignature = analysisContentHash(receipt);
  if (
    receipt.version !== 2 ||
    receipt.kind !== "retained-progressive-diagnostic" ||
    receipt.failureKind !== "hard_solver" ||
    receipt.executionId !== executionId ||
    receipt.sequence !== Number(stored.sequence) ||
    receipt.pointContentSignature !== reference.pointContentSignature ||
    (reference.receiptSignature !== undefined &&
      reference.receiptSignature !== receiptSignature) ||
    analysisContentHash(stored.proof) !== stored.proof_signature
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Numerical recovery changed its exact diagnostic receipt or stop proof",
    );
  const proof = stored.proof as EngineExecutionStopProof;
  validateProgressiveExecutionStopProof(proof);
  if (
    proof.job_id !== executionId ||
    proof.ownership_basis === "never_started_cancellation_fence"
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Numerical recovery requires a stopped diagnostic producer",
    );
  const sourceInput = {
    engineJobId: executionId,
    solverId: String(stored.solver_id),
    promiseId: String(stored.promise_id),
    aoaDeg: Number(stored.aoa_deg),
    engineCaseSlug: stored.case_slug as string | null,
  };
  const source = await resolveProgressiveRemoteEvidence(db, {
    ...sourceInput,
    progressiveEvidence: reference,
  });
  const promotion = source?.polar.rans_precalc_promotion;
  if (
    !source ||
    !promotion ||
    stored.epoch_id !== source.envelope.scope.epochId ||
    progressiveReportedDiagnosticFailureKind(source.point) !== "hard_solver" ||
    progressiveRemotePointProjection(source).regime !== "rans" ||
    source.point.aoa_deg < 0 ||
    source.point.aoa_deg > 5 ||
    promotion.failure_disposition !== "hard_solver" ||
    promotion.trigger_aoa_deg !== source.point.aoa_deg
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Numerical recovery changed its exact diagnostic promotion source",
    );
  const angles = [...(source.envelope.request.aoa?.angles ?? [])].sort(
    (a, b) => a - b,
  );
  const ordered = angles.includes(0)
    ? [
        0,
        ...angles.filter((angle) => angle > 0),
        ...angles.filter((angle) => angle < 0).reverse(),
      ]
    : angles;
  const triggerIndex = ordered.indexOf(promotion.trigger_aoa_deg);
  const attemptedAoas = ordered.slice(0, triggerIndex + 1);
  const intentionallyOmittedAoas = angles.filter(
    (angle) => !attemptedAoas.includes(angle),
  );
  if (
    angles.length < 2 ||
    new Set(angles).size !== angles.length ||
    triggerIndex < 0 ||
    source.envelope.request.solver?.rans_failure_policy !==
      "abort_for_precalc" ||
    canonicalAnalysisJson(promotion.attempted_aoas) !==
      canonicalAnalysisJson(attemptedAoas) ||
    canonicalAnalysisJson(promotion.intentionally_omitted_aoas) !==
      canonicalAnalysisJson(intentionallyOmittedAoas) ||
    canonicalAnalysisJson(
      source.polar.attempts
        ?.map((attempt) => attempt.aoa_deg)
        .sort((a, b) => a - b),
    ) !== canonicalAnalysisJson([...attemptedAoas].sort((a, b) => a - b))
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Numerical recovery changed its authenticated original sweep scope",
    );

  // Read the entire history, including sources absent from the final report.
  // Physical sources retain the same raw-value, evidence-hash and archive gates.
  const classifications = await readProgressiveRemoteSourceClassifications(
    db,
    executionId,
  );
  const retention = await readProgressiveRemoteRetention(db, executionId);
  if (retention.kind !== "retained")
    throw new ProgressiveRemoteEvidenceConflict(
      "Numerical recovery awaits complete retained source history",
    );
  const diagnosticRows =
    await db.execute(sql`SELECT point_content_signature, sequence, receipt
    FROM progressive_remote_diagnostic_receipts WHERE sim_job_id = ${executionId}::uuid
    ORDER BY point_content_signature FOR SHARE`);
  const diagnostics = new Map(
    diagnosticRows.map((row) => [String(row.point_content_signature), row]),
  );
  const physical = new Map(
    retention.sources.map((entry) => [
      entry.delivery.progressiveEvidence.pointContentSignature,
      entry,
    ]),
  );
  const history: unknown[] = [];
  const reportedSources = [];
  const diagnosticAoas: number[] = [];
  for (const entry of classifications) {
    if (!attemptedAoas.includes(entry.aoaDeg))
      throw new ProgressiveRemoteEvidenceConflict(
        "Numerical recovery omitted an actually reported case",
      );
    const input = {
      ...sourceInput,
      aoaDeg: entry.aoaDeg,
      engineCaseSlug: entry.engineCaseSlug,
    };
    const reported = await resolveProgressiveRemoteEvidence(db, {
      ...input,
      progressiveEvidence: entry,
    });
    if (!reported)
      throw new ProgressiveRemoteEvidenceConflict(
        "Numerical recovery lost an authenticated source",
      );
    reportedSources.push(reported);
    const raw = physical.get(entry.pointContentSignature);
    const diagnostic = diagnostics.get(entry.pointContentSignature);
    if (raw && diagnostic)
      throw new ProgressiveRemoteEvidenceConflict(
        "Numerical recovery source has competing physical and diagnostic custody",
      );
    if (raw) {
      await assertProgressiveRemoteEvidenceAttempt(db, {
        ...raw.delivery,
        resultAttemptId: raw.resultAttemptId,
      });
      history.push({ source: entry, physical: raw });
      continue;
    }
    const retained = diagnostic?.receipt as
      | ProgressiveRemoteDiagnosticReceipt
      | undefined;
    if (
      !retained ||
      entry.kind === "requires_evidence" ||
      retained.kind !== "retained-progressive-diagnostic" ||
      retained.executionId !== executionId ||
      retained.sequence !== Number(diagnostic!.sequence) ||
      retained.pointContentSignature !== entry.pointContentSignature ||
      (retained.version === 1
        ? entry.failureKind !== "material_domain"
        : retained.version !== 2 || retained.failureKind !== entry.failureKind)
    )
      throw new ProgressiveRemoteEvidenceConflict(
        "Numerical recovery is missing an exact attempted diagnostic receipt",
      );
    const anchor = await resolveProgressiveRemoteEvidence(db, {
      ...input,
      progressiveEvidence: retained,
    });
    if (!anchor)
      throw new ProgressiveRemoteEvidenceConflict(
        "Numerical recovery lost an attempted diagnostic report",
      );
    diagnosticAoas.push(entry.aoaDeg);
    history.push({
      source: entry,
      receiptSignature: analysisContentHash(retained),
    });
  }
  const observedAoas = [
    ...new Set(classifications.map((entry) => entry.aoaDeg)),
  ].sort((a, b) => a - b);
  const historySignature = analysisContentHash(history);
  if (
    physical.has(reference.pointContentSignature) ||
    !diagnosticAoas.includes(source.point.aoa_deg) ||
    canonicalAnalysisJson(observedAoas) !==
      canonicalAnalysisJson([...attemptedAoas].sort((a, b) => a - b)) ||
    (reference.historySignature !== undefined &&
      reference.historySignature !== historySignature)
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Numerical recovery changed its complete retained source history",
    );
  return {
    source,
    reportedSources,
    physicalSources: retention.sources,
    diagnosticAoas,
    triggerAoaDeg: source.point.aoa_deg,
    attemptedAoas,
    intentionallyOmittedAoas,
    reference: {
      sequence: reference.sequence,
      reportContentSignature: reference.reportContentSignature,
      pointContentSignature: reference.pointContentSignature,
      receiptSignature,
      historySignature,
    },
  };
}
