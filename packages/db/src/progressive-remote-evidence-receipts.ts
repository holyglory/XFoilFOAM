import { eq, sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash } from "./analysis-target";
import { resultAttempts } from "./schema";
import { recordProgressiveCfdEvidence } from "./progressive-cfd-evidence";
import type { ProgressiveStorageEvidenceRecoveryScope } from "./progressive-cfd-evidence";
import {
  ProgressiveRemoteEvidenceConflict,
  resolveProgressiveRemoteEvidence,
  type ProgressiveRemoteEvidenceReference,
} from "./progressive-remote-evidence";
import {
  assertProgressiveRemotePhysicalCase,
  progressiveRemotePointProjection,
} from "./progressive-remote-point-projection";
import { assertStoppedProgressiveStorageAdmission } from "./progressive-stopped-storage";

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
      receipt.received_at, receipt.storage_only, attempt.result_id FROM progressive_remote_evidence_receipts receipt
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
          storageOnly: receipt.storage_only === true,
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

export async function assertProgressiveRemoteEvidenceAttempt(
  db: DB,
  input: ProgressiveRemoteEvidenceDelivery & {
    resultAttemptId: string;
    recoveryScope?: ProgressiveStorageEvidenceRecoveryScope;
  },
) {
  const { source } = await sourceAndReceipt(db, input);
  const [attempt] = await db
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
  // A storage-only replay still authenticates the independently reconstructed
  // report point. The sealed digest is the application's original numerical
  // JSON identity, distinct from PostgreSQL's exact source-text fingerprint.
  let sourceHash: unknown;
  if (attempt.evidenceArchiveId) {
    const [sealed] = await db.execute(sql`WITH candidate AS MATERIALIZED (
        SELECT (${JSON.stringify(projection.evidencePayload)}::jsonb)::text AS original
      ) SELECT e.verification#>>'{dependencies,applicationSha256}' AS digest
      FROM attempt_evidence_storage_events e JOIN attempt_evidence_history_projections p
        ON p.result_attempt_id=e.result_attempt_id AND p.archive_id=e.archive_id CROSS JOIN candidate
      WHERE e.id=${attempt.evidenceStorageEventId}::uuid AND e.result_attempt_id=${attempt.id}::uuid
        AND e.archive_id=${attempt.evidenceArchiveId}::uuid AND e.action='shorten' AND e.completed
        AND e.verification#>>'{dependencies,verifier}'='server-consumers/stopped-progressive-rans-v1'
        AND e.verification#>>'{dependencies,sourceSha256}'=p.projection->>'sourceSha256'
        AND p.projection->>'sourceSha256'=encode(sha256(convert_to(candidate.original,'UTF8')),'hex')
        AND (p.projection->>'sourceByteSize')::bigint=octet_length(candidate.original)
        AND e.verification#>>'{dependencies,progressiveScope,pointContentSignature}'=${source.contentSignature}
        AND e.verification#>>'{dependencies,progressiveScope,executionId}'=${input.engineJobId}`);
    sourceHash = sealed?.digest;
  } else {
    sourceHash = analysisContentHash(attempt.evidencePayload);
  }
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
    sourceHash !== analysisContentHash(projection.evidencePayload)
  )
    throw new Error(
      "Progressive local attempt differs from its reported source values",
    );
  if (input.recoveryScope) {
    const [revision] = await db.execute(sql`
      SELECT snapshot FROM simulation_preset_revisions
      WHERE id = ${attempt.simulationPresetRevisionId}::uuid
    `);
    if (!revision)
      throw new Error(
        "Historical progressive evidence has no immutable execution revision",
      );
    assertProgressiveRemotePhysicalCase(
      source,
      revision.snapshot as Parameters<
        typeof assertProgressiveRemotePhysicalCase
      >[1],
    );
  }
  return { archiveId: attempt.evidenceArchiveId, payload: projection.evidencePayload };
}

export async function recordProgressiveRemoteEvidenceReceipt(
  db: DB,
  input: ProgressiveRemoteEvidenceDelivery & {
    resultAttemptId: string;
    storageOnly?: boolean;
    recoveryScope?: ProgressiveStorageEvidenceRecoveryScope;
  },
) {
  if (input.recoveryScope) {
    const { assertProgressiveStorageEvidenceRecoveryRole } =
      await import("./progressive-cfd-evidence");
    assertProgressiveStorageEvidenceRecoveryRole();
  }
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const { source, receipt } = await sourceAndReceipt(connection, input);
    if (receipt) {
      if (receipt.resultAttemptId !== input.resultAttemptId)
        throw new Error(
          "Progressive receipt already binds another local attempt",
        );
      if (!input.recoveryScope) return receipt;
    }
    if (input.recoveryScope && (!receipt?.storageOnly || input.storageOnly))
      throw new ProgressiveRemoteEvidenceConflict(
        "Historical recovery requires an existing immutable storage-only receipt",
      );
    const verified = await assertProgressiveRemoteEvidenceAttempt(connection, input);
    if (input.recoveryScope && verified.archiveId) {
      // The already authenticated report point had to reproduce the original
      // PG text at shortening. Restore under the same transaction before
      // recording any numerical signature. All normal recovery gates follow.
      await connection.execute(sql`SELECT attempt_evidence_restore(${input.resultAttemptId}::uuid,
        ${verified.archiveId}::uuid,(${JSON.stringify(verified.payload)}::jsonb)::text,
        'original reported point required for progressive scientific recovery')`);
    }
    if (input.storageOnly) {
      const admission = await assertStoppedProgressiveStorageAdmission(connection, input);
      if (admission.kind === "current-failed")
        await recordProgressiveCfdEvidence(connection, {
          simJobId: input.engineJobId, engineJobId: input.engineJobId,
          resultAttemptIds: [input.resultAttemptId], stoppedFailedStorage: input,
        });
    } else
      await recordProgressiveCfdEvidence(connection, {
        simJobId: input.engineJobId,
        engineJobId: input.engineJobId,
        resultAttemptIds: [input.resultAttemptId],
        recoveryScope: input.recoveryScope,
      });
    await connection.execute(sql`
      INSERT INTO progressive_remote_evidence_receipts
        (sim_job_id, sequence, point_content_signature, result_attempt_id, remote_result_id, remote_result_attempt_id, storage_only)
      VALUES (${input.engineJobId}::uuid, ${input.progressiveEvidence.sequence}, ${source.contentSignature},
        ${input.resultAttemptId}::uuid, ${input.remoteResultId}::uuid, ${input.remoteResultAttemptId}::uuid, ${input.storageOnly === true})
      ON CONFLICT (sim_job_id, point_content_signature) DO NOTHING
    `);
    const stored = (await sourceAndReceipt(connection, input)).receipt;
    if (!stored || stored.resultAttemptId !== input.resultAttemptId)
      throw new Error("Progressive receipt lost its exact attempt binding");
    return stored;
  });
}
