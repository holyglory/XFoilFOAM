/**
 * One-shot maintenance reconciliation for a bounded, source-pinned receipt.
 *
 * This is intentionally a CLI rather than an HTTP route. The production
 * deploy watcher already owns the maintenance drain and hands this command a
 * private receipt after it has independently proved the matching engine jobs
 * terminal. It is intrinsically receipt-bound: no UUID list, stdin, or other
 * compatibility transport can invoke this command.
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { type DB, simJobs, sweeperState } from "@aerodb/db";
import {
  type EngineClient,
  WORKER_RESTART_ORPHAN_MESSAGE,
} from "@aerodb/engine-client";
import { eq, inArray } from "drizzle-orm";

import { makeContext } from "./config";
import {
  type ReceiptScopedCandidate,
  type ReceiptSettlementAction,
  reconcile,
} from "./reconcile";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_ENGINE_JOB_ID = /^[0-9a-f]{32}$/;
// Keep this in lockstep with the guarded production receipt producer. A
// receipt remains deliberately bounded so this one-shot maintenance command
// cannot become a general scheduler drain.
export const MAX_RECEIPT_JOB_IDS = 100;
/** Matches the watcher-side per-candidate terminal-message ceiling. The
 * receipt limit is deliberately derived above the worst valid 100-candidate
 * JSON document (100 × 4 KiB messages plus canonical fields/digests), not an
 * arbitrary small CLI pipe limit that could strand a valid maintenance drain. */
export const MAX_RECEIPT_ENGINE_MESSAGE_BYTES = 4_096;
// A valid 4 KiB UTF-8 message can expand sixfold when every byte must be JSON
// escaped (for example NUL). One hundred bounded candidates plus fixed fields
// therefore fit below 3 MiB. This is an encoded-byte contract shared with the
// Python producer, not a language-specific Unicode character count.
export const MAX_RECEIPT_INPUT_BYTES = 3 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TERMINAL_INGEST_STATUSES = new Set(["completed", "failed"]);

/** This is the one legacy gateway identity eligible for the production
 * maintenance receipt. It deliberately mirrors the watcher-side constant and
 * rejects a receipt captured from another runtime family. */
export const LEGACY_GATEWAY_AFFECTED_RUNTIME = {
  build_id: "b7d9213f59f2c1c19b8890b1500b81cf168d83aa",
  engine_version: "2606",
  urans_recovery_version: 12,
  archive_reduction_version: 4,
  queue_observation_version: 1,
} as const;

export const URANS_CLEAN_CYCLE_GATEWAY_AFFECTED_RUNTIME = {
  build_id: "8d8aed9-clean-cycle-v13",
  engine_version: "2606",
  urans_recovery_version: 12,
  archive_reduction_version: 4,
  queue_observation_version: 1,
} as const;

export const ELIGIBLE_GATEWAY_AFFECTED_RUNTIMES = [
  LEGACY_GATEWAY_AFFECTED_RUNTIME,
  URANS_CLEAN_CYCLE_GATEWAY_AFFECTED_RUNTIME,
] as const;

type EligibleGatewayAffectedRuntime =
  (typeof ELIGIBLE_GATEWAY_AFFECTED_RUNTIMES)[number];

const ACTIVE_STATUSES = new Set(["submitted", "running", "ingesting"]);
const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

export const MAINTENANCE_RECEIPT_RECONCILE_USAGE = `Usage:
  pnpm --silent --filter @aerodb/sweeper maintenance:reconcile-receipt -- \\
    --receipt-file /private/guarded-engine-receipt.json

Only the full schemaVersion=1 guarded private receipt is accepted. It verifies
the matching durable maintenance drain before reading a named job, records
only its explicit terminal settlement, and never submits or cancels CFD work.

  --repair-known-retry-rollback
    Repairs only the already-known legacy rollback shape within this exact
    receipt: an original completed ingesting candidate that a failed
    receipt-bound read returned to tokenless running. The repair preserves
    the failed-read error, writes no evidence, and leaves admission paused.
`;

export type MaintenanceReceiptReconcileArgs = {
  receiptFile: string;
  repairKnownRetryRollback?: boolean;
};

export type GuardedEngineReceipt = {
  schemaVersion: 1;
  maintenanceToken: string;
  affectedRuntime: EligibleGatewayAffectedRuntime;
  authoritativeObservedAt: string;
  candidates: ReceiptScopedCandidate[];
  candidateDigest: string;
};

export type ReceiptReconcileReport = {
  schemaVersion: 1;
  mode: "receipt-scoped-maintenance";
  jobIds: string[];
  terminalJobIds: string[];
  activeJobIds: string[];
  nonterminalJobIds: string[];
};

export type ReceiptRetryRollbackRepairReport = {
  schemaVersion: 1;
  mode: "receipt-retry-rollback-repair";
  repairedJobIds: string[];
  alreadyRestoredJobIds: string[];
};

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function isCanonicalEngineJobId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_ENGINE_JOB_ID.test(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
  return `{${entries.join(",")}}`;
}

export function guardedReceiptCandidateDigest(
  candidates: readonly ReceiptScopedCandidate[],
): string {
  return createHash("sha256")
    .update(
      stableJson(
        [...candidates].sort((left, right) =>
          left.jobId.localeCompare(right.jobId),
        ),
      ),
    )
    .digest("hex");
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !(key in value))
  ) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function parseReceiptCandidate(value: unknown, index: number): ReceiptScopedCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`guarded engine receipt candidate ${index + 1} is invalid`);
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(
    candidate,
    [
      "jobId",
      "engineJobId",
      "databaseStatus",
      "engineStatus",
      "engineMessage",
      "statusSha256",
      "resultSha256",
      "settlementAction",
    ],
    `guarded engine receipt candidate ${index + 1}`,
  );
  if (!isCanonicalUuid(candidate.jobId)) {
    throw new Error(
      `guarded engine receipt candidate ${index + 1} must use a canonical lower-case database UUID`,
    );
  }
  if (!isCanonicalEngineJobId(candidate.engineJobId)) {
    throw new Error(
      `guarded engine receipt candidate ${index + 1} must use a canonical lower-case 32-hex engine identity`,
    );
  }
  if (candidate.databaseStatus !== "running" && candidate.databaseStatus !== "ingesting") {
    throw new Error(`guarded engine receipt candidate ${index + 1} database status is invalid`);
  }
  if (
    candidate.engineStatus !== "completed" &&
    candidate.engineStatus !== "failed" &&
    candidate.engineStatus !== "cancelled"
  ) {
    throw new Error(`guarded engine receipt candidate ${index + 1} engine status is invalid`);
  }
  if (
    (typeof candidate.engineMessage !== "string" &&
      candidate.engineMessage !== null) ||
    (typeof candidate.engineMessage === "string" &&
      Buffer.byteLength(candidate.engineMessage, "utf8") >
        MAX_RECEIPT_ENGINE_MESSAGE_BYTES)
  ) {
    throw new Error(`guarded engine receipt candidate ${index + 1} engine message is invalid`);
  }
  if (
    !SHA256_HEX.test(String(candidate.statusSha256)) ||
    !SHA256_HEX.test(String(candidate.resultSha256))
  ) {
    throw new Error(`guarded engine receipt candidate ${index + 1} evidence digest is invalid`);
  }
  const settlementAction = candidate.settlementAction;
  if (
    settlementAction !== "ingest" &&
    settlementAction !== "release_cancelled" &&
    settlementAction !== "release_worker_restart_orphan"
  ) {
    throw new Error(`guarded engine receipt candidate ${index + 1} settlement action is invalid`);
  }
  if (
    (settlementAction === "ingest" &&
      (!TERMINAL_INGEST_STATUSES.has(candidate.engineStatus) ||
        candidate.engineMessage === WORKER_RESTART_ORPHAN_MESSAGE)) ||
    (settlementAction === "release_cancelled" && candidate.engineStatus !== "cancelled") ||
    (settlementAction === "release_worker_restart_orphan" &&
      (candidate.engineStatus !== "failed" ||
        candidate.engineMessage !== WORKER_RESTART_ORPHAN_MESSAGE))
  ) {
    throw new Error(`guarded engine receipt candidate ${index + 1} settlement does not match its terminal state/message`);
  }
  return {
    jobId: candidate.jobId,
    engineJobId: candidate.engineJobId,
    databaseStatus: candidate.databaseStatus,
    engineStatus: candidate.engineStatus,
    engineMessage: candidate.engineMessage,
    statusSha256: String(candidate.statusSha256),
    resultSha256: String(candidate.resultSha256),
    settlementAction: settlementAction as ReceiptSettlementAction,
  };
}

/** Parse the entire watcher-authored receipt. The CLI treats no field as
 * optional, and recomputes the candidates digest before it ever opens the DB. */
export function parseGuardedEngineReceipt(raw: string): GuardedEngineReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("guarded engine receipt must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("guarded engine receipt must be a JSON object");
  }
  const receipt = value as Record<string, unknown>;
  assertExactKeys(
    receipt,
    [
      "schemaVersion",
      "maintenanceToken",
      "affectedRuntime",
      "authoritativeObservedAt",
      "candidates",
      "candidateDigest",
    ],
    "guarded engine receipt",
  );
  if (receipt.schemaVersion !== 1 || !isCanonicalUuid(receipt.maintenanceToken)) {
    throw new Error("guarded engine receipt schema version or maintenance token is invalid");
  }
  const affectedRuntime = ELIGIBLE_GATEWAY_AFFECTED_RUNTIMES.find(
    (eligible) => stableJson(receipt.affectedRuntime) === stableJson(eligible),
  );
  if (!affectedRuntime) {
    throw new Error("guarded engine receipt affected runtime is not the eligible legacy gateway");
  }
  if (
    typeof receipt.authoritativeObservedAt !== "string" ||
    !receipt.authoritativeObservedAt ||
    Number.isNaN(Date.parse(receipt.authoritativeObservedAt))
  ) {
    throw new Error("guarded engine receipt authoritative observation time is invalid");
  }
  if (!Array.isArray(receipt.candidates) || receipt.candidates.length === 0 || receipt.candidates.length > MAX_RECEIPT_JOB_IDS) {
    throw new Error(`guarded engine receipt candidates must contain 1 to ${MAX_RECEIPT_JOB_IDS} rows`);
  }
  const candidates = receipt.candidates.map(parseReceiptCandidate);
  const jobIds = candidates.map((candidate) => candidate.jobId);
  const engineJobIds = candidates.map((candidate) => candidate.engineJobId);
  if (
    new Set(jobIds).size !== jobIds.length ||
    new Set(engineJobIds).size !== engineJobIds.length ||
    candidates.some((candidate, index) => index > 0 && candidates[index - 1]!.jobId >= candidate.jobId)
  ) {
    throw new Error("guarded engine receipt candidates are not canonical and unique");
  }
  if (
    typeof receipt.candidateDigest !== "string" ||
    !SHA256_HEX.test(receipt.candidateDigest) ||
    guardedReceiptCandidateDigest(candidates) !== receipt.candidateDigest
  ) {
    throw new Error("guarded engine receipt candidate digest is invalid");
  }
  return {
    schemaVersion: 1,
    maintenanceToken: receipt.maintenanceToken,
    affectedRuntime,
    authoritativeObservedAt: receipt.authoritativeObservedAt,
    candidates,
    candidateDigest: receipt.candidateDigest,
  };
}

export function parseMaintenanceReceiptReconcileArgs(
  argv: string[],
): MaintenanceReceiptReconcileArgs | { help: true } {
  // pnpm forwards a single literal separator before its script arguments.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      "receipt-file": { type: "string" },
      "repair-known-retry-rollback": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return { help: true };
  const receiptFile = values["receipt-file"]?.trim();
  if (!receiptFile) {
    throw new Error("--receipt-file is required for guarded maintenance reconciliation");
  }
  return {
    receiptFile,
    repairKnownRetryRollback:
      values["repair-known-retry-rollback"] === true,
  };
}

async function readBoundedFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(MAX_RECEIPT_INPUT_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_RECEIPT_INPUT_BYTES) {
      throw new Error(
        `maintenance receipt input exceeds ${MAX_RECEIPT_INPUT_BYTES} bytes`,
      );
    }
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function readGuardedEngineReceipt(
  args: MaintenanceReceiptReconcileArgs,
): Promise<GuardedEngineReceipt> {
  return parseGuardedEngineReceipt(await readBoundedFile(args.receiptFile));
}

async function assertReceiptMaintenanceDrain(
  db: DB,
  receipt: GuardedEngineReceipt,
): Promise<void> {
  const [state] = await db
    .select({
      enabled: sweeperState.enabled,
      admissionFenceActive: sweeperState.admissionFenceActive,
      maintenanceDrainToken: sweeperState.maintenanceDrainToken,
      maintenanceDrainStartedAt: sweeperState.maintenanceDrainStartedAt,
    })
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .limit(1);
  if (
    !state ||
    state.enabled ||
    state.admissionFenceActive ||
    state.maintenanceDrainToken !== receipt.maintenanceToken ||
    !state.maintenanceDrainStartedAt
  ) {
    throw new Error(
      "guarded receipt does not own the current durable maintenance drain",
    );
  }
}

async function assertReceiptMaintenanceDrainLocked(
  db: DB,
  receipt: GuardedEngineReceipt,
): Promise<Date> {
  const [state] = await db
    .select({
      enabled: sweeperState.enabled,
      admissionFenceActive: sweeperState.admissionFenceActive,
      maintenanceDrainToken: sweeperState.maintenanceDrainToken,
      maintenanceDrainStartedAt: sweeperState.maintenanceDrainStartedAt,
    })
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .for("update")
    .limit(1);
  if (
    !state ||
    state.enabled ||
    state.admissionFenceActive ||
    state.maintenanceDrainToken !== receipt.maintenanceToken ||
    !state.maintenanceDrainStartedAt
  ) {
    throw new Error(
      "guarded receipt does not own the current durable maintenance drain",
    );
  }
  return state.maintenanceDrainStartedAt;
}

function isKnownRetryRollbackCandidate(
  candidate: ReceiptScopedCandidate,
): boolean {
  return (
    candidate.databaseStatus === "ingesting" &&
    candidate.engineStatus === "completed" &&
    candidate.settlementAction === "ingest"
  );
}

/**
 * Repair the one legacy post-read rollback shape which existed before the
 * receipt-aware restore was introduced.  This is deliberately not a general
 * status repair: the immutable receipt determines the sole possible scope,
 * writers/admission must still be stopped by its exact token, and every
 * candidate is locked and classified before the first update.
 *
 * A normal retry of this command is a no-op.  It does not alter terminal rows
 * or any row that has acquired a lease, published evidence, or otherwise
 * departed from the known `running/completed/tokenless` failure shape. A
 * prior safe restore may carry either the new epoch marker or a legacy
 * ordinary expiry from before the locked maintenance drain. Both are safely
 * reclaimable and must make a repeat invocation a no-op; a lease timestamp
 * at or after the drain start is never treated as legacy state.
 */
export async function repairGuardedReceiptRetryRollback(
  db: DB,
  receipt: GuardedEngineReceipt,
): Promise<ReceiptRetryRollbackRepairReport> {
  const receiptCandidates = receipt.candidates.filter(
    isKnownRetryRollbackCandidate,
  );
  if (receiptCandidates.length === 0) {
    throw new Error(
      "guarded receipt contains no completed ingesting candidate eligible for retry-shape repair",
    );
  }

  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const maintenanceDrainStartedAt = await assertReceiptMaintenanceDrainLocked(
      tx,
      receipt,
    );

    const jobIds = receiptCandidates.map((candidate) => candidate.jobId);
    const rows = await tx
      .select({
        id: simJobs.id,
        status: simJobs.status,
        engineState: simJobs.engineState,
        engineJobId: simJobs.engineJobId,
        ingestedAt: simJobs.ingestedAt,
        finishedAt: simJobs.finishedAt,
        ingestLeaseToken: simJobs.ingestLeaseToken,
        ingestLeaseClaimedAt: simJobs.ingestLeaseClaimedAt,
        ingestLeaseExpiresAt: simJobs.ingestLeaseExpiresAt,
      })
      .from(simJobs)
      .where(inArray(simJobs.id, jobIds))
      .for("update");
    if (rows.length !== receiptCandidates.length) {
      throw new Error(
        "guarded receipt retry-shape repair rows are incomplete",
      );
    }
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const repairable: ReceiptScopedCandidate[] = [];
    const alreadyRestored: string[] = [];

    for (const candidate of receiptCandidates) {
      const row = rowById.get(candidate.jobId);
      if (!row || row.engineJobId !== candidate.engineJobId) {
        throw new Error(
          `guarded receipt retry-shape repair identity drifted for ${candidate.jobId}`,
        );
      }
      const noPublishedEvidence =
        row.ingestedAt === null && row.finishedAt === null;
      const noLease =
        row.ingestLeaseToken === null && row.ingestLeaseClaimedAt === null;
      const restored =
        row.status === "ingesting" &&
        row.engineState === "completed" &&
        noPublishedEvidence &&
        noLease &&
        row.ingestLeaseExpiresAt !== null &&
        row.ingestLeaseExpiresAt.getTime() <=
          maintenanceDrainStartedAt.getTime();
      if (restored) {
        alreadyRestored.push(candidate.jobId);
        continue;
      }
      const knownRollback =
        row.status === "running" &&
        row.engineState === "completed" &&
        noPublishedEvidence &&
        noLease &&
        row.ingestLeaseExpiresAt === null;
      if (!knownRollback) {
        throw new Error(
          `guarded receipt retry-shape repair row ${candidate.jobId} is not the exact known rollback shape`,
        );
      }
      repairable.push(candidate);
    }

    // There was exactly one reported legacy rollback.  More than one would be
    // new evidence of a broader failure, so preserve the drain for inspection
    // instead of mutating a wider scope.  Zero is the idempotent re-run case.
    if (repairable.length > 1) {
      throw new Error(
        "guarded receipt retry-shape repair found more than one rollback candidate",
      );
    }
    if (repairable.length === 0) {
      return {
        schemaVersion: 1,
        mode: "receipt-retry-rollback-repair",
        repairedJobIds: [],
        alreadyRestoredJobIds: alreadyRestored,
      };
    }

    const candidate = repairable[0]!;
    const [repaired] = await tx
      .update(simJobs)
      .set({
        status: "ingesting",
        engineState: "completed",
        ingestLeaseToken: null,
        ingestLeaseClaimedAt: null,
        // `updatedAt` becomes fresh during this update.  An explicit epoch
        // marker keeps the legacy preflight's null-lease grace from treating
        // the restored row as live.
        ingestLeaseExpiresAt: new Date(0),
        finishedAt: null,
      })
      .where(eq(simJobs.id, candidate.jobId))
      .returning({ id: simJobs.id });
    if (!repaired) {
      throw new Error(
        `guarded receipt retry-shape repair lost ${candidate.jobId}`,
      );
    }
    return {
      schemaVersion: 1,
      mode: "receipt-retry-rollback-repair",
      repairedJobIds: [candidate.jobId],
      alreadyRestoredJobIds: alreadyRestored,
    };
  });
}

/**
 * Reconcile exactly the watcher-authored receipt under the same persisted
 * maintenance token. This exported API intentionally does not accept a list
 * of UUIDs, so neither callers nor CLI transports can use it as a general
 * job settlement backdoor.
 */
export async function reconcileGuardedEngineReceipt(
  db: DB,
  engine: EngineClient,
  receipt: GuardedEngineReceipt,
): Promise<ReceiptReconcileReport> {
  // This check must precede any sim_jobs read or engine probe. A stale receipt
  // is not authorised to inspect, claim, release, or ingest a named job.
  await assertReceiptMaintenanceDrain(db, receipt);
  const exactJobIds = receipt.candidates.map((candidate) => candidate.jobId);
  const before = await db
    .select({
      id: simJobs.id,
      status: simJobs.status,
      engineJobId: simJobs.engineJobId,
    })
    .from(simJobs)
    .where(inArray(simJobs.id, exactJobIds));
  if (before.length !== exactJobIds.length) {
    const found = new Set(before.map((row) => row.id));
    const missing = exactJobIds.filter((id) => !found.has(id));
    throw new Error(
      `guarded receipt names missing sim job(s): ${missing.join(", ")}`,
    );
  }
  const beforeById = new Map(before.map((row) => [row.id, row]));
  for (const candidate of receipt.candidates) {
    const job = beforeById.get(candidate.jobId);
    if (
      !job ||
      job.engineJobId !== candidate.engineJobId ||
      (!TERMINAL_STATUSES.has(job.status) &&
        job.status !== candidate.databaseStatus)
    ) {
      throw new Error(
        `guarded receipt candidate ${candidate.jobId} no longer matches the database`,
      );
    }
  }

  await reconcile(db, engine, {
    jobIds: exactJobIds,
    receiptScopedMaintenance: {
      maintenanceToken: receipt.maintenanceToken,
      candidates: receipt.candidates,
    },
    recordRoutesOnly: true,
    skipFailedRecovery: true,
  });

  const after = await db
    .select({ id: simJobs.id, status: simJobs.status })
    .from(simJobs)
    .where(inArray(simJobs.id, exactJobIds));
  if (after.length !== exactJobIds.length) {
    throw new Error("a guarded receipt sim job disappeared during reconciliation");
  }
  const statusById = new Map(after.map((row) => [row.id, row.status]));
  const activeJobIds = exactJobIds.filter((id) =>
    ACTIVE_STATUSES.has(statusById.get(id) ?? ""),
  );
  const nonterminalJobIds = exactJobIds.filter(
    (id) => !TERMINAL_STATUSES.has(statusById.get(id) ?? ""),
  );
  const report: ReceiptReconcileReport = {
    schemaVersion: 1,
    mode: "receipt-scoped-maintenance",
    jobIds: exactJobIds,
    terminalJobIds: exactJobIds.filter((id) =>
      TERMINAL_STATUSES.has(statusById.get(id) ?? ""),
    ),
    activeJobIds,
    nonterminalJobIds,
  };
  if (nonterminalJobIds.length) {
    throw new Error(
      `guarded receipt reconciliation left named sim job(s) active or unsettled: ${nonterminalJobIds.join(", ")}`,
    );
  }
  return report;
}

/** Keep stdout reserved for the one bounded result receipt. */
export async function withReceiptReconcileLogsOnStderr<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    return await operation();
  } finally {
    console.log = originalLog;
  }
}

export async function runMaintenanceReceiptReconcileCli(
  argv: string[],
): Promise<void> {
  const args = parseMaintenanceReceiptReconcileArgs(argv);
  if ("help" in args) {
    process.stdout.write(MAINTENANCE_RECEIPT_RECONCILE_USAGE);
    return;
  }
  const receipt = await readGuardedEngineReceipt(args);
  const { db, sql, engine } = makeContext();
  try {
    if (args.repairKnownRetryRollback) {
      const report = await repairGuardedReceiptRetryRollback(db, receipt);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return;
    }
    const report = await withReceiptReconcileLogsOnStderr(() =>
      reconcileGuardedEngineReceipt(db, engine, receipt),
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runMaintenanceReceiptReconcileCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
