import type { DB } from "@aerodb/db";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { canonicalAnalysisJson } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import {
  isEngineIdentity,
  isEngineCapabilityDescriptor,
} from "@aerodb/engine-client";
import {
  parseProgressiveRemoteCapabilities,
  type ProgressiveRemoteCapabilities,
} from "./progressive-remote-admission";

interface Observation {
  checkedAt: number;
  sampledAt: string;
  capabilities: ProgressiveRemoteCapabilities | null;
}

const observations = new WeakMap<DB, Observation>();
const pending = new WeakMap<DB, Promise<void>>();

export function progressiveWorkerCapabilityMetadata(
  db: DB,
  now = performance.now(),
) {
  const observation = observations.get(db);
  const fresh =
    observation &&
    now >= observation.checkedAt &&
    now - observation.checkedAt < 60000;
  return {
    progressiveExecution: fresh ? observation.capabilities : null,
    progressiveExecutionObservedAt: fresh ? observation.sampledAt : null,
  };
}

export async function refreshProgressiveWorkerCapabilities(
  db: DB,
  engine: EngineClient,
): Promise<void> {
  const previous = observations.get(db);
  if (previous && performance.now() - previous.checkedAt < 30000) return;
  const running = pending.get(db);
  if (running) return running;
  const refresh = async () => {
    const checkedAt = performance.now();
    const sampledAt = new Date().toISOString();
    let capabilities: ProgressiveRemoteCapabilities | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const [health, inventory] = await Promise.race([
        Promise.all([
          engine.healthDetails({ timeoutMs: 5000 }),
          engine.capabilities({ timeoutMs: 5000 }),
        ]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Engine capability observation timed out")),
            5000,
          );
        }),
      ]);
      const identity = inventory.default_engine;
      if (
        health.status === "ok" &&
        health.solver_budget_version === 2 &&
        inventory.solver_budget_version === 2 &&
        isEngineIdentity(identity) &&
        health.supported_engines?.some(
          (supported) =>
            canonicalAnalysisJson(supported) ===
            canonicalAnalysisJson(identity),
        )
      ) {
        const routes =
          inventory.engines?.filter(
            (route) =>
              isEngineCapabilityDescriptor(route) &&
              canonicalAnalysisJson(route.engine) ===
                canonicalAnalysisJson(identity) &&
              route.steady &&
              route.mesh_evidence,
          ) ?? [];
        capabilities = parseProgressiveRemoteCapabilities({
          version: 1,
          solverBudgetVersion: 2,
          meshRecoveryVersion: health.mesh_recovery_version,
          uransRecoveryVersion: routes.every((route) => route.transient)
            ? (health.urans_recovery_version ?? null)
            : null,
          engine: identity,
          executionPools: routes.map((route) => route.routing_key),
        });
      }
    } catch {
      capabilities = null;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    observations.set(db, { checkedAt, sampledAt, capabilities });
  };
  const operation = refresh();
  pending.set(db, operation);
  try {
    await operation;
  } finally {
    if (pending.get(db) === operation) pending.delete(db);
  }
}

export async function runProgressiveWorkerCapabilityService(
  db: DB,
  engine: EngineClient,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const [settings] = await db.execute(
        sql`SELECT remote_solver_enabled FROM sync_api_settings WHERE id = 1`,
      );
      if (signal.aborted) break;
      if (settings?.remote_solver_enabled)
        await refreshProgressiveWorkerCapabilities(db, engine);
      else observations.delete(db);
    } catch (error) {
      observations.delete(db);
      console.error(
        "[sweeper] progressive capability refresh failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (signal.aborted) break;
    try {
      await delay(30000, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
