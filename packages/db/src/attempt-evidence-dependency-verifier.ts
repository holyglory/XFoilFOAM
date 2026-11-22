import { buildPolarFit, classifyPolarEvidence } from "@aerodb/core";
import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import {
  attemptEvidenceColdCohortSql,
  projectAttemptEvidenceForConsumers,
} from "./attempt-evidence-consumers";
import type { AttemptEvidenceArchiveReader } from "./attempt-evidence-reader";
import type {
  AttemptEvidenceDependencyVerifier,
  AttemptEvidenceDependencyProof,
} from "./attempt-evidence-projection";
import { readPolarAttemptEvidenceForConsumerProof } from "./polar-cache";
import { precalcContinuationProgressFromEvidence } from "./precalc-obligations";
import { requireConfiguredAttemptHubRole, verifiedAttemptProofScope } from "./attempt-evidence-verified-policy";
import { getAttemptEvidenceStoragePolicy } from "./attempt-evidence-projection";
import {
  RECEIPT_SOURCE_VERIFIER,
  URANS_RECEIPT_SOURCE_VERIFIER,
  verifyProgressiveAttemptReceipt,
} from "./attempt-receipt-verification";
import {
  canonicalReportJson,
  parseReportJson,
  reportTextIdentity,
} from "./progressive-report-archive";

export const ATTEMPT_SERVER_CONSUMER_VERIFIER =
  "server-consumers/local-steady-rans-v1";

const STOPPED_VERIFIER = "server-consumers/stopped-progressive-rans-v1";

/** Authenticate the independent signed dispatch/report projection and the
 * measured stop outside the scientific snapshot. No sampling or GCS read is
 * needed by the fitter: this receipt never entered progressive_cfd_evidence.
 * A later numerical registration requires restoration of the exact original. */
async function verifyStoppedSource(
  db: DB,
  attemptId: string,
  originalText: string,
) {
  const [receipt] =
    await db.execute(sql`SELECT storage_only FROM progressive_remote_evidence_receipts
    WHERE result_attempt_id=${attemptId}::uuid`);
  if (receipt?.storage_only !== true) return null;
  const [row] =
    await db.execute(sql`SELECT attempt_evidence_stopped_scope(a.id) AS scope,stopped.proof
    FROM result_attempts a JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=a.sim_job_id
    WHERE a.id=${attemptId}::uuid`);
  const scope = row?.scope as Record<string, unknown> | null;
  requireProof(
    scope,
    "stopped progressive custody or superseding attempt changed",
  );
  const { validateProgressiveExecutionStopProof } =
    await import("./progressive-cfd-settlement");
  const stop = row.proof as Parameters<
    typeof validateProgressiveExecutionStopProof
  >[0];
  validateProgressiveExecutionStopProof(stop);
  requireProof(
    stop.job_id === scope.executionId &&
      analysisContentHash(stop) === scope.stopSignature,
    "stopped execution proof changed",
  );
  const { assertProgressiveRemoteEvidenceAttempt } =
    await import("./progressive-remote-evidence-receipts");
  const verified = await assertProgressiveRemoteEvidenceAttempt(db, {
    solverId: String(scope.solverId),
    promiseId: String(scope.promiseId),
    engineJobId: String(scope.executionId),
    resultAttemptId: attemptId,
    remoteResultId: String(scope.remoteResultId),
    remoteResultAttemptId: String(scope.remoteResultAttemptId),
    aoaDeg: Number(scope.aoaDeg),
    engineCaseSlug: String(scope.caseSlug),
    progressiveEvidence: {
      sequence: Number(scope.sequence),
      reportContentSignature: String(scope.reportContentSignature),
      pointContentSignature: String(scope.pointContentSignature),
    },
  });
  const digest = analysisContentHash(JSON.parse(originalText));
  requireProof(
    !verified.archiveId && analysisContentHash(verified.payload) === digest,
    "signed report and full application source differ",
  );
  const [original] = await db.execute(
    sql`SELECT (${JSON.stringify(verified.payload)}::jsonb)::text = ${originalText} AS matches`,
  );
  requireProof(
    original?.matches === true,
    "signed replay cannot restore the exact original PostgreSQL text",
  );
  return { progressiveScope: scope, applicationSha256: digest };
}

function requireProof(value: unknown, reason: string): asserts value {
  if (!value)
    throw new Error(`Attempt evidence dependency proof refused: ${reason}`);
}

function forcePresent(
  payload: Record<string, unknown>,
  facts: Map<string, number>,
): boolean {
  const parent =
    payload.force_history !== null && payload.force_history !== undefined
      ? "force_history"
      : "forceHistory";
  const raw = payload[parent];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const object = raw as Record<string, unknown>;
  return ["t", "cl", "cd"].every((child) =>
    Object.hasOwn(object, child)
      ? Array.isArray(object[child]) && object[child].length > 0
      : (facts.get(JSON.stringify([parent, child])) ?? 0) > 0,
  );
}

function normalizedHistory(
  payload: Record<string, unknown>,
  snake: string,
  camel: string,
) {
  return payload[snake] !== null && payload[snake] !== undefined
    ? payload[snake]
    : (payload[camel] ?? null);
}

function decisions(classified: ReturnType<typeof classifyPolarEvidence>) {
  return {
    lowAoaFailure: classified.lowAoaFailure,
    needsUransAoas: classified.needsUransAoas,
    hardRejectedAoas: classified.hardRejectedAoas,
    classifications: classified.classifications.map((entry) => ({
      attemptId: (entry.evidence as { resultAttemptId?: string | null })
        .resultAttemptId,
      state: entry.state,
      reasons: entry.reasons,
      region: entry.region,
      confidence: entry.confidence,
    })),
    fit: buildPolarFit(classified.classifications),
  };
}

/** Actual archive access happens BEFORE the bounded read-only SQL snapshot.
 * This verifier never updates a verdict, curve, attempt or scheduling owner.
 * The writer must repeat attemptEvidenceColdCohortSql in its final locked CAS. */
export function createAttemptServerDependencyVerifier(
  db: DB,
  reader: AttemptEvidenceArchiveReader,
  verifyWorker?: (
    attemptId: string,
    original: string,
  ) => Promise<Record<string, unknown>>,
): AttemptEvidenceDependencyVerifier {
  return async (input): Promise<AttemptEvidenceDependencyProof> => {
    const { attemptId, archive, preview, originalPayloadText } = input;
    const projection = preview.projection;
    const source = reportTextIdentity(originalPayloadText);
    requireProof(
      attemptId === archive.attemptId &&
        source.sha256 === archive.sourceSha256 &&
        source.byteSize === archive.sourceByteSize,
      "original source/catalog identity changed",
    );
    requireProof(
      projection.version === 1 &&
        projection.attemptId === attemptId &&
        projection.archiveId === archive.id &&
        projection.sourceSha256 === source.sha256 &&
        projection.sourceByteSize === source.byteSize,
      "projection identifies another source",
    );
    requireProof(
      reportTextIdentity(preview.compactPayloadText).sha256 ===
        projection.compactSha256,
      "compact representation fingerprint changed",
    );
    const expected = projectAttemptEvidenceForConsumers(
      originalPayloadText,
      projection.removedPaths,
    );
    requireProof(
      expected.arrayFacts.length > 0 &&
        expected.arrayFacts.length === projection.removedPaths.length,
      "only actual inventoried array leaves may be removed",
    );
    requireProof(
      canonicalReportJson(parseReportJson(expected.projectionText)) ===
        canonicalReportJson(parseReportJson(preview.compactPayloadText)),
      "scalar, certificate, unknown field, null or presence semantics changed",
    );
    const lengths = new Map<string, number>();
    for (const fact of expected.arrayFacts) {
      const value = projection.values[JSON.stringify(fact.path)];
      requireProof(
        value &&
          JSON.stringify(value.path) === JSON.stringify(fact.path) &&
          value.present === true &&
          value.jsonType === "array" &&
          value.length === fact.length &&
          value.byteSize === fact.byteSize &&
          value.sourceSha256 === fact.sha256,
        "original array type, count or exact content facts changed",
      );
      lengths.set(JSON.stringify(fact.path), fact.length);
    }
    const policy = await getAttemptEvidenceStoragePolicy(db);
    if (policy?.progressiveSourceScope === "verified") {
      requireConfiguredAttemptHubRole();
      if (verifyWorker) throw new Error("A worker-volume proof cannot be used for the verified hub policy");
    }
    const restored = await reader.read(archive, AbortSignal.timeout(30_000));
    requireProof(
      restored.attemptId === attemptId &&
        restored.resultId === archive.resultId &&
        restored.simJobId === archive.simJobId &&
        restored.payloadText === originalPayloadText,
      "archive read did not restore the exact original owner and PG text",
    );

    const workerScope = verifyWorker
      ? await verifyWorker(attemptId, originalPayloadText)
      : null;
    const proofScope =
      policy?.progressiveSourceScope === "verified"
        ? await verifiedAttemptProofScope(db, attemptId, archive.id)
        : policy?.progressiveSourceScope;
    const urans = proofScope === "receipt-urans";
    const broad =
      !workerScope && (urans || proofScope === "receipt-bearing")
        ? await verifyProgressiveAttemptReceipt(
            db,
            attemptId,
            originalPayloadText,
            urans,
          )
        : null;
    const stopped =
      workerScope || broad
        ? null
        : await verifyStoppedSource(db, attemptId, originalPayloadText);
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
      const [row] =
        await tx.execute(sql`SELECT a.result_id,a.sim_job_id,a.airfoil_id,a.simulation_preset_revision_id,
        ${
          workerScope
            ? sql`attempt_evidence_hz_scope(a.id)=${JSON.stringify(workerScope)}::jsonb`
            : broad
              ? sql`${urans ? sql`attempt_evidence_receipt_scope_for(a.id,true)` : sql`attempt_evidence_receipt_scope(a.id)`}=${JSON.stringify(broad.progressiveScope)}::jsonb`
              : stopped
                ? sql`attempt_evidence_stopped_scope(a.id)=${JSON.stringify(stopped.progressiveScope)}::jsonb`
                : attemptEvidenceColdCohortSql(sql`a`)
        } AS eligible,
        CASE WHEN octet_length(a.evidence_payload::text)<=33554432 THEN
          attempt_evidence_make_projection(a.evidence_payload,a.id,${archive.id}::uuid)
            IS NOT DISTINCT FROM ${JSON.stringify(projection)}::jsonb END AS projection_verified,
        CASE WHEN octet_length(a.evidence_payload::text)<=33554432 THEN
          attempt_evidence_compact(a.evidence_payload) IS NOT DISTINCT FROM ${preview.compactPayloadText}::jsonb END AS compact_verified,
        CASE WHEN octet_length(a.evidence_payload::text)<=33554432 THEN a.evidence_payload::text END AS payload_text
        FROM result_attempts a WHERE a.id=${attemptId}::uuid`);
      requireProof(
        row?.eligible === true &&
          row.result_id === archive.resultId &&
          row.sim_job_id === archive.simJobId &&
          row.payload_text === originalPayloadText,
        "source is open, selected, replay-sensitive, referenced or changed",
      );
      requireProof(
        row.projection_verified === true && row.compact_verified === true,
        "immutable SQL equality/presence/value-hash projection differs from the original",
      );
      requireProof(
        typeof row.simulation_preset_revision_id === "string" &&
          typeof row.airfoil_id === "string" &&
          typeof row.sim_job_id === "string",
        "scientific setup/job scope is missing",
      );
      const original = JSON.parse(originalPayloadText) as Record<
        string,
        unknown
      >;
      const compact = JSON.parse(preview.compactPayloadText) as Record<
        string,
        unknown
      >;
      const hasForceHistory = forcePresent(compact, lengths);
      requireProof(
        forcePresent(original, new Map()) === hasForceHistory,
        "force-history existence changed",
      );
      if (broad) {
        if (urans) {
          // The lossless comparison above also keeps the complete cycle and
          // no-shedding certificates, frame cadence and exact time windows.
          // Status/classifier gates use those fields and the verified force
          // presence. Numerical fit and archive publication use the original.
          requireProof(
            canonicalAnalysisJson(
              precalcContinuationProgressFromEvidence(original),
            ) ===
              canonicalAnalysisJson(
                precalcContinuationProgressFromEvidence(compact),
              ),
            "URANS physical time, cycle, frame or continuation evidence changed",
          );
        } else {
          // All leaves except the four replayed numerical channels have already
          // been compared losslessly above. Job-scoped RANS classification reads
          // mean_stable from this parent, with geometry, certificates and force
          // presence kept separately. Thus every sibling sees identical classifier
          // inputs regardless of job cardinality. Progressive fitting uses the
          // authenticated full numerical source, never this compact parent.
          const channels = new Set(["iterations", "cl", "cd", "cm"]);
          requireProof(
            expected.arrayFacts.length === 4 &&
              expected.arrayFacts.every(
                (f) =>
                  f.path.length === 2 &&
                  f.path[0] === "steady_history" &&
                  channels.delete(f.path[1]!),
              ) &&
              channels.size === 0,
            "receipt source removed a non-steady classifier input",
          );
        }
        return {
          contractVersion: 1,
          attemptId,
          archiveId: archive.id,
          sourceSha256: archive.sourceSha256,
          classificationEquivalent: true,
          equalityEquivalent: true,
          scientificEquivalent: true,
          readDependenciesSatisfied: true,
          verifier: urans
            ? URANS_RECEIPT_SOURCE_VERIFIER
            : RECEIPT_SOURCE_VERIFIER,
          ...broad,
        };
      }
      const before = await readPolarAttemptEvidenceForConsumerProof(
        tx,
        row.airfoil_id,
        row.simulation_preset_revision_id,
        row.sim_job_id,
      );
      requireProof(
        before.filter((point) => point.resultAttemptId === attemptId).length ===
          1,
        "scientific source job does not contain the exact attempt once",
      );
      const after = before.map((point) =>
        point.resultAttemptId !== attemptId
          ? point
          : {
              ...point,
              hasForceHistory,
              frameTrack: normalizedHistory(
                compact,
                "frame_track",
                "frameTrack",
              ) as typeof point.frameTrack,
              steadyHistory: normalizedHistory(
                compact,
                "steady_history",
                "steadyHistory",
              ) as typeof point.steadyHistory,
            },
      );
      const originalDecision = decisions(classifyPolarEvidence(before));
      const projectedDecision = decisions(classifyPolarEvidence(after));
      requireProof(
        canonicalAnalysisJson(originalDecision) ===
          canonicalAnalysisJson(projectedDecision),
        "job-scoped classification, promotion or fitted polar changed",
      );
      return {
        contractVersion: 1,
        attemptId,
        archiveId: archive.id,
        sourceSha256: archive.sourceSha256,
        classificationEquivalent: true,
        equalityEquivalent: true,
        scientificEquivalent: true,
        readDependenciesSatisfied: true,
        verifier: workerScope
          ? "server-consumers/hz-worker-steady-rans-v1"
          : stopped
            ? STOPPED_VERIFIER
            : ATTEMPT_SERVER_CONSUMER_VERIFIER,
        ...stopped,
        ...(workerScope
          ? {
              workerScope,
              applicationSha256: analysisContentHash(
                JSON.parse(originalPayloadText),
              ),
            }
          : {}),
      };
    });
  };
}
