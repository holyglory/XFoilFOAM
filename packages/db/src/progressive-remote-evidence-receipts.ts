import { readAttemptEventDependencies } from "./attempt-evidence-proof-reader";
import { isProgressiveReceiptVerifier } from "./attempt-receipt-verification";
import { eq, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { DB } from "./client";
import { analysisContentHash } from "./analysis-target";
import {
  assertAttemptSourcePins,
  loadAttemptSourcePins,
  prepareAttemptSources,
  attemptSourceApplicationSha256,
  type PreparedAttemptSource,
  type AttemptSourcePin,
} from "./attempt-receipt-source";
import type { AttemptEvidenceArchiveReader } from "./attempt-evidence-reader";
import { resultAttempts } from "./schema";
import { recordProgressiveCfdEvidence } from "./progressive-cfd-evidence";
import type { ProgressiveStorageEvidenceRecoveryScope } from "./progressive-cfd-evidence";
import {
  ProgressiveRemoteEvidenceConflict,
  resolveProgressiveRemoteEvidence,
  prepareProgressiveRemoteEvidence,
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

interface PreparedRemoteReceipt {
  pin: PreparedAttemptSource["pin"];
  originalText?: string;
  receiptSequence: number;
  receiptSignature: string;
  storageOnly: boolean;
}
const preparedReceipts = new WeakMap<
  ProgressiveRemoteEvidenceReference,
  PreparedRemoteReceipt
>();
const preparedInline = new WeakMap<
  ProgressiveRemoteEvidenceReference,
  {
    id: string;
    resultId: string;
    sequence: number;
    signature: string;
    storageOnly: boolean;
  }
>();

async function sourceAndReceipt(
  db: DB,
  input: ProgressiveRemoteEvidenceDelivery,
  lock = false,
) {
  const source = await resolveProgressiveRemoteEvidence(db, input);
  if (!source)
    throw new ProgressiveRemoteEvidenceConflict(
      "Progressive delivery has no exact source report",
    );
  const [receipt] = await db.execute(sql`
    SELECT receipt.sequence, anchor.content_signature AS anchor_signature, receipt.result_attempt_id, receipt.remote_result_id, receipt.remote_result_attempt_id,
      receipt.received_at, receipt.storage_only, attempt.result_id FROM progressive_remote_evidence_receipts receipt
    JOIN result_attempts attempt ON attempt.id = receipt.result_attempt_id
    LEFT JOIN progressive_remote_reports anchor ON anchor.sim_job_id=receipt.sim_job_id AND anchor.sequence=receipt.sequence
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
  if (receipt && !/^[a-f0-9]{64}$/.test(String(receipt.anchor_signature)))
    throw new ProgressiveRemoteEvidenceConflict(
      "Original retained report signature is missing",
    );
  const prepared = preparedReceipts.get(input.progressiveEvidence);
  if (prepared) {
    const pin = prepared.pin;
    if (
      !receipt ||
      receipt.result_attempt_id !== pin.attemptId ||
      receipt.result_id !== pin.resultId ||
      pin.originalSimJobId !== input.engineJobId ||
      Number(receipt.sequence) !== prepared.receiptSequence ||
      receipt.anchor_signature !== prepared.receiptSignature ||
      receipt.storage_only !== prepared.storageOnly ||
      analysisContentHash(
        progressiveRemotePointProjection(source).evidencePayload,
      ) !== pin.applicationSha256
    )
      throw new ProgressiveRemoteEvidenceConflict(
        "Progressive replay changed its original receipt or scientific source",
      );
    await assertAttemptSourcePins(db, [pin], { lock });
  }
  return {
    source,
    receiptSignature: receipt ? String(receipt.anchor_signature) : null,
    receipt: receipt
      ? storedProgressivePointReceipt(receipt, input.engineJobId, source.contentSignature)
      : null,
  };
}

/** Project an existing receipt row with its verified execution and point. */
export function storedProgressivePointReceipt(receipt: Record<string, unknown>, executionId: string, pointContentSignature: string) {
  return {
          version: 1 as const,
          kind: "retained-progressive-attempt" as const,
          executionId,
          sequence: Number(receipt.sequence),
          pointContentSignature,
          resultId: String(receipt.result_id),
          resultAttemptId: String(receipt.result_attempt_id),
          remoteResultId: String(receipt.remote_result_id),
          remoteResultAttemptId: String(receipt.remote_result_attempt_id),
          storageOnly: receipt.storage_only === true,
          receivedAt: (receipt.received_at instanceof Date
            ? receipt.received_at
            : new Date(String(receipt.received_at))
          ).toISOString(),
        };
}

async function assertSignedStorageBinding(
  db: DB,
  input: ProgressiveRemoteEvidenceDelivery,
  observed: Awaited<ReturnType<typeof sourceAndReceipt>>,
  pin: AttemptSourcePin,
) {
  const { source, receipt, receiptSignature } = observed;
  if (
    !receipt ||
    !pin.archiveId ||
    !pin.storageEventId ||
    receipt.resultAttemptId !== pin.attemptId ||
    receipt.resultId !== pin.resultId ||
    pin.originalSimJobId !== input.engineJobId
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Archived attempt no longer has its original retained owner",
    );
  const [binding] =
    await db.execute(sql`SELECT e.verification#>>'{dependencies,verifier}' AS verifier,
      e.verification#>'{dependencies,progressiveScope}' AS scope, e.verification?'shortReceipt' AS packed
    FROM attempt_evidence_storage_events e JOIN progressive_remote_report_sources s
      ON s.sim_job_id=${input.engineJobId}::uuid AND s.sequence=${receipt.sequence}
      AND s.point_content_signature=${receipt.pointContentSignature} AND s.aoa_deg=${input.aoaDeg}
      AND s.case_slug IS NOT DISTINCT FROM ${input.engineCaseSlug}
    WHERE e.id=${pin.storageEventId}::uuid AND e.archive_id=${pin.archiveId}::uuid AND e.result_attempt_id=${pin.attemptId}::uuid
      AND e.action='shorten' AND e.completed`);
  if (!binding)
    throw new ProgressiveRemoteEvidenceConflict(
      "Original source inventory or storage event is missing",
    );
  if (isProgressiveReceiptVerifier(binding.verifier)) {
    // The short receipt keeps the remote binding in its archive-bound packed
    // fields. All of the original signature and scientific comparisons below
    // run against the same full scope as an ordinary receipt.
    const dependencies = binding.packed === true
      ? (await readAttemptEventDependencies(db, pin.storageEventId, pin.attemptId, pin.archiveId)) as
          { progressiveScope?: unknown } | undefined
      : undefined;
    const scope = (binding.packed === true ? dependencies?.progressiveScope : binding.scope) as {
      scientific?: { attemptToken: string; applicationSha256: string } | null;
      remote?: Record<string, unknown> | null;
    } | null;
    const remote = scope?.remote;
    if (
      !remote ||
      (scope?.scientific?.attemptToken ?? null) !== pin.cfdAttemptToken ||
      (scope?.scientific?.applicationSha256 ?? null) !==
        pin.cfdEvidenceSignature ||
      remote.executionId !== input.engineJobId ||
      remote.solverId !== input.solverId ||
      remote.promiseId !== input.promiseId ||
      remote.sequence !== receipt.sequence ||
      remote.reportContentSignature !== receiptSignature ||
      remote.pointContentSignature !== receipt.pointContentSignature ||
      remote.assignmentSignature !== source.report.assignmentSignature ||
      remote.remoteResultId !== receipt.remoteResultId ||
      remote.remoteResultAttemptId !== receipt.remoteResultAttemptId ||
      remote.storageOnly !== receipt.storageOnly ||
      remote.aoaDeg !== input.aoaDeg ||
      remote.caseSlug !== input.engineCaseSlug
    )
      throw new ProgressiveRemoteEvidenceConflict(
        "Current receipt differs from the original archived signed source",
      );
  }
}

/** Prepare before archive registration, fitting, or publication takes locks.
 * A repeated point may be delivered at another sequence. Its signed receipt
 * remains bound to the original report and both reports must authenticate. */
export async function prepareProgressiveRemoteReceiptReplay(
  db: DB,
  input: ProgressiveRemoteEvidenceDelivery,
  reader: AttemptEvidenceArchiveReader,
  options: { forRecovery?: boolean; signal?: AbortSignal } = {},
) {
  preparedReceipts.delete(input.progressiveEvidence);
  preparedInline.delete(input.progressiveEvidence);
  const { source, receipt, receiptSignature } = await sourceAndReceipt(
    db,
    input,
  );
  if (!receipt) return null;
  const [stored] = await db
    .select({ archiveId: resultAttempts.evidenceArchiveId })
    .from(resultAttempts)
    .where(eq(resultAttempts.id, receipt.resultAttemptId));
  if (!stored)
    throw new ProgressiveRemoteEvidenceConflict(
      "Original retained attempt is missing",
    );
  if (stored.archiveId === null) {
    preparedInline.set(input.progressiveEvidence, {
      id: receipt.resultAttemptId,
      resultId: receipt.resultId,
      sequence: receipt.sequence,
      signature: receiptSignature!,
      storageOnly: receipt.storageOnly,
    });
    return receipt;
  }
  const pins = await loadAttemptSourcePins(db, [receipt.resultAttemptId]);
  const original = (
    await prepareAttemptSources(db, reader, [...pins.values()], {
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    })
  ).get(receipt.resultAttemptId)!;
  const pin = original.pin;
  await assertSignedStorageBinding(
    db,
    input,
    { source, receipt, receiptSignature },
    pin,
  );
  const originalReport =
    receipt.sequence === input.progressiveEvidence.sequence
      ? source
      : await resolveProgressiveRemoteEvidence(db, {
          ...input,
          progressiveEvidence: {
            sequence: receipt.sequence,
            reportContentSignature: receiptSignature!,
            pointContentSignature: receipt.pointContentSignature,
          },
        });
  if (
    !originalReport ||
    pin.archiveId !== stored.archiveId ||
    pin.resultId !== receipt.resultId ||
    pin.originalSimJobId !== input.engineJobId ||
    analysisContentHash(
      progressiveRemotePointProjection(originalReport).evidencePayload,
    ) !== pin.applicationSha256 ||
    analysisContentHash(
      progressiveRemotePointProjection(source).evidencePayload,
    ) !== pin.applicationSha256
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Archived attempt differs from its original signed report point",
    );
  preparedReceipts.set(input.progressiveEvidence, {
    pin,
    ...(options.forRecovery ? { originalText: original.payloadText } : {}),
    receiptSequence: receipt.sequence,
    receiptSignature: receiptSignature!,
    storageOnly: receipt.storageOnly,
  });
  try {
    await assertProgressiveRemoteEvidenceAttempt(db, {
      ...input,
      resultAttemptId: pin.attemptId,
    });
  } catch (error) {
    preparedReceipts.delete(input.progressiveEvidence);
    throw error;
  }
  return receipt;
}

export async function recheckPreparedProgressiveRemoteReceipt(
  db: DB,
  input: ProgressiveRemoteEvidenceDelivery,
) {
  const inline = preparedInline.get(input.progressiveEvidence);
  if (inline) {
    const [row] =
      await db.execute(sql`SELECT r.sequence FROM progressive_remote_evidence_receipts r
      JOIN result_attempts a ON a.id=r.result_attempt_id JOIN progressive_remote_reports anchor
        ON anchor.sim_job_id=r.sim_job_id AND anchor.sequence=r.sequence
      WHERE a.id=${inline.id}::uuid AND a.result_id=${inline.resultId}::uuid AND a.evidence_archive_id IS NULL
      AND r.sequence=${inline.sequence} AND anchor.content_signature=${inline.signature} AND r.storage_only=${inline.storageOnly}
      AND r.sim_job_id=${input.engineJobId}::uuid
      AND r.point_content_signature=${input.progressiveEvidence.pointContentSignature}
      AND r.remote_result_id=${input.remoteResultId}::uuid AND r.remote_result_attempt_id=${input.remoteResultAttemptId}::uuid
      ${is(db, PgTransaction) ? sql`FOR SHARE OF a` : sql``}`);
    if (!row)
      throw new ProgressiveRemoteEvidenceConflict(
        "Inline receipt source changed; prepare the exact replay again",
      );
  } else {
    const cold = preparedReceipts.get(input.progressiveEvidence);
    if (cold)
      await assertProgressiveRemoteEvidenceAttempt(
        db,
        {
          ...input,
          resultAttemptId: cold.pin.attemptId,
        },
        is(db, PgTransaction),
      );
  }
}

export async function readProgressiveRemoteEvidenceReceipt(
  db: DB,
  input: ProgressiveRemoteEvidenceDelivery,
) {
  return (await sourceAndReceipt(db, input)).receipt;
}

/** Replays authenticate all scientific scalar outputs as well as the
 * complete application payload. Both the report and retained-source paths use this check. */
export function assertProgressivePointMatchesAttempt(
  attempt: typeof resultAttempts.$inferSelect,
  projection: ReturnType<typeof progressiveRemotePointProjection>,
  sourceHash: unknown,
) {
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
}

export async function assertProgressiveRemoteEvidenceAttempt(
  db: DB,
  input: ProgressiveRemoteEvidenceDelivery & {
    resultAttemptId: string;
    recoveryScope?: ProgressiveStorageEvidenceRecoveryScope;
  },
  lock = false,
) {
  const observed = await sourceAndReceipt(db, input, lock);
  const { source } = observed;
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
  const prepared = preparedReceipts.get(input.progressiveEvidence);
  if (attempt.evidenceArchiveId && prepared) {
    if (prepared.pin.attemptId !== attempt.id)
      throw new ProgressiveRemoteEvidenceConflict(
        "Prepared replay belongs to another local attempt",
      );
    sourceHash = prepared.pin.applicationSha256;
  } else if (attempt.evidenceArchiveId) {
    const [event] =
      await db.execute(sql`SELECT verification#>>'{dependencies,verifier}' AS verifier FROM attempt_evidence_storage_events
      WHERE id=${attempt.evidenceStorageEventId}::uuid AND archive_id=${attempt.evidenceArchiveId}::uuid
        AND result_attempt_id=${attempt.id}::uuid AND completed AND action='shorten'`);
    if (isProgressiveReceiptVerifier(event?.verifier)) {
      const pin = (await loadAttemptSourcePins(db, [attempt.id])).get(
        attempt.id,
      )!;
      await assertSignedStorageBinding(db, input, observed, pin);
      sourceHash = attemptSourceApplicationSha256(pin);
    } else {
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
    }
  } else {
    sourceHash = analysisContentHash(attempt.evidencePayload);
  }
  assertProgressivePointMatchesAttempt(attempt, projection, sourceHash);
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
  return {
    archiveId: attempt.evidenceArchiveId,
    payload: projection.evidencePayload,
    ...(prepared?.originalText ? { originalText: prepared.originalText } : {}),
  };
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
  if (
    !is(db, PgTransaction) &&
    (!preparedReceipts.has(input.progressiveEvidence) ||
      (input.recoveryScope &&
        !preparedReceipts.get(input.progressiveEvidence)?.originalText))
  ) {
    const [cold] = await db.execute(
      sql`SELECT 1 FROM result_attempts WHERE id=${input.resultAttemptId}::uuid AND evidence_archive_id IS NOT NULL`,
    );
    if (cold) {
      const { progressiveRetentionReader } =
        await import("./progressive-remote-retention");
      const reader = progressiveRetentionReader();
      if (!reader)
        throw new ProgressiveRemoteEvidenceConflict(
          "Original attempt reader is unavailable for this replay",
        );
      // This is a standalone operation. A later read may reuse the caller's
      // delivery object after a genuine restore or re-shorten. Its immutable
      // scientific identity survives, but this operation's storage pin does not.
      input = {
        ...input,
        progressiveEvidence: { ...input.progressiveEvidence },
      };
      await prepareProgressiveRemoteEvidence(db, input);
      await prepareProgressiveRemoteReceiptReplay(db, input, reader, {
        forRecovery: Boolean(input.recoveryScope),
      });
    }
  }
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const { source, receipt } = await sourceAndReceipt(connection, input, true);
    if (receipt) {
      if (receipt.resultAttemptId !== input.resultAttemptId)
        throw new Error(
          "Progressive receipt already binds another local attempt",
        );
      if (!input.recoveryScope) {
        const [owner] = await connection
          .select({
            archiveId: resultAttempts.evidenceArchiveId,
            eventId: resultAttempts.evidenceStorageEventId,
          })
          .from(resultAttempts)
          .where(eq(resultAttempts.id, receipt.resultAttemptId))
          .for("share");
        if (!owner)
          throw new ProgressiveRemoteEvidenceConflict(
            "Receipt attempt is missing",
          );
        if (
          owner.archiveId &&
          !preparedReceipts.has(input.progressiveEvidence)
        ) {
          const [legacy] =
            await connection.execute(sql`SELECT 1 FROM attempt_evidence_storage_events WHERE id=${owner.eventId}::uuid
            AND archive_id=${owner.archiveId}::uuid AND result_attempt_id=${receipt.resultAttemptId}::uuid AND completed AND action='shorten'
            AND verification#>>'{dependencies,verifier}'='server-consumers/stopped-progressive-rans-v1'`);
          if (!legacy)
            throw new ProgressiveRemoteEvidenceConflict(
              "Cold receipt requires its original bytes before replay",
            );
          await assertProgressiveRemoteEvidenceAttempt(connection, input);
        }
        return receipt;
      }
    }
    if (input.recoveryScope && (!receipt?.storageOnly || input.storageOnly))
      throw new ProgressiveRemoteEvidenceConflict(
        "Historical recovery requires an existing immutable storage-only receipt",
      );
    const verified = await assertProgressiveRemoteEvidenceAttempt(
      connection,
      input,
    );
    if (input.recoveryScope && verified.archiveId) {
      // The already authenticated report point had to reproduce the original
      // PG text at shortening. Restore under the same transaction before
      // recording any numerical signature. All normal recovery gates follow.
      await connection.execute(sql`SELECT attempt_evidence_restore(${input.resultAttemptId}::uuid,
        ${verified.archiveId}::uuid,coalesce(${verified.originalText ?? null}::text,(${JSON.stringify(verified.payload)}::jsonb)::text),
        'original reported point required for progressive scientific recovery')`);
    }
    if (input.storageOnly) {
      const admission = await assertStoppedProgressiveStorageAdmission(
        connection,
        input,
      );
      if (admission.kind === "current-failed")
        await recordProgressiveCfdEvidence(connection, {
          simJobId: input.engineJobId,
          engineJobId: input.engineJobId,
          resultAttemptIds: [input.resultAttemptId],
          stoppedFailedStorage: input,
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
