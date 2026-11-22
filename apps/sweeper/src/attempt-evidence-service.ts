import { configuredDeploymentRole } from "./config";
import type { DB } from "@aerodb/db/client";
import {
  attemptEvidenceArchiveCandidates,
  attemptEvidenceCatalogReady,
  findAttemptEvidenceArchive,
  registerAttemptEvidenceArchive,
} from "@aerodb/db/attempt-evidence-catalog";
import {
  MAX_ATTEMPT_EVIDENCE_BYTES,
  loadSettledAttemptEvidenceCopy,
  prepareAttemptEvidenceCopy,
} from "@aerodb/db/attempt-evidence-storage";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { writeAttemptEvidenceCopy } from "./attempt-evidence-archive";
import {
  AttemptEvidenceStore,
  type AttemptEvidenceArchiveStore,
} from "./attempt-evidence-store";

function assertInstance(instance: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(instance))
    throw new Error("Attempt archive requires a stable source instance");
}

export async function archiveAttemptEvidence(
  db: DB,
  store: AttemptEvidenceArchiveStore,
  options: {
    attemptId: string;
    bucket: string;
    sourceInstance: string;
    signal?: AbortSignal;
  },
) {
  assertInstance(options.sourceInstance);
  const checkAbort = () => {
    if (options.signal?.aborted)
      throw new Error("Attempt evidence archival was aborted");
  };
  checkAbort();
  const source = await loadSettledAttemptEvidenceCopy(db, options.attemptId);
  const plan = prepareAttemptEvidenceCopy(source);
  if (!plan.historySeries.length)
    throw new Error("Attempt has no actual history series to archive");
  const existing = await findAttemptEvidenceArchive(
    db,
    options.sourceInstance,
    source,
    plan.sourceSha256,
  );
  if (existing) {
    const restored = await store.read(existing, options.signal);
    if (restored.payloadText !== source.payloadText)
      throw new Error("Archived attempt differs from the current exact point");
    return {
      archive: existing,
      created: false,
      sourceBytes: plan.sourceByteSize,
      historyBytes: existing.historyByteSize,
      onlineBytesRemoved: 0,
    };
  }
  const directory = await mkdtemp(join(tmpdir(), "attempt-evidence-gcs-"));
  try {
    const path = join(directory, "point.json.gz");
    const proof = await writeAttemptEvidenceCopy(path, source);
    checkAbort();
    const uploaded = await store.putFile(path, proof, {
      bucket: options.bucket,
      sourceInstance: options.sourceInstance,
    });
    checkAbort();
    const restored = await store.read(uploaded, options.signal);
    if (restored.payloadText !== source.payloadText)
      throw new Error("GCS attempt copy changed the exact source text");
    checkAbort();
    const registered = await registerAttemptEvidenceArchive(db, uploaded, plan);
    const archive = registered.archive;
    // A concurrent insertion can select another immutable compressed encoding.
    // Verify the catalog's actual generation before returning its receipt.
    await store.read(archive, options.signal);
    return {
      archive,
      created: registered.created,
      sourceBytes: plan.sourceByteSize,
      historyBytes: archive.historyByteSize,
      onlineBytesRemoved: 0,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runAttemptEvidenceArchivePass(
  db: DB,
  store: AttemptEvidenceArchiveStore,
  options: {
    bucket: string;
    sourceInstance: string;
    after?: string | null;
    maxRows?: number;
    maxBytes?: number;
    signal?: AbortSignal;
  },
) {
  assertInstance(options.sourceInstance);
  const maxRows = options.maxRows ?? 8,
    maxBytes = options.maxBytes ?? 8 * 1024 ** 2;
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > 32 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_ATTEMPT_EVIDENCE_BYTES
  )
    throw new Error("Invalid bounded attempt evidence archive budget");
  const candidates = await attemptEvidenceArchiveCandidates(
    db,
    options.after ?? null,
    options.sourceInstance,
  );
  let next = options.after ?? null,
    processed = 0,
    copied = 0,
    attemptedBytes = 0,
    sourceBytes = 0,
    historyBytes = 0;
  const failures: Array<{ attemptId: string; error: string }> = [];
  for (const candidate of candidates) {
    if (options.signal?.aborted) break;
    if (candidate.eligible !== true) {
      next = candidate.id;
      continue;
    }
    const bytes = Number(candidate.byte_size);
    if (
      processed >= maxRows ||
      (processed > 0 && attemptedBytes + bytes > maxBytes)
    )
      break;
    processed++;
    attemptedBytes += bytes;
    next = candidate.id;
    try {
      const result = await archiveAttemptEvidence(db, store, {
        ...options,
        attemptId: candidate.id,
      });
      copied++;
      sourceBytes += result.sourceBytes;
      historyBytes += result.historyBytes;
    } catch (error) {
      failures.push({
        attemptId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!candidates.length) next = null;
  return {
    processed,
    copied,
    attemptedBytes,
    sourceBytes,
    historyBytes,
    next,
    failures,
    onlineBytesRemoved: 0,
  };
}

export async function attemptEvidenceSourceInstance(db: DB): Promise<string> {
  const configured = process.env.AIRFOILFOAM_HISTORY_SOURCE_INSTANCE?.trim();
  if (configured) {
    assertInstance(configured);
    return configured;
  }
  const [settings] = await db.execute(
    sql`SELECT instance_id::text AS id FROM sync_api_settings WHERE id=1`,
  );
  const instance = String(settings?.id ?? "");
  assertInstance(instance);
  return instance;
}

export async function runAttemptEvidenceStorageService(
  db: DB,
  signal: AbortSignal,
): Promise<void> {
  const bucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
  if (
    !bucket ||
    configuredDeploymentRole() !== "hub" ||
    process.env.AIRFOILFOAM_ATTEMPT_EVIDENCE_ARCHIVE === "false" ||
    signal.aborted
  )
    return;
  if (!(await attemptEvidenceCatalogReady(db))) {
    console.error(
      "attempt-evidence-storage: archive catalog is unavailable; source points remain inline",
    );
    return;
  }
  const sourceInstance = await attemptEvidenceSourceInstance(db),
    store = new AttemptEvidenceStore();
  let after: string | null = null;
  while (!signal.aborted) {
    let pause = 30_000;
    try {
      const result = await runAttemptEvidenceArchivePass(db, store, {
        bucket,
        sourceInstance,
        after,
        signal,
      });
      after = result.next;
      if (after !== null) pause = 250;
      if (result.copied || result.failures.length)
        console.info("attempt-evidence-storage", result);
    } catch (error) {
      console.error(
        "attempt-evidence-storage",
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
