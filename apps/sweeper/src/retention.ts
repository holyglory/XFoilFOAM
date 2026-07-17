import {
  URANS_BUDGET_STOP_MARKER,
  URANS_CONTINUATION_REQUIRED_MARKER,
} from "@aerodb/core";
import {
  acquireSyncBlobStripeLock,
  CONTINUABLE_SQL,
  type DB,
  remoteAssetReferences,
  resultMedia,
  simJobs,
  solverEvidenceArtifacts,
} from "@aerodb/db";
import { EngineError, type EngineClient } from "@aerodb/engine-client";
import { eq, inArray, sql } from "drizzle-orm";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_STRIP_MIN_AGE_MS = 30 * 60 * 1000;
export const DEFAULT_RETENTION_CONTINUABLE_DAYS = 14;
export const DEFAULT_STRIP_MAX_PER_TICK = 5;
export const DEFAULT_ORPHAN_SWEEP_MS = 60 * 60 * 1000;
export const DEFAULT_ORPHAN_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_SYNC_IMPORT_TMP_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SYNC_IMPORT_BLOB_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_SYNC_IMPORT_GC_MAX_PER_SWEEP = 1_000;

const LIVE_URANS_REQUEST_STATES = [
  "pending",
  "submitted",
  "running",
  "ingesting",
];

export interface RetentionConfig {
  stripMinAgeMs: number;
  retentionContinuableDays: number;
  stripMaxPerTick: number;
  orphanSweepMs: number;
  orphanMinAgeMs: number;
}

export interface RetentionTickOptions extends Partial<RetentionConfig> {
  now?: Date;
  forceOrphanSweep?: boolean;
}

interface StripCandidate {
  id: string;
  engine_job_id: string;
  keep_case_state: boolean;
}

let lastOrphanSweepAtMs = 0;

export interface SyncImportGcOptions {
  now?: Date;
  mediaDir?: string;
  tmpMinAgeMs?: number;
  blobMinAgeMs?: number;
  maxPerSweep?: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function retentionConfigFromEnv(
  overrides: Partial<RetentionConfig> = {},
): RetentionConfig {
  return {
    stripMinAgeMs:
      overrides.stripMinAgeMs ??
      envNumber("SWEEPER_STRIP_MIN_AGE_MS", DEFAULT_STRIP_MIN_AGE_MS),
    retentionContinuableDays:
      overrides.retentionContinuableDays ??
      envNumber(
        "RETENTION_CONTINUABLE_DAYS",
        DEFAULT_RETENTION_CONTINUABLE_DAYS,
      ),
    stripMaxPerTick: Math.floor(
      overrides.stripMaxPerTick ??
        envNumber("SWEEPER_STRIP_MAX_PER_TICK", DEFAULT_STRIP_MAX_PER_TICK),
    ),
    orphanSweepMs:
      overrides.orphanSweepMs ??
      envNumber("SWEEPER_ORPHAN_SWEEP_MS", DEFAULT_ORPHAN_SWEEP_MS),
    orphanMinAgeMs:
      overrides.orphanMinAgeMs ??
      envNumber("ORPHAN_MIN_AGE_MS", DEFAULT_ORPHAN_MIN_AGE_MS),
  };
}

export function resetRetentionMemory(): void {
  lastOrphanSweepAtMs = 0;
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function gb(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

function pct(value: number): string {
  return Number.isFinite(value)
    ? value.toFixed(1).replace(/\.0$/, "")
    : "unknown";
}

async function stampStrip(
  db: DB,
  jobId: string,
  now: Date,
  report: {
    bytes_freed?: number;
    files_removed?: number;
    kept_case_state?: boolean;
    note?: string;
  },
): Promise<void> {
  await db
    .update(simJobs)
    .set({ strippedAt: now, stripReport: report })
    .where(eq(simJobs.id, jobId));
}

export async function stripTerminalJobs(
  db: DB,
  engine: EngineClient,
  options: RetentionTickOptions = {},
): Promise<number> {
  const config = retentionConfigFromEnv(options);
  if (config.stripMaxPerTick <= 0) return 0;
  const now = options.now ?? new Date();
  const candidates = (await db.execute(sql`
    WITH candidates AS (
      SELECT
        j.id,
        j.engine_job_id,
        j.stripped_at,
        j.strip_report,
        COALESCE(j."finishedAt", j."ingestedAt", j."updatedAt", j."createdAt") AS terminal_at,
        EXISTS (
          SELECT 1
          FROM results r
          LEFT JOIN result_classifications rc ON rc.result_id = r.id
          WHERE (r.sim_job_id = j.id OR (j.engine_job_id IS NOT NULL AND r.engine_job_id = j.engine_job_id))
            AND ${CONTINUABLE_SQL}
        ) AS has_continuable,
        EXISTS (
          SELECT 1
          FROM sim_urans_requests req
          JOIN results r ON r.id = req.continue_from_result_id
          WHERE req.state IN (${sql.join(
            LIVE_URANS_REQUEST_STATES.map((state) => sql`${state}`),
            sql`, `,
          )})
            AND (r.sim_job_id = j.id OR (j.engine_job_id IS NOT NULL AND r.engine_job_id = j.engine_job_id))
        ) AS has_live_continuation,
        EXISTS (
          SELECT 1
          FROM sim_precalc_obligation_attempts obligation_attempt
          JOIN sim_precalc_obligations obligation
            ON obligation.id = obligation_attempt.obligation_id
          JOIN result_attempts attempt
            ON attempt.id = obligation_attempt.result_attempt_id
          WHERE obligation.state IN ('pending', 'running')
            AND attempt.engine_job_id IS NOT NULL
            AND attempt.engine_case_slug IS NOT NULL
            AND attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
            AND EXISTS (
              SELECT 1
              FROM unnest(COALESCE(attempt.quality_warnings, ARRAY[]::text[])) warning
              WHERE warning LIKE ${"%" + URANS_BUDGET_STOP_MARKER + "%"}
                 OR warning LIKE ${"%" + URANS_CONTINUATION_REQUIRED_MARKER + "%"}
            )
            AND (
              attempt.sim_job_id = j.id
              OR (j.engine_job_id IS NOT NULL AND attempt.engine_job_id = j.engine_job_id)
            )
        ) AS has_live_precalc_continuation
        ,
        EXISTS (
          SELECT 1
          FROM sim_urans_verify_queue verify
          JOIN result_attempts attempt
            ON attempt.id = verify.latest_result_attempt_id
          WHERE verify.state IN ('pending', 'running')
            AND verify.last_outcome IN (
              'continuation_pending',
              'continuation_retry_wait'
            )
            AND attempt.engine_job_id IS NOT NULL
            AND attempt.engine_case_slug IS NOT NULL
            AND attempt.evidence_payload ->> 'fidelity' = 'urans_full'
            AND (
              attempt.sim_job_id = j.id
              OR (
                j.engine_job_id IS NOT NULL
                AND attempt.engine_job_id = j.engine_job_id
              )
            )
        ) AS has_live_final_continuation,
        EXISTS (
          SELECT 1
          FROM result_attempts attempt
          WHERE attempt.engine_job_id IS NOT NULL
            AND attempt.engine_case_slug IS NOT NULL
            AND attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
            AND EXISTS (
              SELECT 1
              FROM unnest(COALESCE(attempt.quality_warnings, ARRAY[]::text[])) warning
              WHERE warning LIKE ${"%" + URANS_BUDGET_STOP_MARKER + "%"}
                 OR warning LIKE ${"%" + URANS_CONTINUATION_REQUIRED_MARKER + "%"}
            )
            AND (
              attempt.sim_job_id = j.id
              OR (
                j.engine_job_id IS NOT NULL
                AND attempt.engine_job_id = j.engine_job_id
              )
            )
        ) AS has_attempt_continuable
      FROM sim_jobs j
      WHERE j.status IN ('done', 'failed', 'cancelled')
        AND j.engine_job_id IS NOT NULL
        -- A remote-solver job owns upload source bytes until the hub has
        -- acknowledged every exact generation and the delivery loop has
        -- written its job-level terminal row. Generic stripping currently
        -- retains packaged evidence too, but this explicit fence prevents a
        -- future retention expansion from racing the federation ACK.
        AND (
          NOT (COALESCE(j.request_payload, '{}'::jsonb) ? 'syncPromiseId')
          OR EXISTS (
            SELECT 1
            FROM sync_remote_result_deliveries remote_delivery
            WHERE remote_delivery.sim_job_id = j.id
              AND remote_delivery.result_id IS NULL
              AND remote_delivery.state IN ('delivered', 'superseded')
          )
        )
        AND COALESCE(j."finishedAt", j."ingestedAt", j."updatedAt", j."createdAt") <=
          ${now.toISOString()}::timestamptz - (${config.stripMinAgeMs}::double precision * interval '1 millisecond')
    )
    SELECT
      id,
      engine_job_id,
      CASE
        WHEN stripped_at IS NOT NULL
          AND strip_report ->> 'kept_case_state' = 'true'
          AND NOT has_live_continuation
          AND NOT has_live_precalc_continuation
          AND NOT has_live_final_continuation
          AND (
            NOT (has_continuable OR has_attempt_continuable)
            OR terminal_at <= ${now.toISOString()}::timestamptz - (${config.retentionContinuableDays}::double precision * interval '1 day')
          )
          THEN false
        ELSE (
          has_continuable
          OR has_attempt_continuable
          OR has_live_continuation
          OR has_live_precalc_continuation
          OR has_live_final_continuation
        )
      END AS keep_case_state
    FROM candidates
    WHERE stripped_at IS NULL
      OR (
        strip_report ->> 'kept_case_state' = 'true'
        AND NOT has_live_continuation
        AND NOT has_live_precalc_continuation
        AND NOT has_live_final_continuation
        AND (
          NOT (has_continuable OR has_attempt_continuable)
          OR terminal_at <= ${now.toISOString()}::timestamptz - (${config.retentionContinuableDays}::double precision * interval '1 day')
        )
      )
    ORDER BY terminal_at ASC, id ASC
    LIMIT ${config.stripMaxPerTick}
  `)) as unknown as StripCandidate[];

  let stripped = 0;
  for (const candidate of candidates) {
    try {
      const response = await engine.stripJob(candidate.engine_job_id, {
        keep_case_state: candidate.keep_case_state,
      });
      await stampStrip(db, candidate.id, now, response);
      stripped++;
      console.log(
        `[sweeper] RETENTION: stripped job ${candidate.engine_job_id} freed ${mb(response.bytes_freed)} MB ` +
          `(kept_case_state=${response.kept_case_state})`,
      );
    } catch (error) {
      if (error instanceof EngineError && error.status === 409) continue;
      if (error instanceof EngineError && error.status === 404) {
        await stampStrip(db, candidate.id, now, {
          bytes_freed: 0,
          files_removed: 0,
          kept_case_state: false,
          note: "engine job not found",
        });
        stripped++;
        continue;
      }
      console.error(
        `[sweeper] RETENTION: strip failed for job ${candidate.engine_job_id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return stripped;
}

export async function runOrphanSweep(
  db: DB,
  engine: EngineClient,
  options: RetentionTickOptions = {},
): Promise<number> {
  const config = retentionConfigFromEnv(options);
  const nowMs = (options.now ?? new Date()).getTime();
  try {
    const disk = await engine.maintenanceDisk();
    const line = `[sweeper] DISK: ${pct(disk.used_pct)}% used, ${gb(disk.free_bytes)} GB free`;
    console.log(line);
    if (disk.used_pct >= 80)
      console.warn(
        `[sweeper] DISK WARNING: ${pct(disk.used_pct)}% used, ${gb(disk.free_bytes)} GB free`,
      );
  } catch (error) {
    console.error(
      `[sweeper] DISK: maintenance disk probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let engineJobs;
  try {
    engineJobs = await engine.maintenanceJobs();
  } catch (error) {
    console.error(
      `[sweeper] RETENTION: orphan sweep failed to list engine jobs: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }

  const knownRows = (await db.execute(sql`
    SELECT engine_job_id
    FROM sim_jobs
    WHERE engine_job_id IS NOT NULL
  `)) as unknown as Array<{ engine_job_id: string | null }>;
  const knownIds = new Set(
    knownRows
      .map((row) => row.engine_job_id)
      .filter((id): id is string => Boolean(id)),
  );

  let deleted = 0;
  let known = 0;
  let young = 0;
  let bytesFreed = 0;
  const oldestAllowedMtime = (nowMs - config.orphanMinAgeMs) / 1000;
  for (const item of engineJobs.items) {
    if (knownIds.has(item.job_id)) {
      known++;
      continue;
    }
    if (
      !Number.isFinite(item.mtime_epoch) ||
      item.mtime_epoch > oldestAllowedMtime
    ) {
      young++;
      continue;
    }
    try {
      const response = await engine.deleteJob(item.job_id);
      deleted++;
      bytesFreed += response.bytes_freed;
      console.log(
        `[sweeper] RETENTION: deleted orphan engine job ${item.job_id} freed ${mb(response.bytes_freed)} MB`,
      );
    } catch (error) {
      if (
        error instanceof EngineError &&
        (error.status === 404 || error.status === 409)
      )
        continue;
      console.error(
        `[sweeper] RETENTION: orphan delete failed for job ${item.job_id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  console.log(
    `[sweeper] RETENTION: orphan sweep deleted ${deleted} job(s), freed ${mb(bytesFreed)} MB ` +
      `(known=${known}, young=${young})`,
  );
  return deleted;
}

export async function sweepSyncImportOrphans(
  db: DB,
  options: SyncImportGcOptions = {},
): Promise<number> {
  const nowMs = (options.now ?? new Date()).getTime();
  const mediaDir =
    options.mediaDir ?? process.env.MEDIA_DIR ?? "/data/airfoilfoam";
  const root = join(mediaDir, "sync-imports");
  const maxPerSweep = Math.max(
    0,
    Math.floor(
      options.maxPerSweep ??
        envNumber(
          "SYNC_IMPORT_GC_MAX_PER_SWEEP",
          DEFAULT_SYNC_IMPORT_GC_MAX_PER_SWEEP,
        ),
    ),
  );
  if (!maxPerSweep) return 0;
  const tmpMinAgeMs =
    options.tmpMinAgeMs ??
    envNumber("SYNC_IMPORT_TMP_MIN_AGE_MS", DEFAULT_SYNC_IMPORT_TMP_MIN_AGE_MS);
  const blobMinAgeMs =
    options.blobMinAgeMs ??
    envNumber(
      "SYNC_IMPORT_BLOB_MIN_AGE_MS",
      DEFAULT_SYNC_IMPORT_BLOB_MIN_AGE_MS,
    );
  let removed = 0;

  const tmpDir = join(root, "tmp");
  const entries = await readdir(tmpDir, { withFileTypes: true }).catch(
    () => [],
  );
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (removed >= maxPerSweep) break;
    if (!entry.isFile()) continue;
    const full = join(tmpDir, entry.name);
    const info = await stat(full).catch(() => null);
    if (!info || nowMs - info.mtimeMs < tmpMinAgeMs) continue;
    await unlink(full).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    removed += 1;
  }

  const candidates: Array<{
    full: string;
    storageKey: string;
    sha256: string;
  }> = [];
  const buckets = await readdir(root, { withFileTypes: true }).catch(() => []);
  buckets.sort((left, right) => left.name.localeCompare(right.name));
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || bucket.name === "tmp") continue;
    const bucketDir = join(root, bucket.name);
    const bucketEntries = await readdir(bucketDir, {
      withFileTypes: true,
    }).catch(() => []);
    bucketEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of bucketEntries) {
      if (!entry.isFile()) continue;
      const full = join(bucketDir, entry.name);
      const info = await stat(full).catch(() => null);
      if (!info || nowMs - info.mtimeMs < blobMinAgeMs) continue;
      candidates.push({
        full,
        storageKey: `sync-imports/${bucket.name}/${entry.name}`,
        sha256: entry.name.match(/^[0-9a-fA-F]{64}/)?.[0] ?? entry.name,
      });
    }
  }
  if (!candidates.length) return removed;
  // Referenced candidates do not consume the deletion quota. Continue
  // through deterministic batches until the quota is actually filled, so a
  // stable prefix of referenced blobs cannot starve a later orphan forever.
  for (let offset = 0; offset < candidates.length; offset += 1_000) {
    if (removed >= maxPerSweep) break;
    const batch = candidates.slice(offset, offset + 1_000);
    const keys = batch.map((candidate) => candidate.storageKey);
    const [artifacts, media, remote] = await Promise.all([
      db
        .select({ storageKey: solverEvidenceArtifacts.storageKey })
        .from(solverEvidenceArtifacts)
        .where(inArray(solverEvidenceArtifacts.storageKey, keys)),
      db
        .select({ storageKey: resultMedia.storageKey })
        .from(resultMedia)
        .where(inArray(resultMedia.storageKey, keys)),
      db
        .select({ storageKey: remoteAssetReferences.localStorageKey })
        .from(remoteAssetReferences)
        .where(inArray(remoteAssetReferences.localStorageKey, keys)),
    ]);
    const referenced = new Set(
      [...artifacts, ...media, ...remote].map((row) => row.storageKey),
    );
    for (const candidate of batch) {
      if (removed >= maxPerSweep) break;
      if (referenced.has(candidate.storageKey)) continue;
      const deleted = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as DB;
        // Same stripe as API publication. Recheck references only after the
        // importer/cleanup lock is held, then keep it through unlink.
        await acquireSyncBlobStripeLock(tx, candidate.sha256);
        const [artifactRef] = await tx
          .select({ id: solverEvidenceArtifacts.id })
          .from(solverEvidenceArtifacts)
          .where(eq(solverEvidenceArtifacts.storageKey, candidate.storageKey))
          .limit(1);
        const [mediaRef] = await tx
          .select({ id: resultMedia.id })
          .from(resultMedia)
          .where(eq(resultMedia.storageKey, candidate.storageKey))
          .limit(1);
        const [remoteRef] = await tx
          .select({ id: remoteAssetReferences.id })
          .from(remoteAssetReferences)
          .where(
            eq(remoteAssetReferences.localStorageKey, candidate.storageKey),
          )
          .limit(1);
        if (artifactRef || mediaRef || remoteRef) return false;
        await unlink(candidate.full).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        return true;
      });
      if (deleted) removed += 1;
    }
  }
  if (removed) {
    console.log(
      `[sweeper] RETENTION: removed ${removed} stale sync import staging/blob file(s)`,
    );
  }
  return removed;
}

export async function retentionTick(
  db: DB,
  engine: EngineClient,
  options: RetentionTickOptions = {},
): Promise<void> {
  try {
    await stripTerminalJobs(db, engine, options);
  } catch (error) {
    console.error(
      `[sweeper] RETENTION: strip reaper failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const config = retentionConfigFromEnv(options);
  const nowMs = (options.now ?? new Date()).getTime();
  if (
    options.forceOrphanSweep ||
    nowMs - lastOrphanSweepAtMs >= config.orphanSweepMs
  ) {
    lastOrphanSweepAtMs = nowMs;
    try {
      await runOrphanSweep(db, engine, options);
    } catch (error) {
      console.error(
        `[sweeper] RETENTION: orphan sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await sweepSyncImportOrphans(db, { now: options.now });
    } catch (error) {
      console.error(
        `[sweeper] RETENTION: sync import GC failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
