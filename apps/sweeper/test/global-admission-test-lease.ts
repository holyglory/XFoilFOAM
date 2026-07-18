import {
  createClient,
  enforceSweeperAdmissionFence,
  sweeperState,
  type Sql,
} from "@aerodb/db";
import { eq } from "drizzle-orm";
import { basename } from "node:path";
import { afterAll, beforeAll } from "vitest";

type ReservedConnection = Awaited<ReturnType<Sql["reserve"]>>;
type SweeperStateSnapshot = typeof sweeperState.$inferSelect;

const LEASE_KEY = "aerodb:sweeper-tests:global-admission";

/**
 * These files intentionally mutate the sweeper singleton or create one of the
 * production-global hazards read by enforceSweeperAdmissionFence. They must be
 * mutually exclusive with every file which may reach an engine-submit
 * boundary. Ordinary files retain a shared lease and therefore still exercise
 * the live database in parallel.
 *
 * Keep this list conservative. A new test which intentionally creates a
 * current-generation critical incident or blocked preliminary/final ledger
 * belongs here; never weaken the runtime detector to make a fixture pass.
 */
const EXCLUSIVE_FILES = new Set([
  "admission-circuit-breaker.test.ts",
  "admission-predicate-transitions.test.ts",
  "auto-retry-mesh-qa.test.ts",
  "auto-retry-partial.test.ts",
  "auto-retry.test.ts",
  "campaign-batching.test.ts",
  "campaign-submit-lifecycle.test.ts",
  "heartbeat-liveness.test.ts",
  "ladder-submit-retry.test.ts",
  "media-repair.test.ts",
  "replace-guard.test.ts",
  "retention.test.ts",
  "sweeper.test.ts",
  "three-stage-urans-canary-once-db.test.ts",
  "urans-ladder.test.ts",
  "worker-restart-orphan.test.ts",
]);

interface VitestWorkerState {
  filepath?: string;
}

function currentTestFile(): string {
  const filepath = (
    globalThis as typeof globalThis & {
      __vitest_worker__?: VitestWorkerState;
    }
  ).__vitest_worker__?.filepath;
  if (!filepath) {
    throw new Error(
      "global admission test lease could not identify the current Vitest file",
    );
  }
  return basename(filepath);
}

let client: ReturnType<typeof createClient> | null = null;
let reserved: ReservedConnection | null = null;
let exclusive = false;
let originalState: SweeperStateSnapshot | null = null;

async function lock(connection: ReservedConnection): Promise<void> {
  if (exclusive) {
    await connection`
      SELECT pg_advisory_lock(hashtextextended(${LEASE_KEY}, 0))
    `;
    return;
  }
  await connection`
    SELECT pg_advisory_lock_shared(hashtextextended(${LEASE_KEY}, 0))
  `;
}

async function unlock(connection: ReservedConnection): Promise<void> {
  const [row] = exclusive
    ? await connection<{ unlocked: boolean }[]>`
        SELECT pg_advisory_unlock(hashtextextended(${LEASE_KEY}, 0)) AS unlocked
      `
    : await connection<{ unlocked: boolean }[]>`
        SELECT pg_advisory_unlock_shared(hashtextextended(${LEASE_KEY}, 0)) AS unlocked
      `;
  if (!row?.unlocked) {
    throw new Error("global admission test lease was not owned at teardown");
  }
}

async function restoreSweeperState(
  snapshot: SweeperStateSnapshot,
): Promise<void> {
  if (!client) throw new Error("global admission test lease client missing");
  await client.db
    .update(sweeperState)
    .set({
      enabled: snapshot.enabled,
      maxConcurrentJobs: snapshot.maxConcurrentJobs,
      cpuSlots: snapshot.cpuSlots,
      engineUnreachableSince: snapshot.engineUnreachableSince,
      pollIntervalMs: snapshot.pollIntervalMs,
      submitIntervalMs: snapshot.submitIntervalMs,
      heartbeatAt: snapshot.heartbeatAt,
      lastTickStartedAt: snapshot.lastTickStartedAt,
      lastTickCompletedAt: snapshot.lastTickCompletedAt,
      diskAdmissionBlocked: snapshot.diskAdmissionBlocked,
      diskAdmissionReason: snapshot.diskAdmissionReason,
      diskUsedPct: snapshot.diskUsedPct,
      diskFreeBytes: snapshot.diskFreeBytes,
      diskRequiredFreeBytes: snapshot.diskRequiredFreeBytes,
      diskCheckedAt: snapshot.diskCheckedAt,
      admissionFenceActive: snapshot.admissionFenceActive,
      lastAdmissionFenceAt: snapshot.lastAdmissionFenceAt,
      lastAdmissionFenceReason: snapshot.lastAdmissionFenceReason,
      lastAdmissionFenceTriggerKey: snapshot.lastAdmissionFenceTriggerKey,
      lastAdmissionFenceDetails: snapshot.lastAdmissionFenceDetails,
      updatedAt: snapshot.updatedAt,
    })
    .where(eq(sweeperState.id, snapshot.id));
}

beforeAll(async () => {
  exclusive = EXCLUSIVE_FILES.has(currentTestFile());
  client = createClient({ max: 2 });
  reserved = await client.sql.reserve();
  await lock(reserved);

  if (exclusive) {
    const [snapshot] = await client.db
      .select()
      .from(sweeperState)
      .where(eq(sweeperState.id, 1))
      .limit(1);
    if (!snapshot) throw new Error("seeded sweeper_state singleton missing");
    originalState = snapshot;
  }
});

afterAll(async () => {
  let teardownError: unknown = null;
  try {
    if (exclusive) {
      if (!client || !originalState) {
        throw new Error("exclusive global admission test lease was not set up");
      }
      const fence = await enforceSweeperAdmissionFence(client.db);
      if (fence.hazardPresent) {
        throw new Error(
          `exclusive test leaked a current-generation admission hazard: ${fence.trigger?.reason ?? "unknown"} (${fence.trigger?.triggerKey ?? "unknown"})`,
        );
      }
      // Fixture cleanup is the test equivalent of resolving/investigating the
      // owned hazard. Only after proving it is gone may the exact pre-file
      // singleton be restored; unresolved hazards are never bypassed.
      await restoreSweeperState(originalState);
    }
  } catch (error) {
    teardownError = error;
  } finally {
    try {
      if (reserved) {
        await unlock(reserved);
        reserved.release();
      }
    } catch (error) {
      teardownError ??= error;
    }
    try {
      await client?.sql.end();
    } catch (error) {
      teardownError ??= error;
    }
  }
  if (teardownError) throw teardownError;
});
