import type { DB } from "@aerodb/db/client";
import { getAttemptEvidenceArchive } from "@aerodb/db/attempt-evidence-catalog";
import {
  ATTEMPT_EVIDENCE_CONTRACT_VERSION,
  attemptEvidenceShorteningCandidates,
  confirmAttemptEvidenceReadback,
  pendingAttemptEvidenceReadbacks,
  getAttemptEvidenceStorage,
  getAttemptEvidenceStoragePolicy,
  prepareAttemptEvidenceProjection,
  restoreAttemptEvidence,
  shortenAttemptEvidence,
  type AttemptEvidenceAppReader,
  type AttemptEvidenceAppReadback,
  type AttemptEvidenceDependencyVerifier,
  type AttemptEvidenceFreshVerification,
  type AttemptEvidenceSettlementMeasurement,
} from "@aerodb/db/attempt-evidence-projection";
import { reportTextIdentity } from "@aerodb/db/progressive-report-archive";
import { setTimeout } from "node:timers/promises";
import type { AttemptEvidenceArchiveStore } from "./attempt-evidence-store";
import { AttemptEvidenceStore } from "./attempt-evidence-store";
import { sweeperAttemptEvidenceDependencyVerifier } from "./attempt-evidence-consumer-reader";

export interface AttemptEvidenceSettlementDependencies {
  store: AttemptEvidenceArchiveStore;
  /** Must exercise the stable-id application read route, not the direct store. */
  readApp: AttemptEvidenceAppReader;
  verifyDependencies: AttemptEvidenceDependencyVerifier;
}

/** Use the same stable-ID reader and job-scoped scientific verifier as the app. */
export function createAttemptEvidenceSettlementDependencies(
  db: DB,
  readApp: AttemptEvidenceAppReader,
  store: AttemptEvidenceArchiveStore = new AttemptEvidenceStore(),
): AttemptEvidenceSettlementDependencies {
  return {
    store,
    readApp,
    verifyDependencies: sweeperAttemptEvidenceDependencyVerifier(db),
  };
}

/** The isolated worker and CLI each need a reader for archived source
 * reports. Installing the API's hub reader uses the existing bucket. */
export async function configuredAttemptEvidenceSettlementDependencies(db: DB) {
  const { installApiReportArchiveReader } = await import("../../api/src/progressive-report-archive-reader");
  const { readApiAttemptEvidenceForApp } = await import("../../api/src/attempt-evidence-reader");
  await installApiReportArchiveReader();
  return createAttemptEvidenceSettlementDependencies(db, request => readApiAttemptEvidenceForApp(db, request));
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new Error("Attempt history shortening was aborted");
}

function exactApp(
  readback: AttemptEvidenceAppReadback,
  attemptId: string,
  archiveId: string,
  text: string,
) {
  const proof = reportTextIdentity(text);
  if (
    readback.source !== "gcs" ||
    readback.attemptId !== attemptId ||
    readback.archiveId !== archiveId ||
    readback.sourceSha256 !== proof.sha256 ||
    readback.sourceByteSize !== proof.byteSize ||
    readback.payloadText !== text
  )
    throw new Error(
      "Application attempt read-through differs from the exact GCS original",
    );
}

async function verifyVisibleAttempt(
  db: DB,
  deps: AttemptEvidenceSettlementDependencies,
  request: Parameters<AttemptEvidenceAppReader>[0],
  sourceText: string,
  eventId: string,
  recover: boolean,
) {
  let response: AttemptEvidenceAppReadback;
  try {
    response = await deps.readApp({ ...request, forceArchive: false });
    exactApp(response, request.attemptId, request.archiveId, sourceText);
  } catch (error) {
    if (!recover) throw error;
    await restoreAttemptEvidence(
      db,
      request.attemptId,
      request.archiveId,
      sourceText,
      "post-shorten application read failed",
      eventId,
    );
    throw new Error(
      "Attempt history application verification failed; exact inline original was restored",
      { cause: error },
    );
  }
  await confirmAttemptEvidenceReadback(db, eventId, response);
}

/** Every item proves direct GCS bytes and a functioning stable-id application
 * read before removal. SQL repeats exact owner/source/dependency/value guards.
 * A failed post-transition app read restores the original in a new transaction. */
export async function settleAttemptEvidenceHistory(
  db: DB,
  deps: AttemptEvidenceSettlementDependencies,
  options: {
    attemptId: string;
    archiveId: string;
    signal?: AbortSignal;
    pendingEventId?: string;
  },
): Promise<
  | AttemptEvidenceSettlementMeasurement
  | {
      attemptId: string;
      archiveId: string;
      alreadyShortened: true;
      payloadBytesReclaimed: 0;
      netValueBytesReclaimed: 0;
    }
> {
  checkAbort(options.signal);
  const stored = await getAttemptEvidenceStorage(db, options.attemptId);
  if (!stored) throw new Error("Attempt history source was not found");
  if (
    options.pendingEventId &&
    (stored.state !== "archived" ||
      stored.storageEventId !== options.pendingEventId)
  )
    throw new Error("Pending readback was superseded");
  if (stored.state === "inline") {
    const policy = await getAttemptEvidenceStoragePolicy(db);
    if (
      !policy?.shorteningEnabled ||
      policy.consumerContractVersion !== ATTEMPT_EVIDENCE_CONTRACT_VERSION
    )
      throw new Error("Attempt history consumer contract is disabled");
    if (policy.canaryAttemptId && policy.canaryAttemptId !== stored.attemptId)
      throw new Error("Attempt differs from the configured canary");
  }
  const archive = await getAttemptEvidenceArchive(db, options.archiveId);
  if (archive.attemptId !== stored.attemptId)
    throw new Error("Attempt history archive belongs to a different attempt");
  // Fresh read(), never archive.verifiedAt, establishes this exact generation.
  const restored = await deps.store.read(archive, options.signal);
  const directAt = new Date().toISOString();
  const proof = reportTextIdentity(restored.payloadText);
  if (
    restored.attemptId !== stored.attemptId ||
    restored.resultId !== archive.resultId ||
    restored.simJobId !== archive.simJobId ||
    proof.sha256 !== archive.sourceSha256 ||
    proof.byteSize !== archive.sourceByteSize ||
    (stored.state === "inline" &&
      stored.inlinePayloadText !== restored.payloadText) ||
    (stored.state === "archived" && stored.archive.id !== archive.id)
  )
    throw new Error("Attempt history GCS source or current owner changed");
  checkAbort(options.signal);
  const appRequest = {
    attemptId: stored.attemptId,
    archiveId: archive.id,
    sourceSha256: archive.sourceSha256,
    sourceByteSize: archive.sourceByteSize,
    forceArchive: stored.state === "inline",
    signal: options.signal,
  };
  if (stored.state === "archived") {
    await verifyVisibleAttempt(
      db,
      deps,
      appRequest,
      restored.payloadText,
      stored.storageEventId,
      Boolean(options.pendingEventId),
    );
    return {
      attemptId: stored.attemptId,
      archiveId: archive.id,
      alreadyShortened: true,
      payloadBytesReclaimed: 0,
      netValueBytesReclaimed: 0,
    };
  }
  const app = await deps.readApp(appRequest);
  exactApp(app, stored.attemptId, archive.id, restored.payloadText);
  const appAt = new Date().toISOString();
  const preview = await prepareAttemptEvidenceProjection(
    db,
    stored.attemptId,
    archive.id,
  );
  const dependencies = await deps.verifyDependencies({
    attemptId: stored.attemptId,
    archive,
    originalPayloadText: restored.payloadText,
    preview,
  });
  if (
    dependencies.contractVersion !== 1 ||
    dependencies.attemptId !== stored.attemptId ||
    dependencies.archiveId !== archive.id ||
    dependencies.sourceSha256 !== archive.sourceSha256 ||
    !dependencies.classificationEquivalent ||
    !dependencies.equalityEquivalent ||
    !dependencies.scientificEquivalent ||
    !dependencies.readDependenciesSatisfied ||
    !dependencies.verifier.trim()
  )
    throw new Error(
      "Attempt history scientific or read dependencies are not equivalent",
    );
  const { payloadText: _fullText, ...appIdentity } = app;
  const verification: AttemptEvidenceFreshVerification = {
    direct: {
      attemptId: stored.attemptId,
      archiveId: archive.id,
      bucket: archive.bucket,
      objectKey: archive.objectKey,
      generation: archive.generation,
      storedSha256: archive.storedSha256,
      storedByteSize: archive.storedByteSize,
      crc32c: archive.crc32c,
      sourceSha256: archive.sourceSha256,
      sourceByteSize: archive.sourceByteSize,
      verifiedAt: directAt,
    },
    app: { ...appIdentity, forceArchive: true, verifiedAt: appAt },
    dependencies,
  };
  checkAbort(options.signal);
  const measurement = await shortenAttemptEvidence(
    db,
    stored.attemptId,
    archive.id,
    verification,
  );
  await verifyVisibleAttempt(
    db,
    deps,
    appRequest,
    restored.payloadText,
    measurement.eventId,
    !("alreadyShortened" in measurement),
  );
  return measurement;
}

export async function runAttemptEvidenceSettlementPass(
  db: DB,
  deps: AttemptEvidenceSettlementDependencies,
  options: {
    after?: string | null;
    maxRows?: number;
    signal?: AbortSignal;
  } = {},
) {
  const maxRows = options.maxRows ?? 4;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 8)
    throw new Error("Attempt history shortening budget must be 1..8");
  const policy = await getAttemptEvidenceStoragePolicy(db);
  const automatic = Boolean(
    policy?.shorteningEnabled &&
    policy.consumerContractVersion === 1 &&
    !policy.canaryAttemptId,
  );
  let next = options.after ?? null,
    processed = 0,
    shortened = 0,
    eligible = 0,
    recovered = 0;
  let payloadBytesReclaimed = 0,
    netValueBytesReclaimed = 0;
  const failures: Array<{ attemptId: string; error: string }> = [];
  const limited: Array<{ attemptId: string; limiter: string }> = [];
  // Replay unacknowledged committed events before selecting new sources. This
  // also runs while new work is disabled, including after a worker restart.
  const pending = policy
    ? await pendingAttemptEvidenceReadbacks(db, maxRows)
    : [];
  for (const item of pending) {
    if (options.signal?.aborted) break;
    processed++;
    try {
      await settleAttemptEvidenceHistory(db, deps, {
        ...item,
        pendingEventId: item.eventId,
        signal: options.signal,
      });
      recovered++;
    } catch (error) {
      failures.push({
        attemptId: item.attemptId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const scope = policy?.progressiveSourceScope;
  const preview = scope === "receipt-bearing" || scope === "receipt-urans"
    ? scope : scope === "stopped-only";
  const candidates =
    automatic && processed < maxRows
      ? await attemptEvidenceShorteningCandidates(db, next, preview)
      : [];
  for (const candidate of candidates) {
    if (options.signal?.aborted) break;
    if (candidate.limiter !== null || !candidate.archive_id) {
      next = candidate.id;
      limited.push({
        attemptId: candidate.id,
        limiter: candidate.limiter ?? "missing-archive",
      });
      continue;
    }
    if (processed >= maxRows) break;
    next = candidate.id;
    processed++;
    eligible++;
    try {
      const result = await settleAttemptEvidenceHistory(db, deps, {
        attemptId: candidate.id,
        archiveId: candidate.archive_id,
        signal: options.signal,
      });
      if (!("alreadyShortened" in result)) {
        shortened++;
        payloadBytesReclaimed += result.payloadBytesReclaimed;
        netValueBytesReclaimed += result.netValueBytesReclaimed;
      }
    } catch (error) {
      failures.push({
        attemptId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (automatic && processed < maxRows && !candidates.length) next = null;
  return {
    enabled: automatic,
    recovered,
    processed,
    shortened,
    next,
    eligible,
    payloadBytesReclaimed,
    netValueBytesReclaimed,
    failures,
    limited,
  };
}

/** Integrate only after the app route and semantic verifier are installed.
 * The rollout policy stays disabled while older readers may still be running. */
export async function runAttemptEvidenceSettlementService(
  db: DB,
  deps: AttemptEvidenceSettlementDependencies,
  signal: AbortSignal,
): Promise<void> {
  let after: string | null = null;
  while (!signal.aborted) {
    let pause = 30_000;
    try {
      const result = await runAttemptEvidenceSettlementPass(db, deps, {
        after,
        signal,
      });
      after = result.next;
      if (result.enabled && after !== null) pause = 250;
      if (result.shortened || result.recovered || result.failures.length)
        console.info("attempt-history-shortening", result);
    } catch (error) {
      console.error(
        "attempt-history-shortening",
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      await setTimeout(pause, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

/** The existing hub worker polls the SQL policy and replays pending receipts. */
export async function runConfiguredAttemptEvidenceSettlementService(
  db: DB,
  signal: AbortSignal,
): Promise<void> {
  if (
    !process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim() ||
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver" ||
    process.env.AIRFOILFOAM_ATTEMPT_HISTORY_SHORTENING === "false" ||
    signal.aborted
  )
    return;
  const deps = await configuredAttemptEvidenceSettlementDependencies(db);
  await runAttemptEvidenceSettlementService(db, deps, signal);
}
