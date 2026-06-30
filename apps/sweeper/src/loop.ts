import {
  airfoils,
  type DB,
  results,
  simJobs,
  sweeperState,
} from "@aerodb/db";
import { ensureEnabledSimulationPresetRevisions, ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import type { EngineClient } from "@aerodb/engine-client";
import { and, count, eq, inArray } from "drizzle-orm";

import { buildPolarRequest } from "./build-request";
import { claimAoas } from "./claim";
import { findGaps, firstBatch } from "./gaps";
import { reconcile, resetOrphans } from "./reconcile";
import { remoteSolverTick } from "./remote-solver";

interface SweeperConfig {
  enabled: boolean;
  maxConcurrentJobs: number;
  pollIntervalMs: number;
  submitIntervalMs: number;
}

export async function getState(db: DB): Promise<SweeperConfig> {
  const [s] = await db.select().from(sweeperState).where(eq(sweeperState.id, 1)).limit(1);
  return {
    enabled: s?.enabled ?? false,
    maxConcurrentJobs: s?.maxConcurrentJobs ?? 2,
    pollIntervalMs: s?.pollIntervalMs ?? 5000,
    submitIntervalMs: s?.submitIntervalMs ?? 15000,
  };
}

async function inFlight(db: DB): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(simJobs)
    .where(inArray(simJobs.status, ["submitted", "running", "ingesting"]));
  return r?.n ?? 0;
}

/** Compose + claim + submit one job (one airfoil, one BC, its gap AoAs). */
export async function submitOneBatch(db: DB, engine: EngineClient): Promise<boolean> {
  await ensureEnabledSimulationPresetRevisions(db);
  const gaps = await findGaps(db, 500);
  const batch = firstBatch(gaps);
  if (!batch) return false;
  const queuePressure = Math.max(
    0,
    new Set(gaps.map((g) => `${g.airfoilId}:${g.bcId}`)).size - 1 + (await inFlight(db)),
  );

  const [a] = await db.select().from(airfoils).where(eq(airfoils.id, batch.airfoilId)).limit(1);
  const setup = await ensureSimulationPresetRevision(db, batch.presetId);
  if (!a || !setup) return false;
  const bcId = setup.snapshot.preset.legacyBoundaryConditionId ?? batch.bcId;

  const { request, speed } = buildPolarRequest({ airfoil: a, setup: setup.snapshot, aoaList: batch.aoas, wave: 1, queuePressure });

  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId: a.id,
      bcIds: [bcId],
      simulationPresetRevisionId: setup.revision.id,
      referenceChordM: setup.snapshot.referenceGeometry.referenceLengthM,
      wave: 1,
      status: "pending",
      totalCases: batch.aoas.length,
      requestPayload: {
        speedMap: [{ speed, bcId, presetRevisionId: setup.revision.id, mach: setup.snapshot.flowState.mach }],
        aoas: batch.aoas,
        resources: request.resources,
        setupSnapshot: setup.snapshot,
      },
    })
    .returning({ id: simJobs.id });

  const claimed = await claimAoas(db, a.id, bcId, setup.revision.id, batch.aoas, job.id);
  if (claimed.length === 0) {
    await db.update(simJobs).set({ status: "cancelled" }).where(eq(simJobs.id, job.id));
    return false;
  }
  request.aoa = { angles: claimed };

  try {
    const status = await engine.submitPolar(request);
    await db
      .update(simJobs)
      .set({ status: "submitted", engineJobId: status.job_id, submittedAt: new Date(), engineState: status.state, totalCases: status.total_cases })
      .where(eq(simJobs.id, job.id));
    return true;
  } catch (e) {
    await db.update(results).set({ status: "pending", simJobId: null }).where(eq(results.simJobId, job.id));
    await db.update(simJobs).set({ status: "failed", error: "submit failed: " + (e as Error).message }).where(eq(simJobs.id, job.id));
    return false;
  }
}

export async function tick(db: DB, engine: EngineClient): Promise<void> {
  const state = await getState(db);
  await reconcile(db, engine); // always reconcile, even when paused
  await remoteSolverTick(db, engine);
  if (state.enabled && (await inFlight(db)) < state.maxConcurrentJobs) {
    await submitOneBatch(db, engine);
  }
  await db
    .insert(sweeperState)
    .values({ id: 1 })
    .onConflictDoUpdate({ target: sweeperState.id, set: { heartbeatAt: new Date() } });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export async function runLoop(db: DB, engine: EngineClient, signal: AbortSignal): Promise<void> {
  await resetOrphans(db);
  while (!signal.aborted) {
    try {
      await tick(db, engine);
    } catch (e) {
      console.error("[sweeper] tick error:", e);
    }
    const { pollIntervalMs } = await getState(db);
    await delay(pollIntervalMs, signal);
  }
}
