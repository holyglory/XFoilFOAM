import { eq, sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash } from "./analysis-target";
import { resultAttempts } from "./schema";
import { recordProgressiveCfdEvidence } from "./progressive-cfd-evidence";
import {
  ProgressiveRemoteEvidenceConflict,
  resolveProgressiveRemoteEvidence,
  type ProgressiveRemoteEvidenceReference,
} from "./progressive-remote-evidence";
import { progressiveRemotePointProjection } from "./progressive-remote-point-projection";

export interface ProgressiveRemoteEvidenceDelivery {
  solverId: string;
  promiseId: string;
  engineJobId: string;
  aoaDeg: number;
  engineCaseSlug: string | null;
  progressiveEvidence: ProgressiveRemoteEvidenceReference;
  remoteResultId: string;
  remoteResultAttemptId: string;
}

async function sourceAndReceipt(
  db: DB,
  input: ProgressiveRemoteEvidenceDelivery,
) {
  const source = await resolveProgressiveRemoteEvidence(db, input);
  if (!source)
    throw new ProgressiveRemoteEvidenceConflict(
      "Progressive delivery has no exact source report",
    );
  const [receipt] = await db.execute(sql`
    SELECT receipt.sequence, receipt.result_attempt_id, receipt.remote_result_id, receipt.remote_result_attempt_id,
      receipt.received_at, attempt.result_id FROM progressive_remote_evidence_receipts receipt
    JOIN result_attempts attempt ON attempt.id = receipt.result_attempt_id
    WHERE receipt.sim_job_id = ${input.engineJobId}::uuid AND receipt.point_content_signature = ${source.contentSignature}
  `);
  if (
    receipt &&
    (receipt.remote_result_id !== input.remoteResultId ||
      receipt.remote_result_attempt_id !== input.remoteResultAttemptId)
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Progressive delivery changed its immutable remote evidence identity",
    );
  if (receipt && !receipt.result_id)
    throw new Error(
      "Progressive retained attempt has no canonical evidence cell",
    );
  return {
    source,
    receipt: receipt
      ? {
          version: 1 as const,
          kind: "retained-progressive-attempt" as const,
          executionId: input.engineJobId,
          sequence: Number(receipt.sequence),
          pointContentSignature: source.contentSignature,
          resultId: String(receipt.result_id),
          resultAttemptId: String(receipt.result_attempt_id),
          remoteResultId: String(receipt.remote_result_id),
          remoteResultAttemptId: String(receipt.remote_result_attempt_id),
          receivedAt: (receipt.received_at instanceof Date
            ? receipt.received_at
            : new Date(String(receipt.received_at))
          ).toISOString(),
        }
      : null,
  };
}

export async function readProgressiveRemoteEvidenceReceipt(
  db: DB,
  input: ProgressiveRemoteEvidenceDelivery,
) {
  return (await sourceAndReceipt(db, input)).receipt;
}

export async function recordProgressiveRemoteEvidenceReceipt(
  db: DB,
  input: ProgressiveRemoteEvidenceDelivery & { resultAttemptId: string },
) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const { source, receipt } = await sourceAndReceipt(connection, input);
    if (receipt) {
      if (receipt.resultAttemptId !== input.resultAttemptId)
        throw new Error(
          "Progressive receipt already binds another local attempt",
        );
      return receipt;
    }
    const [attempt] = await connection
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.id, input.resultAttemptId));
    if (
      !attempt ||
      attempt.simJobId !== input.engineJobId ||
      attempt.engineJobId !== input.engineJobId ||
      !attempt.resultId
    )
      throw new Error(
        "Progressive receipt requires exact owned local attempt evidence",
      );
    const projection = progressiveRemotePointProjection(source);
    const sourceFields = [
      "aoaDeg",
      "status",
      "source",
      "regime",
      "cl",
      "cd",
      "cm",
      "clCd",
      "clStd",
      "cdStd",
      "cmStd",
      "stalled",
      "unsteady",
      "converged",
      "finalResidual",
      "iterations",
      "yPlusAvg",
      "yPlusMax",
      "nCells",
      "firstOrderFallback",
      "strouhal",
      "error",
      "qualityWarnings",
      "methodKey",
      "engineJobId",
      "engineCaseSlug",
    ] as const;
    if (
      sourceFields.some(
        (key) =>
          analysisContentHash(attempt[key] ?? null) !==
          analysisContentHash(projection[key] ?? null),
      ) ||
      analysisContentHash(attempt.evidencePayload) !==
        analysisContentHash(projection.evidencePayload)
    )
      throw new Error(
        "Progressive local attempt differs from its reported source values",
      );
    await recordProgressiveCfdEvidence(connection, {
      simJobId: input.engineJobId,
      engineJobId: input.engineJobId,
      resultAttemptIds: [input.resultAttemptId],
    });
    await connection.execute(sql`
      INSERT INTO progressive_remote_evidence_receipts
        (sim_job_id, sequence, point_content_signature, result_attempt_id, remote_result_id, remote_result_attempt_id)
      VALUES (${input.engineJobId}::uuid, ${input.progressiveEvidence.sequence}, ${source.contentSignature},
        ${input.resultAttemptId}::uuid, ${input.remoteResultId}::uuid, ${input.remoteResultAttemptId}::uuid)
      ON CONFLICT (sim_job_id, point_content_signature) DO NOTHING
    `);
    const stored = (await sourceAndReceipt(connection, input)).receipt;
    if (!stored || stored.resultAttemptId !== input.resultAttemptId)
      throw new Error("Progressive receipt lost its exact attempt binding");
    return stored;
  });
}
