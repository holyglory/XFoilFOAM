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

export async function assertStoppedProgressiveStorage(
  db: DB,
  delivery: ProgressiveRemoteEvidenceDelivery,
) {
  const source = await resolveProgressiveRemoteEvidence(db, delivery);
  if (!source)
    throw new ProgressiveRemoteEvidenceConflict(
      "Stopped storage requires an exact progressive source",
    );
  const [stopped] = await db.execute(sql`
    SELECT job.status,job.engine_job_id,promise.status AS promise_status,
      stop.proof,stop.proof_signature,latest.report,latest.content_signature
    FROM sim_jobs job
    JOIN sync_sweep_promises promise ON promise.id=${delivery.promiseId}::uuid
    JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=job.id AND dispatch.promise_id=promise.id
    JOIN progressive_cfd_execution_stops stop ON stop.sim_job_id=job.id AND stop.engine_job_id=job.engine_job_id
    JOIN LATERAL (SELECT report,content_signature FROM progressive_remote_reports
      WHERE sim_job_id=job.id ORDER BY sequence DESC LIMIT 1) latest ON true
    WHERE job.id=${delivery.engineJobId}::uuid
      AND job.status IN ('done','failed','cancelled')
      AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())
      AND promise.status IN ('cancelled','expired','fulfilled')
      AND NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts attempt
        WHERE attempt.sim_job_id=job.id AND attempt.outcome='running')
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
    stopped.report,
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
  return source;
}
