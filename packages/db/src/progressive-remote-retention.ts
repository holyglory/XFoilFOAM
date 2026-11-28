import { resolveStoredProgressiveReport, withPreparedRemoteReportReads, verifiedProgressiveReportMember, recheckRemoteReportMember } from "./progressive-report-reader";
import { is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { DB } from "./client";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import { readProgressiveEvidenceCustodyReceipt } from "./progressive-evidence-custody";
import { recheckPreparedEvidenceReport, prepareProgressiveRemoteEvidence, resolveProgressiveRemoteEvidence, ProgressiveRemoteEvidenceConflict } from "./progressive-remote-evidence";
import { prepareProgressiveRemoteReceiptReplay, readProgressiveRemoteEvidenceReceipt, type ProgressiveRemoteEvidenceDelivery } from "./progressive-remote-evidence-receipts";
import type { AttemptEvidenceArchiveReader } from "./attempt-evidence-reader";
import { hasAttemptEvidenceStoragePointer } from "./attempt-evidence-storage";
import { progressiveRemotePointProjection } from "./progressive-remote-point-projection";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  isFinalProgressiveRemoteReport,
  progressiveReportedPointSources,
  validateProgressiveRemoteReport,
} from "./progressive-remote-report";
import { verifyProgressiveRemoteExecution, type ProgressiveRemoteExecutionEnvelope } from "./progressive-remote-execution";
import type { ProgressiveRemoteReport } from "./progressive-remote-report";
import { progressiveRemoteReportInventory } from "./progressive-remote-inventory";
import { validateProgressiveExecutionStopProof } from "./progressive-cfd-settlement";

export type ProgressiveDiagnosticFailureKind = "material_domain" | "infrastructure" | "hard_solver";

interface RetentionPreparation {
  executionId: string;
  selectedAttempts?: ReadonlySet<string>;
  preparationFailures: Map<string, Error>;
  deliveries: Map<string, ProgressiveRemoteEvidenceDelivery>;
  reports: Map<string, { report: ProgressiveRemoteReport; current: (connection: DB) => Promise<boolean> }>;
}
const retentionContext = new AsyncLocalStorage<RetentionPreparation>();
let retentionReader: AttemptEvidenceArchiveReader | undefined;
export function installProgressiveRetentionReader(
  reader: AttemptEvidenceArchiveReader,
) {
  retentionReader = reader;
}
export function progressiveRetentionReader() {
  return retentionReader;
}

/** Do external reads at the outer operation, before taking any scientific
 * locks. The normal retention pass repeats source, receipt and custody checks. */
export async function withPreparedProgressiveRemoteRetention<T>(
  db: DB,
  executionId: string,
  reader: AttemptEvidenceArchiveReader,
  action: () => Promise<T>,
  selectedAttempts?: readonly string[],
): Promise<T> {
  if (selectedAttempts && (selectedAttempts.length === 0 || selectedAttempts.length > 512))
    throw new Error("Selected retention preparation requires a bounded point scope");
  const current = retentionContext.getStore();
  const available = current?.selectedAttempts;
  if (current?.executionId === executionId && (!available || selectedAttempts?.every(id => available.has(id)))) return action();
  const attemptPointer=await hasAttemptEvidenceStoragePointer(db);
  const [schema]=await db.execute(sql`SELECT EXISTS(SELECT FROM pg_attribute WHERE attrelid=to_regclass('progressive_remote_reports')
    AND attname='archived_at' AND NOT attisdropped) AS reports`);
  if(!attemptPointer&&!schema?.reports)return action();
  const archivedAttempt=attemptPointer?sql`a.evidence_archive_id`:sql`NULL::uuid`;
  const archivedReport=schema?.reports?sql`r.archived_at IS NOT NULL`:sql`false`;
  const rows=await db.execute(sql`SELECT e.result_attempt_id,e.remote_result_id,e.remote_result_attempt_id,e.point_content_signature,
    e.sequence,r.content_signature,a.aoa_deg,a.engine_case_slug,d.solver_id,d.promise_id,${archivedAttempt} AS archived_attempt
    FROM progressive_remote_evidence_receipts e JOIN result_attempts a ON a.id=e.result_attempt_id
    JOIN progressive_remote_reports r ON r.sim_job_id=e.sim_job_id AND r.sequence=e.sequence
    JOIN progressive_remote_dispatches d ON d.sim_job_id=e.sim_job_id
    WHERE e.sim_job_id=${executionId}::uuid AND (${archivedAttempt} IS NOT NULL OR ${archivedReport})
      ${selectedAttempts ? sql`AND NOT e.storage_only AND e.result_attempt_id IN
        (${sql.join(selectedAttempts.map(id => sql`${id}::uuid`), sql`,`)})` : sql``}
    ORDER BY e.result_attempt_id LIMIT 2049`);
  if(!rows.length){
    if(!schema?.reports)return action();
    const [cold]=await db.execute(sql`SELECT 1 FROM progressive_remote_reports WHERE sim_job_id=${executionId}::uuid AND archive_bundle_id IS NOT NULL LIMIT 1`);
    if(!cold)return action();
  }
  if (rows.length > 2048)
    throw new Error(
      "Remote retention exceeds the bounded source-attempt inventory",
    );
  const prepared: RetentionPreparation = {
    executionId,
    selectedAttempts: selectedAttempts && new Set(selectedAttempts),
    preparationFailures: new Map(),
    deliveries: new Map(),
    reports: new Map(),
  };
  for (const row of rows) {
    const delivery: ProgressiveRemoteEvidenceDelivery = {
      engineJobId: executionId,
      solverId: String(row.solver_id),
      promiseId: String(row.promise_id),
      remoteResultId: String(row.remote_result_id),
      remoteResultAttemptId: String(row.remote_result_attempt_id),
      aoaDeg: Number(row.aoa_deg),
      engineCaseSlug:
        row.engine_case_slug == null ? null : String(row.engine_case_slug),
      progressiveEvidence: {
        sequence: Number(row.sequence),
        reportContentSignature: String(row.content_signature),
        pointContentSignature: String(row.point_content_signature),
      },
    };
    const id = String(row.result_attempt_id);
    try {
      const source = await prepareProgressiveRemoteEvidence(db, delivery);
      if (!source) throw new Error("Remote retention source changed during preparation");
      if (row.archived_attempt) {
        const receipt = await prepareProgressiveRemoteReceiptReplay(db, delivery, reader);
        if (receipt?.resultAttemptId !== id) throw new Error("Remote retention attempt changed during preparation");
      }
      prepared.deliveries.set(id, delivery);
      prepared.reports.set(String(row.content_signature), { report: source.report,
        current: connection => recheckPreparedEvidenceReport(connection, delivery.progressiveEvidence) });
    } catch (error) {
      // A damaged selected member refuses its own unit. Whole-job retention
      // and operational database errors still propagate to the caller.
      if (!selectedAttempts || !(error instanceof Error) || error.name !== "Error" || "code" in error ||
          (error.cause instanceof Error && "code" in error.cause)) throw error;
      prepared.preparationFailures.set(id, error);
    }
  }
  const latest = sql`(SELECT sequence FROM progressive_remote_reports
    WHERE sim_job_id=${executionId}::uuid ORDER BY sequence DESC LIMIT 1)`;
  // A reuse pass needs the selected receipt anchors (prepared above) and the
  // signed final report. Other physical or diagnostic deliveries may be absent.
  const keys = selectedAttempts ? latest : sql`
    (SELECT DISTINCT ON(point_content_signature) sequence FROM progressive_remote_report_sources
      WHERE sim_job_id=${executionId}::uuid ORDER BY point_content_signature,sequence LIMIT 2049)
    UNION SELECT sequence FROM progressive_remote_diagnostic_receipts WHERE sim_job_id=${executionId}::uuid
    UNION ${latest}`;
  const others = await db.execute(sql`WITH keys AS (${keys})
    SELECT r.sequence,r.content_signature,r.report FROM keys JOIN progressive_remote_reports r USING(sequence)
    WHERE r.sim_job_id=${executionId}::uuid AND r.archived_at IS NOT NULL`);
  for (const row of others) {
    const signature=String(row.content_signature);
    if (prepared.reports.has(signature)) continue;
    const report=await resolveStoredProgressiveReport(db, "remote", row, executionId);
    const pin=verifiedProgressiveReportMember(report);
    if (!pin) throw new Error("Archived retention member lost its verified storage binding");
    prepared.reports.set(signature,{report,current:connection=>recheckRemoteReportMember(connection,pin)});
  }
  const read = async (connection:DB, sequence:number, signature:string) => {
    const entry=prepared.reports.get(signature);
    if (!entry || entry.report.sequence!==sequence || entry.report.executionId!==executionId || !await entry.current(connection))
      throw new ProgressiveRemoteEvidenceConflict("Archived retention report changed; prepare again");
    return entry.report;
  };
  return retentionContext.run(prepared, () => withPreparedRemoteReportReads({executionId,read},action));
}

function retentionReport(
  db: DB,
  row: { report?: unknown; content_signature?: unknown },
  executionId: string,
) {
  return resolveStoredProgressiveReport(db, "remote", row, executionId);
}

export function progressivePointHasRetainedHistory(point: ReturnType<typeof progressiveReportedPointSources>[number]["point"]) {
  return [point.force_history, point.steady_history, point.frame_track,
    point.urans_cycle_certificate, point.aperiodic_mean_certificate,
    point.no_shedding_certificate, point.rans_hold_certificate].some((history) => history != null) ||
    [point.images, point.video, point.mean_images].some((media) => media != null && Object.keys(media).length > 0);
}

export function progressiveReportedDiagnosticFailureKind(
  point: ReturnType<typeof progressiveReportedPointSources>[number]["point"],
): ProgressiveDiagnosticFailureKind | null {
  if (!["material_domain", "infrastructure", "hard_solver"].includes(String(point.failure_disposition)) ||
    point.converged !== false || [point.cl, point.cd, point.cm].some((value) => value != null) ||
    (point.evidence_artifacts?.length ?? 0) > 0 || progressivePointHasRetainedHistory(point))
    return null;
  return point.failure_disposition as ProgressiveDiagnosticFailureKind;
}

function diagnosticSignatures(report: ProgressiveRemoteReport) {
  if (!report.result) return new Set<string>();
  return new Set(progressiveReportedPointSources({
    ...report.result,
    polars: report.result.polars.map((polar) => ({ ...polar, points: [] })),
  }).filter(({ point }) => progressiveReportedDiagnosticFailureKind(point) !== null)
    .map((source) => source.contentSignature));
}

export async function readProgressiveRemoteSourceClassifications(
  db: DB,
  executionId: string,
  aoas?: readonly number[],
) {
  const [stored] = await db.execute(sql`SELECT dispatch.envelope,dispatch.solver_id,dispatch.promise_id,
    dispatch.content_signature AS assignment_signature,job.request_payload,
    latest.report,latest.content_signature,latest.sequence,
    stopped.proof,stopped.proof_signature,stopped.engine_job_id AS stopped_engine_job_id
    FROM progressive_remote_dispatches dispatch JOIN sim_jobs job ON job.id=dispatch.sim_job_id
    JOIN LATERAL (SELECT resolve_progressive_report(to_jsonb(progressive_remote_reports.*)) AS report,content_signature,sequence FROM progressive_remote_reports
      WHERE sim_job_id=dispatch.sim_job_id ORDER BY sequence DESC LIMIT 1) latest ON true
    LEFT JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=dispatch.sim_job_id
    WHERE dispatch.sim_job_id=${executionId}::uuid`);
  if (!stored) return [];
  const envelope = verifyProgressiveRemoteExecution(stored.envelope, {
    executionId,
    solverId: String(stored.solver_id),
    promiseId: String(stored.promise_id),
    contentSignature: String(stored.assignment_signature),
  });
  const payload = stored.request_payload as Record<string, unknown>;
  if (canonicalAnalysisJson(payload.engineRequest) !== canonicalAnalysisJson(envelope.request) ||
    canonicalAnalysisJson(payload.progressive) !== canonicalAnalysisJson(envelope.scope))
    throw new ProgressiveRemoteEvidenceConflict("Remote diagnostic history differs from immutable execution ownership");
  const latest = validateProgressiveRemoteReport(await retentionReport(db, stored, executionId), envelope);
  if (latest.contentSignature !== stored.content_signature)
    throw new Error("Remote diagnostic history changed its final report bytes");
  if (!isFinalProgressiveRemoteReport(latest.report) || !stored.proof) return [];
  if (stored.stopped_engine_job_id !== executionId ||
    analysisContentHash(stored.proof) !== stored.proof_signature ||
    (stored.proof as { job_id?: unknown }).job_id !== executionId)
    throw new Error("Remote diagnostic history has no exact stop acknowledgement");
  validateProgressiveExecutionStopProof(stored.proof as Parameters<typeof validateProgressiveExecutionStopProof>[0]);
  validateProgressiveExecutionStopProof(latest.report.stopProof!);
  const [missing] = await db.execute(sql`SELECT report.sequence FROM progressive_remote_reports report
    LEFT JOIN progressive_remote_report_inventories inventory USING (sim_job_id,sequence)
    WHERE report.sim_job_id=${executionId}::uuid AND report.sequence<=${latest.report.sequence}
      AND (inventory.sequence IS NULL OR inventory.report_content_signature<>report.content_signature
        OR inventory.source_count<>(SELECT count(*) FROM progressive_remote_report_sources source
          WHERE source.sim_job_id=inventory.sim_job_id AND source.sequence=inventory.sequence)) LIMIT 1`);
  if (missing) throw new Error("Remote diagnostic history has an incomplete authenticated inventory");
  const selected = aoas?.length
    ? sql`AND source.aoa_deg IN (${sql.join(aoas.map((alpha) => sql`${alpha}`), sql`, `)})`
    : sql``;
  const sources = await db.execute(sql`SELECT DISTINCT ON (source.point_content_signature)
    source.point_content_signature,source.aoa_deg,source.case_slug,source.sequence
    FROM progressive_remote_report_sources source
    WHERE source.sim_job_id=${executionId}::uuid AND source.sequence<=${latest.report.sequence}
      ${selected}
    ORDER BY source.point_content_signature,source.sequence LIMIT 2049`);
  if (sources.length > 2048) throw new Error("Remote diagnostic history exceeds its bounded source inventory");
  if (!sources.length) return [];
  const sequences = [...new Set(sources.map((source) => Number(source.sequence)))];
  const reports = await db.execute(sql`SELECT report.sequence,resolve_progressive_report(to_jsonb(report.*)) AS report,report.content_signature,
    inventory.inventory_signature,inventory.source_count
    FROM progressive_remote_reports report JOIN progressive_remote_report_inventories inventory USING (sim_job_id,sequence)
    WHERE report.sim_job_id=${executionId}::uuid AND report.sequence IN (
      ${sql.join(sequences.map((sequence) => sql`${sequence}`), sql`, `)})`);
  const verified = new Map<number, {
    signature: string;
    inventory: ReturnType<typeof progressiveRemoteReportInventory>;
    diagnostics: Set<string>;
    failureKinds: Map<string, ProgressiveDiagnosticFailureKind | null>;
  }>();
  for (const entry of reports) {
    const validated = validateProgressiveRemoteReport(await retentionReport(db, entry, executionId), envelope);
    const inventory = progressiveRemoteReportInventory(validated.report);
    if (validated.contentSignature !== entry.content_signature ||
      inventory.inventorySignature !== entry.inventory_signature ||
      inventory.sources.length !== Number(entry.source_count) ||
      validated.report.sequence !== Number(entry.sequence))
      throw new Error("Remote diagnostic history changed its authenticated report inventory");
    verified.set(validated.report.sequence, {
      signature: validated.contentSignature,
      inventory,
      diagnostics: diagnosticSignatures(validated.report),
      failureKinds: new Map(validated.report.result ? progressiveReportedPointSources(validated.report.result)
        .map((source) => [source.contentSignature, progressiveReportedDiagnosticFailureKind(source.point)]) : []),
    });
  }
  return sources.map((source) => {
    const report = verified.get(Number(source.sequence));
    const signature = String(source.point_content_signature);
    if (!report || !report.inventory.sources.some((entry) =>
      entry.point_content_signature === signature && entry.aoa_deg === Number(source.aoa_deg) &&
      entry.case_slug === source.case_slug))
      throw new Error("Remote diagnostic history has no exact authenticated point source");
    const failureKind = report.diagnostics.has(signature) ? report.failureKinds.get(signature) ?? null : null;
    return {
      kind: failureKind === "material_domain" ? "material_diagnostic" as const
        : failureKind !== null ? "failure_diagnostic" as const : "requires_evidence" as const,
      failureKind,
      executionId,
      sequence: Number(source.sequence),
      reportContentSignature: report.signature,
      pointContentSignature: signature,
      aoaDeg: Number(source.aoa_deg),
      engineCaseSlug: source.case_slug == null ? null : String(source.case_slug),
    };
  });
}

export function terminalReportHasNoPhysicalEvidence(
  report: ProgressiveRemoteReport,
): boolean {
  if (!report.result) {
    // A worker may terminate before it has a polar object to serialize. A
    // terminal zero-case report is still truthful no-evidence evidence; it
    // must not wait forever for raw evidence that cannot exist.
    return (
      ["failed", "cancelled"].includes(report.status.state) &&
      report.status.completed_cases === 0
    );
  }
  if (!["failed", "cancelled"].includes(report.result.state)) return false;
  const polars = report.result.polars ?? [];
  const points = polars.flatMap((polar) => polar.points ?? []);
  const attempts = polars.flatMap((polar) => polar.attempts ?? []);
  return (
    points.length === 0 &&
    attempts.length > 0 &&
    attempts.every(
      (attempt) =>
        (!attempt.evidence_artifacts ||
          attempt.evidence_artifacts.length === 0) &&
        (attempt.failure_disposition != null || attempt.error != null) &&
        [attempt.cl, attempt.cd, attempt.cm].every((value) => value == null) &&
        !progressivePointHasRetainedHistory(attempt),
    )
  );
}

export function terminalReportNoPhysicalEvidenceSignatures(
  report: ProgressiveRemoteReport,
) {
  if (report.result?.state === "completed" && isFinalProgressiveRemoteReport(report))
    return diagnosticSignatures(report);
  if (!report.result || !["failed", "cancelled"].includes(report.result.state))
    return new Set<string>();
  return new Set(
    progressiveReportedPointSources(report.result)
      .filter(({ point }) => {
        const coefficients = [point.cl, point.cd, point.cm];
        return (
          coefficients.every((value) => value == null) &&
          (!point.evidence_artifacts ||
            point.evidence_artifacts.length === 0) &&
          (point.failure_disposition != null || point.error != null) &&
          !progressivePointHasRetainedHistory(point)
        );
      })
      .map((source) => source.contentSignature),
  );
}

export async function readProgressiveRemoteRetention(
  db: DB,
  executionId: string,
  reader = retentionReader,
) {
  const inspect = async () => {
    const result = await inspectRemoteSources(db, executionId, false);
    if (result.kind !== "verified_sources") return result;
    return { kind: "retained" as const, report: result.report, sources: result.sources };
  };
  if (reader && !is(db, PgTransaction))
    return withPreparedProgressiveRemoteRetention(db, executionId, reader, inspect);
  return inspect();
}

// Canonical publication can consume independently verified sources.
// An incomplete inventory of delivered evidence never settles the job.
export async function readStoppedPublicationSources(db: DB, executionId: string) {
  const result = await inspectRemoteSources(db, executionId, true);
  return result.kind === "verified_sources" ? result : null;
}

/** Authenticate custody of one final-report point without making any claim about its siblings. */
export async function readSelectedPrecisePointSource(db: DB, executionId: string, resultAttemptId: string) {
  const checked = await inspectRemoteSources(db, executionId, true, resultAttemptId);
  if (checked.kind !== "verified_sources" || !checked.report.result || checked.sources.length !== 1) return null;
  const [source] = checked.sources;
  const result = checked.report.result;
  if (source.resultAttemptId !== resultAttemptId || source.storageOnly || !source.archived ||
      !progressiveReportedPointSources({ ...result, polars: result.polars.map(polar => ({ ...polar, attempts: [] })) })
        .some(point => point.contentSignature === source.delivery.progressiveEvidence.pointContentSignature)) return null;
  return { source, report: checked.report };
}

async function inspectRemoteSources(db: DB, executionId: string, allowMissingSiblings: boolean, resultAttemptId?: string) {
  const prepared = retentionContext.getStore();
  if (prepared?.executionId === executionId && prepared.selectedAttempts &&
      (!resultAttemptId || !prepared.selectedAttempts.has(resultAttemptId)))
    throw new Error("Selected point preparation cannot authorize another point or whole-job retention");
  const failure = resultAttemptId && prepared?.executionId === executionId && prepared.preparationFailures.get(resultAttemptId);
  if (failure) throw failure;
  const [latest] =
    await db.execute(sql`SELECT report.report, report.sequence, report.content_signature,
      dispatch.envelope FROM progressive_remote_dispatches dispatch
    JOIN LATERAL (SELECT resolve_progressive_report(to_jsonb(progressive_remote_reports.*)) AS report, sequence, content_signature FROM progressive_remote_reports
      WHERE sim_job_id = dispatch.sim_job_id ORDER BY sequence DESC LIMIT 1) report ON true
    WHERE dispatch.sim_job_id = ${executionId}::uuid`);
  if (!latest)
    return { kind: "waiting" as const, reason: "final_report" as const };
  const { report, contentSignature } = validateProgressiveRemoteReport(
    await retentionReport(db, latest, executionId),
    latest.envelope as ProgressiveRemoteExecutionEnvelope,
  );
  if (contentSignature !== latest.content_signature)
    throw new Error("Remote retention has changed final report bytes");
  if (!isFinalProgressiveRemoteReport(report))
    return { kind: "waiting" as const, reason: "final_report" as const };
  const [missingInventory] =
    await db.execute(sql`SELECT report.sequence FROM progressive_remote_reports report
    LEFT JOIN progressive_remote_report_inventories inventory USING (sim_job_id, sequence)
    WHERE report.sim_job_id = ${executionId}::uuid AND report.sequence <= ${report.sequence}
      ${resultAttemptId ? sql`AND (report.sequence=${report.sequence} OR EXISTS (SELECT FROM progressive_remote_evidence_receipts selected
        WHERE selected.result_attempt_id=${resultAttemptId}::uuid AND selected.sim_job_id=report.sim_job_id AND selected.sequence=report.sequence))` : sql``}
      AND (inventory.sequence IS NULL OR inventory.report_content_signature <> report.content_signature
        OR inventory.source_count <> (SELECT count(*) FROM progressive_remote_report_sources source
          WHERE source.sim_job_id = inventory.sim_job_id AND source.sequence = inventory.sequence)) LIMIT 1`);
  if (missingInventory)
    return { kind: "waiting" as const, reason: "source_inventory" as const };
  const archivePointer = await hasAttemptEvidenceStoragePointer(db) ? sql`raw.evidence_archive_id` : sql`NULL::uuid`;
  const sources = await db.execute(sql`WITH source_identities AS MATERIALIZED (
      SELECT DISTINCT source.point_content_signature, source.aoa_deg, source.case_slug
      FROM progressive_remote_report_sources source
      WHERE source.sim_job_id = ${executionId}::uuid AND source.sequence <= ${report.sequence}
        ${resultAttemptId ? sql`AND EXISTS (SELECT FROM progressive_remote_evidence_receipts selected
          WHERE selected.result_attempt_id=${resultAttemptId}::uuid AND selected.sim_job_id=source.sim_job_id
            AND selected.point_content_signature=source.point_content_signature AND NOT selected.storage_only)` : sql``}
      ORDER BY source.point_content_signature, source.aoa_deg, source.case_slug LIMIT 2049
    )
    SELECT source.point_content_signature, source.aoa_deg, source.case_slug,
      receipt.sequence, receipt.remote_result_id, receipt.remote_result_attempt_id, receipt.result_attempt_id, receipt.storage_only,
      owned_report.content_signature AS report_content_signature, ${archivePointer} AS archive_id,
      CASE WHEN ${archivePointer} IS NULL THEN raw.evidence_payload END AS evidence_payload, evidence.evidence_signature
    FROM source_identities source
    LEFT JOIN progressive_remote_evidence_receipts receipt
      ON receipt.sim_job_id = ${executionId}::uuid AND receipt.point_content_signature = source.point_content_signature
    LEFT JOIN progressive_remote_reports owned_report ON owned_report.sim_job_id = receipt.sim_job_id
      AND owned_report.sequence = receipt.sequence
    LEFT JOIN result_attempts raw ON raw.id = receipt.result_attempt_id
    LEFT JOIN progressive_cfd_evidence evidence ON evidence.result_attempt_id = raw.id
    ORDER BY source.point_content_signature, source.aoa_deg, source.case_slug`);
  if (sources.length > 2048)
    throw new Error(
      "Remote retention exceeds the bounded source-attempt inventory",
    );
  const missingAoas = [...new Set(sources.filter((source) => source.result_attempt_id == null)
    .map((source) => Number(source.aoa_deg)))];
  const classifications = missingAoas.length
    ? await readProgressiveRemoteSourceClassifications(db, executionId, missingAoas)
    : [];
  const terminalNoEvidence = new Set([
    ...terminalReportNoPhysicalEvidenceSignatures(report),
    ...classifications.filter((source) => source.kind === "material_diagnostic" || source.kind === "failure_diagnostic")
      .map((source) => source.pointContentSignature),
  ]);
  const missingEvidence = sources.filter(
    (source) =>
      source.result_attempt_id == null &&
      !terminalNoEvidence.has(String(source.point_content_signature)),
  ).length;
  if (missingEvidence && terminalReportHasNoPhysicalEvidence(report))
    return { kind: "verified_sources" as const, report, sources: [], incomplete: false };
  if (missingEvidence && !allowMissingSiblings)
    return {
      kind: "waiting" as const,
      reason: "raw_evidence" as const,
      sourceCount: sources.length,
      pendingCount: missingEvidence,
    };
  const retained: Array<{
    delivery: ProgressiveRemoteEvidenceDelivery;
    resultAttemptId: string;
    archived: boolean;
    storageOnly: boolean;
  }> = [];
  let pendingArchives = 0;
  for (const source of sources) {
    if (source.result_attempt_id == null) continue;
    if (
      source.archive_id == null && source.storage_only !== true &&
      (!source.evidence_signature ||
        analysisContentHash(source.evidence_payload) !==
          source.evidence_signature)
    )
      throw new Error(
        "Remote retention differs from its immutable CFD evidence receipt",
      );
    const delivery: ProgressiveRemoteEvidenceDelivery = {
      solverId: report.solverId,
      promiseId: report.promiseId,
      engineJobId: executionId,
      aoaDeg: Number(source.aoa_deg),
      engineCaseSlug:
        source.case_slug == null ? null : String(source.case_slug),
      remoteResultId: String(source.remote_result_id),
      remoteResultAttemptId: String(source.remote_result_attempt_id),
      progressiveEvidence: {
        sequence: Number(source.sequence),
        reportContentSignature: String(source.report_content_signature),
        pointContentSignature: String(source.point_content_signature),
      },
    };
    const prepared = retentionContext.getStore()?.deliveries.get(String(source.result_attempt_id));
    if (source.archive_id || prepared) {
      if (!prepared || canonicalAnalysisJson(prepared) !== canonicalAnalysisJson(delivery))
        throw new Error("Cold remote retention requires its current original delivery to be prepared before locking");
      delivery.progressiveEvidence = prepared.progressiveEvidence;
      const receipt = await readProgressiveRemoteEvidenceReceipt(db, delivery);
      if (receipt?.resultAttemptId !== source.result_attempt_id) throw new Error("Cold retained attempt changed");
    }
    const reported = await resolveProgressiveRemoteEvidence(db, delivery);
    if (!reported)
      throw new Error("Remote retention has no exact source report");
    if (source.archive_id && source.storage_only !== true &&
      analysisContentHash(progressiveRemotePointProjection(reported).evidencePayload) !== source.evidence_signature)
      throw new Error("Remote retention differs from its original CFD evidence receipt");
    const hasManifest =
      reported.point.evidence_artifacts?.some(
        (artifact) => artifact.kind === "manifest",
      ) ?? false;
    if (hasManifest) {
      const [upload] =
        await db.execute(sql`SELECT upload.id FROM sync_brokered_evidence_uploads upload
        WHERE upload.engine_job_id = ${executionId} AND upload.solver_id = ${report.solverId}::uuid
          AND upload.promise_id = ${report.promiseId}::uuid
          AND upload.canonical_result_attempt_id = ${source.result_attempt_id}::uuid AND upload.state = 'bound'
          AND EXISTS (SELECT 1 FROM solver_evidence_archives archive WHERE archive.result_attempt_id = upload.canonical_result_attempt_id
            AND archive.source_artifact_id = upload.canonical_artifact_id AND archive.state = 'current')
        ORDER BY upload.bound_at DESC, upload.id LIMIT 1`);
      if (!upload) {
        pendingArchives += 1;
        continue;
      }
      await readProgressiveEvidenceCustodyReceipt(
        db,
        delivery,
        String(upload.id),
      );
    }
    retained.push({
      delivery,
      resultAttemptId: String(source.result_attempt_id),
      archived: hasManifest,
      storageOnly: source.storage_only === true,
    });
  }
  if (pendingArchives && !allowMissingSiblings)
    return {
      kind: "waiting" as const,
      reason: "archives" as const,
      sourceCount: sources.length,
      pendingCount: pendingArchives,
    };
  return { kind: "verified_sources" as const, report, sources: retained, incomplete: missingEvidence > 0 || pendingArchives > 0 };
}
