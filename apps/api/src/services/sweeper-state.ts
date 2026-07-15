// Column-tolerant sweeper_state reader. The sweeper phase adds
// engineUnreachableSince via migration 0026; until the orchestrator applies
// it, drizzle full-row selects of sweeperState would fail on the missing
// column. This helper reads the schema defensively (spec §10: queue payload
// passthrough "if the column exists") and caches the column probe.
import { sql } from "drizzle-orm";

import { db } from "../db";

export interface SweeperStateRow {
  id: number;
  enabled: boolean;
  maxConcurrentJobs: number;
  cpuSlots: number;
  pollIntervalMs: number;
  submitIntervalMs: number;
  heartbeatAt: Date | string | null;
  updatedAt: Date | string | null;
  engineUnreachableSince: Date | string | null;
  /** Tick-progress pair (migration 0033, liveness/progress split): stamped by
   *  the sweeper loop at tick begin/end. Null until the migration applies —
   *  the web then simply never derives tick_stalled. */
  lastTickStartedAt: Date | string | null;
  lastTickCompletedAt: Date | string | null;
  diskAdmissionBlocked: boolean;
  diskAdmissionReason: string | null;
  diskUsedPct: number | null;
  diskFreeBytes: number | null;
  diskRequiredFreeBytes: number | null;
  diskCheckedAt: Date | string | null;
}

export const SWEEPER_STATE_DEFAULTS: SweeperStateRow = {
  id: 1,
  enabled: false,
  // 0 = auto. The sweeper resolves it to the engine worker's CPU-token
  // capacity (or the visible cpuSlots cap), so this legacy field can no
  // longer silently limit the only user-facing capacity control.
  maxConcurrentJobs: 0,
  cpuSlots: 0,
  pollIntervalMs: 5000,
  submitIntervalMs: 15000,
  heartbeatAt: null,
  updatedAt: null,
  engineUnreachableSince: null,
  lastTickStartedAt: null,
  lastTickCompletedAt: null,
  diskAdmissionBlocked: false,
  diskAdmissionReason: null,
  diskUsedPct: null,
  diskFreeBytes: null,
  diskRequiredFreeBytes: null,
  diskCheckedAt: null,
};

let engineUnreachableColumnExists: boolean | null = null;

async function hasEngineUnreachableColumn(): Promise<boolean> {
  if (engineUnreachableColumnExists != null)
    return engineUnreachableColumnExists;
  const rows = (await db.execute(sql`
    SELECT 1 AS present FROM information_schema.columns
    WHERE table_name = 'sweeper_state' AND column_name = 'engineUnreachableSince'
    LIMIT 1
  `)) as unknown as unknown[];
  engineUnreachableColumnExists = rows.length > 0;
  return engineUnreachableColumnExists;
}

// Migration 0033 adds the pair together — one probe covers both columns.
let tickProgressColumnsExist: boolean | null = null;

async function hasTickProgressColumns(): Promise<boolean> {
  if (tickProgressColumnsExist != null) return tickProgressColumnsExist;
  const rows = (await db.execute(sql`
    SELECT 1 AS present FROM information_schema.columns
    WHERE table_name = 'sweeper_state' AND column_name = 'lastTickStartedAt'
    LIMIT 1
  `)) as unknown as unknown[];
  tickProgressColumnsExist = rows.length > 0;
  return tickProgressColumnsExist;
}

let diskAdmissionColumnsExist: boolean | null = null;

async function hasDiskAdmissionColumns(): Promise<boolean> {
  if (diskAdmissionColumnsExist != null) return diskAdmissionColumnsExist;
  const rows = (await db.execute(sql`
    SELECT 1 AS present FROM information_schema.columns
    WHERE table_name = 'sweeper_state' AND column_name = 'disk_admission_blocked'
    LIMIT 1
  `)) as unknown as unknown[];
  diskAdmissionColumnsExist = rows.length > 0;
  return diskAdmissionColumnsExist;
}

export async function readSweeperState(): Promise<SweeperStateRow | null> {
  const withUnreachable = await hasEngineUnreachableColumn();
  const withTickProgress = await hasTickProgressColumns();
  const withDiskAdmission = await hasDiskAdmissionColumns();
  const rows = (await db.execute(sql`
    SELECT
      id,
      enabled,
      max_concurrent_jobs AS "maxConcurrentJobs",
      cpu_slots AS "cpuSlots",
      poll_interval_ms AS "pollIntervalMs",
      submit_interval_ms AS "submitIntervalMs",
      "heartbeatAt",
      "updatedAt"
      ${withUnreachable ? sql`, "engineUnreachableSince"` : sql`, NULL::timestamptz AS "engineUnreachableSince"`}
      ${
        withTickProgress
          ? sql`, "lastTickStartedAt", "lastTickCompletedAt"`
          : sql`, NULL::timestamptz AS "lastTickStartedAt", NULL::timestamptz AS "lastTickCompletedAt"`
      }
      ${
        withDiskAdmission
          ? sql`, disk_admission_blocked AS "diskAdmissionBlocked",
                  disk_admission_reason AS "diskAdmissionReason",
                  disk_used_pct AS "diskUsedPct",
                  disk_free_bytes AS "diskFreeBytes",
                  disk_required_free_bytes AS "diskRequiredFreeBytes",
                  disk_checked_at AS "diskCheckedAt"`
          : sql`, false AS "diskAdmissionBlocked",
                  NULL::text AS "diskAdmissionReason",
                  NULL::double precision AS "diskUsedPct",
                  NULL::bigint AS "diskFreeBytes",
                  NULL::bigint AS "diskRequiredFreeBytes",
                  NULL::timestamptz AS "diskCheckedAt"`
      }
    FROM sweeper_state
    WHERE id = 1
    LIMIT 1
  `)) as unknown as Array<SweeperStateRow>;
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    enabled: Boolean(row.enabled),
    maxConcurrentJobs: Number(row.maxConcurrentJobs),
    cpuSlots: Number(row.cpuSlots ?? 0),
    pollIntervalMs: Number(row.pollIntervalMs),
    submitIntervalMs: Number(row.submitIntervalMs),
    diskAdmissionBlocked: Boolean(row.diskAdmissionBlocked),
    diskUsedPct: row.diskUsedPct == null ? null : Number(row.diskUsedPct),
    diskFreeBytes: row.diskFreeBytes == null ? null : Number(row.diskFreeBytes),
    diskRequiredFreeBytes:
      row.diskRequiredFreeBytes == null
        ? null
        : Number(row.diskRequiredFreeBytes),
  };
}

export interface SweeperStatePatch {
  enabled?: boolean;
  /** 0 = auto; positive values are an explicit API-only admission override. */
  maxConcurrentJobs?: number;
  cpuSlots?: number;
  pollIntervalMs?: number;
  submitIntervalMs?: number;
}

/** Upsert the singleton row without touching (or returning) columns that may
 *  not exist yet on this database. */
export async function writeSweeperState(
  patch: SweeperStatePatch,
): Promise<SweeperStateRow> {
  const existing = await readSweeperState();
  const next = {
    enabled:
      patch.enabled ?? existing?.enabled ?? SWEEPER_STATE_DEFAULTS.enabled,
    maxConcurrentJobs:
      patch.maxConcurrentJobs ??
      existing?.maxConcurrentJobs ??
      SWEEPER_STATE_DEFAULTS.maxConcurrentJobs,
    cpuSlots:
      patch.cpuSlots ?? existing?.cpuSlots ?? SWEEPER_STATE_DEFAULTS.cpuSlots,
    pollIntervalMs:
      patch.pollIntervalMs ??
      existing?.pollIntervalMs ??
      SWEEPER_STATE_DEFAULTS.pollIntervalMs,
    submitIntervalMs:
      patch.submitIntervalMs ??
      existing?.submitIntervalMs ??
      SWEEPER_STATE_DEFAULTS.submitIntervalMs,
  };
  await db.execute(sql`
    INSERT INTO sweeper_state (id, enabled, max_concurrent_jobs, cpu_slots, poll_interval_ms, submit_interval_ms)
    VALUES (1, ${next.enabled}, ${next.maxConcurrentJobs}, ${next.cpuSlots}, ${next.pollIntervalMs}, ${next.submitIntervalMs})
    ON CONFLICT (id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      max_concurrent_jobs = EXCLUDED.max_concurrent_jobs,
      cpu_slots = EXCLUDED.cpu_slots,
      poll_interval_ms = EXCLUDED.poll_interval_ms,
      submit_interval_ms = EXCLUDED.submit_interval_ms,
      "updatedAt" = now()
  `);
  return (await readSweeperState()) ?? { ...SWEEPER_STATE_DEFAULTS, ...next };
}
