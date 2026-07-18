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
  /** Durable global NEW-admission latch. Existing engine work continues. */
  admissionFenceActive: boolean;
  lastAdmissionFenceAt: Date | string | null;
  lastAdmissionFenceReason: string | null;
  lastAdmissionFenceTriggerKey: string | null;
  lastAdmissionFenceDetails: Record<string, unknown> | null;
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
  admissionFenceActive: false,
  lastAdmissionFenceAt: null,
  lastAdmissionFenceReason: null,
  lastAdmissionFenceTriggerKey: null,
  lastAdmissionFenceDetails: null,
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

let admissionFenceColumnsExist: boolean | null = null;

async function hasAdmissionFenceColumns(): Promise<boolean> {
  // Cache only success. During an expand-first rolling deploy this process may
  // probe immediately before 0075 lands; a sticky false would make Resume use
  // the legacy writer forever and collide with the new latch constraint.
  if (admissionFenceColumnsExist === true) return true;
  const rows = (await db.execute(sql`
    SELECT 1 AS present FROM information_schema.columns
    WHERE table_name = 'sweeper_state' AND column_name = 'admission_fence_active'
    LIMIT 1
  `)) as unknown as unknown[];
  const present = rows.length > 0;
  if (present) admissionFenceColumnsExist = true;
  return present;
}

type SweeperStateExecutor = Pick<typeof db, "execute">;

async function readSweeperStateFrom(
  source: SweeperStateExecutor,
): Promise<SweeperStateRow | null> {
  const withUnreachable = await hasEngineUnreachableColumn();
  const withTickProgress = await hasTickProgressColumns();
  const withDiskAdmission = await hasDiskAdmissionColumns();
  const withAdmissionFence = await hasAdmissionFenceColumns();
  const rows = (await source.execute(sql`
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
      ${
        withAdmissionFence
          ? sql`, admission_fence_active AS "admissionFenceActive",
                  last_admission_fence_at AS "lastAdmissionFenceAt",
                  last_admission_fence_reason AS "lastAdmissionFenceReason",
                  last_admission_fence_trigger_key AS "lastAdmissionFenceTriggerKey",
                  last_admission_fence_details AS "lastAdmissionFenceDetails"`
          : sql`, false AS "admissionFenceActive",
                  NULL::timestamptz AS "lastAdmissionFenceAt",
                  NULL::text AS "lastAdmissionFenceReason",
                  NULL::text AS "lastAdmissionFenceTriggerKey",
                  NULL::jsonb AS "lastAdmissionFenceDetails"`
      }
    FROM sweeper_state
    WHERE id = 1
    LIMIT 1
  `)) as unknown as Array<SweeperStateRow>;
  const row = rows[0];
  if (!row) return null;
  const savedCapacity = row.admissionFenceActive
    ? row.lastAdmissionFenceDetails
    : null;
  const savedMaxConcurrentJobs =
    typeof savedCapacity?.previousMaxConcurrentJobs === "number"
      ? savedCapacity.previousMaxConcurrentJobs
      : null;
  const savedCpuSlots =
    typeof savedCapacity?.previousCpuSlots === "number"
      ? savedCapacity.previousCpuSlots
      : null;
  return {
    ...row,
    id: Number(row.id),
    enabled: Boolean(row.enabled),
    // While fenced the physical admission columns are deliberately zero, but
    // these API fields remain the operator's saved capacity configuration.
    // A plain Resume ({enabled:true}) therefore restores exactly what was in
    // force before the trip instead of enabling a zero-capacity scheduler.
    maxConcurrentJobs: Number(savedMaxConcurrentJobs ?? row.maxConcurrentJobs),
    cpuSlots: Number(savedCpuSlots ?? row.cpuSlots ?? 0),
    pollIntervalMs: Number(row.pollIntervalMs),
    submitIntervalMs: Number(row.submitIntervalMs),
    diskAdmissionBlocked: Boolean(row.diskAdmissionBlocked),
    admissionFenceActive: Boolean(row.admissionFenceActive),
    diskUsedPct: row.diskUsedPct == null ? null : Number(row.diskUsedPct),
    diskFreeBytes: row.diskFreeBytes == null ? null : Number(row.diskFreeBytes),
    diskRequiredFreeBytes:
      row.diskRequiredFreeBytes == null
        ? null
        : Number(row.diskRequiredFreeBytes),
  };
}

export async function readSweeperState(): Promise<SweeperStateRow | null> {
  return readSweeperStateFrom(db);
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
  if (await hasAdmissionFenceColumns()) {
    return db.transaction(async (transaction) => {
      // Ensure the singleton exists before taking the serialization lock. The
      // row lock is shared with the breaker UPDATE, so a safety trip that wins
      // the race is re-read below and cannot be cleared by a stale capacity
      // patch. The comment is also a stable wait target for the race test.
      await transaction.execute(sql`
        INSERT INTO sweeper_state (id) VALUES (1)
        ON CONFLICT (id) DO NOTHING
      `);
      await transaction.execute(sql`
        SELECT id
        FROM sweeper_state
        WHERE id = 1
        FOR UPDATE /* writeSweeperState admission fence serialization */
      `);
      const existing = await readSweeperStateFrom(transaction);
      const next = {
        enabled:
          patch.enabled ?? existing?.enabled ?? SWEEPER_STATE_DEFAULTS.enabled,
        maxConcurrentJobs:
          patch.maxConcurrentJobs ??
          existing?.maxConcurrentJobs ??
          SWEEPER_STATE_DEFAULTS.maxConcurrentJobs,
        cpuSlots:
          patch.cpuSlots ??
          existing?.cpuSlots ??
          SWEEPER_STATE_DEFAULTS.cpuSlots,
        pollIntervalMs:
          patch.pollIntervalMs ??
          existing?.pollIntervalMs ??
          SWEEPER_STATE_DEFAULTS.pollIntervalMs,
        submitIntervalMs:
          patch.submitIntervalMs ??
          existing?.submitIntervalMs ??
          SWEEPER_STATE_DEFAULTS.submitIntervalMs,
      };
      const explicitResume = patch.enabled === true;

      if (existing?.admissionFenceActive && !explicitResume) {
        // Only an explicit {enabled:true} is Resume. Capacity edits and an
        // explicit false made during a safety stop update the saved resume
        // configuration while preserving the physical 0/0 fence.
        await transaction.execute(sql`
          UPDATE sweeper_state
          SET enabled = false,
              max_concurrent_jobs = 0,
              cpu_slots = 0,
              poll_interval_ms = ${next.pollIntervalMs},
              submit_interval_ms = ${next.submitIntervalMs},
              last_admission_fence_details =
                COALESCE(last_admission_fence_details, '{}'::jsonb) ||
                jsonb_build_object(
                  'previousMaxConcurrentJobs', ${next.maxConcurrentJobs}::int,
                  'previousCpuSlots', ${next.cpuSlots}::int
                ),
              "updatedAt" = now()
          WHERE id = 1
        `);
      } else {
        await transaction.execute(sql`
          UPDATE sweeper_state
          SET enabled = ${next.enabled},
              max_concurrent_jobs = ${next.maxConcurrentJobs},
              cpu_slots = ${next.cpuSlots},
              poll_interval_ms = ${next.pollIntervalMs},
              submit_interval_ms = ${next.submitIntervalMs},
              admission_fence_active = CASE
                WHEN ${explicitResume}::boolean THEN false
                ELSE admission_fence_active
              END,
              "updatedAt" = now()
          WHERE id = 1
        `);
      }
      return (
        (await readSweeperStateFrom(transaction)) ?? {
          ...SWEEPER_STATE_DEFAULTS,
          ...next,
        }
      );
    });
  }

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
