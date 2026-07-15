import { type DB, sweeperState } from "@aerodb/db";
import type {
  EngineClient,
  EngineMaintenanceDiskResponse,
} from "@aerodb/engine-client";
import { eq } from "drizzle-orm";

const GIB = 1024 ** 3;

export const DEFAULT_DISK_MAX_USED_PCT = 80;
export const DEFAULT_DISK_MIN_FREE_BYTES = 20 * GIB;
export const DEFAULT_DISK_JOB_RESERVE_BYTES = 24 * GIB;

export interface DiskAdmissionConfig {
  maxUsedPct: number;
  minFreeBytes: number;
  jobReserveBytes: number;
}

export interface DiskAdmissionDecision {
  allowed: boolean;
  reason: string | null;
  usedPct: number | null;
  freeBytes: number | null;
  requiredFreeBytes: number | null;
}

function positiveEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function diskAdmissionConfigFromEnv(): DiskAdmissionConfig {
  const maxUsedPct = positiveEnv(
    "SWEEPER_DISK_MAX_USED_PCT",
    DEFAULT_DISK_MAX_USED_PCT,
  );
  return {
    maxUsedPct:
      maxUsedPct > 0 && maxUsedPct < 100
        ? maxUsedPct
        : DEFAULT_DISK_MAX_USED_PCT,
    minFreeBytes:
      positiveEnv(
        "SWEEPER_DISK_MIN_FREE_GIB",
        DEFAULT_DISK_MIN_FREE_BYTES / GIB,
      ) * GIB,
    jobReserveBytes:
      positiveEnv(
        "SWEEPER_DISK_JOB_RESERVE_GIB",
        DEFAULT_DISK_JOB_RESERVE_BYTES / GIB,
      ) * GIB,
  };
}

function gib(bytes: number): string {
  return (bytes / GIB).toFixed(1);
}

/**
 * Reserve the measured worst-case growth of every active batch plus one newly
 * admitted batch. The percentage ceiling protects PostgreSQL and Docker even
 * when a future job is smaller than the reserve estimate.
 */
export function evaluateDiskAdmission(
  disk: EngineMaintenanceDiskResponse,
  inFlightJobs: number,
  config: DiskAdmissionConfig = diskAdmissionConfigFromEnv(),
): DiskAdmissionDecision {
  const valid =
    Number.isFinite(disk.total_bytes) &&
    disk.total_bytes > 0 &&
    Number.isFinite(disk.free_bytes) &&
    disk.free_bytes >= 0 &&
    Number.isFinite(disk.used_pct) &&
    disk.used_pct >= 0 &&
    disk.used_pct <= 100;
  if (!valid) {
    return {
      allowed: false,
      reason:
        "Storage admission stopped: the engine returned an invalid disk measurement.",
      usedPct: null,
      freeBytes: null,
      requiredFreeBytes: null,
    };
  }

  const active = Math.max(0, Math.floor(inFlightJobs));
  const requiredFreeBytes =
    config.minFreeBytes + (active + 1) * config.jobReserveBytes;
  const reasons: string[] = [];
  if (disk.used_pct >= config.maxUsedPct) {
    reasons.push(
      `${disk.used_pct.toFixed(1)}% used (admission limit ${config.maxUsedPct.toFixed(1)}%)`,
    );
  }
  if (disk.free_bytes < requiredFreeBytes) {
    reasons.push(
      `${gib(disk.free_bytes)} GiB free; ${gib(requiredFreeBytes)} GiB required for ${active} active job${active === 1 ? "" : "s"} plus the next job`,
    );
  }
  return {
    allowed: reasons.length === 0,
    reason:
      reasons.length === 0
        ? null
        : `Storage admission stopped: ${reasons.join("; ")}. Existing jobs may reconcile and ingest, but no new solver job will be submitted.`,
    usedPct: disk.used_pct,
    freeBytes: disk.free_bytes,
    requiredFreeBytes,
  };
}

let lastLoggedReason: string | null | undefined;

export function resetDiskAdmissionMemory(): void {
  lastLoggedReason = undefined;
}

export async function refreshDiskAdmission(
  db: DB,
  engine: EngineClient,
  inFlightJobs: number,
): Promise<DiskAdmissionDecision> {
  let decision: DiskAdmissionDecision;
  try {
    decision = evaluateDiskAdmission(
      await engine.maintenanceDisk(),
      inFlightJobs,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    decision = {
      allowed: false,
      reason: `Storage admission stopped: disk measurement unavailable (${message}).`,
      usedPct: null,
      freeBytes: null,
      requiredFreeBytes: null,
    };
  }

  await db
    .update(sweeperState)
    .set({
      diskAdmissionBlocked: !decision.allowed,
      diskAdmissionReason: decision.reason,
      diskUsedPct: decision.usedPct,
      diskFreeBytes: decision.freeBytes,
      diskRequiredFreeBytes: decision.requiredFreeBytes,
      diskCheckedAt: new Date(),
    })
    .where(eq(sweeperState.id, 1));

  if (decision.reason !== lastLoggedReason) {
    if (decision.reason) console.warn(`[sweeper] ${decision.reason}`);
    else if (lastLoggedReason)
      console.log(
        "[sweeper] Storage admission restored; new jobs may be submitted.",
      );
    lastLoggedReason = decision.reason;
  }
  return decision;
}
