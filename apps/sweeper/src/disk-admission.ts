import { type DB, simJobs, sweeperState } from "@aerodb/db";
import {
  EngineError,
  type EngineClient,
  type EngineMaintenanceDiskResponse,
} from "@aerodb/engine-client";
import { statfs } from "node:fs/promises";
import { and, desc, eq, inArray, or } from "drizzle-orm";

import { cancelJobAndReleaseClaims, type SimJobRow } from "./reconcile";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export const DEFAULT_DISK_MAX_USED_PCT = 95;
export const DEFAULT_DISK_MIN_FREE_BYTES = 20 * GIB;
// One ordinary 26-case FAST-URANS batch at the calibrated per-case reserve.
// This is intentionally larger than the 24.375 GiB full RANS batch reserve.
export const DEFAULT_DISK_JOB_RESERVE_BYTES = 40 * GIB;
export const DEFAULT_DISK_RANS_CASE_RESERVE_BYTES = 320 * MIB;
export const DEFAULT_DISK_PRECALC_CASE_RESERVE_BYTES = 1.5 * GIB;
export const DEFAULT_DISK_FULL_CASE_RESERVE_BYTES = 6 * GIB;
export const DEFAULT_DISK_EMERGENCY_USED_PCT = 98;
export const DISK_PRESSURE_CANCELLATION_MARKER =
  "Storage pressure emergency: cancelled disposable solver work for restart";

export interface DiskAdmissionConfig {
  maxUsedPct: number;
  minFreeBytes: number;
  /** Conservative reserve for the next job before its exact shape is known. */
  jobReserveBytes: number;
  ransCaseReserveBytes?: number;
  precalcCaseReserveBytes?: number;
  fullCaseReserveBytes?: number;
}

export interface LocalDiskJob {
  totalCases: number;
  completedCases: number;
  requestPayload: unknown;
  /** Execution capacity is deliberately not a storage multiplier. */
  admissionCpuSlots?: number;
}

export interface DiskAdmissionExposure {
  activeLocalJobCount: number;
  /** Future local growth only; bytes already present are in free_bytes. */
  activeLocalReservedBytes: number;
}

export interface DiskAdmissionDecision {
  allowed: boolean;
  reason: string | null;
  usedPct: number | null;
  freeBytes: number | null;
  requiredFreeBytes: number | null;
}

export function diskPressureEmergencyFromEnv(): number {
  const value = positiveEnv(
    "SWEEPER_DISK_EMERGENCY_USED_PCT",
    DEFAULT_DISK_EMERGENCY_USED_PCT,
  );
  return value > 0 && value < 100 ? value : DEFAULT_DISK_EMERGENCY_USED_PCT;
}

export function isDiskPressureEmergency(
  decision: DiskAdmissionDecision,
  thresholdPct = diskPressureEmergencyFromEnv(),
  minFreeBytes = diskAdmissionConfigFromEnv().minFreeBytes,
): boolean {
  return (
    (decision.usedPct != null && decision.usedPct >= thresholdPct) ||
    (decision.freeBytes != null && decision.freeBytes < minFreeBytes)
  );
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
    ransCaseReserveBytes:
      positiveEnv(
        "SWEEPER_DISK_RANS_CASE_RESERVE_GIB",
        DEFAULT_DISK_RANS_CASE_RESERVE_BYTES / GIB,
      ) * GIB,
    precalcCaseReserveBytes:
      positiveEnv(
        "SWEEPER_DISK_PRECALC_CASE_RESERVE_GIB",
        DEFAULT_DISK_PRECALC_CASE_RESERVE_BYTES / GIB,
      ) * GIB,
    fullCaseReserveBytes:
      positiveEnv(
        "SWEEPER_DISK_FULL_CASE_RESERVE_GIB",
        DEFAULT_DISK_FULL_CASE_RESERVE_BYTES / GIB,
      ) * GIB,
  };
}

function gib(bytes: number): string {
  return (bytes / GIB).toFixed(1);
}

function objectPayload(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Estimate only growth which has not happened yet. Production evidence on
 * 2026-07-27 measured p95 uncompressed archives at 0.235 GiB for RANS,
 * 1.196 GiB for FAST URANS and 3.739 GiB for FINAL URANS. The FAST default is
 * 25% above its measured p95 (and over 2x the 0.5–0.62 GiB/case observed in
 * the 2026-08-11 hub run). Unknown/malformed work keeps a full ordinary-job
 * reserve and therefore fails safe.
 */
export function diskAdmissionExposureForJobs(
  jobs: readonly LocalDiskJob[],
  config: DiskAdmissionConfig = diskAdmissionConfigFromEnv(),
): DiskAdmissionExposure {
  let activeLocalReservedBytes = 0;
  for (const job of jobs) {
    if (
      !Number.isInteger(job.totalCases) ||
      job.totalCases < 1 ||
      !Number.isInteger(job.completedCases) ||
      job.completedCases < 0 ||
      job.completedCases > job.totalCases
    ) {
      activeLocalReservedBytes += config.jobReserveBytes;
      continue;
    }

    // Keep one case of packaging headroom after the engine reports every case
    // complete but before reconciliation has stripped its working directory.
    const remainingCases = Math.max(1, job.totalCases - job.completedCases);
    const fidelity = objectPayload(job.requestPayload)?.uransFidelity;
    let perCaseBytes: number;
    if (fidelity == null || fidelity === "rans") {
      perCaseBytes =
        config.ransCaseReserveBytes ?? DEFAULT_DISK_RANS_CASE_RESERVE_BYTES;
    } else if (fidelity === "precalc") {
      perCaseBytes =
        config.precalcCaseReserveBytes ??
        DEFAULT_DISK_PRECALC_CASE_RESERVE_BYTES;
    } else if (fidelity === "full") {
      perCaseBytes =
        config.fullCaseReserveBytes ?? DEFAULT_DISK_FULL_CASE_RESERVE_BYTES;
    } else {
      activeLocalReservedBytes += config.jobReserveBytes;
      continue;
    }
    activeLocalReservedBytes += Math.ceil(remainingCases * perCaseBytes);
  }
  return {
    activeLocalJobCount: jobs.length,
    activeLocalReservedBytes,
  };
}

export async function loadDiskAdmissionExposure(
  db: DB,
  config: DiskAdmissionConfig = diskAdmissionConfigFromEnv(),
): Promise<DiskAdmissionExposure> {
  const jobs = await db
    .select({
      totalCases: simJobs.totalCases,
      completedCases: simJobs.completedCases,
      requestPayload: simJobs.requestPayload,
      admissionCpuSlots: simJobs.admissionCpuSlots,
    })
    .from(simJobs)
    .where(
      or(
        inArray(simJobs.status, ["submitted", "running"]),
        and(
          eq(simJobs.status, "pending"),
          eq(simJobs.engineState, "submitting"),
        ),
        and(
          eq(simJobs.status, "cancelled"),
          inArray(simJobs.engineState, ["cancelling", "cancel_pending"]),
        ),
      ),
    );
  return diskAdmissionExposureForJobs(jobs, config);
}

/**
 * A closed admission gate cannot stop bytes already being produced by active
 * OpenFOAM children. At the emergency high-water mark, cancel a bounded batch
 * of reproducible jobs and release their claimed points for a clean restart.
 * Retention recognizes the exact marker and strips these job directories
 * without waiting for the ordinary terminal-age or remote-delivery fences.
 */
export async function cancelDisposableJobsForDiskPressure(
  db: DB,
  engine: EngineClient,
  limit = 8,
): Promise<number> {
  const jobs = (await db
    .select()
    .from(simJobs)
    .where(
      or(
        inArray(simJobs.status, ["submitted", "running"]),
        and(
          eq(simJobs.status, "pending"),
          eq(simJobs.engineState, "submitting"),
        ),
      ),
    )
    .orderBy(desc(simJobs.completedCases), desc(simJobs.updatedAt))
    .limit(Math.max(0, Math.trunc(limit)))) as SimJobRow[];

  let cancelled = 0;
  for (const job of jobs) {
    if (job.engineJobId) {
      try {
        await engine.cancelJob(job.engineJobId);
      } catch (error) {
        if (!(error instanceof EngineError && error.status === 404)) {
          console.error(
            `[sweeper] DISK EMERGENCY: engine cancellation failed for ${job.engineJobId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
      }
    }
    if (
      await cancelJobAndReleaseClaims(
        db,
        job,
        DISK_PRESSURE_CANCELLATION_MARKER,
      )
    ) {
      cancelled += 1;
    }
  }
  if (cancelled) {
    console.warn(
      `[sweeper] DISK EMERGENCY: cancelled ${cancelled} disposable job(s); their points were released for restart`,
    );
  }
  return cancelled;
}

/**
 * Reserve measured future growth of local engine work plus one unknown new
 * local batch. Upstream promises computed on another solver are intentionally
 * absent: their durable archive uploads directly to GCS, while the fixed
 * system floor covers the hub's bounded fresh-generation verification.
 */
export function evaluateDiskAdmission(
  disk: EngineMaintenanceDiskResponse,
  exposure: DiskAdmissionExposure,
  config: DiskAdmissionConfig = diskAdmissionConfigFromEnv(),
): DiskAdmissionDecision {
  const valid =
    Number.isFinite(disk.total_bytes) &&
    disk.total_bytes > 0 &&
    Number.isFinite(disk.free_bytes) &&
    disk.free_bytes >= 0 &&
    Number.isFinite(disk.used_pct) &&
    disk.used_pct >= 0 &&
    disk.used_pct <= 100 &&
    Number.isInteger(exposure.activeLocalJobCount) &&
    exposure.activeLocalJobCount >= 0 &&
    Number.isFinite(exposure.activeLocalReservedBytes) &&
    exposure.activeLocalReservedBytes >= 0;
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

  const requiredFreeBytes =
    config.minFreeBytes +
    exposure.activeLocalReservedBytes +
    config.jobReserveBytes;
  const reasons: string[] = [];
  if (disk.used_pct >= config.maxUsedPct) {
    reasons.push(
      `${disk.used_pct.toFixed(1)}% used (admission limit ${config.maxUsedPct.toFixed(1)}%)`,
    );
  }
  if (disk.free_bytes < requiredFreeBytes) {
    reasons.push(
      `${gib(disk.free_bytes)} GiB free; ${gib(requiredFreeBytes)} GiB required (${gib(config.minFreeBytes)} GiB system floor + ${gib(exposure.activeLocalReservedBytes)} GiB remaining local work across ${exposure.activeLocalJobCount} job${exposure.activeLocalJobCount === 1 ? "" : "s"} + ${gib(config.jobReserveBytes)} GiB for the next local job)`,
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
let lastDiskMeasurementFallback: string | null | undefined;

export function resetDiskAdmissionMemory(): void {
  lastLoggedReason = undefined;
  lastDiskMeasurementFallback = undefined;
}

export function diskMeasurementFromStatfs(input: {
  blocks: number | bigint;
  bfree: number | bigint;
  bavail: number | bigint;
  bsize: number | bigint;
}): EngineMaintenanceDiskResponse {
  const blocks = Number(input.blocks);
  const bavail = Number(input.bavail);
  const bsize = Number(input.bsize);
  const totalBytes = blocks * bsize;
  return {
    total_bytes: totalBytes,
    free_bytes: bavail * bsize,
    // Match the engine endpoint exactly: filesystem-reserved blocks are not
    // available to the solver and therefore count as used for admission.
    used_pct: totalBytes > 0 ? ((blocks - bavail) / blocks) * 100 : Number.NaN,
  };
}

async function measuredDisk(
  engine: EngineClient,
): Promise<EngineMaintenanceDiskResponse> {
  try {
    const disk = await engine.maintenanceDisk();
    if (lastDiskMeasurementFallback) {
      console.log(
        "[sweeper] Engine disk measurement recovered; local statfs fallback is no longer needed.",
      );
    }
    lastDiskMeasurementFallback = null;
    return disk;
  } catch (engineError) {
    const message =
      engineError instanceof Error ? engineError.message : String(engineError);
    try {
      const local = diskMeasurementFromStatfs(
        await statfs(process.env.MEDIA_DIR ?? "/data/airfoilfoam"),
      );
      if (lastDiskMeasurementFallback !== message) {
        console.warn(
          `[sweeper] Engine disk measurement unavailable (${message}); using local media-volume statfs.`,
        );
      }
      lastDiskMeasurementFallback = message;
      return local;
    } catch (localError) {
      const localMessage =
        localError instanceof Error ? localError.message : String(localError);
      throw new Error(
        `engine measurement failed (${message}); local media-volume statfs failed (${localMessage})`,
      );
    }
  }
}

export async function refreshDiskAdmission(
  db: DB,
  engine: EngineClient,
): Promise<DiskAdmissionDecision> {
  let decision: DiskAdmissionDecision;
  try {
    const config = diskAdmissionConfigFromEnv();
    decision = evaluateDiskAdmission(
      await measuredDisk(engine),
      await loadDiskAdmissionExposure(db, config),
      config,
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
