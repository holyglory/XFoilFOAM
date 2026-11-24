import { createHash } from "node:crypto";
import {
  analysisContentHash,
  progressiveReportedPointSources,
  progressiveRemotePointProjection,
  validateProgressiveRemoteReport,
  type DB,
  type ProgressiveRemoteExecutionEnvelope,
} from "@aerodb/db";
import { progressiveReportedDiagnosticFailureKind } from "@aerodb/db/progressive-remote-retention";
import { sql } from "drizzle-orm";

type DiagnosticPin = {
  point: string;
  attempt: string;
  sequence: number;
  receipt: unknown;
  version: string;
};
export type TerminalDiagnostics = {
  pins: DiagnosticPin[];
  signature: string | null;
};

// The broker supplies raw custody for real artifacts. A signed, metadata-only
// diagnostic has a separate canonical receipt and no archive to deliver.
const unpackaged = sql`a.status='failed' AND a.valid_for_polar IS FALSE AND a.converged IS FALSE
  AND a.cl IS NULL AND a.cd IS NULL AND a.cm IS NULL AND a.evidence_archive_id IS NULL
  AND NOT EXISTS(SELECT FROM solver_evidence_artifacts art WHERE art.result_attempt_id=a.id)
  AND NOT EXISTS(SELECT FROM result_media media WHERE media.result_attempt_id=a.id)
  AND NOT EXISTS(SELECT FROM force_history force WHERE force.result_attempt_id=a.id)`;
const rowVersion = sql`a.xmin::text||'/'||a.ctid::text`;

function matchesFailure(
  receipt: Record<string, unknown>,
  source: ReturnType<typeof progressiveReportedPointSources>[number],
  envelope: ProgressiveRemoteExecutionEnvelope,
) {
  const kind = progressiveReportedDiagnosticFailureKind(source.point);
  if (!kind) return false;
  switch (receipt.version) {
    case 1:
      return kind === "material_domain";
    case 2:
      return (
        (kind === "infrastructure" || kind === "hard_solver") &&
        receipt.failureKind === kind
      );
    case 3:
      return (
        kind === "infrastructure" &&
        receipt.failureKind === kind &&
        receipt.custody === "terminal_history" &&
        envelope.scope.units.some(
          (u) =>
            u.alpha === source.point.aoa_deg &&
            u.token === receipt.attemptToken,
        )
      );
    default:
      return false;
  }
}

export async function readTerminalDiagnostics(
  db: DB,
  execution: string,
  envelope: ProgressiveRemoteExecutionEnvelope,
): Promise<TerminalDiagnostics> {
  const rows =
    await db.execute(sql`SELECT h.sequence,h.result_attempt_id,h.point_content_signature,h.receipt,
      encode(sha256(convert_to(h.receipt::text,'UTF8')),'hex') AS receipt_sha,
      ${rowVersion} AS version, a.evidence_payload,e.content_signature AS report_signature
    FROM progressive_worker_hub_receipts h
    JOIN result_attempts a ON a.id=h.result_attempt_id AND a.sim_job_id=h.sim_job_id AND a.engine_job_id=h.sim_job_id::text
    JOIN progressive_worker_evidence_attempts link ON (link.sim_job_id,link.sequence,link.result_attempt_id,link.point_content_signature)=
      (h.sim_job_id,h.sequence,h.result_attempt_id,h.point_content_signature)
    JOIN progressive_worker_evidence_receipts e ON (e.sim_job_id,e.sequence)=(h.sim_job_id,h.sequence)
    WHERE h.sim_job_id=${execution}::uuid AND h.receipt->>'kind'='retained-progressive-diagnostic'
      AND ${unpackaged}
      AND NOT EXISTS(SELECT FROM progressive_worker_archive_receipts ar WHERE ar.sim_job_id=h.sim_job_id AND ar.point_content_signature=h.point_content_signature)
    ORDER BY h.point_content_signature COLLATE "C"`);
  const pins: DiagnosticPin[] = [];
  const digest = createHash("sha256");
  const originals = new Map<
    number,
    ReturnType<typeof validateProgressiveRemoteReport>
  >();
  for (const row of rows) {
    const sequence = Number(row.sequence);
    let verified = originals.get(sequence);
    if (!verified) {
      // All worker archive writers lock a terminal local promise before
      // compaction. This verifier serves active mirrors (see the storage contract).
      const [stored] =
        await db.execute(sql`SELECT resolve_progressive_report(r.report,r.result_payload_hash) AS original,r.content_signature
        FROM progressive_worker_reports r WHERE r.sim_job_id=${execution}::uuid AND r.sequence=${sequence}
          AND r.assignment_signature=${envelope.contentSignature} AND r.acknowledged_at IS NOT NULL AND r.archive_bundle_id IS NULL`);
      if (!stored) continue;
      verified = validateProgressiveRemoteReport(stored.original, envelope);
      if (verified.contentSignature !== stored.content_signature) continue;
      originals.set(sequence, verified);
    }
    const { report, contentSignature } = verified;
    const receipt = row.receipt as Record<string, unknown> | null;
    const source =
      report.result &&
      progressiveReportedPointSources(report.result).find(
        (s) => s.contentSignature === row.point_content_signature,
      );
    if (
      !receipt ||
      !source ||
      receipt.executionId !== execution ||
      receipt.sequence !== sequence ||
      receipt.pointContentSignature !== source.contentSignature ||
      receipt.reportContentSignature !== contentSignature ||
      row.report_signature !== contentSignature
    )
      continue;
    if (!matchesFailure(receipt, source, envelope)) continue;
    if (
      analysisContentHash(
        progressiveRemotePointProjection({ ...source, envelope, report })
          .evidencePayload,
      ) !== analysisContentHash(row.evidence_payload)
    )
      continue;
    pins.push({
      point: source.contentSignature,
      attempt: String(row.result_attempt_id),
      sequence,
      receipt,
      version: String(row.version),
    });
    digest.update(Buffer.from(String(row.receipt_sha), "hex"));
  }
  return { pins, signature: pins.length ? digest.digest("hex") : null };
}

export function provenTerminalDiagnostic(verified: TerminalDiagnostics) {
  if (!verified.pins.length) return sql`false`;
  return sql`EXISTS(SELECT FROM jsonb_to_recordset(${JSON.stringify(verified.pins)}::jsonb)
      proof(point text,attempt uuid,sequence bigint,receipt jsonb,version text)
    JOIN result_attempts a ON a.id=proof.attempt
    WHERE proof.point=h.point_content_signature AND proof.attempt=h.result_attempt_id
      AND proof.sequence=h.sequence AND proof.receipt=h.receipt AND ${rowVersion}=proof.version
      AND a.sim_job_id=h.sim_job_id AND a.engine_job_id=h.sim_job_id::text AND ${unpackaged})`;
}
