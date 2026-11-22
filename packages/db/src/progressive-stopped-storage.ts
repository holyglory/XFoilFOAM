import { resolveStoredProgressiveReport } from "./progressive-report-reader";
import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash } from "./analysis-target";
import {
  resolveProgressiveRemoteEvidence,
  ProgressiveRemoteEvidenceConflict,
} from "./progressive-remote-evidence";
import type { ProgressiveRemoteEvidenceDelivery } from "./progressive-remote-evidence-receipts";
import {
  isFinalProgressiveRemoteReport,
  validateProgressiveRemoteReport,
} from "./progressive-remote-report";
import { validateProgressiveExecutionStopProof } from "./progressive-cfd-settlement";
import type { EngineExecutionStopProof } from "../../engine-client/src/types";
import type { ProgressiveRemoteReport } from "./progressive-remote-report";
import type { ProgressiveRemoteEvidenceReference } from "./progressive-remote-evidence";

const preparedFinals = new WeakMap<ProgressiveRemoteEvidenceReference, ProgressiveRemoteReport | null>();

export async function prepareStoppedProgressiveStorage(db: DB, delivery: ProgressiveRemoteEvidenceDelivery) {
  const [promise] = await db.execute(sql`SELECT status FROM sync_sweep_promises WHERE id=${delivery.promiseId}::uuid`);
  if (promise?.status === "active") {
    preparedFinals.set(delivery.progressiveEvidence,null);
    return;
  }
  const [row] = await db.execute(sql`SELECT sequence,content_signature,
    resolve_progressive_report(to_jsonb(r.*)) AS report FROM progressive_remote_reports r
    WHERE sim_job_id=${delivery.engineJobId}::uuid ORDER BY sequence DESC LIMIT 1`);
  if (!row) throw new ProgressiveRemoteEvidenceConflict("Stopped storage final report is missing");
  preparedFinals.set(delivery.progressiveEvidence, await resolveStoredProgressiveReport(db, "remote", row, delivery.engineJobId));
}

const stoppedAttemptOwner = sql`(
  (unit.state='blocked' AND unit.lease_token IS NULL AND unit.lease_until IS NULL)
  OR (unit.state='leased' AND unit.lease_token=attempt.token AND unit.lease_until<=clock_timestamp())
)`;

export async function assertStoppedProgressiveStorage(
  db: DB,
  delivery: ProgressiveRemoteEvidenceDelivery,
) {
  return (await assertStoppedProgressiveStorageAdmission(db, delivery)).source;
}

export async function assertStoppedProgressiveStorageAdmission(
  db: DB,
  delivery: ProgressiveRemoteEvidenceDelivery,
) {
  const source = await resolveProgressiveRemoteEvidence(db, delivery);
  if (!source)
    throw new ProgressiveRemoteEvidenceConflict(
      "Stopped storage requires an exact progressive source",
    );
  const [existing] = await db.execute(sql`SELECT storage_only,remote_result_id,remote_result_attempt_id FROM progressive_remote_evidence_receipts
    WHERE sim_job_id=${delivery.engineJobId}::uuid AND point_content_signature=${source.contentSignature}`);
  if (existing?.storage_only === true) {
    if (existing.remote_result_id !== delivery.remoteResultId || existing.remote_result_attempt_id !== delivery.remoteResultAttemptId)
      throw new ProgressiveRemoteEvidenceConflict("Stopped replay changed its immutable remote result or attempt");
    return { source, kind: "retained-replay" as const };
  }
  const [promise] = await db.execute(sql`SELECT status FROM sync_sweep_promises
    WHERE id=${delivery.promiseId}::uuid`);
  if (promise?.status === "active") {
    if (preparedFinals.get(delivery.progressiveEvidence)) throw new ProgressiveRemoteEvidenceConflict("Stopped assignment changed after preparation");
    const { assertProgressiveStoppedFailedEvidenceJob } = await import("./progressive-cfd-evidence");
    await assertProgressiveStoppedFailedEvidenceJob(db, delivery);
    return { source, kind: "current-failed" as const };
  }
  const preparedFinal = preparedFinals.get(delivery.progressiveEvidence);
  if (preparedFinal === null) throw new ProgressiveRemoteEvidenceConflict("Active assignment stopped after preparation; retry the exact delivery");
  const [stopped] = await db.execute(sql`
    SELECT job.status,job.engine_job_id,promise.status AS promise_status,
      stop.proof,stop.proof_signature,latest.report,latest.content_signature
    FROM sim_jobs job
    JOIN sync_sweep_promises promise ON promise.id=${delivery.promiseId}::uuid
    JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=job.id AND dispatch.promise_id=promise.id
    JOIN progressive_cfd_execution_stops stop ON stop.sim_job_id=job.id AND stop.engine_job_id=job.engine_job_id
    JOIN LATERAL (SELECT ${preparedFinal ? sql`NULL::jsonb` : sql`resolve_progressive_report(to_jsonb(progressive_remote_reports.*))`} AS report,content_signature FROM progressive_remote_reports
      WHERE sim_job_id=job.id ORDER BY sequence DESC LIMIT 1) latest ON true
    WHERE job.id=${delivery.engineJobId}::uuid
      AND (
        (
          job.status IN ('done','failed','cancelled')
          AND NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts attempt
            WHERE attempt.sim_job_id=job.id AND attempt.outcome='running')
        )
        OR (
          job.status='ingesting'
          AND EXISTS (SELECT 1 FROM progressive_cfd_attempts attempt
            JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
            WHERE attempt.sim_job_id=job.id AND attempt.outcome='running'
              AND ${stoppedAttemptOwner})
          AND NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts attempt
            JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
            WHERE attempt.sim_job_id=job.id AND attempt.outcome='running'
              AND NOT coalesce(${stoppedAttemptOwner},false))
        )
      )
      AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())
      AND promise.status IN ('cancelled','expired','fulfilled')
    FOR SHARE OF job,promise
  `);
  if (
    !stopped ||
    stopped.engine_job_id !== delivery.engineJobId ||
    analysisContentHash(stopped.proof) !== stopped.proof_signature
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Stopped storage requires closed ownership and its exact stop acknowledgement",
    );
  const proof = stopped.proof as EngineExecutionStopProof;
  const latest = validateProgressiveRemoteReport(
    preparedFinal ?? await resolveStoredProgressiveReport(db, "remote", stopped, delivery.engineJobId),
    source.envelope,
  );
  if (
    proof.job_id !== delivery.engineJobId ||
    latest.contentSignature !== stopped.content_signature ||
    !isFinalProgressiveRemoteReport(latest.report) ||
    !latest.report.stopProof ||
    latest.report.sequence < delivery.progressiveEvidence.sequence
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Stopped storage requires an immutable final report",
    );
  validateProgressiveExecutionStopProof(proof);
  validateProgressiveExecutionStopProof(latest.report.stopProof);
  return { source, kind: "legacy-closed" as const };
}
